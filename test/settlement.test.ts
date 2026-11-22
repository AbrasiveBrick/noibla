import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DEATH_SILVER_LOSS, QUESTS, SETTLEMENT, ZONES, type ZoneId } from '../src/shared/catalog.ts';
import { MAP_RULES, dist, regionAt, walkable, type Pos, type WorldMap } from '../src/shared/map.ts';
import type { CommandError } from '../src/sdk/index.ts';
import type { Player, Settlement } from '../src/server/types.ts';
import { attach, wait, world } from './helpers.ts';

type W = Awaited<ReturnType<typeof world>>;
type Bot = Awaited<ReturnType<W['bot']>>;
const raw = (w: W, id: string): Player => w.server.game.players.get(id)!;
const stored = (w: W, id: string): Settlement => w.server.game.settlements.get(id)!;
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CommandError; } assert.fail('expected the command to fail'); };
const code = async (p: Promise<unknown>) => (await err(p)).code;
const give = (w: W, id: string, items: Record<string, number>) => { const inv = raw(w, id).inventory; for (const [k, n] of Object.entries(items)) inv[k] = (inv[k] ?? 0) + n; };
const cost = Object.fromEntries(SETTLEMENT.foundCost.map((s) => [s.item, s.qty]));

/** Puts a player straight on a tile (walking is not what these tests are about). */
function place(w: W, id: string, pos: Pos) {
  const p = raw(w, id);
  p.travel = null;
  p.pos = { x: pos.x, y: pos.y };
  p.zone = regionAt(w.server.game.map, pos);
}

/** An open tile of `region` at least `min` and at most `max` tiles from `from`. */
function tileNear(m: WorldMap, from: Pos, region: ZoneId, min: number, max: number): Pos {
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    const d = dist({ x, y }, from);
    if (d >= min && d <= max && walkable(m, x, y) && regionAt(m, { x, y }) === region) return { x, y };
  }
  assert.fail(`no tile of ${region} there`);
}

/** A settlement founded by the first bot and joined by the others. Everyone ends at the plot. */
async function settled(w: W, names: string[], region: ZoneId = 'hollow') {
  const bots: Bot[] = [];
  const ids: string[] = [];
  for (const n of names) { const b = await w.bot(n); bots.push(b); ids.push((await b.whoami()).playerId); }
  const plot = w.server.game.map.plots.find((pl) => pl.region === region)!;
  ids.forEach((id) => place(w, id, plot));
  give(w, ids[0], cost);
  const { settlement } = await bots[0].settlementFound(`${names[0]} Hold`, plot.id);
  for (let i = 1; i < bots.length; i++) {
    await bots[0].settlementInvite(ids[i]);
    await bots[i].settlementJoin(settlement.id);
  }
  return { bots, ids, plot, id: settlement.id };
}

test('contested regions: PvP is allowed, death drops everything, and whoever is present sees it', async () => {
  const w = await world();
  try {
    for (const zone of ['hollow', 'ridge'] as const) {
      assert.equal(ZONES[zone].safety, 'contested');
      const killer = await w.bot('Killer'); const victim = await w.bot('Victim'); const witness = await w.bot('Witness');
      const K = (await killer.whoami()).playerId; const V = (await victim.whoami()).playerId; const S = (await witness.whoami()).playerId;
      const at = w.server.game.map.anchors[zone];
      for (const id of [K, V, S]) place(w, id, at);
      give(w, V, { silver: 100, stone: 7 });
      const carried = raw(w, V).inventory.silver;
      raw(w, V).hp = 1;
      const seen = witness.waitForEvent((e) => e.type === 'player.death' && e.data.victimId === V, 5000);
      assert.ok((await killer.attack(V)).killed, zone);
      const death = (await seen).data;
      assert.equal(death.killerId, K);
      assert.equal(death.fullLoot, true);
      const bag = w.server.game.bags.get(death.bagId)!;
      assert.equal(bag.items.stone, 7);
      assert.equal(bag.items.silver, carried - Math.floor(carried * DEATH_SILVER_LOSS));
      assert.deepEqual(raw(w, V).inventory, {});
      assert.equal(raw(w, V).zone, 'town');
    }
  } finally { await w.close(); }
});

