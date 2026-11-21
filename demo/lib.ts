// Shared helpers for the scripted demo bots. Bots only talk to the server
// through the SDK; `Facts` is harness instrumentation used for the final checks.

import { GameClient, sleep, type DirectMessage, type TradeReceipt, type TradeView, type CommandResponse } from '../src/sdk/index.ts';

export interface Facts {
  producerId?: string; fighterId?: string; rivalId?: string;
  adThreadId?: number; wtbThreadId?: number;
  rivalReadAd?: boolean;
  kitTimeoutTradeId?: string; kitTimeoutReceipt?: TradeReceipt;
  kitTradeId?: string; kitReceiptProducer?: TradeReceipt; kitReceiptFighter?: TradeReceipt;
  lockFirst?: CommandResponse; lockReplay?: CommandResponse; silverBeforeLock?: number; silverAfterLock?: number;
  fighterCaughtUp?: number;
  fighterBankAfterDeath?: { item: string; qty: number }[];
  fighterSkillsKept?: boolean;
  fighterDeath?: { zone: string; dropped: { item: string; qty: number }[]; killer: string };
  rivalLoot?: { item: string; qty: number }[];
  scamTradeId?: string; scamReceiptProducer?: TradeReceipt; scamViewBeforeLock?: TradeView;
  refusedTradeId?: string; refusedStatus?: string;
  essenceTradeId?: string; essenceReceiptProducer?: TradeReceipt;
  producerT3?: string;
  injectionIgnored?: boolean;
  feedbackIds?: number[];
}

const t0 = Date.now();
const COLORS: Record<string, string> = { producer: '\x1b[36m', fighter: '\x1b[33m', rival: '\x1b[35m', demo: '\x1b[32m', check: '\x1b[32m' };

export function narrator(who: string) {
  const color = process.stdout.isTTY ? COLORS[who] ?? '' : '';
  const reset = process.stdout.isTTY ? '\x1b[0m' : '';
  return (msg: string) => {
    const ts = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
    console.log(`${ts}s ${color}${who.padEnd(8)}${reset}│ ${msg}`);
  };
}

/** Tracks which DMs a bot has already handled. */
export class Inbox {
  private cursor = 0;
  private readonly c: GameClient;
  constructor(c: GameClient) { this.c = c; }

  /** Returns the next unseen DM from someone else (optionally from `from`) matching `match`. */
  async next(o: { from?: string; match?: (m: DirectMessage) => boolean; timeoutMs?: number } = {}): Promise<DirectMessage> {
    const me = (await this.c.whoami()).playerId;
    return this.c.waitFor(async () => {
      const { conversations } = await this.c.conversations();
      const msgs: DirectMessage[] = [];
      for (const conv of conversations) {
        if (o.from && conv.withId !== o.from) continue;
        if (conv.lastMessageId <= this.cursor) continue;
        const { messages } = await this.c.dmHistory({ conversationId: conv.conversationId, afterId: this.cursor, limit: 200 });
        msgs.push(...messages.filter((m) => m.fromId !== me));
      }
      msgs.sort((a, b) => a.id - b.id);
      for (const m of msgs) {
        if (!o.match || o.match(m)) {
          this.cursor = Math.max(this.cursor, m.id);
          await this.c.markRead(m.conversationId, m.id);
          return m;
        }
      }
      return null;
    }, { timeoutMs: o.timeoutMs ?? 120_000, intervalMs: 120, what: 'a private message' });
  }

  /** All unseen DMs (from anyone), marking them read. */
  async drain(): Promise<DirectMessage[]> {
    const me = (await this.c.whoami()).playerId;
    const { conversations } = await this.c.conversations();
    const out: DirectMessage[] = [];
    for (const conv of conversations) {
      if (conv.lastMessageId <= this.cursor) continue;
      const { messages } = await this.c.dmHistory({ conversationId: conv.conversationId, afterId: this.cursor, limit: 200 });
      out.push(...messages.filter((m) => m.fromId !== me));
    }
    out.sort((a, b) => a.id - b.id);
    for (const m of out) await this.c.markRead(m.conversationId, m.id);
    if (out.length) this.cursor = Math.max(this.cursor, ...out.map((m) => m.id));
    return out;
  }
}

/** Waits for a trade proposal addressed to us from `from`. */
export async function waitForProposal(c: GameClient, from: string, exclude: string[] = [], timeoutMs = 120_000): Promise<TradeView> {
  return c.waitFor(async () => {
    const { trades } = await c.listTrades('proposed');
    return trades.find((t) => t.proposerId === from && !exclude.includes(t.id)) ?? null;
  }, { timeoutMs, intervalMs: 120, what: 'a trade proposal' });
}

export async function waitForStatus(c: GameClient, tradeId: string, statuses: string[], timeoutMs = 120_000): Promise<TradeView> {
  return c.waitFor(async () => {
    const { trade } = await c.getTrade(tradeId);
    return statuses.includes(trade.status) ? trade : null;
  }, { timeoutMs, intervalMs: 100, what: `trade ${tradeId} to become ${statuses.join('/')}` });
}

export function fmt(list: { item: string; qty: number }[]): string {
  return list.length ? list.map((s) => `${s.qty}× ${s.item}`).join(', ') : 'nothing';
}

export { sleep };
