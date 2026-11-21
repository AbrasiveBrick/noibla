import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, MOB_TYPES, NODE_TYPES, QUESTS, RECIPES, ZONES } from '../src/shared/catalog.ts';
import { world, wait } from './helpers.ts';

test('catalog: frontier exclusives only originate in the frontier and feed higher-tier recipes', () => {
  const exclusives = Object.values(ITEMS).filter((i) => i.frontierExclusive).map((i) => i.id);
  assert.deepEqual(exclusives.sort(), ['duskiron_ore', 'wraith_essence']);
  for (const id of exclusives) {
    assert.ok(!Object.values(RECIPES).some((r) => r.output.item === id), `${id} must not be craftable`);
    assert.ok(!Object.values(QUESTS).some((q) => q.reward.some((s) => s.item === id)), `${id} must not be a quest reward`);
    for (const z of Object.values(ZONES)) {
      const fromNodes = z.nodes.some((n) => NODE_TYPES[n.type].item === id);
      const fromMobs = z.mobs.some((m) => MOB_TYPES[m.type].drops.some((d) => d.item === id));
      if (z.id !== 'frontier') assert.ok(!fromNodes && !fromMobs, `${id} must not originate in ${z.id}`);
    }
    // Used (directly or via its refined form) by a tier-3 recipe.
    const direct = Object.values(RECIPES).filter((r) => r.inputs.some((s) => s.item === id));
    assert.ok(direct.length > 0);
    const reachesT3 = direct.some((r) => r.tier === 3 && (r.kind === 'craft' || Object.values(RECIPES).some((r2) => r2.kind === 'craft' && r2.tier === 3 && r2.inputs.some((s) => s.item === r.output.item))));
    assert.ok(reachesT3, `${id} must feed a tier-3 recipe`);
  }
});

test('catalog: starter gear (weapon, armor, tools) is obtainable from safe zones only', () => {
  const safeRaw = new Set<string>(['silver']);
  for (const z of Object.values(ZONES)) {
    if (z.safety === 'lethal') continue;
    for (const n of z.nodes) safeRaw.add(NODE_TYPES[n.type].item);
    for (const m of z.mobs) for (const d of MOB_TYPES[m.type].drops) safeRaw.add(d.item);
  }
  const obtainable = new Set(safeRaw);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of Object.values(RECIPES)) {
      if (!obtainable.has(r.output.item) && r.inputs.every((s) => obtainable.has(s.item))) { obtainable.add(r.output.item); grew = true; }
    }
  }
  for (const id of ['copper_sword', 'iron_sword', 'leather_jerkin', 'iron_mail', 'copper_pickaxe', 'iron_pickaxe']) assert.ok(obtainable.has(id), id);
  for (const id of ['duskiron_ore', 'wraith_essence', 'duskiron_bar', 'duskiron_sword', 'wraithhide_armor']) assert.ok(!obtainable.has(id), id);
});

test('gathering, refining, crafting improve through use and respect tools and skill levels', async () => {
  const w = await world();
  try {
    const c = await w.bot('Smith');
    await c.travelTo('wilds');
    const o = await c.observe();
    const iron = o.zone!.nodes.find((n) => n.item === 'iron_ore')!;
    const noTool = await c.request('gather', { nodeId: iron.id });
    assert.equal(!noTool.ok && noTool.error.code, 'TOOL_REQUIRED');
    const vein = o.zone!.nodes.find((n) => n.item === 'copper_ore')!;
    const g1 = await c.request('gather', { nodeId: vein.id }, { commandId: 'g-1' });
    const g2 = await c.request('gather', { nodeId: vein.id }, { commandId: 'g-1' });
    assert.ok(g1.ok && g2.ok && g2.replayed);
    assert.equal(await c.count('copper_ore'), g1.ok ? g1.result.qty : -1, 'replayed gather must not add items');
    const busy = await c.request('gather', { nodeId: vein.id });
    assert.equal(!busy.ok && busy.error.code, 'BUSY');
    assert.ok(!busy.ok && busy.error.retryAfterMs! > 0);
    await c.gatherItem('copper_ore', 5);
    const xp = (await c.observe()).self.skills.mining.xp;
    assert.ok(xp >= 25);
    await c.travelTo('town');
    const low = await c.request('craft', { recipeId: 'iron_sword' });
    assert.equal(!low.ok && low.error.code, 'SKILL_TOO_LOW');
    await c.refineItem('copper_bar', 3);
    assert.ok((await c.observe()).self.skills.smelting.level >= 1);
    const wrongKind = await c.request('craft', { recipeId: 'copper_bar' });
    assert.equal(!wrongKind.ok && wrongKind.error.code, 'BAD_REQUEST');
  } finally { await w.close(); }
});

