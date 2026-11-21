// World rules: observation, movement, gathering, refining, crafting,
// equipment, combat, death & loot, banking, quests.

import { randomBytes } from 'node:crypto';
import {
  ABILITIES, BASE_HP, SLOTS, affixText, UNIQUE_SEP, itemDef, baseOf, isUnique, TOOL_FAMILIES, requiredToolTier, type ToolJob, CATALOG, COMBAT, DEATH_SILVER_LOSS, FOCUS, ITEMS, MAX_CRAFT_BATCH, MOB_TYPES, NODE_TYPES, QUESTS, RECIPES, SHOP, SKILLS, TIMING, WEAR, XP, ZONES,
  effectiveLevel, levelFor, type AbilityId, type ItemStack, type SkillId, type Slot, type ZoneId,
} from '../shared/catalog.ts';
import type { UniqueItem, AbilityView, AttackResult, FocusView, GearWearView, Observation, QuestProgress, SkillView, TravelView, ZoneView } from '../shared/protocol.ts';
import { MAP_RULES, dist, findPath, inBounds, nearestWalkable, pathLength, placeOf, pointAlong, regionAt, walkable, type PlaceId, type Pos } from '../shared/map.ts';
import type { Game } from './game.ts';
import type { CommandDef, Mob, Player, Walk } from './types.ts';
import { addItems, describe, fail, hasItems, missing, newId, obj, optInt, removeItems, reqStr, stacks, toStacks } from './util.ts';

// ---------- affixes ----------

// The unique-item registry of the running game. Stats like maxHp(p) are read from many places that only hold a
// Player, so the Game binds its registry here once (one game per process; tests open games one at a time).
let REGISTRY: Map<string, UniqueItem> = new Map();
export function bindUniques(m: Map<string, UniqueItem>) { REGISTRY = m; }

/** Sum of an affix's values over the items equipped in `slots`. */
export function affixSum(p: Player, slots: Slot[], affixId: string): number {
  let n = 0;
  for (const slot of slots) {
    const id = p.equipment[slot];
    const u = id ? REGISTRY.get(id) : undefined;
    if (u) for (const a of u.affixes) if (a.id === affixId) n += a.value;
  }
  return n;
}
const COMBAT_SLOTS: Slot[] = ['weapon', 'armor'];
const pct = (v: number) => Math.min(0.9, v / 100);

// ---------- derived stats ----------

export function maxHp(p: Player): number {
  const armor = p.equipment.armor ? itemDef(p.equipment.armor) : undefined;
  return BASE_HP + Math.round((armor?.hpBonus ?? 0) * gearMultiplier(p, 'armor')) + affixSum(p, COMBAT_SLOTS, 'max_hp');
}

function defense(p: Player): number {
  const armor = p.equipment.armor ? itemDef(p.equipment.armor) : undefined;
  return (armor?.defense ?? 0) * gearMultiplier(p, 'armor');
}

// ---------- gear wear ----------

/** Wear is tracked per item id, so unequipping and re-equipping keeps it. */
function wearOf(p: Player, item: string): number { return p.wear?.[item] ?? 0; }

export function gearMultiplier(p: Player, slot: Slot): number {
  const item = p.equipment[slot];
  return item && wearOf(p, item) >= WEAR.max ? WEAR.brokenMultiplier : 1;
}

export function repairCost(item: string, wear: number): number {
  if (wear <= 0) return 0;
  return Math.ceil(((WEAR.repairCostByTier[itemDef(item)?.tier ?? 0] ?? 0) * wear) / WEAR.max);
}

export function gearView(p: Player): Partial<Record<Slot, GearWearView>> {
  const out: Partial<Record<Slot, GearWearView>> = {};
  for (const slot of SLOTS) {
    const item = p.equipment[slot];
    if (!item) continue;
    const wear = wearOf(p, item);
    const u = REGISTRY.get(item);
    out[slot] = { item, wear: Math.round(wear * 100) / 100, broken: wear >= WEAR.max, repairCost: repairCost(item, wear),
      ...(u ? { ilvl: u.ilvl, rarity: u.rarity, corrupted: u.corrupted, affixes: u.affixes.map((x) => `T${x.tier} ${affixText(x.id, x.value)}`) } : {}) };
  }
  return out;
}

function addWear(g: Game, p: Player, slot: Slot, amount: number) {
  if (slot === 'tool') amount *= 1 - pct(affixSum(p, ['tool'], 'durable'));
  const item = p.equipment[slot];
  if (!item || amount <= 0) return;
  const before = wearOf(p, item);
  if (before >= WEAR.max) return;
  p.wear = p.wear ?? {};
  p.wear[item] = Math.min(WEAR.max, before + amount);
  if (p.wear[item] >= WEAR.max) {
    if (slot === 'armor') p.hp = Math.min(p.hp, maxHp(p));
    g.emit('self.gearBroken', { kind: 'player', playerId: p.id }, { slot, item, note: `${item} is broken and works at ${WEAR.brokenMultiplier * 100}% strength. Repair it in town with the "repair" command (${repairCost(item, WEAR.max)} silver).` }, {});
  }
  g.markPlayer(p);
}

export function isFocused(p: Player, s: SkillId): boolean { return !!p.focus?.includes(s); }

/** The level that counts for rules (see FOCUS): full trained level when focused, capped otherwise. */
export function skillLevel(p: Player, s: SkillId): number { return effectiveLevel(p.skills[s] ?? 0, isFocused(p, s)); }

/** Adds XP (multiplied when the skill is focused) and returns the amount granted. */
function gainXp(p: Player, s: SkillId, xp: number): number {
  const gained = Math.max(0, Math.round(xp * (isFocused(p, s) ? FOCUS.xpMult : 1)));
  p.skills[s] = (p.skills[s] ?? 0) + gained;
  return gained;
}

/** 1 + whole part of `bonus` + one more with probability of its fraction. */
function rollBonus(g: Game, bonus: number): number {
  const whole = Math.floor(bonus);
  return whole + (g.rng() < bonus - whole ? 1 : 0);
}

export function focusView(g: Game, p: Player): FocusView {
  const ready = (p.focusDroppedAt ?? -Infinity) + g.ms(FOCUS.respecCooldownMs);
  return { skills: [...(p.focus ?? [])], slots: FOCUS.slots, unfocusedLevelCap: FOCUS.unfocusedLevelCap, respecReadyInMs: Math.max(0, Math.ceil(ready - g.now())) };
}

/** Abilities come from gear only: no classes. */
export function abilitiesOf(p: Player): { id: AbilityId; source: string }[] {
  const out: { id: AbilityId; source: string }[] = [];
  const weapon = p.equipment.weapon ? itemDef(p.equipment.weapon) : undefined;
  if (weapon?.abilities) for (const a of weapon.abilities) out.push({ id: a, source: weapon.id });
  else out.push({ id: 'punch', source: 'unarmed' });
  const armor = p.equipment.armor ? itemDef(p.equipment.armor) : undefined;
  if (armor?.abilities) for (const a of armor.abilities) if (!out.some((o) => o.id === a)) out.push({ id: a, source: armor.id });
  return out;
}

/** Tier of the equipped tool when it does `job`, else 0. */
export function equippedToolTier(p: Player, job: ToolJob): number {
  const def = p.equipment.tool ? itemDef(p.equipment.tool) : undefined;
  return def?.toolFor?.includes(job) ? def.toolTier ?? 0 : 0;
}

/** Fails with TOOL_REQUIRED unless the matching tool of a high enough tier is equipped. Returns the busy-time multiplier (broken tools are slow). */
function requireTool(g: Game, p: Player, job: ToolJob, tier: number, what: string): number {
  const need = requiredToolTier(tier);
  const have = equippedToolTier(p, job);
  if (have < need) {
    const equipped = p.equipment.tool ? `you have ${p.equipment.tool} equipped` : 'your tool slot is empty';
    fail('TOOL_REQUIRED', `${what} needs a tier ${need}+ ${TOOL_FAMILIES[job]} equipped in the tool slot; ${equipped}`, undefined, toolHint(p, job, need));
  }
  return gearMultiplier(p, 'tool') < 1 ? 1 / WEAR.brokenMultiplier : 1;
}