test('founding: a free plot in a contested region, paid in silver, planks and stone', async () => {
  const w = await world();
  try {
    const a = await w.bot('Founder'); const b = await w.bot('Rival'); const witness = await w.bot('Passerby');
    const A = (await a.whoami()).playerId; const B = (await b.whoami()).playerId;
    const m = await a.map();
    for (const z of Object.values(ZONES)) assert.equal(m.plots.filter((pl) => pl.region === z.id).length, z.plots, z.id);
    give(w, A, cost); give(w, B, cost);

    assert.equal(await code(a.settlementFound('Too Soon')), 'WRONG_ZONE', 'not in town');
    const plot = m.plots.find((pl) => pl.region === 'hollow')!;
    place(w, A, tileNear(m, plot, 'hollow', MAP_RULES.range.plot + 0.5, 99));
    assert.equal(await code(a.settlementFound('Too Far', plot.id)), 'OUT_OF_RANGE');
    assert.equal(await code(a.settlementFound('!')), 'BAD_REQUEST');
    assert.equal(await code(a.settlementFound('Nowhere', 'plot_town_1')), 'NOT_FOUND');

    place(w, A, plot);
    raw(w, A).inventory.stone--;
    assert.equal(await code(a.settlementFound('Too Poor', plot.id)), 'NOT_ENOUGH_ITEMS');
    assert.equal(w.server.game.settlements.size, 0);
    raw(w, A).inventory.stone++;

    place(w, (await witness.whoami()).playerId, m.anchors.hollow);
    const seen = witness.waitForEvent((e) => e.type === 'settlement.founded', 5000);
    const before = { ...raw(w, A).inventory };
    const { settlement, paid } = await a.settlementFound('Moss End', plot.id);
    assert.equal(settlement.yourRole, 'leader');
    assert.deepEqual(settlement.charter, SETTLEMENT.defaultCharter);
    assert.deepEqual(paid.map((s) => s.item).sort(), Object.keys(cost).sort());
    for (const [item, n] of Object.entries(cost)) assert.equal(raw(w, A).inventory[item] ?? 0, before[item] - n, item);
    assert.equal((await w.operator()).economy.destroyed.settlement, cost.silver);
    assert.equal((await seen).data.founderId, A, 'whoever is present witnesses the founding');

    place(w, B, plot);
    assert.equal(await code(b.settlementFound('Second', plot.id)), 'SETTLEMENT_STATE', 'the plot is taken');
    assert.equal((await b.observe()).zone.plots.find((pl) => pl.id === plot.id)!.settlement!.name, 'Moss End');
    const other = m.plots.find((pl) => pl.region === 'hollow' && pl.id !== plot.id)!;
    place(w, B, other);
    assert.equal(await code(b.settlementFound('moss end', other.id)), 'NAME_TAKEN');
    give(w, A, cost);
    place(w, A, other);
    assert.equal(await code(a.settlementFound('Another', other.id)), 'SETTLEMENT_STATE', 'one settlement per player');

    // The helper walks there for real, and skips plots that are taken.
    place(w, B, m.anchors.hollow);
    const mine = await b.foundSettlement('Fern Hall', 'hollow');
    assert.notEqual(mine.plotId, plot.id);
    assert.equal((await b.observe()).self.zone, 'hollow');
  } finally { await w.close(); }
});