test('gear determines abilities; town is safe; PvP only in the frontier; combat locks travel', async () => {
  const w = await world();
  try {
    const a = await w.bot('Brawler');
    const b = await w.bot('Victim');
    const victim = await b.whoami();
    let o = await a.observe();
    assert.deepEqual(o.self.abilities.map((x) => x.id), ['punch']);
    const town = await a.request('attack', { targetId: victim.playerId });
    assert.equal(!town.ok && town.error.code, 'SAFE_ZONE');
    await Promise.all([a.travelTo('wilds'), b.travelTo('wilds')]);
    const pvp = await a.request('attack', { targetId: victim.playerId });
    assert.equal(!pvp.ok && pvp.error.code, 'SAFE_ZONE');
    o = await a.observe();
    const wolf = o.zone!.mobs.find((m) => m.type === 'wolf' && m.alive)!;
    const hit = await a.attack(wolf.id);
    assert.equal(hit.ability, 'punch');
    await a.waitReady();
    const locked = await a.request('move', { to: 'town' });
    assert.equal(!locked.ok && locked.error.code, 'COMBAT_LOCKED');
    const res = await a.fight(wolf.id);
    assert.equal(res.result, 'killed');
    assert.ok(res.loot.some((s) => s.item === 'silver'));
    assert.ok((await a.observe()).self.skills.unarmed.xp > 0);
    const bad = await a.request('ability.use', { ability: 'slash' });
    assert.equal(!bad.ok && bad.error.code, 'ABILITY_UNAVAILABLE');
  } finally { await w.close(); }
});

test('death: safe wilderness keeps everything; frontier drops carried + equipped items for others to loot; bank and skills are safe', async () => {
  const w = await world({ speed: 80 });
  try {
    const v = await w.bot('Doomed');
    const looter = await w.bot('Looter');
    const me = await v.whoami();
    // Prepare: copper ore carried, silver banked, punching skill.
    await v.travelTo('wilds');
    await v.gatherItem('copper_ore', 2);
    let obs = await v.observe();
    const boar = obs.zone!.mobs.find((m) => m.type === 'boar' && m.alive)!;
    await v.sendWhenReady('attack', { targetId: boar.id });
    // Stand still and let the boar win (safe wilderness).
    await v.waitFor(async () => (await v.observe()).self.zone === 'town' || null, { timeoutMs: 20_000, what: 'death in the wilds' });
    obs = await v.observe();
    assert.ok(obs.self.inventory.some((s) => s.item === 'copper_ore'), 'safe-zone death keeps inventory');
    // Every death destroys 25% of carried silver, safe zones included: 20 → 15.
    assert.equal(await v.count('silver'), 15);
    await v.deposit([{ item: 'silver', qty: 15 }]);
    const xpBefore = obs.self.skills.unarmed.xp + obs.self.skills.mining.xp;

    await Promise.all([v.travelTo('frontier'), looter.travelTo('frontier')]);
    obs = await v.observe();
    const wraith = obs.zone!.mobs.find((m) => m.type === 'wraith' && m.alive)!;
    await v.sendWhenReady('attack', { targetId: wraith.id });
    const died = await v.waitForEvent((e) => e.type === 'self.died', 20_000);
    assert.equal(died.data.zone, 'frontier');
    obs = await v.observe();
    assert.equal(obs.self.zone, 'town');
    assert.deepEqual(obs.self.inventory, []);
    assert.deepEqual((await v.bank()).items, [{ item: 'silver', qty: 15 }]);
    assert.ok(obs.self.skills.unarmed.xp + obs.self.skills.mining.xp >= xpBefore);

    const lo = await looter.observe();
    const bag = lo.zone!.lootBags.find((b) => b.ownerId === me.playerId)!;
    assert.ok(bag.items.some((s) => s.item === 'copper_ore'));
    const taken = await looter.lootAll(bag.id);
    assert.ok(taken.taken.some((s) => s.item === 'copper_ore'));
    assert.ok((await looter.count('copper_ore')) >= 2);
    const again = await looter.request('loot', { bagId: bag.id });
    assert.equal(!again.ok && again.error.code, 'NOT_FOUND');
    await wait(10);
  } finally { await w.close(); }
});

test('quests track progress and pay out in town', async () => {
  const w = await world();
  try {
    const c = await w.bot('Quester');
    await c.acceptQuest('ore_run');
    const dup = await c.request('quest.accept', { questId: 'ore_run' });
    assert.equal(!dup.ok && dup.error.code, 'QUEST_STATE');
    const early = await c.request('quest.claim', { questId: 'ore_run' });
    assert.match(!early.ok && early.error.hint || '', /only .* after accepting count/i);
    await c.travelTo('wilds');
    await c.gatherItem('copper_ore', 6);
    const q = (await c.quests()).mine.find((x) => x.questId === 'ore_run')!;
    assert.equal(q.status, 'complete');
    const away = await c.request('quest.claim', { questId: 'ore_run' });
    assert.equal(!away.ok && away.error.code, 'WRONG_ZONE');
    await c.travelTo('town');
    const before = await c.count('silver');
    await c.claimQuest('ore_run');
    assert.equal(await c.count('silver'), before + 15);
    // restUntil takes a fraction or a percent; at full HP both resolve at once.
    assert.equal((await c.restUntil(80, 2000)).self.hp, (await c.restUntil(0.8, 2000)).self.maxHp);
    await assert.rejects(c.restUntil(0), RangeError);
  } finally { await w.close(); }
});
