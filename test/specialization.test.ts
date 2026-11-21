import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, FOCUS, RECIPES, XP, effectiveLevel, levelFor } from '../src/shared/catalog.ts';
import type { Player } from '../src/server/types.ts';
import { SKILL_ODDS } from '../src/server/odds.ts';
import { world } from './helpers.ts';

type W = Awaited<ReturnType<typeof world>>;
const raw = (w: W, id: string): Player => w.server.game.players.get(id)!;
const setRng = (w: W, fn: () => number) => { (w.server.game as any).rng = fn; };

test('catalog publishes the focus rules and marks tier-3 recipes as specialist-only', () => {
  assert.equal(CATALOG.focus, FOCUS);
  assert.ok(FOCUS.slots < CATALOG.skills.length, 'nobody can focus every skill');
  for (const r of Object.values(RECIPES)) assert.equal(!!r.requiresFocus, r.tier === 3, r.id);
  for (const r of Object.values(RECIPES)) assert.ok(r.minLevel <= FOCUS.unfocusedLevelCap, `${r.id}: tier-1/2 recipes stay reachable without focus`);
  assert.equal(effectiveLevel(1000, true), levelFor(1000));
  assert.equal(effectiveLevel(1000, false), FOCUS.unfocusedLevelCap);
});

test('focus.set: town only, limited slots, free to add, cooldown to drop', async () => {
  const w = await world();
  try {
    const c = await w.bot('Picker');
    const bad = await c.request('focus.set', { skills: ['mining', 'smelting', 'toolcraft', 'swords'] });
    assert.equal(!bad.ok && bad.error.code, 'BAD_REQUEST');
    const unknown = await c.request('focus.set', { skills: ['juggling'] });
    assert.equal(!unknown.ok && unknown.error.code, 'BAD_REQUEST');

    assert.deepEqual((await c.setFocus(['mining'])).skills, ['mining']);
    const added = await c.setFocus(['mining', 'smelting']);
    assert.deepEqual(added.skills, ['mining', 'smelting']);
    assert.equal(added.respecReadyInMs, 0, 'adding to free slots does not start the cooldown');

    const dropped = await c.setFocus(['mining', 'toolcraft']);
    assert.deepEqual(dropped.skills, ['mining', 'toolcraft']);
    assert.ok(dropped.respecReadyInMs > 0);
    const again = await c.request('focus.set', { skills: ['mining'] });
    assert.equal(!again.ok && again.error.code, 'ON_COOLDOWN');
    assert.deepEqual((await c.setFocus(['mining', 'toolcraft', 'swords'])).skills, ['mining', 'toolcraft', 'swords'], 'filling a free slot works during the cooldown');

    const obs = await c.observe();
    assert.deepEqual(obs.self.focus.skills, ['mining', 'toolcraft', 'swords']);
    assert.equal(obs.self.skills.mining.focused, true);
    assert.equal(obs.self.skills.smelting.focused, false);

    await c.travelTo('wilds');
    const away = await c.request('focus.set', { skills: [] });
    assert.equal(!away.ok && away.error.code, 'WRONG_ZONE');
  } finally { await w.close(); }
});

test('focused skills earn double XP and keep their full level; unfocused skills cap without losing XP', async () => {
  const w = await world();
  try {
    const spec = await w.bot('Miner');
    const gen = await w.bot('Dabbler');
    await spec.setFocus(['mining']);
    const ps = raw(w, (await spec.whoami()).playerId);
    const pg = raw(w, (await gen.whoami()).playerId);
    ps.skills.mining = 1000; pg.skills.mining = 1000; // trained level 10 each
    for (const c of [spec, gen]) { await c.equip('copper_pickaxe'); await c.travelTo('wilds'); }
    const node = (await spec.nearestNode('copper_ore'))!;
    await Promise.all([spec.goTo(node.id), gen.goTo(node.id)]);
    const rs = await spec.gather(node.id);
    await gen.waitReady();
    const node2 = (await gen.observe()).zone.nodes.find((n) => n.item === 'copper_ore' && n.charges > 0 && n.inRange)!;
    const rg = await gen.gather(node2.id);
    assert.equal(rs.xp, XP.gather(1) * FOCUS.xpMult);
    assert.equal(rg.xp, XP.gather(1));
    assert.equal(rs.level, 10);
    assert.equal(rg.level, FOCUS.unfocusedLevelCap);
    assert.ok(rs.busyMs < rg.busyMs, 'higher effective level gathers faster');
    const og = (await gen.observe()).self.skills.mining;
    assert.equal(og.trainedLevel, 10, 'XP is kept; focusing later restores the level');
    assert.equal(og.level, FOCUS.unfocusedLevelCap);
  } finally { await w.close(); }
});

