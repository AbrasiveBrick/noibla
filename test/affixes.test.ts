import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AFFIXES, AFFIX_TIER_MIN_ILVL, BASE_HP, WEAR, gearGroup } from '../src/shared/catalog.ts';
import { AFFIX_RANGES, rollAffix } from '../src/server/odds.ts';
import type { Player } from '../src/server/types.ts';
import { makeRng } from '../src/server/util.ts';
import { world } from './helpers.ts';

type W = Awaited<ReturnType<typeof world>>;
const raw = (w: W, id: string): Player => w.server.game.players.get(id)!;

test('affix pools: each gear group has its own pool with three tiers', () => {
  assert.equal(gearGroup('iron_sword'), 'combat');
  assert.equal(gearGroup('iron_mail'), 'combat');
  assert.equal(gearGroup('copper_skinning_knife'), 'gathering');
  assert.equal(gearGroup('iron_tongs'), 'refining');
  assert.equal(gearGroup('duskiron_hammer'), 'crafting');
  assert.equal(gearGroup('iron_bar'), undefined);
  for (const a of Object.values(AFFIXES)) for (const [lo, hi] of AFFIX_RANGES[a.id]) assert.ok(lo <= hi, a.id);
});

test('rollAffix: matching pool only, no duplicates, tiers capped by item level', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 300; i++) {
    const low = rollAffix(rng, 'copper_pickaxe', 12, ['yield'])!;
    assert.equal(AFFIXES[low.id].group, 'gathering');
    assert.notEqual(low.id, 'yield');
    assert.equal(low.tier, 1, 'ilvl 12 rolls tier 1 only');
    const [lo, hi] = AFFIX_RANGES[low.id][0];
    assert.ok(low.value >= lo && low.value <= hi);
    const high = rollAffix(rng, 'duskiron_sword', AFFIX_TIER_MIN_ILVL[2], [])!;
    assert.equal(AFFIXES[high.id].group, 'combat');
  }
  const tiers = new Set(Array.from({ length: 300 }, () => rollAffix(rng, 'duskiron_sword', 40, [])!.tier));
  assert.deepEqual([...tiers].sort(), [1, 2, 3]);
  const all = Object.values(AFFIXES).filter((a) => a.group === 'crafting').map((a) => a.id);
  assert.equal(rollAffix(rng, 'iron_hammer', 40, all), null);
});

