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

// ---------- shared work ----------

const REST = SETTLEMENT.sharedWork.restMs * 1.1;

/** A village of `size` with the buildings paid, and the steps of shared work through the real commands. */
function pooling(f: Fake, size = 3) {
  const v = settle(f, size);
  v.raise('workshop', 'forge_hall', 'farm');
  v.stock({ stone: 1000, pine_plank: 1000, iron_bar: 100 });
  f.g.mutate(() => f.g.markSettlement(v.s()));
  const home = (id: string) => f.put(id, v.plot);
  /** Gathers at least `qty` of copper ore, and returns exactly how much. */
  const mine = (id: string, qty: number) => {
    const vein = [...f.g.nodes.values()].find((n) => n.type === 'copper_vein')!;
    f.put(id, vein);
    f.hold(id, 'copper_pickaxe');
    let got = 0;
    while (got < qty) { vein.charges = 10; got += f.ok(id, 'gather', { nodeId: vein.id }).qty; f.p(id).wear = {}; }
    home(id);
    return got;
  };
  const ore = (qty: number) => ({ items: [{ item: 'copper_ore', qty }] });
  const give = (id: string, qty: number) => {
    home(id);
    return bag(f.ok(id, 'stockpile.deposit', ore(qty)).given).copper_ore ?? 0;
  };
  const take = (id: string, qty: number) => { home(id); return f.ok(id, 'stockpile.withdraw', ore(qty)); };
  const ready = (id: string, item = 'copper_ore') => { home(id); return bag(f.ok(id, 'stockpile.view').sharedWork.ready)[item] ?? 0; };
  const resting = (id: string) => { home(id); return bag(f.ok(id, 'stockpile.view').sharedWork.resting).copper_ore ?? 0; };
  const smelter = (id: string) => { home(id); f.hold(id, 'copper_tongs'); f.p(id).wear = {}; };
  const smelt = (id: string, count = 1) => { smelter(id); return f.ok(id, 'refine', { recipeId: 'copper_bar', count, from: 'stockpile' }); };
  const noSmelt = (id: string, count = 1) => { smelter(id); return f.no(id, 'refine', { recipeId: 'copper_bar', count, from: 'stockpile' }); };
  const ownSmelt = (id: string, count = 1) => { smelter(id); return f.ok(id, 'refine', { recipeId: 'copper_bar', count }); };
  const rest = () => { f.pass(REST); for (const id of v.ids) if (v.s().members[id]) home(id); };
  /** Everybody may withdraw. */
  const trusting = () => f.ok(v.ids[0], 'settlement.setCharter', { withdrawRole: 'member' });
  /** Ore from outside, saved as any real transfer is. */
  const handed = (id: string, qty: number) => { f.give(id, { copper_ore: qty }); f.save(id); };
  return { ...v, home, mine, ore, give, take, ready, resting, smelt, noSmelt, ownSmelt, rest, trusting, handed };
}

