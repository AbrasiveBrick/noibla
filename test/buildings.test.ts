// Stage 3: projects, upkeep, levels, stations, shared work, food, stashes, the palisade and the watchtower.
// Timers (upkeep, income, Well fed) are tested on a fake clock; the SDK flow and secrecy over HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AFFIXES, BUILDINGS, CATALOG, FOOD, RECIPES, SETTLEMENT, STARTER_KIT, TIMING, UNIQUE_SEP, gearGroup, itemDef,
  type BuildingId, type ItemStack,
} from '../src/shared/catalog.ts';
import { dist, regionAt, walkable, type Pos } from '../src/shared/map.ts';
import type { CommandError } from '../src/sdk/index.ts';
import { AFFIX_RANGES, BUILDING_ODDS, rollAffix } from '../src/server/odds.ts';
import { operatorState } from '../src/server/operator.ts';
import { Game, type GameOptions } from '../src/server/game.ts';
import { killPlayer } from '../src/server/world.ts';
import type { Player, Settlement } from '../src/server/types.ts';
import { attach, wait, world } from './helpers.ts';

const bag = (list: ItemStack[]) => Object.fromEntries(list.map((s) => [s.item, s.qty]));
const sum = (bags: Record<string, number>[]) => {
  const out: Record<string, number> = {};
  for (const b of bags) for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
};

// ---------- a game on a fake clock ----------

let seq = 0; // across games: one test reopens a database, which remembers command ids

function fake(o: Partial<GameOptions> = {}) {
  let now = 1_000_000;
  const g = new Game({ dbPath: ':memory:', now: () => now, seed: 4, mapSeed: 7, log: (line) => assert.fail(line), ...o });
  const run = (id: string, type: string, payload: object = {}) => {
    g.players.get(id)!.busyUntil = 0;
    return g.execute(id, { commandId: `c${++seq}`, type, payload }) as any;
  };
  const ok = (id: string, type: string, payload: object = {}) => {
    now += 100; // under the command rate limit
    const r = run(id, type, payload);
    assert.ok(r.ok, `${type}: ${r.error?.code} ${r.error?.message}`);
    return r.result;
  };
  const no = (id: string, type: string, payload: object = {}) => {
    now += 100;
    const r = run(id, type, payload);
    assert.ok(!r.ok, `${type} should fail`);
    return r.error;
  };
  const p = (id: string): Player => g.players.get(id)!;
  const give = (id: string, items: Record<string, number>) => { for (const [k, n] of Object.entries(items)) p(id).inventory[k] = (p(id).inventory[k] ?? 0) + n; };
  const put = (id: string, pos: Pos) => Object.assign(p(id), { pos: { x: pos.x, y: pos.y }, zone: regionAt(g.map, pos), travel: null });
  const hold = (id: string, item: string) => { if (!Object.values(p(id).equipment).includes(item)) ok(id, 'equip', { item }); };
  /** Test setup edits memory only: write it, so a rollback has it to go back to. */
  const save = (id: string) => g.mutate(() => g.markPlayer(p(id)));
  return { g, run, ok, no, p, hold, save, give, put, now: () => now, pass: (ms: number) => { now += ms; g.tick(); } };
}
type Fake = ReturnType<typeof fake>;

function settle(f: Fake, size: number) {
  const plot = f.g.map.plots.find((pl) => pl.region === 'hollow')!;
  const ids = Array.from({ length: size }, (_, i) => f.g.register(`Villager${i}`).playerId);
  for (const id of ids) f.put(id, plot);
  f.give(ids[0], bag(SETTLEMENT.foundCost));
  const sid = f.ok(ids[0], 'settlement.found', { name: 'Test Hold', plotId: plot.id }).settlement.id as string;
  for (const id of ids.slice(1)) {
    f.ok(ids[0], 'settlement.invite', { playerId: id });
    f.ok(id, 'settlement.join', { settlementId: sid });
  }
  const s = (): Settlement => f.g.settlements.get(sid)!;
  /** Raises buildings with the real commands. */
  const raise = (...buildings: BuildingId[]) => {
    const who = ids[0];
    f.p(who).skills.construction = Math.max(f.p(who).skills.construction ?? 0, 40);
    f.hold(who, 'copper_trowel');
    for (const building of buildings) {
      f.give(who, bag(BUILDINGS[building].cost));
      f.ok(who, 'settlement.contribute', { building });
      for (let i = 0; i < BUILDINGS[building].work; i++) f.ok(who, 'settlement.build', { building });
    }
    f.p(who).wear = {};
  };
  const stock = (items: Record<string, number>) => { s().stockpile = sum([s().stockpile, items]); };
  return { plot, ids, sid, s, raise, stock };
}

