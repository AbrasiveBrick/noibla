import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, OP } from './helpers.ts';

test('operator and bot credentials are separate', async () => {
  const w = await world();
  try {
    const a = await w.bot('Agent');
    const asBot = await fetch(`${w.url}/operator/state`, { headers: { authorization: `Bearer ${a.botToken}` } });
    assert.equal(asBot.status, 401);
    const none = await fetch(`${w.url}/operator/state`);
    assert.equal(none.status, 401);
    const asOp = await fetch(`${w.url}/api/command`, { method: 'POST', headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'c1', type: 'observe', payload: {} }) });
    assert.equal(asOp.status, 401);
    const evAsOp = await fetch(`${w.url}/api/events`, { headers: { authorization: `Bearer ${OP}` } });
    assert.equal(evAsOp.status, 401);
    const page = await fetch(`${w.url}/dashboard`);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes(OP), 'the page itself carries no credential');
  } finally { await w.close(); }
});

test('debug view lists failed commands with bot and command ids, redacting pending-trade details', async () => {
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
    assert.equal(lock.code, 'TRADE_REJECTED');
    assert.match(lock.reason, /redacted/);
    assert.ok(!/already locked/i.test(JSON.stringify(st)));
    const mv = st.failures.find((f: any) => f.commandId === 'bad-move');
    assert.equal(mv.code, 'BAD_REQUEST');
    assert.equal(mv.name, (await a.whoami()).name);
    // World view: last action for trade work stays generic.
    const bot = st.bots.find((x: any) => x.id === a.playerId);
    assert.equal(bot.lastAction.summary, 'trade activity');
    // Pending trades appear only as a count.
    assert.equal(st.trades.pendingCount, 1);
    assert.equal(st.trades.settled.length + st.trades.timeouts.length, 0);
    assert.ok(!JSON.stringify(st).includes(trade.id));
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