test('shared work: what another member gave and left to rest pays the exact percentage, into the stockpile', () => {
  const f = fake();
  const odds = BUILDING_ODDS.workshopOutput;
  BUILDING_ODDS.workshopOutput = 0;
  try {
    const { ids: [A, B], s, mine, give, ready, resting, smelt, noSmelt, rest } = pooling(f);
    const pct = SETTLEMENT.sharedWork.outputPct / 100;
    const qty = mine(A, 80);
    assert.equal(ready(B), 0, 'gathering alone gives nothing');
    assert.equal(resting(B), 0);
    assert.equal(give(A, qty), qty);
    assert.equal(resting(B), qty);
    assert.equal(resting(A), 0, 'not your own');
    const early = noSmelt(B);
    assert.equal(early.code, 'NOT_ENOUGH_ITEMS');
    assert.ok(early.retryAfterMs >= SETTLEMENT.sharedWork.restMs - 1000, 'it says how long the rest takes');

    f.pass(SETTLEMENT.sharedWork.restMs - 5000);
    assert.equal(ready(B), 0, 'not a moment early');
    rest();
    assert.equal(ready(B), qty);
    assert.equal(ready(A), 0);
    assert.equal(noSmelt(A).code, 'NOT_ENOUGH_ITEMS', 'your own work never covers you');

    assert.equal(s().charter.withdrawRole, 'steward');
    assert.equal(s().members[B].role, 'member', 'it needs no right to withdraw');
    const carried = { ...f.p(B).inventory };
    const barsBefore = s().stockpile.copper_bar ?? 0;
    const units = Math.floor(qty / 2);
    let made = 0;
    let left = units;
    // Batches of every size: the fractions add up to the exact percentage.
    for (let count = 1; left; count = count === 1 ? 3 : 1) {
      const n = Math.min(count, left);
      const r = smelt(B, n);
      assert.equal(r.shared.units, n);
      assert.equal(r.output.qty, n + r.shared.output + (r.bonus ?? 0));
      made += r.output.qty - (r.bonus ?? 0);
      left -= n;
    }
    assert.equal(made, Math.floor(units * (1 + pct)));
    assert.equal(s().stockpile.copper_bar - barsBefore, made, 'the group has the output');
    assert.equal(s().stockpile.copper_ore ?? 0, qty - 2 * units, 'and paid the inputs');
    assert.equal(f.p(B).inventory.copper_ore, carried.copper_ore);
    assert.equal(f.p(B).inventory.copper_bar, carried.copper_bar, 'the refiner pockets none of it');
    assert.equal(noSmelt(B).code, 'NOT_ENOUGH_ITEMS', 'used up');
    const log = f.ok(A, 'stockpile.log').entries;
    const logged = (action: string, item: string) => log
      .filter((e: any) => e.action === action && e.actorId === B).flatMap((e: any) => e.items)
      .reduce((n: number, i: ItemStack) => n + (i.item === item ? i.qty : 0), 0);
    assert.equal(logged('refine', 'copper_ore'), 2 * units);
    assert.equal(logged('refined', 'copper_bar'), made);
  } finally {
    BUILDING_ODDS.workshopOutput = odds;
    f.g.close();
  }
});

test('shared work: only a working village workshop pays it, only on request, and the stockpile bounds it', () => {
  const f = fake();
  try {
    const { ids: [A, B, C], sid, s, stock, plot, mine, give, smelt, noSmelt, ownSmelt, rest, handed } = pooling(f);
    const qty = mine(A, 40);
    give(A, qty);
    rest();
    handed(B, 20);
    assert.equal(ownSmelt(B).shared, undefined, 'your inventory never gets it, whatever others gave');
    const refuse = (payload: object, code: string, type = 'refine') => assert.equal(f.no(B, type, payload).code, code);
    refuse({ recipeId: 'copper_bar', from: 'inventory' }, 'BAD_REQUEST');
    refuse({ recipeId: 'copper_sword', from: 'stockpile' }, 'BAD_REQUEST', 'craft');
    refuse({ recipeId: 'ration', from: 'stockpile' }, 'BAD_REQUEST');
    f.put(B, f.g.map.places.find((x) => x.id === 'smelter')!);
    refuse({ recipeId: 'copper_bar', from: 'stockpile' }, 'OUT_OF_RANGE');
    f.put(B, plot);

    const farm = () => s().buildings.find((b) => b.id === 'farm')!;
    farm().unpaid = true;
    assert.equal(noSmelt(B).code, 'SETTLEMENT_STATE', 'two paid buildings are no village');
    delete farm().unpaid;
    s().buildings.find((b) => b.id === 'workshop')!.unpaid = true;
    assert.equal(noSmelt(B).code, 'NO_STATION', 'a closed workshop');
    delete s().buildings.find((b) => b.id === 'workshop')!.unpaid;
    f.ok(C, 'settlement.leave');
    assert.equal(noSmelt(B).code, 'SETTLEMENT_STATE', 'two members are no village');
    f.ok(A, 'settlement.invite', { playerId: C });
    f.ok(C, 'settlement.join', { settlementId: sid });

    // One batch may go over a full stockpile, never a second.
    const held = Object.entries(s().stockpile).reduce((n, [item, q]) => n + (item === 'silver' ? 0 : q), 0);
    stock({ grain: SETTLEMENT.stockpileCapacity - held + 1 });
    assert.equal(noSmelt(B).code, 'SETTLEMENT_STATE', 'no refining into an overfull stockpile');
    s().stockpile.grain -= 100;
    assert.ok(smelt(B).shared);
  } finally { f.g.close(); }
});

