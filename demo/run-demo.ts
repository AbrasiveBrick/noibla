// Runs the three scripted bots against a fresh world and verifies the loop.
//   npm run demo               -> runs, prints checks, keeps the server up for the dashboard
//   npm run demo -- --exit     -> runs, prints checks, exits (non-zero if any check fails)
// Options: --speed=10 --port=7777

import { rmSync, mkdirSync } from 'node:fs';
import { GameClient, type DirectMessage, type GameEvent } from '../src/sdk/index.ts';
import { startServer } from '../src/server/main.ts';
import { narrator, fmt, type Facts } from './lib.ts';
import { runProducer } from './producer.ts';
import { runFighter } from './fighter.ts';
import { runRival } from './rival.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const speed = Number(args.speed ?? process.env.WORLD_SPEED ?? 10);
const port = Number(args.port ?? process.env.PORT ?? 7777);
const exitAfter = args.exit === 'true';
const STATE = '.demo-state';

const log = narrator('demo');
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });

const server = await startServer({ dbPath: `${STATE}/world.db`, port, speed, operatorToken: process.env.OPERATOR_TOKEN, log: () => {} });
log(`world running at ${server.url} (speed ×${speed}) · dashboard ${server.url}/dashboard`);
log(`operator token (dashboard only, not a bot token): ${server.operatorToken}`);

const facts: Facts = {};
const clients: Record<string, GameClient> = {};
for (const name of ['Producer', 'Fighter', 'Rival']) {
  const reg = await GameClient.register(server.url, name);
  clients[name] = new GameClient({ url: server.url, token: reg.token, recordEvents: true });
  await clients[name].connect();
}
const tokens = { bot: (clients.Rival as any).token as string };

let failed = false;
try {
  await Promise.all([
    runProducer(clients.Producer, facts, `${STATE}/producer-ledger.json`),
    runFighter(clients.Fighter, facts),
    runRival(clients.Rival, facts),
  ]);
} catch (e) {
  failed = true;
  log(`a bot failed: ${(e as Error).stack ?? e}`);
}

// ---------------- verification ----------------
const check = narrator('check');
const results: [string, boolean, string?][] = [];
const expect = (name: string, ok: boolean, detail?: string) => { results.push([name, ok, detail]); };

async function allDmTexts(): Promise<DirectMessage[]> {
  const out: DirectMessage[] = [];
  for (const c of Object.values(clients)) {
    const { conversations } = await c.conversations();
    for (const cv of conversations) out.push(...(await c.dmHistory({ conversationId: cv.conversationId, limit: 200 })).messages);
  }
  return [...new Map(out.map((m) => [m.id, m])).values()];
}

