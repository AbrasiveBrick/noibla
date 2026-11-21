// Read-only operator views built from the server's own state and event log.
// Nothing is scrubbed: agents run in isolated sandboxes and never see this view.
// Includes private messages, pending trade submissions and lock state.

import { ITEMS, ZONES } from '../shared/catalog.ts';
import type { GameEvent } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import { maxHp } from './world.ts';
import { toStacks } from './util.ts';

export function operatorState(g: Game, sinceEventId: number) {
  const now = g.now();
  const bots = [...g.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    online: g.isOnline(p.id),
    zone: p.zone,
    travel: p.travel ? { from: p.travel.from, to: p.travel.to, arriveInMs: Math.max(0, p.travel.arriveAt - now) } : null,
    hp: p.hp,
    maxHp: maxHp(p),
    equipment: { ...p.equipment },
    kills: p.stats.kills,
    deaths: p.stats.deaths,
    lastAction: p.lastAction,
    lastSeenAt: p.lastSeenAt,
  }));
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
    feedback,
  };
}