test('shared work attack: depositing and taking back, and cycling the same units', () => {
  const f = fake();
  try {
    const { ids: [A, B, C], s, stock, mine, give, take, ready, resting, smelt, rest, trusting } = pooling(f);
    trusting();
    const qty = mine(A, 20);
    assert.equal(give(A, qty), qty);
    take(A, qty);
    assert.equal(resting(B), 0, 'taken back at once');
    assert.equal(give(A, qty), 0, 'the same units a second time');
    rest();
    assert.equal(ready(B), 0);

    // Other ore lying in the stockpile does not keep alive what its giver takes back.
    take(A, qty);
    stock({ copper_ore: 100 });
    const more = mine(A, 20);
    give(A, more);
    take(A, more);
    assert.equal(resting(B), 0);

    // Through a partner's hands.
    s().stockpile.copper_ore = 0;
    const third = mine(A, 20);
    give(A, third);
    take(B, third);
    assert.equal(resting(C), 0, 'taken out by someone else');
    assert.equal(give(B, third), 0, 'and put back by them');
    rest();
    assert.equal(ready(C), 0);

    // Taken out just before it is ready, or after: gone either way.
    const fourth = mine(A, 20);
    give(A, fourth);
    rest();
    assert.equal(ready(C), fourth);
    take(B, third + fourth);
    assert.equal(ready(C), 0, 'withdrawn after the rest');
    assert.equal(give(B, third + fourth), 0);

    // Once used, the inputs a tool saves go back as plain ore.
    s().stockpile.copper_ore = 0;
    const fifth = mine(A, 20);
    give(A, fifth);
    rest();
    const tool = `copper_tongs${UNIQUE_SEP}5a4ed000`;
    f.g.uniques.set(tool, { id: tool, base: 'copper_tongs', ilvl: 60, rarity: 'magic', affixes: [{ id: 'save_inputs', tier: 3, value: 100 }], mods: 1, corrupted: false, craftedBy: 'test', craftedAt: f.now() });
    f.give(B, { [tool]: 1 });
    f.ok(B, 'equip', { item: tool });
    const r = f.ok(B, 'refine', { recipeId: 'copper_bar', count: 5, from: 'stockpile' });
    assert.equal(r.inputsSaved, 5);
    assert.equal(s().stockpile.copper_ore, fifth);
    assert.equal(ready(B), fifth - 10, 'saved units never cover again');
    assert.equal(ready(C), fifth - 10);
    assert.ok(smelt(C).shared);
  } finally { f.g.close(); }
});

test('shared work attack: two members swap while each keeps their own materials', () => {
  const f = fake();
  try {
    const { ids: [A, B, C], mine, give, take, ready, resting, noSmelt, ownSmelt, rest, trusting } = pooling(f);
    trusting();
    // Both gather and keep: the other's work covers nothing.
    mine(A, 20);
    mine(B, 20);
    rest();
    assert.equal(ready(A) + ready(B), 0);
    assert.equal(noSmelt(A).code, 'NOT_ENOUGH_ITEMS');
    assert.equal(noSmelt(B).code, 'NOT_ENOUGH_ITEMS');
    assert.equal(ownSmelt(A, 5).shared, undefined);

    // Both deposit and each takes as much back at once, so each still holds what they gathered.
    const a = mine(A, 20);
    const b = mine(B, 20);
    give(A, a);
    give(B, b);
    take(A, a);
    take(B, b);
    assert.equal(resting(C), 0);

    // Or each takes the other's: the pile is empty again, so nothing was given to the group.
    const n = Math.min(mine(A, 20), mine(B, 20));
    give(A, n);
    take(B, n);
    give(B, n);
    take(A, n);
    assert.equal(resting(C), 0);
    rest();
    assert.equal(ready(A) + ready(B) + ready(C), 0);
    assert.equal(ownSmelt(B, 5).shared, undefined);
  } finally { f.g.close(); }
});

