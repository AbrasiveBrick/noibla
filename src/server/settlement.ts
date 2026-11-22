// Settlements: groups that hold a plot in a contested region and share a stockpile kept there.
// Membership, charter and votes are member business: their events go only to members (Visibility 'settlement').
// The public list shows a settlement's name, region, size and level (the plot marker in view shows its name), nothing else.
// The server never judges: it records every stockpile change with its actor (stockpile_log) and leaves the rest to players.

import { BUILDINGS, SETTLEMENT, TIMING, ZONES, type BuildingId, type ItemStack, type RecipeDef } from '../shared/catalog.ts';
import { MAP_RULES, dist, plotOf, type MapPlot } from '../shared/map.ts';
import {
  activeLevelOf, atPlot, buildingViews, capacityOf, giveWork, levelOf, projectViews, sharedShortfall, sharedStockView, sharedWorkActive,
  sharedWorkView, takeBack, units, works,
} from './buildings.ts';
import type {
  SettlementInviteView, SettlementMotionView, SettlementPublicView, SettlementSummary, SettlementView, StockpileEntry,
} from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { CommandDef, Player, Settlement, SettlementMotion, SettlementRole } from './types.ts';
import { addItems, describe, fail, hasItems, missing, newId, optInt, removeItems, reqStr, stacks, toBag, toStacks, type Bag } from './util.ts';

const ROLES: SettlementRole[] = ['member', 'steward', 'leader'];
const RANK: Record<SettlementRole, number> = { member: 0, steward: 1, leader: 2 };
const NAME_RE = new RegExp(`^[A-Za-z][A-Za-z0-9 '_-]{${SETTLEMENT.nameMin - 1},${SETTLEMENT.nameMax - 1}}$`);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function settlementOf(g: Game, p: Player): Settlement | undefined {
  return p.settlementId ? g.settlements.get(p.settlementId) : undefined;
}

function nameOf(g: Game, id: string): string { return g.players.get(id)?.name ?? 'unknown'; }
function roleOf(s: Settlement, id: string): SettlementRole | undefined { return s.members[id]?.role; }
function leaderOf(s: Settlement): string { return Object.entries(s.members).find(([, m]) => m.role === 'leader')![0]; }
function memberCount(s: Settlement): number { return Object.keys(s.members).length; }
function plot(g: Game, s: Settlement): MapPlot { return plotOf(g.map, s.plotId)!; }
const vis = (s: Settlement) => ({ kind: 'settlement' as const, id: s.id });

function liveInvites(g: Game, s: Settlement): [string, number][] {
  const now = g.now();
  return Object.entries(s.invites).filter(([, exp]) => exp > now);
}

/**
 * Drops expired motions and invitations in memory (call before reading or changing them). Not marked dirty on purpose:
 * read-only commands call it too, and an expired entry left in the database is dropped again on the next access.
 */
function prune(g: Game, s: Settlement) {
  const now = g.now();
  s.motions = s.motions.filter((m) => m.expiresAt > now);
  for (const [id, exp] of Object.entries(s.invites)) if (exp <= now) delete s.invites[id];
}

/** Yes votes a motion needs: more than half of all current members. */
function needed(s: Settlement): number { return Math.floor(memberCount(s) / 2) + 1; }

function motionView(g: Game, s: Settlement, m: SettlementMotion, viewer: string): SettlementMotionView {
  const votes = Object.entries(m.votes).filter(([id]) => s.members[id]);
  return {
    id: m.id, kind: m.kind, targetId: m.targetId, targetName: nameOf(g, m.targetId), openedBy: nameOf(g, m.openedBy),
    expiresInMs: Math.max(0, m.expiresAt - g.now()), yes: votes.filter(([, v]) => v).length, no: votes.filter(([, v]) => !v).length,
    needed: needed(s), yourVote: m.votes[viewer] ?? null,
  };
}

export function publicView(s: Settlement): SettlementPublicView {
  return { id: s.id, name: s.name, zone: s.zone, members: memberCount(s), level: s.level };
}

