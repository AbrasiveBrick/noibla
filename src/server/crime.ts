// Pilfering and the evidence it leaves. The server never judges or punishes: it moves the goods and records evidence.
//
// Who learns what:
//   the thief     what they took. Nothing about witnesses, the watchtower or traces beyond what any member can read.
//   a witness     actor, act and items, privately (witness.saw, witness.log). Rolled for each player in the region.
//   members       stockpile: `missing` with the items and no actor, and sometimes `traces` with the actor.
//                 watchtower: sometimes who stood at the plot (the thief among them), not who did it or what.
//   stash owner   only that their stash holds less.
//   the operator  a `theft` event with all of it, the face under a hood included.
//   anyone else   nothing. A pilfer spends the same number of event ids whatever the evidence came to, and the logs
//                 number their entries per settlement, so no gaps in ids tell what it came to.
// Nor may the clock tell: a pilfer writes, queues and sends the same whether or not anyone saw it, so do the same work
// for every possible witness and never branch on who saw before a later tick (Game.emitCopy).
// docs/COMMUNITY_PLAN.md (stage 4) says what may still be inferred.

import { randomInt } from 'node:crypto';
import { SETTLEMENT, TIMING, baseOf, type ItemStack } from '../shared/catalog.ts';
import type { PilferSighting, Sighting } from '../shared/protocol.ts';
import { atPlot, hasBuilding, logWatch, works } from './buildings.ts';
import type { Game } from './game.ts';
import { bySeenId, seenAs } from './identity.ts';
import { CRIME_ODDS } from './odds.ts';
import { audit, requireAtPlot, requireMember } from './settlement.ts';
import type { CommandDef, Player, Settlement } from './types.ts';
import { addItems, available, describe, fail, hasItems, optInt, removeItems, reqStr, stacks, toStacks, type Bag } from './util.ts';
import { requireReady } from './world.ts';

/**
 * Not the world's rng: its state shows in loot and yields, so a player could learn or predict who sees them, and the
 * number of rolls here would show in what it rolls next.
 */
const ROLL_RANGE = 1_000_000;
const happens = (chance: number) => randomInt(ROLL_RANGE) < chance * ROLL_RANGE;
/** Addresses the copy of a bystander who saw nothing: no player has this id, so it reaches no one. */
const NOBODY = '';

/** Whose plot `p` pilfers at: their own settlement's, whatever their role. The one place that decides who may. */
function pilferTarget(g: Game, p: Player): Settlement {
  const s = requireMember(g, p);
  requireAtPlot(g, p, s, 'pilfering');
  return s;
}

/** The most one action takes of a kind of item. A base id counts with all its uniques. */
const shareOf = (bag: Bag, kind: string) => Math.floor((available(bag, kind) * SETTLEMENT.pilferPct) / 100);

const kindsIn = (bag: Bag) => [...new Set(toStacks(bag).map((i) => baseOf(i.item)))];

/**
 * Up to a share of each kind, or one single item instead, so small piles and single pieces can go too. Never the last
 * item. Errors give no amounts: stockpile.view is where those are read.
 */
function chooseLoot(pile: Bag, payload: Record<string, any>): ItemStack[] {
  if (payload.items === undefined) {
    const all = kindsIn(pile).map((item) => ({ item, qty: shareOf(pile, item) })).filter((i) => i.qty > 0);
    if (!all.length) {
      fail('NOT_ENOUGH_ITEMS', 'there is too little of anything to take a share of', undefined,
        'name one single item instead: stockpile.pilfer { items: [{ item, qty: 1 }] }. The last item in a stockpile cannot be pilfered.');
    }
    return all;
  }
  const asked = stacks(payload.items, 'items', false);
  if (!hasItems(pile, asked)) fail('NOT_ENOUGH_ITEMS', 'the stockpile does not hold all of that', undefined, 'stockpile.view at the plot shows what it holds');
  const held = Object.values(pile).reduce((n, qty) => n + qty, 0);
  if (asked.length === 1 && asked[0].qty === 1 && held > 1) return asked;
  const byKind: Bag = {};
  for (const { item, qty } of asked) byKind[baseOf(item)] = (byKind[baseOf(item)] ?? 0) + qty;
  for (const [kind, qty] of Object.entries(byKind)) {
    if (qty > shareOf(pile, kind)) {
      fail('BAD_REQUEST', `that is more ${kind} than one action can take`, undefined,
        `one action takes up to ${SETTLEMENT.pilferPct}% of each item in the stockpile (rounded down), or one single item instead, and never the last one. Without items it takes the most it can.`);
    }
  }
  return asked;
}

function stockpilePilfer(g: Game, p: Player, payload: Record<string, any>) {
  const s = pilferTarget(g, p);
  requireReady(g, p);
  const loot = chooseLoot(s.stockpile, payload);
  g.markSettlement(s);
  // Not takeBack: it starts with the taker's own units, so the shared work numbers would name the thief. At commit the
  // youngest units stop counting, whoever took them (syncPooled).
  return carryOff(g, p, s, 'stockpile.pilfer', removeItems(s.stockpile, loot));
}

/**
 * Blind: one kind at random, a share of it or one item. Any player can be named and an empty grab costs the same time
 * and the same risk, so there is no free way to learn who has a stash or whether it still holds anything.
 */
