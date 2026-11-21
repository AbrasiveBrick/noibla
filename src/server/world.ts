// World rules: observation, movement, gathering, refining, crafting,
// equipment, combat, death & loot, banking, quests.

import {
  ABILITIES, BASE_HP, CATALOG, COMBAT, DEATH_SILVER_LOSS, ITEMS, MAX_CRAFT_BATCH, MOB_TYPES, NODE_TYPES, QUESTS, RECIPES, SHOP, SKILLS, TIMING, WEAR, XP, ZONES,
  levelFor, type AbilityId, type ItemStack, type SkillId, type Slot, type ZoneId,
} from '../shared/catalog.ts';
import type { AbilityView, AttackResult, GearWearView, Observation, QuestProgress, ZoneView } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { CommandDef, Mob, Player } from './types.ts';
import { addItems, describe, fail, hasItems, missing, newId, obj, optInt, removeItems, reqStr, stacks, toStacks } from './util.ts';

// ---------- derived stats ----------

export function maxHp(p: Player): number {
  const armor = p.equipment.armor ? ITEMS[p.equipment.armor] : undefined;
  return BASE_HP + Math.round((armor?.hpBonus ?? 0) * gearMultiplier(p, 'armor'));
}

function defense(p: Player): number {
  const armor = p.equipment.armor ? ITEMS[p.equipment.armor] : undefined;
  return (armor?.defense ?? 0) * gearMultiplier(p, 'armor');
}

// ---------- gear wear ----------

/** Wear is tracked per item id, so unequipping and re-equipping keeps it. */
function wearOf(p: Player, item: string): number { return p.wear?.[item] ?? 0; }

function gearMultiplier(p: Player, slot: Slot): number {
  const item = p.equipment[slot];
  return item && wearOf(p, item) >= WEAR.max ? WEAR.brokenMultiplier : 1;
}

export function repairCost(item: string, wear: number): number {
  if (wear <= 0) return 0;
  return Math.ceil(((WEAR.repairCostByTier[ITEMS[item]?.tier ?? 0] ?? 0) * wear) / WEAR.max);
}

export function gearView(p: Player): Partial<Record<Slot, GearWearView>> {
  const out: Partial<Record<Slot, GearWearView>> = {};
  for (const slot of ['weapon', 'armor'] as Slot[]) {
    const item = p.equipment[slot];
    if (!item) continue;
    const wear = wearOf(p, item);
    out[slot] = { item, wear: Math.round(wear * 100) / 100, broken: wear >= WEAR.max, repairCost: repairCost(item, wear) };
  }
  return out;
}