test('shared work attack: idle alts, bought ore and ore handed over by outsiders', () => {
  const f = fake();
  try {
    const { ids: [A, B, C], mine, give, ready, resting, noSmelt, rest, handed, home } = pooling(f);
    assert.deepEqual(f.ok(A, 'stockpile.view').sharedWork, { ready: [], resting: [] }, 'nobody has worked');
    assert.equal(noSmelt(A).code, 'NOT_ENOUGH_ITEMS');
    handed(C, 50);
    assert.equal(give(C, 50), 0, 'an idle member depositing what was handed to them');

    // A real sale: a worker outside the settlement sells what they mined.
    const seller = f.g.register('Seller').playerId;
    const square = f.g.map.anchors.town;
    const sold = mine(seller, 20);
    const trade = (from: string, to: string, qty: number) => {
      f.put(from, square);
      f.put(to, square);
      const { trade: t } = f.ok(from, 'trade.propose', { to, give: [{ item: 'copper_ore', qty }], receive: [] });
      f.ok(to, 'trade.accept', { tradeId: t.id });
      f.ok(from, 'trade.lock', { tradeId: t.id, items: [{ item: 'copper_ore', qty }] });
      f.ok(to, 'trade.lock', { tradeId: t.id, items: [] });
      home(to);
    };
    trade(seller, B, sold);
    assert.equal(give(B, sold), 0, 'bought');

    // A member's work does not travel to an alt, and does not stay with the member who sold it.
    const work = mine(A, 20);
    trade(A, C, work);
    assert.equal(give(C, work), 0, 'handed to an alt');
    handed(A, work);
    assert.equal(give(A, work), 0, 'bought back after selling');

    // Nor can it be spent and then replaced by bought ore.
    const spent = mine(A, 20);
    f.g.mutate(() => { delete f.p(A).inventory.copper_ore; f.g.markPlayer(f.p(A)); });
    handed(A, spent);
    assert.equal(give(A, spent), 0, 'replaced by bought ore');

    // Carrying both, only as much as was gathered counts.
    handed(A, 30);
    const own = mine(A, 10);
    assert.equal(give(A, own + 30), own);
    assert.equal(resting(B), own);
    rest();
    assert.equal(ready(B), own);
  } finally { f.g.close(); }
});

test('shared work attack: what left the inventory, by bank, refining or death, is no longer gathered work', () => {
  const f = fake();
  try {
    const { ids: [A], mine, give, ownSmelt, handed, home } = pooling(f);
    const banked = mine(A, 10);
    f.put(A, f.g.map.places.find((x) => x.id === 'bank')!);
    f.ok(A, 'bank.deposit', { items: [{ item: 'copper_ore', qty: banked }] });
    f.ok(A, 'bank.withdraw', { items: [{ item: 'copper_ore', qty: banked }] });
    assert.equal(give(A, banked), 0, 'banked');

    const refined = mine(A, 10);
    ownSmelt(A, Math.floor(refined / 2));
    handed(A, refined);
    assert.equal(give(A, refined), refined % 2, 'refined');

    const dropped = mine(A, 10);
    f.g.mutate(() => killPlayer(f.g, f.p(A), { kind: 'mob', id: 'wolf', name: 'Wolf' }));
    handed(A, dropped);
    home(A);
    assert.equal(give(A, dropped), 0, 'died, then got as much back');
  } finally { f.g.close(); }
});

test('shared work attack: leaving, rejoining, expulsion and exile', () => {
  const f = fake();
  try {
    const { ids: [A, B, C, D], sid, s, mine, give, ready, resting, rest } = pooling(f, 4);
    const rejoin = (id: string) => {
      f.ok(A, 'settlement.invite', { playerId: id });
      f.ok(id, 'settlement.join', { settlementId: sid });
    };
    const given = mine(B, 20);
    give(B, given);
    const carried = mine(B, 20);
    f.ok(B, 'settlement.leave');
    assert.equal(s().work[B], undefined);
    assert.equal(resting(C), 0, 'what they gave stops counting, though it stays in the stockpile');
    assert.equal(s().stockpile.copper_ore, given);
    const outside = mine(B, 20);
    rejoin(B);
    assert.equal(give(B, carried + outside), 0, 'neither work from before leaving nor work from outside');
    rest();
    assert.equal(ready(C), 0, 'rejoining brings nothing back');
    assert.equal(ready(B), 0, 'and does not make your old ore someone else\'s');

    const fresh = mine(B, 20);
    give(B, fresh);
    rest();
    assert.equal(ready(C), fresh);
    f.ok(A, 'settlement.expel', { playerId: B });
    assert.equal(ready(C), 0, 'expelled');

    const last = mine(D, 20);
    give(D, last);
    rest();
    assert.equal(ready(C), last);
    f.ok(A, 'settlement.vote', { kind: 'exile', targetId: D });
    f.ok(C, 'settlement.vote', { kind: 'exile', targetId: D });
    assert.equal(s().members[D], undefined);
    assert.equal(ready(C), 0, 'exiled');
    assert.equal(s().work[D], undefined);
  } finally { f.g.close(); }
});