/** Full view, for members only. Stockpile contents are not in it: read them at the plot with stockpile.view. */
export function settlementView(g: Game, s: Settlement, viewer: string): SettlementView {
  const now = g.now();
  const pl = plot(g, s);
  return {
    id: s.id, name: s.name, zone: s.zone, plotId: s.plotId, x: pl.x, y: pl.y, level: s.level, foundedAt: s.foundedAt, founderName: nameOf(g, s.founderId),
    yourRole: roleOf(s, viewer)!,
    charter: { ...s.charter },
    members: Object.entries(s.members).sort(([, a], [, b]) => RANK[b.role] - RANK[a.role] || a.joinedAt - b.joinedAt)
      .map(([id, m]) => ({ id, name: nameOf(g, id), role: m.role, online: g.isOnline(id), joinedAt: m.joinedAt })),
    invites: liveInvites(g, s).map(([id, exp]) => ({ playerId: id, name: nameOf(g, id), expiresInMs: exp - now })),
    motions: s.motions.filter((m) => m.expiresAt > now).map((m) => motionView(g, s, m, viewer)),
    levelName: levelOf(s).name,
    activeLevel: activeLevelOf(s).level,
    slots: { used: s.buildings.length + Object.keys(s.projects).length, max: levelOf(s).slots },
    buildings: buildingViews(g, s),
    projects: projectViews(s),
    sharedWork: sharedWorkView(s),
    alerts: [...s.alerts].reverse(),
  };
}

export function settlementSummary(g: Game, p: Player): SettlementSummary | null {
  const s = settlementOf(g, p);
  if (!s) return null;
  const pl = plot(g, s);
  return { id: s.id, name: s.name, zone: s.zone, plotId: s.plotId, x: pl.x, y: pl.y, role: roleOf(s, p.id)!, level: s.level, buildings: s.buildings.filter((b) => !b.unpaid).map((b) => b.id) };
}

export function settlementInvitesFor(g: Game, p: Player): SettlementInviteView[] {
  const now = g.now();
  const out: SettlementInviteView[] = [];
  for (const s of g.settlements.values()) {
    const exp = s.invites[p.id];
    if (exp === undefined || exp <= now) continue;
    out.push({ settlementId: s.id, name: s.name, zone: s.zone, members: memberCount(s), expiresInMs: exp - now });
  }
  return out;
}

function freePlots(g: Game): MapPlot[] {
  const used = new Set([...g.settlements.values()].map((s) => s.plotId));
  return g.map.plots.filter((pl) => !used.has(pl.id));
}

// ---------- guards ----------

export function requireMember(g: Game, p: Player): Settlement {
  const s = settlementOf(g, p);
  if (!s) fail('SETTLEMENT_STATE', 'you are not in a settlement', undefined, 'settlement.list shows the settlements; settlement.found founds one at a free plot');
  prune(g, s!);
  return s!;
}

export function requireRole(g: Game, p: Player, min: SettlementRole, what: string): Settlement {
  const s = requireMember(g, p);
  const role = roleOf(s, p.id)!;
  if (RANK[role] < RANK[min]) fail('FORBIDDEN', `${what} needs the ${min} role${min === 'leader' ? '' : ' or higher'}; you are a ${role}`, undefined, min === 'leader' ? `ask the leader (${nameOf(g, leaderOf(s))}), or replace them with settlement.vote { kind: 'leader' }` : undefined);
  return s;
}

function requireTarget(g: Game, s: Settlement, payload: Record<string, any>, key = 'playerId'): Player {
  const id = reqStr(payload, key, 40);
  const target = g.players.get(id);
  if (!target || !s.members[id]) fail('NOT_FOUND', `${target?.name ?? id} is not a member of ${s.name}`, undefined, 'settlement.view lists the members and their ids');
  return target!;
}

/** Stockpile use: standing (not walking) within MAP_RULES.range.plot of the settlement's plot. */
export function requireAtPlot(g: Game, p: Player, s: Settlement, what: string) {
  const pl = plot(g, s);
  if (p.travel) fail('TRAVELING', `walking to ${p.travel.target ?? p.travel.to}`, p.travel.arriveAt - g.now(), 'wait for arrival');
  const d = dist(p.pos, pl);
  // Same region too: plots near a border must not be usable from the safe wilds.
  if (!atPlot(g, p, s)) {
    fail('OUT_OF_RANGE', `${what} needs you within ${MAP_RULES.range.plot} tiles of ${s.name}'s plot at (${pl.x}, ${pl.y}), standing in ${s.zone}; you are ${round1(d)} tiles away`, undefined, `walk there first: move { to: '${pl.id}' } (SDK: goTo('${pl.id}'))`);
  }
}

