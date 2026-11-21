import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, RECIPES, STARTER_KIT, TOOL_FAMILIES, WEAR } from '../src/shared/catalog.ts';
import type { Player } from '../src/server/types.ts';
import { world } from './helpers.ts';

type W = Awaited<ReturnType<typeof world>>;
const raw = (w: W, id: string): Player => w.server.game.players.get(id)!;

test('catalog: every job has a tool family in three tiers, each craftable at the forge', () => {
  for (const family of new Set(Object.values(TOOL_FAMILIES).filter(Boolean))) {
    for (const [tier, metal] of [[1, 'copper'], [2, 'iron'], [3, 'duskiron']] as const) {
      const id = `${metal}_${family}`;
      assert.equal(ITEMS[id]?.slot, 'tool', id);
      assert.equal(ITEMS[id].toolTier, tier, id);
      assert.equal(RECIPES[id]?.skill, 'toolcraft', id);
      assert.equal(!!RECIPES[id].requiresFocus, tier === 3, id);
    }
  }
  assert.equal(STARTER_KIT.length, 7);
});

test('new players carry a copper kit; jobs need the matching tool equipped', async () => {
  const w = await world();
  try {
    const c = await w.bot('Toolsmith');
    const p = raw(w, (await c.whoami()).playerId);
    for (const k of STARTER_KIT) assert.equal(await c.count(k.item), 1, k.item);
    p.inventory.copper_ore = 4;
    const none = await c.request('refine', { recipeId: 'copper_bar' });
    assert.equal(!none.ok && none.error.code, 'TOOL_REQUIRED');
    assert.match(!none.ok ? none.error.hint ?? '' : '', /equip\("copper_tongs"\)/);
    await c.equip('copper_pickaxe');
    const wrong = await c.request('refine', { recipeId: 'copper_bar' });
    assert.equal(!wrong.ok && wrong.error.code, 'TOOL_REQUIRED', 'a pickaxe is not tongs');
    await c.equip('copper_tongs');
    assert.equal(await c.count('copper_pickaxe'), 1, 'the swapped-out tool returns to the inventory');
    const ok = await c.refine('copper_bar', 2);
    assert.equal(ok.output.qty, 2);
    assert.equal((await c.observe()).self.gear.tool?.wear, WEAR.perToolUse * 2, 'tools wear per unit made');
    // Tier-3 recipes need an iron tool.
    p.skills.smelting = 100; p.focus = ['smelting']; p.inventory.duskiron_ore = 2; p.inventory.iron_bar = 1;
    await c.waitReady();
    const weak = await c.request('refine', { recipeId: 'duskiron_bar' });
    assert.equal(!weak.ok && weak.error.code, 'TOOL_REQUIRED');
    assert.match(!weak.ok ? weak.error.hint ?? '' : '', /iron_tongs/);
    // Repairs cover the tool slot.
    const fixed = await c.repair('tool');
    assert.equal(fixed.repaired[0].item, 'copper_tongs');
  } finally { await w.close(); }
});

test('beasts drop hides only to a killer with a skinning knife; hunt() equips one', async () => {
  const w = await world();
  try {
    const c = await w.bot('Skinner');
    const p = raw(w, (await c.whoami()).playerId);
    p.inventory.copper_sword = 1;
    await c.equip('copper_sword');
    await c.equip('copper_axe');
    await c.travelTo('wilds');
    const wolf = (await c.observe()).zone!.mobs.find((m) => m.type === 'wolf' && m.alive)!;
    const bare = await c.fight(wolf.id);
    assert.equal(bare.result, 'killed');
    assert.ok(!bare.loot.some((s) => s.item === 'rough_hide'), 'no knife, no hide');
    assert.ok(bare.loot.some((s) => s.item === 'silver'));
    const loot = await c.hunt('wolf', 1);
    assert.ok(loot.some((s) => s.item === 'rough_hide'));
    assert.equal((await c.observe()).self.equipment.tool, 'copper_skinning_knife');
  } finally { await w.close(); }
});

test('players saved before the tool slot get the starter kit once on load', async () => {
  const w = await world();
  const c = await w.bot('Veteran');
  const id = (await c.whoami()).playerId;
  const p = raw(w, id);
  for (const k of STARTER_KIT) delete p.inventory[k.item];
  delete p.toolKit;
  w.server.game.markPlayer(p);
  await w.close({ keepDir: true });
  for (let i = 0; i < 2; i++) {
    const w2 = await world({ dir: w.dir });
    const q = raw(w2, id);
    assert.equal(q.inventory.copper_hammer, 1, `restart ${i}`);
    await w2.close({ keepDir: i === 0 });
  }
});
