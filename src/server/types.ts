import type { AbilityId, SkillId, Slot, ZoneId } from '../shared/catalog.ts';
import type { GameEvent } from '../shared/protocol.ts';
import type { Bag } from './util.ts';
import type { Game } from './game.ts';

export interface Player {
  id: string;
  name: string;
  createdAt: number;
  zone: ZoneId | null;
  travel: { from: ZoneId; to: ZoneId; departAt: number; arriveAt: number } | null;
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
  /** Party the player belongs to (see Party). */
  partyId?: string;
}

export interface Party {
  id: string;
  leaderId: string;
  /** Member ids in join order (the leader included). */
  members: string[];
  /** Pending invitations: invited player id -> expiry time. */
  invites: Record<string, number>;
  createdAt: number;
}

export interface Mob {
  id: string;
  type: string;
  zone: ZoneId;
  hp: number;
  aggro: Record<string, number>;
  targetId: string | null;
  nextAttackAt: number;
  deadUntil: number;
  /** Bosses: when the current fight started (enrage clock) and when the next area attack lands. */
  engagedAt?: number;
  nextAoeAt?: number;
  /** Bosses: every player who damaged it this fight (dying does not remove you). Decides who may open the spoils. */
  contributors?: string[];
}

export interface ResourceNode {
  id: string;
  type: string;
  zone: ZoneId;
  charges: number;
  nextChargeAt: number;
}

export interface LootBag {
  id: string;
  zone: ZoneId;
  ownerId: string;
  ownerName: string;
  items: Bag;
  createdAt: number;
  expiresAt: number;
  /** Boss spoils: only these players may loot until `opensToAllAt`. */
  eligible?: string[];
  opensToAllAt?: number;
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
  | { kind: 'party'; partyId: string }
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