function stashPilfer(g: Game, p: Player, payload: Record<string, any>) {
  const s = pilferTarget(g, p);
  const ownerId = reqStr(payload, 'ownerId', 40);
  if (ownerId === p.id) fail('BAD_REQUEST', 'that is your own stash', undefined, 'stash.withdraw takes your things out');
  const owner = g.players.get(ownerId);
  if (!owner) fail('NOT_FOUND', `no player ${ownerId}`, undefined, 'settlement.view lists the members and their ids; player.lookup finds anyone by name');
  if (!hasBuilding(s, 'huts')) fail('SETTLEMENT_STATE', `${s.name} has no huts, so no stashes`);
  requireReady(g, p);
  g.markSettlement(s);
  const stash = s.stashes[ownerId] ?? {};
  const kinds = kindsIn(stash);
  let taken: ItemStack[] = [];
  if (kinds.length) {
    const kind = kinds[randomInt(kinds.length)];
    taken = removeItems(stash, [{ item: kind, qty: Math.max(1, shareOf(stash, kind)) }]);
    if (!Object.keys(stash).length) delete s.stashes[ownerId];
  }
  return carryOff(g, p, s, 'stash.pilfer', taken, owner!);
}

/**
 * The act, all at once: the goods, then the evidence. Like gathering it takes effect immediately and then keeps the
 * thief busy, so damage interrupts nothing. Whoever kills them meanwhile gets what they still carry.
 */
function carryOff(g: Game, p: Player, s: Settlement, act: PilferSighting['act'], taken: ItemStack[], owner?: Player) {
  const now = g.now();
  g.markPlayer(p);
  addItems(p.inventory, taken);
  const busyMs = g.ms(TIMING.pilferMs);
  p.busyUntil = now + busyMs;

  const everyone = bySeenId(g.players.values()).filter((o) => !o.dead);
  // The downed still see; the dead don't, and the tower doesn't count bodies.
  const bystanders = everyone.filter((o) => o.id !== p.id && o.zone === s.zone && !o.travel).map((o) => ({ o, saw: happens(CRIME_ODDS.witness) }));
  const witnesses = bystanders.filter((b) => b.saw).map((b) => b.o);
  // Kept in the operator's event too, so that its row is as long either way.
  const missed = bystanders.filter((b) => !b.saw).map((b) => b.o);
  // The tower makes out who is at the plot, not whose hand it is. Listed by the ids shown, not the thief first.
  const watched = works(s, 'watchtower') && happens(CRIME_ODDS.watchtower) ? everyone.filter((o) => atPlot(g, o, s)) : [];
  const stockpile = act === 'stockpile.pilfer';
  const traces = stockpile && happens(works(s, 'storehouse') ? CRIME_ODDS.tracesLocked : CRIME_ODDS.traces);

  const saw: Omit<PilferSighting, 'ts'> = {
    settlementId: s.id, settlementName: s.name, actor: seenAs(p), act, items: taken,
    ...(owner ? { owner: { id: owner.id, name: owner.name } } : {}),
  };
  const theft = g.emit('theft', { kind: 'operator' }, {
    ...saw, actor: { id: p.id, name: p.name }, ...(p.hood ? { hooded: true } : {}), witnesses: witnesses.map((o) => ({ id: o.id, name: o.name })), missed: missed.map((o) => ({ id: o.id, name: o.name })), watched: watched.map((o) => ({ id: o.id, name: o.name })), traces,
  }, { zone: s.zone, actor: p });
  for (const b of bystanders) {
    // Under their own id either way: a stand-in id would touch fewer index pages, and the commit would be quicker.
    g.store.run('INSERT INTO sightings(ts, player_id, data, seen) VALUES(?, ?, ?, ?)', now, b.o.id, JSON.stringify(saw), b.saw ? 1 : 0);
    g.emitCopy(theft, 'witness.saw', b.saw ? b.o.id : NOBODY, saw);
  }
  for (const o of watched) logWatch(g, s, now, o, 'at_pilfer');
  // No audit entry for a stash: it would show every member what was in it.
  if (stockpile) {
    audit(g, s, null, 'missing', taken);
    if (traces) audit(g, s, p, 'traces', taken);
    else g.skipEventId();
  }
  g.setLastAction(p, 'theft', `pilfered ${describe(taken)} from ${owner ? `${owner.name}'s stash in ${s.name}` : `${s.name}'s stockpile`}`);
  return { taken, inventory: toStacks(p.inventory), busyMs };
}

/** Your own sightings, newest first. The row ids stay in: their gaps would count other people's. */
function witnessLog(g: Game, p: Player, payload: Record<string, any>) {
  const limit = optInt(payload, 'limit', 1, 200, SETTLEMENT.logPage);
  const entries: Sighting[] = g.store.all<{ ts: number; data: string }>('SELECT ts, data FROM sightings WHERE player_id = ? AND seen = 1 ORDER BY id DESC LIMIT ?', p.id, limit)
    .map((r) => ({ ts: r.ts, ...JSON.parse(r.data) }));
  return { entries };
}

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const crimeCommands: Record<string, CommandDef> = {
  'stockpile.pilfer': rw(stockpilePilfer),
  'stash.pilfer': rw(stashPilfer),
  'witness.log': ro(witnessLog),
};
