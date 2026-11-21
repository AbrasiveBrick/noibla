import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORBS, RECIPES, SHOP, WEAR } from '../src/shared/catalog.ts';
import type { Player } from '../src/server/types.ts';
import { makeRng } from '../src/server/util.ts';
import { repairCost } from '../src/server/world.ts';
import { world } from './helpers.ts';

type W = Awaited<ReturnType<typeof world>>;
const raw = (w: W, id: string): Player => w.server.game.players.get(id)!;
const setRng = (w: W, fn: () => number) => { (w.server.game as any).rng = fn; };

async function smith(w: W, name: string, base = 'iron_sword') {
  const c = await w.bot(name);
  const p = raw(w, (await c.whoami()).playerId);
  p.skills.weaponcraft = 1000; p.skills.toolcraft = 1000; p.focus = ['weaponcraft', 'toolcraft'];
  p.inventory.iron_bar = 10; p.inventory.pine_plank = 5; p.inventory.silver = 5000;
  await c.craftItem(base, 1);
  const u = (await c.observe()).self.uniques.find((x) => x.base === base)!;
  await c.goTo('altar');
  return { c, p, u };
}

test('orb chain: transmute → augment → regal → chaos → annul → scour, fees rise with each mod and are destroyed', async () => {
  const w = await world();
  try {
    setRng(w, makeRng(42));
    const { c, p, u } = await smith(w, 'Modder');
    for (const o of Object.values(ORBS.items)) p.inventory[o] = 3;
    const silver0 = p.inventory.silver;
    const t = await c.modifyItem(u.id, 'transmute');
    assert.equal(t.item.rarity, 'magic');
    assert.equal(t.item.affixes.length, 1);
    assert.equal(t.fee, ORBS.baseFee.transmute);
    assert.ok(t.item.affixes.every((a) => a.tier <= 2), 'ilvl 30 caps affixes at tier 2');
    const a = await c.modifyItem(u.id, 'augment');
    assert.equal(a.item.affixes.length, 2);
    assert.equal(a.fee, Math.ceil(ORBS.baseFee.augment * (1 + ORBS.feeGrowth)), 'fee grows with mods');
    const full = await c.request('item.modify', { item: u.id, orb: 'augment' });
    assert.equal(!full.ok && full.error.code, 'INVALID_TARGET');
    assert.equal(await c.count('orb_augment'), 2, 'a refused orb is not consumed');
    const r = await c.modifyItem(u.id, 'regal');
    assert.equal(r.item.rarity, 'rare');
    assert.equal(r.item.affixes.length, 3);
    const ch = await c.modifyItem(u.id, 'chaos');
    assert.ok(ch.item.affixes.length >= 3 && ch.item.affixes.length <= 4);
    assert.equal(new Set(ch.item.affixes.map((x) => x.id)).size, ch.item.affixes.length, 'no duplicate affixes');
    const n = ch.item.affixes.length;
    assert.equal((await c.modifyItem(u.id, 'annul')).item.affixes.length, n - 1);
    const sc = await c.modifyItem(u.id, 'scour');
    assert.equal(sc.item.rarity, 'normal');
    assert.deepEqual(sc.item.affixes, []);
    assert.equal(sc.item.mods, 6);
    const op = await w.operator();
    const fees = [t, a, r, ch, sc].reduce((s, x) => s + x.fee, 0);
    assert.ok(op.economy.destroyed.orbFee >= fees);
    assert.equal(p.inventory.silver, silver0 - op.economy.destroyed.orbFee);
    assert.equal(op.economy.orbs.used.transmute, 1);
    assert.ok(op.events.some((e: any) => e.type === 'item.modified' && e.data.orb === 'chaos'));
    assert.ok((await c.observe()).self.skills.enchanting.xp > 0, 'modding trains enchanting');
  } finally { await w.close(); }
});

test('retrying item.modify with the same commandId never spends a second orb', async () => {
  const w = await world();
  try {
    const { c, p, u } = await smith(w, 'Careful');
    p.inventory.orb_transmute = 2;
    const r1 = await c.request('item.modify', { item: u.id, orb: 'transmute' }, { commandId: 'mod-1' });
    const r2 = await c.request('item.modify', { item: u.id, orb: 'transmute' }, { commandId: 'mod-1' });
    assert.ok(r1.ok && r2.ok && r2.replayed);
    assert.equal(p.inventory.orb_transmute, 1);
    assert.equal(w.server.game.uniques.get(u.id)!.mods, 1);
  } finally { await w.close(); }
});