test('catalog: buildings promise nothing a later stage owes, and hide their odds', () => {
  assert.deepEqual(Object.keys(BUILDINGS).sort(), ['farm', 'forge_hall', 'huts', 'kitchen', 'palisade', 'storehouse', 'watchtower', 'workshop'], 'the infirmary waits for stage 5');
  for (const b of Object.values(BUILDINGS)) {
    assert.doesNotMatch(b.description, /downed|witness|lock|raid|steal|theft|ally|allies|revive/i, `${b.id} advertises a later stage`);
    for (const s of [...b.cost, ...b.upkeep, ...(b.produces ?? [])]) assert.ok(itemDef(s.item), `${b.id}: ${s.item}`);
  }
  assert.ok(BUILDINGS.forge_hall.cost.some((s) => s.item === 'bear_pelt'));
  assert.equal(SETTLEMENT.levels.at(-1)!.slots, Object.keys(BUILDINGS).length);

  const text = JSON.stringify(CATALOG);
  assert.ok(!text.includes('workshopOutput'));
  assert.doesNotMatch(JSON.stringify(CATALOG.buildings.workshop), /\d\s*%|chance":/, 'the workshop bonus is in words only');
  assert.ok(BUILDING_ODDS.workshopOutput > 0);

  assert.equal(CATALOG.nodes.fertile_field.skill, 'farming');
  for (const [tool, group] of [['copper_hoe', 'gathering'], ['copper_pot', 'refining'], ['copper_trowel', 'building']] as const) {
    assert.equal(gearGroup(tool), group);
    for (let i = 0; i < 30; i++) {
      const roll = rollAffix(() => i / 30, tool, 60, [])!;
      assert.equal(AFFIXES[roll.id].group, group, tool);
      assert.ok(Number.isFinite(roll.value), `${roll.id} has a range`);
    }
  }
});

test('projects: members put in materials at the plot, then timed building with a trowel raises it', () => {
  const f = fake();
  try {
    const { ids: [A, B], plot, s } = settle(f, 2);
    assert.equal(f.no(A, 'settlement.contribute', { building: 'castle' }).code, 'BAD_REQUEST');
    assert.equal(f.no(A, 'settlement.contribute', { building: '__proto__' }).code, 'BAD_REQUEST');
    assert.equal(f.no(A, 'settlement.contribute', { building: 'farm' }).code, 'NOT_ENOUGH_ITEMS', 'nothing to give');
    assert.deepEqual(s().projects, {}, 'a failed contribution starts nothing');

    const cost = bag(BUILDINGS.farm.cost);
    f.give(A, { pine_plank: cost.pine_plank + 5, iron_bar: 3 });
    assert.equal(f.no(A, 'settlement.contribute', { building: 'farm', items: [{ item: 'iron_bar', qty: 1 }] }).code, 'BAD_REQUEST', 'not needed');
    const first = f.ok(A, 'settlement.contribute', { building: 'farm', items: [{ item: 'pine_plank', qty: cost.pine_plank + 5 }] });
    assert.deepEqual(first.contributed, [{ item: 'pine_plank', qty: cost.pine_plank }], 'the surplus stays with the player');
    assert.equal(f.p(A).inventory.pine_plank, 5);
    assert.equal(first.project.readyToBuild, false);
    f.hold(A, 'copper_trowel');
    assert.equal(f.no(A, 'settlement.build', { building: 'farm' }).code, 'NOT_ENOUGH_ITEMS');

    f.give(B, { stone: cost.stone, grain: cost.grain });
    f.put(B, f.g.map.anchors.town);
    assert.equal(f.no(B, 'settlement.contribute', { building: 'farm' }).code, 'OUT_OF_RANGE');
    f.put(B, plot);
    assert.equal(f.ok(B, 'settlement.contribute', { building: 'farm' }).project.readyToBuild, true);
    assert.equal(f.no(B, 'settlement.build', { building: 'farm' }).code, 'TOOL_REQUIRED');

    // Each action is one timed unit of work, and any member can do it.
    const step = f.ok(A, 'settlement.build', { building: 'farm' });
    assert.equal(step.work, 1);
    assert.equal(step.busyMs, TIMING.buildMs);
    assert.ok(step.xp > 0);
    assert.equal((f.g.execute(A, { commandId: 'too-soon', type: 'settlement.build', payload: { building: 'farm' } }) as any).error.code, 'BUSY');
    f.hold(B, 'copper_trowel');
    let last: any = step;
    while (!last.built) last = f.ok(B, 'settlement.build', { building: 'farm' });
    assert.equal(last.work, BUILDINGS.farm.work);

    const view = f.ok(A, 'settlement.view').settlement;
    assert.deepEqual(view.buildings.map((b: any) => [b.id, b.working]), [['farm', true]]);
    assert.deepEqual(view.projects, []);
    assert.equal(f.no(A, 'settlement.contribute', { building: 'farm' }).code, 'SETTLEMENT_STATE', 'one of each');

    const log = f.ok(A, 'stockpile.log').entries.filter((e: any) => e.action === 'contribute');
    assert.deepEqual(log.map((e: any) => [e.actorId, e.building]), [[B, 'farm'], [A, 'farm']]);

    // The forge hall is tier 2 work.
    f.give(A, bag(BUILDINGS.forge_hall.cost));
    f.ok(A, 'settlement.contribute', { building: 'forge_hall' });
    f.p(A).skills.construction = 0;
    assert.equal(f.no(A, 'settlement.build', { building: 'forge_hall' }).code, 'SKILL_TOO_LOW');
  } finally { f.g.close(); }
});

test('slots: a camp holds three; cancelling frees a slot and puts the materials in the stockpile', () => {
  const f = fake();
  try {
    const { ids: [A, B], s } = settle(f, 2);
    f.give(B, { pine_plank: 10, pine_log: 5, stone: 10 });
    for (const building of ['workshop', 'kitchen', 'huts']) f.ok(B, 'settlement.contribute', { building, items: [{ item: 'pine_plank', qty: 2 }] });
    assert.equal(f.no(B, 'settlement.contribute', { building: 'palisade' }).code, 'SETTLEMENT_STATE', 'no slot left');
    assert.equal(s().projects.palisade, undefined);
    assert.equal(f.no(B, 'settlement.cancelProject', { building: 'kitchen' }).code, 'FORBIDDEN', 'members cannot cancel');
    const { returned } = f.ok(A, 'settlement.cancelProject', { building: 'kitchen' });
    assert.deepEqual(returned, [{ item: 'pine_plank', qty: 2 }]);
    assert.equal(s().stockpile.pine_plank, 2);
    assert.equal(f.ok(A, 'stockpile.log').entries[0].action, 'cancel');
    f.ok(B, 'settlement.contribute', { building: 'palisade' });
  } finally { f.g.close(); }
});

test('levels: buildings and members make a village, then a town', () => {
  const f = fake();
  try {
    const { ids, sid, s, raise } = settle(f, 2);
    raise('workshop', 'farm', 'kitchen');
    assert.equal(s().level, 1, 'three buildings and two members is a camp');
    f.give(ids[0], { pine_log: 1 });
    assert.equal(f.no(ids[0], 'settlement.contribute', { building: 'palisade' }).code, 'SETTLEMENT_STATE', 'a camp has three slots');

    const join = (name: string) => {
      const id = f.g.register(name).playerId;
      f.ok(ids[0], 'settlement.invite', { playerId: id });
      f.ok(id, 'settlement.join', { settlementId: sid });
      return id;
    };
    const third = join('Third');
    assert.equal(s().level, 2);
    raise('palisade', 'watchtower', 'huts');
    assert.equal(s().level, 2, 'six buildings and three members is still a village');
    join('Fourth');
    const fifth = join('Fifth');
    assert.equal(s().level, 3);
    assert.equal(f.ok(fifth, 'settlement.list').settlements[0].level, 3);
    assert.equal(f.ok(fifth, 'settlement.view').settlement.slots.max, SETTLEMENT.levels[2].slots);
    f.ok(fifth, 'settlement.leave');
    assert.equal(s().level, 2, 'a town needs five');
    f.ok(third, 'settlement.leave');
    assert.equal(s().level, 2, 'a village needs three');
  } finally { f.g.close(); }
});

test('upkeep: paid from the stockpile each interval; an unpaid building does nothing until it can pay', () => {
  const f = fake();
  try {
    const { ids: [A], s, raise, stock } = settle(f, 1);
    raise('workshop');
    const upkeep = bag(BUILDINGS.workshop.upkeep);
    stock(upkeep);
    f.pass(SETTLEMENT.upkeepMs - 2000);
    assert.equal(s().stockpile.stone, upkeep.stone, 'nothing is due before the interval ends');
    f.pass(2000);
    assert.equal(s().stockpile.stone, undefined, 'paid');
    const paid = f.ok(A, 'stockpile.log').entries.find((e: any) => e.action === 'upkeep');
    assert.equal(paid.actorId, null);
    assert.deepEqual(bag(paid.items), upkeep);

    f.give(A, { copper_ore: 4 });
    f.hold(A, 'copper_tongs');
    f.ok(A, 'refine', { recipeId: 'copper_bar' });

    // Nothing left for the next interval.
    f.pass(SETTLEMENT.upkeepMs);
    const closed = f.ok(A, 'settlement.view').settlement;
    assert.equal(closed.buildings[0].working, false);
    assert.deepEqual(f.ok(A, 'observe').settlement.buildings, []);
    const refused = f.no(A, 'refine', { recipeId: 'copper_bar' });
    assert.equal(refused.code, 'NO_STATION');
    assert.match(refused.message, /upkeep/);

    f.give(A, upkeep);
    f.ok(A, 'stockpile.deposit', { items: BUILDINGS.workshop.upkeep });
    f.pass(100);
    const open = f.ok(A, 'settlement.view').settlement.buildings[0];
    assert.equal(open.working, true);
    assert.ok(open.upkeepInMs > SETTLEMENT.upkeepMs - 1000, 'a late payment buys a whole interval');
    f.ok(A, 'refine', { recipeId: 'copper_bar' });

    // A long outage is one payment, never one per missed interval.
    stock(Object.fromEntries(Object.entries(upkeep).map(([k, n]) => [k, n * 50])));
    f.pass(SETTLEMENT.upkeepMs * 30);
    assert.equal(s().stockpile.stone, upkeep.stone * 49);
    f.pass(100);
    assert.equal(s().stockpile.stone, upkeep.stone * 49);
  } finally { f.g.close(); }
});

test('income and farm: paid into the stockpile by the active level, logged, and only while buildings work', () => {
  const f = fake();
  try {
    const { ids: [A], s, raise, stock } = settle(f, 3);
    f.pass(SETTLEMENT.upkeepMs * 2);
    assert.equal(s().stockpile.silver, undefined, 'a plot with no buildings earns nothing');

    raise('workshop', 'forge_hall', 'farm');
    const all = sum((['workshop', 'forge_hall', 'farm'] as const).map((b) => bag(BUILDINGS[b].upkeep)));
    stock(all);
    f.pass(SETTLEMENT.upkeepMs);
    assert.equal(s().stockpile.silver, SETTLEMENT.levels[1].income, 'a village');
    assert.equal(s().stockpile.grain, bag(BUILDINGS.farm.produces!).grain);
    assert.deepEqual(new Set(f.ok(A, 'stockpile.log').entries.slice(0, 3).map((e: any) => e.action)), new Set(['upkeep', 'produced', 'income']));

    // Only the farm can pay: the standing buildings still show a village, but it earns like a camp.
    stock(bag(BUILDINGS.farm.upkeep));
    f.pass(SETTLEMENT.upkeepMs);
    assert.equal(s().stockpile.silver, SETTLEMENT.levels[1].income + SETTLEMENT.levels[0].income);
    const view = f.ok(A, 'settlement.view').settlement;
    assert.equal(view.activeLevel, 1);
    assert.equal(view.level, 2, 'the public level does not give upkeep away');

    f.pass(SETTLEMENT.upkeepMs);
    assert.equal(s().stockpile.silver, SETTLEMENT.levels[1].income + SETTLEMENT.levels[0].income, 'all closed: no income');
    assert.equal(operatorState(f.g, 0).economy.created.settlements, SETTLEMENT.levels[1].income + SETTLEMENT.levels[0].income);
  } finally { f.g.close(); }
});

test('storehouse: a limited stockpile, much larger with a storehouse; silver takes no room', () => {
  const f = fake();
  try {
    const { ids: [A], s, raise, stock } = settle(f, 1);
    const cap = SETTLEMENT.stockpileCapacity;
    f.give(A, { stone: cap * 2, silver: 900 });
    f.ok(A, 'stockpile.deposit', { items: [{ item: 'stone', qty: cap }] });
    assert.equal(f.no(A, 'stockpile.deposit', { items: [{ item: 'stone', qty: 1 }] }).code, 'SETTLEMENT_STATE');
    f.ok(A, 'stockpile.deposit', { items: [{ item: 'silver', qty: 900 }] });

    raise('storehouse');
    f.ok(A, 'stockpile.deposit', { items: [{ item: 'stone', qty: 10 }] });
    assert.equal(f.ok(A, 'stockpile.view').capacity, BUILDINGS.storehouse.stockpileCapacity);

    // Closed, it stops taking more, and never holds back what is inside.
    delete s().stockpile.pine_plank;
    f.pass(SETTLEMENT.upkeepMs);
    assert.equal(f.no(A, 'stockpile.deposit', { items: [{ item: 'stone', qty: 1 }] }).code, 'SETTLEMENT_STATE');
    f.ok(A, 'stockpile.withdraw', { items: [{ item: 'stone', qty: 100 }] });

    // A full stockpile gets no harvest.
    s().stockpile = {};
    raise('farm');
    stock({ ...bag(BUILDINGS.farm.upkeep), copper_ore: cap });
    f.pass(SETTLEMENT.upkeepMs);
    assert.equal(s().stockpile.grain, undefined);
  } finally { f.g.close(); }
});

test('stations: members use their buildings at the plot; the forge hall adds item level and repairs without healing', () => {
  const f = fake();
  try {
    const { ids: [A], plot, raise } = settle(f, 1);
    const outsider = f.g.register('Outsider').playerId;
    f.put(outsider, plot);
    for (const id of [A, outsider]) f.give(id, { copper_bar: 12, pine_plank: 4, copper_ore: 2, grain: 3 });
    f.hold(A, 'copper_hammer');
    assert.equal(f.no(A, 'craft', { recipeId: 'copper_sword' }).code, 'NO_STATION', 'no buildings yet');

    raise('workshop', 'forge_hall', 'kitchen');
    f.hold(outsider, 'copper_hammer');
    assert.equal(f.no(outsider, 'craft', { recipeId: 'copper_sword' }).code, 'NO_STATION', 'not a member');

    f.hold(A, 'copper_hammer');
    f.p(A).skills.weaponcraft = 0;
    const home = f.ok(A, 'craft', { recipeId: 'copper_sword' }).items[0];
    f.put(A, f.g.map.places.find((x) => x.id === 'forge')!);
    f.p(A).skills.weaponcraft = 0;
    const town = f.ok(A, 'craft', { recipeId: 'copper_sword' }).items[0];
    assert.equal(home.ilvl, town.ilvl + BUILDINGS.forge_hall.ilvlBonus!);

    f.hold(A, 'copper_pot');
    assert.equal(f.no(A, 'refine', { recipeId: 'ration' }).code, 'NO_STATION', 'town has no kitchen');

    f.put(A, plot);
    f.ok(A, 'equip', { item: home.id });
    f.p(A).wear = { [home.id]: 50 };
    f.p(A).hp = 10;
    f.give(A, { silver: 100 });
    assert.ok(f.ok(A, 'repair').paid > 0);
    assert.equal(f.p(A).hp, 10, 'a repair in PvP land is no heal');
    f.p(outsider).wear = { copper_hammer: 50 };
    assert.equal(f.no(outsider, 'repair').code, 'WRONG_ZONE');
  } finally { f.g.close(); }
});

test('workshop: sometimes extra output, only there', () => {
  const at = (where: 'home' | 'town') => {
    const f = fake();
    try {
      const { ids: [A], raise } = settle(f, 1);
      raise('workshop');
      f.give(A, { copper_ore: 2000 });
      if (where === 'town') f.put(A, f.g.map.places.find((x) => x.id === 'smelter')!);
      f.hold(A, 'copper_tongs');
      let n = 0;
      for (let i = 0; i < 100; i++) n += f.ok(A, 'refine', { recipeId: 'copper_bar', count: 10 }).output.qty;
      return n;
    } finally { f.g.close(); }
  };
  assert.equal(at('town'), 1000);
  const home = at('home');
  assert.ok(Math.abs(home - 1000 * (1 + BUILDING_ODDS.workshopOutput)) < 50, `${home}`);
});

test('shared work: exact extra output on what other members gathered, and never on your own', () => {
  const f = fake();
  const odds = BUILDING_ODDS.workshopOutput;
  BUILDING_ODDS.workshopOutput = 0;
  try {
    const { ids: [A, B, C], sid, s, raise, stock, plot } = settle(f, 3);
    raise('workshop', 'forge_hall', 'farm');
    stock({ stone: 1000, pine_plank: 1000, iron_bar: 100 });
    const pct = SETTLEMENT.sharedWork.outputPct / 100;
    const copper = [...f.g.nodes.values()].find((n) => n.type === 'copper_vein')!;
    const mine = (id: string) => {
      copper.charges = 10;
      f.put(id, copper);
      f.hold(id, 'copper_pickaxe');
      return f.ok(id, 'gather', { nodeId: copper.id }).qty as number;
    };
    const smelt = (id: string, count: number) => {
      f.put(id, plot);
      f.hold(id, 'copper_tongs');
      return f.ok(id, 'refine', { recipeId: 'copper_bar', count });
    };
    const covered = (id: string) => bag(f.ok(id, 'settlement.view').settlement.sharedWork.covered).copper_ore ?? 0;

    let gathered = 0;
    while (gathered < 12) gathered += mine(A);
    assert.equal(covered(A), 0, 'your own work never covers you');
    assert.equal(covered(B), gathered);
    const own = smelt(A, 2);
    assert.equal(own.shared, undefined);
    assert.equal(own.output.qty, 2);

    // Another member, with ore from anywhere: covered as far as A's work goes.
    f.give(B, { copper_ore: 40 });
    const units = Math.floor(gathered / 2);
    const other = smelt(B, 10);
    assert.deepEqual(other.shared, { units: Math.min(10, units), output: Math.floor(Math.min(10, units) * pct) });
    assert.equal(other.output.qty, 10 + other.shared.output);
    assert.equal(covered(B), gathered - 2 * Math.min(10, units), 'used up');

    // Over many one-unit batches the fractions add up to the exact percentage.
    s().work[A] = { cover: { copper_ore: 80 }, carry: {} };
    s().work[B] = { cover: {}, carry: {} };
    f.give(B, { copper_ore: 80 });
    let made = 0;
    for (let i = 0; i < 40; i++) made += smelt(B, 1).output.qty;
    assert.equal(made, 40 + 40 * pct);
    assert.equal(smelt(B, 1).shared, undefined, 'nothing left to cover it');

    // Each raw item covers only itself.
    s().work[A].cover = { pine_log: 100 };
    f.give(B, { copper_ore: 2 });
    assert.equal(smelt(B, 1).shared, undefined);

    // Not in town, and not while the settlement is no village.
    s().work[A].cover = { copper_ore: 100 };
    f.give(B, { copper_ore: 20 });
    f.put(B, f.g.map.places.find((x) => x.id === 'smelter')!);
    f.hold(B, 'copper_tongs');
    assert.equal(f.ok(B, 'refine', { recipeId: 'copper_bar' }).shared, undefined, 'town');
    s().buildings.find((b) => b.id === 'farm')!.unpaid = true;
    assert.equal(smelt(B, 1).shared, undefined, 'two paid buildings are no village');
    delete s().buildings.find((b) => b.id === 'farm')!.unpaid;
    assert.ok(smelt(B, 1).shared);
    f.ok(C, 'settlement.leave');
    assert.equal(smelt(B, 1).shared, undefined, 'two members are no village');

    // Leaving takes your cover along: an exile's work stops helping.
    f.ok(A, 'settlement.invite', { playerId: C });
    f.ok(C, 'settlement.join', { settlementId: sid });
    assert.ok(smelt(B, 1).shared);
    f.ok(A, 'settlement.setRole', { playerId: B, role: 'leader' });
    f.ok(B, 'settlement.expel', { playerId: A });
    assert.equal(covered(B), 0);
    assert.equal(s().work[A], undefined);
    assert.equal(s().members[A], undefined);
  } finally {
    BUILDING_ODDS.workshopOutput = odds;
    f.g.close();
  }
});

test('shared work: skinning covers tanning, cover is capped, and idle members add nothing', () => {
  const f = fake();
  try {
    const { ids: [A, B, C], s, raise } = settle(f, 3);
    raise('workshop', 'forge_hall', 'farm');
    assert.deepEqual(f.ok(A, 'settlement.view').settlement.sharedWork.covered, [], 'nobody has worked');

    const wolf = [...f.g.mobs.values()].find((m) => m.type === 'wolf')!;
    f.put(B, wolf);
    f.give(B, { copper_sword: 1 });
    f.hold(B, 'copper_sword');
    f.hold(B, 'copper_skinning_knife');
    wolf.hp = 1;
    const hides = bag(f.ok(B, 'attack', { targetId: wolf.id }).loot).rough_hide;
    assert.ok(hides > 0);
    assert.deepEqual(f.ok(C, 'settlement.view').settlement.sharedWork.covered, [{ item: 'rough_hide', qty: hides }]);

    const vein = [...f.g.nodes.values()].find((n) => n.type === 'iron_vein')!;
    const max = SETTLEMENT.sharedWork.maxCoverPerItem;
    s().work[B].cover.iron_ore = max;
    f.put(B, vein);
    f.hold(B, 'copper_pickaxe');
    f.ok(B, 'gather', { nodeId: vein.id });
    assert.equal(s().work[B].cover.iron_ore, max);

    const quarry = [...f.g.nodes.values()].find((n) => n.type === 'stone_quarry')!;
    f.put(B, quarry);
    f.ok(B, 'gather', { nodeId: quarry.id });
    assert.equal(s().work[B].cover.stone, undefined, 'only what a workshop refines counts');
  } finally { f.g.close(); }
});

test('farming and food: hoe the field, cook at the kitchen, eat for more XP and faster regeneration until death', () => {
  const f = fake();
  try {
    const { ids: [A], plot, raise } = settle(f, 1);
    const field = [...f.g.nodes.values()].find((n) => n.type === 'fertile_field')!;
    f.put(A, field);
    f.hold(A, 'copper_axe');
    assert.equal(f.no(A, 'gather', { nodeId: field.id }).code, 'TOOL_REQUIRED', 'an axe no longer reaps');
    f.hold(A, 'copper_hoe');
    assert.equal(f.ok(A, 'gather', { nodeId: field.id }).skill, 'farming');

    f.put(A, plot);
    assert.equal(f.no(A, 'eat').code, 'NOT_ENOUGH_ITEMS');
    raise('kitchen');
    f.give(A, { grain: 6 });
    f.hold(A, 'copper_pot');
    const cooked = f.ok(A, 'refine', { recipeId: 'ration', count: 2 });
    assert.equal(cooked.output.item, 'ration');
    assert.equal(RECIPES.ration.skill, 'cooking');

    const copper = [...f.g.nodes.values()].find((n) => n.type === 'copper_vein')!;
    const mineXp = () => { f.put(A, copper); f.hold(A, 'copper_pickaxe'); return f.ok(A, 'gather', { nodeId: copper.id }).xp as number; };
    const hungryXp = mineXp();
    const regen = () => {
      const p = f.p(A);
      p.hp = 10; p.lastCombatAt = 0; p.lastRegenAt = 0;
      f.pass(TIMING.regenIntervalMs);
      return p.hp - 10;
    };
    const hungryRegen = regen();

    const ate = f.ok(A, 'eat');
    assert.equal(ate.wellFedMs, FOOD.wellFedMs);
    assert.ok(f.ok(A, 'observe').self.effects.wellFedMs > 0);
    assert.equal(mineXp(), Math.round(hungryXp * FOOD.xpMult));
    assert.equal(regen(), Math.ceil(f.g.maxHp(f.p(A)) * TIMING.regenFraction * FOOD.regenMult));
    assert.ok(hungryRegen < regen());
    f.p(A).hp = 10; f.p(A).lastCombatAt = f.now();
    f.pass(TIMING.regenIntervalMs);
    assert.equal(f.p(A).hp, 10, 'food never heals in combat');

    f.give(A, { ration: 1 });
    f.pass(1000);
    f.ok(A, 'eat');
    assert.equal(f.ok(A, 'observe').self.effects.wellFedMs <= FOOD.wellFedMs, true, 'no stacking');

    killPlayer(f.g, f.p(A), { kind: 'mob', id: 'm', name: 'Wolf' });
    assert.equal(f.ok(A, 'observe').self.effects.wellFedMs, 0);
  } finally { f.g.close(); }
});

test('stashes: private, limited, and still the owner\'s after leaving or while the huts are closed', () => {
  const f = fake();
  try {
    const { ids: [A, B], plot, sid, s, raise } = settle(f, 2);
    f.give(B, { stone: BUILDINGS.huts.stashCapacity! + 5, silver: 40 });
    assert.equal(f.no(B, 'stash.deposit', { items: [{ item: 'stone', qty: 1 }] }).code, 'SETTLEMENT_STATE', 'no huts');
    raise('huts');
    assert.equal(f.no(B, 'stash.deposit', { items: [{ item: 'stone', qty: BUILDINGS.huts.stashCapacity! + 1 }] }).code, 'SETTLEMENT_STATE');
    f.ok(B, 'stash.deposit', { items: [{ item: 'stone', qty: 9 }, { item: 'silver', qty: 40 }] });
    assert.deepEqual(f.ok(A, 'stash.view').stashes, [], 'not even the leader sees it');
    assert.equal(f.no(A, 'stash.withdraw', { items: [{ item: 'stone', qty: 1 }], settlementId: sid }).code, 'NOT_FOUND');
    assert.equal(s().stockpile.stone, undefined);
    assert.equal(operatorState(f.g, 0).economy.circulation.stashed, 40);

    const id = `copper_sword${UNIQUE_SEP}0000abcd`;
    f.g.uniques.set(id, { id, base: 'copper_sword', ilvl: 10, rarity: 'normal', affixes: [], mods: 0, corrupted: false, craftedBy: 'x', craftedAt: 1 });
    f.give(B, { [id]: 1 });
    f.ok(B, 'stash.deposit', { items: [{ item: id, qty: 1 }] });
    assert.ok(f.ok(B, 'observe').self.uniques.some((u: any) => u.id === id));

    f.pass(SETTLEMENT.upkeepMs);
    assert.equal(f.no(B, 'stash.deposit', { items: [{ item: 'stone', qty: 1 }] }).code, 'SETTLEMENT_STATE', 'closed huts take nothing');
    f.ok(B, 'stash.withdraw', { items: [{ item: 'stone', qty: 4 }] });

    f.ok(A, 'settlement.expel', { playerId: B });
    const mine = f.ok(B, 'stash.view').stashes;
    assert.deepEqual([mine.length, mine[0].member, mine[0].settlementId], [1, false, sid]);
    f.put(B, f.g.map.anchors.town);
    assert.equal(f.no(B, 'stash.withdraw', { items: [{ item: 'stone', qty: 1 }] }).code, 'OUT_OF_RANGE', 'at the plot only');
    f.put(B, plot);
    assert.equal(f.no(B, 'stash.deposit', { items: [{ item: 'stone', qty: 1 }] }).code, 'SETTLEMENT_STATE', 'former members only take out');
    f.ok(B, 'stash.withdraw', { items: [{ item: 'stone', qty: 5 }, { item: 'silver', qty: 40 }, { item: id, qty: 1 }] });
    assert.deepEqual(f.ok(B, 'stash.view').stashes, []);
  } finally { f.g.close(); }
});

test('leaving keeps a stash; abandonment spills stashes, projects and the stockpile and drops the buildings', () => {
  const f = fake();
  try {
    const { ids: [A, B], plot, sid, raise, stock } = settle(f, 2);
    raise('huts');
    f.give(B, { leather: 7, pine_plank: 4 });
    f.ok(B, 'stash.deposit', { items: [{ item: 'leather', qty: 7 }] });
    f.ok(B, 'settlement.contribute', { building: 'kitchen' });
    stock({ stone: 11 });
    f.ok(B, 'settlement.leave');
    assert.equal(f.ok(B, 'stash.view').stashes.length, 1);

    const told: string[] = [];
    f.g.subscribe({ kind: 'player', playerId: B, send: (e) => told.push(e.type) });
    assert.equal(f.ok(A, 'settlement.leave').disbanded, true);
    assert.equal(f.g.settlements.has(sid), false);
    const spill = [...f.g.bags.values()].find((b) => b.ownerId === sid)!;
    assert.deepEqual(spill.items, { stone: 11, leather: 7, pine_plank: 4 });
    assert.ok(told.includes('stash.spilled'));
    assert.deepEqual(f.ok(B, 'stash.view').stashes, []);
    assert.deepEqual(f.ok(A, 'settlement.list').settlements, []);

    f.give(A, bag(SETTLEMENT.foundCost));
    assert.deepEqual(f.ok(A, 'settlement.found', { name: 'Again', plotId: plot.id }).settlement.buildings, [], 'ruins carry nothing over');
  } finally { f.g.close(); }
});

test('palisade and watchtower: who crosses into the region, while they work', () => {
  const f = fake();
  try {
    const { ids: [A, B], plot, raise, stock } = settle(f, 2);
    raise('palisade', 'watchtower');
    stock({ pine_log: 10, pine_plank: 5, stone: 10 });
    const stranger = f.g.register('Stranger').playerId;
    const alerts: string[] = [];
    // The intruder, and an outsider standing in the region, hear nothing of either building.
    const bystander = f.g.register('Bystander').playerId;
    f.put(bystander, plot);
    const overheard: string[] = [];
    for (const id of [stranger, bystander]) f.g.subscribe({ kind: 'player', playerId: id, send: (e) => { if (/^(settlement|stockpile)\./.test(e.type)) overheard.push(e.type); } });
    f.g.subscribe({ kind: 'player', playerId: A, send: (e) => { if (e.type === 'settlement.alert') alerts.push(e.data.playerId); } });

    const edge = (() => {
      const m = f.g.map;
      let best: Pos | undefined;
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
        if (walkable(m, x, y) && regionAt(m, { x, y }) === 'wilds' && (!best || dist({ x, y }, plot) < dist(best, plot))) best = { x, y };
      }
      return best!;
    })();
    const walk = (id: string, to: object) => {
      const { travel } = f.ok(id, 'move', to);
      assert.ok(travel);
      const steps = Math.ceil(travel.arriveInMs / 200) + 2;
      for (let i = 0; i < steps; i++) f.pass(200);
    };
    for (const id of [stranger, B]) f.put(id, edge);
    walk(stranger, { to: plot.id });
    walk(B, { to: plot.id });
    assert.deepEqual(alerts, [stranger], 'members do not set it off');
    assert.deepEqual(f.ok(B, 'settlement.view').settlement.alerts.map((a: any) => a.playerId), [stranger]);

    walk(stranger, { x: edge.x, y: edge.y });
    const log = f.ok(A, 'watchtower.log').entries;
    assert.deepEqual(log.map((e: any) => [e.playerId, e.move]), [[stranger, 'depart'], [B, 'arrive'], [stranger, 'arrive']], 'members are logged too');

    // Unpaid, both go blind. What was recorded stays readable.
    f.g.settlements.get(f.p(A).settlementId!)!.stockpile = {};
    f.pass(SETTLEMENT.upkeepMs);
    walk(stranger, { to: plot.id });
    assert.deepEqual(alerts, [stranger]);
    const after = f.ok(A, 'watchtower.log');
    assert.equal(after.recording, false);
    assert.equal(after.entries.length, 3);
    assert.deepEqual(overheard, []);
  } finally { f.g.close(); }
});

