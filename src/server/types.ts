import type { AbilityId, SkillId, Slot, ZoneId } from '../shared/catalog.ts';
import type { Pos } from '../shared/map.ts';
import type { GameEvent } from '../shared/protocol.ts';
import type { Bag } from './util.ts';
import type { Game } from './game.ts';

export interface Player {
  id: string;
  name: string;
  createdAt: number;
  /** Current region (derived from the position, kept up to date by the tick). */
  zone: ZoneId;
  /** Position on the map. While walking, the live position follows `travel.path` and this holds the last known one. */
  pos: Pos;
  travel: Walk | null;
  hp: number;
  inventory: Bag;
  bank: Bag;
  equipment: Partial<Record<Slot, string>>;
  /** Received the starter tool kit (players from before the tool slot get it on load). */
  toolKit?: boolean;
  skills: Partial<Record<SkillId, number>>;
  busyUntil: number;
  cooldowns: Partial<Record<AbilityId, number>>;
  evadeUntil: number;
  braceUntil: number;
  lastCombatAt: number;
  combatLockUntil: number;
  lastRegenAt: number;
  quests: Record<string, { status: 'active' | 'complete' | 'claimed'; progress: number }>;
  stats: { kills: number; deaths: number };
  lastAction: { type: string; summary: string; at: number } | null;
  lastSeenAt: number;
  /** Gear wear by item id (0 to WEAR.max). Optional: saves from before wear existed have none. */
  wear?: Record<string, number>;
  /** Focus skills (see FOCUS). Optional: saves from before focus existed have none. */
  focus?: SkillId[];
  /** Last time a focused skill was dropped (respec cooldown). */
  focusDroppedAt?: number;
}

/** A walk along a path of tiles. The position at time t is pointAlong(path, (t - departAt) / msPerTile). */
export interface Walk {
  from: ZoneId;
  to: ZoneId;
  path: Pos[];
  departAt: number;
  arriveAt: number;
  /** Scaled by world speed. */
  msPerTile: number;
  /** What the walk was aimed at (a region, place, node, mob, bag or player id), when given. */
  target?: string;
}

export interface Mob {
  id: string;
  type: string;
  zone: ZoneId;
  x: number;
  y: number;
  home: Pos;
  /** Last tick that moved this mob (in memory only). */
  movedAt?: number;
  hp: number;
  aggro: Record<string, number>;
  targetId: string | null;
  nextAttackAt: number;
  deadUntil: number;
}

export interface ResourceNode {
  id: string;
  type: string;
  zone: ZoneId;
  x: number;
  y: number;
  charges: number;
  nextChargeAt: number;
}

export interface LootBag {
  id: string;
  zone: ZoneId;
  /** Optional: bags saved before the map existed have none (placed at the region anchor on load). */
  x?: number;
  y?: number;
  ownerId: string;
  ownerName: string;
  items: Bag;
  createdAt: number;
  expiresAt: number;
}

export interface TradeSubmission { items: Bag; locked: boolean; lockedAt: number | null }

export interface Trade {
  id: string;
  createdAt: number;
  proposerId: string;
  counterpartyId: string;
  /** What each participant promised to send, keyed by player id. */
  terms: Record<string, Bag>;
  status: 'proposed' | 'agreed' | 'settled' | 'expired' | 'declined' | 'cancelled';
  proposalExpiresAt: number;
  lockTimeoutMs: number;
  lockDeadline: number | null;
  /** Secret, server-only. Never serialized to the counterparty, chat, events or the dashboard before close. */
  subs: Record<string, TradeSubmission>;
  closedAt: number | null;
}

export type Visibility =
  | { kind: 'zone'; zone: ZoneId }
  | { kind: 'forum' }
  | { kind: 'player'; playerId: string }
  | { kind: 'dm'; a: string; b: string }
  | { kind: 'operator' };

export type Subscriber =
  | { kind: 'player'; playerId: string; send: (ev: GameEvent) => void }
  | { kind: 'operator'; send: (ev: GameEvent) => void };

export interface CommandDef {
  /** Mutating commands are recorded for idempotent retries and run in a transaction. */
  mutates: boolean;
  run: (g: Game, p: Player, payload: Record<string, any>) => unknown;
}

/** One operator snapshot of a player's progression (observation only). */
export interface SnapshotData {
  skills: Partial<Record<SkillId, number>>;
  kills: number;
  deaths: number;
  carried: number;
  banked: number;
  zone: ZoneId | null;
  traveling: boolean;
  online: boolean;
}