test('shared work attack: loot earns and launders no cover', () => {
  const f = fake();
  try {
    const { ids: [A, B, C], s, mine, give, ready, resting, rest } = pooling(f);
    /** What stage 4's theft will do: goods move out of the stockpile, and nothing here tells shared work. */
    const steal = (who: string, qty: number) => f.g.mutate(() => {
      f.g.markSettlement(s());
      f.g.markPlayer(f.p(who));
      s().stockpile.copper_ore -= qty;
      f.p(who).inventory.copper_ore = (f.p(who).inventory.copper_ore ?? 0) + qty;
    });
    const old = mine(A, 20);
    give(A, old);
    rest();
    const young = mine(B, 20);
    give(B, young);
    steal(C, young);
    assert.equal(resting(A), 0, 'the youngest stops counting first');
    assert.equal(ready(C), old);
    assert.equal(give(C, young), 0, 'loot put back');
    assert.equal(resting(A), 0);

    steal(A, young + old);
    assert.equal(ready(C), 0, 'stolen by its own giver');
    assert.equal(give(A, young + old), 0);

    const spy = f.g.register('Thief').playerId;
    steal(spy, young + old);
    f.ok(A, 'settlement.invite', { playerId: spy });
    f.ok(spy, 'settlement.join', { settlementId: s().id });
    assert.equal(give(spy, young + old), 0, 'a thief who joins');
    rest();
    assert.equal(ready(B) + ready(C), 0);

    const own = mine(C, 10);
    steal(C, 30);
    assert.equal(give(C, own + 30), own, 'mixed with loot, only their own work counts');
  } finally { f.g.close(); }
});