test('saves: existing players get only the new tools, once, and older settlements still load and build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-buildings-'));
  const dbPath = join(dir, 'world.db');
  try {
    let f = fake({ dbPath });
    const { ids: [A, B], sid, plot } = settle(f, 2);
    f.give(A, { stone: 3 });
    f.ok(A, 'stockpile.deposit', { items: [{ item: 'stone', qty: 3 }] });
    const untouched = f.g.register('Banked').playerId;
    f.g.close();

    // Turn the save back into what stage 2 wrote.
    const db = new DatabaseSync(dbPath);
    const added = ['copper_hoe', 'copper_trowel', 'copper_pot'];
    for (const row of db.prepare('SELECT id, data FROM players').all() as { id: string; data: string }[]) {
      const p = JSON.parse(row.data);
      for (const t of added) delete p.inventory[t];
      delete p.kitVersion;
      if (row.id === untouched) { p.bank.copper_hammer = 1; delete p.inventory.copper_hammer; }
      db.prepare('UPDATE players SET data = ? WHERE id = ?').run(JSON.stringify(p), row.id);
    }
    for (const row of db.prepare('SELECT id, data FROM settlements').all() as { id: string; data: string }[]) {
      const s = JSON.parse(row.data);
      for (const k of ['buildings', 'projects', 'stashes', 'work', 'alerts']) delete s[k];
      db.prepare('UPDATE settlements SET data = ? WHERE id = ?').run(JSON.stringify(s), row.id);
    }
    db.exec('ALTER TABLE stockpile_log DROP COLUMN building');
    db.close();

    for (let restart = 0; restart < 2; restart++) {
      f = fake({ dbPath });
      for (const id of [A, B, untouched]) for (const t of added) assert.equal(f.p(id).inventory[t], 1, `${t}, restart ${restart}`);
      assert.equal(f.p(untouched).inventory.copper_hammer, undefined, 'the rest of the kit is not granted again');
      assert.equal(STARTER_KIT.length, 10);
      const s = f.g.settlements.get(sid)!;
      assert.equal(s.stockpile.stone, 3);
      assert.deepEqual([s.buildings, s.level], [[], 1]);
      if (restart === 0) {
        f.put(A, plot);
        f.give(A, { pine_plank: 2 });
        f.ok(A, 'settlement.contribute', { building: 'farm' });
      } else {
        assert.equal(s.projects.farm!.materials.pine_plank, 2);
      }
      f.g.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed write leaves projects, stashes and the stockpile as they were', () => {
  const f = fake({ log: () => {} });
  try {
    const { ids: [A], s, raise } = settle(f, 1);
    raise('huts');
    f.give(A, { pine_plank: 9, stone: 4 });
    f.save(A);
    const before = { inventory: { ...f.p(A).inventory }, settlement: structuredClone(s()) };
    const run = f.g.store.run.bind(f.g.store);
    f.g.store.run = ((sql: string, ...args: any[]) => {
      if (sql.startsWith('UPDATE players') || sql.startsWith('INSERT INTO stockpile_log')) throw new Error('disk full');
      return run(sql, ...args);
    }) as any;
    assert.equal(f.no(A, 'settlement.contribute', { building: 'kitchen' }).code, 'INTERNAL');
    assert.equal(f.no(A, 'stash.deposit', { items: [{ item: 'stone', qty: 4 }] }).code, 'INTERNAL');
    f.g.store.run = run as any;
    assert.deepEqual(f.p(A).inventory, before.inventory);
    assert.deepEqual(s().projects, before.settlement.projects);
    assert.deepEqual(s().stashes, before.settlement.stashes);
  } finally { f.g.close(); }
});