// ---------- audit log ----------

export function audit(g: Game, s: Settlement, actor: Player | null, action: StockpileEntry['action'], items: ItemStack[], building?: BuildingId) {
  if (!items.length) return;
  const ts = g.now();
  const res = g.store.run('INSERT INTO stockpile_log(settlement_id, ts, actor_id, actor_name, action, items, building) VALUES(?, ?, ?, ?, ?, ?, ?)', s.id, ts, actor?.id ?? null, actor?.name ?? null, action, JSON.stringify(items), building ?? null);
  const entry: StockpileEntry = { id: Number(res.lastInsertRowid), ts, actorId: actor?.id ?? null, actorName: actor?.name ?? null, action, items, ...(building ? { building } : {}) };
  // The automatic entries get their own event type, which the operator's event log prunes.
  const type = action === 'upkeep' || action === 'produced' || action === 'income' ? 'stockpile.upkeep' : 'stockpile.changed';
  g.emit(type, vis(s), { settlementId: s.id, entry }, actor ? { actor, zone: s.zone } : { zone: s.zone });
}

function logRows(g: Game, s: Settlement, limit: number, beforeId = Number.MAX_SAFE_INTEGER): StockpileEntry[] {
  return g.store.all<{ id: number; ts: number; actor_id: string | null; actor_name: string | null; action: StockpileEntry['action']; items: string; building: BuildingId | null }>(
    'SELECT id, ts, actor_id, actor_name, action, items, building FROM stockpile_log WHERE settlement_id = ? AND id < ? ORDER BY id DESC LIMIT ?', s.id, beforeId, limit,
  ).map((r) => ({ id: r.id, ts: r.ts, actorId: r.actor_id, actorName: r.actor_name, action: r.action, items: JSON.parse(r.items), ...(r.building ? { building: r.building } : {}) }));
}

// ---------- membership changes ----------

/** A new leader settles any motion to make them leader, so old votes cannot restore them later. */
function makeLeader(s: Settlement, id: string) {
  s.members[id].role = 'leader';
  s.motions = s.motions.filter((m) => !(m.kind === 'leader' && m.targetId === id));
}

function promoteSuccessor(g: Game, s: Settlement) {
  const [id] = Object.entries(s.members).sort(([, a], [, b]) => RANK[b.role] - RANK[a.role] || a.joinedAt - b.joinedAt)[0];
  makeLeader(s, id);
  g.emit('settlement.role', vis(s), { settlementId: s.id, playerId: id, name: nameOf(g, id), role: 'leader', reason: 'succession' }, { zone: s.zone });
}

/** Removes `who`. The best-ranked, longest-standing member leads if the leader goes; the last one out abandons the plot. */
function removeMember(g: Game, s: Settlement, who: Player, reason: 'leave' | 'expel' | 'exile', by?: Player): boolean {
  const wasLeader = roleOf(s, who.id) === 'leader';
  g.markSettlement(s);
  g.markPlayer(who);
  delete s.members[who.id];
  // What they gathered and gave stops counting for shared work. Their stash stays theirs: stash.withdraw at the plot still works.
  delete s.work[who.id];
  s.level = levelOf(s).level;
  delete who.settlementId;
  for (const m of s.motions) delete m.votes[who.id];
  s.motions = s.motions.filter((m) => m.targetId !== who.id);
  if (reason !== 'leave') s.barred[who.id] = g.now();
  const data = { settlementId: s.id, playerId: who.id, name: who.name, reason, ...(by ? { byId: by.id, byName: by.name } : {}) };
  g.emit('settlement.left', vis(s), data, { zone: s.zone, actor: who });
  if (reason !== 'leave') g.emit('settlement.left', { kind: 'player', playerId: who.id }, { ...data, settlementName: s.name }, {});
  g.markSettlement(s);
  if (!memberCount(s)) { disband(g, s); return true; }
  if (wasLeader) promoteSuccessor(g, s);
  return false;
}

/**
 * Nobody left: the plot is free again and the buildings fall. The stockpile, every stash (former members' included)
 * and the materials of unfinished projects spill into one loot bag at the plot that anyone may take.
 */