test('membership: invitations, open membership, roles, expulsion and the charter', async () => {
  const w = await world();
  try {
    const { bots: [lead, stew, mem], ids: [L, S, M], id } = await settled(w, ['Lead', 'Stew', 'Mem']);
    const joiner = await w.bot('Joiner');
    const J = (await joiner.whoami()).playerId;

    assert.equal(await code(joiner.settlementJoin(id)), 'FORBIDDEN', 'closed by default');
    assert.equal(await code(mem.settlementInvite(J)), 'FORBIDDEN');
    assert.equal(await code(mem.settlementSetCharter({ open: true })), 'FORBIDDEN');
    assert.equal(await code(mem.settlementSetRole(S, 'steward')), 'FORBIDDEN');
    assert.equal(await code(mem.settlementExpel(S)), 'FORBIDDEN');

    await lead.settlementSetRole(S, 'steward');
    assert.equal((await stew.observe()).settlement!.role, 'steward');
    assert.equal(await code(stew.settlementSetCharter({ taxPct: 5 })), 'FORBIDDEN', 'the charter is the leader\'s');
    assert.equal(await code(stew.settlementExpel(L)), 'FORBIDDEN', 'not a higher role');

    // A steward invites; an invitation can be declined.
    await stew.settlementInvite(J);
    assert.equal((await joiner.observe()).settlementInvites[0].settlementId, id);
    await joiner.settlementDecline(id);
    assert.equal((await joiner.settlement()).invites.length, 0);
    await stew.settlementInvite(J);
    assert.equal(await joiner.acceptSettlementInvite(), id);
    assert.equal((await joiner.settlement()).settlement!.members.length, 4);

    // An expired invitation is no invitation.
    const late = await w.bot('Late');
    const T = (await late.whoami()).playerId;
    await lead.settlementInvite(T);
    stored(w, id).invites[T] = w.server.game.now() - 1;
    assert.equal(await code(late.settlementJoin(id)), 'FORBIDDEN');

    assert.equal(await code(lead.settlementSetCharter({ taxPct: SETTLEMENT.maxTaxPct + 1 })), 'BAD_REQUEST');
    assert.equal(await code(lead.settlementSetCharter({ withdrawRole: 'king' as any })), 'BAD_REQUEST');
    const c = (await lead.settlementSetCharter({ open: true })).settlement.charter;
    assert.deepEqual(c, { ...SETTLEMENT.defaultCharter, open: true }, 'omitted fields keep their value');
    await late.settlementJoin(id);

    // The expelled cannot walk back into an open settlement.
    const told = late.waitForEvent((e) => e.type === 'settlement.left' && e.data.reason === 'expel', 5000);
    await stew.settlementExpel(T);
    await told;
    assert.equal((await late.observe()).settlement, null);
    assert.equal(await code(late.settlementJoin(id)), 'FORBIDDEN');
    await lead.settlementInvite(T);
    await late.settlementJoin(id);

    // Handover, then succession: the steward before the members.
    await lead.settlementSetRole(M, 'leader');
    assert.equal((await lead.observe()).settlement!.role, 'steward');
    assert.equal((await mem.observe()).settlement!.role, 'leader');
    await mem.settlementLeave();
    const roles = (await lead.settlement()).settlement!.members.map((x) => x.role);
    assert.equal(roles.filter((r) => r === 'leader').length, 1);
    assert.equal((await lead.observe()).settlement!.role, 'leader', 'the longest-standing steward succeeds');
  } finally { await w.close(); }
});

test('membership: a settlement has a size limit', async () => {
  const w = await world();
  try {
    const { bots: [lead], id } = await settled(w, ['Full']);
    const s = stored(w, id);
    for (let i = 1; i < SETTLEMENT.maxMembers; i++) s.members[`p_filler${i}`] = { role: 'member', joinedAt: i };
    const extra = await w.bot('Extra');
    const E = (await extra.whoami()).playerId;
    assert.equal(await code(lead.settlementInvite(E)), 'SETTLEMENT_STATE');
    s.charter.open = true;
    assert.equal(await code(extra.settlementJoin(id)), 'SETTLEMENT_STATE');
  } finally { await w.close(); }
});

