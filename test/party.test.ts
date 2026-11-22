import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOB_TYPES } from '../src/shared/catalog.ts';
import type { CommandError } from '../src/sdk/index.ts';
import type { Mob, Player } from '../src/server/types.ts';
import { attach, wait, world } from './helpers.ts';

type W = Awaited<ReturnType<typeof world>>;
const raw = (w: W, id: string): Player => w.server.game.players.get(id)!;
const bossOf = (w: W, type: string): Mob => [...w.server.game.mobs.values()].find((m) => m.type === type)!;
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CommandError; } assert.fail('expected the command to fail'); };

test('parties: invite, accept, member view, party chat only for members, kick and leave', async () => {
  const w = await world();
  try {
    const lead = await w.bot('Leader');
    const mate = await w.bot('Mate');
    const out = await w.bot('Outsider');
    const L = await lead.whoami(); const M = await mate.whoami(); const O = await out.whoami();

    assert.equal((await lead.observe()).party, null);
    const { party } = await lead.partyInvite(M.playerId);
    assert.equal(party.leaderId, L.playerId);
    assert.deepEqual(party.invites.map((i) => i.playerId), [M.playerId]);
    // Only the invited player sees the invitation.
    assert.equal((await out.observe()).partyInvites.length, 0);
    assert.equal((await err(out.partyAccept(party.id))).code, 'NOT_FOUND');

    const pid = await mate.acceptPartyInvite({ fromId: L.playerId });
    assert.equal(pid, party.id);
    assert.equal((await mate.observe()).party!.members.length, 2);
    assert.equal((await err(mate.partyInvite(O.playerId))).code, 'FORBIDDEN', 'only the leader invites');
    assert.equal((await err(lead.partyInvite(M.playerId))).code, 'PARTY_STATE', 'already in a party');

    // Members see each other's zone and HP, even in different zones.
    await mate.travelTo('wilds');
    raw(w, M.playerId).hp = 37;
    const seen = (await lead.party()).party!.members.find((m) => m.id === M.playerId)!;
    assert.equal(seen.zone, 'wilds');
    assert.equal(seen.hp, 37);

    const said = mate.waitForEvent((e) => e.type === 'party.message', 5000);
    await lead.partySay('meet at the bear');
    const got = await said;
    assert.equal(got.data.message.text, 'meet at the bear');
    await wait(50);
    assert.ok(!out.received.some((e) => e.type.startsWith('party.')), 'outsiders never see party events');
    assert.equal((await err(out.partySay('hi'))).code, 'PARTY_STATE');

    // Kick, then the leader leaving disbands the party.
    const kicked = mate.waitForEvent((e) => e.type === 'party.left' && e.data.kicked, 5000);
    await lead.partyKick(M.playerId);
    assert.equal((await mate.observe()).party, null);
    await kicked;
    await lead.partyLeave();
    assert.equal(w.server.game.parties.size, 0);
  } finally { await w.close(); }
});

test('allies in the zone add attack damage and share kill XP and quest credit', async () => {
  const w = await world();
  try {
    const a = await w.bot('Striker');
    const b = await w.bot('Helper');
    const c = await w.bot('Helper2');
    const A = await a.whoami(); const B = await b.whoami(); const C = await c.whoami();
    await a.partyInvite(B.playerId); await b.acceptPartyInvite();
    await a.partyInvite(C.playerId); await c.acceptPartyInvite();
    await b.acceptQuest('wolf_cull');
    raw(w, A.playerId).inventory.iron_sword = 1;
    await a.equip('iron_sword');
    await Promise.all([a.travelTo('wilds'), b.travelTo('wilds'), c.travelTo('wilds')]);
    const wolf = [...w.server.game.mobs.values()].find((m) => m.type === 'wolf' && m.zone === 'wilds')!;
    await a.goTo(wolf.id);
    wolf.hp = 13;
    const r = await a.attack(wolf.id, 'slash');
    assert.equal(r.damage, 13, 'iron sword 12 × (1 + 2 allies × 5%)');
    assert.ok(r.killed);
    const share = Math.round(MOB_TYPES.wolf.hp * 0.1 * 0.5);
    assert.equal((await b.observe()).self.skills.unarmed.xp, share, 'XP share in the weapon skill (unarmed: no weapon)');
    assert.equal((await b.observe()).self.quests.find((q) => q.questId === 'wolf_cull')!.progress, 1);
    // An ally in another zone gets nothing.
    await c.travelTo('town');
    const xpBefore = (await c.observe()).self.skills.unarmed.xp;
    const wolf2 = [...w.server.game.mobs.values()].find((m) => m.type === 'wolf' && m.id !== wolf.id)!;
    await a.goTo(wolf2.id);
    wolf2.hp = 1;
    const r2 = await a.attack(wolf2.id, 'slash');
    assert.equal(r2.damage, Math.round(12 * 1.05));
    assert.equal((await c.observe()).self.skills.unarmed.xp, xpBefore);
  } finally { await w.close(); }
});