test('focused gathering and crafting yield bonus output', async () => {
  const w = await world();
  try {
    const c = await w.bot('Smelter');
    const p = raw(w, (await c.whoami()).playerId);
    p.skills.smelting = 4000; p.skills.mining = 4000; // trained level 20
    p.inventory.copper_ore = 20;
    setRng(w, () => 0); // every chance roll succeeds
    await c.equip('copper_tongs');
    const plain = await c.refine('copper_bar', 2);
    assert.equal(plain.output.qty, 2, 'unfocused refining never yields bonus output');
    await c.waitReady();
    await c.setFocus(['smelting', 'mining']);
    const focused = await c.refine('copper_bar', 4);
    assert.equal(focused.bonus, 4);
    assert.equal(focused.output.qty, 8);
    await c.equip('copper_pickaxe');
    await c.travelTo('wilds');
    const node = (await c.nearestNode('copper_ore'))!;
    await c.goTo(node.id);
    const g = await c.gather(node.id);
    assert.equal(g.qty, 1 + SKILL_ODDS.maxBonusYield, 'a level-20 focused gatherer triples yield');
  } finally { await w.close(); }
});

test('tier-3 recipes need focus in their skill', async () => {
  const w = await world();
  try {
    const c = await w.bot('Armorer');
    const p = raw(w, (await c.whoami()).playerId);
    p.skills.armorcraft = 100; // trained level 3
    p.inventory.wraith_essence = 2; p.inventory.leather = 3; p.inventory.iron_bar = 1; p.inventory.iron_hammer = 1;
    await c.equip('iron_hammer');
    const denied = await c.request('craft', { recipeId: 'wraithhide_armor' });
    assert.equal(!denied.ok && denied.error.code, 'FOCUS_REQUIRED');
    assert.match(!denied.ok ? denied.error.hint ?? '' : '', /focus\.set/);
    await c.setFocus(['armorcraft']);
    const made = await c.craft('wraithhide_armor');
    assert.equal(made.output.item, 'wraithhide_armor');
  } finally { await w.close(); }
});

test('trade contracts: deliver and procure quests progress only from settled trades', async () => {
  const w = await world();
  try {
    const smith = await w.bot('Smith');
    const buyer = await w.bot('Buyer');
    const ids = { s: (await smith.whoami()).playerId, b: (await buyer.whoami()).playerId };
    raw(w, ids.s).inventory.iron_bar = 4;
    raw(w, ids.b).inventory.silver = 100;
    await smith.acceptQuest('supply_contract');
    await buyer.acceptQuest('hire_a_smith');
    const ore = await buyer.acceptQuest('ore_buyer');
    assert.equal(ore.goal, 6);

    // An expired trade credits nothing.
    const t1 = await smith.proposeTrade({ to: ids.b, give: [{ item: 'iron_bar', qty: 4 }], receive: [{ item: 'silver', qty: 40 }], lockTimeoutMs: 1000 });
    await buyer.acceptTrade(t1.trade.id);
    await smith.lockTrade(t1.trade.id, [{ item: 'iron_bar', qty: 4 }]);
    await smith.waitForReceipt(t1.trade.id);
    assert.equal((await smith.quests()).mine.find((q) => q.questId === 'supply_contract')!.progress, 0);

    // A settled trade credits what actually moved.
    const t2 = await smith.proposeTrade({ to: ids.b, give: [{ item: 'iron_bar', qty: 4 }], receive: [{ item: 'silver', qty: 40 }] });
    await buyer.acceptTrade(t2.trade.id);
    await buyer.lockTrade(t2.trade.id, [{ item: 'silver', qty: 40 }]);
    await smith.lockTrade(t2.trade.id, [{ item: 'iron_bar', qty: 4 }]);
    const sq = (await smith.quests()).mine.find((q) => q.questId === 'supply_contract')!;
    assert.equal(sq.status, 'complete');
    const before = await smith.count('silver');
    await smith.claimQuest('supply_contract');
    assert.equal(await smith.count('silver'), before + 40);
    assert.equal((await buyer.quests()).mine.find((q) => q.questId === 'hire_a_smith')!.progress, 0, 'iron bars are not an iron sword');
  } finally { await w.close(); }
});