test('stockpile: only at the plot, withdrawals follow the charter, and every change is logged with its actor', async () => {
  const w = await world();
  try {
    const { bots: [lead, stew, mem], ids: [L, S, M], plot, id } = await settled(w, ['Boss', 'Keeper', 'Hand']);
    await lead.settlementSetRole(S, 'steward');
    give(w, M, { stone: 10, 'iron_sword#0a1b2c3d': 1 });

    const m = w.server.game.map;
    place(w, M, tileNear(m, plot, 'hollow', MAP_RULES.range.plot + 0.5, 99));
    assert.equal(await code(mem.stockpileDeposit([{ item: 'stone', qty: 1 }])), 'OUT_OF_RANGE');
    assert.equal(await code(mem.stockpile()), 'OUT_OF_RANGE');
    // A plot by the border is not reachable from the safe wilds, even within range.
    const moved = m.plots.find((pl) => pl.id === plot.id)!;
    const was = moved.y;
    moved.y = m.regions.find((r) => r.id === 'hollow')!.y1;
    place(w, M, tileNear(m, moved, 'wilds', 0, MAP_RULES.range.plot));
    assert.equal(await code(mem.stockpile()), 'OUT_OF_RANGE', 'same range, wrong region');
    moved.y = was;

    place(w, M, plot);
    await mem.stockpileDeposit([{ item: 'stone', qty: 8 }, { item: 'iron_sword#0a1b2c3d', qty: 1 }]);
    assert.equal(raw(w, M).inventory.stone, 2);
    assert.equal(stored(w, id).stockpile.stone, 8);
    assert.equal(await code(mem.stockpileWithdraw([{ item: 'stone', qty: 1 }])), 'FORBIDDEN', 'members cannot withdraw by default');
    await stew.stockpileWithdraw([{ item: 'stone', qty: 3 }]);
    assert.equal(await code(stew.stockpileWithdraw([{ item: 'stone', qty: 99 }])), 'NOT_ENOUGH_ITEMS');
    await lead.settlementSetCharter({ withdrawRole: 'leader' });
    assert.equal(await code(stew.stockpileWithdraw([{ item: 'stone', qty: 1 }])), 'FORBIDDEN');
    await lead.stockpileWithdraw([{ item: 'stone', qty: 1 }]);
    await lead.settlementSetCharter({ withdrawRole: 'member' });
    await mem.stockpileWithdraw([{ item: 'iron_sword#0a1b2c3d', qty: 1 }]);
    assert.equal(raw(w, M).inventory['iron_sword#0a1b2c3d'], 1);

    const view = await mem.stockpile();
    assert.deepEqual(view.items, [{ item: 'stone', qty: 4 }]);
    const { entries } = await mem.stockpileLog();
    assert.deepEqual(entries.map((e) => [e.action, e.actorId]), [['withdraw', M], ['withdraw', L], ['withdraw', S], ['deposit', M]], 'newest first, failures not logged');
    assert.deepEqual(view.log, entries);
    assert.deepEqual(entries[2].items, [{ item: 'stone', qty: 3 }]);
    const page = (await mem.stockpileLog({ limit: 2, beforeId: entries[0].id })).entries;
    assert.deepEqual(page, entries.slice(1, 3));

    // The log is readable from anywhere, the contents only at the plot.
    place(w, M, m.spawn);
    assert.equal((await mem.stockpileLog()).entries.length, 4);
    assert.equal(await code(mem.stockpile()), 'OUT_OF_RANGE');

    // A retry changes nothing and logs nothing.
    const again = [{ item: 'stone', qty: 1 }];
    await stew.stockpileWithdraw(again, { commandId: 'same-withdrawal' });
    await stew.stockpileWithdraw(again, { commandId: 'same-withdrawal' });
    assert.equal(stored(w, id).stockpile.stone, 3);
    assert.equal((await stew.stockpileLog()).entries.length, 5);
  } finally { await w.close(); }
});

test('stockpile: a change that cannot be logged does not happen', async () => {
  const w = await world();
  try {
    const { bots: [lead], ids: [L], id } = await settled(w, ['Atomic']);
    give(w, L, { stone: 5 });
    await lead.stockpileDeposit([{ item: 'stone', qty: 2 }]);
    w.server.game.store.db.exec("CREATE TEMP TRIGGER no_log BEFORE INSERT ON stockpile_log BEGIN SELECT RAISE(ABORT, 'log down'); END");
    const r = await lead.request('stockpile.deposit', { items: [{ item: 'stone', qty: 3 }] });
    assert.equal(!r.ok && r.error.code, 'INTERNAL');
    assert.equal(stored(w, id).stockpile.stone, 2);
    assert.equal(raw(w, L).inventory.stone, 3);
  } finally { await w.close(); }
});

