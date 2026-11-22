// World rules: observation, movement, gathering, refining, crafting,
// equipment, combat & loot, banking, quests. Going down and dying are in death.ts.

import { randomBytes } from 'node:crypto';
import {
  ABILITIES, AFFIXES, BASE_HP, FOOD, PARTY, SLOTS, affixText, UNIQUE_SEP, itemDef, baseOf, isUnique, TOOL_FAMILIES, requiredToolTier, type ToolJob, CATALOG, COMBAT, DEATH, FOCUS, HOOD, ITEMS, MAX_CRAFT_BATCH, MOB_TYPES, NODE_TYPES, QUESTS, RECIPES, SHOP, SKILLS, TIMING, WEAR, XP, ZONES,
  effectiveLevel, levelFor, type AbilityId, type ItemStack, type SkillId, type Slot, type StationId, type ZoneId,
} from '../shared/catalog.ts';
import type { AffixRoll, MobView, UniqueItem, AbilityView, AttackResult, FocusView, GearWearView, Observation, QuestProgress, SkillView, TravelView, ZoneView } from '../shared/protocol.ts';
import { MAP_RULES, dist, findPath, inBounds, nearestWalkable, pathLength, placeOf, plotOf, pointAlong, regionAt, walkable, type PlaceId, type Pos } from '../shared/map.ts';
import type { Game } from './game.ts';
import { buildingStation, noteCrossing, recordWork, takeShared } from './buildings.ts';
import { corpseShown, downPlayer, killPlayer } from './death.ts';
import { bySeenId, isAlias, seenAs } from './identity.ts';
import { BUILDING_ODDS, MOB_LOOT, SKILL_ODDS } from './odds.ts';
import type { CommandDef, LootBag, Mob, Player, Walk } from './types.ts';
import { addItems, available, describe, fail, hasItems, missing, newId, obj, optInt, removeItems, reqStr, stacks, toBag, toStacks } from './util.ts';
import { alliesBeside, invitesFor, partyDamageMult, partyOf, partyView } from './party.ts';
import { audit, requireSharedWork, settlementInvitesFor, settlementSummary, taxQuestReward } from './settlement.ts';

export { killPlayer };

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
    if (u) for (const a of u.affixes) if (a.id === affixId) n += a.value ?? 0;
  }
  return n;
}
/** Player-facing copy of an affix roll: chance-based affixes hide their value. */
export function publicAffix(a: AffixRoll): AffixRoll {
  return AFFIXES[a.id]?.hiddenValue ? { id: a.id, tier: a.tier } : { ...a };
}
export function publicUnique(u: UniqueItem): UniqueItem { return { ...u, affixes: u.affixes.map(publicAffix) }; }
/** Readable affix line. A value whose text has no `{v}` (chance affixes, operator view only) is appended. */
export function affixLine(a: AffixRoll): string {
  const extra = a.value !== undefined && !AFFIXES[a.id]?.text.includes('{v}') ? ` (${a.value})` : '';
  return `T${a.tier} ${affixText(a.id, a.value)}${extra}`;
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
  const u = REGISTRY.get(item);
  const mult = u ? WEAR.rarityRepairMult[u.rarity] + (u.corrupted ? WEAR.corruptedExtra : 0) : 1;
  return Math.ceil(((WEAR.repairCostByTier[itemDef(item)?.tier ?? 0] ?? 0) * mult * wear) / WEAR.max);
}

/** Equipped gear. `reveal` (operator only) shows chance-based affix values too. */
export function gearView(p: Player, reveal = false): Partial<Record<Slot, GearWearView>> {
  const out: Partial<Record<Slot, GearWearView>> = {};
  for (const slot of SLOTS) {
    const item = p.equipment[slot];
    if (!item) continue;
    const wear = wearOf(p, item);
    const u = REGISTRY.get(item);
    out[slot] = { item, wear: Math.round(wear * 100) / 100, broken: wear >= WEAR.max, repairCost: repairCost(item, wear),
      ...(u ? { ilvl: u.ilvl, rarity: u.rarity, corrupted: u.corrupted, affixes: u.affixes.map((x) => affixLine(reveal ? x : publicAffix(x))) } : {}) };
  }
  return out;
}

export function addWear(g: Game, p: Player, slot: Slot, amount: number) {
  if (slot === 'tool') amount *= 1 - pct(affixSum(p, ['tool'], 'durable') + affixSum(p, ['tool'], 'build_durable'));
  const item = p.equipment[slot];
  if (!item || amount <= 0) return;
  const before = wearOf(p, item);
  if (before >= WEAR.max) return;
  p.wear = p.wear ?? {};
  p.wear[item] = Math.min(WEAR.max, before + amount);
  if (p.wear[item] >= WEAR.max) {
    if (slot === 'armor') p.hp = Math.min(p.hp, maxHp(p));
    g.emit('self.gearBroken', { kind: 'player', playerId: p.id }, { slot, item, note: `${item} is broken and works at ${WEAR.brokenMultiplier * 100}% strength. Repair it in town or at your settlement's forge hall with the "repair" command (${repairCost(item, WEAR.max)} silver).` }, {});
  }
  g.markPlayer(p);
}

export function isFocused(p: Player, s: SkillId): boolean { return !!p.focus?.includes(s); }

/** The level that counts for rules (see FOCUS): full trained level when focused, capped otherwise. */
export function skillLevel(p: Player, s: SkillId): number { return effectiveLevel(p.skills[s] ?? 0, isFocused(p, s)); }

export function isWellFed(g: Game, p: Player): boolean { return (p.wellFedUntil ?? 0) > g.now(); }

