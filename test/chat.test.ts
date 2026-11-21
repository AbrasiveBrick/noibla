import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attach, world, wait } from './helpers.ts';

test('zone channels: history and live events only for agents in that zone', async () => {
  const w = await world();
  try {
    const a = await w.bot('Wanderer');
    const b = await w.bot('Townie');
    await a.travelTo('wilds');
    await a.say('wolves near the iron veins');
    await wait(30);
    const own = await a.chatHistory('zone:wilds');
    assert.equal(own.messages.at(-1)!.text, 'wolves near the iron veins');
    assert.equal(own.messages.at(-1)!.authorKind, 'player');
    const denied = await b.request('chat.history', { channel: 'zone:wilds' });
    assert.equal(!denied.ok && denied.error.code, 'FORBIDDEN');
    assert.ok(!b.received.some((e) => e.type === 'chat.message'));
    await b.travelTo('wilds');
    assert.equal((await b.chatHistory('zone:wilds')).messages.length, 1, 'anyone eligible can read and join');
    await b.say('on my way');
    await wait(30);
    assert.ok(a.received.some((e) => e.type === 'chat.message' && e.data.message.text === 'on my way'));
  } finally { await w.close(); }
});

test('trade forum: persistent threads and replies, readable by anyone in town', async () => {
  const w = await world();
  try {
    const a = await w.bot('Seller');
    const b = await w.bot('Buyer');
    const { thread } = await a.createThread('[WTS] copper bars', '10 bars, 5 silver each', ['wts']);
    await b.replyToThread(thread.id, 'I will take 4');
    const t = (await b.getThread(thread.id)).thread;
    assert.equal(t.body, '10 bars, 5 silver each');
    assert.equal(t.replies[0].body, 'I will take 4');
    assert.equal((await b.listThreads({ tag: 'wts' })).threads.length, 1);
    await b.travelTo('wilds');
    const away = await b.request('forum.listThreads', {});
    assert.equal(!away.ok && away.error.code, 'WRONG_ZONE');
    const st = await w.operator();
    assert.ok(st.events.some((e: any) => e.type === 'forum.thread' && e.data.thread.title === '[WTS] copper bars'));
  } finally { await w.close(); }
});

test('private messages: only the two participants, via history or live events; catch-up after reconnect', async () => {
  const w = await world();
  try {
    const a = await w.bot('Alpha');
    const b = await w.bot('Bravo', { connect: false });
    const c = await w.bot('Charlie');
    const bravo = await b.whoami();
    const alpha = await a.whoami();
    const secret = 'meet me at the forge, 140 silver final';
    await a.sendDm(bravo.playerId, secret);
    await a.sendDm(bravo.playerId, 'and bring the pickaxe');
    await wait(30);
    // Bravo was offline: catches up with unread counts and history.
    const convs = (await b.conversations()).conversations;
    assert.equal(convs.length, 1);
    assert.equal(convs[0].unread, 2);
    assert.equal(convs[0].withId, alpha.playerId);
    const hist = await b.dmHistory({ with: alpha.playerId });
    assert.deepEqual(hist.messages.map((m) => m.text), [secret, 'and bring the pickaxe']);
    await b.markRead(hist.conversationId, hist.messages.at(-1)!.id);
    assert.equal((await b.observe()).unreadDms, 0);
    await b.connect();
    await b.sendDm(alpha.playerId, 'deal');
    await wait(50);
    assert.ok(a.received.some((e) => e.type === 'dm.message' && e.data.message.text === 'deal'));

    // Charlie: no history by id, no history via chat, no live events.
    const byId = await c.request('dm.history', { conversationId: hist.conversationId });
    assert.equal(!byId.ok && byId.error.code, 'FORBIDDEN');
    const viaChat = await c.request('chat.history', { channel: hist.conversationId });
    assert.equal(!viaChat.ok && viaChat.error.code, 'FORBIDDEN');
    assert.equal((await c.dmHistory({ with: alpha.playerId })).messages.length, 0);
    assert.ok(!JSON.stringify(c.received).includes(secret));
    assert.ok(!c.received.some((e) => e.type === 'dm.message'));

    // The operator dashboard shows private conversations in full (sender, recipient, text).
    const st = await w.operator();
    const sent = st.events.filter((e: any) => e.type === 'dm.sent');
    assert.equal(sent.length, 3);
    assert.equal(sent[0].data.text, secret);
    assert.equal(sent[0].data.playerId, alpha.playerId);
    assert.equal(sent[0].data.toId, bravo.playerId);
    assert.equal(sent[0].data.conversationId, hist.conversationId);

    // A reconnecting client with the same token sees the same persisted history.
    const again = attach(w.url, b.botToken);
    assert.equal((await again.dmHistory({ with: alpha.playerId })).messages.length, 3);
  } finally { await w.close(); }
});

test('feedback reports reach the operator verbatim with command context', async () => {
  const w = await world();
  try {
    const a = await w.bot('Reporter');
    const b = await w.bot('Friend');
    const friend = await b.whoami();
    await a.sendDm(friend.playerId, 'my secret price is 777 silver for the mail');
    const bad = await a.request('move', { x: -1, y: 0 });
    assert.equal(!bad.ok && bad.error.code, 'BAD_REQUEST');
    const fb = await a.reportFeedback({ category: 'confusing_api', summary: 'move to frontier failed from town', details: 'I had told Friend "my secret price is 777 silver for the mail" and then move failed', relatedCommandId: bad.commandId });
    const st = await w.operator();
    const f = st.feedback.find((x: any) => x.id === fb.feedbackId);
    assert.ok(f);
    assert.ok(f.details.includes('my secret price is 777 silver for the mail'));
    assert.equal(f.context.relatedCommandId, bad.commandId);
    assert.ok(f.context.recentCommands.some((c: any) => c.type === 'move' && c.code === 'BAD_REQUEST'));
    assert.ok(!f.context.recentCommands.some((c: any) => 'payload' in c));
  } finally { await w.close(); }
});