test('votes: more than half of all members exile a member or replace the leader', async () => {
  const w = await world();
  try {
    const { bots: [lead, a, b, c], ids: [L, A, B, C], id } = await settled(w, ['Tyrant', 'Ann', 'Ben', 'Cal']);

    let r = await a.settlementVote('leader', A);
    assert.equal(r.passed, false);
    assert.equal(r.motion.needed, 3);
    r = await b.settlementVote('leader', A);
    assert.equal(r.passed, false, 'half is not a majority');
    await b.settlementVote('leader', A, false);
    assert.equal((await lead.settlement()).settlement!.motions[0].no, 1, 'votes can change');
    await b.settlementVote('leader', A);
    r = await c.settlementVote('leader', A);
    assert.equal(r.passed, true);
    assert.equal((await a.observe()).settlement!.role, 'leader');
    assert.equal((await lead.observe()).settlement!.role, 'member', 'deposed');

    assert.equal(await code(lead.settlementVote('exile', L)), 'BAD_REQUEST', 'no voting for your own exile');
    await a.settlementVote('exile', L);
    r = await lead.settlementVote('exile', L, false);
    assert.equal(r.motion.no, 1, 'the target may vote against it');
    await b.settlementVote('exile', L);
    const told = lead.waitForEvent((e) => e.type === 'settlement.left' && e.data.reason === 'exile', 5000);
    assert.equal((await c.settlementVote('exile', L)).passed, true);
    await told;
    assert.equal((await lead.observe()).settlement, null);
    stored(w, id).charter.open = true;
    assert.equal(await code(lead.settlementJoin(id)), 'FORBIDDEN', 'exile bars open rejoining');

    // A majority can exile the leader too; someone takes over.
    await b.settlementVote('exile', A);
    assert.equal((await c.settlementVote('exile', A)).passed, true);
    const left = (await b.settlement()).settlement!.members;
    assert.deepEqual(left.map((x) => x.id).sort(), [B, C].sort());
    assert.equal(left.filter((x) => x.role === 'leader').length, 1);

    // In a pair neither can exile the other.
    assert.equal((await b.settlementVote('exile', C)).passed, false);
    // Motions expire.
    stored(w, id).motions[0].expiresAt = w.server.game.now() - 1;
    assert.equal((await b.settlement()).settlement!.motions.length, 0);
  } finally { await w.close(); }
});

test('votes: a motion the new leader no longer needs cannot restore them later', async () => {
  const w = await world();
  try {
    const { bots: [lead, a, b], ids: [, A, B], id } = await settled(w, ['Elder', 'Heir', 'Challenger']);
    await a.settlementVote('leader', A);
    await lead.settlementSetRole(A, 'leader');
    assert.equal(stored(w, id).motions.length, 0);
    await b.settlementVote('leader', B);
    assert.equal((await lead.settlementVote('leader', B)).passed, true);
    assert.equal((await b.observe()).settlement!.role, 'leader');
  } finally { await w.close(); }
});

test('tax: the charter share of members\' quest silver goes into the stockpile and the log', async () => {
  const w = await world();
  try {
    const { bots: [lead, mem], ids: [, M], id } = await settled(w, ['Collector', 'Earner']);
    const free = await w.bot('Untaxed');
    const F = (await free.whoami()).playerId;
    await lead.settlementSetCharter({ taxPct: 20 });
    const reward = QUESTS.wolf_cull.reward.find((s) => s.item === 'silver')!.qty;
    const tax = Math.floor(reward * 0.2);
    for (const p of [M, F]) {
      raw(w, p).quests.wolf_cull = { status: 'complete', progress: 3 };
      place(w, p, w.server.game.map.spawn);
    }
    const had = raw(w, M).inventory.silver;
    const got = await mem.claimQuest('wolf_cull');
    assert.equal(got.tax, tax);
    assert.equal(raw(w, M).inventory.silver, had + reward - tax);
    assert.equal(stored(w, id).stockpile.silver, tax);
    const [entry] = (await lead.stockpileLog()).entries;
    assert.deepEqual([entry.action, entry.actorId, entry.items], ['tax', M, [{ item: 'silver', qty: tax }]]);
    assert.equal((await free.claimQuest('wolf_cull')).tax, undefined);
    assert.equal((await w.operator()).economy.circulation.stockpiled, tax);
  } finally { await w.close(); }
});