/** Adds XP (multiplied when the skill is focused, and again when Well fed) and returns the amount granted. */
export function gainXp(g: Game, p: Player, s: SkillId, xp: number): number {
  const gained = Math.max(0, Math.round(xp * (isFocused(p, s) ? FOCUS.xpMult : 1) * (isWellFed(g, p) ? FOOD.xpMult : 1)));
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
export function requireTool(g: Game, p: Player, job: ToolJob, tier: number, what: string): number {
  if (!TOOL_FAMILIES[job]) return 1;
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

export function requireArrived(g: Game, p: Player): ZoneId {
  if (p.travel) fail('TRAVELING', `walking to ${p.travel.target ?? p.travel.to}`, p.travel.arriveAt - g.now(), 'wait for arrival, or send a new move to change course');
  return p.zone;
}

export function requireReady(g: Game, p: Player) {
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
export function requirePlace(g: Game, p: Player, placeId: PlaceId, what: string, code: 'OUT_OF_RANGE' | 'NO_STATION' = 'OUT_OF_RANGE'): void {
  const place = placeOf(g.map, placeId)!;
  requireArrived(g, p);
  if (code === 'OUT_OF_RANGE') requireZone(g, p, regionAt(g.map, place), what);
  const d = dist(p.pos, place);
  if (d > MAP_RULES.range.place + 1e-9) {
    fail(code, `${what} needs you within ${MAP_RULES.range.place} tiles of the ${placeId} at ${at(place.x, place.y)} in ${regionAt(g.map, place)}; you are ${round1(d)} tiles away at ${at(round1(p.pos.x), round1(p.pos.y))}`, undefined, rangeHint(placeId));
  }
}

export function requireInRange(g: Game, p: Player, target: Pos, id: string, what: string): void {
  const d = dist(p.pos, target);
  if (d > MAP_RULES.range.interact + 1e-9) {
    fail('OUT_OF_RANGE', `${what} ${id} is ${round1(d)} tiles away at ${at(round1(target.x), round1(target.y))}; range is ${MAP_RULES.range.interact}`, undefined, rangeHint(id));
  }
}

/**
 * Mobs, resource nodes and loot bags are used from inside their own region only. Across a border a mob would never hit
 * back, and a node or bag in contested land could be emptied from the safety of the next region.
 */
function sameRegion(zone: ZoneId, there: ZoneId, what: string, verb: string, id: string) {
  if (there !== zone) fail('WRONG_ZONE', `${what} is in ${there} and you are in ${zone}; you can only ${verb} it from inside its region`, undefined, `move { to: '${id}' } (goTo('${id}')) walks into ${there} and stops within reach`);
}

// ---------- other players ----------

export function inView(g: Game, p: Player, o: Player): boolean {
  return dist(posOf(g, p), posOf(g, o)) <= MAP_RULES.viewRadius;
}

/**
 * Whether `viewer` may know where `o` is, by name: player.get, the party view, and move, attack and revive. Only within
 * view, so that pulling up a hood is just like stepping out of sight: anything region-wide would show who vanished.
 * One exception, so partners can come to the rescue: a downed partner without a hood shows across their region.
 */
export function canPlace(g: Game, viewer: Player, o: Player): boolean {
  if (o.id === viewer.id) return true;
  if (o.hood) return false;
  return inView(g, viewer, o) || (!!o.downed && !!o.partyId && o.partyId === viewer.partyId && o.zone === viewer.zone);
}

/**
 * The player `key` points at, for what is done to someone in the world: move, attack, revive. A hooded player answers
 * to the figure's id alone, within view: to their own id and name they are just like someone out of sight.
 */
export function findPlayer(g: Game, p: Player, key: string, byName = false): Player | undefined {
  if (isAlias(key)) {
    const figure = [...g.players.values()].find((x) => x.hood?.as === key);
    if (figure) return figure.id !== p.id && inView(g, p, figure) ? figure : undefined;
  }
  const o = g.players.get(key) ?? (byName ? g.playerByName(key) : undefined);
  return o && o.id !== p.id && canPlace(g, p, o) ? o : undefined;
}

/** Fails for a player who can't be reached. The same answer whether they are out of sight or hooded. */
export function notInSight(g: Game, code: 'BAD_REQUEST' | 'INVALID_TARGET', key: string, unknown: string, hint?: string, byName = false): never {
  if (isAlias(key) || g.players.has(key) || (byName && g.playerByName(key))) {
    return fail(code, `${key} is not in sight`, undefined, 'you can only reach players within view: observe().zone.players lists them. To find someone, walk where they may be, or ask them where they are.');
  }
  return fail(code, unknown, undefined, hint);
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

/** Your region plus everything within MAP_RULES.viewRadius (any region), nearest first. The dead see only the region's rules. */
function zoneView(g: Game, p: Player): ZoneView {
  const zone = p.zone;
  const z = ZONES[zone];
  const now = g.now();
  const me = posOf(g, p);
  const R = MAP_RULES.viewRadius;
  const near = <T extends { distance: number }>(list: T[]) => list.filter((e) => e.distance <= R).sort((a, b) => a.distance - b.distance);
  // `region`: what is used from its own region only (sameRegion) is in range only from there.
  const loc = (q: Pos, range: number, region?: ZoneId) => { const d = dist(me, q); return { x: round1(q.x), y: round1(q.y), distance: round1(d), inRange: d <= range + 1e-9 && (!region || region === zone) }; };
  const I = MAP_RULES.range.interact;
  const base = {
    id: z.id, name: z.name, safety: z.safety, adjacent: z.adjacent, hasBank: z.hasBank, hasForum: z.hasForum, hasQuestBoard: z.hasQuestBoard, pvp: z.pvp,
    viewRadius: R,
  };
  if (p.dead) return { ...base, places: [], plots: [], nodes: [], mobs: [], players: [], lootBags: [], corpses: [] };
  return {
    ...base,
    places: near(g.map.places.map((s) => ({ id: s.id, ...loc(s, MAP_RULES.range.place) }))),
    plots: near(g.map.plots.map((pl) => {
      const s = [...g.settlements.values()].find((x) => x.plotId === pl.id);
      return { id: pl.id, region: pl.region, ...loc(pl, MAP_RULES.range.plot, pl.region), settlement: s ? { id: s.id, name: s.name } : null };
    })),
    nodes: near([...g.nodes.values()].map((n) => {
      const def = NODE_TYPES[n.type];
      return { id: n.id, type: n.type, item: def.item, tier: def.tier, region: n.zone, ...loc(n, I, n.zone), charges: n.charges, maxCharges: def.maxCharges, nextChargeInMs: n.charges < def.maxCharges ? Math.max(0, n.nextChargeAt - now) : 0 };
    })),
    mobs: near([...g.mobs.values()].map((m) => {
      const def = MOB_TYPES[m.type];
      const alive = m.deadUntil <= now && m.hp > 0;
      const view: MobView = { id: m.id, type: m.type, name: def.name, region: m.zone, ...loc(alive ? m : m.home, I, m.zone), hp: alive ? m.hp : 0, maxHp: def.hp, alive, respawnInMs: alive ? 0 : Math.max(0, m.deadUntil - now), targetId: alive ? targetSeen(g, p, m) : null };
      if (def.boss) { view.boss = true; view.enrageInMs = alive && m.engagedAt !== undefined ? Math.max(0, m.engagedAt + g.ms(def.boss.enrageAfterMs) - now) : null; }
      return view;
    })),
    players: near(bySeenId(g.players.values()).filter((o) => o.id !== p.id && !o.dead).map((o) => ({
      ...seenAs(o), region: o.zone, ...loc(posOf(g, o), I), walking: !!o.travel, hpPct: Math.round((o.hp / maxHp(o)) * 100),
      // Unique ids and gear would name who is under a hood.
      equipment: o.hood ? {} : { ...o.equipment },
      inCombat: now - o.lastCombatAt < g.ms(TIMING.outOfCombatMs), downed: !!o.downed, hooded: !!o.hood,
    }))),
    corpses: near([...g.corpses.values()].filter((c) => corpseShown(g, c)).map((c) => ({
      id: c.id, region: c.zone, victimId: c.victim.id, victimName: c.victim.name, ...loc(c, I), reported: c.reports.length > 0,
    }))),
    lootBags: near([...g.bags.values()].map((b) => ({
      id: b.id, region: b.zone, ...loc({ x: b.x!, y: b.y! }, I, b.zone), ownerId: b.ownerId, ownerName: b.ownerName, items: toStacks(b.items), expiresInMs: Math.max(0, b.expiresAt - now), youMayLoot: mayLoot(g, b, p.id),
      ...(b.eligible ? { spoils: true, opensToAllInMs: Math.max(0, (b.opensToAllAt ?? 0) - now) } : {}),
    }))),
  };
}

/** Whom a mob is after, as `viewer` may know them. You always know when it is you. */
function targetSeen(g: Game, viewer: Player, m: Mob): string | null {
  if (!m.targetId || m.targetId === viewer.id) return m.targetId;
  const t = g.players.get(m.targetId);
  return t ? seenAs(t).id : m.targetId;
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
      effects: { evadeMs: Math.max(0, p.evadeUntil - now), braceMs: Math.max(0, p.braceUntil - now), wellFedMs: Math.max(0, (p.wellFedUntil ?? 0) - now) },
      quests: questViews(p),
      focus: focusView(g, p),
      gear: gearView(p),
      uniques: p.dead ? [] : uniquesOf(g, p),
      downed: p.downed ? { leftMs: Math.max(0, p.downed.until - now), bandages: available(p.inventory, DEATH.bandage), reviving: !!p.reviving } : null,
      dead: p.dead ? { at: p.dead.at, zone: p.dead.zone, corpseId: p.dead.corpseId } : null,
      hood: p.hood ? { as: p.hood.as, leftMs: Math.max(0, p.hood.until - now) } : null,
    },
    zone: zoneView(g, p),
    // A dead character's token is no window on the living.
    ...(p.dead
      ? { unreadDms: 0, openTrades: 0, party: null, partyInvites: [], settlement: null, settlementInvites: [] }
      : {
        unreadDms: unread,
        openTrades,
        party: partyOf(g, p) ? partyView(g, partyOf(g, p)!, p.id) : null,
        partyInvites: invitesFor(g, p),
        settlement: settlementSummary(g, p),
        settlementInvites: settlementInvitesFor(g, p),
      }),
  };
}

// ---------- movement ----------

/** Resolves `move { to }`: a region id, a place id, or the id of a node, mob, loot bag, corpse or player (or a player's name). */
/** `region`: the walk ends in the target's region, where it can be used (see sameRegion). */
function resolveTarget(g: Game, p: Player, to: string): { dest: Pos; range: number; region?: ZoneId } {
  if ((ZONES as Record<string, unknown>)[to]) {
    const zone = to as ZoneId;
    if (p.zone === zone && !p.travel) fail('BAD_REQUEST', `already in ${zone}`, undefined, `to walk inside ${zone}, move to { x, y } or to a target id (node, mob, place, player)`);
    return { dest: g.map.anchors[zone], range: 0 };
  }
  const place = placeOf(g.map, to);
  if (place) return { dest: place, range: 1.5 };
  const plot = plotOf(g.map, to);
  if (plot) return { dest: plot, range: 1.5 };
  const I = MAP_RULES.range.interact;
  const node = g.nodes.get(to);
  if (node) return { dest: node, range: I, region: node.zone };
  const mob = g.mobs.get(to);
  if (mob) return { dest: mobAlive(g, mob) ? mob : mob.home, range: I, region: mob.zone };
  const bag = g.bags.get(to);
  if (bag) return { dest: { x: bag.x!, y: bag.y! }, range: I, region: bag.zone };
  const corpse = g.corpses.get(to);
  if (corpse && corpseShown(g, corpse)) return { dest: corpse, range: I, region: corpse.zone };
  const other = findPlayer(g, p, to, true);
  if (other) return { dest: posOf(g, other), range: I };
  return notInSight(g, 'BAD_REQUEST', to, `unknown move target "${to}"`,
    `use a region (${Object.keys(ZONES).join(', ')}), a place (${g.map.places.map((s) => s.id).join(', ')}), a settlement plot (${g.map.plots.map((pl) => pl.id).join(', ')}), a node/mob/loot bag/corpse/player id from observe(), or { x, y }`, true);
}

function move(g: Game, p: Player, payload: Record<string, any>) {
  let dest: Pos;
  let range = 0;
  let region: ZoneId | undefined;
  let target: string | undefined;
  if (payload.to !== undefined) {
    target = reqStr(payload, 'to', 80);
    ({ dest, range, region } = resolveTarget(g, p, target));
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
  const path = findPath(g.map, here, dest, range, region);
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
        ? `every hit you deal or take renews the lock, and these mobs keep attacking you: ${attackers.join(', ')}. Kill them before leaving ${p.zone}.`
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
    const who = seenAs(p);
    g.emit('travel.depart', { kind: 'zone', zone: from }, { playerId: who.id, name: who.name, from, to: region }, { zone: from, actor: p });
    p.zone = region;
    g.emit('travel.arrive', { kind: 'zone', zone: region }, { playerId: who.id, name: who.name, from, to: region }, { zone: region, actor: p });
    noteCrossing(g, p, from, region);
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
  sameRegion(zone, node!.zone, `${def.name} ${nodeId}`, 'gather from', nodeId);
  requireInRange(g, p, node!, nodeId, 'resource node');
  requireReady(g, p);
  const now = g.now();
  if (node!.charges <= 0) fail('DEPLETED', `${def.name} is depleted`, node!.nextChargeAt - now);
  const level = skillLevel(p, def.skill);
  let qty = 1 + rollBonus(g, Math.min(SKILL_ODDS.maxBonusYield, SKILL_ODDS.bonusYieldPerLevel * level) + affixSum(p, ['tool'], 'yield') / 100);
  const doubleDrop = affixSum(p, ['tool'], 'double_drop');
  if (doubleDrop > 0 && g.rng() < doubleDrop / 100) qty *= 2;
  if (node!.charges === def.maxCharges) node!.nextChargeAt = now + g.ms(TIMING.nodeRegenMs);
  node!.charges--;
  addItems(p.inventory, [{ item: def.item, qty }]);
  recordWork(g, p, def.item, qty);
  const shard = findShard(g, p);
  const xp = gainXp(g, p, def.skill, XP.gather(def.tier));
  const busy = g.ms(TIMING.gatherMs * Math.max(0.5, 1 - 0.05 * level) * slow * (1 - pct(affixSum(p, ['tool'], 'gather_speed'))));
  p.busyUntil = now + busy;
  addWear(g, p, 'tool', WEAR.perToolUse);
  questProgress(g, p, 'gather', def.item, qty);
  g.emit('gather', { kind: 'zone', zone }, { playerId: seenAs(p).id, name: seenAs(p).name, nodeId, item: def.item, qty }, { zone, actor: p });
  g.setLastAction(p, 'gather', `gathered ${qty}× ${def.item}`);
  g.markPlayer(p);
  return { item: def.item, qty, xp, skill: def.skill, level: skillLevel(p, def.skill), busyMs: busy, ...(shard ? { shards: shard } : {}) };
}

/** Gathering tools with shard_find may turn up an orb shard. */
function findShard(g: Game, p: Player): number {
  const chance = affixSum(p, ['tool'], 'shard_find');
  if (chance <= 0 || g.rng() >= chance / 100) return 0;
  addItems(p.inventory, [{ item: 'orb_shard', qty: 1 }]);
  g.store.ledger('shards.created.found', 1);
  return 1;
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
  if (r) ways.unshift(`craft it (recipe "${r.id}" at the ${r.station} in town or in your settlement's forge hall: ${describe(r.inputs)}; needs ${r.skill} level ${r.minLevel})`);
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
    const fromPool = payload.from !== undefined;
    if (fromPool && (kind !== 'refine' || payload.from !== 'stockpile')) fail('BAD_REQUEST', "from can only be 'stockpile', and only for refine", undefined, 'leave from out to use your inventory');
    const zone = requireArrived(g, p);
    const pool = fromPool ? requireSharedWork(g, p, r!, count) : undefined;
    const home = requireStation(g, p, r!.station, recipeId);
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
    const source = pool ? pool.stockpile : p.inventory;
    if (!hasItems(source, r!.inputs, count)) fail('NOT_ENOUGH_ITEMS', `missing ${missing(source, r!.inputs, count)}`);
    if (pool) g.markSettlement(pool);
    removeItems(source, r!.inputs, count);
    let bonus = 0;
    const toolOutput = kind === 'refine' ? affixSum(p, ['tool'], 'refine_output') / 100 : 0;
    const workshopOutput = kind === 'refine' && home?.def.id === 'workshop' ? BUILDING_ODDS.workshopOutput : 0;
    const chance = (focused ? Math.min(SKILL_ODDS.maxBonusOutput, SKILL_ODDS.bonusOutputPerLevel * level) : 0) + toolOutput + workshopOutput;
    if (chance > 0) for (let i = 0; i < count; i++) if (g.rng() < chance) bonus++;
    // Refining tools with save_inputs: each unit may hand its inputs back.
    let saved = 0;
    const save = kind === 'refine' ? affixSum(p, ['tool'], 'save_inputs') : 0;
    if (save > 0) { for (let i = 0; i < count; i++) if (g.rng() < save / 100) saved++; if (saved) addItems(source, r!.inputs, saved); }
    const output: ItemStack = { item: r!.output.item, qty: r!.output.qty * count + bonus };
    // Shared work: more output on what other members gave to the group, and all of it is the group's.
    const shared = pool ? { units: count, output: takeShared(g, pool, p, r!, count, output.qty) } : undefined;
    if (shared) output.qty += shared.output;
    const made = isGearKind(output.item)
      ? createUniques(g, p, output.item, output.qty, itemLevel(r!.tier, level) + affixSum(p, ['tool'], 'craft_ilvl') + (home?.def.ilvlBonus ?? 0))
      : null;
    addItems(source, made ? made.map((u) => ({ item: u.id, qty: 1 })) : [output]);
    const consumed = r!.inputs.map((s) => ({ item: s.item, qty: s.qty * (count - saved) })).filter((s) => s.qty > 0);
    if (pool) {
      audit(g, pool, p, 'refine', consumed);
      audit(g, pool, p, 'refined', [output]);
    }
    const xp = gainXp(g, p, r!.skill, XP[kind](r!.tier) * count);
    const base = kind === 'refine' ? TIMING.refineMs : TIMING.craftMs;
    const speed = kind === 'refine' ? pct(affixSum(p, ['tool'], 'refine_speed')) : 0;
    const busy = g.ms(base * count * Math.max(0.5, 1 - 0.05 * level) * slow * (1 - speed));
    p.busyUntil = g.now() + busy;
    addWear(g, p, 'tool', WEAR.perToolUse * count);
    if (kind === 'craft') questProgress(g, p, 'craft', output.item, output.qty);
    if (itemDef(output.item)?.kind === 'orb') g.store.ledger('orbs.created.crafted', output.qty);
    g.emit(kind, { kind: 'zone', zone }, { playerId: seenAs(p).id, name: seenAs(p).name, recipeId, output, station: r!.station }, { zone, actor: p });
    g.setLastAction(p, kind, `${kind === 'refine' ? 'refined' : 'crafted'} ${output.qty}× ${output.item}`);
    g.markPlayer(p);
    return { output, consumed, xp, level: skillLevel(p, r!.skill), busyMs: busy, ...(bonus ? { bonus } : {}), ...(saved ? { inputsSaved: saved } : {}), ...(shared ? { shared } : {}), ...(made ? { items: made.map(publicUnique) } : {}) };
  };
}

/** A recipe's station: your settlement's building when you stand at it and it works, else the place in town. */
function requireStation(g: Game, p: Player, station: StationId, what: string) {
  const home = buildingStation(g, p, station);
  if (home?.working) return home;
  if (home) {
    fail('NO_STATION', `${home.s.name}'s ${home.def.name} is closed: its upkeep is unpaid`, undefined,
      `put ${describe(home.def.upkeep)} in the stockpile and it reopens${station === 'kitchen' ? '' : `, or use the ${station} in town`}`);
  }
  if (station === 'kitchen') {
    fail('NO_STATION', `${what} needs a kitchen, which only settlements have`, undefined,
      'stand at the plot of your own settlement with a working kitchen (goTo its plotId), or buy rations from another player');
  }
  requirePlace(g, p, station as PlaceId, what, 'NO_STATION');
  return undefined;
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
    const u: UniqueItem = { id, base, ilvl, rarity: 'normal', affixes: [], mods: 0, corrupted: false, craftedBy: seenAs(p).name, craftedAt: g.now() };
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

/** Every unique the player owns (carried, equipped, banked, stashed), for observation. */
function uniquesOf(g: Game, p: Player): UniqueItem[] {
  const ids = new Set<string>([...Object.keys(p.inventory), ...Object.keys(p.bank), ...Object.values(p.equipment).filter((x): x is string => !!x)]);
  for (const s of g.settlements.values()) for (const id of Object.keys(s.stashes[p.id] ?? {})) ids.add(id);
  return [...ids].filter(isUnique).sort().map((id) => g.uniques.get(id)).filter((u): u is UniqueItem => !!u).map(publicUnique);
}

/** Public details of any unique item: anyone can inspect an id they were offered. */
function inspect(g: Game, _p: Player, payload: Record<string, any>) {
  const id = reqStr(payload, 'item', 60);
  const u = g.uniques.get(id);
  if (!u) fail('NOT_FOUND', `no unique item ${id}`, undefined, 'unique ids look like iron_sword#3f9a1c2b; see observe().self.uniques');
  return { item: publicUnique(u!) };
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

function weaponSkillOf(p: Player): SkillId {
  const weapon = p.equipment.weapon ? itemDef(p.equipment.weapon) : undefined;
  return weapon?.weaponSkill ?? 'unarmed';
}

function attackDamage(g: Game, p: Player, ability: AbilityId): { damage: number; skill: SkillId } {
  const def = ABILITIES[ability];
  const weapon = p.equipment.weapon ? itemDef(p.equipment.weapon) : undefined;
  const skill = weaponSkillOf(p);
  const base = def.flatDamage ?? (weapon?.power ?? 0) * gearMultiplier(p, 'weapon') * (def.powerMult ?? 1);
  const bonusLevels = Math.min(skillLevel(p, skill), COMBAT.damageBonusMaxLevel);
  return { damage: base * (1 + COMBAT.damageBonusPerLevel * bonusLevels) * (1 + affixSum(p, COMBAT_SLOTS, 'damage') / 100) * partyDamageMult(g, p), skill };
}

function combatXp(damage: number): number {
  return damage > 0 ? Math.max(1, Math.round(damage * COMBAT.xpPerDamage)) : 0;
}

/**
 * Applies damage to a player (armor, evade, brace): interrupts their revive, and at 0 HP they go down.
 * Emits self.damaged, or on going down player.downed and self.downed: then the caller emits no combat.hit, so a blow
 * spends two event ids either way.
 */
export function damagePlayer(g: Game, target: Player, raw: number, source: { kind: 'mob' | 'player'; id: string; name: string }, ability?: string) {
  if (target.downed || target.dead) return { damage: 0, dodged: false, downed: false };
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
  if (target.hp <= 0) {
    // Nobody can fight in town, so nobody goes down there.
    if (ZONES[target.zone].safety !== 'safe') {
      downPlayer(g, target, source, damage, ability);
      return { damage, dodged, downed: true };
    }
    target.hp = maxHp(target);
  }
  const interrupted = !dodged && !!target.reviving;
  if (interrupted) {
    delete target.reviving;
    target.busyUntil = now;
  }
  const attacker = source.kind === 'player' ? g.players.get(source.id) : undefined;
  const from = attacker ? seenAs(attacker) : source;
  g.emit('self.damaged', { kind: 'player', playerId: target.id }, { sourceKind: source.kind, sourceId: from.id, sourceName: from.name, damage, dodged, hp: target.hp, maxHp: maxHp(target), ...(interrupted ? { reviveInterrupted: true } : {}) }, { zone: target.zone });
  return { damage, dodged, downed: false };
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
  const me = seenAs(p);
  const def = ABILITIES[ability];
  const gcd = g.ms(TIMING.globalCooldownMs * (1 - pct(affixSum(p, COMBAT_SLOTS, 'attack_speed'))));

  if (def.kind === 'buff') {
    if (ZONES[zone].safety === 'safe') fail('SAFE_ZONE', 'no combat in town');
    if (ability === 'evade') p.evadeUntil = now + g.ms(def.durationMs!);
    if (ability === 'brace') p.braceUntil = now + g.ms(def.durationMs!);
    p.cooldowns[ability] = now + g.ms(def.cooldownMs * (1 - pct(affixSum(p, COMBAT_SLOTS, 'guard'))));
    p.busyUntil = now + gcd;
    g.emit('combat.buff', { kind: 'zone', zone }, { playerId: me.id, name: me.name, ability }, { zone, actor: p });
    g.setLastAction(p, 'combat', `used ${ability}`);
    g.markPlayer(p);
    return { ability, targetId: null, damage: 0, dodged: false, targetHp: null, killed: false, loot: [], xp: 0, busyMs: gcd };
  }

  if (!targetId) fail('BAD_REQUEST', 'targetId is required for attacks');
  if (ZONES[zone].safety === 'safe') fail('SAFE_ZONE', 'no combat in town');
  const mob = g.mobs.get(targetId!);
  let victim: Player | undefined;
  if (mob) {
    if (!mobAlive(g, mob)) fail('TARGET_DEAD', `${targetId} is dead`);
    // A mob only fights players in its own region (see worldTick), so only attack it from there: across a border it would never hit back.
    sameRegion(zone, mob.zone, `${MOB_TYPES[mob.type].name} ${mob.id}`, 'attack', mob.id);
    requireInRange(g, p, mob, mob.id, MOB_TYPES[mob.type].name);
  } else {
    if (targetId === p.id || targetId === p.hood?.as) fail('INVALID_TARGET', 'cannot attack yourself');
    if (!ZONES[zone].pvp && (g.players.has(targetId!) || isAlias(targetId!))) fail('SAFE_ZONE', `PvP is not allowed in ${zone}`);
    victim = findPlayer(g, p, targetId!);
    if (!victim) return notInSight(g, 'INVALID_TARGET', targetId!, `no target ${targetId}`);
    const who = seenAs(victim);
    if (!ZONES[victim.zone].pvp) fail('SAFE_ZONE', `${who.name} is in ${victim.zone}, where PvP is not allowed`);
    requireInRange(g, p, posOf(g, victim), who.id, who.name);
    if (victim.dead) fail('TARGET_DEAD', `${who.name} is dead`, undefined, 'observe().zone.corpses shows the body: corpse.examine, or death.report');
  }

  const { damage: raw, skill } = attackDamage(g, p, ability);
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
    if (mdef.boss) {
      if (mob.engagedAt === undefined) { mob.engagedAt = now; mob.nextAoeAt = now + g.ms(mdef.boss.aoeEveryMs); }
      mob.contributors = mob.contributors ?? [];
      if (!mob.contributors.includes(p.id)) {
        mob.contributors.push(p.id);
        if (p.hood) (mob.hoodedContributors ??= []).push(p.id);
      }
    }
    const xp = gainXp(g, p, skill, combatXp(damage));
    g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: me.id, attackerName: me.name, targetId: mob.id, targetName: mdef.name, ability, damage, targetHp: mob.hp }, { zone, actor: p });
    let loot: ItemStack[] = [];
    let killed = false;
    let note: string | undefined;
    let spoilsBagId: string | undefined;
    if (mob.hp <= 0) {
      killed = true;
      loot = rollLoot(g, mob.type, p);
      if (mdef.boss) {
        // Boss loot goes into a spoils bag that the players who fought it may open first. Any of them can take it all.
        const bag = dropSpoils(g, mob, loot, now);
        spoilsBagId = bag.id;
        note = `${mdef.name} spoils dropped into bag ${bag.id}: only the ${bag.eligible!.length} player(s) who damaged it can loot it for the next ${Math.round(g.ms(PARTY.spoilsReservedMs) / 1000)}s, then anyone can.`;
      } else addItems(p.inventory, loot);
      if (!mdef.boss && MOB_LOOT[mob.type].drops.some((d) => d.skin)) {
        if (equippedToolTier(p, 'skinning') >= requiredToolTier(mdef.tier)) {
          addWear(g, p, 'tool', WEAR.perToolUse);
          if (findShard(g, p)) loot = toStacks(Object.fromEntries([...loot, { item: 'orb_shard', qty: 1 }].reduce((m, s) => m.set(s.item, (m.get(s.item) ?? 0) + s.qty), new Map<string, number>())));
          const dd = affixSum(p, ['tool'], 'double_drop');
          if (dd > 0 && g.rng() < dd / 100) {
            const extra = loot.filter((s) => MOB_LOOT[mob.type].drops.some((d) => d.skin && d.item === s.item));
            addItems(p.inventory, extra);
            loot = toStacks(Object.fromEntries([...loot, ...extra].reduce((m, s) => m.set(s.item, (m.get(s.item) ?? 0) + s.qty), new Map<string, number>())));
          }
        }
        else note = `no hides: equip a skinning knife (tier ${requiredToolTier(mdef.tier)}+) in the tool slot to skin ${mdef.name}s`;
      }
      if (!mdef.boss) {
        for (const d of MOB_LOOT[mob.type].drops) if (d.skin) recordWork(g, p, d.item, loot.find((s) => s.item === d.item)?.qty ?? 0);
      }
      g.store.ledger('created.mobs', silverIn(loot));
      for (const s of loot) if (itemDef(s.item)?.kind === 'orb') g.store.ledger('orbs.created.mobs', s.qty);
      const contributors = mob.contributors ?? [];
      mob.deadUntil = now + g.ms(mdef.respawnMs);
      resetMob(mob);
      p.stats.kills++;
      questProgress(g, p, 'kill', mob.type, 1);
      shareKill(g, p, mob.type, contributors);
      g.emit('combat.kill', { kind: 'zone', zone }, { killerId: me.id, killerName: me.name, targetId: mob.id, targetType: mob.type, loot, ...(spoilsBagId ? { spoilsBagId } : {}) }, { zone, actor: p });
      g.setLastAction(p, 'combat', `killed ${mdef.name} (loot: ${describe(loot)})`);
    } else {
      g.setLastAction(p, 'combat', `fighting ${mdef.name}`);
    }
    return { ability, targetId: mob.id, damage, dodged: false, targetHp: mob.hp, killed, loot: spoilsBagId ? [] : loot, xp, busyMs: gcd, ...(weaponWear !== undefined ? { weaponWear } : {}), ...(note ? { note } : {}), ...(spoilsBagId ? { spoilsBagId } : {}) };
  }

  const v = victim!;
  const on = seenAs(v);
  const source = { kind: 'player' as const, id: p.id, name: p.name };
  const common = { ability, targetId: on.id, loot: [], busyMs: gcd, ...(weaponWear !== undefined ? { weaponWear } : {}) };
  if (v.downed) {
    // One attack finishes the downed, whatever it would have hit for.
    killPlayer(g, v, source);
    g.setLastAction(p, 'combat', `finished off ${v.name}`);
    return { ...common, damage: 0, dodged: false, targetHp: 0, killed: true, xp: 0 };
  }
  const res = damagePlayer(g, v, raw, source, ability);
  const xp = gainXp(g, p, skill, combatXp(res.damage));
  if (!res.downed) g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: me.id, attackerName: me.name, targetId: on.id, targetName: on.name, ability, damage: res.damage, dodged: res.dodged, targetHpPct: Math.round((v.hp / maxHp(v)) * 100), pvp: true }, { zone, actor: p });
  g.setLastAction(p, 'combat', res.downed ? `downed ${v.name}` : `attacking ${v.name}`);
  return { ...common, damage: res.damage, dodged: res.dodged, targetHp: v.hp, killed: false, ...(res.downed ? { downed: true } : {}), xp };
}

