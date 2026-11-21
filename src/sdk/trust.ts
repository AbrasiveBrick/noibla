// Bot-side memory of who kept their word, keyed by stable player ids and fed
// by private trade receipts. Optional: persists to a local JSON file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TradeReceipt } from '../shared/protocol.ts';
import type { GameClient } from './client.ts';

export interface TrustEntry {
  playerId: string;
  name: string;
  kept: number;
  broken: number;
  timeouts: number;
  lastTradeId: string | null;
  notes: string[];
}

export class TrustLedger {
  private entries: Record<string, TrustEntry> = {};
  private seen = new Set<string>();
  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      this.entries = data.entries ?? {};
      this.seen = new Set(data.seen ?? []);
    }
  }

  /** Records a receipt once (by receipt id). Returns the updated entry. */
  record(r: TradeReceipt): TrustEntry {
    const e = this.entries[r.counterpartyId] ??= { playerId: r.counterpartyId, name: r.counterpartyName, kept: 0, broken: 0, timeouts: 0, lastTradeId: null, notes: [] };
    if (this.seen.has(r.id)) return e;
    this.seen.add(r.id);
    e.name = r.counterpartyName;
    e.lastTradeId = r.tradeId;
    if (r.counterpartyKeptWord === null) e.timeouts++;
    else if (r.counterpartyKeptWord) e.kept++;
    else {
      e.broken++;
      e.notes.push(`trade ${r.tradeId}: promised ${fmt(r.promised.them)}, sent ${fmt(r.actual.youReceived)}`);
    }
    this.save();
    return e;
  }

  /** Pulls recent receipts from the server and records any new ones. */
  async sync(client: GameClient): Promise<void> {
    const { receipts } = await client.receipts({ limit: 200 });
    for (const r of receipts.reverse()) this.record(r);
  }

  get(playerId: string): TrustEntry | undefined { return this.entries[playerId]; }

  /** Trusted = has never broken a promise to us. Unknown players are trusted by default. */
  isTrusted(playerId: string): boolean { return (this.entries[playerId]?.broken ?? 0) === 0; }

  all(): TrustEntry[] { return Object.values(this.entries); }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ entries: this.entries, seen: [...this.seen] }, null, 2));
  }
}

function fmt(list: { item: string; qty: number }[]): string {
  return list.length ? list.map((s) => `${s.qty}× ${s.item}`).join(', ') : 'nothing';
}
