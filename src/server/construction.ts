// Construction projects, personal stashes, the watchtower log, and the tick that takes upkeep and pays income.
// Everything here is member business, except that a stash stays its owner's after they leave the settlement.

import { BUILDINGS, SETTLEMENT, TIMING, WEAR, XP, type BuildingDef, type BuildingId, type ItemStack } from '../shared/catalog.ts';
import type { StashView, WatchEntry } from '../shared/protocol.ts';
import { activeLevelOf, capacityOf, hasBuilding, levelOf, projectViews, stillNeeded, units, works } from './buildings.ts';
import type { Game } from './game.ts';
import { audit, requireAtPlot, requireMember, requireRole, settlementView } from './settlement.ts';
import type { CommandDef, Player, Settlement } from './types.ts';
import { addItems, describe, fail, hasItems, missing, optInt, removeItems, reqStr, stacks, toBag, toStacks, type Bag } from './util.ts';
import { addWear, affixSum, gainXp, requireReady, requireTool, skillLevel } from './world.ts';

const members = (s: Settlement) => ({ kind: 'settlement' as const, id: s.id });

function reqBuilding(payload: Record<string, any>): BuildingDef {
  const id = reqStr(payload, 'building', 30);
  if (!Object.hasOwn(BUILDINGS, id)) fail('BAD_REQUEST', `unknown building "${id}"`, undefined, `buildings are ${Object.keys(BUILDINGS).join(', ')} (catalog().buildings)`);
  return BUILDINGS[id as BuildingId];
}

// ---------- projects ----------

/** Members put materials in. The first contribution starts the project and takes a building slot. */
function contribute(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  const def = reqBuilding(payload);
  requireAtPlot(g, p, s, 'contributing');
  if (hasBuilding(s, def.id)) fail('SETTLEMENT_STATE', `${s.name} already has a ${def.name}`, undefined, 'one of each building; upkeep is paid from the stockpile, not contributed');
  let project = s.projects[def.id];
  if (!project) {
    const level = levelOf(s);
    if (s.buildings.length + Object.keys(s.projects).length >= level.slots) {
      const next = SETTLEMENT.levels.find((l) => l.level === level.level + 1);
      fail('SETTLEMENT_STATE', `a ${level.name} has ${level.slots} building slots and all are taken by buildings and projects`, undefined,
        `${next ? `a ${next.name} (${next.buildings} buildings, ${next.members} members) has ${next.slots} slots. ` : ''}A steward or the leader can free a project's slot with settlement.cancelProject.`);
    }
  }
  const needs = stillNeeded(def, project?.materials ?? {});
  if (!Object.keys(needs).length) fail('SETTLEMENT_STATE', `the ${def.name} has all its materials`, undefined, `work on it with settlement.build { building: '${def.id}' }`);
  let give: ItemStack[];
  if (payload.items === undefined) {
    give = Object.entries(needs).map(([item, qty]) => ({ item, qty: Math.min(qty, p.inventory[item] ?? 0) })).filter((i) => i.qty > 0);
    if (!give.length) fail('NOT_ENOUGH_ITEMS', `you carry nothing the ${def.name} still needs (${describe(toStacks(needs))})`);
  } else {
    give = stacks(payload.items, 'items', false);
    for (const i of give) if (!needs[i.item]) fail('BAD_REQUEST', `the ${def.name} needs no more ${i.item}`, undefined, `it still needs ${describe(toStacks(needs))}`);
    // Anything beyond the need stays with the player.
    give = give.map((i) => ({ item: i.item, qty: Math.min(i.qty, needs[i.item]) }));
    if (!hasItems(p.inventory, give)) fail('NOT_ENOUGH_ITEMS', `missing ${missing(p.inventory, give)}`);
  }
  g.markSettlement(s);
  g.markPlayer(p);
  const taken = removeItems(p.inventory, give);
  project ??= s.projects[def.id] = { materials: {}, work: 0, startedBy: p.id };
  addItems(project.materials, taken);
  audit(g, s, p, 'contribute', taken, def.id);
  const view = projectViews(s).find((v) => v.building === def.id)!;
  g.emit('settlement.project', members(s), { settlementId: s.id, stage: 'contributed', project: view, items: taken, playerId: p.id, name: p.name }, { zone: s.zone, actor: p });
  g.setLastAction(p, 'settlement', `contributed ${describe(taken)} to ${s.name}'s ${def.name}`);
  return { contributed: taken, project: view };
}