test('shared work attack: a rolled-back command changes nothing, and a restart keeps the books', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-shared-'));
  let f = fake({ dbPath: join(dir, 'world.db'), log: () => {} });
  try {
    const { ids: [A, B], sid, s, plot, mine, give, rest, trusting } = pooling(f);
    trusting();
    f.save(A);
    f.save(B);
    /** Runs a command whose commit fails after the command and the sync both changed things. */
    const failing = (id: string, type: string, payload: object) => {
      f.save(id);
      const before = { work: structuredClone(s().work), stockpile: { ...s().stockpile }, inventory: { ...f.p(id).inventory } };
      const run = f.g.store.run.bind(f.g.store);
      f.g.store.run = ((sql: string, ...args: any[]) => {
        if (sql.startsWith('INSERT INTO settlements')) throw new Error('disk full');
        return run(sql, ...args);
      }) as typeof f.g.store.run;
      try {
        assert.equal(f.run(id, type, payload).error.code, 'INTERNAL');
      } finally { f.g.store.run = run; }
      assert.deepEqual({ work: s().work, stockpile: { ...s().stockpile }, inventory: { ...f.p(id).inventory } }, before, type);
    };
    const qty = mine(A, 20);
    const vein = [...f.g.nodes.values()].find((n) => n.type === 'copper_vein')!;
    vein.charges = 10;
    f.put(A, vein);
    failing(A, 'gather', { nodeId: vein.id });
    f.put(A, plot);
    failing(A, 'stockpile.deposit', { items: [{ item: 'copper_ore', qty }] });
    assert.equal(give(A, qty), qty, 'still theirs to give');
    failing(A, 'stockpile.withdraw', { items: [{ item: 'copper_ore', qty }] });
    rest();
    f.put(B, plot);
    f.hold(B, 'copper_tongs');
    failing(B, 'refine', { recipeId: 'copper_bar', count: 3, from: 'stockpile' });

    f.g.mutate(() => f.g.markSettlement(s()));
    const work = structuredClone(s().work);
    const clock = f.now();
    f.g.close();
    f = fake({ dbPath: join(dir, 'world.db') });
    f.pass(clock - f.now());
    assert.deepEqual(f.g.settlements.get(sid)!.work, work);
    f.put(B, plot);
    f.hold(B, 'copper_tongs');
    assert.ok(f.ok(B, 'refine', { recipeId: 'copper_bar', count: 3, from: 'stockpile' }).shared);
  } finally {
    f.g.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared work: saves from the gather-time rule load, keep their carry and lose the unearned cover', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-shared-'));
  const dbPath = join(dir, 'world.db');
  let f = fake({ dbPath });
  try {
    const { ids: [A, B], sid, s, plot, stock } = pooling(f);
    stock({ copper_ore: 100 });
    f.g.mutate(() => f.g.markSettlement(s()));
    // Written as 8dd6ee7 saved it.
    f.g.store.run('UPDATE settlements SET data = ? WHERE id = ?', JSON.stringify({
      ...s(),
      work: { [A]: { cover: { copper_ore: 80, rough_hide: 4 }, carry: { copper_bar: 0.75 } }, [B]: { cover: {}, carry: {} } },
    }), sid);
    f.give(A, { copper_ore: 80 });
    f.save(A);
    f.g.close();
    f = fake({ dbPath });
    const loaded = f.g.settlements.get(sid)!;
    assert.deepEqual(loaded.work, { [A]: { gathered: {}, given: {}, carry: { copper_bar: 0.75 } }, [B]: { gathered: {}, given: {}, carry: {} } });
    assert.equal(loaded.stockpile.copper_ore, 100);
    f.put(A, plot);
    f.put(B, plot);
    assert.deepEqual(f.ok(B, 'stockpile.view').sharedWork, { ready: [], resting: [] });
    f.hold(B, 'copper_tongs');
    assert.equal(f.no(B, 'refine', { recipeId: 'copper_bar', from: 'stockpile' }).code, 'NOT_ENOUGH_ITEMS');
    assert.deepEqual(f.ok(A, 'stockpile.deposit', { items: [{ item: 'copper_ore', qty: 80 }] }).given, []);
  } finally {
    f.g.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared work: skinning counts, stone does not, and the lots stay few', () => {
  const f = fake();
  try {
    const { ids: [A, B], s, plot, rest, ready, handed } = pooling(f);
    const wolf = [...f.g.mobs.values()].find((m) => m.type === 'wolf')!;
    f.put(B, wolf);
    f.give(B, { copper_sword: 1 });
    f.hold(B, 'copper_sword');
    f.hold(B, 'copper_skinning_knife');
    wolf.hp = 1;
    const hides = bag(f.ok(B, 'attack', { targetId: wolf.id }).loot).rough_hide;
    assert.ok(hides > 0);
    f.put(B, plot);
    assert.deepEqual(f.ok(B, 'stockpile.deposit', { items: [{ item: 'rough_hide', qty: hides }] }).given, [{ item: 'rough_hide', qty: hides }]);
    rest();
    assert.equal(ready(A, 'rough_hide'), hides);

    const quarry = [...f.g.nodes.values()].find((n) => n.type === 'stone_quarry')!;
    f.put(B, quarry);
    f.hold(B, 'copper_pickaxe');
    const stone = f.ok(B, 'gather', { nodeId: quarry.id }).qty;
    f.put(B, plot);
    assert.deepEqual(f.ok(B, 'stockpile.deposit', { items: [{ item: 'stone', qty: stone }] }).given, []);

    // A deposit every two seconds for half an hour.
    handed(A, 900);
    for (let i = 0; i < 900; i++) {
      s().work[A] ??= { gathered: {}, given: {}, carry: {} };
      s().work[A].gathered.copper_ore = { qty: 1, had: f.p(A).inventory.copper_ore };
      f.ok(A, 'stockpile.deposit', { items: [{ item: 'copper_ore', qty: 1 }] });
      f.pass(2000);
      f.put(A, plot);
    }
    const lots = s().work[A].given.copper_ore;
    assert.ok(lots.length <= 63, `${lots.length} lots`);
    assert.equal(lots.reduce((n, l) => n + l.qty, 0), 900);
  } finally { f.g.close(); }
});

