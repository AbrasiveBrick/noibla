import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attach, world } from './helpers.ts';

test('progress, items, threads, DMs, receipts, pending trades and command records survive a restart', async () => {
  const w1 = await world();
  const dir = w1.dir;
  const a = await w1.bot('Keeper');
  const b = await w1.bot('Partner');
  const alice = await a.whoami();
  const bob = await b.whoami();
  await a.travelTo('wilds');
  await a.gatherItem('copper_ore', 3);
  await a.travelTo('town');
  await a.deposit([{ item: 'silver', qty: 5 }], { commandId: 'deposit-before-restart' });
  const { thread } = await a.createThread('[WTS] ore', 'copper ore for sale', ['wts']);
  await a.sendDm(bob.playerId, 'still there after a restart?');
  // A settled trade (receipt) and a pending one with a reserved submission.
  const t1 = (await a.proposeTrade({ to: bob.playerId, give: [{ item: 'silver', qty: 1 }], receive: [] })).trade;
  await b.acceptTrade(t1.id);
  await a.lockTrade(t1.id, [{ item: 'silver', qty: 1 }]);
  await b.lockTrade(t1.id, []);
  const t2 = (await a.proposeTrade({ to: bob.playerId, give: [{ item: 'copper_ore', qty: 2 }], receive: [{ item: 'silver', qty: 4 }], lockTimeoutMs: 600_000 })).trade;
  await b.acceptTrade(t2.id);
  await a.lockTrade(t2.id, [{ item: 'copper_ore', qty: 2 }]);
  const before = await a.observe();
  await w1.close({ keepDir: true });

  const w2 = await world({ dir });
  try {
    const a2 = attach(w2.url, a.botToken);
    const b2 = attach(w2.url, b.botToken);
    const after = await a2.observe();
    assert.equal(after.self.id, alice.playerId);
    assert.deepEqual(after.self.inventory, before.self.inventory);
    assert.deepEqual(after.self.skills, before.self.skills);
    assert.deepEqual((await a2.bank()).items, [{ item: 'silver', qty: 5 }]);
    assert.equal((await b2.getThread(thread.id)).thread.body, 'copper ore for sale');
    assert.equal((await b2.dmHistory({ with: alice.playerId })).messages[0].text, 'still there after a restart?');
    assert.equal((await a2.receipts()).receipts[0].tradeId, t1.id);
    // Retrying a pre-restart command replays the recorded result.
    const replay = await a2.request('bank.deposit', { items: [{ item: 'silver', qty: 5 }] }, { commandId: 'deposit-before-restart' });
    assert.ok(replay.ok && replay.replayed);
    assert.deepEqual((await a2.bank()).items, [{ item: 'silver', qty: 5 }]);
    // The pending trade resumes and settles.
    const pending = await b2.getTrade(t2.id);
    assert.equal(pending.trade.status, 'agreed');
    const res = await b2.lockTrade(t2.id, [{ item: 'silver', qty: 4 }]);
    assert.equal(res.trade.status, 'settled');
    assert.ok((await b2.count('copper_ore')) >= 2);
    const st = await w2.operator();
    assert.equal(st.trades.settled.length, 2);
  } finally { await w2.close(); }
});
