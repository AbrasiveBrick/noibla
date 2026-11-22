import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, FOCUS, MAX_SKILL_LEVEL, WEAR, levelFor } from '../src/shared/catalog.ts';
import type { Player } from '../src/server/types.ts';
import { world } from './helpers.ts';
import { BUILDS, bossIncomePerHour, simulate, type BuildId, type Keep, type Side, type Strategy, type ValueId } from './village-sim.ts';
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
// A smoke check, not a proof. village-sim.ts plays three cases (items at cost, one map, each build) through the real
// rules: 30 game minutes, where the first 14 count as played and the rest stands for the remainder of two hours,
// because materials given to the group rest before they pay. The strategies were not searched under this rule.
// Whether a village really reaches the target is for runs with real agents to show: docs/COMMUNITY_PLAN.md has the
// theory. What this does guard: pooling pays, and keeping your own materials gets no shared work at all.

const BUILD_IDS = Object.keys(BUILDS) as BuildId[];
const KEEPS: Keep[] = ['own', 'cycle', 'swap'];
const TARGET = { ratio: 1.5, exileLoss: 0.3 };
const VALUE: ValueId = 'cost';
const MAP = MAPS[0];
const RUN = { values: VALUE, map: MAP, minutes: 30, warmMinutes: 14, seed: 21 };

for (const build of BUILD_IDS) {
  test(`economy: for ${build} players pooling pays, exile hurts, and keeping your own materials earns no shared work`, () => {
    const found = strategiesFor(VALUE, build, MAP);
    const play = (side: Side, strategy: Strategy) => simulate({ ...RUN, build, side, strategy });
    // Maxed players may solo bosses, so they get all of that income. Anyone else gets a quarter, as if four shared.
    const boss = bossIncomePerHour(VALUE) / (build === 'maxed' ? 1 : 4);
    const alone = (['solo', 'founders', 'altFounders'] as const).map((side) => play(side, found[side]));
    for (const r of alone) assert.equal(r.shared, 0, 'alone, with idle accounts or without, nothing is shared work');
    const solo = Math.max(...alone.map((r) => r.perHour)) + boss;

    const village = play('village', found.village);
    assert.equal(village.lapsed, false, 'the village kept its upkeep paid');
    const ratio = village.perHour / solo;
    assert.ok(ratio >= TARGET.ratio, `pooling pays only ${ratio.toFixed(2)}x playing alone`);
    const exiled = play('exile', found.exile).each[3] + (build === 'maxed' ? boss : 0);
    const loss = 1 - exiled / village.perHour;
    assert.ok(loss >= TARGET.exileLoss, `exile costs only ${Math.round(loss * 100)}%`);

    for (const keep of KEEPS) {
      const separate = play('separate', { ...found.village, keep });
      assert.equal(separate.shared, 0, `${keep}: shared work without sharing`);
      const kept = separate.perHour / solo;
      assert.ok(kept < TARGET.ratio, `${keep}: keeping your own pays ${kept.toFixed(2)}x playing alone`);
    }
  });
}