test('shared work: random play never covers more than was gathered, more than the stockpile holds, or too early', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const f = fake({ seed });
    try {
      const { ids, s, mine, give, take, smelt, ready, trusting, handed, home } = pooling(f, 4);
      trusting();
      let z = seed * 7919;
      const rnd = () => { z = (z * 1664525 + 1013904223) % 4294967296; return z / 4294967296; };
      const gatheredAt: [number, number][] = [];
      let used = 0;
      for (let step = 0; step < 300; step++) {
        const id = ids[Math.floor(rnd() * ids.length)];
        Object.assign(s().stockpile, { stone: 1000, pine_plank: 1000, iron_bar: 100 });
        home(id);
        const have = f.p(id).inventory.copper_ore ?? 0;
        const held = s().stockpile.copper_ore ?? 0;
        const x = rnd();
        if (x < 0.2) gatheredAt.push([f.now(), mine(id, 5)]);
        else if (x < 0.26) handed(id, 10);
        else if (x < 0.48 && have) give(id, 1 + Math.floor(rnd() * have));
        else if (x < 0.56 && held) take(id, 1 + Math.floor(rnd() * held));
        else if (x < 0.8) {
          const count = Math.min(10, Math.floor(ready(id) / 2));
          if (count) { used += 2 * smelt(id, count).shared.units; }
        } else f.pass(rnd() * SETTLEMENT.sharedWork.restMs * 0.5);
        const old = gatheredAt.reduce((n, [at, q]) => n + (at <= f.now() - SETTLEMENT.sharedWork.restMs ? q : 0), 0);
        assert.ok(used <= old, `seed ${seed}, step ${step}: ${used} covered, only ${old} gathered long enough ago`);
        const lots = Object.values(s().work).flatMap((w) => w.given.copper_ore ?? []).reduce((n, l) => n + l.qty, 0);
        assert.ok(lots <= (s().stockpile.copper_ore ?? 0), `seed ${seed}, step ${step}: more cover than ore`);
      }
      assert.ok(used > 0, `seed ${seed}: never refined`);
    } finally { f.g.close(); }
  }
});

