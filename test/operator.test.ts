import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEATH_SILVER_LOSS, TRADE_SILVER_FEE, WEAR } from '../src/shared/catalog.ts';
import { REPEAT_THRESHOLD } from '../src/server/game.ts';
import { killPlayer } from '../src/server/world.ts';
import { world, OP } from './helpers.ts';

test('operator and bot credentials and listeners are separate', async () => {
  const w = await world();
  try {
    const a = await w.bot('Agent');
    const op = w.server.operatorUrl;
    const asBot = await fetch(`${op}/operator/state`, { headers: { authorization: `Bearer ${a.botToken}` } });
    assert.equal(asBot.status, 401);
    const none = await fetch(`${op}/operator/state`);
    assert.equal(none.status, 401);
    const asOp = await fetch(`${w.url}/api/command`, { method: 'POST', headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'c1', type: 'observe', payload: {} }) });
    assert.equal(asOp.status, 401);
    const evAsOp = await fetch(`${w.url}/api/events`, { headers: { authorization: `Bearer ${OP}` } });
    assert.equal(evAsOp.status, 401);
    const page = await fetch(`${op}/dashboard`);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes(OP), 'the page itself carries no credential');
    // The operator listener does not play; the bot listener has no operator routes at all.
    const cmdOnOp = await fetch(`${op}/api/command`, { method: 'POST', headers: { authorization: `Bearer ${a.botToken}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cmdOnOp.status, 404);
    for (const path of ['/dashboard', '/operator/state']) {
      const r = await fetch(`${w.url}${path}`, { headers: { authorization: `Bearer ${OP}` } });
      assert.equal(r.status, 404, `bot port must not serve ${path}`);
    }
  } finally { await w.close(); }
});

test('debug view lists failed commands verbatim; pending trades show submissions and locks', async () => {
  const w = await world();
  try {
    const a = await w.bot('Trader');
    const b = await w.bot('Other');
    const other = await b.whoami();
    const { trade } = await a.proposeTrade({ to: other.playerId, give: [{ item: 'silver', qty: 2 }], receive: [] });
    await b.acceptTrade(trade.id);
    await a.lockTrade(trade.id, [{ item: 'silver', qty: 2 }]);
    const again = await a.request('trade.lock', { tradeId: trade.id }, { commandId: 'second-lock' });
    assert.equal(!again.ok && again.error.code, 'TRADE_STATE', 'the bot itself gets the real reason');
    const bad = await a.request('move', { to: 'nowhere' as any }, { commandId: 'bad-move' });
    assert.equal(bad.ok, false);
    const st = await w.operator();
    const lock = st.failures.find((f: any) => f.commandId === 'second-lock');
    assert.equal(lock.code, 'TRADE_STATE');
    assert.match(lock.reason, /already locked/);
    const mv = st.failures.find((f: any) => f.commandId === 'bad-move');
    assert.equal(mv.code, 'BAD_REQUEST');
    assert.equal(mv.name, (await a.whoami()).name);
    // Nothing is hidden from the operator: last action, live trade steps, submissions and locks.
    const bot = st.bots.find((x: any) => x.id === a.playerId);
    assert.match(bot.lastAction.summary, new RegExp(`^locked ${trade.id}`));
    assert.ok(st.events.some((e: any) => e.type === 'trade.activity' && e.data.tradeId === trade.id && e.data.action === 'locked'));
    assert.equal(st.trades.pendingCount, 1);
    const [mine, theirs] = st.trades.pending[0].parties;
    assert.deepEqual(mine.submitted, [{ item: 'silver', qty: 2 }]);
    assert.equal(mine.locked, true);
    assert.equal(theirs.submitted, null);
    assert.equal(theirs.locked, false);
    assert.equal(st.trades.settled.length + st.trades.timeouts.length, 0);
  } finally { await w.close(); }
});

test('operator feed has public activity but no private player events', async () => {
  const w = await world();
  try {
    const a = await w.bot('Busy');
    await a.travelTo('wilds');
    await a.gatherItem('copper_ore', 1);
    const me = await a.whoami();
    const st = await w.operator();
    const types = new Set(st.events.map((e: any) => e.type));
    for (const t of ['travel.depart', 'travel.arrive', 'gather']) assert.ok(types.has(t), t);
    for (const t of ['self.arrived', 'self.damaged', 'dm.message', 'trade.proposed']) assert.ok(!types.has(t), t);
    const b = st.bots.find((x: any) => x.name === me.name);
    assert.equal(b.zone, 'wilds');
    assert.match(b.lastAction.summary, /gathered/);
  } finally { await w.close(); }
});

test('economy: per-bot silver, circulation, and a cumulative ledger that moves on kill, quest, shop, repair, death and trade fee', async () => {
  const w = await world();
  try {
    const g = w.server.game;
    const a = await w.bot('Banker');
    const b = await w.bot('Buyer');
    const pa = g.players.get((await a.whoami()).playerId)!;
    const pb = g.players.get((await b.whoami()).playerId)!;
    const ledger = async () => (await w.operator()).economy;
    let eco = await ledger();
    assert.deepEqual(eco.created, { mobs: 0, quests: 0 });
    assert.deepEqual(eco.destroyed, { death: 0, repair: 0, shop: 0, tradeFee: 0 });

    // Kill: silver looted from mobs is created.
    pa.inventory.copper_sword = 1;
    await a.equip('copper_sword');
    await a.travelTo('wilds');
    const wolf = (await a.observe()).zone!.mobs.find((m) => m.type === 'wolf' && m.alive)!;
    await a.fight(wolf.id);
    const kill = (await w.operator()).events.find((e: any) => e.type === 'combat.kill' && e.data.killerId === pa.id);
    const looted = kill.data.loot.filter((s: any) => s.item === 'silver').reduce((n: number, s: any) => n + s.qty, 0);
    assert.ok(looted > 0);
    assert.equal((await ledger()).created.mobs, looted);
    await a.travelTo('town');

    // Quest reward silver is created.
    await a.acceptQuest('wolf_cull');
    pa.quests.wolf_cull = { status: 'complete', progress: 3 };
    await a.claimQuest('wolf_cull');
    assert.equal((await ledger()).created.quests, 30);

    // Shop and repair payments are destroyed.
    pa.inventory.silver = 200;
    assert.equal((await a.buy('copper_pickaxe')).paid, 60);
    pa.wear = { copper_sword: WEAR.max };
    const fixed = await a.repair();
    assert.ok(fixed.paid > 0);
    eco = await ledger();
    assert.equal(eco.destroyed.shop, 60);
    assert.equal(eco.destroyed.repair, fixed.paid);

    // Death destroys a share of carried silver.
    pb.inventory.silver = 40;
    g.store.transaction(() => killPlayer(g, pb, { kind: 'mob', id: 'm_test', name: 'Test' }));
    assert.equal((await ledger()).destroyed.death, Math.floor(40 * DEATH_SILVER_LOSS));

    // Trade fee on silver received; trade.closed carries it per party.
    const { trade } = await a.proposeTrade({ to: pb.id, give: [{ item: 'silver', qty: 50 }], receive: [{ item: 'copper_pickaxe', qty: 1 }] });
    pb.inventory.copper_pickaxe = 1;
    await b.acceptTrade(trade.id);
    await a.lockTrade(trade.id, [{ item: 'silver', qty: 50 }]);
    await b.lockTrade(trade.id, [{ item: 'copper_pickaxe', qty: 1 }]);
    const st = await w.operator();
    const fee = Math.max(1, Math.floor(50 * TRADE_SILVER_FEE));
    assert.equal(st.economy.destroyed.tradeFee, fee);
    const closed = st.trades.settled.find((t: any) => t.tradeId === trade.id);
    assert.deepEqual(closed.parties.map((p: any) => [p.name, p.silverFee]), [[pa.name, 0], [pb.name, fee]]);

    // Circulation matches each bot's carried and banked silver.
    pa.bank.silver = 7;
    const now = await w.operator();
    const ba = now.bots.find((x: any) => x.id === pa.id);
    assert.deepEqual(ba.silver, { carried: pa.inventory.silver, banked: 7 });
    const carried = now.bots.reduce((n: number, x: any) => n + x.silver.carried, 0);
    const banked = now.bots.reduce((n: number, x: any) => n + x.silver.banked, 0);
    assert.deepEqual(now.economy.circulation, { carried, banked, total: carried + banked });
  } finally { await w.close(); }
});

test('economy ledger is backfilled once from retained events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-ledger-'));
  const w1 = await world({ dir });
  try {
    const g = w1.server.game;
    const ev = (id: number, type: string, data: unknown) => g.store.run('INSERT INTO events(id, ts, type, data) VALUES(?, ?, ?, ?)', id, 1000 + id, type, JSON.stringify({ id, ts: 1000 + id, type, data }));
    ev(9_000_001, 'combat.kill', { loot: [{ item: 'rough_hide', qty: 1 }, { item: 'silver', qty: 8 }] });
    ev(9_000_002, 'quest', { status: 'claimed', reward: [{ item: 'silver', qty: 30 }] });
    ev(9_000_003, 'player.death', { silverLost: 5 });
    ev(9_000_004, 'trade.closed', { outcome: 'settled', parties: [{ received: [{ item: 'silver', qty: 100 }] }, { received: [{ item: 'rough_hide', qty: 2 }] }] });
    g.store.run('DELETE FROM economy_ledger');
    g.store.run("DELETE FROM meta WHERE key = 'economy_since'");
  } finally { await w1.close({ keepDir: true }); }
  const w2 = await world({ dir });
  try {
    const eco = (await w2.operator()).economy;
    assert.deepEqual(eco.created, { mobs: 8, quests: 30 });
    assert.deepEqual(eco.destroyed, { death: 5, repair: 0, shop: 0, tradeFee: Math.max(1, Math.floor(100 * TRADE_SILVER_FEE)) });
  } finally { await w2.close(); }
});

test('failureSummary groups by bot, command and code, and flags a current streak', async () => {
  const w = await world();
  try {
    const c = await w.bot('Stubborn');
    const id = (await c.whoami()).playerId;
    await c.travelTo('wilds');
    const iron = (await c.observe()).zone!.nodes.find((n) => n.item === 'iron_ore')!;
    for (let i = 0; i < 2; i++) await c.request('gather', { nodeId: iron.id });
    await c.request('move', { to: 'nowhere' as any });
    for (let i = 0; i < REPEAT_THRESHOLD; i++) await c.request('gather', { nodeId: iron.id });
    let st = await w.operator();
    const mine = st.failureSummary.filter((f: any) => f.playerId === id);
    const gather = mine.find((f: any) => f.type === 'gather' && f.code === 'TOOL_REQUIRED');
    assert.equal(gather.count, 2 + REPEAT_THRESHOLD);
    assert.equal(gather.streak, true);
    assert.equal(gather.streakLength, REPEAT_THRESHOLD);
    assert.ok(gather.firstTs <= gather.lastTs);
    assert.match(gather.latestReason, /mining tool/);
    const move = mine.find((f: any) => f.type === 'move' && f.code === 'BAD_REQUEST');
    assert.equal(move.count, 1);
    assert.equal(move.streak, false);
    assert.equal(mine[0], gather, 'sorted by count');
    const bot = st.bots.find((x: any) => x.id === id);
    assert.equal(bot.failureRate.failures, 3 + REPEAT_THRESHOLD);
    assert.ok(Array.isArray(st.forumAds));
    assert.ok(bot.failureRate.attempts > bot.failureRate.failures);
    // A successful write ends the streak, as it does in the game.
    await c.travelTo('town');
    st = await w.operator();
    assert.equal(st.failureSummary.find((f: any) => f.playerId === id && f.type === 'gather').streak, false);
  } finally { await w.close(); }
});
