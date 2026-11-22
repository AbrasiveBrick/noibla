// Who a player appears to be. While hooded they are "a hooded figure" under a throwaway id in everything others can
// see them do or say in the world.
//
// The rule for every module:
//   - An act done in the world, or a view of one, names the player with seenAs(), never with p.id or p.name.
//   - A command that only makes sense under your own name and would also say where you stand (trading, founding,
//     shared work, wills) refuses a hood (requireFace). It must never show the figure and the name together.
//   - Acts from anywhere under your own name (DM, party, membership, votes) keep the name and carry no figure.
//   - A lookup by a player's own id or name never finds them while hooded, and answers exactly as if they were elsewhere.
//   - Lists of players are in the order of the ids shown (bySeenId): registration order would tell who a figure is.

import { HOOD } from '../shared/catalog.ts';
import type { EventType } from '../shared/protocol.ts';
import type { Player, Who } from './types.ts';
import { fail } from './util.ts';

const ALIAS_RE = /^hood_[0-9a-f]{12}$/;

/** A throwaway id a hood gave: also what chat and forum rows keep as their author. */
export const isAlias = (id: string) => ALIAS_RE.test(id);

export function seenAs(p: Player): Who {
  return p.hood ? { id: p.hood.as, name: HOOD.name } : { id: p.id, name: p.name };
}

export function bySeenId(players: Iterable<Player>): Player[] {
  const key = (p: Player) => p.hood?.as ?? p.id;
  return [...players].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

export function requireFace(p: Player, now: number, what: string) {
  if (!p.hood) return;
  fail('HOODED', `${what} needs your face, and you are hooded`, p.hood.until - now, 'it would tell who the hooded figure is: wait retryAfterMs for the hood to come off');
}

/** Events about acts from anywhere under one's own name: their actor is never masked. All others mask it. */
export const OWN_NAME_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'party.joined', 'party.left', 'party.message',
  'settlement.invited', 'settlement.joined', 'settlement.left', 'settlement.role', 'settlement.charter', 'settlement.vote',
]);