// ---------- bosses ----------

/**
 * One whole boss fight on the real rules. `stand`: attack to the end, with every buff timed as well as a player can.
 * `kite`: also run to the far side of the region below half HP, to rest where regeneration (which food doubles) works.
 */
function bossFight(type: string, build: { sword: string; armor: string; level: number; good?: boolean }, size: number, fed: boolean, tactic: 'stand' | 'kite', lagMs = 0) {
  const f = fake();
  try {
    const boss = [...f.g.mobs.values()].find((m) => m.type === type)!;
    const { map } = f.g;
    let far: Pos = boss.home;
    for (let y = 0; y < map.height; y += 2) for (let x = 0; x < map.width; x += 2) {
      if (walkable(map, x, y) && regionAt(map, { x, y }) === boss.zone && dist({ x, y }, boss.home) > dist(far, boss.home)) far = { x, y };
    }
    const ids = Array.from({ length: size }, (_, i) => f.g.register(`Hunter${i}`).playerId);
    for (const id of ids) {
      const p = f.p(id);
      for (const [k, base] of [build.sword, build.armor].entries()) {
        let item = base;
        if (build.good) {
          // Four affixes in the middle of tier 2, at the item level a forge hall gives.
          item = `${base}${UNIQUE_SEP}${k}${id.slice(2, 10)}`;
          const affixes = Object.values(AFFIXES).filter((a) => a.group === 'combat').map((a) => ({ id: a.id, tier: 2, value: Math.floor((AFFIX_RANGES[a.id][1][0] + AFFIX_RANGES[a.id][1][1]) / 2) }));
          f.g.uniques.set(item, { id: item, base, ilvl: 30 + build.level + BUILDINGS.forge_hall.ilvlBonus!, rarity: 'rare', affixes, mods: 4, corrupted: false, craftedBy: 'test', craftedAt: 1 });
        }
        f.give(id, { [item]: 1 });
        f.ok(id, 'equip', { item });
      }
      p.focus = ['swords'];
      p.skills.swords = 10 * build.level * build.level;
      f.put(id, boss);
      p.hp = f.g.maxHp(p);
      p.busyUntil = 0;
      p.wellFedUntil = fed ? f.now() + FOOD.wellFedMs : 0;
    }
    let n = 0;
    const send = (id: string, command: string, payload: object) => f.g.execute(id, { commandId: `fight${++n}`, type: command, payload }) as any;
    const start = f.now();
    while (f.now() - start < 240_000) {
      let standing = 0;
      for (const id of ids) {
        const p = f.p(id);
        if (p.zone !== boss.zone || p.stats.deaths) continue;
        standing++;
        if (p.busyUntil + lagMs > f.now()) continue;
        const hp = p.hp / f.g.maxHp(p);
        if (tactic === 'kite' && boss.engagedAt !== undefined && hp < 0.5) {
          if (!p.travel) send(id, 'move', dist(p.pos, far) > 2 ? { x: far.x, y: far.y } : { x: boss.home.x, y: boss.home.y });
          continue;
        }
        if (p.travel) continue;
        if (dist(p.pos, boss) > 1.5) { send(id, 'move', { to: boss.id }); continue; }
        const can = itemDef(p.equipment.armor ?? '')?.abilities ?? [];
        const ready = (a: 'evade' | 'brace') => can.includes(a) && (p.cooldowns[a] ?? 0) <= f.now();
        let buff: string | undefined;
        if (boss.engagedAt !== undefined) {
          if (ready('evade') && boss.targetId === id && boss.nextAttackAt - f.now() < 2500) buff = 'evade';
          else if (ready('brace') && p.braceUntil <= f.now()) buff = 'brace';
        }
        const r = buff ? send(id, 'ability.use', { ability: buff }) : send(id, 'attack', { targetId: boss.id });
        if (r.ok && r.result.killed) return true;
      }
      if (!standing) return false;
      f.pass(25);
    }
    return false;
  } finally { f.g.close(); }
}

