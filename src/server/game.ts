// Authoritative game server core: state, transactions, idempotent command
// execution, event visibility, and the world tick.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { KIT_ADDED, KIT_VERSION, MOB_TYPES, NODE_TYPES, STARTER_KIT, STARTING_SILVER, BASE_HP, ZONES, type ZoneId } from '../shared/catalog.ts';
import { MAP_LAYOUT, generateMap, nearestWalkable, regionAt, type WorldMap } from '../shared/map.ts';
import type { ApiError, CommandResponse, EventType, GameEvent } from '../shared/protocol.ts';
import { Store } from './store.ts';
import { GameError, addItems, fail, makeRng, newId, sha256, stableStringify } from './util.ts';
import type { UniqueItem } from '../shared/protocol.ts';
import type { CommandDef, LootBag, Mob, Party, Player, ResourceNode, Settlement, SnapshotData, Subscriber, Trade, Visibility } from './types.ts';
import { syncCarried, syncPooled, upgradeSettlement } from './buildings.ts';
import { constructionCommands, settlementTick } from './construction.ts';
import { crimeCommands } from './crime.ts';
import { orbCommands } from './orbs.ts';
import { partyCommands } from './party.ts';
import { settlementCommands } from './settlement.ts';
import { bindUniques, worldCommands, worldTick, maxHp } from './world.ts';
import { socialCommands } from './social.ts';
import { tradeCommands, tradeTick } from './trade.ts';
import { backfillEconomyLedger } from './operator.ts';

export interface GameOptions {
  dbPath: string;
  /** World speed multiplier: all action durations are divided by it. */
  speed?: number;
  seed?: number;
  /** Seed of the procedurally generated map. Used only when the database has no map yet (a new world); afterwards the stored seed wins. Default: random. */
  mapSeed?: number;
  /** Operator credential for the dashboard. Must differ from any bot token. */
  operatorToken?: string;
  now?: () => number;
  tickMs?: number;
  log?: (line: string) => void;
}

const COMMAND_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,19}$/;
const RATE_PER_SEC = 40;
const RATE_BURST = 80;
/** A bot without an open event stream counts as online this long after its last command. Agents often think for 10-30 s between calls. */
const ONLINE_WINDOW_MS = 60_000;
/** How long after the act a copy (emitCopy) is sent, in real ms. */
const COPY_DELAY_MS = [250, 1000] as const;
/** Identical failures (same command type and error code, back to back) before the error carries `repeated`. */
export const REPEAT_THRESHOLD = 3;
/** Game-clock spacing of the operator's per-player progression snapshots. */
export const SNAPSHOT_INTERVAL_MS = 60_000;
/** High-volume operator events pruned after `EVENT_RETENTION_MS`; trades, deaths, quests, chat etc. are kept. */
const PRUNABLE_EVENTS = ['combat.hit', 'combat.buff', 'gather', 'travel.depart', 'travel.arrive', 'player.online', 'player.offline', 'command.failed', 'bank', 'shop', 'repair', 'eat', 'stockpile.upkeep', 'settlement.alert'];

export class Game {
  readonly store: Store;
  readonly speed: number;
  readonly rng: () => number;
  readonly operatorToken: string;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** The world map, generated once per world from a persisted seed. */
  readonly map: WorldMap;

  readonly players = new Map<string, Player>();
  readonly mobs = new Map<string, Mob>();
  readonly nodes = new Map<string, ResourceNode>();
  readonly bags = new Map<string, LootBag>();
  /** Crafted gear instances by unique id (`<base>#<hex>`). The id sits in inventories, banks, equipment, bags and trades like any item. */
  readonly uniques = new Map<string, UniqueItem>();
  readonly trades = new Map<string, Trade>();
  readonly parties = new Map<string, Party>();
  readonly settlements = new Map<string, Settlement>();
  readonly commands: Record<string, CommandDef>;