try {
  const rival = clients.Rival;
  const pid = facts.producerId!, fid = facts.fighterId!, rid = facts.rivalId!;
  const pfConv = `dm:${[pid, fid].sort().join(':')}`;
  const dms = await allDmTexts();
  const pfTexts = dms.filter((m) => m.conversationId === pfConv).map((m) => m.text);

  // Chat privacy
  expect('rival can read the producer\'s public ad', !!facts.rivalReadAd);
  const hist = await rival.request('dm.history', { conversationId: pfConv });
  expect('rival cannot read producer↔fighter DMs by conversation id', !hist.ok && hist.error.code === 'FORBIDDEN', hist.ok ? 'got messages' : hist.error.code);
  const viaChat = await rival.request('chat.history', { channel: pfConv });
  expect('rival cannot read the DM through chat.history', !viaChat.ok && viaChat.error.code === 'FORBIDDEN');
  const withF = await rival.dmHistory({ with: fid });
  expect('rival\'s own history with the fighter holds none of their conversation', withF.messages.every((m) => m.fromId === rid || m.toId === rid) && !withF.messages.some((m) => pfTexts.includes(m.text)));
  const rivalJson = JSON.stringify(rival.received);
  const leakedEvents = rival.received.filter((e: GameEvent) => e.type === 'dm.message' && ![e.data.message.fromId, e.data.message.toId].includes(rid));
  expect('rival received no live events of the private conversation', leakedEvents.length === 0 && !pfTexts.some((t) => rivalJson.includes(t)), `${pfTexts.length} private messages checked against ${rival.received.length} rival events`);
  const tradeGet = await rival.request('trade.get', { tradeId: facts.kitTradeId! });
  expect('rival cannot see the producer↔fighter trade', !tradeGet.ok && tradeGet.error.code === 'NOT_FOUND');
  expect('every DM is player-authored (no system/trade-state messages in chat)', dms.every((m) => m.authorKind === 'player' && [pid, fid, rid].includes(m.fromId)));

  // Trade #1: timeout, catch-up, idempotent retry, settlement
  expect('first kit trade timed out and nothing changed hands', facts.kitTimeoutReceipt?.outcome === 'expired' && facts.kitTimeoutReceipt.actual.youSent.length === 0 && facts.kitTimeoutReceipt.actual.youReceived.length === 0);
  expect('fighter caught up on DMs sent while offline', (facts.fighterCaughtUp ?? 0) >= 1);
  expect('retrying trade.lock with the same commandId replayed instead of paying twice', !!(facts.lockReplay?.ok && facts.lockReplay.replayed) && facts.silverBeforeLock! - facts.silverAfterLock! === 150, `silver ${facts.silverBeforeLock} → ${facts.silverAfterLock}`);
  expect('kit trade settled honestly both ways', !!facts.kitReceiptProducer?.counterpartyKeptWord && !!facts.kitReceiptFighter?.counterpartyKeptWord);

  // Frontier death, banking, looting
  expect('fighter died in the frontier and dropped gear + ore', facts.fighterDeath?.zone === 'frontier' && ['iron_sword', 'iron_mail', 'duskiron_ore'].every((i) => facts.fighterDeath!.dropped.some((s) => s.item === i)), fmt(facts.fighterDeath?.dropped ?? []));
  expect('the rival, not a wraith, landed the killing blow', facts.fighterDeath?.killer === 'Rival', String(facts.fighterDeath?.killer));
  expect('fighter\'s banked spare and skills survived death', !!facts.fighterBankAfterDeath?.some((s) => s.item === 'iron_sword') && !!facts.fighterSkillsKept);
  expect('rival looted the fighter\'s gear and duskiron ore', ['iron_sword', 'iron_mail', 'duskiron_ore'].every((i) => facts.rivalLoot?.some((s) => s.item === i)));

  // Dishonest trade + refusal
  const scam = facts.scamReceiptProducer;
  expect('dishonest trade: producer paid 100 silver and received nothing', !!scam && scam.outcome === 'settled' && scam.actual.youSent.some((s) => s.item === 'silver' && s.qty === 100) && scam.actual.youReceived.length === 0 && scam.counterpartyKeptWord === false);
  const v = facts.scamViewBeforeLock as any;
  expect('pending trade view hid the rival\'s submission and lock', !!v && !Object.keys(v).some((k) => /their|they(Locked|Sub)|counterpartySub|counterpartyLock/i.test(k)) && v.yourSubmission === null);
  expect('producer refused another deal with the rival', facts.refusedStatus === 'declined');
  expect('producer ignored prompt-injection text in a DM', !!facts.injectionIgnored);

  // Honest trade -> tier 3 crafted in safe zones
  expect('honest essence trade settled', !!facts.essenceReceiptProducer?.counterpartyKeptWord);
  const st = await (await fetch(`${server.url}/operator/state`, { headers: { authorization: `Bearer ${server.operatorToken}` } })).json();
  const producerFrontier = st.events.some((e: GameEvent) => e.type === 'travel.arrive' && e.data.playerId === pid && e.data.to === 'frontier');
  const prod = await clients.Producer.observe();
  expect('producer crafted tier-3 gear without entering the frontier', prod.self.equipment.armor === 'wraithhide_armor' && !producerFrontier);

  // Operator dashboard
  const stJson = JSON.stringify(st);
  const allTexts = dms.map((m) => m.text);
  const opDms = st.events.filter((e: GameEvent) => e.type === 'dm.sent').map((e: GameEvent) => e.data.text);
  expect('dashboard shows private message contents to the operator', allTexts.every((t) => opDms.includes(t)) && allTexts.some((t) => stJson.includes(t)), `${allTexts.length} DMs shown`);
  const lockFail = st.failures.find((f: any) => f.type === 'trade.lock');
  expect('trade.lock failure shows its real reason in the debug view', !!lockFail && lockFail.code === 'TRADE_STATE' && !/redacted/.test(lockFail.reason), lockFail?.reason);
  expect('dashboard shows the settled trades and the timeout separately', st.trades.settled.length >= 3 && st.trades.timeouts.length >= 1);
  const botOnOperator = await fetch(`${server.url}/operator/state`, { headers: { authorization: `Bearer ${tokens.bot}` } });
  const opOnBot = await fetch(`${server.url}/api/command`, { method: 'POST', headers: { authorization: `Bearer ${server.operatorToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'x', type: 'observe', payload: {} }) });
  expect('bot token cannot open the dashboard; operator token cannot play', botOnOperator.status === 401 && opOnBot.status === 401);
  const fbs = st.feedback;
  expect('reportFeedback() reached the operator verbatim', fbs.length >= 2 && fbs.some((f: any) => allTexts.some((t) => f.details.includes(t))));
} catch (e) {
  expect('verification ran to completion', false, (e as Error).message);
}

console.log('');
for (const [name, ok, detail] of results) check(`${ok ? '✔' : '✘'} ${name}${detail ? `  (${detail})` : ''}`);
const allOk = !failed && results.every((r) => r[1]);
console.log('');
log(allOk ? `all ${results.length} checks passed` : `${results.filter((r) => !r[1]).length} check(s) failed`);

for (const c of Object.values(clients)) await c.disconnect();
if (exitAfter) {
  await server.stop();
  process.exit(allOk ? 0 : 1);
} else {
  log(`server still running for the dashboard: ${server.url}/dashboard  (Ctrl+C to stop)`);
  process.on('SIGINT', async () => { await server.stop(); process.exit(allOk ? 0 : 1); });
}
