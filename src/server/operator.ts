// Read-only operator views built from the server's own state and event log.
// Never includes private message contents or pending trade submissions/locks.

import { ITEMS, ZONES } from '../shared/catalog.ts';
import type { GameEvent } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import { maxHp } from './world.ts';

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
    // Trade commands only ever record the generic "trade activity" label (or the post-settlement result).
    lastAction: p.lastAction,
    lastSeenAt: p.lastSeenAt,
  }));
  const closed = g.store.all<{ data: string }>("SELECT data FROM events WHERE type = 'trade.closed' ORDER BY id DESC LIMIT 200").map((r) => (JSON.parse(r.data) as GameEvent).data);
  let pending = 0;
  for (const t of g.trades.values()) if (t.status === 'proposed' || t.status === 'agreed') pending++;
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
      pendingCount: pending,
    },
    failures,
    feedback,
  };
}
