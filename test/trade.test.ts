import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, wait } from './helpers.ts';

const silver = (n: number) => [{ item: 'silver', qty: n }];

test('blind trade settles whatever was locked, even a broken promise, and receipts stay private', async () => {
  const w = await world();
  try {
    const a = await w.bot('Alice');
    const b = await w.bot('Bob');
    const bob = await b.whoami();
    const alice = await a.whoami();
    // Alice promises 10 silver for 5 of Bob's silver; she will send nothing.
    const { trade } = await a.proposeTrade({ to: bob.playerId, give: silver(10), receive: silver(5) });
    await b.acceptTrade(trade.id);
    const lockA = await a.lockTrade(trade.id, []);
    assert.equal(lockA.receipt, null);
    assert.equal(lockA.trade.status, 'agreed');

    // Bob cannot see Alice's submission or lock state.
    const viewB = (await b.getTrade(trade.id)).trade as unknown as Record<string, unknown>;
    assert.equal(viewB.status, 'agreed');
    assert.equal(viewB.yourSubmission, null);
    assert.equal(viewB.youLocked, false);
    assert.ok(!JSON.stringify(viewB).includes('"locked"'));
    const bobTradeEvents = b.received.filter((e) => e.type.startsWith('trade.')).map((e) => e.type);
    assert.deepEqual(bobTradeEvents, ['trade.proposed', 'trade.agreed']);

    const res = await b.lockTrade(trade.id, silver(5));
    assert.equal(res.trade.status, 'settled');
    const rb = res.receipt!;
    assert.deepEqual(rb.promised.them, silver(10));
    assert.deepEqual(rb.actual.youReceived, []);
    assert.deepEqual(rb.actual.youSent, silver(5));
    assert.equal(rb.counterpartyKeptWord, false);
    assert.equal(rb.youKeptWord, true);
    assert.equal(await b.count('silver'), 15);
    // Alice received 5 silver; the 2% settlement fee (minimum 1) destroys 1 of it.
    assert.equal(await a.count('silver'), 24);

    const ra = (await a.receipts()).receipts;
    assert.equal(ra.length, 1);
    assert.equal(ra[0].youKeptWord, false);
    assert.equal(ra[0].silverFee, 1);
    assert.deepEqual(ra[0].actual.youReceived, silver(5), 'receipts show the gross amount sent');
    assert.equal(rb.silverFee, undefined, 'no fee when no silver was received');
    assert.equal(ra[0].ownerId, alice.playerId);
    // Each player only ever sees their own receipt.
    assert.ok((await b.receipts()).receipts.every((r) => r.ownerId === bob.playerId));
  } finally { await w.close(); }
});

test('submissions are reserved; resubmitting swaps the reservation; expiry returns everything', async () => {
  const w = await world();
  try {
    const a = await w.bot('Ann');
    const b = await w.bot('Ben');
    const ben = await b.whoami();
    const { trade } = await a.proposeTrade({ to: ben.playerId, give: silver(8), receive: silver(8), lockTimeoutMs: 1000 });
    await b.acceptTrade(trade.id);
    await a.submitTrade(trade.id, silver(12));
    assert.equal(await a.count('silver'), 8);
    await a.submitTrade(trade.id, silver(3));
    assert.equal(await a.count('silver'), 17);
    const tooMuch = await a.request('trade.submit', { tradeId: trade.id, items: silver(500) });
    assert.equal(tooMuch.ok, false);
    assert.equal(await a.count('silver'), 17, 'failed submit must not lose the old reservation');
    await a.lockTrade(trade.id);
    const receipt = await a.waitForReceipt(trade.id, 5000);
    assert.equal(receipt.outcome, 'expired');
    assert.deepEqual(receipt.actual, { youSent: [], youReceived: [] });
    assert.equal(await a.count('silver'), 20);
    assert.equal(await b.count('silver'), 20);
    const late = await b.request('trade.lock', { tradeId: trade.id, items: [] });
    assert.equal(late.ok, false);
    const st = await w.operator();
    assert.equal(st.trades.timeouts.length, 1);
    assert.equal(st.trades.settled.length, 0);
  } finally { await w.close(); }
});

test('retrying a command with the same commandId never duplicates a transfer', async () => {
  const w = await world();
  try {
    const a = await w.bot('Cid');
    const b = await w.bot('Dee');
    const dee = await b.whoami();
    const { trade } = await a.proposeTrade({ to: dee.playerId, give: silver(10), receive: [] });
    await b.acceptTrade(trade.id);
    await b.lockTrade(trade.id, []);
    const r1 = await a.request('trade.lock', { tradeId: trade.id, items: silver(10) }, { commandId: 'lock-once' });
    const r2 = await a.request('trade.lock', { tradeId: trade.id, items: silver(10) }, { commandId: 'lock-once' });
    assert.ok(r1.ok && r2.ok);
    assert.equal(r2.ok && r2.replayed, true);
    assert.deepEqual(r1.ok && r1.result, r2.ok && r2.result);
    assert.equal(await a.count('silver'), 10);
    assert.equal(await b.count('silver'), 29, 'received 10, minus the 1-silver settlement fee');
    const conflict = await a.request('trade.lock', { tradeId: trade.id, items: silver(1) }, { commandId: 'lock-once' });
    assert.equal(!conflict.ok && conflict.error.code, 'IDEMPOTENCY_CONFLICT');
    // Bank deposits are also replay-safe.
    await a.travelTo('town');
    const d1 = await a.request('bank.deposit', { items: silver(5) }, { commandId: 'dep-1' });
    const d2 = await a.request('bank.deposit', { items: silver(5) }, { commandId: 'dep-1' });
    assert.ok(d1.ok && d2.ok);
    assert.deepEqual((await a.bank()).items, silver(5));
  } finally { await w.close(); }
});

test('outsiders cannot see or touch a trade; trading needs the town', async () => {
  const w = await world();
  try {
    const a = await w.bot('Eve');
    const b = await w.bot('Fay');
    const c = await w.bot('Gus');
    const fay = await b.whoami();
    const { trade } = await a.proposeTrade({ to: fay.playerId, give: silver(1), receive: silver(1) });
    for (const type of ['trade.get', 'trade.accept', 'trade.lock'] as const) {
      const r = await c.request(type, { tradeId: trade.id } as any);
      assert.equal(!r.ok && r.error.code, 'NOT_FOUND', type);
    }
    assert.equal((await c.listTrades()).trades.length, 0);
    await b.travelTo('wilds');
    const away = await b.request('trade.accept', { tradeId: trade.id });
    assert.equal(!away.ok && away.error.code, 'WRONG_ZONE');
    const decline = await b.request('trade.decline', { tradeId: trade.id });
    assert.ok(decline.ok);
    await wait(10);
  } finally { await w.close(); }
});
