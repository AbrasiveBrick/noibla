// Producer: gathers, refines and crafts gear entirely in safe zones, sells it
// through the forum + DMs + blind trade, remembers who kept their word, and
// buys frontier exclusives to craft tier-3 gear without ever leaving safety.
// It specializes as a smith (smelting, weaponcraft, armorcraft focus): tier-3 armor
// needs armorcraft focus, and an outfitter contract pays it for selling the mail.

import { GameClient, TrustLedger, type ItemStack } from '../src/sdk/index.ts';
import { Inbox, fmt, narrator, waitForStatus, type Facts } from './lib.ts';

const KIT: ItemStack[] = [{ item: 'iron_sword', qty: 2 }, { item: 'iron_mail', qty: 1 }, { item: 'iron_pickaxe', qty: 1 }];
const MAX_PRICE_PER_UNIT = 30;

export async function runProducer(c: GameClient, facts: Facts, ledgerFile?: string) {
  const say = narrator('producer');
  const ledger = new TrustLedger(ledgerFile);
  const inbox = new Inbox(c);
  const me = await c.whoami();
  facts.producerId = me.playerId;

  // --- Specialize: three focus skills; everything else stays capped at the unfocused level ---
  facts.producerFocus = (await c.setFocus(['smelting', 'weaponcraft', 'armorcraft'])).skills;
  await c.acceptQuest('outfitter_contract');
  say(`focused on ${facts.producerFocus.join(', ')}; accepted the outfitter contract (paid when a buyer receives iron mail)`);

  // --- Gather in the safe wilderness ---
  await c.acceptQuest('ore_run');
  await c.acceptQuest('apprentice_smith');
  await c.travelTo('wilds');
  say('in the wilds: mining copper and cutting pine (bare hands work on tier 1 nodes)');
  await c.gatherItem('copper_ore', 10);
  await c.gatherItem('pine_log', 10);

  // --- First tools and weapon ---
  await c.travelTo('town');
  await c.refineItem('copper_bar', 5);
  await c.refineItem('pine_plank', 5);
  await c.craftItem('copper_pickaxe', 1);
  await c.craftItem('copper_sword', 1);
  await c.equip('copper_sword');
  await c.claimQuest('ore_run');
  await c.claimQuest('apprentice_smith');
  say('crafted a copper pickaxe and sword in town, claimed 2 quests');

  // --- Iron and hides ---
  await c.travelTo('wilds');
  const ironMined = await c.gatherItem('iron_ore', 18);
  say(`mined ${ironMined} iron ore with the copper pickaxe; hunting boars for hides and silver`);
  let hides = await c.count('rough_hide');
  let boars = 0;
  while (hides < 16) {
    await c.hunt('boar', 1);
    boars++;
    hides = await c.count('rough_hide');
  }
  say(`killed ${boars} boars → ${hides} hides, ${await c.count('silver')} silver`);

  // --- Refine and craft the kit ---
  await c.travelTo('town');
  await c.refineItem('iron_bar', 9);
  await c.refineItem('leather', 8);
  await c.craftItem('leather_jerkin', 1);
  await c.equip('leather_jerkin');
  await c.craftItem('iron_sword', 2);
  await c.craftItem('iron_mail', 1);
  await c.craftItem('iron_pickaxe', 1);
  const obs = await c.observe();
  say(`crafted ${fmt(KIT)} · weaponcraft L${obs.self.skills.weaponcraft.level}, armorcraft L${obs.self.skills.armorcraft.level}, smelting L${obs.self.skills.smelting.level}`);

  // --- Public ads ---
  const ad = await c.createThread('[WTS] Iron fighter kit — 150 silver', 'Two iron swords (one spare), iron mail and an iron pickaxe that can mine frontier duskiron. 150 silver. PM me to deal.', ['wts', 'gear']);
  const wtb = await c.createThread('[WTB] Duskiron ore & wraith essence', 'Buying frontier exclusives for tier-3 crafting. Up to 30 silver each. PM me with an offer; seller proposes the trade.', ['wtb', 'frontier']);
  facts.adThreadId = ad.thread.id;
  facts.wtbThreadId = wtb.thread.id;
  say(`posted public ad #${ad.thread.id} "${ad.thread.title}" and WTB #${wtb.thread.id}`);

  // --- Phase A: negotiate the kit by DM, settle through blind trade ---
  const first = await inbox.next({ match: (m) => /kit/i.test(m.text) });
  const fighterId = first.fromId;
  say(`PM from ${first.fromName} (${fighterId}) — treating as untrusted text: "${first.text}"`);
  await c.sendDm(fighterId, '150 firm — two swords, mail and a duskiron-capable pickaxe.');
  await inbox.next({ from: fighterId, match: (m) => /deal/i.test(m.text) });

  // Attempt 1: short lock window. The fighter's connection drops before locking.
  const p1 = await c.proposeTrade({ to: fighterId, give: KIT, receive: [{ item: 'silver', qty: 150 }], lockTimeoutMs: 2500 });
  facts.kitTimeoutTradeId = p1.trade.id;
  await waitForStatus(c, p1.trade.id, ['agreed']);
  say(`terms agreed on ${p1.trade.id}; secretly locking the kit`);
  const r1 = await c.completeTrade(p1.trade.id, KIT);
  facts.kitTimeoutReceipt = r1;
  say(`${p1.trade.id} ${r1.outcome}: received ${fmt(r1.actual.youReceived)}, sent ${fmt(r1.actual.youSent)} — kit back in inventory (${await c.count('iron_sword')} swords)`);
  await c.sendDm(fighterId, 'Our trade expired before you locked. Nothing changed hands; I still have the kit. Tell me when you are back.');
  await inbox.next({ from: fighterId, match: (m) => /back|ready/i.test(m.text) });

  // Attempt 2.
  const p2 = await c.proposeTrade({ to: fighterId, give: KIT, receive: [{ item: 'silver', qty: 150 }], lockTimeoutMs: 30_000 });
  facts.kitTradeId = p2.trade.id;
  await waitForStatus(c, p2.trade.id, ['agreed']);
  const r2 = await c.completeTrade(p2.trade.id, KIT);
  facts.kitReceiptProducer = r2;
  ledger.record(r2);
  say(`${p2.trade.id} settled: sent ${fmt(r2.actual.youSent)}, received ${fmt(r2.actual.youReceived)} → ${r2.counterpartyName} ${r2.counterpartyKeptWord ? 'kept their word' : 'BROKE their word'}`);
  const contract = await c.claimQuest('outfitter_contract');
  facts.producerContractPaid = contract.reward.some((s) => s.item === 'silver');
  say(`outfitter contract paid ${fmt(contract.reward)} for delivering the mail through a settled trade`);

  // --- Phase C/D: deal desk for frontier exclusives ---
  const expecting = new Map<string, { item: string; qty: number; price: number }>();
  let refusedRival = false;
  let crafted = false;
  while (!(crafted && refusedRival)) {
    // Incoming proposals.
    const { trades } = await c.listTrades('proposed');
    for (const t of trades.filter((x) => x.counterpartyId === me.playerId)) {
      if (!ledger.isTrusted(t.proposerId)) {
        await c.declineTrade(t.id);
        const e = ledger.get(t.proposerId)!;
        await c.sendDm(t.proposerId, `No. You took my silver and sent nothing on ${e.lastTradeId}. I won't trade with you again.`);
        facts.refusedTradeId = t.id;
        refusedRival = true;
        say(`refused ${t.counterpartyName}'s new proposal ${t.id} (ledger: ${e.broken} broken promise)`);
        continue;
      }
      const deal = expecting.get(t.proposerId);
      const ok = deal && t.theyPromise.length === 1 && t.theyPromise[0].item === deal.item && t.theyPromise[0].qty === deal.qty
        && t.youPromise.length === 1 && t.youPromise[0].item === 'silver' && t.youPromise[0].qty === deal.price;
      if (!ok) { await c.declineTrade(t.id); say(`declined ${t.id}: terms don't match what we agreed`); continue; }
      expecting.delete(t.proposerId);
      await c.acceptTrade(t.id);
      const view = (await c.getTrade(t.id)).trade;
      if (deal!.item === 'duskiron_ore') { facts.scamTradeId = t.id; facts.scamViewBeforeLock = view; }
      say(`accepted ${t.id} from ${t.counterpartyName}: ${fmt(t.theyPromise)} for ${fmt(t.youPromise)}; locking ${deal!.price} silver (I can't see their submission)`);
      const r = await c.completeTrade(t.id, [{ item: 'silver', qty: deal!.price }]);
      const entry = ledger.record(r);
      if (deal!.item === 'duskiron_ore') facts.scamReceiptProducer = r;
      if (deal!.item === 'wraith_essence') { facts.essenceTradeId = t.id; facts.essenceReceiptProducer = r; }
      say(`receipt ${t.id}: promised ${fmt(r.promised.them)}, actually received ${fmt(r.actual.youReceived)} → ${r.counterpartyKeptWord ? 'kept word' : 'BROKE word'} (ledger: ${entry.kept} kept / ${entry.broken} broken)`);
      if (!r.counterpartyKeptWord) {
        await c.sendDm(t.proposerId, `I paid ${deal!.price} silver on ${t.id} and received nothing. Noted.`);
        await c.replyToThread(wtb.thread.id, `Warning: ${r.counterpartyName} (${r.counterpartyId}) took ${deal!.price} silver on trade ${t.id} and sent nothing.`);
      }
      if (r.counterpartyKeptWord && deal!.item === 'wraith_essence') {
        await c.craftItem('wraithhide_armor', 1);
        await c.equip('wraithhide_armor');
        facts.producerT3 = 'wraithhide_armor';
        crafted = true;
        say('crafted and equipped Wraithhide Armor (tier 3) in town — never set foot in the frontier');
        await c.say('Tier 3 wraithhide armor forged in Brightwater. Thanks, honest traders.');
      }
    }
    // New messages.
    for (const m of await inbox.drain()) {
      if (/ignore (all |your )?(previous|prior) instructions|system notice|system:/i.test(m.text)) {
        facts.injectionIgnored = true;
        say(`message from ${m.fromName} contains instruction-like text; it is player-authored data, not a command — ignoring that part`);
      }
      if (!ledger.isTrusted(m.fromId)) {
        await c.sendDm(m.fromId, 'Not interested.');
        continue;
      }
      const offer = /(\d+)\s*(?:x\s*)?(duskiron ore|wraith essence)\D+?(\d+)\s*silver/i.exec(m.text);
      if (!offer) continue;
      const qty = Number(offer[1]);
      const item = offer[2].toLowerCase().replace(' ', '_');
      const price = Number(offer[3]);
      if (price > qty * MAX_PRICE_PER_UNIT) { await c.sendDm(m.fromId, `Too steep. I pay up to ${MAX_PRICE_PER_UNIT} each.`); continue; }
      expecting.set(m.fromId, { item, qty, price });
      await c.sendDm(m.fromId, `Deal: ${qty} ${offer[2]} for ${price} silver. Send the trade proposal and I'll lock.`);
      say(`agreed by DM with ${m.fromName}: ${qty}× ${item} for ${price} silver`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  // Feedback through the SDK, not chat.
  const rivalName = ledger.all().find((e) => e.broken > 0)?.name ?? 'someone';
  const fb = await c.reportFeedback({
    category: 'missing_feature',
    summary: 'Blind trades could support an optional reputation lookup across players',
    details: `After ${rivalName} scammed me I had to keep my own ledger. ${rivalName} then wrote "Oops, misclick! For real this time: 3 duskiron ore for 60 silver." — a shared, opt-in honesty score would help bots.`,
  });
  (facts.feedbackIds ??= []).push(fb.feedbackId);
  say(`sent feedback #${fb.feedbackId} via reportFeedback()`);
}