// ---------- position & guards ----------

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Live position: follows the walk path while walking. */
export function posOf(g: Game, p: Player): Pos {
  return p.travel ? pointAlong(p.travel.path, (g.now() - p.travel.departAt) / p.travel.msPerTile) : p.pos;
}

function requireArrived(g: Game, p: Player): ZoneId {
  if (p.travel) fail('TRAVELING', `walking to ${p.travel.target ?? p.travel.to}`, p.travel.arriveAt - g.now(), 'wait for arrival, or send a new move to change course');
  return p.zone;
}

function requireReady(g: Game, p: Player) {
  const now = g.now();
  if (p.busyUntil > now) fail('BUSY', 'still performing the previous action', p.busyUntil - now);
}

/** Region-wide features (trade, forum, focus): being anywhere in the region is enough, also while walking. */
export function requireZone(_g: Game, p: Player, zone: ZoneId, what: string): void {
  if (p.zone !== zone) fail('WRONG_ZONE', `${what} is only available in ${zone}`, undefined, `travelTo('${zone}') (move { to: '${zone}' }) first`);
}

const at = (x: number, y: number) => `(${x}, ${y})`;

function rangeHint(id: string) { return `walk there first: move { to: '${id}' } (SDK: goTo('${id}'))`; }

/** Places (bank, stations, quest board, shop) need you within MAP_RULES.range.place of them. */
function requirePlace(g: Game, p: Player, placeId: PlaceId, what: string, code: 'OUT_OF_RANGE' | 'NO_STATION' = 'OUT_OF_RANGE'): void {
  const place = placeOf(g.map, placeId)!;
  requireArrived(g, p);
  if (code === 'OUT_OF_RANGE') requireZone(g, p, regionAt(g.map, place), what);
  const d = dist(p.pos, place);
  if (d > MAP_RULES.range.place + 1e-9) {
    fail(code, `${what} needs you within ${MAP_RULES.range.place} tiles of the ${placeId} at ${at(place.x, place.y)} in ${regionAt(g.map, place)}; you are ${round1(d)} tiles away at ${at(round1(p.pos.x), round1(p.pos.y))}`, undefined, rangeHint(placeId));
  }
}

function requireInRange(g: Game, p: Player, target: Pos, id: string, what: string): void {
  const d = dist(p.pos, target);
  if (d > MAP_RULES.range.interact + 1e-9) {
    fail('OUT_OF_RANGE', `${what} ${id} is ${round1(d)} tiles away at ${at(round1(target.x), round1(target.y))}; range is ${MAP_RULES.range.interact}`, undefined, rangeHint(id));
  }
}

// ---------- observation ----------

function questViews(p: Player): QuestProgress[] {
  return Object.entries(p.quests).map(([questId, q]) => ({ questId, status: q.status, progress: Math.min(q.progress, QUESTS[questId].objective.count), goal: QUESTS[questId].objective.count }));
}

function walkView(g: Game, w: Walk): TravelView {
  const now = g.now();
  const dest = w.path[w.path.length - 1];
  return { from: w.from, to: w.to, dest: { ...dest }, ...(w.target ? { target: w.target } : {}), arriveAt: w.arriveAt, arriveInMs: Math.max(0, w.arriveAt - now) };
}

/** Your region plus everything within MAP_RULES.viewRadius (any region), nearest first. */
function zoneView(g: Game, p: Player): ZoneView {
  const zone = p.zone;
  const z = ZONES[zone];
  const now = g.now();
  const me = posOf(g, p);
  const R = MAP_RULES.viewRadius;
  const near = <T extends { distance: number }>(list: T[]) => list.filter((e) => e.distance <= R).sort((a, b) => a.distance - b.distance);
  const loc = (q: Pos, range: number) => { const d = dist(me, q); return { x: round1(q.x), y: round1(q.y), distance: round1(d), inRange: d <= range + 1e-9 }; };
  const I = MAP_RULES.range.interact;
  return {
    id: z.id, name: z.name, safety: z.safety, adjacent: z.adjacent, hasBank: z.hasBank, hasForum: z.hasForum, hasQuestBoard: z.hasQuestBoard, pvp: z.pvp,
    viewRadius: R,
    places: near(g.map.places.map((s) => ({ id: s.id, ...loc(s, MAP_RULES.range.place) }))),
    nodes: near([...g.nodes.values()].map((n) => {
      const def = NODE_TYPES[n.type];
      return { id: n.id, type: n.type, item: def.item, tier: def.tier, region: n.zone, ...loc(n, I), charges: n.charges, maxCharges: def.maxCharges, nextChargeInMs: n.charges < def.maxCharges ? Math.max(0, n.nextChargeAt - now) : 0 };
    })),
    mobs: near([...g.mobs.values()].map((m) => {
      const def = MOB_TYPES[m.type];
      const alive = m.deadUntil <= now && m.hp > 0;
      return { id: m.id, type: m.type, name: def.name, region: m.zone, ...loc(alive ? m : m.home, I), hp: alive ? m.hp : 0, maxHp: def.hp, alive, respawnInMs: alive ? 0 : Math.max(0, m.deadUntil - now), targetId: alive ? m.targetId : null };
    })),
    players: near([...g.players.values()].filter((o) => o.id !== p.id).map((o) => ({
      id: o.id, name: o.name, region: o.zone, ...loc(posOf(g, o), I), walking: !!o.travel, hpPct: Math.round((o.hp / maxHp(o)) * 100), equipment: { ...o.equipment }, inCombat: now - o.lastCombatAt < g.ms(TIMING.outOfCombatMs),
    }))),
    lootBags: near([...g.bags.values()].map((b) => ({ id: b.id, region: b.zone, ...loc({ x: b.x!, y: b.y! }, I), ownerId: b.ownerId, ownerName: b.ownerName, items: toStacks(b.items), expiresInMs: Math.max(0, b.expiresAt - now) }))),
  };
}