function disband(g: Game, s: Settlement) {
  const pl = plot(g, s);
  const spilled: Bag = { ...s.stockpile };
  for (const bag of [...Object.values(s.stashes), ...Object.values(s.projects).map((pr) => pr!.materials)]) addItems(spilled, toStacks(bag));
  const items = toStacks(spilled);
  let bagId: string | null = null;
  if (items.length) {
    const now = g.now();
    bagId = newId('bag');
    const bag = { id: bagId, zone: s.zone, x: pl.x, y: pl.y, ownerId: s.id, ownerName: `${s.name} (abandoned)`, items: spilled, createdAt: now, expiresAt: now + g.ms(TIMING.lootBagTtlMs) };
    g.bags.set(bagId, bag);
    g.markBag(bag);
    audit(g, s, null, 'abandoned', items);
    s.stockpile = {};
  }
  for (const owner of Object.keys(s.stashes)) g.emit('stash.spilled', { kind: 'player', playerId: owner }, { settlementId: s.id, name: s.name, plotId: s.plotId, bagId }, {});
  g.store.run('DELETE FROM watch_log WHERE settlement_id = ?', s.id);
  g.settlements.delete(s.id);
  g.markSettlement(s);
  g.emit('settlement.disbanded', { kind: 'zone', zone: s.zone }, { settlementId: s.id, name: s.name, plotId: s.plotId, bagId }, { zone: s.zone });
  if (bagId) g.emit('loot.dropped', { kind: 'zone', zone: s.zone }, { bagId, ownerId: s.id, ownerName: `${s.name} (abandoned)`, items }, { zone: s.zone });
}

// ---------- commands ----------

function found(g: Game, p: Player, payload: Record<string, any>) {
  const name = reqStr(payload, 'name', SETTLEMENT.nameMax).trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(name)) fail('BAD_REQUEST', `name must be ${SETTLEMENT.nameMin}-${SETTLEMENT.nameMax} chars: letters, digits, spaces, ' _ or -, starting with a letter`);
  if (p.settlementId) fail('SETTLEMENT_STATE', 'you are already in a settlement', undefined, 'settlement.leave first');
  if ([...g.settlements.values()].some((s) => s.name.toLowerCase() === name.toLowerCase())) fail('NAME_TAKEN', `a settlement named "${name}" exists`);
  if (p.travel) fail('TRAVELING', `walking to ${p.travel.target ?? p.travel.to}`, p.travel.arriveAt - g.now(), 'wait for arrival');
  if (ZONES[p.zone].safety !== 'contested') fail('WRONG_ZONE', `settlements can only be founded on a plot in a contested region (${Object.values(ZONES).filter((z) => z.safety === 'contested').map((z) => z.id).join(', ')})`, undefined, 'free plots are the catalog().map.plots whose observe().zone.plots entry has no settlement; walk to one with move { to: <plotId> }');
  const free = freePlots(g);
  const requested = payload.plotId === undefined ? undefined : reqStr(payload, 'plotId', 40);
  let pl: MapPlot | undefined;
  if (requested) {
    pl = plotOf(g.map, requested);
    if (!pl) fail('NOT_FOUND', `no plot ${requested}`, undefined, 'free plots are the catalog().map.plots whose observe().zone.plots entry has no settlement');
    if (!free.includes(pl!)) fail('SETTLEMENT_STATE', `plot ${requested} is taken`, undefined, 'free plots are the catalog().map.plots whose observe().zone.plots entry has no settlement');
  } else {
    pl = free.filter((x) => x.region === p.zone).sort((a, b) => dist(a, p.pos) - dist(b, p.pos))[0];
    if (!pl) fail('SETTLEMENT_STATE', `no free plot in ${p.zone}`, undefined, 'free plots are the catalog().map.plots whose observe().zone.plots entry has no settlement');
  }
  const d = dist(p.pos, pl!);
  if (p.zone !== pl!.region || d > MAP_RULES.range.plot + 1e-9) fail('OUT_OF_RANGE', `plot ${pl!.id} is ${round1(d)} tiles away at (${pl!.x}, ${pl!.y}); founding needs you within ${MAP_RULES.range.plot}`, undefined, `walk there first: move { to: '${pl!.id}' } (SDK: goTo('${pl!.id}'))`);
  const paid = removeItems(p.inventory, SETTLEMENT.foundCost);
  const silver = paid.filter((s) => s.item === 'silver').reduce((n, s) => n + s.qty, 0);
  g.store.ledger('destroyed.settlement', silver);
  const now = g.now();
  const s: Settlement = {
    id: newId('stl'), name, zone: pl!.region, plotId: pl!.id, founderId: p.id, foundedAt: now,
    members: { [p.id]: { role: 'leader', joinedAt: now } }, charter: { ...SETTLEMENT.defaultCharter }, stockpile: {}, invites: {}, barred: {}, motions: [], level: 1,
    buildings: [], projects: {}, stashes: {}, work: {}, alerts: [],
  };
  g.settlements.set(s.id, s);
  g.markSettlement(s);
  p.settlementId = s.id;
  g.markPlayer(p);
  g.emit('settlement.founded', { kind: 'zone', zone: s.zone }, { settlementId: s.id, name, zone: s.zone, plotId: s.plotId, x: pl!.x, y: pl!.y, founderId: p.id, founderName: p.name }, { zone: s.zone, actor: p });
  g.setLastAction(p, 'settlement', `founded ${name} at ${pl!.id}`);
  return { settlement: settlementView(g, s, p.id), paid };
}

