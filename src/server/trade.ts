// Blind trade. Terms (promises) are agreed in the open; what each side
// actually sends is a secret submission, reserved in escrow when submitted.
// When both lock, both submissions transfer atomically, whatever they contain.
// If the lock deadline passes first, reservations return and nothing moves.

import { TRADE_SILVER_FEE, type ItemStack } from '../shared/catalog.ts';
import type { TradeReceipt, TradeView } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { CommandDef, Player, Trade } from './types.ts';
import { type Bag, addItems, covers, describe, fail, newId, optInt, removeItems, reqStr, stacks, toBag, toStacks } from './util.ts';
import { questProgress, requireZone } from './world.ts';

const PROPOSAL_TTL_MS = 5 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2 * 60_000;
const MAX_OPEN_TRADES = 20;

const isOpen = (t: Trade) => t.status === 'proposed' || t.status === 'agreed';

/** Operator-only record of each trade step (the counterparty never sees it). */
function opLog(g: Game, p: Player, t: Trade, action: string, items?: ItemStack[]) {
  const withName = g.players.get(other(t, p.id))?.name ?? 'unknown';
  g.setLastAction(p, 'trade', `${action} ${t.id} with ${withName}${items ? `: ${describe(items)}` : ''}`);
  g.emit('trade.activity', { kind: 'operator' }, { tradeId: t.id, action, playerId: p.id, name: p.name, withName, items: items ?? null, terms: { [p.name]: toStacks(t.terms[p.id]), [withName]: toStacks(t.terms[other(t, p.id)]) } }, { zone: 'town', actor: p });
}
const other = (t: Trade, id: string) => (t.proposerId === id ? t.counterpartyId : t.proposerId);

export function tradeView(g: Game, t: Trade, viewerId: string): TradeView {
  const them = other(t, viewerId);
  const sub = t.subs[viewerId];
  return {
    id: t.id,
    proposerId: t.proposerId,
    counterpartyId: t.counterpartyId,
    counterpartyName: g.players.get(them)?.name ?? 'unknown',
    status: t.status,
    youPromise: toStacks(t.terms[viewerId] ?? {}),
    theyPromise: toStacks(t.terms[them] ?? {}),
    createdAt: t.createdAt,
    proposalExpiresAt: t.proposalExpiresAt,
    lockTimeoutMs: t.lockTimeoutMs,
    lockDeadline: t.lockDeadline,
    yourSubmission: sub ? toStacks(sub.items) : null,
    youLocked: !!sub?.locked,
  };
}

function getTrade(g: Game, p: Player, payload: Record<string, any>): Trade {
  const id = reqStr(payload, 'tradeId', 60);
  const t = g.trades.get(id);
  // Non-participants get NOT_FOUND so trade existence does not leak.
  if (!t || (t.proposerId !== p.id && t.counterpartyId !== p.id)) fail('NOT_FOUND', `no trade ${id}`);
  return t!;
}

function receiptFor(g: Game, tradeId: string, ownerId: string): TradeReceipt | null {
  const row = g.store.get<{ data: string }>('SELECT data FROM receipts WHERE trade_id = ? AND owner_id = ?', tradeId, ownerId);
  return row ? JSON.parse(row.data) : null;
}

function propose(g: Game, p: Player, payload: Record<string, any>) {
  requireZone(g, p, 'town', 'trading');
  const to = reqStr(payload, 'to', 40);
  const target = g.players.get(to);
  if (!target) fail('NOT_FOUND', `no player ${to}`);
  if (to === p.id) fail('BAD_REQUEST', 'cannot trade with yourself');
  const give = stacks(payload.give ?? [], 'give');
  const receive = stacks(payload.receive ?? [], 'receive');
  if (!give.length && !receive.length) fail('BAD_REQUEST', 'a trade must promise something');
  const lockTimeoutMs = optInt(payload, 'lockTimeoutMs', 1000, 600_000, DEFAULT_LOCK_TIMEOUT_MS);
  let open = 0;
  for (const t of g.trades.values()) if (isOpen(t) && (t.proposerId === p.id || t.counterpartyId === p.id)) open++;
  if (open >= MAX_OPEN_TRADES) fail('TRADE_STATE', `you already have ${open} open trades`);
  const now = g.now();
  const t: Trade = {
    id: newId('t'), createdAt: now, proposerId: p.id, counterpartyId: to,
    terms: { [p.id]: toBag(give), [to]: toBag(receive) },
    status: 'proposed', proposalExpiresAt: now + PROPOSAL_TTL_MS, lockTimeoutMs, lockDeadline: null, subs: {}, closedAt: null,
  };
  g.trades.set(t.id, t);
  g.markTrade(t);
  g.emit('trade.proposed', { kind: 'player', playerId: to }, { trade: tradeView(g, t, to) }, {});
  opLog(g, p, t, 'proposed');
  return { trade: tradeView(g, t, p.id) };
}