test('secrecy: outsiders, invitees and ex-members learn nothing through any command or event', async () => {
  const w = await world();
  try {
    const { bots: [lead, mate, ex], ids: [L, T, X], plot, id } = await settled(w, ['Secretive', 'Accomplice', 'Former']);
    const spy = await w.bot('Spy'); const invitee = await w.bot('Invitee');
    const P = (await spy.whoami()).playerId; const I = (await invitee.whoami()).playerId;
    await ex.settlementLeave();
    await lead.settlementInvite(I);
    // Standing on the plot itself, next to the members, is the best an outsider can do.
    for (const p of [P, I, X]) place(w, p, plot);
    await wait(80);
    const outsiders = [[spy, P], [invitee, I], [ex, X]] as const;
    for (const [o] of outsiders) o.received.length = 0;

    const SECRET_QTY = 17351, SECRET_ID = 'iron_mail#deadbeef';
    give(w, L, { grain: SECRET_QTY, [SECRET_ID]: 1 });
    const memberSees = mate.waitForEvent((e) => e.type === 'stockpile.changed', 5000);
    await lead.stockpileDeposit([{ item: 'grain', qty: SECRET_QTY }, { item: SECRET_ID, qty: 1 }]);
    await memberSees;
    await lead.settlementSetCharter({ taxPct: 37 });
    await lead.settlementSetRole(T, 'steward');
    const { motion } = await mate.settlementVote('exile', L);
    await wait(80);

    const leaks = (what: string, data: unknown) => {
      const text = JSON.stringify(data) ?? '';
      // As a whole number: timestamps and ids contain every short digit run sooner or later.
      assert.doesNotMatch(text, new RegExp(`(?<![0-9a-f])${SECRET_QTY}(?![0-9a-f])`), `${what} leaks the amount`);
      for (const secret of [SECRET_ID, motion.id, '"taxPct":37', '"yourRole"', '"role":"steward"']) assert.ok(!text.includes(secret), `${what} leaks ${secret}`);
    };
    const refused = ['settlement.invite', 'settlement.leave', 'settlement.expel', 'settlement.setRole', 'settlement.setCharter', 'settlement.vote', 'stockpile.deposit', 'stockpile.withdraw', 'stockpile.view', 'stockpile.log'];
    const payload = {
      settlementId: id, id, playerId: L, targetId: T, to: T, with: L, name: 'Mirror', plotId: plot.id, bagId: id, tradeId: id, partyId: id,
      // Never a secret itself, so that any secret in a response is a leak and not an echo of the question.
      channel: `settlement:${id}`, item: 'grain', items: [{ item: 'grain', qty: 1 }], kind: 'exile', role: 'member', open: true,
    };
    for (const [bot, who] of outsiders) {
      for (const type of Object.keys(w.server.game.commands)) {
        // Joining is the invitee's right; settlement.join is checked on its own below.
        if (type === 'settlement.join' || type === 'settlement.decline') continue;
        const r: any = await bot.request(type as any, payload as any);
        assert.notEqual(r.error?.code, 'RATE_LIMITED', `${type} was not really tried`);
        if (refused.includes(type)) assert.equal(r.error?.code, 'SETTLEMENT_STATE', `${type} must refuse non-members`);
        if (type === 'settlement.view') assert.equal(r.result.settlement, null);
        leaks(`${type} for ${raw(w, who).name}`, r);
        place(w, who, plot);
        raw(w, who).busyUntil = 0;
      }
      assert.equal(await code(bot.stockpileLog({ beforeId: 999999 })), 'SETTLEMENT_STATE');
      assert.equal(await code(bot.stockpile()), 'SETTLEMENT_STATE');
    }
    assert.equal(await code(spy.settlementJoin(id)), 'FORBIDDEN');
    assert.equal(await code(ex.settlementJoin(id)), 'FORBIDDEN');

    assert.deepEqual((await spy.settlements()).settlements, [{ id, name: 'Secretive Hold', zone: 'hollow', members: 2, level: 1 }], 'the public list has nothing else');
    await wait(80);
    for (const [bot, who] of outsiders) {
      const secretTypes = bot.received.filter((e) => (e.type.startsWith('settlement.') || e.type.startsWith('stockpile.')) && e.data.settlementId === id);
      assert.deepEqual(secretTypes.map((e) => e.type), [], `${raw(w, who).name} got member events`);
      leaks(`events of ${raw(w, who).name}`, bot.received);
    }

    // Members got them, and so does the operator.
    assert.ok(mate.received.some((e) => e.type === 'stockpile.changed' && e.data.entry.items.some((s: any) => s.qty === SECRET_QTY)));
    const op = (await w.operator()).events;
    assert.ok(op.some((e: any) => e.type === 'stockpile.changed' && e.data.entry.actorId === L));
    assert.ok(op.some((e: any) => e.type === 'settlement.vote'));
  } finally { await w.close(); }
});

test('abandonment: the last member out spills the stockpile at the plot and frees it', async () => {
  const w = await world();
  try {
    const { bots: [last], ids: [L], plot, id } = await settled(w, ['Last'], 'ridge');
    give(w, L, { stone: 6 });
    await last.stockpileDeposit([{ item: 'stone', qty: 6 }]);
    const next = await w.bot('Next');
    const N = (await next.whoami()).playerId;
    place(w, N, plot);
    assert.equal((await last.settlementLeave()).disbanded, true);
    assert.equal(w.server.game.settlements.has(id), false);
    const seen = await next.observe();
    assert.equal(seen.zone.plots.find((pl) => pl.id === plot.id)!.settlement, null);
    const bag = seen.zone.lootBags.find((b) => b.ownerId === id)!;
    assert.deepEqual(bag.items, [{ item: 'stone', qty: 6 }]);
    await next.lootAll(bag.id);
    assert.equal(raw(w, N).inventory.stone, 6);
    give(w, N, cost);
    await next.settlementFound('New Start', plot.id);
  } finally { await w.close(); }
});