export function observe(g: Game, p: Player): Observation {
  const now = g.now();
  const abilities: AbilityView[] = abilitiesOf(p).map(({ id, source }) => ({ id, kind: ABILITIES[id].kind, readyInMs: Math.max(0, (p.cooldowns[id] ?? 0) - now, p.busyUntil - now), source }));
  const skills: Record<string, SkillView> = {};
  for (const s of SKILLS) skills[s] = { xp: p.skills[s] ?? 0, level: skillLevel(p, s), trainedLevel: levelFor(p.skills[s] ?? 0), focused: isFocused(p, s) };
  const unread = g.store.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dm_messages m LEFT JOIN dm_reads r ON r.player_id = ? AND r.conversation_id = m.conversation_id
     WHERE m.to_id = ? AND m.id > COALESCE(r.last_read_id, 0)`, p.id, p.id)?.n ?? 0;
  let openTrades = 0;
  for (const t of g.trades.values()) if ((t.status === 'proposed' || t.status === 'agreed') && (t.proposerId === p.id || t.counterpartyId === p.id)) openTrades++;
  return {
    now,
    self: {
      id: p.id, name: p.name, zone: p.zone,
      pos: (({ x, y }) => ({ x: round1(x), y: round1(y) }))(posOf(g, p)),
      travel: p.travel ? walkView(g, p.travel) : null,
      hp: p.hp, maxHp: maxHp(p), busyMs: Math.max(0, p.busyUntil - now),
      inCombat: now - p.lastCombatAt < g.ms(TIMING.outOfCombatMs), combatLockedMs: Math.max(0, p.combatLockUntil - now),
      equipment: { ...p.equipment }, inventory: toStacks(p.inventory), skills, abilities,
      effects: { evadeMs: Math.max(0, p.evadeUntil - now), braceMs: Math.max(0, p.braceUntil - now) },
      quests: questViews(p),
      focus: focusView(g, p),
      gear: gearView(p),
      uniques: uniquesOf(g, p),
    },
    zone: zoneView(g, p),
    unreadDms: unread,
    openTrades,
  };
}

// ---------- movement ----------

/** Resolves `move { to }`: a region id, a place id, or the id of a node, mob, loot bag or player (or a player's name). */
function resolveTarget(g: Game, p: Player, to: string): { dest: Pos; range: number } {
  if ((ZONES as Record<string, unknown>)[to]) {
    const zone = to as ZoneId;
    if (p.zone === zone && !p.travel) fail('BAD_REQUEST', `already in ${zone}`, undefined, `to walk inside ${zone}, move to { x, y } or to a target id (node, mob, place, player)`);
    return { dest: g.map.anchors[zone], range: 0 };
  }
  const place = placeOf(g.map, to);
  if (place) return { dest: place, range: 1.5 };
  const I = MAP_RULES.range.interact;
  const node = g.nodes.get(to);
  if (node) return { dest: node, range: I };
  const mob = g.mobs.get(to);
  if (mob) return { dest: mobAlive(g, mob) ? mob : mob.home, range: I };
  const bag = g.bags.get(to);
  if (bag) return { dest: { x: bag.x!, y: bag.y! }, range: I };
  const other = g.players.get(to) ?? g.playerByName(to);
  if (other && other.id !== p.id) return { dest: posOf(g, other), range: I };
  return fail('BAD_REQUEST', `unknown move target "${to}"`, undefined,
    `use a region (${Object.keys(ZONES).join(', ')}), a place (${g.map.places.map((s) => s.id).join(', ')}), a node/mob/loot bag/player id from observe(), or { x, y }`);
}

function move(g: Game, p: Player, payload: Record<string, any>) {
  let dest: Pos;
  let range = 0;
  let target: string | undefined;
  if (payload.to !== undefined) {
    target = reqStr(payload, 'to', 80);
    ({ dest, range } = resolveTarget(g, p, target));
  } else {
    if (!Number.isInteger(payload.x) || !Number.isInteger(payload.y)) fail('BAD_REQUEST', 'move needs { to: <region | place | id> } or integer { x, y }');
    dest = { x: payload.x, y: payload.y };
    if (!inBounds(g.map, dest.x, dest.y)) fail('BAD_REQUEST', `(${dest.x}, ${dest.y}) is outside the map (0..${g.map.width - 1}, 0..${g.map.height - 1})`);
    if (!walkable(g.map, dest.x, dest.y)) {
      const alt = nearestWalkable(g.map, dest);
      fail('BAD_REQUEST', `tile (${dest.x}, ${dest.y}) is blocked ('${g.map.tiles[dest.y][dest.x]}')`, undefined, `the nearest open tile is (${alt.x}, ${alt.y})`);
    }
  }
  requireReady(g, p);
  const now = g.now();
  const here = posOf(g, p);
  const path = findPath(g.map, here, dest, range);
  if (!path) return fail('BAD_REQUEST', `no path to ${target ?? at(dest.x, dest.y)}`);
  const full = dist(here, path[0]) > 1e-6 ? [{ ...here }, ...path] : path;
  const length = pathLength(full);
  if (length < 1e-6) {
    // Already there: stop any walk in progress.
    p.pos = { ...here };
    p.travel = null;
    return { travel: null, pos: { x: round1(here.x), y: round1(here.y) }, distance: 0 };
  }
  if (p.combatLockUntil > now && full.some((q) => regionAt(g.map, q) !== p.zone)) {
    const attackers = [...g.mobs.values()].filter((m) => m.targetId === p.id && mobAlive(g, m)).map((m) => `${MOB_TYPES[m.type].name} (${m.id}, ${m.hp} hp)`);
    fail('COMBAT_LOCKED', `cannot leave ${p.zone} while in combat`, p.combatLockUntil - now,
      attackers.length
        ? `every hit you deal or take renews the lock, and these mobs keep attacking you: ${attackers.join(', ')}. Kill them (or die) before leaving ${p.zone}.`
        : `stop attacking and wait retryAfterMs, then move. Moving inside ${p.zone} is allowed.`);
  }
  const msPerTile = g.ms(MAP_RULES.msPerTile);
  const end = full[full.length - 1];
  p.pos = { ...here };
  p.travel = { from: p.zone, to: regionAt(g.map, end), path: full, departAt: now, arriveAt: now + Math.max(1, Math.ceil(length * msPerTile)), msPerTile, ...(target ? { target } : {}) };
  g.setLastAction(p, 'move', `walking to ${target ?? at(end.x, end.y)} (${round1(length)} tiles)`);
  g.markPlayer(p);
  return { travel: walkView(g, p.travel), pos: { x: round1(here.x), y: round1(here.y) }, distance: round1(length) };
}

/** Advances a walk: region crossings (blocked while combat locked) and arrival. */
function walkTick(g: Game, p: Player, now: number) {
  const w = p.travel!;
  const done = now >= w.arriveAt;
  const pos = done ? { ...w.path[w.path.length - 1] } : pointAlong(w.path, (now - w.departAt) / w.msPerTile);
  const region = regionAt(g.map, pos);
  if (region !== p.zone) {
    if (p.combatLockUntil > now) {
      p.travel = null;
      g.emit('self.arrived', { kind: 'player', playerId: p.id }, { zone: p.zone, pos: { x: round1(p.pos.x), y: round1(p.pos.y) }, stopped: 'COMBAT_LOCKED', note: `stopped at the edge of ${p.zone}: you cannot leave a region while in combat` }, { zone: p.zone });
      g.setLastAction(p, 'move', `stopped at the edge of ${p.zone} (combat locked)`);
      g.markPlayer(p);
      return;
    }
    const from = p.zone;
    g.emit('travel.depart', { kind: 'zone', zone: from }, { playerId: p.id, name: p.name, from, to: region }, { zone: from, actor: p });
    p.zone = region;
    g.emit('travel.arrive', { kind: 'zone', zone: region }, { playerId: p.id, name: p.name, from, to: region }, { zone: region, actor: p });
    g.setLastAction(p, 'travel', `entered ${region}`);
    g.markPlayer(p);
  }
  p.pos = pos;
  if (done) {
    p.travel = null;
    g.emit('self.arrived', { kind: 'player', playerId: p.id }, { zone: p.zone, pos: { ...pos }, ...(w.target ? { target: w.target } : {}) }, { zone: p.zone });
    g.setLastAction(p, 'move', `arrived at ${w.target ?? at(pos.x, pos.y)} in ${p.zone}`);
    g.markPlayer(p);
  }
}

/** A chasing mob steps toward its target, sliding along walls, never leaving its region. */
function mobStep(g: Game, m: Mob, target: Pos, tiles: number) {
  const dx = target.x - m.x, dy = target.y - m.y;
  const d = Math.hypot(dx, dy);
  const s = Math.min(tiles, d - 1);
  if (s <= 0) return;
  for (const [ax, ay] of [[(dx / d) * s, (dy / d) * s], [Math.sign(dx) * s, 0], [0, Math.sign(dy) * s]]) {
    const nx = m.x + ax, ny = m.y + ay;
    if (walkable(g.map, Math.round(nx), Math.round(ny)) && regionAt(g.map, { x: nx, y: ny }) === m.zone) { m.x = nx; m.y = ny; return; }
  }
}

// ---------- gathering ----------

function gather(g: Game, p: Player, payload: Record<string, any>) {
  const nodeId = reqStr(payload, 'nodeId', 80);
  const zone = requireArrived(g, p);
  const node = g.nodes.get(nodeId);
  if (!node) fail('INVALID_TARGET', `no resource node ${nodeId}`);
  const def = NODE_TYPES[node!.type];
  const slow = requireTool(g, p, def.skill, def.tier, `${def.name} (tier ${def.tier})`);
  requireInRange(g, p, node!, nodeId, 'resource node');
  requireReady(g, p);
  const now = g.now();
  if (node!.charges <= 0) fail('DEPLETED', `${def.name} is depleted`, node!.nextChargeAt - now);
  const level = skillLevel(p, def.skill);
  let qty = 1 + rollBonus(g, Math.min(FOCUS.maxBonusYield, FOCUS.bonusYieldPerLevel * level) + affixSum(p, ['tool'], 'yield') / 100);
  const doubleDrop = affixSum(p, ['tool'], 'double_drop');
  if (doubleDrop > 0 && g.rng() < doubleDrop / 100) qty *= 2;
  if (node!.charges === def.maxCharges) node!.nextChargeAt = now + g.ms(TIMING.nodeRegenMs);
  node!.charges--;
  addItems(p.inventory, [{ item: def.item, qty }]);
  const xp = gainXp(p, def.skill, XP.gather(def.tier));
  const busy = g.ms(TIMING.gatherMs * Math.max(0.5, 1 - 0.05 * level) * slow * (1 - pct(affixSum(p, ['tool'], 'gather_speed'))));
  p.busyUntil = now + busy;
  addWear(g, p, 'tool', WEAR.perToolUse);
  questProgress(g, p, 'gather', def.item, qty);
  g.emit('gather', { kind: 'zone', zone }, { playerId: p.id, name: p.name, nodeId, item: def.item, qty }, { zone, actor: p });
  g.setLastAction(p, 'gather', `gathered ${qty}× ${def.item}`);
  g.markPlayer(p);
  return { item: def.item, qty, xp, skill: def.skill, level: skillLevel(p, def.skill), busyMs: busy };
}

function toolHint(p: Player, job: ToolJob, minTier: number): string {
  const family = TOOL_FAMILIES[job];
  const fits = (item: string) => { const d = itemDef(item); return !!d?.toolFor?.includes(job) && (d.toolTier ?? 0) >= minTier; };
  const carried = Object.keys(p.inventory).filter((i) => (p.inventory[i] ?? 0) > 0 && fits(i)).sort((a, b) => (itemDef(a)!.toolTier ?? 0) - (itemDef(b)!.toolTier ?? 0))[0];
  if (carried) return `you carry ${carried}: equip it first with equip("${carried}") (the SDK helpers gatherItem/refineItem/craftItem do this for you).`;
  const tool = Object.values(ITEMS).filter((i) => fits(i.id)).sort((a, b) => (a.toolTier ?? 0) - (b.toolTier ?? 0))[0];
  if (!tool) return `no ${family} of tier ${minTier}+ exists`;
  const r = RECIPES[tool.id];
  const ways = [`buy one from another player`];
  if (r) ways.unshift(`craft it (recipe "${r.id}" at the ${r.station} in town: ${describe(r.inputs)}; needs ${r.skill} level ${r.minLevel})`);
  if (SHOP[tool.id] !== undefined) ways.push(`buy it in town with shop.buy for ${SHOP[tool.id]} silver`);
  return `equip a ${tool.id} (tier ${tool.toolTier}) or better in the tool slot. This will fail until you do. Ways to get one: ${ways.join('; ')}.`;
}

// ---------- refining & crafting ----------

function makeItem(kind: 'refine' | 'craft') {
  return (g: Game, p: Player, payload: Record<string, any>) => {
    const recipeId = reqStr(payload, 'recipeId', 60);
    const count = optInt(payload, 'count', 1, MAX_CRAFT_BATCH, 1);
    const r = RECIPES[recipeId];
    if (!r) fail('BAD_REQUEST', `unknown recipe "${recipeId}"`);
    if (r!.kind !== kind) fail('BAD_REQUEST', `${recipeId} is a ${r!.kind} recipe; use the "${r!.kind}" command`);
    const zone = requireArrived(g, p);
    requirePlace(g, p, r!.station, recipeId, 'NO_STATION');
    requireReady(g, p);
    const level = skillLevel(p, r!.skill);
    const focused = isFocused(p, r!.skill);
    if (r!.requiresFocus && !focused) {
      fail('FOCUS_REQUIRED', `${recipeId} is a tier-${r!.tier} specialist recipe: only players focused in ${r!.skill} can make it`, undefined,
        (p.focus?.length ?? 0) < FOCUS.slots
          ? `add ${r!.skill} to your focus with focus.set in town (${FOCUS.slots - (p.focus?.length ?? 0)} free slot(s)), or buy ${r!.output.item} from a ${r!.skill} specialist`
          : `your ${FOCUS.slots} focus slots are full (${p.focus!.join(', ')}); buy ${r!.output.item} from a ${r!.skill} specialist, or swap a focus skill with focus.set`);
    }
    if (level < r!.minLevel) fail('SKILL_TOO_LOW', `${recipeId} needs ${r!.skill} level ${r!.minLevel}; you are level ${level}`);
    const slow = requireTool(g, p, r!.skill, r!.tier, `${recipeId} (tier ${r!.tier})`);
    if (!hasItems(p.inventory, r!.inputs, count)) fail('NOT_ENOUGH_ITEMS', `missing ${missing(p.inventory, r!.inputs, count)}`);
    removeItems(p.inventory, r!.inputs, count);
    let bonus = 0;
    const toolOutput = kind === 'refine' ? affixSum(p, ['tool'], 'refine_output') / 100 : 0;
    const chance = (focused ? Math.min(FOCUS.maxBonusOutput, FOCUS.bonusOutputPerLevel * level) : 0) + toolOutput;
    if (chance > 0) for (let i = 0; i < count; i++) if (g.rng() < chance) bonus++;
    // Refining tools with save_inputs: each unit may hand its inputs back.
    let saved = 0;
    const save = kind === 'refine' ? affixSum(p, ['tool'], 'save_inputs') : 0;
    if (save > 0) { for (let i = 0; i < count; i++) if (g.rng() < save / 100) saved++; if (saved) addItems(p.inventory, r!.inputs, saved); }
    const output: ItemStack = { item: r!.output.item, qty: r!.output.qty * count + bonus };
    const made = isGearKind(output.item) ? createUniques(g, p, output.item, output.qty, itemLevel(r!.tier, level) + affixSum(p, ['tool'], 'craft_ilvl')) : null;
    addItems(p.inventory, made ? made.map((u) => ({ item: u.id, qty: 1 })) : [output]);
    const xp = gainXp(p, r!.skill, XP[kind](r!.tier) * count);
    const base = kind === 'refine' ? TIMING.refineMs : TIMING.craftMs;
    const speed = kind === 'refine' ? pct(affixSum(p, ['tool'], 'refine_speed')) : 0;
    const busy = g.ms(base * count * Math.max(0.5, 1 - 0.05 * level) * slow * (1 - speed));
    p.busyUntil = g.now() + busy;
    addWear(g, p, 'tool', WEAR.perToolUse * count);
    if (kind === 'craft') questProgress(g, p, 'craft', output.item, output.qty);
    g.emit(kind, { kind: 'zone', zone }, { playerId: p.id, name: p.name, recipeId, output, station: r!.station }, { zone, actor: p });
    g.setLastAction(p, kind, `${kind === 'refine' ? 'refined' : 'crafted'} ${output.qty}× ${output.item}`);
    g.markPlayer(p);
    return { output, consumed: r!.inputs.map((s) => ({ item: s.item, qty: s.qty * (count - saved) })).filter((s) => s.qty > 0), xp, level: skillLevel(p, r!.skill), busyMs: busy, ...(bonus ? { bonus } : {}), ...(saved ? { inputsSaved: saved } : {}), ...(made ? { items: made } : {}) };
  };
}

/** Weapons, armor and tools are crafted as unique items. */
function isGearKind(base: string): boolean { const k = ITEMS[base]?.kind; return k === 'weapon' || k === 'armor' || k === 'tool'; }

/** Item level of a crafted base: 10 × tier + the crafter's effective skill level. */
export function itemLevel(tier: number, level: number): number { return 10 * tier + level; }

function createUniques(g: Game, p: Player, base: string, qty: number, ilvl: number): UniqueItem[] {
  const out: UniqueItem[] = [];
  for (let i = 0; i < qty; i++) {
    let id: string;
    do id = `${base}${UNIQUE_SEP}${randomHex()}`; while (g.uniques.has(id));
    const u: UniqueItem = { id, base, ilvl, rarity: 'normal', affixes: [], mods: 0, corrupted: false, craftedBy: p.name, craftedAt: g.now() };
    g.uniques.set(id, u);
    g.markUnique(u);
    out.push(u);
  }
  return out;
}

function randomHex(): string { return randomBytes(4).toString('hex'); }

// ---------- equipment ----------

function equip(g: Game, p: Player, payload: Record<string, any>) {
  const asked = reqStr(payload, 'item', 60);
  const def = itemDef(asked);
  if (!def?.slot) fail('NOT_EQUIPPABLE', `${asked} cannot be equipped`);
  if (p.travel) fail('TRAVELING', 'cannot change gear while traveling', p.travel.arriveAt - g.now());
  // A base id picks a carried copy: the plain item first, else your best unique of that base.
  const item = isUnique(asked) || (p.inventory[asked] ?? 0) > 0 ? asked : bestUnique(g, p.inventory, asked) ?? asked;
  removeItems(p.inventory, [{ item, qty: 1 }]);
  const slot = def!.slot!;
  const prev = p.equipment[slot];
  if (prev) addItems(p.inventory, [{ item: prev, qty: 1 }]);
  p.equipment[slot] = item;
  p.hp = p.zone === 'town' && !p.travel ? maxHp(p) : Math.min(p.hp, maxHp(p));
  g.setLastAction(p, 'equip', `equipped ${item}`);
  g.markPlayer(p);
  return { equipment: { ...p.equipment } };
}

/** Highest-item-level unique of `base` in the bag. */
function bestUnique(g: Game, bag: Record<string, number>, base: string): string | undefined {
  return Object.keys(bag).filter((k) => bag[k] > 0 && isUnique(k) && baseOf(k) === base)
    .sort((a, b) => (g.uniques.get(b)?.ilvl ?? 0) - (g.uniques.get(a)?.ilvl ?? 0) || a.localeCompare(b))[0];
}

/** Every unique the player owns (carried, equipped, banked), for observation. */
function uniquesOf(g: Game, p: Player): UniqueItem[] {
  const ids = new Set<string>([...Object.keys(p.inventory), ...Object.keys(p.bank), ...Object.values(p.equipment).filter((x): x is string => !!x)]);
  return [...ids].filter(isUnique).sort().map((id) => g.uniques.get(id)).filter((u): u is UniqueItem => !!u);
}

/** Public details of any unique item: anyone can inspect an id they were offered. */
function inspect(g: Game, _p: Player, payload: Record<string, any>) {
  const id = reqStr(payload, 'item', 60);
  const u = g.uniques.get(id);
  if (!u) fail('NOT_FOUND', `no unique item ${id}`, undefined, 'unique ids look like iron_sword#3f9a1c2b; see observe().self.uniques');
  return { item: u! };
}

function unequip(g: Game, p: Player, payload: Record<string, any>) {
  const slot = reqStr(payload, 'slot', 10) as Slot;
  if (!SLOTS.includes(slot)) fail('BAD_REQUEST', `slot must be one of ${SLOTS.join(', ')}`);
  const prev = p.equipment[slot];
  if (!prev) fail('BAD_REQUEST', `nothing equipped in ${slot}`);
  delete p.equipment[slot];
  addItems(p.inventory, [{ item: prev!, qty: 1 }]);
  p.hp = Math.min(p.hp, maxHp(p));
  g.markPlayer(p);
  return { equipment: { ...p.equipment } };
}

// ---------- combat ----------

export function clearAggro(g: Game, playerId: string) {
  for (const m of g.mobs.values()) {
    if (playerId in m.aggro) delete m.aggro[playerId];
    if (m.targetId === playerId) m.targetId = null;
  }
}

function mobAlive(g: Game, m: Mob) { return m.hp > 0 && m.deadUntil <= g.now(); }

function pickAbility(g: Game, p: Player, requested: AbilityId | undefined): AbilityId {
  const have = abilitiesOf(p);
  const now = g.now();
  if (requested) {
    if (!ABILITIES[requested]) fail('BAD_REQUEST', `unknown ability "${requested}"`);
    if (!have.some((a) => a.id === requested)) fail('ABILITY_UNAVAILABLE', `${requested} is not granted by your current gear (${have.map((a) => a.id).join(', ')})`);
    const ready = p.cooldowns[requested] ?? 0;
    if (ready > now) fail('ON_COOLDOWN', `${requested} is on cooldown`, ready - now);
    return requested;
  }
  const attacks = have.map((a) => ABILITIES[a.id]).filter((a) => a.kind === 'attack' && (p.cooldowns[a.id] ?? 0) <= now);
  attacks.sort((a, b) => (b.powerMult ?? 0) - (a.powerMult ?? 0));
  return attacks[0]?.id ?? 'punch';
}

function attackDamage(p: Player, ability: AbilityId): { damage: number; skill: SkillId } {
  const def = ABILITIES[ability];
  const weapon = p.equipment.weapon ? itemDef(p.equipment.weapon) : undefined;
  const skill: SkillId = weapon?.weaponSkill ?? 'unarmed';
  const base = def.flatDamage ?? (weapon?.power ?? 0) * gearMultiplier(p, 'weapon') * (def.powerMult ?? 1);
  const bonusLevels = Math.min(skillLevel(p, skill), COMBAT.damageBonusMaxLevel);
  return { damage: base * (1 + COMBAT.damageBonusPerLevel * bonusLevels) * (1 + affixSum(p, COMBAT_SLOTS, 'damage') / 100), skill };
}

function combatXp(damage: number): number {
  return damage > 0 ? Math.max(1, Math.round(damage * COMBAT.xpPerDamage)) : 0;
}

/** Applies damage to a player (armor, evade, brace) and handles death. */
export function damagePlayer(g: Game, target: Player, raw: number, source: { kind: 'mob' | 'player'; id: string; name: string }) {
  const now = g.now();
  let dodged = false;
  let dmg = raw * (1 - defense(target));
  if (target.evadeUntil > now) { dodged = true; target.evadeUntil = 0; dmg = 0; }
  else if (target.braceUntil > now) dmg *= 0.5;
  const damage = dodged ? 0 : Math.max(1, Math.round(dmg));
  target.hp = Math.max(0, target.hp - damage);
  if (!dodged) addWear(g, target, 'armor', WEAR.perHitTaken);
  target.lastCombatAt = now;
  target.combatLockUntil = now + g.ms(TIMING.combatLockMs);
  g.markPlayer(target);
  g.emit('self.damaged', { kind: 'player', playerId: target.id }, { sourceKind: source.kind, sourceId: source.id, sourceName: source.name, damage, dodged, hp: target.hp, maxHp: maxHp(target) }, { zone: target.zone });
  let killed = false;
  if (target.hp <= 0) { killPlayer(g, target, source); killed = true; }
  return { damage, dodged, killed };
}

function useAbility(g: Game, p: Player, payload: Record<string, any>, defaultToAttack: boolean): AttackResult {
  const targetId = payload.targetId === undefined ? undefined : reqStr(payload, 'targetId', 80);
  const requested = payload.ability === undefined ? undefined : (reqStr(payload, 'ability', 30) as AbilityId);
  const zone = requireArrived(g, p);
  if (!defaultToAttack && !requested) fail('BAD_REQUEST', 'ability is required');
  // Deterministic errors first, so a bot never waits out a cooldown to learn its gear lacks the ability.
  if (requested && ABILITIES[requested] && !abilitiesOf(p).some((a) => a.id === requested)) {
    fail('ABILITY_UNAVAILABLE', `${requested} is not granted by your current gear (${abilitiesOf(p).map((a) => a.id).join(', ')})`);
  }
  requireReady(g, p);
  const now = g.now();
  const ability = pickAbility(g, p, requested);
  const def = ABILITIES[ability];
  const gcd = g.ms(TIMING.globalCooldownMs * (1 - pct(affixSum(p, COMBAT_SLOTS, 'attack_speed'))));

  if (def.kind === 'buff') {
    if (ZONES[zone].safety === 'safe') fail('SAFE_ZONE', 'no combat in town');
    if (ability === 'evade') p.evadeUntil = now + g.ms(def.durationMs!);
    if (ability === 'brace') p.braceUntil = now + g.ms(def.durationMs!);
    p.cooldowns[ability] = now + g.ms(def.cooldownMs * (1 - pct(affixSum(p, COMBAT_SLOTS, 'guard'))));
    p.busyUntil = now + gcd;
    g.emit('combat.buff', { kind: 'zone', zone }, { playerId: p.id, name: p.name, ability }, { zone, actor: p });
    g.setLastAction(p, 'combat', `used ${ability}`);
    g.markPlayer(p);
    return { ability, targetId: null, damage: 0, dodged: false, targetHp: null, killed: false, loot: [], xp: 0, busyMs: gcd };
  }

  if (!targetId) fail('BAD_REQUEST', 'targetId is required for attacks');
  if (ZONES[zone].safety === 'safe') fail('SAFE_ZONE', 'no combat in town');
  const mob = g.mobs.get(targetId!);
  const victim = mob ? undefined : g.players.get(targetId!);
  if (mob) {
    if (!mobAlive(g, mob)) fail('TARGET_DEAD', `${targetId} is dead`);
    requireInRange(g, p, mob, mob.id, MOB_TYPES[mob.type].name);
  } else if (victim) {
    if (victim.id === p.id) fail('INVALID_TARGET', 'cannot attack yourself');
    if (!ZONES[zone].pvp) fail('SAFE_ZONE', `PvP is not allowed in ${zone}`);
    if (!ZONES[victim.zone].pvp) fail('SAFE_ZONE', `${victim.name} is in ${victim.zone}, where PvP is not allowed`);
    requireInRange(g, p, posOf(g, victim), victim.id, victim.name);
  } else {
    fail('INVALID_TARGET', `no target ${targetId}`);
  }

  const { damage: raw, skill } = attackDamage(p, ability);
  addWear(g, p, 'weapon', WEAR.perAttack);
  const weaponWear = p.equipment.weapon ? Math.round(wearOf(p, p.equipment.weapon) * 100) / 100 : undefined;
  if (def.cooldownMs > 0) p.cooldowns[ability] = now + g.ms(def.cooldownMs);
  p.busyUntil = now + gcd;
  p.lastCombatAt = now;
  p.combatLockUntil = now + g.ms(TIMING.combatLockMs);
  g.markPlayer(p);

  if (mob) {
    const mdef = MOB_TYPES[mob.type];
    const damage = Math.max(1, Math.round(raw));
    mob.hp = Math.max(0, mob.hp - damage);
    mob.aggro[p.id] = (mob.aggro[p.id] ?? 0) + damage;
    if (!mob.targetId) { mob.targetId = p.id; mob.nextAttackAt = now + g.ms(mdef.attackMs); }
    const xp = gainXp(p, skill, combatXp(damage));
    g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: p.id, attackerName: p.name, targetId: mob.id, targetName: mdef.name, ability, damage, targetHp: mob.hp }, { zone, actor: p });
    let loot: ItemStack[] = [];
    let killed = false;
    let note: string | undefined;
    if (mob.hp <= 0) {
      killed = true;
      loot = rollLoot(g, mob.type, p);
      addItems(p.inventory, loot);
      if (mdef.drops.some((d) => d.skin)) {
        if (equippedToolTier(p, 'skinning') >= requiredToolTier(mdef.tier)) {
          addWear(g, p, 'tool', WEAR.perToolUse);
          const dd = affixSum(p, ['tool'], 'double_drop');
          if (dd > 0 && g.rng() < dd / 100) {
            const extra = loot.filter((s) => mdef.drops.some((d) => d.skin && d.item === s.item));
            addItems(p.inventory, extra);
            loot = toStacks(Object.fromEntries([...loot, ...extra].reduce((m, s) => m.set(s.item, (m.get(s.item) ?? 0) + s.qty), new Map<string, number>())));
          }
        }
        else note = `no hides: equip a skinning knife (tier ${requiredToolTier(mdef.tier)}+) in the tool slot to skin ${mdef.name}s`;
      }
      g.store.ledger('created.mobs', silverIn(loot));
      mob.deadUntil = now + g.ms(mdef.respawnMs);
      mob.aggro = {};
      mob.targetId = null;
      p.stats.kills++;
      questProgress(g, p, 'kill', mob.type, 1);
      g.emit('combat.kill', { kind: 'zone', zone }, { killerId: p.id, killerName: p.name, targetId: mob.id, targetType: mob.type, loot }, { zone, actor: p });
      g.setLastAction(p, 'combat', `killed ${mdef.name} (loot: ${describe(loot)})`);
    } else {
      g.setLastAction(p, 'combat', `fighting ${mdef.name}`);
    }
    return { ability, targetId: mob.id, damage, dodged: false, targetHp: mob.hp, killed, loot, xp, busyMs: gcd, ...(weaponWear !== undefined ? { weaponWear } : {}), ...(note ? { note } : {}) };
  }

  const v = victim!;
  const res = damagePlayer(g, v, raw, { kind: 'player', id: p.id, name: p.name });
  const xp = gainXp(p, skill, combatXp(res.damage));
  g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: p.id, attackerName: p.name, targetId: v.id, targetName: v.name, ability, damage: res.damage, dodged: res.dodged, targetHpPct: Math.round((v.hp / maxHp(v)) * 100), pvp: true }, { zone, actor: p });
  g.setLastAction(p, 'combat', res.killed ? `killed ${v.name}` : `attacking ${v.name}`);
  return { ability, targetId: v.id, damage: res.damage, dodged: res.dodged, targetHp: res.killed ? 0 : v.hp, killed: res.killed, loot: [], xp, busyMs: gcd, ...(weaponWear !== undefined ? { weaponWear } : {}) };
}

function silverIn(stacks: ItemStack[]): number {
  return stacks.reduce((n, s) => n + (s.item === 'silver' ? s.qty : 0), 0);
}

function rollLoot(g: Game, mobType: string, p: Player): ItemStack[] {
  const def = MOB_TYPES[mobType];
  const canSkin = equippedToolTier(p, 'skinning') >= requiredToolTier(def.tier);
  const out: Record<string, number> = {};
  const [lo, hi] = def.silver;
  out.silver = lo + Math.floor(g.rng() * (hi - lo + 1));
  for (const d of def.drops) {
    if (d.skin && !canSkin) continue;
    if (g.rng() <= d.chance) out[d.item] = (out[d.item] ?? 0) + d.min + Math.floor(g.rng() * (d.max - d.min + 1));
  }
  return toStacks(out);
}

/** Death rules. Lethal zones drop everything carried and worn into a loot bag; bank and skills are always safe. */
export function killPlayer(g: Game, victim: Player, source: { kind: 'mob' | 'player'; id: string; name: string }) {
  const zone = victim.zone;
  const z = ZONES[zone];
  const deathPos = posOf(g, victim);
  const now = g.now();
  let bagId: string | null = null;
  let dropped: ItemStack[] = [];
  // Part of the carried silver is destroyed on every death (a sink); banked silver is safe.
  const silverLost = Math.floor((victim.inventory.silver ?? 0) * DEATH_SILVER_LOSS);
  if (silverLost > 0) removeItems(victim.inventory, [{ item: 'silver', qty: silverLost }]);
  g.store.ledger('destroyed.death', silverLost);
  if (z.fullLoot) {
    const items: Record<string, number> = { ...victim.inventory };
    for (const it of Object.values(victim.equipment)) if (it) items[it] = (items[it] ?? 0) + 1;
    // The dropped copies leave with their wear; a looter gets them as fresh items.
    if (victim.wear) for (const it of Object.keys(items)) delete victim.wear[it];
    victim.inventory = {};
    victim.equipment = {};
    dropped = toStacks(items);
    if (dropped.length) {
      bagId = newId('bag');
      const bag = { id: bagId, zone, x: round1(deathPos.x), y: round1(deathPos.y), ownerId: victim.id, ownerName: victim.name, items, createdAt: now, expiresAt: now + g.ms(TIMING.lootBagTtlMs) };
      g.bags.set(bagId, bag);
      g.markBag(bag);
    }
  }
  clearAggro(g, victim.id);
  victim.stats.deaths++;
  if (source.kind === 'player') {
    const killer = g.players.get(source.id);
    if (killer) { killer.stats.kills++; g.markPlayer(killer); }
  }
  g.emit('player.death', { kind: 'zone', zone }, { victimId: victim.id, victimName: victim.name, killerKind: source.kind, killerId: source.id, killerName: source.name, zone, fullLoot: z.fullLoot, bagId, dropped, silverLost }, { zone, actor: victim });
  if (bagId) g.emit('loot.dropped', { kind: 'zone', zone }, { bagId, ownerId: victim.id, ownerName: victim.name, items: dropped }, { zone, actor: victim });
  const lostNote = silverLost > 0 ? ` ${silverLost} carried silver was destroyed (${DEATH_SILVER_LOSS * 100}% of what you carried; bank silver is safe).` : '';
  g.emit('self.died', { kind: 'player', playerId: victim.id }, { zone, killerKind: source.kind, killerId: source.id, killerName: source.name, dropped, bagId, silverLost, note: (z.fullLoot ? 'The rest of your carried and equipped items were dropped. Bank and skills are safe.' : 'Safe zone death: you kept the rest of your items.') + lostNote }, { zone });
  // Respawn in town.
  victim.zone = regionAt(g.map, g.map.spawn);
  victim.pos = { ...g.map.spawn };
  victim.travel = null;
  victim.hp = maxHp(victim);
  victim.cooldowns = {};
  victim.evadeUntil = 0;
  victim.braceUntil = 0;
  victim.lastCombatAt = 0;
  victim.combatLockUntil = 0;
  victim.busyUntil = now + g.ms(TIMING.respawnBusyMs);
  g.emit('player.respawn', { kind: 'zone', zone: 'town' }, { playerId: victim.id, name: victim.name }, { zone: 'town', actor: victim });
  g.setLastAction(victim, 'death', `died in ${zone} to ${source.name}${z.fullLoot ? ' (dropped gear)' : ''}`);
  g.markPlayer(victim);
}

// ---------- looting ----------

function loot(g: Game, p: Player, payload: Record<string, any>) {
  const bagId = reqStr(payload, 'bagId', 80);
  const zone = requireArrived(g, p);
  const bag = g.bags.get(bagId);
  if (!bag) fail('NOT_FOUND', `no loot bag ${bagId}`);
  requireInRange(g, p, { x: bag!.x!, y: bag!.y! }, bagId, 'loot bag');
  const asked = payload.items === undefined ? toStacks(bag!.items) : stacks(payload.items, 'items', false);
  const want = removeItems(bag!.items, asked);
  addItems(p.inventory, want);
  g.markBag(bag!);
  if (Object.keys(bag!.items).length === 0) g.bags.delete(bag!.id);
  g.emit('loot.taken', { kind: 'zone', zone }, { bagId, ownerId: bag!.ownerId, ownerName: bag!.ownerName, looterId: p.id, looterName: p.name, items: want }, { zone, actor: p });
  g.setLastAction(p, 'loot', `looted ${describe(want)} from ${bag!.ownerName}'s bag`);
  g.markPlayer(p);
  return { taken: want, remaining: toStacks(bag!.items) };
}