test('secrecy: shared work shows only to members, and the pile only at the plot', () => {
  const f = fake();
  try {
    const { ids: [A, B, C], sid, plot, mine, give, smelt, rest, home, handed, ownSmelt } = pooling(f);
    const spy = f.g.register('Spy').playerId;
    const former = f.g.register('Former').playerId;
    f.ok(A, 'settlement.invite', { playerId: former });
    f.ok(former, 'settlement.join', { settlementId: sid });
    f.ok(former, 'settlement.leave');
    const outsiders = [spy, former];
    const seen = new Map<string, any[]>(outsiders.map((id) => [id, []]));
    for (const id of outsiders) { f.put(id, plot); f.g.subscribe({ kind: 'player', playerId: id, send: (e: any) => seen.get(id)!.push(e) } as any); }
    const mate: any[] = [];
    f.g.subscribe({ kind: 'player', playerId: C, send: (e: any) => mate.push(e) } as any);

    give(A, mine(A, 30));
    rest();
    const later = mine(B, 20);
    give(B, later);
    for (const id of outsiders) f.put(id, plot);
    smelt(C, 2);

    const keys = ['"ready"', '"resting"', '"nextReadyInMs"', '"given"', '"gathered"', '"readyAt"', '"refined"', '"outputPct":125,"covered"', '"action":"refine"'];
    const leaks = (what: string, data: unknown) => { for (const k of keys) assert.ok(!(JSON.stringify(data) ?? '').includes(k), `${what} leaks ${k}`); };
    for (const id of outsiders) {
      for (const type of Object.keys(f.g.commands)) {
        if (type === 'settlement.join' || type === 'settlement.decline') continue;
        f.put(id, plot);
        f.pass(1000);
        f.put(id, plot);
        leaks(type, f.run(id, type, { settlementId: sid, id: sid, playerId: A, to: A, recipeId: 'copper_bar', from: 'stockpile', items: [{ item: 'copper_ore', qty: 1 }], plotId: plot.id }));
      }
      f.put(id, plot);
      f.pass(1000);
      f.put(id, plot);
      assert.equal(f.no(id, 'refine', { recipeId: 'copper_bar', from: 'stockpile' }).code, 'SETTLEMENT_STATE', 'refused before the stockpile is looked at');
      leaks(`events of ${id}`, seen.get(id));
      assert.ok(!seen.get(id)!.some((e) => e.type.startsWith('stockpile.')));
    }
    assert.ok(mate.some((e) => e.type === 'stockpile.changed' && e.data.entry.action === 'refined'));

    // A bystander sees the same refine event whether the materials were the group's or the refiner's own.
    seen.get(spy)!.length = 0;
    f.put(spy, plot);
    smelt(C);
    handed(C, 2);
    ownSmelt(C);
    const refines = seen.get(spy)!.filter((e) => e.type === 'refine');
    assert.equal(refines.length, 2);
    assert.deepEqual(Object.keys(refines[0].data).sort(), Object.keys(refines[1].data).sort());

    // A member away from the plot learns nothing of what lies in the pile.
    f.put(C, f.g.map.anchors.town);
    assert.deepEqual(f.ok(C, 'settlement.view').settlement.sharedWork, { active: true, outputPct: SETTLEMENT.sharedWork.outputPct });
    leaks('observe away from the plot', f.ok(C, 'observe'));
    assert.equal(f.no(C, 'stockpile.view').code, 'OUT_OF_RANGE');
    const away = f.no(C, 'refine', { recipeId: 'copper_bar', count: 10, from: 'stockpile' });
    assert.equal(away.code, 'OUT_OF_RANGE');
    assert.doesNotMatch(JSON.stringify(away), /resting|ready/, 'no counts from afar');
    home(C);
    assert.ok(f.ok(C, 'stockpile.view').sharedWork.ready.length);
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

    const always = [SECRET_ID, ALERTED, WATCHED, '"upkeepInMs"', '"readyToBuild"', '"resting"', '"nextReadyInMs"', '"working":false', 'upkeep is unpaid'];
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

test('SDK: give to the stockpile, see it rest, refine it from there', async () => {
  const w = await world();
  try {
    const g = w.server.game;
    const bots = [await w.bot('Giver'), await w.bot('Smelter'), await w.bot('Third')];
    const ids = await Promise.all(bots.map(async (b) => (await b.whoami()).playerId));
    const plot = g.map.plots.find((pl) => pl.region === 'hollow')!;
    const vein = [...g.nodes.values()].find((n) => n.type === 'copper_vein')!;
    const put = (id: string, at: Pos) => Object.assign(g.players.get(id)!, { pos: { x: at.x, y: at.y }, zone: regionAt(g.map, at), travel: null, busyUntil: 0 });
    for (const id of ids) put(id, plot);
    g.players.get(ids[0])!.inventory = sum([g.players.get(ids[0])!.inventory, bag(SETTLEMENT.foundCost)]);
    const { settlement } = await bots[0].settlementFound('Shared Hold', plot.id);
    for (const i of [1, 2]) { await bots[0].settlementInvite(ids[i]); await bots[i].settlementJoin(settlement.id); }
    g.mutate(() => {
      const s = g.settlements.get(settlement.id)!;
      g.markSettlement(s);
      for (const id of ['workshop', 'forge_hall', 'farm'] as const) s.buildings.push({ id, builtAt: g.now(), paidUntil: g.now() + 3600_000 });
    });
    await bots[0].equip('copper_pickaxe');
    put(ids[0], vein);
    let qty = 0;
    while (qty < 2) { qty += (await bots[0].sendWhenReady('gather', { nodeId: vein.id })).qty; }
    put(ids[0], plot);
    assert.deepEqual((await bots[0].stockpileDeposit([{ item: 'copper_ore', qty }])).given, [{ item: 'copper_ore', qty }]);
    put(ids[1], plot);
    const resting = (await bots[1].stockpile()).sharedWork;
    assert.deepEqual([resting.ready, resting.resting], [[], [{ item: 'copper_ore', qty }]]);
    assert.ok(resting.nextReadyInMs! > 0);
    assert.equal(await code(bots[1].refineFromStockpile('copper_bar')), 'NOT_ENOUGH_ITEMS');
    g.mutate(() => {
      const s = g.settlements.get(settlement.id)!;
      g.markSettlement(s);
      for (const lot of s.work[ids[0]].given.copper_ore) lot.readyAt = g.now();
    });
    await bots[1].equip('copper_tongs');
    assert.equal((await bots[1].refineFromStockpile('copper_bar')).shared!.units, 1);
    assert.ok((await bots[1].stockpile()).items.some((i) => i.item === 'copper_bar'));
    assert.equal(await bots[1].count('copper_bar'), 0);
  } finally { await w.close(); }
});
