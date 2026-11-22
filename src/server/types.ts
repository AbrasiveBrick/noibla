import type { AbilityId, BuildingId, SkillId, Slot, ZoneId } from '../shared/catalog.ts';
import type { Pos } from '../shared/map.ts';
import type { GameEvent, PalisadeAlert } from '../shared/protocol.ts';
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
  /** Starter kit version already granted (see KIT_VERSION). Optional: saves from before stage 3 have none. */
  kitVersion?: number;
  /** Well fed until then (see FOOD). */
  wellFedUntil?: number;
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
  /** Settlement the player belongs to (see Settlement). */
  settlementId?: string;
}

export type SettlementRole = 'leader' | 'steward' | 'member';

export interface SettlementCharter {
  /** Open: anyone not barred may join. Closed: joining needs a live invitation. */
  open: boolean;
  /** Lowest role allowed to withdraw from the stockpile. */
  withdrawRole: SettlementRole;
  /** Percent of members' quest silver paid into the stockpile. */
  taxPct: number;
}

/** A settlement.vote motion: exile a member, or make a member the leader. */
export interface SettlementMotion {
  id: string;
  kind: 'exile' | 'leader';
  targetId: string;
  openedBy: string;
  openedAt: number;
  expiresAt: number;
  /** Voter id -> yes (true) or no (false). */
  votes: Record<string, boolean>;
}

export interface Settlement {
  id: string;
  name: string;
  zone: ZoneId;
  plotId: string;
  founderId: string;
  foundedAt: number;
  /** Member id -> role and join time. Exactly one leader. */
  members: Record<string, { role: SettlementRole; joinedAt: number }>;
  charter: SettlementCharter;
  /** Shared items, kept at the plot. Members only (see stockpile.*); every change is written to stockpile_log. */
  stockpile: Bag;
  /** Pending invitations: invited player id -> expiry time. */
  invites: Record<string, number>;
  /** Expelled or exiled players: barred from joining an open settlement until invited again. */
  barred: Record<string, number>;
  motions: SettlementMotion[];
  /** Public level, from the buildings that stand and the members (see levelOf). */
  level: number;
  // Saves from before stage 3 lack the fields below: upgradeSettlement adds them on load.
  buildings: SettlementBuilding[];
  /** Construction under way. */
  projects: Partial<Record<BuildingId, SettlementProject>>;
  /** Owner id -> stash. It stays the owner's after they leave. */
  stashes: Record<string, Bag>;
  /** Shared work by member: raw units that cover others' refining, and the member's fraction of output carried per recipe. */
  work: Record<string, { cover: Bag; carry: Record<string, number> }>;
  /** Latest palisade alerts, oldest first. */
  alerts: PalisadeAlert[];
  nextIncomeAt?: number;
}

/** A finished building. `unpaid`: the stockpile could not pay its upkeep, so it does nothing. */
export interface SettlementBuilding { id: BuildingId; builtAt: number; paidUntil: number; unpaid?: boolean }

export interface SettlementProject { materials: Bag; work: number; startedBy: string }

export interface Party {
  id: string;
  leaderId: string;
  /** Member ids in join order (the leader included). */
  members: string[];
  /** Pending invitations: invited player id -> expiry time. */
  invites: Record<string, number>;
  createdAt: number;
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
  /** Members of a settlement only (stockpile activity, membership, votes). */
  | { kind: 'settlement'; id: string }
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