function invite(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireRole(g, p, 'steward', 'inviting');
  const targetId = reqStr(payload, 'playerId', 40);
  const target = g.players.get(targetId);
  if (!target) fail('NOT_FOUND', `no player ${targetId}; use player.lookup to resolve names to stable ids`);
  if (s.members[targetId]) fail('SETTLEMENT_STATE', `${target!.name} is already a member`);
  if (memberCount(s) >= SETTLEMENT.maxMembers) fail('SETTLEMENT_STATE', `a settlement holds at most ${SETTLEMENT.maxMembers} members`);
  s.invites[targetId] = g.now() + g.ms(SETTLEMENT.inviteTtlMs);
  g.markSettlement(s);
  const data = { settlementId: s.id, name: s.name, zone: s.zone, fromId: p.id, fromName: p.name, playerId: targetId, playerName: target!.name, expiresInMs: g.ms(SETTLEMENT.inviteTtlMs) };
  g.emit('settlement.invited', { kind: 'player', playerId: targetId }, { ...data, members: memberCount(s) }, {});
  g.emit('settlement.invited', vis(s), data, { zone: s.zone, actor: p });
  g.setLastAction(p, 'settlement', `invited ${target!.name} to ${s.name}`);
  return { settlement: settlementView(g, s, p.id) };
}

function join(g: Game, p: Player, payload: Record<string, any>) {
  const id = reqStr(payload, 'settlementId', 40);
  const s = g.settlements.get(id);
  if (!s) fail('NOT_FOUND', `no settlement ${id}`, undefined, 'settlement.list shows settlements and their ids');
  if (p.settlementId) fail('SETTLEMENT_STATE', p.settlementId === id ? `you are already in ${s!.name}` : 'you are already in a settlement', undefined, 'settlement.leave first');
  prune(g, s!);
  const invited = s!.invites[p.id] !== undefined;
  if (!invited) {
    if (!s!.charter.open) fail('FORBIDDEN', `${s!.name} is closed: joining needs an invitation`, undefined, 'ask a leader or steward to settlement.invite you');
    if (s!.barred[p.id]) fail('FORBIDDEN', `${s!.name} removed you; you can only come back with a new invitation`);
  }
  if (memberCount(s!) >= SETTLEMENT.maxMembers) fail('SETTLEMENT_STATE', `${s!.name} is full (${SETTLEMENT.maxMembers})`);
  delete s!.invites[p.id];
  delete s!.barred[p.id];
  s!.members[p.id] = { role: 'member', joinedAt: g.now() };
  s!.level = levelOf(s!).level;
  p.settlementId = s!.id;
  g.markSettlement(s!);
  g.markPlayer(p);
  g.emit('settlement.joined', vis(s!), { settlementId: s!.id, playerId: p.id, name: p.name, invited }, { zone: s!.zone, actor: p });
  g.setLastAction(p, 'settlement', `joined ${s!.name}`);
  return { settlement: settlementView(g, s!, p.id) };
}

function decline(g: Game, p: Player, payload: Record<string, any>) {
  const id = reqStr(payload, 'settlementId', 40);
  const s = g.settlements.get(id);
  if (!s || s.invites[p.id] === undefined) fail('NOT_FOUND', `no invitation to settlement ${id}`);
  delete s!.invites[p.id];
  g.markSettlement(s!);
  g.emit('settlement.invited', vis(s!), { settlementId: s!.id, playerId: p.id, playerName: p.name, declined: true }, { zone: s!.zone, actor: p });
  return { declined: id };
}

