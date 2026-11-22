import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, FOCUS, MAX_SKILL_LEVEL, SETTLEMENT, WEAR, levelFor } from '../src/shared/catalog.ts';
import type { Player } from '../src/server/types.ts';
import { world } from './helpers.ts';
import { BUILDS, VALUES, bossIncomePerHour, simulate, type BuildId, type Keep, type Side, type ValueId } from './village-sim.ts';
import { MAPS, strategiesFor } from './village-strategies.ts';

/** Server-side player state, for test setup only. */
function raw(w: Awaited<ReturnType<typeof world>>, id: string): Player {
  return w.server.game.players.get(id)!;
}

test('skill levels cap at 99; combat XP is a fraction of damage; the damage bonus stops at level 30', async () => {
  assert.equal(levelFor(1e12), MAX_SKILL_LEVEL);
  const w = await world();
  try {
    const c = await w.bot('Veteran');
    const me = await c.whoami();
    const p = raw(w, me.playerId);
    p.inventory.copper_sword = 1;
    p.skills.swords = 10_000_000; // far past level 30
    p.focus = ['swords']; // unfocused skills count only FOCUS.unfocusedLevelCap levels
    await c.equip('copper_sword');
    await c.travelTo('wilds');
    const wolf = await c.approachMob('wolf');
    const hit = await c.attack(wolf.id, 'slash');
    const expected = Math.round(8 * (1 + COMBAT.damageBonusPerLevel * COMBAT.damageBonusMaxLevel));
    assert.equal(hit.damage, expected);
    assert.equal(hit.xp, Math.round(Math.max(1, Math.round(expected * COMBAT.xpPerDamage)) * FOCUS.xpMult), 'focused skills earn FOCUS.xpMult× XP');
  } finally { await w.close(); }
});

test('gear wears out, breaks at half strength, and repair in town costs silver', async () => {
  const w = await world();
  try {
    const c = await w.bot('Smith');
    const me = await c.whoami();
    const p = raw(w, me.playerId);
    p.inventory.copper_sword = 1;
    await c.equip('copper_sword');
    p.wear = { copper_sword: WEAR.max - WEAR.perAttack };
    await c.travelTo('wilds');
    const wolf = await c.approachMob('wolf');
    const first = await c.attack(wolf.id, 'slash');
    assert.equal(first.weaponWear, WEAR.max);
    assert.equal(first.damage, 8, 'the attack that breaks the weapon still lands at full power');
    await c.waitForEvent((e) => e.type === 'self.gearBroken', 5_000);
    await c.waitReady();
    const second = await c.sendWhenReady('attack', { targetId: wolf.id, ability: 'slash' });
    assert.equal(second.damage, 4, 'broken weapon hits at half power');
    let obs = await c.observe();
    assert.deepEqual(obs.self.gear.weapon, { item: 'copper_sword', wear: WEAR.max, broken: true, repairCost: 10 });

    const away = await c.request('repair', {});
    assert.equal(!away.ok && away.error.code, 'WRONG_ZONE');
    await c.fight(wolf.id);
    await c.travelTo('town');
    p.inventory.silver = 5;
    const poor = await c.request('repair', { slot: 'weapon' });
    assert.equal(!poor.ok && poor.error.code, 'NOT_ENOUGH_ITEMS');
    assert.ok(!poor.ok && poor.error.hint?.includes('bank'));
    p.inventory.silver = 25;
    const fixed = await c.repair();
    assert.equal(fixed.paid, 10);
    assert.equal(await c.count('silver'), 15);
    obs = await c.observe();
    assert.deepEqual(obs.self.gear.weapon, { item: 'copper_sword', wear: 0, broken: false, repairCost: 0 });
    const nothing = await c.request('repair', {});
    assert.equal(!nothing.ok && nothing.error.code, 'BAD_REQUEST');
  } finally { await w.close(); }
});

test('the town shop sells fixed-price tools for carried silver', async () => {
  const w = await world();
  try {
    const c = await w.bot('Shopper');
    const p = raw(w, (await c.whoami()).playerId);
    const list = await c.shop();
    assert.ok(list.items.some((i) => i.item === 'copper_pickaxe' && i.price === 60));
    const poor = await c.request('shop.buy', { item: 'copper_pickaxe' });
    assert.equal(!poor.ok && poor.error.code, 'NOT_ENOUGH_ITEMS');
    p.inventory.silver = 100;
    const res = await c.buy('copper_pickaxe');
    assert.equal(res.paid, 60);
    assert.equal(await c.count('copper_pickaxe'), 2, 'the starter kit pickaxe plus the bought one');
    assert.equal(await c.count('silver'), 40);
    const nope = await c.request('shop.buy', { item: 'duskiron_sword' });
    assert.equal(!nope.ok && nope.error.code, 'NOT_FOUND');
    assert.ok(!nope.ok && nope.error.hint?.includes('copper_pickaxe'));
  } finally { await w.close(); }
});

