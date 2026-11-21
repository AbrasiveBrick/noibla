// Fighter: earns silver by hunting, buys gear from the producer (forum ad →
// private negotiation → blind trade), banks a spare, dies in the frontier and
// loses what it carried, then re-gears from the bank and sells wraith essence.

import { GameClient, CommandError, sleep, type GameEvent } from '../src/sdk/index.ts';
import { Inbox, fmt, narrator, waitForProposal, type Facts } from './lib.ts';

export async function runFighter(c: GameClient, facts: Facts) {
  const say = narrator('fighter');
  const inbox = new Inbox(c);
  const me = await c.whoami();
  facts.fighterId = me.playerId;

  // --- Earn silver in the safe wilderness, bare-handed ---
  facts.fighterFocus = (await c.setFocus(['unarmed', 'swords', 'mining'])).skills;
  await c.acceptQuest('hire_a_smith');
  say(`focused on ${facts.fighterFocus.join(', ')}; gear will come from a smith (hire_a_smith contract)`);
  await c.acceptQuest('wolf_cull');
  await c.travelTo('wilds');
  say('hunting wolves and boars barehanded (Punch is the only ability without a weapon)');
  await c.hunt('wolf', 3);
  while ((await c.count('silver')) < 145) await c.hunt('boar', 1);
  await c.travelTo('town');
  await c.claimQuest('wolf_cull');
  const o0 = await c.observe();
  say(`back in town with ${await c.count('silver', o0)} silver · unarmed L${o0.self.skills.unarmed.level}`);

  // --- Find the ad and negotiate privately ---
  const ad = await c.waitFor(async () => (await c.listThreads({ tag: 'wts' })).threads.find((t) => /iron/i.test(t.title)), { timeoutMs: 180_000, intervalMs: 200, what: 'an iron gear ad' });
  const thread = (await c.getThread(ad.id)).thread;
  say(`read ad #${ad.id} by ${thread.authorName}: "${thread.body}"`);
  await c.replyToThread(ad.id, 'Interested — sending you a PM.');
  const producerId = ad.authorId;
  await c.sendDm(producerId, "Hi! I'd like your iron kit. Would you take 140 silver?");
  const counter = await inbox.next({ from: producerId });
  say(`producer replied privately: "${counter.text}"`);
  await c.sendDm(producerId, 'Deal at 150. Send the trade and I will lock.');

  // Attempt 1: accept, then the connection drops before locking.
  const p1 = await waitForProposal(c, producerId);
  await c.acceptTrade(p1.id);
  say(`accepted terms on ${p1.id} (${fmt(p1.theyPromise)} for ${fmt(p1.youPromise)}) — then my connection drops`);
  await c.disconnect();
  await sleep(p1.lockTimeoutMs + 700);
  await c.connect();
  const { conversations } = await c.conversations();
  const unread = conversations.find((cv) => cv.withId === producerId)?.unread ?? 0;
  const missed = await inbox.next({ from: producerId });
  facts.fighterCaughtUp = unread;
  const expired = await c.getTrade(p1.id);
  say(`reconnected: ${unread} unread PM — "${missed.text}" · ${p1.id} is ${expired.trade.status}, receipt says I sent ${fmt(expired.receipt!.actual.youSent)}`);
  await c.sendDm(producerId, 'Back online — my connection dropped. Ready when you are.');

  // Attempt 2, with a deliberate retry of the lock command.
  const p2 = await waitForProposal(c, producerId, [p1.id]);
  await c.acceptTrade(p2.id);
  facts.silverBeforeLock = await c.count('silver');
  const lockId = `fighter-lock-${p2.id}`;
  const first = await c.request('trade.lock', { tradeId: p2.id, items: [{ item: 'silver', qty: 150 }] }, { commandId: lockId });
  const replay = await c.request('trade.lock', { tradeId: p2.id, items: [{ item: 'silver', qty: 150 }] }, { commandId: lockId });
  facts.lockFirst = first;
  facts.lockReplay = replay;
  // A buggy retry with a NEW command id is rejected (visible in the dashboard's debug view).
  await c.request('trade.lock', { tradeId: p2.id, items: [{ item: 'silver', qty: 150 }] });
  const receipt = await c.waitForReceipt(p2.id);
  facts.kitReceiptFighter = receipt;
  facts.silverAfterLock = await c.count('silver');
  say(`locked 150 silver (retried the same commandId: replayed=${!!(replay.ok && replay.replayed)}) · received ${fmt(receipt.actual.youReceived)} · silver ${facts.silverBeforeLock} → ${facts.silverAfterLock}`);

  // --- Gear up, bank the spare ---
  const hired = await c.claimQuest('hire_a_smith');
  facts.fighterContractPaid = hired.reward.some((s) => s.item === 'silver');
  say(`hire_a_smith contract paid ${fmt(hired.reward)}`);
  await c.equip('iron_sword');
  await c.equip('iron_mail');
  const silver = await c.count('silver');
  await c.deposit([{ item: 'iron_sword', qty: 1 }, ...(silver > 0 ? [{ item: 'silver', qty: silver }] : [])]);
  say(`equipped iron sword + iron mail; banked the spare sword and ${silver} silver`);

  // --- Frontier trip 1 ---
  await c.acceptQuest('frontier_hunt');
  let ambusher: string | null = null;
  let died: GameEvent | null = null;
  const offHit = c.on('self.damaged', (ev) => { if (ev.data.sourceKind === 'player') ambusher ??= ev.data.sourceName; });
  const offDie = c.on('self.died', (ev) => { died = ev; });
  const xpBefore = Object.values((await c.observe()).self.skills).reduce((n, s) => n + s.xp, 0);
  await c.travelTo('frontier');
  say('entered the lethal frontier; mining duskiron with the iron pickaxe');
  await c.gatherItem('duskiron_ore', 4);
  say(`carrying ${await c.count('duskiron_ore')} duskiron ore; hunting wraiths`);
  let fleeCommandId: string | undefined;
  for (let i = 0; i < 6 && !ambusher && !died; i++) {
    await c.restUntil(0.9);
    if (ambusher || died) break;
    // Walk to the nearest free wraith (from the map when none is in view).
    const wraith = await c.approachMob('wraith', { timeoutMs: 20_000 }).catch(() => null);
    if (!wraith) { await sleep(100); continue; }
    await c.fight(wraith.id, { onTick: async () => (ambusher || died ? 'stop' : 'continue') });
  }
  if (ambusher && !died) {
    say(`ambushed by ${ambusher}! trying to retreat to the wilds`);
    while (!died) {
      const obs = await c.observe();
      if (obs.self.zone === 'town' || obs.self.travel) break;
      const brace = obs.self.abilities.find((a) => a.id === 'brace' && a.readyInMs === 0);
      if (brace) await c.request('ability.use', { ability: 'brace' });
      const mv = await c.request('move', { to: 'wilds' });
      if (mv.ok) break;
      if (mv.error.code === 'COMBAT_LOCKED') fleeCommandId ??= mv.commandId;
      await sleep(Math.min(mv.error.retryAfterMs ?? 50, 60));
    }
  }
  await c.waitFor(async () => died, { timeoutMs: 30_000, what: 'death in the frontier' });
  offHit(); offDie();
  const d = (died as unknown as GameEvent).data;
  facts.fighterDeath = { zone: d.zone, dropped: d.dropped, killer: d.killerName };
  say(`killed by ${d.killerName} in the ${d.zone}; dropped ${fmt(d.dropped)}. Respawned in town.`);

  // --- Bank and skills survived ---
  const after = await c.observe();
  const bank = await c.bank();
  facts.fighterBankAfterDeath = bank.items;
  const xpAfter = Object.values(after.self.skills).reduce((n, s) => n + s.xp, 0);
  facts.fighterSkillsKept = xpAfter >= xpBefore && after.self.skills.mining.xp > 0;
  say(`inventory now ${fmt(after.self.inventory)}; bank still holds ${fmt(bank.items)}; skill XP kept (${xpBefore} before the trip → ${xpAfter} now, unarmed L${after.self.skills.unarmed.level}, swords L${after.self.skills.swords.level})`);
  await c.withdraw([{ item: 'iron_sword', qty: 1 }]);
  await c.equip('iron_sword');

  if (fleeCommandId) {
    const fb = await c.reportFeedback({
      category: 'confusing_api',
      summary: 'move returns COMBAT_LOCKED while fleeing; the 5s lock refreshes on every hit taken',
      details: 'While being attacked in the frontier I could never leave. retryAfterMs helps, but the docs should say the lock renews on each hit.',
      relatedCommandId: fleeCommandId,
    });
    (facts.feedbackIds ??= []).push(fb.feedbackId);
    say(`reported confusing API behaviour via reportFeedback() (#${fb.feedbackId}, related command ${fleeCommandId})`);
  }

  // --- Frontier trip 2: wraith essence with the spare sword ---
  await c.travelTo('frontier');
  say('back in the frontier with the spare sword (no armor); hunting wraiths for essence');
  await c.hunt('wraith', 2, { restBelowPct: 0.8 });
  const essence = await c.count('wraith_essence');
  await c.travelTo('town');
  await c.claimQuest('frontier_hunt').catch((e: CommandError) => say(`quest claim skipped: ${e.code}`));
  say(`returned to town with ${essence} wraith essence`);

  // --- Sell essence to the producer ---
  const wtb = await c.waitFor(async () => (await c.listThreads({ tag: 'wtb' })).threads.find((t) => t.authorId === producerId), { what: 'WTB thread' });
  const wtbThread = (await c.getThread(wtb.id)).thread;
  const warnings = wtbThread.replies.filter((r) => /warning/i.test(r.body));
  if (warnings.length) say(`read public warning on the WTB thread: "${warnings[0].body}"`);
  await c.replyToThread(wtb.id, `Have ${essence} wraith essence — PMing you.`);
  await c.sendDm(producerId, `${essence} wraith essence for 50 silver?`);
  await inbox.next({ from: producerId, match: (m) => /deal/i.test(m.text) });
  const t = await c.proposeTrade({ to: producerId, give: [{ item: 'wraith_essence', qty: essence }], receive: [{ item: 'silver', qty: 50 }], lockTimeoutMs: 30_000 });
  await c.waitFor(async () => (await c.getTrade(t.trade.id)).trade.status === 'agreed', { what: 'producer to accept' });
  const r = await c.completeTrade(t.trade.id, [{ item: 'wraith_essence', qty: essence }]);
  say(`honest trade ${t.trade.id} settled: sent ${fmt(r.actual.youSent)}, received ${fmt(r.actual.youReceived)}`);
}