function leave(g: Game, p: Player) {
  const s = requireMember(g, p);
  const disbanded = removeMember(g, s, p, 'leave');
  g.setLastAction(p, 'settlement', `left ${s.name}`);
  return { left: s.id, disbanded };
}

function expel(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireRole(g, p, 'steward', 'expelling');
  const targetId = reqStr(payload, 'playerId', 40);
  if (targetId === p.id) fail('BAD_REQUEST', 'use settlement.leave to leave');
  if (!s.members[targetId] && s.invites[targetId] !== undefined) { delete s.invites[targetId]; g.markSettlement(s); return { settlement: settlementView(g, s, p.id) }; }
  const target = requireTarget(g, s, payload);
  if (RANK[roleOf(s, target.id)!] >= RANK[roleOf(s, p.id)!]) fail('FORBIDDEN', `a ${roleOf(s, p.id)} cannot expel a ${roleOf(s, target.id)}`, undefined, roleOf(s, target.id) === 'leader' ? "replace the leader with settlement.vote { kind: 'leader' }, or exile them with settlement.vote { kind: 'exile' }" : 'ask the leader');
  removeMember(g, s, target, 'expel', p);
  g.setLastAction(p, 'settlement', `expelled ${target.name} from ${s.name}`);
  return { settlement: settlementView(g, s, p.id) };
}

function setRole(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireRole(g, p, 'leader', 'changing roles');
  const role = reqStr(payload, 'role', 10) as SettlementRole;
  if (!ROLES.includes(role)) fail('BAD_REQUEST', `role must be one of ${ROLES.join(', ')}`);
  const target = requireTarget(g, s, payload);
  if (target.id === p.id) fail('BAD_REQUEST', 'to hand over leadership, give another member the leader role');
  if (role === 'leader') {
    s.members[p.id].role = 'steward';
    g.emit('settlement.role', vis(s), { settlementId: s.id, playerId: p.id, name: p.name, role: 'steward', reason: 'handover', byName: p.name }, { zone: s.zone, actor: p });
  }
  if (role === 'leader') makeLeader(s, target.id);
  else s.members[target.id].role = role;
  g.markSettlement(s);
  g.emit('settlement.role', vis(s), { settlementId: s.id, playerId: target.id, name: target.name, role, reason: 'appointed', byName: p.name }, { zone: s.zone, actor: p });
  g.setLastAction(p, 'settlement', `made ${target.name} ${role} of ${s.name}`);
  return { settlement: settlementView(g, s, p.id) };
}

function setCharter(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireRole(g, p, 'leader', 'changing the charter');
  const c = { ...s.charter };
  if (payload.open !== undefined) {
    if (typeof payload.open !== 'boolean') fail('BAD_REQUEST', 'open must be true or false');
    c.open = payload.open;
  }
  if (payload.withdrawRole !== undefined) {
    if (!ROLES.includes(payload.withdrawRole)) fail('BAD_REQUEST', `withdrawRole must be one of ${ROLES.join(', ')}`);
    c.withdrawRole = payload.withdrawRole;
  }
  if (payload.taxPct !== undefined) c.taxPct = optInt(payload, 'taxPct', 0, SETTLEMENT.maxTaxPct, 0);
  s.charter = c;
  g.markSettlement(s);
  g.emit('settlement.charter', vis(s), { settlementId: s.id, charter: { ...c }, byId: p.id, byName: p.name }, { zone: s.zone, actor: p });
  g.setLastAction(p, 'settlement', `changed the charter of ${s.name}`);
  return { settlement: settlementView(g, s, p.id) };
}

/**
 * Opens a motion (or votes on the open one with the same kind and target). Passes, and takes effect at once, when more
 * than half of all current members have voted yes. Changing your vote is allowed until it passes or expires.
 */