/** One timed unit of work on a project that has all its materials. */
function build(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  const def = reqBuilding(payload);
  requireAtPlot(g, p, s, 'building');
  const project = s.projects[def.id];
  if (!project) {
    fail('SETTLEMENT_STATE', hasBuilding(s, def.id) ? `the ${def.name} is finished` : `${s.name} has no ${def.name} project`, undefined,
      hasBuilding(s, def.id) ? undefined : `start it with settlement.contribute { building: '${def.id}' }: it needs ${describe(def.cost)}`);
  }
  const needs = stillNeeded(def, project!.materials);
  if (Object.keys(needs).length) fail('NOT_ENOUGH_ITEMS', `the ${def.name} still needs ${describe(toStacks(needs))}`, undefined, `any member can add them with settlement.contribute { building: '${def.id}' }`);
  const level = skillLevel(p, 'construction');
  if (level < def.minLevel) fail('SKILL_TOO_LOW', `the ${def.name} needs construction level ${def.minLevel}; you are level ${level}`, undefined, 'building any tier-1 building trains construction');
  const slow = requireTool(g, p, 'construction', def.tier, `building a ${def.name}`);
  requireReady(g, p);
  g.markSettlement(s);
  g.markPlayer(p);
  project!.work++;
  const xp = gainXp(g, p, 'construction', XP.build(def.tier) * (1 + affixSum(p, ['tool'], 'build_xp') / 100));
  const now = g.now();
  const busy = g.ms(TIMING.buildMs * Math.max(0.5, 1 - 0.05 * level) * slow * (1 - Math.min(0.9, affixSum(p, ['tool'], 'build_speed') / 100)));
  p.busyUntil = now + busy;
  addWear(g, p, 'tool', WEAR.perToolUse);
  const work = project!.work;
  const built = work >= def.work;
  if (built) {
    delete s.projects[def.id];
    if (!s.buildings.length) s.nextIncomeAt = now + g.ms(SETTLEMENT.upkeepMs);
    // The first interval is covered by the construction.
    s.buildings.push({ id: def.id, builtAt: now, paidUntil: now + g.ms(SETTLEMENT.upkeepMs) });
    s.level = levelOf(s).level;
  }
  g.emit('settlement.project', members(s), { settlementId: s.id, stage: built ? 'built' : 'progress', building: def.id, work, workNeeded: def.work, playerId: p.id, name: p.name, ...(built ? { level: s.level } : {}) }, { zone: s.zone, actor: p });
  g.setLastAction(p, 'settlement', built ? `finished ${s.name}'s ${def.name}` : `building ${s.name}'s ${def.name} (${work}/${def.work})`);
  return { building: def.id, work, workNeeded: def.work, built, xp, busyMs: busy };
}

/** Frees the slot. The materials go to the stockpile, where the charter decides who takes them. */
function cancelProject(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireRole(g, p, 'steward', 'cancelling a project');
  const def = reqBuilding(payload);
  requireAtPlot(g, p, s, 'cancelling a project');
  const project = s.projects[def.id];
  if (!project) fail('SETTLEMENT_STATE', `${s.name} has no ${def.name} project`);
  g.markSettlement(s);
  const returned = toStacks(project!.materials);
  delete s.projects[def.id];
  addItems(s.stockpile, returned);
  audit(g, s, p, 'cancel', returned, def.id);
  g.emit('settlement.project', members(s), { settlementId: s.id, stage: 'cancelled', building: def.id, items: returned, playerId: p.id, name: p.name }, { zone: s.zone, actor: p });
  g.setLastAction(p, 'settlement', `cancelled ${s.name}'s ${def.name}`);
  return { returned, settlement: settlementView(g, s, p.id) };
}

// ---------- stashes ----------

function stashDeposit(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  requireAtPlot(g, p, s, 'your stash');
  if (!works(s, 'huts')) {
    fail('SETTLEMENT_STATE', hasBuilding(s, 'huts') ? `${s.name}'s huts are closed: their upkeep is unpaid` : `${s.name} has no huts`, undefined,
      hasBuilding(s, 'huts') ? 'put the upkeep in the stockpile. Taking your things out always works.' : "build them: settlement.contribute { building: 'huts' }");
  }
  const asked = stacks(payload.items, 'items', false);
  const room = BUILDINGS.huts.stashCapacity! - units(s.stashes[p.id] ?? {});
  if (units(toBag(asked)) > room) fail('SETTLEMENT_STATE', `your stash has room for ${Math.max(0, room)} more items`, undefined, 'silver takes no room');
  g.markSettlement(s);
  g.markPlayer(p);
  const items = removeItems(p.inventory, asked);
  addItems((s.stashes[p.id] ??= {}), items);
  g.emit('stash', { kind: 'operator' }, { settlementId: s.id, playerId: p.id, name: p.name, action: 'deposit', items }, { zone: s.zone, actor: p });
  g.setLastAction(p, 'stash', `stashed ${describe(items)} in ${s.name}`);
  return { stash: toStacks(s.stashes[p.id]), inventory: toStacks(p.inventory) };
}

