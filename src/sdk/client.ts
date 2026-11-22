// noibla bot SDK. Bots play the whole game through this client:
//  - low-level: one typed method per server command (`send` underneath),
//  - events: a live, server-filtered event stream (`connect`, `on`, `waitForEvent`),
//  - high-level: helpers that chain commands and wait out cooldowns/travel.
//
// Every command carries a commandId. Network retries reuse it, so a retried
// command can never duplicate items or transfers.

import { randomUUID } from 'node:crypto';
import { baseOf, itemDef, MAX_CRAFT_BATCH, MOB_TYPES, NODE_TYPES, RECIPES, requiredToolTier, type ToolJob, type OrbId, type AbilityId, type ItemStack, type Slot, type ZoneId } from '../shared/catalog.ts';
import { findPath, pathLength, type PlaceId, type Pos } from '../shared/map.ts';
import {
  TRANSIENT_ERRORS,
  type ApiError, type CommandResponse, type CommandType, type EventType, type FeedbackCategory, type GameEvent,
  type MapCatalog, type MobView, type Observation, type PayloadOf, type ResultOf, type TradeReceipt, type TradeStatus, type UniqueItem,
} from '../shared/protocol.ts';

export class CommandError extends Error {
  readonly code: ApiError['code'];
  readonly retryAfterMs?: number;
  /** What to do next, when the server can tell. */
  readonly hint?: string;
  /** How many times in a row this command type failed with this code (present from 3). */
  readonly repeated?: number;
  readonly commandId?: string;
  readonly command: string;
  constructor(err: ApiError, command: string, commandId?: string) {
    super(`${command} failed: ${err.code}: ${err.message}${err.hint ? ` (hint: ${err.hint})` : ''}`);
    this.code = err.code;
    if (err.retryAfterMs !== undefined) this.retryAfterMs = err.retryAfterMs;
    if (err.hint !== undefined) this.hint = err.hint;
    if (err.repeated !== undefined) this.repeated = err.repeated;
    if (commandId !== undefined) this.commandId = commandId;
    this.command = command;
  }
  get transient() { return TRANSIENT_ERRORS.has(this.code); }
}

export interface SendOptions {
  /** Supply to make a retry explicit. Reusing an id for a different command fails with IDEMPOTENCY_CONFLICT. */
  commandId?: string;
  /** Network-level retries (same commandId). Default 4. */
  networkRetries?: number;
}

export interface ClientOptions {
  url: string;
  token: string;
  /** Keep every received event in `received` (useful for audits/tests). */
  recordEvents?: boolean;
  log?: (line: string) => void;
}

export type FightOutcome = { result: 'killed' | 'target_gone' | 'died' | 'fled'; loot: ItemStack[]; hits: number };

const round1 = (n: number) => Math.round(n * 10) / 10;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

type Handler = (ev: GameEvent) => void;

export class GameClient {
  readonly url: string;
  private readonly token: string;
  private handlers = new Map<string, Set<Handler>>();
  private wantStream = false;
  private streamAbort: AbortController | null = null;
  private streamLoop: Promise<void> | null = null;
  private log: (line: string) => void;
  readonly received: GameEvent[] = [];
  private recordEvents: boolean;
  connected = false;
  playerId: string | null = null;
  name: string | null = null;
  private mapCache: MapCatalog | null = null;

  constructor(opts: ClientOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.token = opts.token;
    this.recordEvents = !!opts.recordEvents;
    this.log = opts.log ?? (() => {});
  }

  /** Creates a character. Store the token: it is the bot's only credential. */
  static async register(url: string, name: string): Promise<{ playerId: string; name: string; token: string }> {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const body = await res.json();
    if (!res.ok) throw new CommandError(body.error, 'register');
    return body;
  }

  // ======================= low level =======================