test('a lone fighter loses to the Elder Bear; the boss resets, and enrage triples its damage', async () => {
  const w = await world();
  try {
    const solo = await w.bot('Solo');
    const S = await solo.whoami();
    await solo.travelTo('wilds');
    const bear = bossOf(w, 'elder_bear');
    await solo.goTo(bear.id);
    const view = (await solo.observe()).zone!.mobs.find((m) => m.id === bear.id)!;
    assert.equal(view.boss, true);
    assert.equal(view.enrageInMs, null, 'no enrage clock before the fight');
    const r = await solo.huntBoss('elder_bear', { timeoutMs: 30_000 });
    assert.equal(r.result, 'died');
    await solo.waitFor(async () => bear.hp === MOB_TYPES.elder_bear.hp && bear.targetId === null, { timeoutMs: 5000, what: 'bear reset' });
    assert.equal(bear.engagedAt, undefined);

    // Enrage: a fight that has lasted past enrageAfterMs hits three times as hard.
    await solo.waitReady();
    await solo.travelTo('wilds');
    await solo.goTo(bear.id);
    const p = raw(w, S.playerId);
    await solo.attack(bear.id);
    p.hp = 10_000;
    bear.engagedAt = Date.now() - 10 * 60_000;
    bear.nextAoeAt = Date.now() + 60_000;
    const hit = await solo.waitForEvent((e) => e.type === 'self.damaged' && e.data.sourceId === bear.id && e.data.damage !== MOB_TYPES.elder_bear.damage, 5000);
    assert.equal(hit.data.damage, MOB_TYPES.elder_bear.damage * 3);
    assert.equal((await solo.observe()).zone!.mobs.find((m) => m.id === bear.id)!.enrageInMs, 0);
  } finally { await w.close(); }
});