async function forge(w: W, c: Awaited<ReturnType<W['bot']>>, base: string, affixes: { id: string; tier: number; value: number }[]) {
  const p = raw(w, (await c.whoami()).playerId);
  const g = w.server.game;
  const id = `${base}#${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
  g.uniques.set(id, { id, base, ilvl: 40, rarity: affixes.length > 2 ? 'rare' : 'magic', affixes, mods: 1, corrupted: false, craftedBy: 'test', craftedAt: 0 });
  p.inventory[id] = 1;
  await c.equip(id);
  return { id, p };
}

test('combat affixes raise max HP and damage, and show on the gear view', async () => {
  const w = await world();
  try {
    const c = await w.bot('Champion');
    await forge(w, c, 'leather_jerkin', [{ id: 'max_hp', tier: 3, value: 30 }]);
    const obs = await c.observe();
    assert.equal(obs.self.maxHp, BASE_HP + 20 + 30);
    assert.deepEqual(obs.self.gear.armor?.affixes, ['T3 +30 max HP']);
    assert.equal(obs.self.gear.armor?.rarity, 'magic');
    await forge(w, c, 'copper_sword', [{ id: 'damage', tier: 3, value: 25 }, { id: 'attack_speed', tier: 3, value: 15 }]);
    await c.travelTo('wilds');
    const wolf = await c.approachMob('wolf');
    const hit = await c.attack(wolf.id, 'slash');
    assert.ok(Math.abs(hit.damage - 10) < 0.01, `slash for 8 × 1.25 = 10, got ${hit.damage}`);
    assert.ok(hit.busyMs < w.server.game.ms(1000), 'attack speed shortens the global cooldown');
  } finally { await w.close(); }
});

test('gathering, refining and crafting tool affixes change yield, inputs, wear and item level', async () => {
  const w = await world();
  try {
    const c = await w.bot('Artisan');
    (w.server.game as any).rng = () => 0; // every chance roll succeeds
    const { p } = await forge(w, c, 'copper_tongs', [{ id: 'save_inputs', tier: 3, value: 18 }, { id: 'refine_output', tier: 1, value: 5 }]);
    p.inventory.copper_ore = 4;
    const r = await c.refine('copper_bar', 2);
    assert.equal(r.inputsSaved, 2);
    assert.equal(r.output.qty, 4, 'refine_output adds a bar per unit even unfocused');
    assert.equal(await c.count('copper_ore'), 4, 'inputs handed back');
    await c.waitReady();
    await forge(w, c, 'copper_hammer', [{ id: 'craft_ilvl', tier: 3, value: 7 }]);
    p.inventory.copper_bar = 3; p.inventory.pine_plank = 1;
    await c.craft('copper_sword');
    const sword = (await c.observe()).self.uniques.find((u) => u.base === 'copper_sword')!;
    assert.equal(sword.ilvl, 10 + 0 + 7);
    await c.waitReady();
    await forge(w, c, 'copper_pickaxe', [{ id: 'yield', tier: 3, value: 40 }, { id: 'double_drop', tier: 3, value: 18 }, { id: 'durable', tier: 3, value: 50 }]);
    await c.travelTo('wilds');
    const vein = (await c.nearestNode('copper_ore'))!;
    await c.goTo(vein.id);
    const gth = await c.gather(vein.id);
    assert.equal(gth.qty, (1 + 1) * 2, 'yield rolls one bonus item, double drop doubles it');
    assert.equal((await c.observe()).self.gear.tool?.wear, WEAR.perToolUse * 0.5);
  } finally { await w.close(); }
});

test('catalog() carries no probabilities; chance-based affix values are hidden from players', async () => {
  const w = await world();
  try {
    const c = await w.bot('Peeker');
    const cat = await c.catalog();
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (typeof v === 'string') { if (/\d+(\.\d+)?\s*%\s*(chance|odds)|~\s*\d+\s*%|\d+\s*%\s*:/i.test(v)) bad.push(`${path}: "${v}"`); return; }
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if (path !== 'catalog.affixes' && /chance|weight|odds|luck|prob|^tiers$|bonusOutput|bonusYield|extraAffix/i.test(k)) bad.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    };
    walk(cat, 'catalog');
    for (const [id, m] of Object.entries(cat.mobs)) assert.ok(!Array.isArray(m.silver), `${id}.silver must not be a numeric range`);
    assert.deepEqual(bad, []);
    // An item with a chance affix shows its tier, not its value.
    const g = w.server.game;
    const p = g.players.get((await c.whoami()).playerId)!;
    const id = 'copper_pickaxe#0badc0de';
    g.uniques.set(id, { id, base: 'copper_pickaxe', ilvl: 40, rarity: 'magic', affixes: [{ id: 'double_drop', tier: 3, value: 15 }, { id: 'durable', tier: 1, value: 12 }], mods: 1, corrupted: false, craftedBy: 'x', craftedAt: 0 });
    p.inventory[id] = 1;
    const seen = (await c.inspect(id)).item.affixes;
    assert.deepEqual(seen, [{ id: 'double_drop', tier: 3 }, { id: 'durable', tier: 1, value: 12 }]);
    await c.equip(id);
    assert.deepEqual((await c.observe()).self.gear.tool?.affixes, ['T3 a chance to double a gather or a hide drop', 'T1 12% less tool wear']);
    const op = await w.operator();
    assert.ok(op.bots.find((b: any) => b.id === p.id).gear.tool.affixes[0].includes('15'), 'the operator sees the real value');
  } finally { await w.close(); }
});