test('errors carry hints, and repeating the same failure is flagged', async () => {
  const w = await world();
  try {
    const c = await w.bot('Stubborn');
    delete raw(w, (await c.whoami()).playerId).inventory.copper_pickaxe;
    await c.travelTo('wilds');
    const iron = (await c.nearestNode('iron_ore'))!;
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await c.request('gather', { nodeId: iron.id }));
    const errs = results.map((r) => (!r.ok ? r.error : null));
    assert.equal(errs[0]?.code, 'TOOL_REQUIRED');
    assert.ok(errs[0]?.hint?.includes('copper_pickaxe'));
    assert.ok(errs[0]?.hint?.includes('shop.buy'));
    assert.equal(errs[0]?.repeated, undefined);
    assert.equal(errs[2]?.repeated, 3);
    assert.match(errs[2]!.hint!, /3 times in a row/);

    await c.travelTo('town');
    await c.acceptQuest('wolf_cull');
    const early = await c.request('quest.claim', { questId: 'wolf_cull' });
    assert.ok(!early.ok && early.error.hint?.includes('progress 0/3'));

    const long = await c.request('chat.say', { text: 'x'.repeat(620) });
    assert.ok(!long.ok && long.error.message.includes('got 620'));
    assert.ok(!long.ok && long.error.hint?.includes('120'));
  } finally { await w.close(); }
});