test('boss area attack hits fighters near it; spoils are reserved for contributors and any of them can take it all', async () => {
  const w = await world();
  try {
    const a = await w.bot('Tank');
    const b = await w.bot('Archer');
    const c = await w.bot('Cheer');      // party member in the zone who never hits
    const d = await w.bot('Freelance');  // hits the boss without being in the party
    const e = await w.bot('Vulture');    // just watches
    const [A, B, C, D, E] = await Promise.all([a, b, c, d, e].map((x) => x.whoami()));
    await a.partyInvite(B.playerId); await b.acceptPartyInvite();
    await a.partyInvite(C.playerId); await c.acceptPartyInvite();
    for (const x of [a, b, c, d, e]) await x.acceptQuest('bear_hunt');
    for (const id of [A, B, C, D, E]) raw(w, id.playerId).hp = 5000;
    await Promise.all([a, b, c, d, e].map((x) => x.travelTo('wilds')));
    for (const id of [A, B, C, D, E]) raw(w, id.playerId).hp = 5000;
    const bear = bossOf(w, 'elder_bear');
    // Everyone gathers at the bear; only Tank, Archer and Freelance hit it.
    await Promise.all([a, b, c, d, e].map((x) => x.goTo(bear.id)));

    await a.attack(bear.id);
    await b.attack(bear.id);
    await d.attack(bear.id);
    // The sweep hits the fighters next to the bear, not the bystanders, and not a fighter who stepped out of its radius.
    const far = raw(w, D.playerId);
    far.pos = (await d.map()).tiles.flatMap((row, y) => [...row].map((ch, x) => ({ ch, x, y })))
      .filter((t) => t.ch === '.' && Math.hypot(t.x - bear.x, t.y - bear.y) > MOB_TYPES.elder_bear.boss!.aoeRadius + 1 && Math.hypot(t.x - bear.x, t.y - bear.y) < 8)
      .map(({ x, y }) => ({ x, y })).find((q) => w.server.game.map.regions.find((r) => q.x >= r.x0 && q.x <= r.x1 && q.y >= r.y0 && q.y <= r.y1)?.id === 'wilds')!;
    bear.nextAoeAt = Date.now();
    const sweep = await b.waitForEvent((ev) => ev.type === 'combat.hit' && ev.data.ability === 'sweep' && ev.data.targetId === B.playerId, 5000);
    assert.equal(sweep.data.area, true);
    await wait(30);
    const swept = new Set(b.received.filter((ev) => ev.type === 'combat.hit' && ev.data.ability === 'sweep').map((ev) => ev.data.targetId));
    assert.ok(swept.has(A.playerId) && !swept.has(D.playerId) && !swept.has(C.playerId) && !swept.has(E.playerId));

    bear.hp = 1;
    await a.waitReady();
    const kill = await a.attack(bear.id);
    assert.ok(kill.killed);
    assert.deepEqual(kill.loot, [], 'boss loot never goes straight to the killer');
    assert.ok(kill.spoilsBagId);
    const bag = (await e.observe()).zone!.lootBags.find((x) => x.id === kill.spoilsBagId)!;
    assert.equal(bag.spoils, true);
    assert.equal(bag.youMayLoot, false);
    assert.ok(bag.items.some((s) => s.item === 'bear_pelt'));
    assert.equal((await c.observe()).zone!.lootBags.find((x) => x.id === bag.id)!.youMayLoot, false, 'hitting it is what counts');
    const denied = await err(e.loot(bag.id));
    assert.equal(denied.code, 'FORBIDDEN');
    assert.ok(denied.retryAfterMs! > 0);

    // Quest credit: party members in the zone and every contributor; not the bystander.
    const progress = async (x: typeof a) => (await x.observe()).self.quests.find((q) => q.questId === 'bear_hunt')!.status;
    assert.equal(await progress(a), 'complete');
    assert.equal(await progress(b), 'complete');
    assert.equal(await progress(c), 'complete');
    assert.equal(await progress(d), 'complete');
    assert.equal(await progress(e), 'active');

    // The freelancer grabs everything: nothing is left for the party.
    const grabbed = await d.lootAll(bag.id);
    assert.ok(grabbed.taken.some((s) => s.item === 'bear_pelt'));
    assert.deepEqual(grabbed.remaining, []);
    assert.ok(!(await a.observe()).zone!.lootBags.some((x) => x.id === bag.id));
  } finally { await w.close(); }
});

test('reserved spoils open to anyone later; parties survive a restart', async () => {
  const w1 = await world();
  const dir = w1.dir;
  const a = await w1.bot('Keeper');
  const b = await w1.bot('Friend');
  const v = await w1.bot('Late');
  const [A, B] = await Promise.all([a.whoami(), b.whoami()]);
  await a.partyInvite(B.playerId); await b.acceptPartyInvite();
  await Promise.all([a.travelTo('wilds'), v.travelTo('wilds')]);
  const bear = bossOf(w1, 'elder_bear');
  await Promise.all([a.goTo(bear.id), v.goTo(bear.id)]);
  raw(w1, A.playerId).hp = 5000;
  bear.hp = 1;
  const kill = await a.attack(bear.id);
  const bag = w1.server.game.bags.get(kill.spoilsBagId!)!;
  bag.opensToAllAt = Date.now() - 1;
  w1.server.game.markBag(bag); // written by the next tick
  await wait(100);
  assert.equal((await v.observe()).zone!.lootBags.find((x) => x.id === bag.id)!.youMayLoot, true);
  const partyId = (await a.observe()).party!.id;
  await w1.close({ keepDir: true });

  const w2 = await world({ dir });
  try {
    const b2 = attach(w2.url, b.botToken);
    const pv = (await b2.party()).party!;
    assert.equal(pv.id, partyId);
    assert.deepEqual(pv.members.map((m) => m.id).sort(), [A.playerId, B.playerId].sort());
    const v2 = attach(w2.url, v.botToken);
    const taken = await v2.lootAll(kill.spoilsBagId!);
    assert.ok(taken.taken.length > 0);
  } finally { await w2.close(); }
});