// ---------- banking ----------

function bankOp(kind: 'deposit' | 'withdraw') {
  return (g: Game, p: Player, payload: Record<string, any>) => {
    requirePlace(g, p, 'bank', 'the bank');
    const asked = stacks(payload.items, 'items', false);
    const items = kind === 'deposit' ? removeItems(p.inventory, asked) : removeItems(p.bank, asked);
    addItems(kind === 'deposit' ? p.bank : p.inventory, items);
    g.emit('bank', { kind: 'operator' }, { playerId: p.id, name: p.name, action: kind, items }, { zone: 'town', actor: p });
    g.setLastAction(p, 'bank', `${kind === 'deposit' ? 'banked' : 'withdrew'} ${describe(items)}`);
    g.markPlayer(p);
    return { bank: toStacks(p.bank), inventory: toStacks(p.inventory) };
  };
}

// ---------- specialization ----------

function focusSet(g: Game, p: Player, payload: Record<string, any>) {
  requireZone(g, p, 'town', 'choosing focus skills');
  const raw = payload.skills;
  if (!Array.isArray(raw)) fail('BAD_REQUEST', 'skills must be an array of skill ids');
  const skills = [...new Set(raw as unknown[])] as SkillId[];
  for (const s of skills) if (typeof s !== 'string' || !SKILLS.includes(s)) fail('BAD_REQUEST', `unknown skill "${String(s)}"; skills are ${SKILLS.join(', ')}`);
  if (skills.length > FOCUS.slots) fail('BAD_REQUEST', `at most ${FOCUS.slots} focus skills`, undefined, 'specialize: pick the skills you will use most and buy the rest from other players');
  const dropped = (p.focus ?? []).filter((s) => !skills.includes(s));
  if (dropped.length) {
    const readyIn = focusView(g, p).respecReadyInMs;
    if (readyIn > 0) fail('ON_COOLDOWN', `you can drop a focus skill again in ${Math.ceil(readyIn / 1000)}s`, readyIn, 'adding skills to free slots is always allowed');
    p.focusDroppedAt = g.now();
  }
  p.focus = skills;
  g.setLastAction(p, 'focus', skills.length ? `focused on ${skills.join(', ')}` : 'cleared focus');
  g.markPlayer(p);
  return focusView(g, p);
}