/** Works for former members too, and while the huts are unpaid: a stash stays its owner's. */
function stashWithdraw(g: Game, p: Player, payload: Record<string, any>) {
  let s: Settlement | undefined;
  if (payload.settlementId !== undefined) {
    const id = reqStr(payload, 'settlementId', 40);
    s = g.settlements.get(id);
  } else {
    const mine = [...g.settlements.values()].filter((x) => x.stashes[p.id]);
    s = mine.find((x) => x.id === p.settlementId) ?? (mine.length === 1 ? mine[0] : undefined);
  }
  const stash: Bag | undefined = s?.stashes[p.id];
  if (!stash) fail('NOT_FOUND', 'you have no stash there', undefined, 'stash.view lists your stashes with their settlementId');
  requireAtPlot(g, p, s!, 'your stash');
  g.markSettlement(s!);
  g.markPlayer(p);
  const items = removeItems(stash!, stacks(payload.items, 'items', false));
  addItems(p.inventory, items);
  const left = toStacks(stash!);
  if (!left.length) delete s!.stashes[p.id];
  g.emit('stash', { kind: 'operator' }, { settlementId: s!.id, playerId: p.id, name: p.name, action: 'withdraw', items }, { zone: s!.zone, actor: p });
  g.setLastAction(p, 'stash', `took ${describe(items)} from a stash`);
  return { stash: left, inventory: toStacks(p.inventory) };
}

/** Your own stashes, from anywhere. Nobody else's. */
function stashView(g: Game, p: Player) {
  const stashes: StashView[] = [];
  for (const s of g.settlements.values()) {
    if (s.stashes[p.id]) stashes.push({ settlementId: s.id, name: s.name, plotId: s.plotId, member: !!s.members[p.id], items: toStacks(s.stashes[p.id]) });
  }
  return { stashes };
}

// ---------- watchtower ----------

function watchtowerLog(g: Game, p: Player, payload: Record<string, any>) {
  const s = requireMember(g, p);
  const limit = optInt(payload, 'limit', 1, 200, SETTLEMENT.logPage);
  const beforeId = optInt(payload, 'beforeId', 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (!hasBuilding(s, 'watchtower')) fail('SETTLEMENT_STATE', `${s.name} has no watchtower`, undefined, "build one: settlement.contribute { building: 'watchtower' }");
  const entries: WatchEntry[] = g.store.all<{ id: number; ts: number; player_id: string; name: string; move: WatchEntry['move'] }>(
    'SELECT id, ts, player_id, name, move FROM watch_log WHERE settlement_id = ? AND id < ? ORDER BY id DESC LIMIT ?', s.id, beforeId, limit,
  ).map((r) => ({ id: r.id, ts: r.ts, playerId: r.player_id, name: r.name, move: r.move }));
  return { settlementId: s.id, recording: works(s, 'watchtower'), entries };
}

// ---------- tick ----------

/**
 * Takes each building's upkeep when it falls due, and pays the settlement's income. An unpaid building keeps trying,
 * so it works again as soon as the stockpile can pay. Time the server was down is not billed or paid.
 */
export function settlementTick(g: Game, now: number) {
  const interval = g.ms(SETTLEMENT.upkeepMs);
  for (const s of g.settlements.values()) {
    if (!s.buildings.length) continue;
    const paid: Bag = {};
    const grown: Bag = {};
    for (const b of s.buildings) {
      if (!b.unpaid && now < b.paidUntil) continue;
      const def = BUILDINGS[b.id];
      if (!hasItems(s.stockpile, def.upkeep)) {
        if (b.unpaid) continue;
        g.markSettlement(s);
        b.unpaid = true;
        g.emit('settlement.building', members(s), { settlementId: s.id, building: b.id, working: false, upkeep: def.upkeep }, { zone: s.zone });
        continue;
      }
      g.markSettlement(s);
      addItems(paid, removeItems(s.stockpile, def.upkeep));
      const late = !!b.unpaid || now - b.paidUntil >= interval;
      b.paidUntil = (late ? now : b.paidUntil) + interval;
      if (b.unpaid) {
        delete b.unpaid;
        g.emit('settlement.building', members(s), { settlementId: s.id, building: b.id, working: true }, { zone: s.zone });
      }
      for (const out of def.produces ?? []) {
        const qty = Math.min(out.qty, capacityOf(s) - units(s.stockpile));
        if (qty <= 0) continue;
        addItems(s.stockpile, [{ item: out.item, qty }]);
        addItems(grown, [{ item: out.item, qty }]);
      }
    }
    audit(g, s, null, 'upkeep', toStacks(paid));
    audit(g, s, null, 'produced', toStacks(grown));

    const due = s.nextIncomeAt ?? now;
    if (now < due) continue;
    g.markSettlement(s);
    s.nextIncomeAt = (now - due >= interval ? now : due) + interval;
    if (s.buildings.every((b) => b.unpaid)) continue;
    const silver = activeLevelOf(s).income;
    addItems(s.stockpile, [{ item: 'silver', qty: silver }]);
    g.store.ledger('created.settlements', silver);
    audit(g, s, null, 'income', [{ item: 'silver', qty: silver }]);
  }
}

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const constructionCommands: Record<string, CommandDef> = {
  'settlement.contribute': rw(contribute),
  'settlement.build': rw(build),
  'settlement.cancelProject': rw(cancelProject),
  'stash.deposit': rw(stashDeposit),
  'stash.withdraw': rw(stashWithdraw),
  'stash.view': ro((g, p) => stashView(g, p)),
  'watchtower.log': ro(watchtowerLog),
};