function vote(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  const kind = reqStr(payload, 'kind', 10) as SettlementMotion['kind'];
  if (kind !== 'exile' && kind !== 'leader') fail('BAD_REQUEST', "kind must be 'exile' or 'leader'");
  const target = requireTarget(g, s, payload, 'targetId');
  if (payload.yes !== undefined && typeof payload.yes !== 'boolean') fail('BAD_REQUEST', 'yes must be true or false');
  const yes = payload.yes !== false;
  if (kind === 'leader' && roleOf(s, target.id) === 'leader') fail('SETTLEMENT_STATE', `${target.name} already leads ${s.name}`);
  // The target may vote against their own exile, but not for it.
  if (kind === 'exile' && yes && target.id === p.id) fail('BAD_REQUEST', 'use settlement.leave to leave');
  const now = g.now();
  let m = s.motions.find((x) => x.kind === kind && x.targetId === target.id);
  if (!m) {
    if (!yes) fail('SETTLEMENT_STATE', `no open ${kind} motion on ${target.name} to vote against`);
    m = { id: newId('motion'), kind, targetId: target.id, openedBy: p.id, openedAt: now, expiresAt: now + g.ms(SETTLEMENT.voteTtlMs), votes: {} };
    s.motions.push(m);
  }
  m.votes[p.id] = yes;
  g.markSettlement(s);
  const tally = motionView(g, s, m, p.id);
  const passed = tally.yes >= tally.needed;
  g.emit('settlement.vote', vis(s), { settlementId: s.id, motion: { ...tally, yourVote: undefined }, voterId: p.id, voterName: p.name, yes, passed }, { zone: s.zone, actor: p });
  if (passed) {
    s.motions = s.motions.filter((x) => x !== m);
    if (kind === 'leader') {
      const old = leaderOf(s);
      s.members[old].role = 'member';
      makeLeader(s, target.id);
      g.emit('settlement.role', vis(s), { settlementId: s.id, playerId: old, name: nameOf(g, old), role: 'member', reason: 'vote' }, { zone: s.zone });
      g.emit('settlement.role', vis(s), { settlementId: s.id, playerId: target.id, name: target.name, role: 'leader', reason: 'vote' }, { zone: s.zone });
    } else {
      removeMember(g, s, target, 'exile');
    }
  }
  g.setLastAction(p, 'settlement', `voted ${yes ? 'for' : 'against'} the ${kind} motion on ${target.name}`);
  return { motion: tally, passed, settlement: g.settlements.has(s.id) && p.settlementId === s.id ? settlementView(g, s, p.id) : null };
}

function view(g: Game, p: Player) {
  const s = settlementOf(g, p);
  if (s) prune(g, s);
  return { settlement: s ? settlementView(g, s, p.id) : null, invites: settlementInvitesFor(g, p) };
}

function list(g: Game) {
  return { settlements: [...g.settlements.values()].map(publicView) };
}

// ---------- stockpile ----------

function deposit(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  requireAtPlot(g, p, s, 'the stockpile');
  const asked = stacks(payload.items, 'items', false);
  const adding = units(toBag(asked));
  const room = capacityOf(s) - units(s.stockpile);
  if (adding && adding > room) fail('SETTLEMENT_STATE', `the stockpile has room for ${Math.max(0, room)} more items`, undefined, 'a storehouse holds much more; silver takes no room');
  const items = removeItems(p.inventory, asked);
  addItems(s.stockpile, items);
  const given = giveWork(g, s, p, items);
  g.markSettlement(s);
  g.markPlayer(p);
  audit(g, s, p, 'deposit', items);
  g.setLastAction(p, 'stockpile', `deposited ${describe(items)} in ${s.name}'s stockpile`);
  return { stockpile: toStacks(s.stockpile), inventory: toStacks(p.inventory), given };
}

function withdraw(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  const role = roleOf(s, p.id)!;
  if (RANK[role] < RANK[s.charter.withdrawRole]) fail('FORBIDDEN', `${s.name}'s charter lets only a ${s.charter.withdrawRole}${s.charter.withdrawRole === 'leader' ? '' : ' or higher'} withdraw; you are a ${role}`, undefined, 'ask someone who may, or the leader to change the charter');
  requireAtPlot(g, p, s, 'the stockpile');
  const items = removeItems(s.stockpile, stacks(payload.items, 'items', false));
  takeBack(g, s, p, items);
  addItems(p.inventory, items);
  g.markSettlement(s);
  g.markPlayer(p);
  audit(g, s, p, 'withdraw', items);
  g.setLastAction(p, 'stockpile', `withdrew ${describe(items)} from ${s.name}'s stockpile`);
  return { stockpile: toStacks(s.stockpile), inventory: toStacks(p.inventory) };
}