test('settlements, stockpiles and the audit log survive a restart', async () => {
  const w1 = await world();
  const { bots: [lead, mem], ids: [, M], id } = await settled(w1, ['Durable', 'Steady']);
  give(w1, M, { stone: 4 });
  await mem.stockpileDeposit([{ item: 'stone', qty: 4 }]);
  await lead.settlementSetCharter({ taxPct: 12 });
  await mem.settlementVote('exile', (await lead.whoami()).playerId);
  await w1.close({ keepDir: true });
  const w2 = await world({ dir: w1.dir });
  try {
    const m2 = attach(w2.url, mem.botToken);
    const s = (await m2.settlement()).settlement!;
    assert.equal(s.id, id);
    assert.equal(s.charter.taxPct, 12);
    assert.equal(s.members.length, 2);
    assert.equal(s.motions.length, 1);
    const pile = await m2.stockpile();
    assert.deepEqual(pile.items, [{ item: 'stone', qty: 4 }]);
    assert.equal(pile.log[0].actorId, M);
  } finally { await w2.close(); }
});

test('a world saved on the three-band map loads with everyone still in their region', async () => {
  const w1 = await world();
  const saved: { id: string; zone: ZoneId; pos: Pos; travel?: unknown }[] = [];
  const x = Math.round(w1.server.game.map.anchors.wilds.x);
  const last = w1.server.game.map.width - 2;
  // The old map was 24 rows high and the wilds were a full band: north and south of today's wilds were safe then.
  for (const [zone, pos] of [
    ['wilds', { x, y: 2 }], ['wilds', { x, y: 23 }], ['wilds', { x, y: 12 }], ['town', { x: 3, y: 1 }], ['frontier', { x: last, y: 20 }], ['wilds', { x: 2, y: 2 }],
  ] as [ZoneId, Pos][]) saved.push({ id: (await (await w1.bot('Old')).whoami()).playerId, zone, pos });
  saved[2].travel = { from: 'wilds', to: 'wilds', path: [{ x, y: 12 }, { x, y: 1 }], departAt: Date.now(), arriveAt: Date.now() + 600_000, msPerTile: 50_000 };
  await w1.close({ keepDir: true });

  const db = new DatabaseSync(join(w1.dir, 'world.db'));
  for (const s of saved) {
    const p = JSON.parse((db.prepare('SELECT data FROM players WHERE id = ?').get(s.id) as { data: string }).data);
    db.prepare('UPDATE players SET data = ? WHERE id = ?').run(JSON.stringify({ ...p, zone: s.zone, pos: s.pos, travel: s.travel ?? null }), s.id);
  }
  const bag = { id: 'bag_old', zone: 'wilds', x, y: 2, ownerId: saved[0].id, ownerName: 'Old', items: { stone: 1 }, createdAt: Date.now(), expiresAt: Date.now() + 600_000 };
  db.prepare('INSERT INTO loot_bags(id, data) VALUES(?, ?)').run(bag.id, JSON.stringify(bag));
  db.exec("DELETE FROM meta WHERE key = 'map_layout'; DROP TABLE settlements; DROP TABLE stockpile_log;");
  db.close();

  const check = (w: W) => {
    const g = w.server.game;
    for (const s of saved) {
      const p = raw(w, s.id);
      assert.equal(p.zone, s.zone, `${s.zone} ${JSON.stringify(s.pos)}`);
      assert.equal(regionAt(g.map, p.pos), s.zone);
      assert.ok(walkable(g.map, p.pos.x, p.pos.y));
      assert.equal(p.travel, null);
    }
    const b = g.bags.get('bag_old')!;
    assert.equal(b.zone, 'wilds');
    assert.equal(regionAt(g.map, { x: b.x!, y: b.y! }), 'wilds');
  };
  const w2 = await world({ dir: w1.dir });
  check(w2);
  await w2.close({ keepDir: true });
  // The move was saved, so the next restart keeps it.
  const w3 = await world({ dir: w1.dir });
  try { check(w3); } finally { await w3.close(); }
});