// ---------- quests ----------

export function questProgress(g: Game, p: Player, kind: 'kill' | 'gather' | 'craft' | 'deliver' | 'procure', target: string, amount: number) {
  for (const [questId, q] of Object.entries(p.quests)) {
    const def = QUESTS[questId];
    if (q.status !== 'active' || def.objective.kind !== kind || def.objective.target !== target) continue;
    q.progress += amount;
    if (q.progress >= def.objective.count) {
      q.status = 'complete';
      g.emit('quest.complete', { kind: 'player', playerId: p.id }, { questId, name: def.name }, {});
      g.emit('quest', { kind: 'operator' }, { playerId: p.id, name: p.name, questId, status: 'complete' }, { zone: p.zone, actor: p });
    } else {
      g.emit('quest.progress', { kind: 'player', playerId: p.id }, { questId, progress: q.progress, goal: def.objective.count }, {});
    }
  }
}

function questAccept(g: Game, p: Player, payload: Record<string, any>) {
  const questId = reqStr(payload, 'questId', 40);
  const def = QUESTS[questId];
  if (!def) fail('NOT_FOUND', `unknown quest ${questId}`);
  requirePlace(g, p, 'quest_board', 'the quest board');
  if (p.quests[questId]) fail('QUEST_STATE', `quest ${questId} already ${p.quests[questId].status}`);
  p.quests[questId] = { status: 'active', progress: 0 };
  g.emit('quest', { kind: 'operator' }, { playerId: p.id, name: p.name, questId, status: 'accepted' }, { zone: 'town', actor: p });
  g.setLastAction(p, 'quest', `accepted quest ${def!.name}`);
  g.markPlayer(p);
  return { questId, status: 'active' as const, progress: 0, goal: def!.objective.count };
}