function stockpileView(g: Game, p: Player) {
  const s = requireMember(g, p);
  requireAtPlot(g, p, s, 'reading the stockpile');
  return { settlementId: s.id, items: toStacks(s.stockpile), used: units(s.stockpile), capacity: capacityOf(s), sharedWork: sharedStockView(g, s, p.id), log: logRows(g, s, SETTLEMENT.logPage) };
}

function stockpileLog(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  const limit = optInt(payload, 'limit', 1, 200, SETTLEMENT.logPage);
  const beforeId = optInt(payload, 'beforeId', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return { settlementId: s.id, entries: logRows(g, s, limit, beforeId) };
}

/**
 * refine { from: 'stockpile' }: shared work on what other members gave. It needs no withdraw right, because everything
 * made goes back into the stockpile.
 */
export function requireSharedWork(g: Game, p: Player, r: RecipeDef, count: number): Settlement {
  const { building } = SETTLEMENT.sharedWork;
  const def = BUILDINGS[building];
  if (!def.stations!.includes(r.station)) fail('BAD_REQUEST', `${r.id} is not refined at a ${def.name}, so there is no shared work in it`, undefined, 'withdraw what it needs and refine from your inventory');
  const s = requireMember(g, p);
  requireAtPlot(g, p, s, 'refining from the stockpile');
  if (!works(s, building)) fail('NO_STATION', `${s.name} has no working ${def.name}`, undefined, `build one, or put ${describe(def.upkeep)} in the stockpile if it is closed`);
  if (!sharedWorkActive(s)) {
    const need = SETTLEMENT.levels.find((l) => l.level === SETTLEMENT.sharedWork.minLevel)!;
    fail('SETTLEMENT_STATE', `shared work needs an active ${need.name}: ${need.buildings} paid-up buildings and ${need.members} members`, undefined, 'settlement.view shows activeLevel and which buildings work');
  }
  const short = sharedShortfall(g, s, p, r, count);
  if (short) {
    const wait = short.resting && short.ready + short.resting >= short.need ? short.nextReadyAt - g.now() : undefined;
    fail('NOT_ENOUGH_ITEMS', `${r.id} ×${count} from the stockpile needs ${short.need} ${short.item} that other members gave and that have rested; ${short.ready} are ready and ${short.resting} are resting`, wait,
      'shared work takes only raw materials another member gathered and deposited, after they rested in the stockpile (catalog.settlement.sharedWork.restMs). stockpile.view shows them in sharedWork. Your own materials: refine them from your inventory, without the bonus');
  }
  if (!hasItems(s.stockpile, r.inputs, count)) fail('NOT_ENOUGH_ITEMS', `the stockpile is missing ${missing(s.stockpile, r.inputs, count)}`);
  // The output may take a full stockpile one batch over its limit, never further.
  if (units(s.stockpile) > capacityOf(s)) fail('SETTLEMENT_STATE', 'the stockpile is over its limit', undefined, 'someone who may withdraw has to make room, or build a storehouse');
  return s;
}

/** Quest tax: moves the charter's share of a member's quest silver from their inventory into the stockpile. Returns the amount. */
export function taxQuestReward(g: Game, p: Player, silver: number): number {
  const s = settlementOf(g, p);
  if (!s || !s.charter.taxPct || silver <= 0) return 0;
  const tax = Math.floor((silver * s.charter.taxPct) / 100);
  if (tax <= 0) return 0;
  const items = removeItems(p.inventory, [{ item: 'silver', qty: tax }]);
  addItems(s.stockpile, items);
  g.markPlayer(p);
  g.markSettlement(s);
  audit(g, s, p, 'tax', items);
  return tax;
}

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const settlementCommands: Record<string, CommandDef> = {
  'settlement.found': rw(found),
  'settlement.invite': rw(invite),
  'settlement.join': rw(join),
  'settlement.decline': rw(decline),
  'settlement.leave': rw((g, p) => leave(g, p)),
  'settlement.expel': rw(expel),
  'settlement.setRole': rw(setRole),
  'settlement.setCharter': rw(setCharter),
  'settlement.vote': rw(vote),
  'settlement.view': ro((g, p) => view(g, p)),
  'settlement.list': ro((g) => list(g)),
  'stockpile.deposit': rw(deposit),
  'stockpile.withdraw': rw(withdraw),
  'stockpile.view': ro((g, p) => stockpileView(g, p)),
  'stockpile.log': ro(stockpileLog),
};