test('bosses: food and buildings never let a player who is not maxed out kill one alone', () => {
  // The builds test/bosses.test.ts calls not maxed out, up to the strongest. The forge hall's +2 item level only
  // brings affix tiers two crafting levels earlier, so the good affixes stand in for it; the rest is Well fed.
  const notMaxed = [
    { sword: 'copper_sword', armor: 'leather_jerkin', level: 3 },
    { sword: 'copper_sword', armor: 'leather_jerkin', level: 30 },
    { sword: 'iron_sword', armor: 'iron_mail', level: 30 },
    { sword: 'iron_sword', armor: 'bearhide_jerkin', level: 30 },
    { sword: 'duskiron_sword', armor: 'wraithhide_armor', level: 10 },
    { sword: 'duskiron_sword', armor: 'wraithhide_armor', level: 30 },
    { sword: 'duskiron_sword', armor: 'wraithhide_armor', level: 15, good: true },
    { sword: 'duskiron_sword', armor: 'wyrmscale_mail', level: 30 },
  ];
  for (const type of ['elder_bear', 'ash_wyrm']) {
    const maxedOut = { sword: 'duskiron_sword', armor: 'wyrmscale_mail', level: 30, good: true };
    assert.equal(bossFight(type, maxedOut, 1, true, 'stand'), true, `this fight script can win: a maxed player solos the ${type}`);
    for (const build of notMaxed) {
      for (const tactic of ['stand', 'kite'] as const) {
        for (const lag of [0, 100]) {
          assert.equal(bossFight(type, build, 1, true, tactic, lag), false, `${build.sword}/${build.armor} level ${build.level}${build.good ? ' with affixes' : ''} (${tactic}, ${lag} ms lag) soloed the ${type} Well fed`);
        }
      }
    }
  }
});