function accept(g: Game, p: Player, payload: Record<string, any>) {
  const t = getTrade(g, p, payload);
  if (t.counterpartyId !== p.id) fail('TRADE_STATE', 'only the counterparty can accept the terms');
  if (t.status !== 'proposed') fail('TRADE_STATE', `trade is ${t.status}`);
  const now = g.now();
  if (now > t.proposalExpiresAt) fail('TRADE_EXPIRED', 'the proposal expired');
  requireZone(g, p, 'town', 'trading');
  t.status = 'agreed';
  t.lockDeadline = now + t.lockTimeoutMs;
  g.markTrade(t);
  for (const id of [t.proposerId, t.counterpartyId]) g.emit('trade.agreed', { kind: 'player', playerId: id }, { trade: tradeView(g, t, id) }, {});
  opLog(g, p, t, 'accepted terms of');
  return { trade: tradeView(g, t, p.id) };
}

function close(g: Game, p: Player, payload: Record<string, any>, kind: 'declined' | 'cancelled') {
  const t = getTrade(g, p, payload);
  if (t.status !== 'proposed') fail('TRADE_STATE', `trade is ${t.status}; agreed trades cannot be withdrawn, they expire if not locked`);
  if (kind === 'declined' && t.counterpartyId !== p.id) fail('TRADE_STATE', 'only the counterparty can decline; the proposer cancels');
  if (kind === 'cancelled' && t.proposerId !== p.id) fail('TRADE_STATE', 'only the proposer can cancel; the counterparty declines');
  t.status = kind;
  t.closedAt = g.now();
  g.markTrade(t);
  for (const id of [t.proposerId, t.counterpartyId]) g.emit(kind === 'declined' ? 'trade.declined' : 'trade.cancelled', { kind: 'player', playerId: id }, { trade: tradeView(g, t, id) }, {});
  opLog(g, p, t, kind);
  return { trade: tradeView(g, t, p.id) };
}

function requireLockable(g: Game, p: Player, t: Trade) {
  if (t.status !== 'agreed') fail('TRADE_STATE', `trade is ${t.status}`);
  if (g.now() > (t.lockDeadline ?? 0)) fail('TRADE_EXPIRED', 'the lock deadline passed');
  if (t.subs[p.id]?.locked) fail('TRADE_STATE', 'your submission is already locked');
  requireZone(g, p, 'town', 'trading');
}

/** Replace the caller's secret submission. Items move from inventory into escrow. */
function setSubmission(g: Game, p: Player, t: Trade, items: ItemStack[]) {
  const prev = t.subs[p.id];
  g.markTrade(t);
  g.markPlayer(p);
  if (prev) addItems(p.inventory, toStacks(prev.items));
  removeItems(p.inventory, items);
  t.subs[p.id] = { items: toBag(items), locked: false, lockedAt: null };
}

function submit(g: Game, p: Player, payload: Record<string, any>) {
  const t = getTrade(g, p, payload);
  requireLockable(g, p, t);
  setSubmission(g, p, t, stacks(payload.items ?? [], 'items'));
  opLog(g, p, t, 'submitted to', toStacks(t.subs[p.id].items));
  return { trade: tradeView(g, t, p.id) };
}

function lock(g: Game, p: Player, payload: Record<string, any>) {
  const t = getTrade(g, p, payload);
  requireLockable(g, p, t);
  if (payload.items !== undefined) setSubmission(g, p, t, stacks(payload.items, 'items'));
  // Locking without a submission means sending nothing.
  const sub = t.subs[p.id] ?? { items: {}, locked: false, lockedAt: null };
  sub.locked = true;
  sub.lockedAt = g.now();
  t.subs[p.id] = sub;
  g.markTrade(t);
  opLog(g, p, t, 'locked', toStacks(sub.items));
  const both = t.subs[t.proposerId]?.locked && t.subs[t.counterpartyId]?.locked;
  if (both) settle(g, t);
  return { trade: tradeView(g, t, p.id), receipt: both ? receiptFor(g, t.id, p.id) : null };
}

function makeReceipt(g: Game, t: Trade, ownerId: string, outcome: 'settled' | 'expired'): TradeReceipt {
  const them = other(t, ownerId);
  const sent = outcome === 'settled' ? t.subs[ownerId]?.items ?? {} : {};
  const received = outcome === 'settled' ? t.subs[them]?.items ?? {} : {};
  return {
    id: newId('r'), tradeId: t.id, ownerId, counterpartyId: them, counterpartyName: g.players.get(them)?.name ?? 'unknown', outcome,
    promised: { you: toStacks(t.terms[ownerId]), them: toStacks(t.terms[them]) },
    actual: { youSent: toStacks(sent), youReceived: toStacks(received) },
    counterpartyKeptWord: outcome === 'settled' ? covers(received, t.terms[them]) : null,
    youKeptWord: outcome === 'settled' ? covers(sent, t.terms[ownerId]) : null,
    ...(outcome === 'settled' && silverFee(received) ? { silverFee: silverFee(received) } : {}),
    at: g.now(),
  };
}

