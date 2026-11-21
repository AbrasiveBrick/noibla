import { createHash, randomBytes } from 'node:crypto';
import { baseOf, isUnique, itemDef, type ItemStack } from '../shared/catalog.ts';
import type { ErrorCode } from '../shared/protocol.ts';
import { TRANSIENT_ERRORS } from '../shared/protocol.ts';

export class GameError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;
  readonly hint?: string;
  constructor(code: ErrorCode, message: string, retryAfterMs?: number, hint?: string) {
    super(message);
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
    if (hint) this.hint = hint;
  }
  get transient() { return TRANSIENT_ERRORS.has(this.code); }
}

export const fail = (code: ErrorCode, message: string, retryAfterMs?: number, hint?: string): never => { throw new GameError(code, message, retryAfterMs, hint); };

export function newId(prefix: string): string { return `${prefix}_${randomBytes(6).toString('hex')}`; }
export function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
}

/** Seeded PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- payload validation ----------

export function obj(payload: unknown): Record<string, any> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) fail('BAD_REQUEST', 'payload must be an object');
  return payload as Record<string, any>;
}

export function reqStr(p: Record<string, any>, key: string, max = 200): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0) fail('BAD_REQUEST', `${key} must be a non-empty string`);
  if (v.length > max) fail('BAD_REQUEST', `${key} exceeds ${max} characters`);
  return v;
}

export function optStr(p: Record<string, any>, key: string, max = 200): string | undefined {
  if (p[key] === undefined) return undefined;
  return reqStr(p, key, max);
}

export function optInt(p: Record<string, any>, key: string, min: number, max: number, dflt: number): number {
  const v = p[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail('BAD_REQUEST', `${key} must be an integer in [${min}, ${max}]`);
  return v;
}

export function reqInt(p: Record<string, any>, key: string, min: number, max: number): number {
  if (p[key] === undefined) fail('BAD_REQUEST', `${key} is required`);
  return optInt(p, key, min, max, 0);
}

/** Strips control characters (keeps newlines and tabs) and trims. Text stays player-authored data. */
export function cleanText(p: Record<string, any>, key: string, max: number): string {
  const tooLong = (len: number) => fail('BAD_REQUEST', `${key} exceeds ${max} characters (got ${len})`, undefined, `shorten ${key} by at least ${len - max} characters, or split it into several messages`);
  const raw = p[key];
  if (typeof raw !== 'string' || raw.length === 0) fail('BAD_REQUEST', `${key} must be a non-empty string`);
  if (raw.length > max * 2) tooLong(raw.length);
  const t = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
  if (!t) fail('BAD_REQUEST', `${key} is empty`);
  if (t.length > max) tooLong(t.length);
  return t;
}

// ---------- item stacks ----------

export type Bag = Record<string, number>;

export function stacks(input: unknown, key = 'items', allowEmpty = true): ItemStack[] {
  if (!Array.isArray(input)) fail('BAD_REQUEST', `${key} must be an array of { item, qty }`);
  const arr = input as unknown[];
  if (arr.length > 50) fail('BAD_REQUEST', `${key} has too many entries`);
  const merged: Bag = {};
  for (const s of arr) {
    if (!s || typeof s !== 'object') fail('BAD_REQUEST', `${key} entries must be { item, qty }`);
    const { item, qty } = s as Record<string, unknown>;
    if (typeof item !== 'string' || !itemDef(item) || (isUnique(item) && !/^[a-z_]+#[0-9a-f]{8,16}$/.test(item))) fail('BAD_REQUEST', `unknown item "${String(item)}"`);
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 1_000_000) fail('BAD_REQUEST', `qty for ${String(item)} must be a positive integer`);
    merged[item as string] = (merged[item as string] ?? 0) + (qty as number);
  }
  const out = toStacks(merged);
  if (!allowEmpty && out.length === 0) fail('BAD_REQUEST', `${key} must not be empty`);
  return out;
}

export function toStacks(bag: Bag): ItemStack[] {
  return Object.entries(bag).filter(([, q]) => q > 0).sort(([a], [b]) => a.localeCompare(b)).map(([item, qty]) => ({ item, qty }));
}

export function toBag(list: ItemStack[]): Bag {
  const b: Bag = {};
  for (const s of list) b[s.item] = (b[s.item] ?? 0) + s.qty;
  return b;
}

/**
 * How many of `item` the bag can supply. A unique id (`iron_sword#…`) counts only itself; a base id (`iron_sword`)
 * counts the plain stack plus every unique of that base, so "1× iron_sword" can be paid with a crafted sword.
 */
export function available(bag: Bag, item: string): number {
  if (isUnique(item)) return bag[item] ?? 0;
  let n = bag[item] ?? 0;
  for (const [k, q] of Object.entries(bag)) if (q > 0 && isUnique(k) && baseOf(k) === item) n += q;
  return n;
}

export function hasItems(bag: Bag, list: ItemStack[], times = 1): boolean {
  return list.every((s) => available(bag, s.item) >= s.qty * times);
}

export function missing(bag: Bag, list: ItemStack[], times = 1): string {
  return list.filter((s) => available(bag, s.item) < s.qty * times).map((s) => `${s.item} (have ${available(bag, s.item)}, need ${s.qty * times})`).join(', ');
}

/** Removes items and returns the concrete stacks taken (base ids may be paid with uniques of that base: plain stack first, then uniques by id). */
export function removeItems(bag: Bag, list: ItemStack[], times = 1): ItemStack[] {
  if (!hasItems(bag, list, times)) fail('NOT_ENOUGH_ITEMS', `missing ${missing(bag, list, times)}`);
  const taken: Bag = {};
  const take = (k: string, n: number) => { bag[k] -= n; if (bag[k] <= 0) delete bag[k]; taken[k] = (taken[k] ?? 0) + n; };
  for (const s of list) {
    let need = s.qty * times;
    const plain = Math.min(need, bag[s.item] ?? 0);
    if (plain > 0) { take(s.item, plain); need -= plain; }
    if (need > 0 && !isUnique(s.item)) {
      for (const k of Object.keys(bag).filter((k) => isUnique(k) && baseOf(k) === s.item).sort()) {
        if (need <= 0) break;
        const n = Math.min(need, bag[k]);
        take(k, n); need -= n;
      }
    }
  }
  return toStacks(taken);
}

export function addItems(bag: Bag, list: ItemStack[], times = 1) {
  for (const s of list) bag[s.item] = (bag[s.item] ?? 0) + s.qty * times;
}

/** True when `sent` covers every promised quantity (a promised base id is covered by uniques of that base). */
export function covers(sent: Bag, promised: Bag): boolean {
  return Object.entries(promised).every(([item, qty]) => available(sent, item) >= qty);
}

export function describe(list: ItemStack[]): string {
  return list.length ? list.map((s) => `${s.qty}× ${s.item}`).join(', ') : 'nothing';
}
