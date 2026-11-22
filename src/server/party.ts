// Parties: small groups that fight together. Members in the same region see each other's position and HP,
// share kill credit and bonus XP, and hit harder side by side (see PARTY in the catalog).
// Party chat and membership events go only to members (Visibility 'party').

import { PARTY } from '../shared/catalog.ts';
import type { PartyInviteView, PartyMessage, PartyView } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { CommandDef, Party, Player } from './types.ts';
import { cleanText, fail, newId, reqStr } from './util.ts';
import { maxHp, posOf } from './world.ts';

const MAX_PARTY_CHAT = 500;

export function partyOf(g: Game, p: Player): Party | undefined {
  return p.partyId ? g.parties.get(p.partyId) : undefined;
}

/**
 * Inviting creates a party of one right away, and a party can shrink back to one. Being alone in a party never blocks
 * being invited or joining another: only sharing a party with someone does.
 */
function hasPartymates(g: Game, p: Player): boolean {
  return (partyOf(g, p)?.members.length ?? 0) > 1;
}

/**
 * Other party members on their feet in the same region as `p` (walking or not). A hood fights alone, both ways: a
 * partner's bonus or credit would say who is under it.
 */
export function alliesInZone(g: Game, p: Player): Player[] {
  const pt = partyOf(g, p);
  if (!pt || p.hood) return [];
  return pt.members.filter((id) => id !== p.id).map((id) => g.players.get(id)).filter((o): o is Player => !!o && !o.hood && !o.downed && !o.dead && o.zone === p.zone);
}

/** Attack damage multiplier from allies fighting beside you. */
export function partyDamageMult(g: Game, p: Player): number {
  return 1 + Math.min(PARTY.maxDamageBonus, PARTY.damageBonusPerAlly * alliesInZone(g, p).length);
}

function liveInvites(g: Game, pt: Party): [string, number][] {
  const now = g.now();
  return Object.entries(pt.invites).filter(([, exp]) => exp > now);
}

/** As `viewerId` sees it: nothing from afar, so a distant partner can't watch someone go down, and nothing of a hood. */
export function partyView(g: Game, pt: Party, viewerId: string): PartyView {
  const now = g.now();
  const viewer = g.players.get(viewerId)!;
  return {
    id: pt.id,
    leaderId: pt.leaderId,
    members: pt.members.map((id) => {
      const o = g.players.get(id)!;
      const member = { id, name: o.name, leader: id === pt.leaderId, online: g.isOnline(id) };
      if (id !== viewerId && (o.zone !== viewer.zone || o.hood)) return { ...member, zone: null, pos: null, walking: null, hp: null, maxHp: null };
      const pos = posOf(g, o);
      return { ...member, zone: o.zone, pos: { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10 }, walking: !!o.travel, hp: o.hp, maxHp: maxHp(o) };
    }),
    invites: liveInvites(g, pt).map(([id, exp]) => ({ playerId: id, name: g.players.get(id)?.name ?? 'unknown', expiresInMs: exp - now })),
  };
}

export function invitesFor(g: Game, p: Player): PartyInviteView[] {
  const now = g.now();
  const out: PartyInviteView[] = [];
  for (const pt of g.parties.values()) {
    const exp = pt.invites[p.id];
    if (exp === undefined || exp <= now) continue;
    const leader = g.players.get(pt.leaderId)!;
    out.push({ partyId: pt.id, fromId: leader.id, fromName: leader.name, members: pt.members.map((id) => g.players.get(id)?.name ?? 'unknown'), expiresInMs: exp - now });
  }
  return out;
}

function opLog(g: Game, p: Player, pt: Party, action: string, extra: Record<string, unknown> = {}) {
  g.emit('party', { kind: 'operator' }, { partyId: pt.id, action, playerId: p.id, name: p.name, members: pt.members.map((id) => g.players.get(id)?.name), ...extra }, { actor: p, zone: p.zone });
}

function requireLeader(g: Game, p: Player): Party {
  const pt = partyOf(g, p);
  if (!pt) fail('PARTY_STATE', 'you are not in a party', undefined, 'party.invite creates a party with you as its leader');
  if (pt!.leaderId !== p.id) fail('FORBIDDEN', `only the party leader (${g.players.get(pt!.leaderId)?.name}) can do that`);
  return pt!;
}

function invite(g: Game, p: Player, payload: Record<string, any>) {
  const targetId = reqStr(payload, 'playerId', 40);
  const target = g.players.get(targetId);
  if (!target) fail('NOT_FOUND', `no player ${targetId}; use player.lookup to resolve names to stable ids`);
  if (targetId === p.id) fail('BAD_REQUEST', 'cannot invite yourself');
  let pt = partyOf(g, p);
  if (pt && pt.leaderId !== p.id) fail('FORBIDDEN', `only the party leader (${g.players.get(pt.leaderId)?.name}) can invite`);
  if (hasPartymates(g, target!)) fail('PARTY_STATE', `${target!.name} is already in a party`, undefined, 'they must party.leave first');
  if (pt && pt.members.length + liveInvites(g, pt).filter(([id]) => id !== targetId).length >= PARTY.maxSize) {
    fail('PARTY_STATE', `a party holds at most ${PARTY.maxSize} players, counting pending invites`);
  }
  const now = g.now();
  if (!pt) {
    pt = { id: newId('party'), leaderId: p.id, members: [p.id], invites: {}, createdAt: now };
    g.parties.set(pt.id, pt);
    p.partyId = pt.id;
    g.markPlayer(p);
  }
  // Drop expired invites while we are here.
  for (const [id, exp] of Object.entries(pt.invites)) if (exp <= now) delete pt.invites[id];
  pt.invites[targetId] = now + g.ms(PARTY.inviteTtlMs);
  g.markParty(pt);
  g.emit('party.invited', { kind: 'player', playerId: targetId }, { partyId: pt.id, fromId: p.id, fromName: p.name, members: pt.members.map((id) => g.players.get(id)?.name), expiresInMs: g.ms(PARTY.inviteTtlMs) }, {});
  opLog(g, p, pt, 'invite', { targetName: target!.name });
  g.setLastAction(p, 'party', `invited ${target!.name} to the party`);
  return { party: partyView(g, pt, p.id) };
}