/** Clears a mob's fight state (aggro, target, boss clocks). Callers move it home when needed. */
function resetMob(m: Mob) {
  m.aggro = {};
  m.targetId = null;
  delete m.engagedAt;
  delete m.nextAoeAt;
  delete m.contributors;
  delete m.hoodedContributors;
}

function dropSpoils(g: Game, mob: Mob, loot: ItemStack[], now: number): LootBag {
  const eligible = (mob.contributors ?? []).filter((id) => g.players.has(id));
  // Named only if they showed their face both when they joined and now. Sorted, or the order would say who a figure is.
  const eligibleNames = eligible.map((id) => {
    const o = g.players.get(id)!;
    return o.hood || mob.hoodedContributors?.includes(id) ? HOOD.name : o.name;
  }).sort();
  const bag: LootBag = {
    id: newId('bag'), zone: mob.zone, x: round1(mob.x), y: round1(mob.y), ownerId: mob.id, ownerName: MOB_TYPES[mob.type].name, items: toBag(loot), createdAt: now,
    expiresAt: now + g.ms(TIMING.lootBagTtlMs), eligible, eligibleNames, opensToAllAt: now + g.ms(PARTY.spoilsReservedMs),
  };
  g.bags.set(bag.id, bag);
  g.markBag(bag);
  g.emit('loot.dropped', { kind: 'zone', zone: mob.zone }, { bagId: bag.id, ownerId: mob.id, ownerName: bag.ownerName, items: loot, spoils: true, eligible: eligibleNames }, { zone: mob.zone, truth: { eligible: eligible.map((id) => g.players.get(id)!.name) } });
  return bag;
}

