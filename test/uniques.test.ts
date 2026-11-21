import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseOf, isUnique } from '../src/shared/catalog.ts';
import type { Player } from '../src/server/types.ts';
import { world } from './helpers.ts';

type W = Awaited<ReturnType<typeof world>>;
const raw = (w: W, id: string): Player => w.server.game.players.get(id)!;

test('crafted gear is unique with an item level from base tier and crafter skill', async () => {
  const w = await world();
  try {
    const c = await w.bot('Forger');
    const p = raw(w, (await c.whoami()).playerId);
    p.skills.weaponcraft = 40; // trained level 2
    p.inventory.copper_bar = 6; p.inventory.pine_plank = 2;
    const r = await c.craftItem('copper_sword', 2);
    assert.deepEqual(r, { item: 'copper_sword', qty: 2 });
    const obs = await c.observe();
    assert.equal(obs.self.uniques.length, 2);
    for (const u of obs.self.uniques) {
      assert.ok(isUnique(u.id) && baseOf(u.id) === 'copper_sword');
      assert.equal(u.ilvl, 10 + 2);
      assert.equal(u.rarity, 'normal');
      assert.deepEqual(u.affixes, []);
      assert.equal(u.corrupted, false);
      assert.equal(u.craftedBy, p.name);
    }
    assert.equal(await c.count('copper_sword'), 2, 'count() by base includes uniques');
    assert.equal((await c.inspect(obs.self.uniques[0].id)).item.base, 'copper_sword');
    // Equip by base picks a unique; bank by base moves a unique.
    await c.equip('copper_sword');
    const eq = (await c.observe()).self.equipment.weapon!;
    assert.ok(isUnique(eq));
    await c.deposit([{ item: 'copper_sword', qty: 1 }]);
    const after = await c.observe();
    assert.equal(await c.count('copper_sword', after), 0);
    assert.equal(after.self.uniques.length, 2, 'banked and equipped uniques still listed');
    // Refined materials stay stackable.
    p.inventory.copper_ore = 2;
    await c.refineItem('copper_bar', 1);
    assert.equal(await c.count('copper_bar'), 1);
  } finally { await w.close(); }
});

test('blind trades accept uniques against a base-id promise; contracts count the base', async () => {
  const w = await world();
  try {
    const s = await w.bot('Smith');
    const b = await w.bot('Buyer');
    const ps = raw(w, (await s.whoami()).playerId);
    const pb = raw(w, (await b.whoami()).playerId);
    ps.skills.weaponcraft = 100; ps.inventory.iron_bar = 2; ps.inventory.pine_plank = 1;
    pb.inventory.silver = 100;
    await s.craftItem('iron_sword', 1);
    const sword = (await s.observe()).self.uniques[0].id;
    await b.acceptQuest('hire_a_smith');
    const { trade } = await b.proposeTrade({ to: ps.id, give: [{ item: 'silver', qty: 50 }], receive: [{ item: 'iron_sword', qty: 1 }] });
    await s.acceptTrade(trade.id);
    const [rs, rb] = await Promise.all([
      s.completeTrade(trade.id, [{ item: 'iron_sword', qty: 1 }]),
      b.completeTrade(trade.id, [{ item: 'silver', qty: 50 }]),
    ]);
    assert.equal(rb.counterpartyKeptWord, true);
    assert.equal(rs.counterpartyKeptWord, true);
    assert.deepEqual(rb.actual.youReceived, [{ item: sword, qty: 1 }]);
    assert.equal(pb.inventory[sword], 1);
    assert.equal((await b.observe()).self.uniques[0].ilvl, 23);
    assert.equal((await b.observe()).self.quests.find((q) => q.questId === 'hire_a_smith')?.status, 'complete');
  } finally { await w.close(); }
});

test('unique items persist across restarts', async () => {
  const w = await world();
  const c = await w.bot('Keeper');
  const id = (await c.whoami()).playerId;
  const p = raw(w, id);
  p.inventory.leather = 3;
  await c.craftItem('leather_jerkin', 1);
  const u = (await c.observe()).self.uniques[0];
  await w.close({ keepDir: true });
  const w2 = await world({ dir: w.dir });
  try {
    assert.deepEqual(w2.server.game.uniques.get(u.id), u);
    assert.equal(raw(w2, id).inventory[u.id], 1);
  } finally { await w2.close(); }
});