test('vaal: better, bricked or unchanged, then locked; luck from hammer and enchanting makes it safer', async () => {
  const w = await world();
  try {
    const { c, p, u } = await smith(w, 'Gambler');
    p.inventory.orb_transmute = 1; p.inventory.orb_vaal = 3;
    await c.modifyItem(u.id, 'transmute');
    setRng(w, () => 0.1); // below bricked odds (0.25)
    const v = await c.modifyItem(u.id, 'vaal');
    assert.equal(v.outcome, 'bricked');
    assert.equal(v.item.corrupted, true);
    assert.deepEqual(v.item.affixes, []);
    const again = await c.request('item.modify', { item: u.id, orb: 'vaal' });
    assert.equal(!again.ok && again.error.code, 'CORRUPTED');
    assert.equal(p.inventory.orb_vaal, 2);
    // A lucky modder: enchanting level + mod_odds hammer push 0.1 out of the bricked band.
    const { c: c2, p: p2, u: u2 } = await smith(w, 'Lucky');
    p2.inventory.orb_transmute = 1; p2.inventory.orb_vaal = 1;
    p2.skills.enchanting = 10_000; p2.focus = ['enchanting'];
    const hid = 'iron_hammer#abcdef01';
    w.server.game.uniques.set(hid, { id: hid, base: 'iron_hammer', ilvl: 40, rarity: 'magic', affixes: [{ id: 'mod_odds', tier: 3, value: 30 }, { id: 'orb_fee', tier: 3, value: 30 }], mods: 1, corrupted: false, craftedBy: 'x', craftedAt: 0 });
    p2.inventory[hid] = 1;
    await c2.equip(hid);
    setRng(w, makeRng(3));
    await c2.modifyItem(u2.id, 'transmute');
    const q = await c2.quoteModify(u2.id, 'vaal');
    assert.equal(q.luck, ORBS.maxLuck);
    assert.equal(q.feeCut, ORBS.maxFeeCut);
    assert.ok(q.fee < ORBS.baseFee.vaal);
    setRng(w, () => 0.2); // bricked band shrinks to 0.125 at max luck; 0.2 now lands in "better"
    const v2 = await c2.modifyItem(u2.id, 'vaal');
    assert.equal(v2.outcome, 'better');
    assert.ok(v2.item.affixes[0].tier > v2.before.affixes[0].tier || v2.item.affixes[0].tier === 3);
  } finally { await w.close(); }
});

test('salvage turns uniques into shards; enchanters fuse 10 shards into an orb; shop sells only basic orbs', async () => {
  const w = await world();
  try {
    const { c, p, u } = await smith(w, 'Recycler');
    const swords = await c.count('iron_sword');
    const s = await c.salvage(u.id);
    assert.equal(s.shards, ORBS.salvage.perTier[2]);
    assert.equal(w.server.game.uniques.has(u.id), false);
    assert.equal(await c.count('iron_sword'), swords - 1);
    p.inventory.orb_shard = 10;
    const made = await c.craftItem('orb_transmute', 1);
    await c.goTo('altar');
    assert.equal(made.qty, 1);
    assert.equal(RECIPES.orb_chaos.requiresFocus, true);
    assert.deepEqual(Object.keys(SHOP).filter((k) => k.startsWith('orb_')).sort(), ['orb_augment', 'orb_transmute']);
    const op = await w.operator();
    assert.equal(op.economy.orbs.shards.salvage, s.shards);
    assert.equal(op.economy.orbs.created.crafted, 1);
    const noAltar = await c.request('item.salvage', { item: 'copper_pickaxe' });
    assert.equal(!noAltar.ok && noAltar.error.code, 'NOT_FOUND', 'starter tools are not uniques');
  } finally { await w.close(); }
});

test('rarer gear costs more to repair', async () => {
  const w = await world();
  try {
    const g = w.server.game;
    const mk = (id: string, rarity: 'normal' | 'magic' | 'rare', corrupted = false) => g.uniques.set(id, { id, base: 'iron_sword', ilvl: 30, rarity, affixes: [], mods: 0, corrupted, craftedBy: 'x', craftedAt: 0 });
    mk('iron_sword#00000001', 'normal'); mk('iron_sword#00000002', 'magic'); mk('iron_sword#00000003', 'rare', true);
    assert.equal(repairCost('iron_sword#00000001', WEAR.max), 30);
    assert.equal(repairCost('iron_sword#00000002', WEAR.max), 45);
    assert.equal(repairCost('iron_sword#00000003', WEAR.max), 90);
  } finally { await w.close(); }
});

test('rerollUntil stops on the affix or at the silver budget', async () => {
  const w = await world();
  try {
    setRng(w, makeRng(9));
    const { c, p, u } = await smith(w, 'Seeker');
    p.inventory.orb_transmute = 1; p.inventory.orb_alteration = 50; p.inventory.orb_augment = 20;
    const res = await c.rerollUntil(u.id, 'damage', { maxSilver: 2000 });
    assert.equal(res.hit, true);
    assert.ok(res.item.affixes.some((a) => a.id === 'damage'));
    const poor = await c.rerollUntil(u.id, 'nonexistent_affix', { maxSilver: 30 });
    assert.equal(poor.stopReason, 'budget');
    assert.ok(poor.silverSpent <= 30);
  } finally { await w.close(); }
});