/**
 * Kill credit beyond the killer: party members beside them (in the region and in view) get the quest credit and a share of XP;
 * everyone else who damaged a boss gets the quest credit.
 */
function shareKill(g: Game, killer: Player, mobType: string, contributors: string[]) {
  const def = MOB_TYPES[mobType];
  const credited = new Set<string>([killer.id]);
  for (const a of alliesBeside(g, killer)) {
    credited.add(a.id);
    const skill = weaponSkillOf(a);
    const xp = gainXp(g, a, skill, Math.round(def.hp * COMBAT.xpPerDamage * PARTY.killXpShare));
    questProgress(g, a, 'kill', mobType, 1);
    g.emit('quest.progress', { kind: 'player', playerId: a.id }, { partyKill: true, killerName: killer.name, mobType, xp, skill }, {});
    g.markPlayer(a);
  }
  if (def.boss) {
    for (const id of contributors) {
      if (credited.has(id)) continue;
      const c = g.players.get(id);
      if (!c) continue;
      credited.add(id);
      questProgress(g, c, 'kill', mobType, 1);
      g.markPlayer(c);
    }
  }
}

export function mayLoot(g: Game, b: LootBag, playerId: string): boolean {
  return !b.eligible || (b.opensToAllAt ?? 0) <= g.now() || b.eligible.includes(playerId);
}