  private nameIndex = new Map<string, string>();
  private tokenIndex = new Map<string, string>();
  private dirtyPlayers = new Set<string>();
  private dirtyBags = new Set<string>();
  private dirtyUniques = new Set<string>();
  private dirtyTrades = new Set<string>();
  private dirtyParties = new Set<string>();
  private dirtySettlements = new Set<string>();
  private outbox: { ev: GameEvent; vis: Visibility; delayMs?: number }[] = [];
  /** Committed copies (emitCopy) waiting to be sent by a later tick. */
  private whispers: { ev: GameEvent; vis: Visibility; dueAt: number }[] = [];
  private subscribers = new Set<Subscriber>();
  private eventSeq: number;
  private rate = new Map<string, { tokens: number; at: number }>();
  private online = new Set<string>();
  private failStreak = new Map<string, { key: string; n: number }>();
  private flushedEventSeq = -1;
  readonly recentCommands = new Map<string, { ts: number; type: string; commandId: string; ok: boolean; code?: string }[]>();
  private timer: NodeJS.Timeout | null = null;
  private tickMs: number;
  private lastSnapshotAt: number;

  constructor(opts: GameOptions) {
    this.store = new Store(opts.dbPath);
    this.speed = Math.max(0.1, opts.speed ?? 1);
    this.rng = makeRng(opts.seed ?? Date.now());
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(l));
    this.tickMs = opts.tickMs ?? 25;
    this.lastSnapshotAt = this.store.get<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM snapshots')?.ts ?? -Infinity;
    this.operatorToken = opts.operatorToken ?? `op_${randomBytes(18).toString('hex')}`;
    this.commands = { ...worldCommands, ...orbCommands, ...socialCommands, ...tradeCommands, ...partyCommands, ...settlementCommands, ...constructionCommands, ...crimeCommands };
    this.eventSeq = Number(this.store.getMeta('event_seq') ?? '0');
    // Procedural map: generated when the world is created; the seed is stored so restarts rebuild the same map.
    let mapSeed = Number(this.store.getMeta('map_seed') ?? NaN);
    if (!Number.isFinite(mapSeed)) {
      mapSeed = (opts.mapSeed ?? randomBytes(4).readUInt32BE(0)) >>> 0;
      this.store.setMeta('map_seed', String(mapSeed));
    }
    this.map = generateMap(mapSeed, Object.values(ZONES).map((z) => ({ region: z.id, nodes: z.nodes, mobs: z.mobs, plots: z.plots })));
    this.load();
    bindUniques(this.uniques);
    backfillEconomyLedger(this.store);
    this.spawnWorld();
  }

  // ---------- time ----------

  /** Scales a base duration by world speed. */
  ms(base: number): number { return Math.max(1, Math.round(base / this.speed)); }

  // ---------- loading & persistence ----------

  private load() {
    const relayout = this.store.getMeta('map_layout') !== MAP_LAYOUT;
    for (const row of this.store.all<{ id: string; name: string; token_hash: string; data: string }>('SELECT id, name, token_hash, data FROM players')) {
      const p = this.migratePlayer(JSON.parse(row.data), relayout);
      if (relayout) this.store.run('UPDATE players SET data = ? WHERE id = ?', JSON.stringify(p), p.id);
      if (grantKit(p)) this.store.run('UPDATE players SET data = ? WHERE id = ?', JSON.stringify(p), p.id);
      this.players.set(p.id, p);
      this.nameIndex.set(p.name.toLowerCase(), p.id);
      this.tokenIndex.set(row.token_hash, p.id);
    }
    for (const row of this.store.all<{ data: string }>('SELECT data FROM uniques')) {
      const u = JSON.parse(row.data) as UniqueItem;
      this.uniques.set(u.id, u);
    }
    for (const row of this.store.all<{ data: string }>('SELECT data FROM loot_bags')) {
      const b = JSON.parse(row.data) as LootBag;
      if (b.x === undefined || b.y === undefined) { b.x = this.map.anchors[b.zone].x; b.y = this.map.anchors[b.zone].y; }
      if (relayout) {
        const pos = this.placeInRegion({ x: b.x, y: b.y }, b.zone);
        b.x = pos.x; b.y = pos.y;
        this.store.run('UPDATE loot_bags SET data = ? WHERE id = ?', JSON.stringify(b), b.id);
      }
      this.bags.set(b.id, b);
    }
    for (const row of this.store.all<{ data: string }>('SELECT data FROM trades')) {
      const t = JSON.parse(row.data) as Trade;
      this.trades.set(t.id, t);
    }
    for (const row of this.store.all<{ data: string }>('SELECT data FROM parties')) {
      const pt = JSON.parse(row.data) as Party;
      this.parties.set(pt.id, pt);
    }
    for (const row of this.store.all<{ data: string }>('SELECT data FROM settlements')) {
      const s = upgradeSettlement(JSON.parse(row.data));
      this.settlements.set(s.id, s);
    }
    if (relayout) this.store.setMeta('map_layout', MAP_LAYOUT);
  }

  /** A position saved on another map layout: the nearest open tile if that is still in `zone`, else that region's anchor. */
  private placeInRegion(pos: { x: number; y: number }, zone: ZoneId): { x: number; y: number } {
    const q = nearestWalkable(this.map, pos);
    return regionAt(this.map, q) === zone ? q : { ...this.map.anchors[zone] };
  }

  /**
   * Saves from before the map existed have a zone (or a zone-to-zone trip) but no position. Saves from an older map
   * layout have positions that may now lie in another region: those players stop walking and keep their saved region,
   * so nobody logs back in from the safe wilds into PvP land.
   */
  private migratePlayer(p: Player & { travel: any }, relayout: boolean): Player {
    if (p.travel && !Array.isArray(p.travel.path)) { p.zone = p.travel.to; p.travel = null; }
    const zone: ZoneId = p.zone && ZONES[p.zone] ? p.zone : 'town';
    if (relayout) p.travel = null;
    if (!p.pos) p.pos = { ...this.map.anchors[zone] };
    else if (relayout) p.pos = this.placeInRegion(p.pos, zone);
    else if (!p.travel) p.pos = nearestWalkable(this.map, p.pos);
    p.zone = regionAt(this.map, p.pos);
    return p;
  }

  private spawnWorld() {
    for (const n of this.map.nodes) {
      this.nodes.set(n.id, { id: n.id, type: n.type, zone: n.region, x: n.x, y: n.y, charges: NODE_TYPES[n.type].maxCharges, nextChargeAt: 0 });
    }
    for (const s of this.map.mobSpawns) {
      this.mobs.set(s.id, { id: s.id, type: s.type, zone: s.region, x: s.x, y: s.y, home: { x: s.x, y: s.y }, hp: MOB_TYPES[s.type].hp, aggro: {}, targetId: null, nextAttackAt: 0, deadUntil: 0 });
    }
  }

  markPlayer(p: Player) { this.dirtyPlayers.add(p.id); }
  markBag(b: LootBag) { this.dirtyBags.add(b.id); }
  markUnique(u: UniqueItem) { this.dirtyUniques.add(u.id); }
  markTrade(t: Trade) { this.dirtyTrades.add(t.id); }
  markParty(pt: Party) { this.dirtyParties.add(pt.id); }
  markSettlement(s: Settlement) { this.dirtySettlements.add(s.id); }

  private flushDirty() {
    // Shared work follows what inventories and stockpiles really hold (buildings.ts). Both run before anything is written.
    for (const id of this.dirtyPlayers) {
      const p = this.players.get(id);
      if (p) syncCarried(this, p);
    }
    for (const id of this.dirtySettlements) {
      const s = this.settlements.get(id);
      if (s) syncPooled(s);
    }
    for (const id of this.dirtyPlayers) {
      const p = this.players.get(id);
      if (p) this.store.run('UPDATE players SET data = ? WHERE id = ?', JSON.stringify(p), id);
    }
    for (const id of this.dirtyUniques) {
      const u = this.uniques.get(id);
      if (u) this.store.run('INSERT INTO uniques(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, JSON.stringify(u));
      else this.store.run('DELETE FROM uniques WHERE id = ?', id);
    }
    for (const id of this.dirtyBags) {
      const b = this.bags.get(id);
      if (b) this.store.run('INSERT INTO loot_bags(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, JSON.stringify(b));
      else this.store.run('DELETE FROM loot_bags WHERE id = ?', id);
    }
    for (const id of this.dirtyTrades) {
      const t = this.trades.get(id);
      if (t) this.store.run('INSERT INTO trades(id, status, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data', id, t.status, JSON.stringify(t));
    }
    for (const id of this.dirtyParties) {
      const pt = this.parties.get(id);
      if (pt) this.store.run('INSERT INTO parties(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, JSON.stringify(pt));
      else this.store.run('DELETE FROM parties WHERE id = ?', id);
    }
    for (const id of this.dirtySettlements) {
      const s = this.settlements.get(id);
      if (s) this.store.run('INSERT INTO settlements(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', id, JSON.stringify(s));
      else this.store.run('DELETE FROM settlements WHERE id = ?', id);
    }
    if (this.eventSeq !== this.flushedEventSeq) {
      this.store.setMeta('event_seq', String(this.eventSeq));
      this.flushedEventSeq = this.eventSeq;
    }
    this.clearDirty();
  }

  private clearDirty() { this.dirtyPlayers.clear(); this.dirtyBags.clear(); this.dirtyUniques.clear(); this.dirtyTrades.clear(); this.dirtyParties.clear(); this.dirtySettlements.clear(); }

  /** After a rollback, restore every touched entity from the database. */
  private reloadDirty() {
    for (const id of this.dirtyPlayers) {
      const row = this.store.get<{ data: string }>('SELECT data FROM players WHERE id = ?', id);
      if (row) this.players.set(id, JSON.parse(row.data));
    }
    for (const id of this.dirtyUniques) {
      const row = this.store.get<{ data: string }>('SELECT data FROM uniques WHERE id = ?', id);
      if (row) this.uniques.set(id, JSON.parse(row.data)); else this.uniques.delete(id);
    }
    for (const id of this.dirtyBags) {
      const row = this.store.get<{ data: string }>('SELECT data FROM loot_bags WHERE id = ?', id);
      if (row) this.bags.set(id, JSON.parse(row.data)); else this.bags.delete(id);
    }
    for (const id of this.dirtyTrades) {
      const row = this.store.get<{ data: string }>('SELECT data FROM trades WHERE id = ?', id);
      if (row) this.trades.set(id, JSON.parse(row.data)); else this.trades.delete(id);
    }
    for (const id of this.dirtyParties) {
      const row = this.store.get<{ data: string }>('SELECT data FROM parties WHERE id = ?', id);
      if (row) this.parties.set(id, JSON.parse(row.data)); else this.parties.delete(id);
    }
    for (const id of this.dirtySettlements) {
      const row = this.store.get<{ data: string }>('SELECT data FROM settlements WHERE id = ?', id);
      if (row) this.settlements.set(id, upgradeSettlement(JSON.parse(row.data))); else this.settlements.delete(id);
    }
    this.clearDirty();
  }

  /** Runs fn atomically: state changes, persistence and emitted events all commit or none do. */
  mutate<T>(fn: () => T): T {
    const outboxStart = this.outbox.length;
    try {
      const out = this.store.transaction(() => {
        const r = fn();
        this.flushDirty();
        return r;
      });
      this.dispatchOutbox();
      return out;
    } catch (e) {
      this.outbox.length = outboxStart;
      this.reloadDirty();
      throw e;
    }
  }

  // ---------- events ----------

  emit(type: EventType, vis: Visibility, data: unknown, meta: { zone?: ZoneId | null; actor?: Player } = {}): GameEvent {
    const ev: GameEvent = { id: ++this.eventSeq, ts: this.now(), type, data };
    if (meta.zone !== undefined) ev.zone = meta.zone;
    if (meta.actor) { ev.actorId = meta.actor.id; ev.actorName = meta.actor.name; }
    if (operatorCanSee(vis)) this.store.run('INSERT INTO events(id, ts, type, data) VALUES(?, ?, ?, ?)', ev.id, ev.ts, ev.type, JSON.stringify(ev));
    this.outbox.push({ ev, vis });
    return ev;
  }

  /**
   * Tells one player their version of `of` under the same id, so however many are told, the ids in everyone's stream
   * stay the same. The copy carries nothing else of the original, and the operator has the original.
   *
   * It is sent by a tick, a random moment later: writing to a stream takes time, so sending it with the command would
   * let whoever sent that time how many were told. Emit one copy per player who could have been told, to NOBODY for
   * those who weren't, so that the command does the same work either way.
   */
  emitCopy(of: GameEvent, type: EventType, playerId: string, data: unknown) {
    this.outbox.push({ ev: { id: of.id, ts: of.ts, type, zone: of.zone, data }, vis: { kind: 'player', playerId }, delayMs: randomInt(...COPY_DELAY_MS) });
  }

  /** Spends an id without an event, where whether an event was emitted is itself a secret. */
  skipEventId() { this.eventSeq++; }

  private dispatchOutbox() {
    const items = this.outbox.splice(0);
    for (const { ev, vis, delayMs } of items) {
      if (delayMs !== undefined) this.whispers.push({ ev, vis, dueAt: this.now() + delayMs });
      else this.send(ev, vis);
    }
  }

  private sendWhispers(now: number) {
    if (!this.whispers.length) return;
    const due = this.whispers.filter((w) => w.dueAt <= now);
    if (!due.length) return;
    this.whispers = this.whispers.filter((w) => w.dueAt > now);
    for (const { ev, vis } of due) this.send(ev, vis);
  }

  private send(ev: GameEvent, vis: Visibility) {
    for (const sub of this.subscribers) {
      if (this.canSee(sub, vis)) {
        try { sub.send(ev); } catch { /* subscriber gone */ }
      }
    }
  }

  /** Server-side access control for live events, evaluated at delivery time. */
  canSee(sub: Subscriber, vis: Visibility): boolean {
    if (sub.kind === 'operator') return operatorCanSee(vis);
    const p = this.players.get(sub.playerId);
    if (!p) return false;
    switch (vis.kind) {
      case 'zone': return p.zone === vis.zone;
      case 'forum': return p.zone === 'town';
      case 'player': return vis.playerId === p.id;
      case 'dm': return vis.a === p.id || vis.b === p.id;
      case 'party': return p.partyId === vis.partyId;
      case 'settlement': return !!p.settlementId && p.settlementId === vis.id;
      case 'operator': return false;
    }
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => { this.subscribers.delete(sub); };
  }

  hasPlayerStream(playerId: string): boolean {
    for (const s of this.subscribers) if (s.kind === 'player' && s.playerId === playerId) return true;
    return false;
  }

  /** Operator-visible events after `sinceId` (oldest first). With sinceId 0, the most recent `limit`. */
  operatorEventsSince(sinceId: number, limit = 500): GameEvent[] {
    const rows = sinceId > 0
      ? this.store.all<{ data: string }>('SELECT data FROM events WHERE id > ? ORDER BY id ASC LIMIT ?', sinceId, limit)
      : this.store.all<{ data: string }>('SELECT data FROM events ORDER BY id DESC LIMIT ?', limit).reverse();
    return rows.map((r) => JSON.parse(r.data) as GameEvent);
  }

  // ---------- auth ----------

  register(name: string): { playerId: string; name: string; token: string } {
    if (typeof name !== 'string' || !NAME_RE.test(name)) fail('BAD_REQUEST', 'name must be 3-20 chars: letters, digits, _ or -, starting with a letter');
    if (this.nameIndex.has(name.toLowerCase())) fail('NAME_TAKEN', `name "${name}" is taken`);
    const token = `bot_${randomBytes(24).toString('hex')}`;
    const now = this.now();
    const p: Player = {
      id: newId('p'), name, createdAt: now, zone: 'town', pos: { ...this.map.spawn }, travel: null, hp: BASE_HP,
      inventory: { silver: STARTING_SILVER, ...Object.fromEntries(STARTER_KIT.map((s) => [s.item, s.qty])) }, bank: {}, equipment: {}, toolKit: true, kitVersion: KIT_VERSION, skills: {},
      busyUntil: 0, cooldowns: {}, evadeUntil: 0, braceUntil: 0, lastCombatAt: 0, combatLockUntil: 0, lastRegenAt: 0, wear: {},
      quests: {}, stats: { kills: 0, deaths: 0 }, lastAction: { type: 'register', summary: 'arrived in Brightwater', at: now }, lastSeenAt: now,
    };
    this.mutate(() => {
      this.store.run('INSERT INTO players(id, name, token_hash, created_at, data) VALUES(?, ?, ?, ?, ?)', p.id, name, sha256(token), now, JSON.stringify(p));
      this.players.set(p.id, p);
      this.nameIndex.set(name.toLowerCase(), p.id);
      this.tokenIndex.set(sha256(token), p.id);
    });
    return { playerId: p.id, name, token };
  }

  authBot(token: string | undefined): Player | null {
    if (!token || !token.startsWith('bot_')) return null;
    const id = this.tokenIndex.get(sha256(token));
    return id ? this.players.get(id) ?? null : null;
  }

  authOperator(token: string | undefined): boolean {
    if (!token) return false;
    const a = Buffer.from(sha256(token));
    const b = Buffer.from(sha256(this.operatorToken));
    return timingSafeEqual(a, b);
  }

  playerByName(name: string): Player | undefined {
    const id = this.nameIndex.get(name.toLowerCase());
    return id ? this.players.get(id) : undefined;
  }

  isOnline(playerId: string): boolean { return this.online.has(playerId); }

  setLastAction(p: Player, type: string, summary: string) {
    p.lastAction = { type, summary, at: this.now() };
  }

  // ---------- commands ----------

  execute(playerId: string, req: { commandId?: unknown; type?: unknown; payload?: unknown }): CommandResponse {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: { code: 'UNAUTHORIZED', message: 'unknown player' } };
    const type = typeof req.type === 'string' ? req.type : '';
    const commandId = typeof req.commandId === 'string' ? req.commandId : '';
    p.lastSeenAt = this.now();
    if (!COMMAND_ID_RE.test(commandId)) return this.failure(p, type || 'unknown', commandId || null, new GameError('BAD_REQUEST', 'commandId must be 1-128 chars of [A-Za-z0-9_.:-]; reuse it only to retry the same command'));
    const def = this.commands[type];
    if (!def) return this.failure(p, type || 'unknown', commandId, new GameError('UNKNOWN_COMMAND', `unknown command "${type}"`));
    const payload = req.payload ?? {};
    if (typeof payload !== 'object' || Array.isArray(payload) || payload === null) return this.failure(p, type, commandId, new GameError('BAD_REQUEST', 'payload must be an object'));

    let hash = '';
    if (def.mutates) {
      hash = sha256(stableStringify({ type, payload }));
      const prior = this.store.get<{ payload_hash: string; result: string }>('SELECT payload_hash, result FROM commands WHERE player_id = ? AND command_id = ?', p.id, commandId);
      if (prior) {
        if (prior.payload_hash !== hash) return this.failure(p, type, commandId, new GameError('IDEMPOTENCY_CONFLICT', `commandId ${commandId} was already used for a different command`));
        return { ...(JSON.parse(prior.result) as CommandResponse), replayed: true } as CommandResponse;
      }
    }
    const limited = this.rateLimit(p.id);
    if (limited) return this.failure(p, type, commandId, limited);

    try {
      let response: CommandResponse;
      if (def.mutates) {
        response = this.mutate(() => {
          const result = def.run(this, p, payload as Record<string, any>);
          const resp: CommandResponse = { ok: true, commandId, result };
          this.store.run('INSERT INTO commands(player_id, command_id, type, payload_hash, result, at) VALUES(?, ?, ?, ?, ?, ?)', p.id, commandId, type, hash, JSON.stringify(resp), this.now());
          this.markPlayer(p);
          return resp;
        });
      } else {
        response = { ok: true, commandId, result: def.run(this, p, payload as Record<string, any>) };
      }
      this.noteCommand(p.id, type, commandId, true);
      this.failStreak.delete(p.id);
      return response;
    } catch (e) {
      if (e instanceof GameError) return this.failure(p, type, commandId, e);
      this.log(`[internal-error] player=${p.id} command=${type} id=${commandId} ${(e as Error).stack ?? e}`);
      return this.failure(p, type, commandId, new GameError('INTERNAL', 'internal server error'));
    }
  }

  private rateLimit(playerId: string): GameError | null {
    const now = this.now();
    const b = this.rate.get(playerId) ?? { tokens: RATE_BURST, at: now };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_SEC);
    b.at = now;
    this.rate.set(playerId, b);
    if (b.tokens < 1) return new GameError('RATE_LIMITED', 'too many commands', ((1 - b.tokens) / RATE_PER_SEC) * 1000);
    b.tokens -= 1;
    return null;
  }

  private noteCommand(playerId: string, type: string, commandId: string, ok: boolean, code?: string) {
    const list = this.recentCommands.get(playerId) ?? [];
    list.push({ ts: this.now(), type, commandId, ok, ...(code ? { code } : {}) });
    if (list.length > 20) list.shift();
    this.recentCommands.set(playerId, list);
  }

  /** Records a failed command, verbatim, for the operator's debug view and returns the error to the bot. */
  private failure(p: Player, type: string, commandId: string | null, err: GameError): CommandResponse {
    const red = { code: err.code, reason: err.message };
    this.noteCommand(p.id, type, commandId ?? '', false, red.code);
    try {
      this.mutate(() => {
        this.store.run('INSERT INTO failures(ts, player_id, command_id, type, code, reason) VALUES(?, ?, ?, ?, ?, ?)', this.now(), p.id, commandId, type, red.code, red.reason);
        this.emit('command.failed', { kind: 'operator' }, { playerId: p.id, name: p.name, commandId, type, code: red.code, reason: red.reason, transient: err.transient }, { actor: p });
      });
    } catch (e) {
      this.log(`[failure-log-error] ${(e as Error).message}`);
    }
    const error: ApiError = { code: err.code, message: err.message };
    if (err.retryAfterMs !== undefined) error.retryAfterMs = err.retryAfterMs;
    if (err.hint) error.hint = err.hint;
    const key = `${type}:${err.code}`;
    const prev = this.failStreak.get(p.id);
    const n = prev?.key === key ? prev.n + 1 : 1;
    this.failStreak.set(p.id, { key, n });
    if (n >= REPEAT_THRESHOLD) {
      error.repeated = n;
      const advice = err.transient
        ? `You got this same error ${n} times in a row: wait retryAfterMs before sending it again.`
        : `You got this same error ${n} times in a row: retrying will not change the outcome. Change something first.`;
      error.hint = error.hint ? `${error.hint} ${advice}` : advice;
    }
    return commandId ? { ok: false, commandId, error } : { ok: false, error };
  }

  // ---------- tick ----------

  tick() {
    const now = this.now();
    try {
      this.mutate(() => {
        worldTick(this, now);
        settlementTick(this, now);
        tradeTick(this, now);
        this.updateOnline(now);
      });
      this.sendWhispers(now);
      if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) this.snapshot(now);
    } catch (e) {
      this.log(`[tick-error] ${(e as Error).stack ?? e}`);
    }
  }

  /** Observation only: one progression row per player for the operator's sparklines and presence timeline. */
  private snapshot(now: number) {
    this.lastSnapshotAt = now;
    this.store.transaction(() => {
      for (const p of this.players.values()) {
        const data: SnapshotData = {
          skills: { ...p.skills }, kills: p.stats.kills, deaths: p.stats.deaths,
          carried: p.inventory.silver ?? 0, banked: p.bank.silver ?? 0,
          zone: p.zone, traveling: !!p.travel, online: this.online.has(p.id),
        };
        this.store.run('INSERT INTO snapshots(ts, player_id, data) VALUES(?, ?, ?)', now, p.id, JSON.stringify(data));
      }
    });
  }

  private updateOnline(now: number) {
    for (const p of this.players.values()) {
      const on = this.hasPlayerStream(p.id) || now - p.lastSeenAt < ONLINE_WINDOW_MS;
      if (on && !this.online.has(p.id)) {
        this.online.add(p.id);
        this.emit('player.online', { kind: 'operator' }, { playerId: p.id, name: p.name, zone: p.zone }, { actor: p, zone: p.zone });
      } else if (!on && this.online.has(p.id)) {
        this.online.delete(p.id);
        this.emit('player.offline', { kind: 'operator' }, { playerId: p.id, name: p.name, zone: p.zone }, { actor: p, zone: p.zone });
      }
    }
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close() {
    this.stop();
    this.subscribers.clear();
    this.store.close();
  }

  // ---------- helpers used by command modules ----------

  maxHp(p: Player) { return maxHp(p); }

  pruneCommands(olderThanMs = 24 * 3600_000) {
    this.store.run('DELETE FROM commands WHERE at < ?', this.now() - olderThanMs);
  }

  /** Housekeeping: drops old idempotency records, high-volume operator events and old failure rows. */
  prune(opts: { commandsMs?: number; eventsMs?: number; failuresMs?: number; snapshotsMs?: number; watchMs?: number } = {}) {
    const now = this.now();
    this.pruneCommands(opts.commandsMs);
    this.store.run(`DELETE FROM events WHERE ts < ? AND type IN (${PRUNABLE_EVENTS.map(() => '?').join(', ')})`, now - (opts.eventsMs ?? 24 * 3600_000), ...PRUNABLE_EVENTS);
    this.store.run('DELETE FROM watch_log WHERE ts < ?', now - (opts.watchMs ?? 7 * 24 * 3600_000));
    this.store.run('DELETE FROM sightings WHERE ts < ?', now - (opts.watchMs ?? 7 * 24 * 3600_000));
    this.store.run('DELETE FROM failures WHERE ts < ?', now - (opts.failuresMs ?? 7 * 24 * 3600_000));
    this.store.run('DELETE FROM snapshots WHERE ts < ?', now - (opts.snapshotsMs ?? 30 * 24 * 3600_000));
  }
}

/**
 * Players from before the tool slot get the whole starter kit. Everyone else gets only the tools added since the kit
 * version they hold. Both happen once. Returns whether the player changed.
 */
function grantKit(p: Player): boolean {
  if (p.toolKit && (p.kitVersion ?? 1) >= KIT_VERSION) return false;
  const give = !p.toolKit ? STARTER_KIT : Object.entries(KIT_ADDED).filter(([v]) => Number(v) > (p.kitVersion ?? 1)).flatMap(([, tools]) => tools);
  addItems(p.inventory, give);
  p.toolKit = true;
  p.kitVersion = KIT_VERSION;
  return true;
}

function operatorCanSee(vis: Visibility): boolean {
  return vis.kind === 'zone' || vis.kind === 'forum' || vis.kind === 'party' || vis.kind === 'settlement' || vis.kind === 'operator';
}