test('prune drops old high-volume events and failures but keeps trade history', async () => {
  const w = await world();
  try {
    const g = w.server.game;
    const old = g.now() - 2 * 24 * 3600_000;
    const veryOld = g.now() - 8 * 24 * 3600_000;
    g.store.run('INSERT INTO events(id, ts, type, data) VALUES(?, ?, ?, ?)', 9_000_001, old, 'combat.hit', '{}');
    g.store.run('INSERT INTO events(id, ts, type, data) VALUES(?, ?, ?, ?)', 9_000_002, old, 'trade.closed', '{}');
    g.store.run('INSERT INTO failures(ts, player_id, command_id, type, code, reason) VALUES(?, ?, ?, ?, ?, ?)', veryOld, 'p_x', null, 'gather', 'BUSY', 'x');
    g.prune();
    const ids = g.store.all<{ id: number }>('SELECT id FROM events WHERE id >= 9000000').map((r) => r.id);
    assert.deepEqual(ids, [9_000_002]);
    assert.equal(g.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM failures WHERE player_id = 'p_x'")!.n, 0);
  } finally { await w.close(); }
});

// ---------- group versus solo (community plan, stage 3) ----------
//
// Played, not computed: village-sim.ts runs four scripted players through the real commands on a fake clock and counts
// what they hold. A run is 30 game minutes. The first 14 count as played, because materials given to the group rest
// before they pay. The rate of the last 16 stands for the remainder of two hours. Upkeep, founding and building (paid
// off over those two hours), walking, repairs and deaths all come out of it. The silver value of every item is in
// VALUES there. The target must hold under all three valuations (items at cost, at what quests pay, at half of shop
// prices), for newcomers, veterans and perfectly geared players, on three maps. Each side plays the best strategy a
// long offline search found for exactly that case (village-strategies.ts). A solo player's best includes founding
// alone with every building and the income, recruiting two idle accounts to count as a village, and soloing every
// boss respawn for free.
//
// The negative side matters as much: a village whose members keep their own materials is searched as hard as the
// others and must stay under the target. Without it these tests would pass a shared work rule that needs no sharing.

const VALUE_IDS = Object.keys(VALUES) as ValueId[];
const BUILD_IDS = Object.keys(BUILDS) as BuildId[];
const KEEPS: Keep[] = ['own', 'cycle', 'swap'];
const TARGET = { ratio: 1.5, exileLoss: 0.3, stockpileHours: [2, 4] };
const RUN = { minutes: 30, warmMinutes: 14, seed: 21 };

function play(side: Exclude<Side, 'freeRider'>, values: ValueId, build: BuildId, map: number) {
  return simulate({ side, strategy: strategiesFor(values, build, map)[side], values, build, map, ...RUN });
}

/** Maxed players may solo bosses, so they get all of that income. Anyone else gets a quarter of it, as if four shared. */
function bossBonus(values: ValueId, build: BuildId): number {
  return bossIncomePerHour(values) / (build === 'maxed' ? 1 : 4);
}

const soloBests = new Map<string, number>();
function bestSolo(values: ValueId, build: BuildId, map: number): number {
  const key = `${values} ${build} ${map}`;
  if (!soloBests.has(key)) {
    const runs = (['solo', 'founders', 'altFounders'] as const).map((side) => play(side, values, build, map));
    for (const r of runs) assert.equal(r.shared, 0, `${key}: alone, with idle accounts or without, nothing is shared work`);
    soloBests.set(key, Math.max(...runs.map((r) => r.perHour)) + bossBonus(values, build));
  }
  return soloBests.get(key)!;
}

for (const build of BUILD_IDS) {
  test(`economy: a pooling village of four ${build} players beats their best solo play 1.5x, and exile costs at least 30%`, () => {
    for (const values of VALUE_IDS) {
      for (const map of MAPS) {
        const at = `${values} values, ${build}, map ${map}`;
        const village = play('village', values, build, map);
        assert.equal(village.lapsed, false, `${at}: the village kept its upkeep paid`);
        const ratio = village.perHour / bestSolo(values, build, map);
        assert.ok(ratio >= TARGET.ratio, `${at}: village ${Math.round(village.perHour)}/member-hour is only ${ratio.toFixed(2)}x the best solo play`);

        // The exile's world has the three who stayed in it, playing their own best. The exile plays theirs.
        const exiled = play('exile', values, build, map).each[3] + (build === 'maxed' ? bossBonus(values, build) : 0);
        const loss = 1 - exiled / village.perHour;
        assert.ok(loss >= TARGET.exileLoss, `${at}: exile costs only ${Math.round(loss * 100)}%`);
      }
    }
  });

  test(`economy: a village of four ${build} players who each keep their own materials misses the target`, () => {
    for (const values of VALUE_IDS) {
      for (const map of MAPS) {
        const at = `${values} values, ${build}, map ${map}`;
        const separate = play('separate', values, build, map);
        const ratio = separate.perHour / bestSolo(values, build, map);
        assert.ok(ratio < TARGET.ratio, `${at}: keeping their own pays ${ratio.toFixed(2)}x the best solo play`);
        assert.equal(separate.shared, 0, `${at}: shared work without sharing`);
      }
    }
    // Every trick, also where the search preferred another.
    const strategy = strategiesFor('cost', build, MAPS[0]).separate;
    for (const keep of KEEPS) {
      const r = simulate({ side: 'separate', strategy: { ...strategy, keep }, values: 'cost', build, map: MAPS[0], ...RUN });
      assert.equal(r.shared, 0, `${build}, ${keep}: shared work without sharing`);
      assert.ok(r.perHour / bestSolo('cost', build, MAPS[0]) < TARGET.ratio, `${build}, ${keep}: reaches the target`);
    }
  });
}

test('economy: without shared work the village misses the target, so the target rests on that rule', () => {
  const pct = SETTLEMENT.sharedWork.outputPct;
  try {
    for (const build of BUILD_IDS) {
      const solo = bestSolo('cost', build, MAPS[0]);
      SETTLEMENT.sharedWork.outputPct = 0;
      const ratio = play('village', 'cost', build, MAPS[0]).perHour / solo;
      SETTLEMENT.sharedWork.outputPct = pct;
      assert.ok(ratio < TARGET.ratio, `${build}: ${ratio.toFixed(2)}x without shared work`);
    }
  } finally { SETTLEMENT.sharedWork.outputPct = pct; }
});

test('economy: a working village\'s stockpile settles at 2-4 member-hours of its output', () => {
  // The village pools what it refines and shares out only what no longer fits, for 200 minutes. At cost and at quest
  // pay. (At half shop prices crafted gear outweighs the materials, and the same stockpile is worth fewer hours.)
  for (const values of ['cost', 'quest'] as const) {
    for (const build of BUILD_IDS) {
      const map = MAPS[0];
      const r = simulate({ side: 'village', strategy: strategiesFor(values, build, map).stock, values, build, minutes: 200, stockpileFromMinute: 160, map, seed: 21 });
      const hours = r.stockpile / r.perHour;
      assert.ok(hours >= TARGET.stockpileHours[0] && hours <= TARGET.stockpileHours[1], `${values} values, ${build}: the stockpile holds ${hours.toFixed(2)} member-hours`);
    }
  }
});