function addWear(g: Game, p: Player, slot: Slot, amount: number) {
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

export function skillLevel(p: Player, s: SkillId): number { return levelFor(p.skills[s] ?? 0); }

function gainXp(p: Player, s: SkillId, xp: number) { p.skills[s] = (p.skills[s] ?? 0) + Math.max(0, Math.round(xp)); }

/** Abilities come from gear only: no classes. */
export function abilitiesOf(p: Player): { id: AbilityId; source: string }[] {
  const out: { id: AbilityId; source: string }[] = [];
  const weapon = p.equipment.weapon ? ITEMS[p.equipment.weapon] : undefined;
  if (weapon?.abilities) for (const a of weapon.abilities) out.push({ id: a, source: weapon.id });
  else out.push({ id: 'punch', source: 'unarmed' });
  const armor = p.equipment.armor ? ITEMS[p.equipment.armor] : undefined;
  if (armor?.abilities) for (const a of armor.abilities) if (!out.some((o) => o.id === a)) out.push({ id: a, source: armor.id });
  return out;
}

function bestTool(p: Player, skill: SkillId): number {
  let tier = 0;
  for (const [item, qty] of Object.entries(p.inventory)) {
    const def = ITEMS[item];
    if (qty > 0 && def?.kind === 'tool' && def.toolFor === skill) tier = Math.max(tier, def.toolTier ?? 0);
  }
  return tier;
}

// ---------- guards ----------

function requireArrived(g: Game, p: Player): ZoneId {
  if (p.travel) fail('TRAVELING', `traveling to ${p.travel.to}`, p.travel.arriveAt - g.now());
  return p.zone!;
}

function requireReady(g: Game, p: Player) {
  const now = g.now();
  if (p.busyUntil > now) fail('BUSY', 'still performing the previous action', p.busyUntil - now);
}

export function requireZone(g: Game, p: Player, zone: ZoneId, what: string): void {
  const z = requireArrived(g, p);
  if (z !== zone) fail('WRONG_ZONE', `${what} is only available in ${zone}`);
}

// ---------- observation ----------

function questViews(p: Player): QuestProgress[] {
  return Object.entries(p.quests).map(([questId, q]) => ({ questId, status: q.status, progress: Math.min(q.progress, QUESTS[questId].objective.count), goal: QUESTS[questId].objective.count }));
}

function zoneView(g: Game, zone: ZoneId, viewerId: string): ZoneView {
  const z = ZONES[zone];
  const now = g.now();
  return {
    id: z.id, name: z.name, safety: z.safety, adjacent: z.adjacent, stations: z.stations,
    hasBank: z.hasBank, hasForum: z.hasForum, hasQuestBoard: z.hasQuestBoard, pvp: z.pvp,
    nodes: [...g.nodes.values()].filter((n) => n.zone === zone).map((n) => {
      const def = NODE_TYPES[n.type];
      return { id: n.id, type: n.type, item: def.item, tier: def.tier, charges: n.charges, maxCharges: def.maxCharges, nextChargeInMs: n.charges < def.maxCharges ? Math.max(0, n.nextChargeAt - now) : 0 };
    }),
    mobs: [...g.mobs.values()].filter((m) => m.zone === zone).map((m) => {
      const def = MOB_TYPES[m.type];
      const alive = m.deadUntil <= now && m.hp > 0;
      return { id: m.id, type: m.type, name: def.name, hp: alive ? m.hp : 0, maxHp: def.hp, alive, respawnInMs: alive ? 0 : Math.max(0, m.deadUntil - now), targetId: alive ? m.targetId : null };
    }),
    players: [...g.players.values()].filter((o) => o.id !== viewerId && o.zone === zone && !o.travel).map((o) => ({
      id: o.id, name: o.name, hpPct: Math.round((o.hp / maxHp(o)) * 100), equipment: { ...o.equipment }, inCombat: now - o.lastCombatAt < g.ms(TIMING.outOfCombatMs),
    })),
    lootBags: [...g.bags.values()].filter((b) => b.zone === zone).map((b) => ({ id: b.id, ownerId: b.ownerId, ownerName: b.ownerName, items: toStacks(b.items), expiresInMs: Math.max(0, b.expiresAt - now) })),
  };
}

export function observe(g: Game, p: Player): Observation {
  const now = g.now();
  const abilities: AbilityView[] = abilitiesOf(p).map(({ id, source }) => ({ id, kind: ABILITIES[id].kind, readyInMs: Math.max(0, (p.cooldowns[id] ?? 0) - now, p.busyUntil - now), source }));
  const skills: Record<string, { xp: number; level: number }> = {};
  for (const s of SKILLS) skills[s] = { xp: p.skills[s] ?? 0, level: skillLevel(p, s) };
  const unread = g.store.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM dm_messages m LEFT JOIN dm_reads r ON r.player_id = ? AND r.conversation_id = m.conversation_id
     WHERE m.to_id = ? AND m.id > COALESCE(r.last_read_id, 0)`, p.id, p.id)?.n ?? 0;
  let openTrades = 0;
  for (const t of g.trades.values()) if ((t.status === 'proposed' || t.status === 'agreed') && (t.proposerId === p.id || t.counterpartyId === p.id)) openTrades++;
  return {
    now,
    self: {
      id: p.id, name: p.name, zone: p.zone,
      travel: p.travel ? { from: p.travel.from, to: p.travel.to, arriveAt: p.travel.arriveAt, arriveInMs: Math.max(0, p.travel.arriveAt - now) } : null,
      hp: p.hp, maxHp: maxHp(p), busyMs: Math.max(0, p.busyUntil - now),
      inCombat: now - p.lastCombatAt < g.ms(TIMING.outOfCombatMs), combatLockedMs: Math.max(0, p.combatLockUntil - now),
      equipment: { ...p.equipment }, inventory: toStacks(p.inventory), skills, abilities,
      effects: { evadeMs: Math.max(0, p.evadeUntil - now), braceMs: Math.max(0, p.braceUntil - now) },
      quests: questViews(p),
      gear: gearView(p),
    },
    zone: p.zone && !p.travel ? zoneView(g, p.zone, p.id) : null,
    unreadDms: unread,
    openTrades,
  };
}

// ---------- movement ----------

function move(g: Game, p: Player, payload: Record<string, any>) {
  const to = reqStr(payload, 'to', 20) as ZoneId;
  if (!ZONES[to]) fail('BAD_REQUEST', `unknown zone "${to}"`);
  const from = requireArrived(g, p);
  if (from === to) fail('BAD_REQUEST', `already in ${to}`);
  if (!ZONES[from].adjacent.includes(to)) fail('NOT_ADJACENT', `${to} is not adjacent to ${from}; adjacent: ${ZONES[from].adjacent.join(', ')}`);
  requireReady(g, p);
  const now = g.now();
  if (p.combatLockUntil > now) {
    const attackers = [...g.mobs.values()].filter((m) => m.targetId === p.id && mobAlive(g, m)).map((m) => `${MOB_TYPES[m.type].name} (${m.id}, ${m.hp} hp)`);
    fail('COMBAT_LOCKED', 'cannot leave the zone while in combat', p.combatLockUntil - now,
      attackers.length
        ? `every hit you deal or take renews the lock, and these mobs keep attacking you: ${attackers.join(', ')}. Kill them (or die) before moving.`
        : 'stop attacking and wait retryAfterMs, then move.');
  }
  p.travel = { from, to, departAt: now, arriveAt: now + g.ms(TIMING.travelMs) };
  p.zone = null;
  clearAggro(g, p.id);
  g.emit('travel.depart', { kind: 'zone', zone: from }, { playerId: p.id, name: p.name, from, to }, { zone: from, actor: p });
  g.setLastAction(p, 'travel', `traveling ${from} → ${to}`);
  g.markPlayer(p);
  return { travel: { from, to, arriveAt: p.travel.arriveAt, arriveInMs: p.travel.arriveAt - now } };
}

function arrive(g: Game, p: Player) {
  const t = p.travel!;
  p.zone = t.to;
  p.travel = null;
  if (t.to === 'town') p.hp = maxHp(p);
  g.emit('travel.arrive', { kind: 'zone', zone: t.to }, { playerId: p.id, name: p.name, from: t.from, to: t.to }, { zone: t.to, actor: p });
  g.emit('self.arrived', { kind: 'player', playerId: p.id }, { zone: t.to }, { zone: t.to });
  g.setLastAction(p, 'travel', `arrived in ${t.to}`);
  g.markPlayer(p);
}

// ---------- gathering ----------

function gather(g: Game, p: Player, payload: Record<string, any>) {
  const nodeId = reqStr(payload, 'nodeId', 80);
  const zone = requireArrived(g, p);
  const node = g.nodes.get(nodeId);
  if (!node || node.zone !== zone) fail('INVALID_TARGET', `no resource node ${nodeId} in ${zone}`);
  requireReady(g, p);
  const def = NODE_TYPES[node!.type];
  const now = g.now();
  if (node!.charges <= 0) fail('DEPLETED', `${def.name} is depleted`, node!.nextChargeAt - now);
  const tool = bestTool(p, def.skill);
  if (tool < def.tier - 1) fail('TOOL_REQUIRED', `${def.name} (tier ${def.tier}) needs a tier ${def.tier - 1}+ ${def.skill} tool; best carried is tier ${tool}`, undefined, toolHint(def.skill, def.tier - 1));
  const level = skillLevel(p, def.skill);
  const qty = 1 + (g.rng() < 0.1 * level ? 1 : 0);
  if (node!.charges === def.maxCharges) node!.nextChargeAt = now + g.ms(TIMING.nodeRegenMs);
  node!.charges--;
  addItems(p.inventory, [{ item: def.item, qty }]);
  const xp = XP.gather(def.tier);
  gainXp(p, def.skill, xp);
  const busy = g.ms(TIMING.gatherMs * Math.max(0.5, 1 - 0.05 * level));
  p.busyUntil = now + busy;
  questProgress(g, p, 'gather', def.item, qty);
  g.emit('gather', { kind: 'zone', zone }, { playerId: p.id, name: p.name, nodeId, item: def.item, qty }, { zone, actor: p });
  g.setLastAction(p, 'gather', `gathered ${qty}× ${def.item}`);
  g.markPlayer(p);
  return { item: def.item, qty, xp, skill: def.skill, level: skillLevel(p, def.skill), busyMs: busy };
}

function toolHint(skill: SkillId, minTier: number): string {
  const tool = Object.values(ITEMS)
    .filter((i) => i.kind === 'tool' && i.toolFor === skill && (i.toolTier ?? 0) >= minTier)
    .sort((a, b) => (a.toolTier ?? 0) - (b.toolTier ?? 0))[0];
  if (!tool) return `no ${skill} tool of tier ${minTier}+ exists`;
  const r = RECIPES[tool.id];
  const ways = [`buy one from another player`];
  if (r) ways.unshift(`craft it (recipe "${r.id}" at the ${r.station} in town: ${describe(r.inputs)}; needs ${r.skill} level ${r.minLevel})`);
  if (SHOP[tool.id] !== undefined) ways.push(`buy it in town with shop.buy for ${SHOP[tool.id]} silver`);
  return `carry a ${tool.id} (tier ${tool.toolTier}) in your inventory. Gathering this node again will fail until you do. Ways to get one: ${ways.join('; ')}.`;
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
    if (!ZONES[zone].stations.includes(r!.station)) fail('NO_STATION', `${recipeId} needs a ${r!.station}, found in town`);
    requireReady(g, p);
    const level = skillLevel(p, r!.skill);
    if (level < r!.minLevel) fail('SKILL_TOO_LOW', `${recipeId} needs ${r!.skill} level ${r!.minLevel}; you are level ${level}`);
    if (!hasItems(p.inventory, r!.inputs, count)) fail('NOT_ENOUGH_ITEMS', `missing ${missing(p.inventory, r!.inputs, count)}`);
    removeItems(p.inventory, r!.inputs, count);
    const output: ItemStack = { item: r!.output.item, qty: r!.output.qty * count };
    addItems(p.inventory, [output]);
    const xp = XP[kind](r!.tier) * count;
    gainXp(p, r!.skill, xp);
    const base = kind === 'refine' ? TIMING.refineMs : TIMING.craftMs;
    const busy = g.ms(base * count * Math.max(0.5, 1 - 0.05 * level));
    p.busyUntil = g.now() + busy;
    if (kind === 'craft') questProgress(g, p, 'craft', output.item, output.qty);
    g.emit(kind, { kind: 'zone', zone }, { playerId: p.id, name: p.name, recipeId, output, station: r!.station }, { zone, actor: p });
    g.setLastAction(p, kind, `${kind === 'refine' ? 'refined' : 'crafted'} ${output.qty}× ${output.item}`);
    g.markPlayer(p);
    return { output, consumed: r!.inputs.map((s) => ({ item: s.item, qty: s.qty * count })), xp, level: skillLevel(p, r!.skill), busyMs: busy };
  };
}

// ---------- equipment ----------

function equip(g: Game, p: Player, payload: Record<string, any>) {
  const item = reqStr(payload, 'item', 60);
  const def = ITEMS[item];
  if (!def?.slot) fail('NOT_EQUIPPABLE', `${item} cannot be equipped`);
  if (p.travel) fail('TRAVELING', 'cannot change gear while traveling', p.travel.arriveAt - g.now());
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

function unequip(g: Game, p: Player, payload: Record<string, any>) {
  const slot = reqStr(payload, 'slot', 10) as Slot;
  if (slot !== 'weapon' && slot !== 'armor') fail('BAD_REQUEST', 'slot must be weapon or armor');
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
  const weapon = p.equipment.weapon ? ITEMS[p.equipment.weapon] : undefined;
  const skill: SkillId = weapon?.weaponSkill ?? 'unarmed';
  const base = def.flatDamage ?? (weapon?.power ?? 0) * gearMultiplier(p, 'weapon') * (def.powerMult ?? 1);
  const bonusLevels = Math.min(skillLevel(p, skill), COMBAT.damageBonusMaxLevel);
  return { damage: base * (1 + COMBAT.damageBonusPerLevel * bonusLevels), skill };
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
  const gcd = g.ms(TIMING.globalCooldownMs);

  if (def.kind === 'buff') {
    if (ZONES[zone].safety === 'safe') fail('SAFE_ZONE', 'no combat in town');
    if (ability === 'evade') p.evadeUntil = now + g.ms(def.durationMs!);
    if (ability === 'brace') p.braceUntil = now + g.ms(def.durationMs!);
    p.cooldowns[ability] = now + g.ms(def.cooldownMs);
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
    if (mob.zone !== zone) fail('INVALID_TARGET', `${targetId} is not in ${zone}`);
    if (!mobAlive(g, mob)) fail('TARGET_DEAD', `${targetId} is dead`);
  } else if (victim) {
    if (victim.id === p.id) fail('INVALID_TARGET', 'cannot attack yourself');
    if (!ZONES[zone].pvp) fail('SAFE_ZONE', `PvP is not allowed in ${zone}`);
    if (victim.zone !== zone || victim.travel) fail('INVALID_TARGET', `${victim.name} is not in ${zone}`);
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
    const xp = combatXp(damage);
    gainXp(p, skill, xp);
    g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: p.id, attackerName: p.name, targetId: mob.id, targetName: mdef.name, ability, damage, targetHp: mob.hp }, { zone, actor: p });
    let loot: ItemStack[] = [];
    let killed = false;
    if (mob.hp <= 0) {
      killed = true;
      loot = rollLoot(g, mob.type);
      addItems(p.inventory, loot);
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
    return { ability, targetId: mob.id, damage, dodged: false, targetHp: mob.hp, killed, loot, xp, busyMs: gcd, ...(weaponWear !== undefined ? { weaponWear } : {}) };
  }

  const v = victim!;
  const res = damagePlayer(g, v, raw, { kind: 'player', id: p.id, name: p.name });
  const xp = combatXp(res.damage);
  gainXp(p, skill, xp);
  g.emit('combat.hit', { kind: 'zone', zone }, { attackerId: p.id, attackerName: p.name, targetId: v.id, targetName: v.name, ability, damage: res.damage, dodged: res.dodged, targetHpPct: Math.round((v.hp / maxHp(v)) * 100), pvp: true }, { zone, actor: p });
  g.setLastAction(p, 'combat', res.killed ? `killed ${v.name}` : `attacking ${v.name}`);
  return { ability, targetId: v.id, damage: res.damage, dodged: res.dodged, targetHp: res.killed ? 0 : v.hp, killed: res.killed, loot: [], xp, busyMs: gcd, ...(weaponWear !== undefined ? { weaponWear } : {}) };
}

function silverIn(stacks: ItemStack[]): number {
  return stacks.reduce((n, s) => n + (s.item === 'silver' ? s.qty : 0), 0);
}

function rollLoot(g: Game, mobType: string): ItemStack[] {
  const def = MOB_TYPES[mobType];
  const out: Record<string, number> = {};
  const [lo, hi] = def.silver;
  out.silver = lo + Math.floor(g.rng() * (hi - lo + 1));
  for (const d of def.drops) {
    if (g.rng() <= d.chance) out[d.item] = (out[d.item] ?? 0) + d.min + Math.floor(g.rng() * (d.max - d.min + 1));
  }
  return toStacks(out);
}

/** Death rules. Lethal zones drop everything carried and worn into a loot bag; bank and skills are always safe. */
export function killPlayer(g: Game, victim: Player, source: { kind: 'mob' | 'player'; id: string; name: string }) {
  const zone = victim.zone!;
  const z = ZONES[zone];
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
      const bag = { id: bagId, zone, ownerId: victim.id, ownerName: victim.name, items, createdAt: now, expiresAt: now + g.ms(TIMING.lootBagTtlMs) };
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
  victim.zone = 'town';
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
  if (!bag || bag.zone !== zone) fail('NOT_FOUND', `no loot bag ${bagId} in ${zone}`);
  const want = payload.items === undefined ? toStacks(bag!.items) : stacks(payload.items, 'items', false);
  removeItems(bag!.items, want);
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
    requireZone(g, p, 'town', 'the bank');
    const items = stacks(payload.items, 'items', false);
    if (kind === 'deposit') { removeItems(p.inventory, items); addItems(p.bank, items); }
    else { removeItems(p.bank, items); addItems(p.inventory, items); }
    g.emit('bank', { kind: 'operator' }, { playerId: p.id, name: p.name, action: kind, items }, { zone: 'town', actor: p });
    g.setLastAction(p, 'bank', `${kind === 'deposit' ? 'banked' : 'withdrew'} ${describe(items)}`);
    g.markPlayer(p);
    return { bank: toStacks(p.bank), inventory: toStacks(p.inventory) };
  };
}

// ---------- quests ----------

export function questProgress(g: Game, p: Player, kind: 'kill' | 'gather' | 'craft', target: string, amount: number) {
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
  requireZone(g, p, 'town', 'the quest board');
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
  requireZone(g, p, 'town', 'the quest board');
  const q = p.quests[questId];
  if (!q || q.status !== 'complete') {
    fail('QUEST_STATE', `quest ${questId} is ${q?.status ?? 'not accepted'}`, undefined,
      !q ? `accept it first with quest.accept` : q.status === 'claimed' ? 'the reward was already paid' : `progress ${Math.min(q.progress, def!.objective.count)}/${def!.objective.count}: ${def!.description} Claim it once progress reaches the goal.`);
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
  requireZone(g, p, 'town', 'the shop');
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
  if (slotArg !== undefined && slotArg !== 'weapon' && slotArg !== 'armor') fail('BAD_REQUEST', 'slot must be weapon or armor');
  requireZone(g, p, 'town', 'repairs');
  const slots: Slot[] = slotArg ? [slotArg as Slot] : ['weapon', 'armor'];
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
    if (p.travel && p.travel.arriveAt <= now) arrive(g, p);
    const max = maxHp(p);
    if (p.hp < max && p.zone === 'town' && !p.travel) { p.hp = max; g.markPlayer(p); continue; }
    if (p.hp < max && !p.travel && now - p.lastCombatAt >= g.ms(TIMING.outOfCombatMs) && now - p.lastRegenAt >= g.ms(TIMING.regenIntervalMs)) {
      p.hp = Math.min(max, p.hp + Math.ceil(max * TIMING.regenFraction));
      p.lastRegenAt = now;
      g.markPlayer(p);
    }
  }
  for (const m of g.mobs.values()) {
    const def = MOB_TYPES[m.type];
    if (m.hp <= 0 || m.deadUntil > now) {
      if (m.deadUntil <= now) { m.hp = def.hp; m.deadUntil = 0; m.aggro = {}; m.targetId = null; }
      continue;
    }
    if (!m.targetId) continue;
    const valid = (id: string) => { const t = g.players.get(id); return !!t && !t.travel && t.zone === m.zone; };
    if (!valid(m.targetId)) {
      delete m.aggro[m.targetId];
      const next = Object.entries(m.aggro).filter(([id]) => valid(id)).sort((a, b) => b[1] - a[1])[0];
      if (next) { m.targetId = next[0]; }
      else { m.targetId = null; m.aggro = {}; m.hp = def.hp; continue; }
    }
    if (now >= m.nextAttackAt) {
      const target = g.players.get(m.targetId!)!;
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
  catalog: ro(() => CATALOG),
  'player.lookup': ro((g, _p, payload) => {
    const o = g.playerByName(reqStr(obj(payload), 'name', 40));
    if (!o) fail('NOT_FOUND', 'no such player');
    return { playerId: o!.id, name: o!.name };
  }),
  'player.get': ro((g, p, payload) => {
    const o = g.players.get(reqStr(obj(payload), 'playerId', 40));
    if (!o) fail('NOT_FOUND', 'no such player');
    const sameZone = !p.travel && !o!.travel && p.zone === o!.zone;
    return { id: o!.id, name: o!.name, online: g.isOnline(o!.id), zone: sameZone ? o!.zone : null, createdAt: o!.createdAt };
  }),
  move: rw(move),
  gather: rw(gather),
  refine: rw(makeItem('refine')),
  craft: rw(makeItem('craft')),
  equip: rw(equip),
  unequip: rw(unequip),
  attack: rw((g, p, payload) => useAbility(g, p, payload, true)),
  'ability.use': rw((g, p, payload) => useAbility(g, p, payload, false)),
  loot: rw(loot),
  'bank.view': ro((g, p) => { requireZone(g, p, 'town', 'the bank'); return { items: toStacks(p.bank) }; }),
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