function accept(g: Game, p: Player, payload: Record<string, any>) {
  const partyId = reqStr(payload, 'partyId', 40);
  const pt = g.parties.get(partyId);
  const exp = pt?.invites[p.id];
  if (!pt || exp === undefined) fail('NOT_FOUND', `no invitation to party ${partyId}`, undefined, 'observe().partyInvites lists your invitations');
  if (exp! <= g.now()) fail('PARTY_STATE', 'that invitation expired', undefined, 'ask the leader to invite you again');
  if (hasPartymates(g, p)) fail('PARTY_STATE', 'you are already in a party', undefined, 'party.leave first');
  if (pt!.members.length >= PARTY.maxSize) fail('PARTY_STATE', `the party is full (${PARTY.maxSize})`);
  const own = partyOf(g, p);
  if (own) {
    // A party of one gives way to the one being joined; invitations it sent lapse with it.
    removeMember(g, own, p, 'leave');
    opLog(g, p, own, 'leave');
  }
  delete pt!.invites[p.id];
  pt!.members.push(p.id);
  p.partyId = pt!.id;
  g.markParty(pt!);
  g.markPlayer(p);
  g.emit('party.joined', { kind: 'party', partyId: pt!.id }, { partyId: pt!.id, playerId: p.id, name: p.name }, {});
  opLog(g, p, pt!, 'join');
  g.setLastAction(p, 'party', `joined ${g.players.get(pt!.leaderId)?.name}'s party`);
  return { party: partyView(g, pt!, p.id) };
}

function decline(g: Game, p: Player, payload: Record<string, any>) {
  const partyId = reqStr(payload, 'partyId', 40);
  const pt = g.parties.get(partyId);
  if (!pt || pt.invites[p.id] === undefined) fail('NOT_FOUND', `no invitation to party ${partyId}`);
  delete pt!.invites[p.id];
  g.markParty(pt!);
  opLog(g, p, pt!, 'decline');
  return { declined: partyId };
}

/** Removes `who` from their party: the next member leads if the leader goes, and an empty party disbands. */
export function removeMember(g: Game, pt: Party, who: Player, action: 'leave' | 'kick' | 'death') {
  pt.members = pt.members.filter((id) => id !== who.id);
  delete who.partyId;
  g.markPlayer(who);
  g.emit('party.left', { kind: 'party', partyId: pt.id }, { partyId: pt.id, playerId: who.id, name: who.name, kicked: action === 'kick', ...(action === 'death' ? { died: true } : {}) }, {});
  if (action === 'kick') g.emit('party.left', { kind: 'player', playerId: who.id }, { partyId: pt.id, playerId: who.id, name: who.name, kicked: true }, {});
  if (!pt.members.length) {
    g.parties.delete(pt.id);
    g.markParty(pt);
    return;
  }
  if (pt.leaderId === who.id) pt.leaderId = pt.members[0];
  g.markParty(pt);
}

function leave(g: Game, p: Player) {
  const pt = partyOf(g, p);
  if (!pt) fail('PARTY_STATE', 'you are not in a party');
  removeMember(g, pt!, p, 'leave');
  opLog(g, p, pt!, 'leave');
  g.setLastAction(p, 'party', 'left the party');
  return { left: pt!.id };
}

function kick(g: Game, p: Player, payload: Record<string, any>) {
  const pt = requireLeader(g, p);
  const targetId = reqStr(payload, 'playerId', 40);
  if (targetId === p.id) fail('BAD_REQUEST', 'use party.leave to leave your own party');
  const target = g.players.get(targetId);
  if (!target || !pt.members.includes(targetId)) {
    if (pt.invites[targetId] !== undefined) { delete pt.invites[targetId]; g.markParty(pt); return { party: partyView(g, pt, p.id) }; }
    fail('NOT_FOUND', `${target?.name ?? targetId} is not in your party`);
  }
  removeMember(g, pt, target!, 'kick');
  opLog(g, p, pt, 'kick', { targetName: target!.name });
  g.setLastAction(p, 'party', `kicked ${target!.name} from the party`);
  return { party: partyView(g, pt, p.id) };
}

function say(g: Game, p: Player, payload: Record<string, any>) {
  const pt = partyOf(g, p);
  if (!pt) fail('PARTY_STATE', 'you are not in a party');
  const text = cleanText(payload, 'text', MAX_PARTY_CHAT);
  const message: PartyMessage = { partyId: pt!.id, authorId: p.id, authorName: p.name, text, ts: g.now(), authorKind: 'player' };
  g.emit('party.message', { kind: 'party', partyId: pt!.id }, { message }, { actor: p });
  g.setLastAction(p, 'chat', 'spoke in party chat');
  return { message };
}

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const partyCommands: Record<string, CommandDef> = {
  'party.invite': rw(invite),
  'party.accept': rw(accept),
  'party.decline': rw(decline),
  'party.leave': rw((g, p) => leave(g, p)),
  'party.kick': rw(kick),
  'party.view': ro((g, p) => { const pt = partyOf(g, p); return { party: pt ? partyView(g, pt, p.id) : null, invites: invitesFor(g, p) }; }),
  'party.say': rw(say),
};