  /** Sends one command and returns the raw response (never throws on game errors). */
  async request<K extends CommandType>(type: K, payload: PayloadOf<K>, opts: SendOptions = {}): Promise<CommandResponse<ResultOf<K>>> {
    const commandId = opts.commandId ?? `${type}-${randomUUID()}`;
    const retries = opts.networkRetries ?? 4;
    let limited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.url}/api/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ commandId, type, payload }),
        });
        if (res.status >= 500) throw new Error(`server error ${res.status}`);
        const body = (await res.json()) as CommandResponse<ResultOf<K>>;
        // A rate-limited command never ran: wait it out and resend (a few times) with the same commandId.
        if (!body.ok && body.error.code === 'RATE_LIMITED' && limited++ < 5) { await sleep(Math.max(25, body.error.retryAfterMs ?? 100)); attempt--; continue; }
        return body;
      } catch (e) {
        if (attempt >= retries) throw e;
        // Same commandId on retry: the server returns the recorded result if the first attempt landed.
        await sleep(100 * 2 ** attempt);
      }
    }
  }

  /** Sends one command; throws CommandError on failure. */
  async send<K extends CommandType>(type: K, payload: PayloadOf<K>, opts: SendOptions = {}): Promise<ResultOf<K>> {
    const resp = await this.request(type, payload, opts);
    if (!resp.ok) throw new CommandError(resp.error, type, resp.commandId);
    return resp.result;
  }

  /**
   * Like send, but waits out transient errors (BUSY, ON_COOLDOWN, COMBAT_LOCKED,
   * TRAVELING, DEPLETED, RATE_LIMITED) and retries with the same commandId.
   */
  async sendWhenReady<K extends CommandType>(type: K, payload: PayloadOf<K>, opts: SendOptions & { timeoutMs?: number } = {}): Promise<ResultOf<K>> {
    const commandId = opts.commandId ?? `${type}-${randomUUID()}`;
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    for (;;) {
      const resp = await this.request(type, payload, { ...opts, commandId });
      if (resp.ok) return resp.result;
      const err = new CommandError(resp.error, type, commandId);
      if (!err.transient || Date.now() > deadline) throw err;
      await sleep(Math.min(err.retryAfterMs ?? 100, 2000));
    }
  }

  // ---- observation & lookup ----
  observe() { return this.send('observe', {}); }
  catalog() { return this.send('catalog', {}); }
  lookupPlayer(name: string) { return this.send('player.lookup', { name }); }
  getPlayer(playerId: string) { return this.send('player.get', { playerId }); }

  // ---- movement & skills ----
  /** Starts a walk (returns at once). `to`: region, place, node/mob/bag/player id, or { x, y }. High level: goTo / moveTo / travelTo. */
  move(to: string | Pos, opts?: SendOptions) { return this.send('move', typeof to === 'string' ? { to } : { x: to.x, y: to.y }, opts); }
  gather(nodeId: string, opts?: SendOptions) { return this.send('gather', { nodeId }, opts); }
  refine(recipeId: string, count = 1, opts?: SendOptions) { return this.send('refine', { recipeId, count }, opts); }
  craft(recipeId: string, count = 1, opts?: SendOptions) { return this.send('craft', { recipeId, count }, opts); }

  // ---- gear & combat ----
  /** Equips an item. A base id (`iron_sword`) picks a carried plain copy, else your highest item-level unique of that base. */
  equip(item: string, opts?: SendOptions) { return this.send('equip', { item }, opts); }
  /** Public details (base, item level, rarity, affixes) of any unique item id. */
  inspect(item: string, opts?: SendOptions) { return this.send('item.inspect', { item }, opts); }
  /** Uses one orb on a unique you carry or wear, within range of the town altar (goTo('altar') first); pays the altar fee. Retrying the same commandId never spends a second orb. */
  modifyItem(item: string, orb: OrbId, opts?: SendOptions) { return this.send('item.modify', { item, orb }, opts); }
  /** Salvages a carried unique into orb shards, within range of the town altar. */
  salvage(item: string, opts?: SendOptions) { return this.send('item.salvage', { item }, opts); }
  /** Fee, fee cut and max affix tier for using `orb` on `item` right now. */
  quoteModify(item: string, orb: OrbId, opts?: SendOptions) { return this.send('item.quote', { item, orb }, opts); }
  unequip(slot: Slot, opts?: SendOptions) { return this.send('unequip', { slot }, opts); }
  attack(targetId: string, ability?: AbilityId, opts?: SendOptions) { return this.send('attack', ability ? { targetId, ability } : { targetId }, opts); }
  useAbility(ability: AbilityId, targetId?: string, opts?: SendOptions) { return this.send('ability.use', targetId ? { ability, targetId } : { ability }, opts); }
  loot(bagId: string, items?: ItemStack[], opts?: SendOptions) { return this.send('loot', items ? { bagId, items } : { bagId }, opts); }

  // ---- specialization ----
  /** Sets your focus skills (town only, up to catalog.focus.slots). Adding to free slots is free; dropping one has a cooldown. */
  setFocus(skills: string[], opts?: SendOptions) { return this.send('focus.set', { skills }, opts); }

  // ---- bank ----
  bank() { return this.send('bank.view', {}); }
  deposit(items: ItemStack[], opts?: SendOptions) { return this.send('bank.deposit', { items }, opts); }
  withdraw(items: ItemStack[], opts?: SendOptions) { return this.send('bank.withdraw', { items }, opts); }

  // ---- quests ----
  quests() { return this.send('quest.list', {}); }
  acceptQuest(questId: string, opts?: SendOptions) { return this.send('quest.accept', { questId }, opts); }
  claimQuest(questId: string, opts?: SendOptions) { return this.send('quest.claim', { questId }, opts); }

  // ---- town services ----
  shop() { return this.send('shop.list', {}); }
  buy(item: string, qty = 1, opts?: SendOptions) { return this.send('shop.buy', { item, qty }, opts); }
  repair(slot?: Slot, opts?: SendOptions) { return this.send('repair', slot ? { slot } : {}, opts); }

  // ---- public chat ----
  say(text: string, opts?: SendOptions) { return this.send('chat.say', { text }, opts); }
  chatHistory(channel: string, o: { limit?: number; beforeId?: number } = {}) { return this.send('chat.history', { channel, ...o }); }

  // ---- trade forum ----
  createThread(title: string, body: string, tags: string[] = [], opts?: SendOptions) { return this.send('forum.createThread', { title, body, tags }, opts); }
  replyToThread(threadId: number, body: string, opts?: SendOptions) { return this.send('forum.reply', { threadId, body }, opts); }
  listThreads(o: { limit?: number; tag?: string; authorId?: string } = {}) { return this.send('forum.listThreads', o); }
  getThread(threadId: number) { return this.send('forum.getThread', { threadId }); }

  // ---- private messages ----
  sendDm(to: string, text: string, opts?: SendOptions) { return this.send('dm.send', { to, text }, opts); }
  dmHistory(o: { with?: string; conversationId?: string; limit?: number; beforeId?: number; afterId?: number }) { return this.send('dm.history', o); }
  conversations() { return this.send('dm.conversations', {}); }
  markRead(conversationId: string, upToId: number) { return this.send('dm.markRead', { conversationId, upToId }); }

  // ---- blind trade ----
  proposeTrade(o: { to: string; give: ItemStack[]; receive: ItemStack[]; lockTimeoutMs?: number }, opts?: SendOptions) { return this.send('trade.propose', o, opts); }
  acceptTrade(tradeId: string, opts?: SendOptions) { return this.send('trade.accept', { tradeId }, opts); }
  declineTrade(tradeId: string, opts?: SendOptions) { return this.send('trade.decline', { tradeId }, opts); }
  cancelTrade(tradeId: string, opts?: SendOptions) { return this.send('trade.cancel', { tradeId }, opts); }
  /** Secretly set (or replace) what you will actually send. Items are reserved from your inventory. */
  submitTrade(tradeId: string, items: ItemStack[], opts?: SendOptions) { return this.send('trade.submit', { tradeId, items }, opts); }
  /** Lock your submission (optionally setting it in the same call). Irreversible. Settles when both have locked. */
  lockTrade(tradeId: string, items?: ItemStack[], opts?: SendOptions) { return this.send('trade.lock', items ? { tradeId, items } : { tradeId }, opts); }
  getTrade(tradeId: string) { return this.send('trade.get', { tradeId }); }
  listTrades(status?: TradeStatus) { return this.send('trade.list', status ? { status } : {}); }
  receipts(o: { limit?: number; counterpartyId?: string } = {}) { return this.send('receipts.list', o); }

  // ---- feedback ----
  /** Report a suspected bug, confusing API behavior, or a missing feature straight to the operator. */
  // ---- parties ----
  /** Invites a player (by id) to your party; creates the party with you as leader if you have none. */
  partyInvite(playerId: string, opts?: SendOptions) { return this.send('party.invite', { playerId }, opts); }
  partyAccept(partyId: string, opts?: SendOptions) { return this.send('party.accept', { partyId }, opts); }
  partyDecline(partyId: string, opts?: SendOptions) { return this.send('party.decline', { partyId }, opts); }
  partyLeave(opts?: SendOptions) { return this.send('party.leave', {}, opts); }
  partyKick(playerId: string, opts?: SendOptions) { return this.send('party.kick', { playerId }, opts); }
  party() { return this.send('party.view', {}); }
  partySay(text: string, opts?: SendOptions) { return this.send('party.say', { text }, opts); }

  reportFeedback(o: { category: FeedbackCategory; summary: string; details?: string; relatedCommandId?: string }, opts?: SendOptions) {
    return this.send('reportFeedback', o, opts);
  }

  // ======================= events =======================

  /** Opens the live event stream (auto-reconnects). Resolves once connected. */
  async connect(): Promise<void> {
    if (this.wantStream) return;
    this.wantStream = true;
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => { resolveFirst = r; });
    this.streamLoop = this.runStream(resolveFirst);
    await Promise.race([first, sleep(5000)]);
  }

  /** Closes the event stream. Missed private messages can be caught up later with dmHistory / conversations. */
  async disconnect(): Promise<void> {
    this.wantStream = false;
    this.streamAbort?.abort();
    await this.streamLoop?.catch(() => {});
    this.streamLoop = null;
    this.connected = false;
  }

  private async runStream(onConnected: () => void) {
    let backoff = 200;
    while (this.wantStream) {
      const ac = new AbortController();
      this.streamAbort = ac;
      try {
        const res = await fetch(`${this.url}/api/events`, { headers: { authorization: `Bearer ${this.token}` }, signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        this.connected = true;
        backoff = 200;
        onConnected();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (data) this.dispatch(JSON.parse(data) as GameEvent);
          }
        }
      } catch (e) {
        if (!this.wantStream) break;
        this.log(`event stream error: ${(e as Error).message}`);
      }
      this.connected = false;
      if (this.wantStream) { await sleep(backoff); backoff = Math.min(backoff * 2, 5000); }
    }
  }

  private dispatch(ev: GameEvent) {
    if (this.recordEvents) this.received.push(ev);
    for (const key of [ev.type, '*']) {
      for (const h of this.handlers.get(key) ?? []) {
        try { h(ev); } catch (e) { this.log(`event handler error: ${(e as Error).message}`); }
      }
    }
  }

  /** Subscribe to one event type (or '*'). Returns an unsubscribe function. */
  on(type: EventType | '*', handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  /** Resolves with the first event matching `pred` (requires connect()). */
  waitForEvent(pred: (ev: GameEvent) => boolean, timeoutMs = 30_000): Promise<GameEvent> {
    return new Promise((resolve, reject) => {
      const off = this.on('*', (ev) => { if (pred(ev)) { clearTimeout(timer); off(); resolve(ev); } });
      const timer = setTimeout(() => { off(); reject(new Error('timed out waiting for event')); }, timeoutMs);
    });
  }

  // ======================= high level =======================

  async whoami(): Promise<{ playerId: string; name: string }> {
    if (!this.playerId) {
      const o = await this.observe();
      this.playerId = o.self.id;
      this.name = o.self.name;
    }
    return { playerId: this.playerId!, name: this.name! };
  }

  /** Polls `check` until it returns a truthy value. */
  async waitFor<T>(check: () => Promise<T | null | undefined | false>, o: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
    const deadline = Date.now() + (o.timeoutMs ?? 60_000);
    for (;;) {
      const v = await check();
      if (v) return v as T;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${o.what ?? 'condition'}`);
      await sleep(o.intervalMs ?? 100);
    }
  }

  async count(item: string, obs?: Observation): Promise<number> {
    const o = obs ?? (await this.observe());
    // A base id also counts carried uniques of that base (crafted gear is unique: `iron_sword#3f9a1c2b`).
    return o.self.inventory.filter((s) => s.item === item || (!item.includes('#') && baseOf(s.item) === item)).reduce((n, s) => n + s.qty, 0);
  }

  async waitReady(): Promise<Observation> {
    for (;;) {
      const o = await this.observe();
      const wait = Math.max(o.self.busyMs, o.self.travel?.arriveInMs ?? 0);
      if (wait <= 0) return o;
      await sleep(Math.min(wait + 2, 1000));
    }
  }

  // ---------------- map & movement ----------------

  /** The world map (generated per server; cached after the first call). Same as `(await catalog()).map`. */
  async map(): Promise<MapCatalog> {
    if (!this.mapCache) this.mapCache = (await this.catalog()).map;
    return this.mapCache;
  }

  /** Waits until the current walk ends (arrived, or stopped at a region edge while combat locked). */
  async waitArrival(timeoutMs = 120_000): Promise<Observation> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const o = await this.observe();
      if (!o.self.travel) return o;
      if (Date.now() > deadline) throw new Error('timed out waiting to arrive');
      await sleep(Math.min(o.self.travel.arriveInMs + 2, 1000));
    }
  }

  /**
   * Makes sure a tool for `job` of tier >= requiredToolTier(tier) is in the tool slot, equipping the best carried one if needed.
   * Returns the equipped tool id, or null when you carry none that fits (the next command then fails with TOOL_REQUIRED and a hint).
   */
  async equipToolFor(job: ToolJob, tier = 1): Promise<string | null> {
    const need = requiredToolTier(tier);
    const obs = await this.observe();
    const fits = (id?: string) => { const d = id ? itemDef(id) : undefined; return !!d?.toolFor?.includes(job) && (d.toolTier ?? 0) >= need; };
    const cur = obs.self.equipment.tool;
    if (fits(cur)) return cur!;
    const best = obs.self.inventory.filter((s) => s.qty > 0 && fits(s.item)).sort((a, b) => (itemDef(b.item)!.toolTier ?? 0) - (itemDef(a.item)!.toolTier ?? 0))[0];
    if (!best) return null;
    await this.sendWhenReady('equip', { item: best.item });
    return best.item;
  }

  /**
   * Walks to `target` and waits until there, retrying through busy time and combat locks.
   * `target`: a region (`'wilds'`), a place (`'bank'`, `'forge'`, …), the id of a node, mob, loot bag or player
   * (stops within interaction range), or `{ x, y }`.
   */
  async goTo(target: string | Pos, o: { timeoutMs?: number } = {}): Promise<Observation> {
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    const payload = typeof target === 'string' ? { to: target } : { x: target.x, y: target.y };
    for (let attempt = 0; ; attempt++) {
      const resp = await this.request('move', payload);
      if (!resp.ok) {
        const err = new CommandError(resp.error, 'move', resp.commandId);
        if (err.code === 'BAD_REQUEST' && /^already in /.test(err.message)) return this.observe();
        if (!err.transient || Date.now() > deadline) throw err;
        await sleep(Math.min(err.retryAfterMs ?? 100, 2000));
        continue;
      }
      if (!resp.result.travel) return this.observe();
      const obs = await this.waitArrival(Math.max(1000, deadline - Date.now()));
      const dest = resp.result.travel.dest;
      if (Math.hypot(obs.self.pos.x - dest.x, obs.self.pos.y - dest.y) < 0.05) return obs;
      // Stopped early (combat lock at a region edge): try again until the deadline.
      if (Date.now() > deadline) throw new Error(`goTo(${JSON.stringify(target)}) timed out at (${obs.self.pos.x}, ${obs.self.pos.y})`);
      await sleep(Math.min(Math.max(obs.self.combatLockedMs, 100), 2000));
    }
  }

  /** Walks to tile (x, y) and waits until there. */
  moveTo(x: number, y: number, o: { timeoutMs?: number } = {}) { return this.goTo({ x, y }, o); }

  /** Walks into region `zone` (to its anchor; in town that is the plaza next to every place). No-op when already there. */
  async travelTo(zone: ZoneId, o: { timeoutMs?: number } = {}): Promise<Observation> {
    const obs = await this.observe();
    if (obs.self.zone === zone && !obs.self.travel) return obs;
    return this.goTo(zone, o);
  }

  /** Shortest walkable path from your position (or `from`) to a tile, computed locally from the map. */
  async pathTo(x: number, y: number, from?: Pos): Promise<{ path: Pos[]; tiles: number; ms: number } | null> {
    const m = await this.map();
    const start = from ?? (await this.observe()).self.pos;
    const path = findPath(m, start, { x, y });
    if (!path) return null;
    const tiles = pathLength(path);
    return { path, tiles, ms: Math.round(tiles * m.msPerTile) };
  }

  /** A place (bank, smelter, sawmill, tannery, forge, workbench, quest_board, shop) with its distance from you. */
  async nearestPlace(id: PlaceId): Promise<{ id: PlaceId; x: number; y: number; distance: number }> {
    const [m, o] = await Promise.all([this.map(), this.observe()]);
    const p = m.places.find((s) => s.id === id);
    if (!p) throw new Error(`unknown place "${id}"; places: ${m.places.map((s) => s.id).join(', ')}`);
    return { ...p, distance: round1(Math.hypot(p.x - o.self.pos.x, p.y - o.self.pos.y)) };
  }

  /**
   * Nearest resource node yielding `item` (from the map, so also beyond view), in your region by default.
   * Nodes in view known to be depleted are skipped while others exist. `charges` is null when out of view.
   */
  async nearestNode(item: string, o: { region?: ZoneId | 'any'; obs?: Observation } = {}): Promise<{ id: string; type: string; region: ZoneId; x: number; y: number; distance: number; charges: number | null; nextChargeInMs: number } | null> {
    const [m, obs] = await Promise.all([this.map(), o.obs ? Promise.resolve(o.obs) : this.observe()]);
    const region = o.region ?? obs.self.zone;
    const seen = new Map(obs.zone.nodes.map((n) => [n.id, n]));
    const list = m.nodes
      .filter((n) => NODE_TYPES[n.type]?.item === item && (region === 'any' || n.region === region))
      .map((n) => ({ id: n.id, type: n.type, region: n.region, x: n.x, y: n.y, distance: round1(Math.hypot(n.x - obs.self.pos.x, n.y - obs.self.pos.y)), charges: seen.get(n.id)?.charges ?? null, nextChargeInMs: seen.get(n.id)?.nextChargeInMs ?? 0 }))
      .sort((a, b) => a.distance - b.distance);
    return list.find((n) => n.charges !== 0) ?? list[0] ?? null;
  }

  /** Nearest living mob of `type` in view that is free to fight (not fighting someone else), in your region. */
  async nearestMob(type: string, obs?: Observation): Promise<MobView | null> {
    const o = obs ?? (await this.observe());
    return o.zone.mobs.find((x) => x.type === type && x.alive && x.region === o.self.zone && (x.targetId === null || x.targetId === o.self.id)) ?? null;
  }

  /** Where nodes of `item` or mobs of `type` exist, by region (from the map). */
  private async whereIs(kind: 'node' | 'mob', what: string): Promise<string> {
    const m = await this.map();
    const regions = new Set(kind === 'node' ? m.nodes.filter((n) => NODE_TYPES[n.type]?.item === what).map((n) => n.region) : m.mobSpawns.filter((s) => s.type === what).map((s) => s.region));
    return regions.size ? `they are in ${[...regions].join(', ')}: travelTo('${[...regions][0]}') first` : 'none exist on this map';
  }

  /** Gathers `qty` more of `item` from nodes in your region, walking to the nearest node with charges. Equips a matching tool first. */
  async gatherItem(item: string, qty: number, o: { timeoutMs?: number } = {}): Promise<number> {
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    let got = 0;
    while (got < qty) {
      if (Date.now() > deadline) throw new Error(`gatherItem(${item}) timed out after ${got}/${qty}`);
      const obs = await this.waitReady();
      const here = obs.zone.nodes.find((n) => n.item === item && n.inRange && n.charges > 0);
      if (!here) {
        const node = await this.nearestNode(item, { obs });
        if (!node) throw new Error(`no ${item} nodes in ${obs.self.zone}; ${await this.whereIs('node', item)}`);
        if (node.charges === 0) {
          const inRange = obs.zone.nodes.find((n) => n.id === node.id)?.inRange;
          if (inRange) { await sleep(Math.min(node.nextChargeInMs || 100, 2000) + 2); continue; }
        }
        await this.goTo(node.id, { timeoutMs: Math.max(1000, deadline - Date.now()) });
        continue;
      }
      const nd = NODE_TYPES[here.type];
      if (nd) await this.equipToolFor(nd.skill, nd.tier);
      const resp = await this.request('gather', { nodeId: here.id });
      if (resp.ok) got += resp.result.qty;
      else if (resp.error.code !== 'OUT_OF_RANGE' && !TRANSIENT_ERRORS.has(resp.error.code)) throw new CommandError(resp.error, 'gather', resp.commandId);
    }
    return got;
  }

  /** Runs a refining or crafting recipe `count` times, batching, walking to the station when needed, and waiting out busy time. Equips a matching tool first. */
  async make(recipeId: string, count: number, kind: 'refine' | 'craft'): Promise<ItemStack> {
    const rd = RECIPES[recipeId];
    if (rd) await this.equipToolFor(rd.skill, rd.tier);
    let left = count;
    let made = 0;
    let item = '';
    while (left > 0) {
      const n = Math.min(left, MAX_CRAFT_BATCH);
      let r;
      try {
        r = await this.sendWhenReady(kind, { recipeId, count: n });
      } catch (e) {
        const station = RECIPES[recipeId]?.station;
        if (!(e instanceof CommandError) || e.code !== 'NO_STATION' || !station) throw e;
        await this.goTo(station);
        r = await this.sendWhenReady(kind, { recipeId, count: n });
      }
      made += r.output.qty;
      item = r.output.item;
      left -= n;
    }
    return { item, qty: made };
  }

  refineItem(recipeId: string, count = 1) { return this.make(recipeId, count, 'refine'); }
  craftItem(recipeId: string, count = 1) { return this.make(recipeId, count, 'craft'); }

  /** Waits (out of combat) until HP reaches `pct` of max: a fraction (0.9) or a percent (90). */
  async restUntil(pct = 0.9, timeoutMs = 60_000): Promise<Observation> {
    // Accept percent too (restUntil(80)): a fraction > 1 could never be reached.
    const frac = pct > 1 ? pct / 100 : pct;
    if (!(frac > 0 && frac <= 1)) throw new RangeError(`restUntil(${pct}): pass a fraction like 0.9 or a percent like 90`);
    return this.waitFor(async () => { const o = await this.observe(); return o.self.hp >= o.self.maxHp * frac ? o : null; }, { timeoutMs, intervalMs: 150, what: 'HP regen' });
  }

  /**
   * Fights a mob or player until it dies, leaves, or we die. Uses the best
   * ready attack from current gear; uses Brace/Evade when HP drops below `buffBelowPct`.
   */
  async fight(targetId: string, o: { buffBelowPct?: number; timeoutMs?: number; onTick?: (obs: Observation) => Promise<'continue' | 'stop'> } = {}): Promise<FightOutcome> {
    const deadline = Date.now() + (o.timeoutMs ?? 60_000);
    const loot: ItemStack[] = [];
    let hits = 0;
    const start = await this.observe();
    const deaths = () => this.received.filter((e) => e.type === 'self.died').length;
    const deathsBefore = deaths();
    const zone = start.self.zone;
    for (;;) {
      const obs = await this.observe();
      // Death respawns you in town (a region change you did not walk).
      if ((obs.self.zone !== zone && !obs.self.travel) || deaths() > deathsBefore) return { result: 'died', loot, hits };
      if (o.onTick && (await o.onTick(obs)) === 'stop') return { result: 'fled', loot, hits };
      const mob = obs.zone.mobs.find((m) => m.id === targetId);
      const player = obs.zone.players.find((p) => p.id === targetId);
      if ((mob && !mob.alive) || (!mob && !player)) return { result: mob ? 'killed' : 'target_gone', loot, hits };
      if (Date.now() > deadline) throw new Error(`fight(${targetId}) timed out`);
      const wait = obs.self.busyMs;
      if (!(mob ?? player)!.inRange) {
        // Close in (the target may be moving): re-aim every few hundred ms.
        const mv = await this.request('move', { to: targetId });
        if (!mv.ok && !TRANSIENT_ERRORS.has(mv.error.code)) {
          if (mv.error.code === 'BAD_REQUEST') return { result: 'target_gone', loot, hits };
          throw new CommandError(mv.error, 'move', mv.commandId);
        }
        // Pace the chase: re-aim at most every ~60-300 ms.
        await sleep(Math.max(60, mv.ok && mv.result.travel ? Math.min(mv.result.travel.arriveInMs + 2, 300) : Math.min(mv.ok ? 60 : (mv.error.retryAfterMs ?? 100), 300)));
        continue;
      }
      if (wait > 0) { await sleep(wait + 2); continue; }
      const hpPct = obs.self.hp / obs.self.maxHp;
      const buff = obs.self.abilities.find((a) => a.kind === 'buff' && a.readyInMs === 0);
      if (buff && hpPct < (o.buffBelowPct ?? 0.5)) {
        await this.request('ability.use', { ability: buff.id });
        continue;
      }
      const resp = await this.request('attack', { targetId });
      if (resp.ok) {
        hits++;
        loot.push(...resp.result.loot);
        if (resp.result.killed) return { result: 'killed', loot, hits };
      } else if (resp.error.code === 'TARGET_DEAD' || resp.error.code === 'INVALID_TARGET') {
        return { result: 'target_gone', loot, hits };
      } else if (resp.error.code === 'OUT_OF_RANGE') {
        await sleep(40);
      } else if (!TRANSIENT_ERRORS.has(resp.error.code)) {
        throw new CommandError(resp.error, 'attack', resp.commandId);
      }
    }
  }

  /**
   * Rerolls `item` with Alteration (magic) or Chaos (rare) until it has `affix` (at `minTier`+), or until the next
   * roll would push spent silver past `maxSilver`, or orbs run out. Transmutes a normal item first when using alteration.
   * Returns the final item and what was spent; `hit` says whether the affix landed.
   */
  async rerollUntil(item: string, affix: string, o: { maxSilver: number; minTier?: number; orb?: 'alteration' | 'chaos'; maxRolls?: number }): Promise<{ hit: boolean; item: UniqueItem; silverSpent: number; orbsUsed: number; stopReason: 'hit' | 'budget' | 'no_orbs' | 'max_rolls' }> {
    const orb = o.orb ?? 'alteration';
    const has = (u: UniqueItem) => u.affixes.some((a) => a.id === affix && a.tier >= (o.minTier ?? 1));
    let u = (await this.inspect(item)).item;
    await this.goTo('altar');
    let silverSpent = 0, orbsUsed = 0;
    const step = async (use: OrbId) => {
      const r = await this.modifyItem(u.id, use);
      silverSpent += r.fee; orbsUsed++; u = r.item;
    };
    while (!has(u)) {
      if (orbsUsed >= (o.maxRolls ?? 200)) return { hit: false, item: u, silverSpent, orbsUsed, stopReason: 'max_rolls' };
      const use: OrbId = orb === 'alteration' && u.rarity === 'normal' ? 'transmute' : orb;
      const q = await this.quoteModify(u.id, use);
      if (silverSpent + q.fee > o.maxSilver) return { hit: false, item: u, silverSpent, orbsUsed, stopReason: 'budget' };
      if ((await this.count(`orb_${use}`)) < 1) return { hit: false, item: u, silverSpent, orbsUsed, stopReason: 'no_orbs' };
      await step(use);
      // A magic item with room for one more affix: try Augmentation before rerolling.
      if (!has(u) && use === 'alteration' && u.affixes.length < 2 && (await this.count('orb_augment')) > 0) {
        const qa = await this.quoteModify(u.id, 'augment');
        if (silverSpent + qa.fee <= o.maxSilver) await step('augment');
      }
    }
    return { hit: true, item: u, silverSpent, orbsUsed, stopReason: 'hit' };
  }

  /**
   * Finds a free living mob of `type` in your region and walks into attack range of it: the nearest one in view,
   * else the nearest mob home (from the map) out of view; waits for a respawn when all are dead or busy.
   */
  async approachMob(type: string, o: { timeoutMs?: number } = {}): Promise<MobView> {
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    for (;;) {
      if (Date.now() > deadline) throw new Error(`approachMob(${type}) timed out`);
      const obs = await this.waitReady();
      const target = await this.nearestMob(type, obs);
      if (target?.inRange) return target;
      if (target) { await this.goTo(target.id, { timeoutMs: Math.max(1000, deadline - Date.now()) }); continue; }
      const m = await this.map();
      const homes = m.mobSpawns.filter((s) => s.type === type && s.region === obs.self.zone);
      if (!homes.length) throw new Error(`no ${type} in ${obs.self.zone}; ${await this.whereIs('mob', type)}`);
      const inView = new Map(obs.zone.mobs.map((x) => [x.id, x]));
      const unseen = homes.filter((h) => !inView.has(h.id)).sort((a, b) => Math.hypot(a.x - obs.self.pos.x, a.y - obs.self.pos.y) - Math.hypot(b.x - obs.self.pos.x, b.y - obs.self.pos.y));
      if (unseen.length) { await this.goTo(unseen[0].id, { timeoutMs: Math.max(1000, deadline - Date.now()) }); continue; }
      await sleep(Math.min(...homes.map((h) => inView.get(h.id)?.respawnInMs || 300), 2000) + 2);
    }
  }

  /** Kills `count` mobs of `mobType` in your region (see approachMob), resting between fights. Returns all loot. Equips a skinning knife first when the beast drops hides. */
  async hunt(mobType: string, count: number, o: { restBelowPct?: number; timeoutMs?: number } = {}): Promise<ItemStack[]> {
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    const loot: ItemStack[] = [];
    let kills = 0;
    const md = MOB_TYPES[mobType];
    // Beasts drop hides only to a killer with a skinning knife equipped.
    if (md?.drops.some((d) => d.skin)) await this.equipToolFor('skinning', md.tier);
    while (kills < count) {
      if (Date.now() > deadline) throw new Error(`hunt(${mobType}) timed out after ${kills}/${count}`);
      const obs = await this.waitReady();
      if (obs.self.hp < obs.self.maxHp * (o.restBelowPct ?? 0.6)) await this.restUntil(0.95);
      const target = await this.approachMob(mobType, { timeoutMs: Math.max(1000, deadline - Date.now()) });
      const r = await this.fight(target.id);
      loot.push(...r.loot);
      if (r.result === 'died') throw new Error(`died while hunting ${mobType}`);
      if (r.result === 'killed') kills++;
    }
    return loot;
  }

  /** Waits for a party invitation (from `fromId` if given) and accepts it. Returns the party id. */
  async acceptPartyInvite(o: { fromId?: string; timeoutMs?: number } = {}): Promise<string> {
    const inv = await this.waitFor(async () => (await this.observe()).partyInvites.find((i) => !o.fromId || i.fromId === o.fromId), { timeoutMs: o.timeoutMs ?? 60_000, intervalMs: 150, what: 'a party invitation' });
    await this.partyAccept(inv.partyId);
    return inv.partyId;
  }

  /**
   * Walks to the boss of type `mobType` in your region, waits for it to be alive, fights it until it dies or we die,
   * then loots its spoils bag if we may (`loot: false` leaves it). Bosses are built for groups: hunt them with a party.
   */
  async huntBoss(mobType: string, o: { timeoutMs?: number; waitForSpawnMs?: number; loot?: boolean } = {}): Promise<{ result: FightOutcome['result']; spoilsBagId: string | null; looted: ItemStack[] }> {
    const start = await this.waitReady();
    const home = (await this.map()).mobSpawns.find((s) => s.type === mobType && s.region === start.self.zone);
    if (!home) throw new Error(`no ${mobType} in ${start.self.zone}; ${await this.whereIs('mob', mobType)}`);
    await this.waitFor(async () => {
      const ob = await this.observe();
      const boss = ob.zone.mobs.find((m) => m.id === home.id);
      if (!boss) { await this.goTo(home.id); return null; }
      return boss.alive ? boss : null;
    }, { timeoutMs: o.waitForSpawnMs ?? 60_000, intervalMs: 250, what: `${mobType} to spawn` });
    const r = await this.fight(home.id, { timeoutMs: o.timeoutMs ?? 180_000 });
    if (r.result === 'died') return { result: r.result, spoilsBagId: null, looted: [] };
    const bag = (await this.observe()).zone.lootBags.find((b) => b.ownerId === home.id && b.spoils);
    if (!bag || o.loot === false || !bag.youMayLoot) return { result: r.result, spoilsBagId: bag?.id ?? null, looted: [] };
    const res = await this.lootAll(bag.id);
    return { result: r.result, spoilsBagId: bag.id, looted: res.taken };
  }

  /** Walks to a loot bag if needed and takes everything from it. */
  async lootAll(bagId: string) {
    const first = await this.request('loot', { bagId });
    if (first.ok) return first.result;
    if (first.error.code !== 'OUT_OF_RANGE' && !TRANSIENT_ERRORS.has(first.error.code)) throw new CommandError(first.error, 'loot', first.commandId);
    if (first.error.code === 'OUT_OF_RANGE') await this.goTo(bagId);
    return this.sendWhenReady('loot', { bagId });
  }

  /** Locks `items` into a trade and waits for its receipt (settled or expired). */
  async completeTrade(tradeId: string, items: ItemStack[], o: { timeoutMs?: number; commandId?: string } = {}): Promise<TradeReceipt> {
    const res = await this.send('trade.lock', { tradeId, items }, o.commandId ? { commandId: o.commandId } : {});
    if (res.receipt) return res.receipt;
    return this.waitForReceipt(tradeId, o.timeoutMs);
  }

  async waitForReceipt(tradeId: string, timeoutMs = 600_000): Promise<TradeReceipt> {
    return this.waitFor(async () => (await this.getTrade(tradeId)).receipt, { timeoutMs, intervalMs: 100, what: `receipt for ${tradeId}` });
  }
}
