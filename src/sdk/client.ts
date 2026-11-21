// noibla bot SDK. Bots play the whole game through this client:
//  - low-level: one typed method per server command (`send` underneath),
//  - events: a live, server-filtered event stream (`connect`, `on`, `waitForEvent`),
//  - high-level: helpers that chain commands and wait out cooldowns/travel.
//
// Every command carries a commandId. Network retries reuse it, so a retried
// command can never duplicate items or transfers.

import { randomUUID } from 'node:crypto';
import { MAX_CRAFT_BATCH, zonePath, type AbilityId, type ItemStack, type Slot, type ZoneId } from '../shared/catalog.ts';
import {
  TRANSIENT_ERRORS,
  type ApiError, type CommandResponse, type CommandType, type EventType, type FeedbackCategory, type GameEvent,
  type Observation, type PayloadOf, type ResultOf, type TradeReceipt, type TradeStatus,
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
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.url}/api/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ commandId, type, payload }),
        });
        if (res.status >= 500) throw new Error(`server error ${res.status}`);
        return (await res.json()) as CommandResponse<ResultOf<K>>;
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
  move(to: ZoneId, opts?: SendOptions) { return this.send('move', { to }, opts); }
  gather(nodeId: string, opts?: SendOptions) { return this.send('gather', { nodeId }, opts); }
  refine(recipeId: string, count = 1, opts?: SendOptions) { return this.send('refine', { recipeId, count }, opts); }
  craft(recipeId: string, count = 1, opts?: SendOptions) { return this.send('craft', { recipeId, count }, opts); }

  // ---- gear & combat ----
  equip(item: string, opts?: SendOptions) { return this.send('equip', { item }, opts); }
  unequip(slot: Slot, opts?: SendOptions) { return this.send('unequip', { slot }, opts); }
  attack(targetId: string, ability?: AbilityId, opts?: SendOptions) { return this.send('attack', ability ? { targetId, ability } : { targetId }, opts); }
  useAbility(ability: AbilityId, targetId?: string, opts?: SendOptions) { return this.send('ability.use', targetId ? { ability, targetId } : { ability }, opts); }
  loot(bagId: string, items?: ItemStack[], opts?: SendOptions) { return this.send('loot', items ? { bagId, items } : { bagId }, opts); }

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
    return o.self.inventory.find((s) => s.item === item)?.qty ?? 0;
  }

  async waitReady(): Promise<Observation> {
    for (;;) {
      const o = await this.observe();
      const wait = Math.max(o.self.busyMs, o.self.travel?.arriveInMs ?? 0);
      if (wait <= 0) return o;
      await sleep(wait + 2);
    }
  }

  /** Walks zone by zone to `zone`, waiting out travel time and combat locks. */
  async travelTo(zone: ZoneId, o: { timeoutMs?: number } = {}): Promise<Observation> {
    const deadline = Date.now() + (o.timeoutMs ?? 60_000);
    for (;;) {
      const obs = await this.observe();
      if (obs.self.travel) { await sleep(obs.self.travel.arriveInMs + 2); continue; }
      if (obs.self.zone === zone) return obs;
      if (Date.now() > deadline) throw new Error(`travelTo(${zone}) timed out`);
      const next = zonePath(obs.self.zone!, zone)[0];
      const r = await this.sendWhenReady('move', { to: next }, { timeoutMs: o.timeoutMs ?? 60_000 });
      await sleep(r.travel.arriveInMs + 2);
    }
  }

  /** Gathers from nodes in the current zone until `qty` more of `item` were collected. */
  async gatherItem(item: string, qty: number, o: { timeoutMs?: number } = {}): Promise<number> {
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    let got = 0;
    while (got < qty) {
      if (Date.now() > deadline) throw new Error(`gatherItem(${item}) timed out after ${got}/${qty}`);
      const obs = await this.waitReady();
      const nodes = (obs.zone?.nodes ?? []).filter((n) => n.item === item);
      if (!nodes.length) throw new Error(`no ${item} nodes in ${obs.self.zone}`);
      const node = nodes.find((n) => n.charges > 0);
      if (!node) { await sleep(Math.min(...nodes.map((n) => n.nextChargeInMs || 100)) + 2); continue; }
      const resp = await this.request('gather', { nodeId: node.id });
      if (resp.ok) got += resp.result.qty;
      else if (!TRANSIENT_ERRORS.has(resp.error.code)) throw new CommandError(resp.error, 'gather', resp.commandId);
    }
    return got;
  }

  /** Runs a refining or crafting recipe `count` times, batching and waiting out busy time. */
  async make(recipeId: string, count: number, kind: 'refine' | 'craft'): Promise<ItemStack> {
    let left = count;
    let made = 0;
    let item = '';
    while (left > 0) {
      const n = Math.min(left, MAX_CRAFT_BATCH);
      const r = await this.sendWhenReady(kind, { recipeId, count: n });
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
    const zone = start.self.zone;
    for (;;) {
      const obs = await this.waitReady();
      if (obs.self.zone !== zone) return { result: 'died', loot, hits };
      if (o.onTick && (await o.onTick(obs)) === 'stop') return { result: 'fled', loot, hits };
      const mob = obs.zone?.mobs.find((m) => m.id === targetId);
      const player = obs.zone?.players.find((p) => p.id === targetId);
      if ((mob && !mob.alive) || (!mob && !player)) return { result: mob ? 'killed' : 'target_gone', loot, hits };
      if (Date.now() > deadline) throw new Error(`fight(${targetId}) timed out`);
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
      } else if (!TRANSIENT_ERRORS.has(resp.error.code)) {
        throw new CommandError(resp.error, 'attack', resp.commandId);
      }
    }
  }

  /** Kills `count` mobs of `mobType` in the current zone, resting between fights. Returns all loot. */
  async hunt(mobType: string, count: number, o: { restBelowPct?: number; timeoutMs?: number } = {}): Promise<ItemStack[]> {
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    const loot: ItemStack[] = [];
    let kills = 0;
    while (kills < count) {
      if (Date.now() > deadline) throw new Error(`hunt(${mobType}) timed out after ${kills}/${count}`);
      let obs = await this.waitReady();
      if (obs.self.hp < obs.self.maxHp * (o.restBelowPct ?? 0.6)) obs = await this.restUntil(0.95);
      const me = obs.self.id;
      const mobs = (obs.zone?.mobs ?? []).filter((m) => m.type === mobType);
      if (!mobs.length) throw new Error(`no ${mobType} in ${obs.self.zone}`);
      const target = mobs.find((m) => m.alive && (m.targetId === null || m.targetId === me));
      if (!target) { await sleep(Math.min(...mobs.map((m) => m.respawnInMs || 100)) + 2); continue; }
      const r = await this.fight(target.id);
      loot.push(...r.loot);
      if (r.result === 'died') throw new Error(`died while hunting ${mobType}`);
      if (r.result === 'killed') kills++;
    }
    return loot;
  }

  /** Takes everything from a loot bag. */
  lootAll(bagId: string) { return this.sendWhenReady('loot', { bagId }); }

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
