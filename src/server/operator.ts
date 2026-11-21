// Read-only operator views built from the server's own state and event log.
// Nothing is scrubbed: agents run in isolated sandboxes and never see this view.
// Includes private messages, pending trade submissions and lock state.

import { ITEMS, QUESTS, SKILLS, ZONES, levelFor, type SkillId } from '../shared/catalog.ts';
import type { GameEvent } from '../shared/protocol.ts';
import { REPEAT_THRESHOLD, type Game } from './game.ts';
import type { Store } from './store.ts';
import { gearView, maxHp, posOf } from './world.ts';
import { MOB_TYPES, NODE_TYPES } from '../shared/catalog.ts';
import type { SnapshotData } from './types.ts';
import { silverFee } from './trade.ts';
import { toStacks } from './util.ts';

/** Commands and failures counted for the per-bot failure rate. */
const RATE_WINDOW_MS = 10 * 60_000;
const LEDGER_KINDS = { created: ['mobs', 'quests'], destroyed: ['death', 'repair', 'shop', 'tradeFee', 'orbFee'] } as const;

const silverOf = (stacks: { item: string; qty: number }[] | undefined) => (stacks ?? []).reduce((n, s) => n + (s.item === 'silver' ? s.qty : 0), 0);

/**
 * Seeds the cumulative silver ledger once from whatever events are still retained,
 * so a world that predates the ledger starts from its history rather than zero.
 * shop/repair events are pruned after a day, so older sinks of those kinds are missing.
 */
export function backfillEconomyLedger(store: Store) {
  if (store.getMeta('economy_since') !== undefined) return;
  store.transaction(() => {
    const first = store.get<{ ts: number | null }>('SELECT MIN(ts) AS ts FROM events')?.ts;
    const rows = store.all<{ type: string; data: string }>("SELECT type, data FROM events WHERE type IN ('combat.kill', 'quest', 'player.death', 'shop', 'repair', 'trade.closed')");
    for (const r of rows) {
      const d = (JSON.parse(r.data) as GameEvent).data as any;
      if (r.type === 'combat.kill') store.ledger('created.mobs', silverOf(d.loot));
      else if (r.type === 'quest' && d.status === 'claimed') store.ledger('created.quests', silverOf(d.reward));
      else if (r.type === 'player.death') store.ledger('destroyed.death', d.silverLost ?? 0);
      else if (r.type === 'shop' || r.type === 'repair') store.ledger(`destroyed.${r.type}`, d.paid ?? 0);
      else if (r.type === 'trade.closed' && d.outcome === 'settled') {
        for (const party of d.parties ?? []) store.ledger('destroyed.tradeFee', party.silverFee ?? silverFee({ silver: silverOf(party.received) }));
      }
    }
    store.setMeta('economy_since', String(first ?? Date.now()));
  });
}

function economy(g: Game, circulation: { carried: number; banked: number }) {
  const rows = new Map(g.store.all<{ kind: string; qty: number }>('SELECT kind, qty FROM economy_ledger').map((r) => [r.kind, r.qty]));
  const side = (k: 'created' | 'destroyed') => Object.fromEntries(LEDGER_KINDS[k].map((n) => [n, rows.get(`${k}.${n}`) ?? 0]));
  return {
    since: Number(g.store.getMeta('economy_since') ?? 0),
    created: side('created') as Record<(typeof LEDGER_KINDS)['created'][number], number>,
    destroyed: side('destroyed') as Record<(typeof LEDGER_KINDS)['destroyed'][number], number>,
    circulation: { ...circulation, total: circulation.carried + circulation.banked },
    /** Orb and shard flows (counts of items, not silver). */
    orbs: {
      created: { mobs: rows.get('orbs.created.mobs') ?? 0, crafted: rows.get('orbs.created.crafted') ?? 0, shop: rows.get('orbs.created.shop') ?? 0 },
      used: Object.fromEntries([...rows].filter(([k]) => k.startsWith('orbs.used.')).map(([k, v]) => [k.slice('orbs.used.'.length), v])) as Record<string, number>,
      shards: { salvage: rows.get('shards.created.salvage') ?? 0, found: rows.get('shards.created.found') ?? 0 },
    },
  };
}