function questClaim(g: Game, p: Player, payload: Record<string, any>) {
  const questId = reqStr(payload, 'questId', 40);
  const def = QUESTS[questId];
  if (!def) fail('NOT_FOUND', `unknown quest ${questId}`);
  requirePlace(g, p, 'quest_board', 'the quest board');
  const q = p.quests[questId];
  if (!q || q.status !== 'complete') {
    fail('QUEST_STATE', `quest ${questId} is ${q?.status ?? 'not accepted'}`, undefined,
      !q ? `accept it first with quest.accept` : q.status === 'claimed' ? 'the reward was already paid' : `progress ${Math.min(q.progress, def!.objective.count)}/${def!.objective.count}: ${def!.description} Only kills, gathers, crafts and settled trades after accepting count. Claim it once progress reaches the goal.`);
  }
  q!.status = 'claimed';
  addItems(p.inventory, def!.reward);
  g.store.ledger('created.quests', silverIn(def!.reward));
  g.emit('quest', { kind: 'operator' }, { playerId: p.id, name: p.name, questId, status: 'claimed', reward: def!.reward }, { zone: 'town', actor: p });
  g.setLastAction(p, 'quest', `claimed ${def!.name} (${describe(def!.reward)})`);
  g.markPlayer(p);
  return { reward: def!.reward };
}

