import type { AbilityId, BuildingId, SkillId, Slot, ZoneId } from '../shared/catalog.ts';
import type { Pos } from '../shared/map.ts';
import type { DeathCause, GameEvent, PalisadeAlert } from '../shared/protocol.ts';
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
  /** At 0 HP and not yet dead. `forMs`: the whole time allowed, given again after a restart. */
  downed?: { at: number; until: number; forMs: number; blow: Blow };
  /** Dead for good. `settled`: the estate passed. */
  dead?: { at: number; zone: ZoneId; corpseId: string; settled?: true };
  /** A revive under way (`targetId` may be the player's own id). */
  reviving?: { targetId: string; until: number };
  /** Set while hooded and only then: the tick removes it, so it can't run out halfway through a command. */
  hood?: { as: string; until: number };
  /** The heir named at the bank: a player or settlement id. */
  will?: { kind: 'player' | 'settlement'; id: string };
}

/** A player or mob, by name. */
export interface Who { id: string; name: string }

/** What put a player down or killed them. Server-only: `as` is what players may be told. */
export interface Blow { kind: 'mob' | 'player'; id: string; name: string; as: Who; cause: DeathCause }

/** A player's corpse. The death is secret until `settledAt`: that is when the estate passed. */
export interface Corpse {
  id: string;
  zone: ZoneId;
  x: number;
  y: number;
  victim: Who;
  at: number;
  /** Server-only truth. Players get the cause and nothing else of it. */
  blow: Blow;
  bledOut: boolean;
  bagId: string | null;
  /** The settlement the victim belonged to when they died. */
  settlementId?: string;
  dueAt: number;
  settledAt?: number;
  /** `byId` is never shown: `reporter` is how they appeared. */
  reports: { ts: number; byId: string; reporter: Who; accuse: Who | null; text: string }[];
}

/** Escrowed silver. `paidTo` stays secret: the list changes when the target's death is made known. */
export interface Bounty {
  id: string;
  target: Who;
  amount: number;
  posterId: string;
  /** How the poster appeared. */
  poster: Who;
  postedAt: number;
  paidTo?: string;
}

/** An operator's copy of an event adds the truth behind hoods. */
export interface OperatorEvent extends GameEvent { hooded?: string[] }

export type SettlementRole = 'leader' | 'steward' | 'member';

export interface SettlementCharter {
  /** Open: anyone not barred may join. Closed: joining needs a live invitation. */
  open: boolean;
  /** Lowest role allowed to withdraw from the stockpile. */
  withdrawRole: SettlementRole;
  /** Percent of members' quest silver paid into the stockpile. */
  taxPct: number;
  /** Silver from the stockpile to the first to report a member's death. */
  reportReward: number;
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
  /** Shared work by member. Deleted when they leave. */
  work: Record<string, SharedWork>;
  /** Latest palisade alerts, oldest first. */
  alerts: PalisadeAlert[];
  nextIncomeAt?: number;
}

export interface SharedWork {
  /**
   * Raw units the member gathered as a member and still carries. `had`: how many of the item they carried at the last
   * commit. Whatever leaves the inventory uses up gathered units first.
   */
  gathered: Record<string, { qty: number; had: number }>;
  /**
   * Gathered units the member deposited, by item and the time from which others may refine them with shared work.
   * All members' lots of an item never add up to more than the stockpile holds of it.
   */
  given: Record<string, { qty: number; readyAt: number }[]>;
  /** The member's fraction of shared output, carried per recipe. */
  carry: Record<string, number>;
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
  /** Those of them who wore a hood when they joined the fight: the spoils never name them. */
  hoodedContributors?: string[];
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
  /** Who `eligible` are, as they were seen. */
  eligibleNames?: string[];
  opensToAllAt?: number;
  /** Lies by a corpse: looting it is told only to those who can see it. */
  corpse?: true;
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
  /** Every living player, wherever they are (death reports). */
  | { kind: 'public' }
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