function silverIn(stacks: ItemStack[]): number {
  return stacks.reduce((n, s) => n + (s.item === 'silver' ? s.qty : 0), 0);
}

function rollLoot(g: Game, mobType: string, p: Player): ItemStack[] {
  const def = { ...MOB_TYPES[mobType], ...MOB_LOOT[mobType] };
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

// ---------- looting ----------

function loot(g: Game, p: Player, payload: Record<string, any>) {
  const bagId = reqStr(payload, 'bagId', 80);
  const zone = requireArrived(g, p);
  const bag = g.bags.get(bagId);
  if (!bag) fail('NOT_FOUND', `no loot bag ${bagId}`);
  if (!mayLoot(g, bag!, p.id)) {
    const wait = bag!.opensToAllAt! - g.now();
    fail('FORBIDDEN', `these are ${bag!.ownerName} spoils: only the players who damaged it can loot them for another ${Math.ceil(wait / 1000)}s`, wait,
      `eligible: ${(bag!.eligibleNames ?? bag!.eligible!.map((id) => g.players.get(id)?.name ?? id)).join(', ')}. Wait retryAfterMs, or ask one of them to share.`);
  }
  sameRegion(zone, bag!.zone, `loot bag ${bagId}`, 'loot', bagId);
  requireInRange(g, p, { x: bag!.x!, y: bag!.y! }, bagId, 'loot bag');
  const asked = payload.items === undefined ? toStacks(bag!.items) : stacks(payload.items, 'items', false);
  const want = removeItems(bag!.items, asked);
  addItems(p.inventory, want);
  g.markBag(bag!);
  if (Object.keys(bag!.items).length === 0) g.bags.delete(bag!.id);
  const who = seenAs(p);
  const taking = { bagId, ownerId: bag!.ownerId, ownerName: bag!.ownerName, looterId: who.id, looterName: who.name, items: want };
  if (bag!.corpse) {
    // A region-wide event would tell of a death to people who never saw the body.
    const ev = g.emit('loot.taken', { kind: 'operator' }, taking, { zone, actor: p });
    const spot = { x: bag!.x!, y: bag!.y! };
    for (const o of g.players.values()) {
      if (!o.dead && dist(posOf(g, o), spot) <= MAP_RULES.viewRadius) g.emitCopy(ev, 'loot.taken', o.id, taking);
    }
  } else g.emit('loot.taken', { kind: 'zone', zone }, taking, { zone, actor: p });
  g.setLastAction(p, 'loot', `looted ${describe(want)} from ${bag!.ownerName}'s bag`);
  g.markPlayer(p);
  return { taken: want, remaining: toStacks(bag!.items) };
}

// ---------- food ----------

function eat(g: Game, p: Player) {
  requireReady(g, p);
  if ((p.inventory[FOOD.item] ?? 0) < 1) {
    fail('NOT_ENOUGH_ITEMS', `you carry no ${FOOD.item}`, undefined, 'cook rations from grain at a settlement kitchen (refine { recipeId: "ration" }), or buy them from players');
  }
  g.markPlayer(p);
  removeItems(p.inventory, [{ item: FOOD.item, qty: 1 }]);
  const now = g.now();
  p.wellFedUntil = now + g.ms(FOOD.wellFedMs);
  const busy = g.ms(TIMING.eatMs);
  p.busyUntil = now + busy;
  g.emit('eat', { kind: 'operator' }, { playerId: p.id, name: p.name, item: FOOD.item }, { zone: p.zone, actor: p });
  g.setLastAction(p, 'eat', `ate a ${FOOD.item}`);
  return { ate: FOOD.item, wellFedMs: g.ms(FOOD.wellFedMs), busyMs: busy };
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
  // Settlement charter tax: a share of the quest silver goes straight into the stockpile.
  const tax = taxQuestReward(g, p, silverIn(def!.reward));
  g.emit('quest', { kind: 'operator' }, { playerId: p.id, name: p.name, questId, status: 'claimed', reward: def!.reward, ...(tax ? { tax } : {}) }, { zone: 'town', actor: p });
  g.setLastAction(p, 'quest', `claimed ${def!.name} (${describe(def!.reward)})${tax ? `, paid ${tax} silver settlement tax` : ''}`);
  g.markPlayer(p);
  return tax ? { reward: def!.reward, tax } : { reward: def!.reward };
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
  if (itemDef(item)?.kind === 'orb') g.store.ledger('orbs.created.shop', qty);
  g.emit('shop', { kind: 'operator' }, { playerId: p.id, name: p.name, item, qty, paid: cost }, { zone: 'town', actor: p });
  g.setLastAction(p, 'shop', `bought ${qty}× ${item} for ${cost} silver`);
  g.markPlayer(p);
  return { bought: { item, qty }, paid: cost, inventory: toStacks(p.inventory) };
}

function repair(g: Game, p: Player, payload: Record<string, any>) {
  const slotArg = payload.slot === undefined ? undefined : reqStr(payload, 'slot', 10);
  if (slotArg !== undefined && !SLOTS.includes(slotArg as Slot)) fail('BAD_REQUEST', `slot must be one of ${SLOTS.join(', ')}`);
  const hall = buildingStation(g, p, 'forge');
  if (!hall?.working) requirePlace(g, p, 'forge', 'repairs');
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
  // Town keeps HP full. Anywhere else a repair must not heal, or a 1 silver repair would be a full heal in PvP land.
  p.hp = p.zone === 'town' ? maxHp(p) : Math.min(p.hp, maxHp(p));
  g.store.ledger('destroyed.repair', total);
  g.emit('repair', { kind: 'operator' }, { playerId: p.id, name: p.name, repaired: jobs, paid: total }, { zone: p.zone, actor: p });
  g.setLastAction(p, 'repair', `repaired ${jobs.map((j) => j.item).join(', ')} for ${total} silver`);
  g.markPlayer(p);
  return { repaired: jobs, paid: total, gear: gearView(p) };
}

// ---------- tick ----------

/** Boss damage multiplier: enraged once the fight has lasted `enrageAfterMs`. */
function enrageMult(g: Game, m: Mob, now: number): number {
  const boss = MOB_TYPES[m.type].boss;
  return boss && m.engagedAt !== undefined && now - m.engagedAt >= g.ms(boss.enrageAfterMs) ? boss.enrageMult : 1;
}

/** Boss area attack: hits everyone fighting it within `aoeRadius` tiles. */
function bossSweep(g: Game, m: Mob, now: number, valid: (id: string) => boolean) {
  const boss = MOB_TYPES[m.type].boss!;
  if (m.nextAoeAt === undefined || now < m.nextAoeAt) return;
  m.nextAoeAt = now + g.ms(boss.aoeEveryMs);
  const mult = enrageMult(g, m, now);
  const name = MOB_TYPES[m.type].name;
  for (const id of Object.keys(m.aggro)) {
    if (!valid(id)) continue;
    const target = g.players.get(id)!;
    if (dist(m, posOf(g, target)) > boss.aoeRadius + 1e-9) continue;
    const res = damagePlayer(g, target, boss.aoeDamage * mult, { kind: 'mob', id: m.id, name }, 'sweep');
    if (res.downed) continue;
    const who = seenAs(target);
    g.emit('combat.hit', { kind: 'zone', zone: m.zone }, { attackerId: m.id, attackerName: name, targetId: who.id, targetName: who.name, ability: 'sweep', damage: res.damage, dodged: res.dodged, targetHpPct: Math.round((target.hp / maxHp(target)) * 100), area: true, enraged: mult > 1 }, { zone: m.zone });
  }
}

export function worldTick(g: Game, now: number) {
  for (const p of bySeenId(g.players.values())) {
    if (p.downed || p.dead) continue;
    if (p.travel) walkTick(g, p, now);
    const max = maxHp(p);
    if (p.hp < max && p.zone === 'town') { p.hp = max; g.markPlayer(p); continue; }
    if (p.hp < max && now - p.lastCombatAt >= g.ms(TIMING.outOfCombatMs) && now - p.lastRegenAt >= g.ms(TIMING.regenIntervalMs)) {
      p.hp = Math.min(max, p.hp + Math.ceil(max * TIMING.regenFraction * (isWellFed(g, p) ? FOOD.regenMult : 1)));
      p.lastRegenAt = now;
      g.markPlayer(p);
    }
  }
  for (const m of g.mobs.values()) {
    const def = MOB_TYPES[m.type];
    const last = m.movedAt ?? now;
    m.movedAt = now;
    if (m.hp <= 0 || m.deadUntil > now) {
      if (m.deadUntil <= now) { m.hp = def.hp; m.deadUntil = 0; resetMob(m); m.x = m.home.x; m.y = m.home.y; }
      continue;
    }
    if (!m.targetId && m.hp >= def.hp && m.engagedAt === undefined && m.x === m.home.x && m.y === m.home.y) continue;
    // A mob keeps chasing an attacker anywhere in its own region; it gives up (healed, back home) when none is left there.
    // A target that went down, died or left hands the fight to the next attacker still here.
    const valid = (id: string) => { const t = g.players.get(id); return !!t && !t.downed && !t.dead && t.zone === m.zone; };
    if (!m.targetId || !valid(m.targetId)) {
      if (m.targetId) delete m.aggro[m.targetId];
      const next = Object.entries(m.aggro).filter(([id]) => valid(id)).sort((a, b) => b[1] - a[1])[0];
      if (next) { m.targetId = next[0]; }
      else { resetMob(m); m.hp = def.hp; m.x = m.home.x; m.y = m.home.y; continue; }
    }
    const target = g.players.get(m.targetId!)!;
    const tpos = posOf(g, target);
    mobStep(g, m, tpos, (now - last) / g.ms(MAP_RULES.mobMsPerTile));
    if (def.boss) bossSweep(g, m, now, valid);
    if (!m.targetId || dist(m, tpos) > MAP_RULES.range.interact + 1e-9) continue;
    if (now >= m.nextAttackAt) {
      m.nextAttackAt = now + g.ms(def.attackMs);
      const zone = m.zone;
      const res = damagePlayer(g, target, def.damage * enrageMult(g, m, now), { kind: 'mob', id: m.id, name: def.name }, 'claw');
      if (res.downed) continue;
      const who = seenAs(target);
      g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: m.id, attackerName: def.name, targetId: who.id, targetName: who.name, ability: 'claw', damage: res.damage, dodged: res.dodged, targetHpPct: Math.round((target.hp / maxHp(target)) * 100) }, { zone });
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
    // A hooded player reads as someone out of sight.
    const visible = canPlace(g, p, o!);
    const pos = posOf(g, o!);
    return { id: o!.id, name: o!.name, online: g.isOnline(o!.id), zone: visible ? o!.zone : null, pos: visible ? { x: round1(pos.x), y: round1(pos.y) } : null, createdAt: o!.createdAt };
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
  eat: rw((g, p) => eat(g, p)),
};