// ---------- town services: shop & repair (silver sinks) ----------

function payFromInventory(p: Player, cost: number, what: string) {
  const have = p.inventory.silver ?? 0;
  if (have < cost) fail('NOT_ENOUGH_ITEMS', `${what} costs ${cost} silver; you carry ${have}`, undefined, 'withdraw silver from the bank, or sell goods to other players');
  removeItems(p.inventory, [{ item: 'silver', qty: cost }]);
}

function shopList() {
  return { items: Object.entries(SHOP).map(([item, price]) => ({ item, price })) };
}

function shopBuy(g: Game, p: Player, payload: Record<string, any>) {
  const item = reqStr(payload, 'item', 60);
  const qty = optInt(payload, 'qty', 1, MAX_CRAFT_BATCH, 1);
  const price = SHOP[item];
  if (price === undefined) fail('NOT_FOUND', `the shop does not sell ${item}`, undefined, `the shop sells: ${Object.entries(SHOP).map(([i, pr]) => `${i} (${pr})`).join(', ')}. Buy anything else from players.`);
  requirePlace(g, p, 'shop', 'the shop');
  const cost = price! * qty;
  payFromInventory(p, cost, `${qty}× ${item}`);
  addItems(p.inventory, [{ item, qty }]);
  g.store.ledger('destroyed.shop', cost);
  g.emit('shop', { kind: 'operator' }, { playerId: p.id, name: p.name, item, qty, paid: cost }, { zone: 'town', actor: p });
  g.setLastAction(p, 'shop', `bought ${qty}× ${item} for ${cost} silver`);
  g.markPlayer(p);
  return { bought: { item, qty }, paid: cost, inventory: toStacks(p.inventory) };
}