function storeReceipts(g: Game, t: Trade, outcome: 'settled' | 'expired') {
  const parties = [t.proposerId, t.counterpartyId].map((id) => {
    const r = makeReceipt(g, t, id, outcome);
    g.store.run('INSERT INTO receipts(id, owner_id, trade_id, counterparty_id, at, data) VALUES(?, ?, ?, ?, ?, ?)', r.id, id, t.id, r.counterpartyId, r.at, JSON.stringify(r));
    // Each receipt goes only to its owner.
    g.emit(outcome === 'settled' ? 'trade.settled' : 'trade.expired', { kind: 'player', playerId: id }, { tradeId: t.id, receipt: r }, {});
    g.store.ledger('destroyed.tradeFee', r.silverFee ?? 0);
    const p = g.players.get(id)!;
    return {
      id, name: p.name,
      promised: toStacks(t.terms[id]),
      sent: r.actual.youSent,
      received: r.actual.youReceived,
      keptWord: r.youKeptWord,
      locked: !!t.subs[id]?.locked,
      silverFee: r.silverFee ?? 0,
    };
  });
  // Operator view, emitted only once the trade is closed.
  g.emit('trade.closed', { kind: 'operator' }, { tradeId: t.id, outcome, createdAt: t.createdAt, closedAt: t.closedAt, parties }, { zone: 'town' });
}

/** Settlement fee: a share of the silver a party receives is destroyed (minimum 1 when any silver moves). */
export function silverFee(received: Bag): number {
  const silver = received.silver ?? 0;
  return silver > 0 ? Math.max(1, Math.floor(silver * TRADE_SILVER_FEE)) : 0;
}

function deliver(to: Player, items: Bag) {
  const net = { ...items };
  const fee = silverFee(items);
  if (fee) { net.silver -= fee; if (net.silver <= 0) delete net.silver; }
  addItems(to.inventory, toStacks(net));
}

function settle(g: Game, t: Trade) {
  const a = g.players.get(t.proposerId)!;
  const b = g.players.get(t.counterpartyId)!;
  deliver(b, t.subs[a.id].items);
  deliver(a, t.subs[b.id].items);
  t.status = 'settled';
  t.closedAt = g.now();
  g.markPlayer(a);
  g.markPlayer(b);
  g.markTrade(t);
  storeReceipts(g, t, 'settled');
  // Trade contracts: credit only what actually changed hands.
  for (const [from, to] of [[a, b], [b, a]]) {
    for (const [item, qty] of Object.entries(t.subs[from.id].items)) {
      if (qty <= 0) continue;
      questProgress(g, from, 'deliver', item, qty);
      questProgress(g, to, 'procure', item, qty);
    }
  }
  for (const p of [a, b]) g.setLastAction(p, 'trade', `trade settled (received ${describe(toStacks(t.subs[other(t, p.id)].items))})`);
}

export function tradeTick(g: Game, now: number) {
  for (const t of g.trades.values()) {
    if (t.status === 'proposed' && now > t.proposalExpiresAt) {
      t.status = 'expired';
      t.closedAt = now;
      g.markTrade(t);
      for (const id of [t.proposerId, t.counterpartyId]) g.emit('trade.expired', { kind: 'player', playerId: id }, { tradeId: t.id, stage: 'proposal', receipt: null }, {});
    } else if (t.status === 'agreed' && t.lockDeadline !== null && now > t.lockDeadline) {
      for (const [id, sub] of Object.entries(t.subs)) {
        const p = g.players.get(id);
        if (p && Object.keys(sub.items).length) { addItems(p.inventory, toStacks(sub.items)); g.markPlayer(p); }
      }
      t.status = 'expired';
      t.closedAt = now;
      g.markTrade(t);
      storeReceipts(g, t, 'expired');
    }
  }
}

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const tradeCommands: Record<string, CommandDef> = {
  'trade.propose': rw(propose),
  'trade.accept': rw(accept),
  'trade.decline': rw((g, p, payload) => close(g, p, payload, 'declined')),
  'trade.cancel': rw((g, p, payload) => close(g, p, payload, 'cancelled')),
  'trade.submit': rw(submit),
  'trade.lock': rw(lock),
  'trade.get': ro((g, p, payload) => {
    const t = getTrade(g, p, payload);
    return { trade: tradeView(g, t, p.id), receipt: isOpen(t) ? null : receiptFor(g, t.id, p.id) };
  }),
  'trade.list': ro((g, p, payload) => {
    const status = payload.status as string | undefined;
    const trades = [...g.trades.values()]
      .filter((t) => (t.proposerId === p.id || t.counterpartyId === p.id) && (!status || t.status === status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
      .map((t) => tradeView(g, t, p.id));
    return { trades };
  }),
  'receipts.list': ro((g, p, payload) => {
    const limit = optInt(payload, 'limit', 1, 200, 50);
    const cp = payload.counterpartyId === undefined ? undefined : reqStr(payload, 'counterpartyId', 40);
    const rows = cp
      ? g.store.all<{ data: string }>('SELECT data FROM receipts WHERE owner_id = ? AND counterparty_id = ? ORDER BY at DESC LIMIT ?', p.id, cp, limit)
      : g.store.all<{ data: string }>('SELECT data FROM receipts WHERE owner_id = ? ORDER BY at DESC LIMIT ?', p.id, limit);
    return { receipts: rows.map((r) => JSON.parse(r.data) as TradeReceipt) };
  }),
};