/** Repeated failures grouped by (bot, command type, code), with a streak flag when a bot's latest failures are that same pair back to back. */
function failureSummary(g: Game) {
  const groups = g.store.all<any>(`SELECT player_id, type, code, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last, MAX(id) AS last_id
    FROM failures GROUP BY player_id, type, code ORDER BY n DESC, last DESC LIMIT 100`);
  const reasons = g.store.all<{ id: number; reason: string }>(`SELECT id, reason FROM failures WHERE id IN (${groups.map((x) => Number(x.last_id)).join(',') || 'NULL'})`);
  const reasonOf = new Map(reasons.map((r) => [r.id, r.reason]));
  const streaks = new Map<string, number>();
  for (const { player_id } of g.store.all<{ player_id: string }>('SELECT DISTINCT player_id FROM failures')) {
    // As in Game.failure, a successful write breaks the streak (read-only successes are not logged, so they cannot).
    const lastOk = g.store.get<{ at: number | null }>('SELECT MAX(at) AS at FROM commands WHERE player_id = ?', player_id)?.at ?? 0;
    const recent = g.store.all<{ type: string; code: string }>('SELECT type, code FROM failures WHERE player_id = ? AND ts > ? ORDER BY id DESC LIMIT 20', player_id, lastOk);
    let n = 0;
    while (n < recent.length && recent[n].type === recent[0].type && recent[n].code === recent[0].code) n++;
    if (n >= REPEAT_THRESHOLD) streaks.set(`${player_id}|${recent[0].type}|${recent[0].code}`, n);
  }
  return groups.map((x) => {
    const streak = streaks.get(`${x.player_id}|${x.type}|${x.code}`) ?? 0;
    return {
      playerId: x.player_id, name: g.players.get(x.player_id)?.name ?? '?', type: x.type, code: x.code,
      count: x.n, firstTs: x.first, lastTs: x.last, latestReason: reasonOf.get(Number(x.last_id)) ?? '', streak: streak > 0, streakLength: streak,
    };
  });
}

/** Per bot: failures and attempts (successful writes plus failures) in the last RATE_WINDOW_MS. */
function failureRates(g: Game, now: number) {
  const since = now - RATE_WINDOW_MS;
  const fails = new Map(g.store.all<{ player_id: string; n: number }>('SELECT player_id, COUNT(*) AS n FROM failures WHERE ts >= ? GROUP BY player_id', since).map((r) => [r.player_id, r.n]));
  const oks = new Map(g.store.all<{ player_id: string; n: number }>('SELECT player_id, COUNT(*) AS n FROM commands WHERE at >= ? GROUP BY player_id', since).map((r) => [r.player_id, r.n]));
  return (id: string) => {
    const failures = fails.get(id) ?? 0;
    const attempts = failures + (oks.get(id) ?? 0);
    return { failures, attempts, windowMs: RATE_WINDOW_MS };
  };
}

const totalLevel = (skills: Partial<Record<string, number>>) => SKILLS.reduce((n, s) => n + levelFor(skills[s] ?? 0), 0);

/** Progression snapshots: all retained rows on a first poll (sinceEventId 0), afterwards only rows with id > sinceSnapshotId. */
function snapshots(g: Game, sinceEventId: number, sinceSnapshotId: number) {
  const after = sinceEventId === 0 ? 0 : sinceSnapshotId;
  return g.store.all<{ id: number; ts: number; player_id: string; data: string }>('SELECT id, ts, player_id, data FROM snapshots WHERE id > ? ORDER BY id ASC', after).map((r) => {
    const d = JSON.parse(r.data) as SnapshotData;
    return { id: r.id, ts: r.ts, playerId: r.player_id, ...d, totalLevel: totalLevel(d.skills) };
  });
}