test('bosses: Well fed changes no fight that enrage decides', () => {
  const iron = { sword: 'iron_sword', armor: 'iron_mail', level: 0 };
  const duskiron = { sword: 'duskiron_sword', armor: 'wraithhide_armor', level: 0 };
  for (const [type, build, size] of [['elder_bear', iron, 2], ['elder_bear', iron, 3], ['ash_wyrm', duskiron, 2], ['ash_wyrm', duskiron, 3]] as const) {
    assert.equal(bossFight(type, build, size, true, 'stand'), bossFight(type, build, size, false, 'stand'), `${size} against the ${type}`);
  }
});

// ---------- over HTTP ----------

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as CommandError).code; } assert.fail('expected the command to fail'); };

test('secrecy: stashes, projects, upkeep, alerts and the watch log reach nobody who is not entitled', async () => {
  const w = await world();
  try {
    const g = w.server.game;
    const names = ['Owner', 'Mate', 'Former', 'Spy', 'Invited'] as const;
    const bots: Awaited<ReturnType<typeof w.bot>>[] = [];
    const ids: string[] = [];
    for (const n of names) { const b = await w.bot(n); bots.push(b); ids.push((await b.whoami()).playerId); }
    const [owner, mate, former, spy, invited] = bots;
    const [O, M, F, S, I] = ids;
    const plot = g.map.plots.find((pl) => pl.region === 'hollow')!;
    const put = (id: string) => Object.assign(g.players.get(id)!, { pos: { x: plot.x, y: plot.y }, zone: plot.region, travel: null, busyUntil: 0 });
    const give = (id: string, items: Record<string, number>) => { g.players.get(id)!.inventory = sum([g.players.get(id)!.inventory, items]); };
    for (const id of ids) put(id);
    give(O, bag(SETTLEMENT.foundCost));
    const { settlement } = await owner.settlementFound('Quiet Hold', plot.id);
    for (const [id, bot] of [[M, mate], [F, former]] as const) { await owner.settlementInvite(id); await bot.settlementJoin(settlement.id); }

    for (const b of ['huts', 'watchtower'] as const) {
      give(O, bag(BUILDINGS[b].cost));
      assert.equal((await owner.buildBuilding(b, { timeoutMs: 30_000 })).built, true, b);
    }
    await former.settlementLeave();
    await owner.settlementInvite(I);
    for (const id of ids) put(id);
    await wait(80);
    const outsiders = [[former, F], [spy, S], [invited, I]] as const;
    for (const [o] of outsiders) o.received.length = 0;

    // The secrets: numbers and ids that appear nowhere else.
    const STASHED = 1873, CONTRIBUTED = 17, ALERTED = 'p_feedfacecafe', WATCHED = 'p_0ddba11c0de5';
    const SECRET_ID = `iron_mail${UNIQUE_SEP}5ec2e7aa`;
    give(O, { stone: STASHED, pine_log: CONTRIBUTED, [SECRET_ID]: 1 });
    await owner.stashDeposit([{ item: 'stone', qty: STASHED }, { item: SECRET_ID, qty: 1 }]);
    await owner.settlementContribute('palisade', [{ item: 'pine_log', qty: CONTRIBUTED }]);
    g.mutate(() => {
      const s = g.settlements.get(settlement.id)!;
      g.markSettlement(s);
      s.alerts.push({ ts: g.now(), playerId: ALERTED, name: 'Alerted' });
      g.store.run('INSERT INTO watch_log(settlement_id, ts, player_id, name, move) VALUES(?, ?, ?, ?, ?)', s.id, g.now(), WATCHED, 'Watched', 'arrive');
      g.emit('settlement.alert', { kind: 'settlement', id: s.id }, { settlementId: s.id, playerId: ALERTED });
      // Upkeep falls due and cannot be paid.
      for (const b of s.buildings) b.paidUntil = g.now() - 1;
    });
    await wait(150);

    const always = [SECRET_ID, ALERTED, WATCHED, '"upkeepInMs"', '"readyToBuild"', '"covered"', '"working":false', 'upkeep is unpaid'];
    const leaks = (what: string, data: unknown) => {
      const text = JSON.stringify(data) ?? '';
      for (const secret of always) assert.ok(!text.includes(secret), `${what} leaks ${secret}`);
      assert.doesNotMatch(text, new RegExp(`(?<![0-9a-f])${STASHED}(?![0-9a-f])`), `${what} leaks the stash`);
      assert.doesNotMatch(text, new RegExp(`"qty":${CONTRIBUTED}(?![0-9])`), `${what} leaks the project`);
    };
    const refused = ['settlement.contribute', 'settlement.build', 'settlement.cancelProject', 'watchtower.log', 'stash.deposit'];
    const payload = {
      settlementId: settlement.id, id: settlement.id, playerId: O, targetId: M, to: M, with: O, name: 'Mirror', plotId: plot.id,
      channel: `settlement:${settlement.id}`, building: 'palisade', recipeId: 'copper_bar', items: [{ item: 'stone', qty: 1 }],
    };
    for (const [bot, id] of outsiders) {
      for (const type of Object.keys(g.commands)) {
        if (type === 'settlement.join' || type === 'settlement.decline') continue;
        const r: any = await bot.request(type as any, payload as any);
        assert.notEqual(r.error?.code, 'RATE_LIMITED', `${type} was not really tried`);
        if (refused.includes(type)) assert.equal(r.error?.code, 'SETTLEMENT_STATE', `${type} must refuse non-members`);
        if (type === 'stash.withdraw') assert.equal(r.error?.code, 'NOT_FOUND');
        if (type === 'stash.view') assert.deepEqual(r.result.stashes, []);
        leaks(`${type} for ${g.players.get(id)!.name}`, r);
        put(id);
      }
    }

    // Another member knows the settlement's business, and still nothing of the owner's stash.
    const matesView = (await mate.settlement()).settlement!;
    assert.deepEqual(matesView.buildings.map((b) => b.working), [false, false]);
    assert.equal(matesView.alerts[0].playerId, ALERTED);
    assert.ok((await mate.watchtowerLog()).entries.some((e) => e.playerId === WATCHED));
    assert.deepEqual((await mate.stash()).stashes, []);
    assert.equal(await code(mate.stashWithdraw([{ item: 'stone', qty: 1 }], settlement.id)), 'NOT_FOUND');
    for (const [type, p] of [['observe', {}], ['settlement.view', {}], ['stockpile.view', {}], ['stockpile.log', {}]] as const) {
      const text = JSON.stringify(await mate.send(type, p));
      assert.ok(!text.includes(SECRET_ID) && !new RegExp(`(?<![0-9a-f])${STASHED}(?![0-9a-f])`).test(text), `${type} shows a member someone's stash`);
    }

    await wait(80);
    for (const [bot, id] of outsiders) {
      const who = g.players.get(id)!.name;
      leaks(`events of ${who}`, bot.received);
      const member = bot.received.filter((e) => /^(settlement\.(project|building|alert)|stockpile\.|stash)/.test(e.type));
      assert.deepEqual(member.map((e) => e.type), [], `${who} got member events`);
    }
    assert.ok(!mate.received.some((e) => JSON.stringify(e).includes(SECRET_ID)), 'stash events reach no member');
    assert.ok(mate.received.some((e) => e.type === 'settlement.building' && e.data.working === false));

    const op = (await w.operator()).events as { type: string; data: any }[];
    assert.ok(op.some((e) => e.type === 'stash' && e.data.items.some((i: any) => i.item === SECRET_ID)), 'the operator sees everything');
    assert.deepEqual(Object.keys((await spy.settlements()).settlements[0]).sort(), ['id', 'level', 'members', 'name', 'zone']);
  } finally { await w.close(); }
});