test('being alone in a party never blocks joining another: declined, expired, crossed invites and leftovers', async () => {
  const w = await world();
  try {
    const [a, b, c, d, e] = await Promise.all(['Asker', 'Busy', 'Caller', 'Drifter', 'Extra'].map((n) => w.bot(n)));
    const [A, B, C, D, E] = await Promise.all([a, b, c, d, e].map((x) => x.whoami()));

    // Declined: the asker can still be invited and join.
    const first = (await a.partyInvite(B.playerId)).party;
    await b.partyDecline(first.id);
    const fromC = (await c.partyInvite(A.playerId)).party;
    await a.partyAccept(fromC.id);
    assert.equal((await a.observe()).party!.id, fromC.id);
    assert.ok(!w.server.game.parties.has(first.id), 'the party of one gave way');

    // Sharing a party still blocks both being invited and joining another.
    assert.equal((await err(d.partyInvite(A.playerId))).code, 'PARTY_STATE');
    await c.partyLeave();
    // Left alone by the others: free again.
    const fromD = (await d.partyInvite(A.playerId)).party;
    await a.partyAccept(fromD.id);
    await a.partyLeave();
    await d.partyLeave();

    // Expired: the same.
    const stale = (await a.partyInvite(B.playerId)).party;
    w.server.game.parties.get(stale.id)!.invites[B.playerId] = Date.now() - 1;
    const fromE = (await e.partyInvite(A.playerId)).party;
    await a.partyAccept(fromE.id);
    await a.partyLeave();
    await e.partyLeave();

    // Crossed invites: whoever accepts first joins, and their own invitation lapses.
    const byB = (await b.partyInvite(C.playerId)).party;
    const byC = (await c.partyInvite(B.playerId)).party;
    await b.partyAccept(byC.id);
    assert.deepEqual((await c.party()).party!.members.map((m) => m.id).sort(), [B.playerId, C.playerId].sort());
    assert.equal((await c.observe()).partyInvites.length, 0);
    assert.equal((await err(c.partyAccept(byB.id))).code, 'NOT_FOUND');

    // A full party turns you away without costing you your own party or the invitations you sent.
    const mine = (await a.partyInvite(E.playerId)).party;
    const target = w.server.game.parties.get(byC.id)!;
    target.invites[A.playerId] = Date.now() + 60_000;
    const members = [...target.members];
    target.members.push(D.playerId, D.playerId, D.playerId);
    assert.equal((await err(a.partyAccept(byC.id))).code, 'PARTY_STATE');
    target.members = members;
    assert.equal((await a.observe()).party!.id, mine.id);
    assert.equal((await e.observe()).partyInvites[0].partyId, mine.id);
  } finally { await w.close(); }
});

test('huntBoss reports no loot, rather than throwing, when a teammate empties the spoils first', async () => {
  for (const when of ['before looting', 'while walking to the bag'] as const) {
    const w = await world();
    try {
      const c = await w.bot('Slow');
      const C = await c.whoami();
      await c.travelTo('wilds');
      const bear = bossOf(w, 'elder_bear');
      await c.goTo(bear.id);
      raw(w, C.playerId).hp = 5000;
      bear.hp = 1;
      const lootAll = c.lootAll.bind(c);
      const goTo = c.goTo.bind(c);
      c.lootAll = async (bagId) => {
        if (when === 'before looting') w.server.game.bags.delete(bagId);
        else {
          const bag = w.server.game.bags.get(bagId)!;
          bag.x = bag.x! + 4; // out of reach, so lootAll walks to it
          c.goTo = async (target, o) => { w.server.game.bags.delete(bagId); return goTo(target, o); };
        }
        return lootAll(bagId);
      };
      const r = await c.huntBoss('elder_bear');
      assert.equal(r.result, 'killed', when);
      assert.ok(r.spoilsBagId, when);
      assert.deepEqual(r.looted, [], when);
    } finally { await w.close(); }
  }
});