export function operatorState(g: Game, sinceEventId: number, sinceSnapshotId = 0) {
  const now = g.now();
  const rateOf = failureRates(g, now);
  const bots = [...g.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    online: g.isOnline(p.id),
    zone: p.zone,
    pos: (({ x, y }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }))(posOf(g, p)),
    travel: p.travel ? { from: p.travel.from, to: p.travel.to, dest: p.travel.path[p.travel.path.length - 1], target: p.travel.target ?? null, arriveInMs: Math.max(0, p.travel.arriveAt - now) } : null,
    hp: p.hp,
    maxHp: maxHp(p),
    equipment: { ...p.equipment },
    kills: p.stats.kills,
    deaths: p.stats.deaths,
    lastAction: p.lastAction,
    lastSeenAt: p.lastSeenAt,
    silver: { carried: p.inventory.silver ?? 0, banked: p.bank.silver ?? 0 },
    failureRate: rateOf(p.id),
    gear: gearView(p),
    skillLevels: Object.fromEntries(SKILLS.map((s) => [s, levelFor(p.skills[s] ?? 0)])) as Record<SkillId, number>,
    focus: [...(p.focus ?? [])],
    quests: Object.entries(p.quests).filter(([, q]) => q.status !== 'claimed').map(([questId, q]) => ({ questId, name: QUESTS[questId]?.name ?? questId, status: q.status, progress: Math.min(q.progress, QUESTS[questId]?.objective.count ?? q.progress), goal: QUESTS[questId]?.objective.count ?? 0 })),
    combatLockUntil: p.combatLockUntil,
  }));
  const circulation = bots.reduce((c, b) => ({ carried: c.carried + b.silver.carried, banked: c.banked + b.silver.banked }), { carried: 0, banked: 0 });
  const closed = g.store.all<{ data: string }>("SELECT data FROM events WHERE type = 'trade.closed' ORDER BY id DESC LIMIT 200").map((r) => (JSON.parse(r.data) as GameEvent).data);
  const pendingTrades = [...g.trades.values()]
    .filter((t) => t.status === 'proposed' || t.status === 'agreed')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({
      tradeId: t.id, status: t.status, createdAt: t.createdAt, proposalExpiresAt: t.proposalExpiresAt, lockDeadline: t.lockDeadline,
      parties: [t.proposerId, t.counterpartyId].map((id) => ({
        id, name: g.players.get(id)?.name ?? '?',
        promised: toStacks(t.terms[id] ?? {}),
        submitted: t.subs[id] ? toStacks(t.subs[id].items) : null,
        locked: !!t.subs[id]?.locked,
      })),
    }));
  const failures = g.store.all<any>('SELECT id, ts, player_id, command_id, type, code, reason FROM failures ORDER BY id DESC LIMIT 300').map((f) => ({
    id: f.id, ts: f.ts, playerId: f.player_id, name: g.players.get(f.player_id)?.name ?? '?', commandId: f.command_id, type: f.type, code: f.code, reason: f.reason,
  }));
  const feedback = g.store.all<any>('SELECT id, ts, player_id, category, summary, details, context FROM feedback ORDER BY id DESC LIMIT 100').map((f) => ({
    id: f.id, ts: f.ts, playerId: f.player_id, name: g.players.get(f.player_id)?.name ?? '?', category: f.category, summary: f.summary, details: f.details, context: JSON.parse(f.context),
  }));
  const events = g.operatorEventsSince(sinceEventId, sinceEventId === 0 ? 1500 : 500);
  return {
    now,
    speed: g.speed,
    zones: Object.values(ZONES).map((z) => ({ id: z.id, name: z.name, safety: z.safety })),
    /** The generated map (static per world) and live positions of mobs, nodes and loot bags. Bots are in `bots[].pos`. */
    map: g.map,
    entities: {
      mobs: [...g.mobs.values()].map((m) => {
        const alive = m.hp > 0 && m.deadUntil <= now;
        return { id: m.id, type: m.type, name: MOB_TYPES[m.type]?.name ?? m.type, x: Math.round((alive ? m.x : m.home.x) * 10) / 10, y: Math.round((alive ? m.y : m.home.y) * 10) / 10, alive, hp: m.hp, maxHp: MOB_TYPES[m.type]?.hp ?? 0, targetId: alive ? m.targetId : null };
      }),
      nodes: [...g.nodes.values()].map((n) => ({ id: n.id, type: n.type, item: NODE_TYPES[n.type]?.item ?? n.type, x: n.x, y: n.y, charges: n.charges, maxCharges: NODE_TYPES[n.type]?.maxCharges ?? 0 })),
      bags: [...g.bags.values()].map((b) => ({ id: b.id, x: b.x ?? 0, y: b.y ?? 0, ownerName: b.ownerName, items: toStacks(b.items) })),
    },
    items: Object.fromEntries(Object.values(ITEMS).map((i) => [i.id, i.name])),
    bots,
    events,
    trades: {
      settled: closed.filter((t) => t.outcome === 'settled'),
      timeouts: closed.filter((t) => t.outcome === 'expired'),
      pending: pendingTrades,
      pendingCount: pendingTrades.length,
    },
    failures,
    failureSummary: failureSummary(g),
    forumAds: g.store.all<any>('SELECT id, author_id, title, created_at FROM forum_threads ORDER BY id DESC LIMIT 30').map((t) => ({
      id: t.id, authorId: t.author_id, authorName: g.players.get(t.author_id)?.name ?? '?', title: t.title, createdAt: t.created_at,
    })),
    economy: economy(g, circulation),
    feedback,
    snapshots: snapshots(g, sinceEventId, sinceSnapshotId),
  };
}