test('SDK: helpers build, refine and cook at the settlement, and survive a restart', async () => {
  const w = await world();
  let token = '';
  let finished = false;
  try {
    const g = w.server.game;
    const bot = await w.bot('Builder');
    token = bot.botToken;
    const id = (await bot.whoami()).playerId;
    const p = g.players.get(id)!;
    const plot = g.map.plots.find((pl) => pl.region === 'hollow')!;
    Object.assign(p, { pos: { ...g.map.anchors.hollow }, zone: 'hollow' });
    p.inventory = sum([p.inventory, bag(SETTLEMENT.foundCost), bag(BUILDINGS.workshop.cost), bag(BUILDINGS.kitchen.cost), { grain: 3, pine_log: 2 }]);
    await bot.foundSettlement('Builder Hold', 'hollow');
    assert.equal((await bot.buildBuilding('workshop', { timeoutMs: 30_000 })).built, true);
    assert.equal((await bot.buildBuilding('kitchen', { timeoutMs: 30_000 })).built, true);
    assert.deepEqual((await bot.buildBuilding('workshop')), { built: true, needs: [] }, 'already standing');
    const lacking = await bot.buildBuilding('huts');
    assert.equal(lacking.built, false);
    assert.ok(lacking.needs.length > 0);

    // Two members calling buildBuilding at once: whoever is second neither throws nor builds twice.
    const mate = await w.bot('Mate');
    const M = (await mate.whoami()).playerId;
    const sid = (await bot.settlement()).settlement!.id;
    await bot.settlementInvite(M);
    await mate.settlementJoin(sid);
    const m = g.players.get(M)!;
    Object.assign(m, { pos: { ...p.pos }, zone: p.zone });
    const cost = bag(BUILDINGS.watchtower.cost);
    p.inventory = sum([p.inventory, cost]);
    m.inventory = sum([m.inventory, cost]);
    const both = await Promise.all([bot.buildBuilding('watchtower', { timeoutMs: 30_000 }), mate.buildBuilding('watchtower', { timeoutMs: 30_000 })]);
    assert.deepEqual(both.map((r) => r.built), [true, true]);
    await bot.waitReady();
    await bot.goTo(g.map.anchors.hollow);
    assert.ok((await bot.refineItem('pine_plank')).qty >= 1);
    assert.equal((await bot.observe()).self.zone, plot.region, 'refineItem used the workshop, not town');
    assert.ok((await bot.refineItem('ration')).qty >= 1);
    await bot.waitReady();
    assert.ok((await bot.eat()).wellFedMs > 0);
    finished = true;
  } finally { await w.close({ keepDir: finished }); }

  const w2 = await world({ dir: w.dir });
  try {
    const again = attach(w2.url, token);
    const s = (await again.settlement()).settlement!;
    assert.deepEqual(s.buildings.map((b) => b.id), ['workshop', 'kitchen', 'watchtower']);
    assert.ok((await again.observe()).self.effects.wellFedMs > 0);
  } finally { await w2.close(); }
});