function repair(g: Game, p: Player, payload: Record<string, any>) {
  const slotArg = payload.slot === undefined ? undefined : reqStr(payload, 'slot', 10);
  if (slotArg !== undefined && !SLOTS.includes(slotArg as Slot)) fail('BAD_REQUEST', `slot must be one of ${SLOTS.join(', ')}`);
  requirePlace(g, p, 'forge', 'repairs');
  const slots: Slot[] = slotArg ? [slotArg as Slot] : SLOTS;
  const jobs: { slot: Slot; item: string; wearRemoved: number; cost: number }[] = [];
  for (const slot of slots) {
    const item = p.equipment[slot];
    const wear = item ? wearOf(p, item) : 0;
    if (item && wear > 0) jobs.push({ slot, item, wearRemoved: Math.round(wear * 100) / 100, cost: repairCost(item, wear) });
  }
  if (!jobs.length) fail('BAD_REQUEST', slotArg ? `nothing to repair in ${slotArg}` : 'no equipped gear needs repair', undefined, 'repair works on equipped gear; equip the item first');
  const total = jobs.reduce((n, j) => n + j.cost, 0);
  payFromInventory(p, total, 'this repair');
  for (const j of jobs) delete p.wear![j.item];
  p.hp = maxHp(p);
  g.store.ledger('destroyed.repair', total);
  g.emit('repair', { kind: 'operator' }, { playerId: p.id, name: p.name, repaired: jobs, paid: total }, { zone: 'town', actor: p });
  g.setLastAction(p, 'repair', `repaired ${jobs.map((j) => j.item).join(', ')} for ${total} silver`);
  g.markPlayer(p);
  return { repaired: jobs, paid: total, gear: gearView(p) };
}

// ---------- tick ----------

export function worldTick(g: Game, now: number) {
  for (const p of g.players.values()) {
    if (p.travel) walkTick(g, p, now);
    const max = maxHp(p);
    if (p.hp < max && p.zone === 'town') { p.hp = max; g.markPlayer(p); continue; }
    if (p.hp < max && now - p.lastCombatAt >= g.ms(TIMING.outOfCombatMs) && now - p.lastRegenAt >= g.ms(TIMING.regenIntervalMs)) {
      p.hp = Math.min(max, p.hp + Math.ceil(max * TIMING.regenFraction));
      p.lastRegenAt = now;
      g.markPlayer(p);
    }
  }
  for (const m of g.mobs.values()) {
    const def = MOB_TYPES[m.type];
    const last = m.movedAt ?? now;
    m.movedAt = now;
    if (m.hp <= 0 || m.deadUntil > now) {
      if (m.deadUntil <= now) { m.hp = def.hp; m.deadUntil = 0; m.aggro = {}; m.targetId = null; m.x = m.home.x; m.y = m.home.y; }
      continue;
    }
    if (!m.targetId) continue;
    // A mob keeps chasing an attacker anywhere in its own region; it gives up (healed, back home) when none is left there.
    const valid = (id: string) => { const t = g.players.get(id); return !!t && t.zone === m.zone; };
    if (!valid(m.targetId)) {
      delete m.aggro[m.targetId];
      const next = Object.entries(m.aggro).filter(([id]) => valid(id)).sort((a, b) => b[1] - a[1])[0];
      if (next) { m.targetId = next[0]; }
      else { m.targetId = null; m.aggro = {}; m.hp = def.hp; m.x = m.home.x; m.y = m.home.y; continue; }
    }
    const target = g.players.get(m.targetId!)!;
    const tpos = posOf(g, target);
    mobStep(g, m, tpos, (now - last) / g.ms(MAP_RULES.mobMsPerTile));
    if (dist(m, tpos) > MAP_RULES.range.interact + 1e-9) continue;
    if (now >= m.nextAttackAt) {
      m.nextAttackAt = now + g.ms(def.attackMs);
      const zone = m.zone;
      const res = damagePlayer(g, target, def.damage, { kind: 'mob', id: m.id, name: def.name });
      g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: m.id, attackerName: def.name, targetId: target.id, targetName: target.name, ability: 'claw', damage: res.damage, dodged: res.dodged, targetHpPct: res.killed ? 0 : Math.round((target.hp / maxHp(target)) * 100) }, { zone });
    }
  }
  for (const n of g.nodes.values()) {
    const max = NODE_TYPES[n.type].maxCharges;
    if (n.charges < max && now >= n.nextChargeAt) {
      n.charges++;
      n.nextChargeAt = n.charges < max ? now + g.ms(TIMING.nodeRegenMs) : 0;
    }
  }
  for (const b of [...g.bags.values()]) {
    if (b.expiresAt <= now) {
      g.bags.delete(b.id);
      g.markBag(b);
      g.emit('loot.expired', { kind: 'operator' }, { bagId: b.id, ownerId: b.ownerId, items: toStacks(b.items) }, { zone: b.zone });
    }
  }
}

// ---------- registry ----------

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const worldCommands: Record<string, CommandDef> = {
  observe: ro((g, p) => observe(g, p)),
  catalog: ro((g) => ({ ...CATALOG, map: { ...MAP_RULES, ...g.map } })),
  'player.lookup': ro((g, _p, payload) => {
    const o = g.playerByName(reqStr(obj(payload), 'name', 40));
    if (!o) fail('NOT_FOUND', 'no such player');
    return { playerId: o!.id, name: o!.name };
  }),
  'player.get': ro((g, p, payload) => {
    const o = g.players.get(reqStr(obj(payload), 'playerId', 40));
    if (!o) fail('NOT_FOUND', 'no such player');
    const sameZone = p.zone === o!.zone;
    const pos = posOf(g, o!);
    const visible = dist(posOf(g, p), pos) <= MAP_RULES.viewRadius;
    return { id: o!.id, name: o!.name, online: g.isOnline(o!.id), zone: sameZone ? o!.zone : null, pos: visible ? { x: round1(pos.x), y: round1(pos.y) } : null, createdAt: o!.createdAt };
  }),
  move: rw(move),
  'focus.set': rw(focusSet),
  gather: rw(gather),
  refine: rw(makeItem('refine')),
  craft: rw(makeItem('craft')),
  equip: rw(equip),
  'item.inspect': ro(inspect),
  unequip: rw(unequip),
  attack: rw((g, p, payload) => useAbility(g, p, payload, true)),
  'ability.use': rw((g, p, payload) => useAbility(g, p, payload, false)),
  loot: rw(loot),
  'bank.view': ro((g, p) => { requirePlace(g, p, 'bank', 'the bank'); return { items: toStacks(p.bank) }; }),
  'bank.deposit': rw(bankOp('deposit')),
  'bank.withdraw': rw(bankOp('withdraw')),
  'quest.list': ro((_g, p) => ({
    available: Object.values(QUESTS).filter((q) => !p.quests[q.id]).map((q) => ({ id: q.id, name: q.name, description: q.description, reward: q.reward })),
    mine: questViews(p),
  })),
  'quest.accept': rw(questAccept),
  'quest.claim': rw(questClaim),
  'shop.list': ro(() => shopList()),
  'shop.buy': rw(shopBuy),
  repair: rw(repair),
};
