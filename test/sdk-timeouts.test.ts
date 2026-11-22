import test from 'node:test';
import assert from 'node:assert/strict';
import { GameClient, sleep } from '../src/sdk/index.ts';

// A client whose observe/gather are stubbed: no server needed.
function stub(node: { charges: number; nextChargeInMs: number }, gather: () => Promise<any>) {
  const c: any = new GameClient({ url: 'http://127.0.0.1:1', token: 'x' });
  const n = { id: 'n1', type: 'copper_vein', item: 'copper_ore', inRange: true, get charges() { return node.charges; }, get nextChargeInMs() { return node.nextChargeInMs; } };
  const obs = { self: { zone: 'wilds' }, zone: { nodes: [n] } };
  c.waitReady = async () => obs;
  c.nearestNode = async () => n;
  c.equipToolFor = async () => {};
  c.request = async () => gather();
  return c as GameClient;
}

test('gatherItem: the deadline restarts whenever units arrive', async () => {
  let left = 8;
  const node = { charges: 1, nextChargeInMs: 0 };
  const c = stub(node, async () => { await sleep(30); left--; return { ok: true, result: { qty: 1 } }; });
  // 8 x 30 ms is well over the 100 ms limit, but each unit is progress.
  assert.equal(await c.gatherItem('copper_ore', 8, { timeoutMs: 100 }), 8);
  assert.equal(left, 0);
});

test('gatherItem: depleted nodes give a specific error with progress and the wait', async () => {
  const node = { charges: 1, nextChargeInMs: 0 };
  const c = stub(node, async () => { node.charges = 0; node.nextChargeInMs = 5000; return { ok: true, result: { qty: 1 } }; });
  await assert.rejects(c.gatherItem('copper_ore', 3, { timeoutMs: 100 }), (e: Error) => /got 1\/3/.test(e.message) && /depleted/.test(e.message) && /next charge in ~5s/.test(e.message));
});

test('timeout arguments take a number or { timeoutMs } and reject anything else', async () => {
  const c: any = new GameClient({ url: 'http://127.0.0.1:1', token: 'x' });
  const t0 = Date.now();
  // The old code turned { timeoutMs } into NaN: the wait failed after ~1 ms.
  const p = c.waitForEvent(() => false, { timeoutMs: 150 });
  await assert.rejects(p, /timed out waiting for event/);
  assert.ok(Date.now() - t0 >= 120, 'waited the requested time');
  await assert.rejects(c.waitForEvent(() => false, 'soon'), TypeError);
  await assert.rejects(c.waitForEvent(() => false, { timeoutMs: NaN }), /timeoutMs/);
  await assert.rejects(c.waitArrival({ timeoutMs: '5' }), TypeError);
  await assert.rejects(c.restUntil(0.9, -1), TypeError);
  await assert.rejects(c.waitForReceipt('t', null), TypeError);
});
