// Downed, permanent death and the murder mystery around it. As with theft, the server never judges: it produces
// evidence and moves what the rules say moves.
//
// Who learns what:
//   the victim      who struck them, as they appeared. Once dead they hear and see nothing more.
//   present         everyone in the region: player.downed, player.death with the killer as they appeared, witness.log.
//                   Someone who bled out has no killer in player.death: only those present at the blow saw it.
//   the corpse      cause, weapon base, an approximate time and watchtower movements, to whoever stands by it.
//   members, heir, party, bounty posters
//                   nothing until the death is made known (settleEstate): the first report, else a timer.
//   the operator    the true killer, behind any hood.
//   anyone else     nothing. A blow spends two event ids whether it hurts, downs or kills, and whoever is told,
//                   so the gaps in an outsider's stream don't tell a death from a hit.
// docs/COMMUNITY_PLAN.md (stage 5) says what may still be inferred.

import { DEATH, DEATH_SILVER_LOSS, HOOD, SETTLEMENT, TIMING, baseOf, itemDef, type ItemStack } from '../shared/catalog.ts';
import { dist, plotOf, regionAt } from '../shared/map.ts';
import type { AttackSighting, BountyView, CorpseExamination, DeathNoticeView, HeirView } from '../shared/protocol.ts';
import { works } from './buildings.ts';
import type { Game } from './game.ts';
import { bySeenId, requireFace, seenAs } from './identity.ts';
import { partyOf, removeMember as removePartner } from './party.ts';
import { audit, removeMember, settlementOf } from './settlement.ts';
import { expireTradesOf } from './trade.ts';
import type { Blow, Bounty, CommandDef, Corpse, Player, Settlement, Who } from './types.ts';
import { GameError, addItems, available, cleanText, describe, fail, newId, optInt, optStr, removeItems, reqInt, reqStr, toStacks, type Bag } from './util.ts';
import { clearAggro, findPlayer, maxHp, notInSight, posOf, requireArrived, requireInRange, requirePlace, requireReady } from './world.ts';

type Source = { kind: 'mob' | 'player'; id: string; name: string };
const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- what the downed and the dead may do ----------

const WHILE_DOWNED: ReadonlySet<string> = new Set(['revive', 'reportFeedback']);

/** The error that stops a downed or dead player's command, if one does. */
export function blocked(g: Game, p: Player, type: string, def: CommandDef): GameError | null {
  if (p.dead) {
    if (type === 'observe') return null;
    return new GameError('DEAD', `${p.name} is dead, for good`, undefined,
      `nothing brings this character back; only observe still works. Register a new character under a new name (GameClient.register(url, '<name>-2'), then -3 and so on: names stay reserved, at most 20 characters), save its token and go on with that one.`);
  }
  if (p.downed && def.mutates && !WHILE_DOWNED.has(type)) {
    const left = p.downed.until - g.now();
    return new GameError('DOWNED', 'you are downed: you cannot act, chat or DM', left > 0 ? left : undefined,
      p.reviving ? 'your revive is under way: wait for it to finish'
        : available(p.inventory, DEATH.bandage) ? `send revive {} now to bandage yourself (you carry a ${DEATH.bandage}). When the time runs out you die for good.`
          : `you carry no ${DEATH.bandage}: only someone else's revive can save you. When the time runs out you die for good.`);
  }
  return null;
}

// ---------- going down and dying ----------

function blowOf(g: Game, source: Source): Blow {
  if (source.kind === 'mob') {
    return { ...source, as: { id: source.id, name: source.name }, cause: { by: 'mob', mob: g.mobs.get(source.id)?.type ?? source.name } };
  }
  const attacker = g.players.get(source.id);
  const held = attacker?.equipment.weapon;
  const weapon = held ? baseOf(held) : null;
  return {
    ...source, as: attacker ? seenAs(attacker) : { id: source.id, name: source.name },
    cause: { by: 'player', wound: held && itemDef(held)?.weaponSkill === 'swords' ? 'cut' : 'beaten', weapon },
  };
}

/** Everyone in the victim's region who can still see, except who did it. No roll: being there is seeing it. */
function present(g: Game, victim: Player, actorId: string | null): Player[] {
  return [...g.players.values()].filter((o) => o.id !== victim.id && o.id !== actorId && !o.dead && o.zone === victim.zone);
}

function remember(g: Game, witnesses: Player[], saw: Omit<AttackSighting, 'ts'>) {
  for (const o of witnesses) g.store.run('INSERT INTO sightings(ts, player_id, data) VALUES(?, ?, ?)', g.now(), o.id, JSON.stringify(saw));
}

function endRevivesOf(g: Game, targetId: string) {
  for (const o of g.players.values()) {
    if (o.reviving?.targetId !== targetId) continue;
    g.markPlayer(o);
    delete o.reviving;
    if (o.id !== targetId) o.busyUntil = g.now();
  }
}

/** Where someone falls: their position, unless a step since the last tick already took it out of their region. */
function fallsAt(g: Game, p: Player) {
  const pos = posOf(g, p);
  return regionAt(g.map, pos) === p.zone ? { ...pos } : { ...p.pos };
}

function downedFor(g: Game, p: Player): number {
  const s = settlementOf(g, p);
  const near = s && s.zone === p.zone && works(s, 'infirmary') && dist(p.pos, plotOf(g.map, s.plotId)!) <= DEATH.infirmaryRange + 1e-9;
  return g.ms(TIMING.downedMs * (near ? DEATH.infirmaryMult : 1));
}

/** At 0 HP. Emits player.downed and self.downed in place of the hit's combat.hit and self.damaged. */
export function downPlayer(g: Game, victim: Player, source: Source, damage: number, ability?: string) {
  const now = g.now();
  g.markPlayer(victim);
  const blow = blowOf(g, source);
  victim.pos = fallsAt(g, victim);
  victim.travel = null;
  victim.hp = 0;
  victim.evadeUntil = 0;
  victim.braceUntil = 0;
  delete victim.reviving;
  const forMs = downedFor(g, victim);
  victim.downed = { at: now, until: now + forMs, forMs, blow };
  clearAggro(g, victim.id);

  const who = seenAs(victim);
  const actorId = source.kind === 'player' ? source.id : null;
  const witnesses = present(g, victim, actorId);
  g.emit('player.downed', { kind: 'zone', zone: victim.zone }, {
    victimId: who.id, victimName: who.name, byKind: source.kind, byId: blow.as.id, byName: blow.as.name, damage, ...(ability ? { ability } : {}), zone: victim.zone,
  }, { zone: victim.zone, actor: victim, truth: { byId: source.id, byName: source.name, forMs } });
  g.emit('self.downed', { kind: 'player', playerId: victim.id }, {
    sourceKind: source.kind, sourceId: blow.as.id, sourceName: blow.as.name, damage, leftMs: forMs, bandages: available(victim.inventory, DEATH.bandage),
    note: `You are downed and die for good in ${Math.round(forMs / 1000)}s. revive {} bandages yourself if you carry a ${DEATH.bandage}; otherwise someone has to revive you.`,
  }, { zone: victim.zone });
  remember(g, witnesses, { act: 'player.downed', zone: victim.zone, actor: blow.as, victim: who });
  g.setLastAction(victim, 'downed', `downed in ${victim.zone} by ${source.name}`);
}

/** Killed outright: a downed player finished. */
export function killPlayer(g: Game, victim: Player, source: Source) {
  die(g, victim, blowOf(g, source), false);
}

function die(g: Game, victim: Player, blow: Blow, bledOut: boolean) {
  if (victim.dead) return;
  const now = g.now();
  const zone = victim.zone;
  g.markPlayer(victim);
  endRevivesOf(g, victim.id);
  victim.pos = fallsAt(g, victim);
  victim.travel = null;

  const silverLost = Math.floor((victim.inventory.silver ?? 0) * DEATH_SILVER_LOSS);
  if (silverLost > 0) removeItems(victim.inventory, [{ item: 'silver', qty: silverLost }]);
  g.store.ledger('destroyed.death', silverLost);
  const items: Bag = { ...victim.inventory };
  for (const it of Object.values(victim.equipment)) if (it) items[it] = (items[it] ?? 0) + 1;
  victim.inventory = {};
  victim.equipment = {};
  victim.wear = {};
  const dropped = toStacks(items);

  const x = round1(victim.pos.x), y = round1(victim.pos.y);
  const windowEnd = timeWindow(g, now).to;
  let bagId: string | null = null;
  if (dropped.length) {
    bagId = newId('bag');
    // Dated by the window, or its countdown would give the exact time of death.
    const bag = { id: bagId, zone, x, y, ownerId: victim.id, ownerName: victim.name, items, createdAt: windowEnd, expiresAt: windowEnd + g.ms(TIMING.lootBagTtlMs), corpse: true as const };
    g.bags.set(bagId, bag);
    g.markBag(bag);
  }
  const corpse: Corpse = {
    id: newId('corpse'), zone, x, y, victim: { id: victim.id, name: victim.name }, at: now, blow, bledOut, bagId,
    ...(victim.settlementId ? { settlementId: victim.settlementId } : {}), dueAt: windowEnd + g.ms(DEATH.knownAfterMs), reports: [],
  };
  g.corpses.set(corpse.id, corpse);
  g.markCorpse(corpse);

  clearAggro(g, victim.id);
  victim.hp = 0;
  victim.busyUntil = 0;
  victim.cooldowns = {};
  victim.evadeUntil = 0;
  victim.braceUntil = 0;
  victim.wellFedUntil = 0;
  victim.lastCombatAt = 0;
  victim.combatLockUntil = 0;
  victim.stats.deaths++;
  delete victim.downed;
  // Death takes the hood off.
  delete victim.hood;
  victim.dead = { at: now, zone, corpseId: corpse.id };

  const killer = blow.kind === 'player' ? g.players.get(blow.id) : undefined;
  if (killer) {
    g.markPlayer(killer);
    killer.stats.kills++;
  }
  const actor = bledOut ? null : blow.as;
  const witnesses = present(g, victim, !bledOut && killer ? killer.id : null);
  const paid = killer && !killer.dead ? payBounties(g, victim, killer) : [];
  g.emit('player.death', { kind: 'zone', zone }, {
    victimId: victim.id, victimName: victim.name, killerKind: bledOut ? null : blow.kind, killerId: actor?.id ?? null, killerName: actor?.name ?? null,
    bledOut, zone, corpseId: corpse.id, bagId, dropped, silverLost,
  }, {
    zone, actor: victim,
    truth: { killerKind: blow.kind, killerId: blow.id, killerName: blow.name, witnesses: witnesses.map((o) => ({ id: o.id, name: o.name })), bounty: paid.reduce((n, b) => n + b.amount, 0) },
  });
  const died = g.emit('self.died', { kind: 'player', playerId: victim.id }, {
    zone, killerKind: blow.kind, killerId: blow.as.id, killerName: blow.as.name, bledOut, corpseId: corpse.id, bagId, dropped, silverLost,
    note: 'You died, for good. Only observe works now. Register a new character under a new name to go on.',
  }, { zone });
  remember(g, witnesses, { act: 'player.death', zone, actor, victim: { id: victim.id, name: victim.name } });
  if (killer && paid.length) {
    // With the victim's own event, which the killer never gets: nobody receives two events under one id.
    g.emitCopy(died, 'bounty.paid', killer.id, { target: corpse.victim, amount: paid.reduce((n, b) => n + b.amount, 0), bounties: paid.length, to: 'bank' });
  }
  g.setLastAction(victim, 'death', `died for good in ${zone}: ${bledOut ? 'bled out, downed' : 'killed'} by ${blow.name}`);
}

/** The killer is paid at once and quietly. The list keeps showing the bounty until the death is made known. */
function payBounties(g: Game, victim: Player, killer: Player): Bounty[] {
  const paid = [...g.bounties.values()].filter((b) => b.target.id === victim.id && !b.paidTo);
  for (const b of paid) {
    g.markBounty(b);
    b.paidTo = killer.id;
    addItems(killer.bank, [{ item: 'silver', qty: b.amount }]);
  }
  return paid;
}

// ---------- revive ----------

function revive(g: Game, p: Player, payload: Record<string, any>) {
  const now = g.now();
  const key = optStr(payload, 'targetId', 80);
  const self = key === undefined || key === p.id || key === p.hood?.as;
  if (p.downed && !self) fail('DOWNED', 'you are downed: you can only revive yourself', undefined, 'send revive {} with no targetId');
  if (p.reviving) fail('BUSY', 'a revive is already under way', p.reviving.until - now);
  let target: Player;
  if (self) {
    if (!p.downed) fail('INVALID_TARGET', 'you are not downed', undefined, 'revive { targetId } revives someone else who is downed');
    if (now >= p.downed!.until) fail('DOWNED', 'your time has run out');
    if (!available(p.inventory, DEATH.bandage)) {
      fail('NOT_ENOUGH_ITEMS', `reviving yourself takes a ${DEATH.bandage}, and you carry none`, undefined, 'only another player can revive you now');
    }
    target = p;
  } else {
    requireArrived(g, p);
    const found = findPlayer(g, p, key!);
    if (!found) notInSight(g, 'INVALID_TARGET', key!, `no player ${key}`);
    target = found!;
    const who = seenAs(target);
    requireInRange(g, p, posOf(g, target), who.id, who.name);
    if (target.dead) fail('TARGET_DEAD', `${who.name} is dead: no revive brings them back`, undefined, 'corpse.examine shows what the body tells, death.report makes the death known');
    if (!target.downed) fail('INVALID_TARGET', `${who.name} is not downed`);
    if (now >= target.downed!.until) fail('INVALID_TARGET', `${who.name} is past saving`);
    requireReady(g, p);
  }
  g.markPlayer(p);
  // Used up as it starts: an interrupted self-revive is a death.
  if (self) removeItems(p.inventory, [{ item: DEATH.bandage, qty: 1 }]);
  const busyMs = g.ms(TIMING.reviveMs);
  p.reviving = { targetId: target.id, until: now + busyMs };
  // Going down cuts no pilfer short, and neither does getting up.
  p.busyUntil = Math.max(p.busyUntil, now + busyMs);
  const by = seenAs(p);
  const on = seenAs(target);
  g.emit('player.reviving', { kind: 'zone', zone: target.zone }, { playerId: by.id, name: by.name, targetId: on.id, targetName: on.name, channelMs: busyMs }, { zone: target.zone, actor: p });
  g.setLastAction(p, 'revive', self ? 'bandaging themself' : `reviving ${target.name}`);
  return { targetId: on.id, busyMs };
}

function finishRevive(g: Game, p: Player) {
  const target = g.players.get(p.reviving!.targetId)!;
  g.markPlayer(p);
  g.markPlayer(target);
  endRevivesOf(g, target.id);
  delete target.downed;
  target.hp = Math.max(1, Math.ceil((maxHp(target) * DEATH.reviveHpPct) / 100));
  target.lastCombatAt = g.now();
  const by = seenAs(p);
  const on = seenAs(target);
  g.emit('player.revived', { kind: 'zone', zone: target.zone }, { playerId: on.id, name: on.name, byId: by.id, byName: by.name, hp: target.hp }, { zone: target.zone, actor: target });
  g.setLastAction(target, 'revive', p === target ? 'bandaged themself back up' : `revived by ${p.name}`);
}

// ---------- tick ----------

/** Runs after worldTick, so a hit that lands in the same tick still interrupts a revive. */
export function deathTick(g: Game, now: number) {
  const players = bySeenId(g.players.values());
  for (const p of players) {
    if (p.hood && p.hood.until <= now) {
      g.markPlayer(p);
      delete p.hood;
    }
    if (p.reviving && p.reviving.until <= now) finishRevive(g, p);
  }
  for (const p of players) {
    if (!p.downed || now < p.downed.until) continue;
    // A revive that started in time holds death off until it ends.
    if (players.some((o) => o.reviving?.targetId === p.id)) continue;
    die(g, p, p.downed.blow, true);
  }
  for (const c of g.corpses.values()) if (!c.settledAt && now >= c.dueAt) settleEstate(g, c);
}

// ---------- the death made known ----------

/**
 * Trades end, the estate passes (heir, else the settlement, else destroyed), membership and party end and the bounties
 * close. What a will said must not show in the event ids: it spends the same number whoever inherits.
 */
function settleEstate(g: Game, c: Corpse) {
  const p = g.players.get(c.victim.id)!;
  g.markCorpse(c);
  g.markPlayer(p);
  c.settledAt = g.now();
  p.dead!.settled = true;
  // Their escrow comes back to the empty inventory and passes with the rest.
  expireTradesOf(g, p);

  const goods: Bag = { ...p.bank };
  addItems(goods, toStacks(p.inventory));
  p.bank = {};
  p.inventory = {};
  for (const s of g.settlements.values()) {
    if (s.invites[p.id] !== undefined) {
      g.markSettlement(s);
      delete s.invites[p.id];
    }
    if (!s.stashes[p.id]) continue;
    g.markSettlement(s);
    addItems(goods, toStacks(s.stashes[p.id]));
    delete s.stashes[p.id];
  }
  const items = toStacks(goods);

  const named = p.will;
  const heir = named?.kind === 'player' ? g.players.get(named.id) : undefined;
  const toPlayer = heir && !heir.dead ? heir : undefined;
  let toSettlement: Settlement | undefined;
  if (!toPlayer) {
    toSettlement = (named?.kind === 'settlement' ? g.settlements.get(named.id) : undefined) ?? (c.settlementId ? g.settlements.get(c.settlementId) : undefined);
  }
  const to = toPlayer ? { kind: 'player', id: toPlayer.id, name: toPlayer.name } : toSettlement ? { kind: 'settlement', id: toSettlement.id, name: toSettlement.name } : null;
  // No zone on these two: their private copies would tell heirs and posters where it happened.
  const estate = g.emit('estate', { kind: 'operator' }, { corpseId: c.id, victim: c.victim, where: c.zone, to, items, reported: c.reports.length > 0 }, { actor: p });

  if (toPlayer) {
    g.markPlayer(toPlayer);
    addItems(toPlayer.bank, items);
    g.emitCopy(estate, 'will.inherited', toPlayer.id, { from: c.victim, items, to: 'bank' });
  } else if (!toSettlement) {
    g.store.ledger('destroyed.estate', goods.silver ?? 0);
  }
  if (toSettlement && items.length) {
    g.markSettlement(toSettlement);
    addItems(toSettlement.stockpile, items);
    audit(g, toSettlement, p, 'inherit', items);
  } else g.skipEventId();

  // One id of their own for the notices, or an heir who is also a poster would get two events under one.
  const open = [...g.bounties.values()].filter((b) => b.target.id === p.id);
  const closing = g.emit('bounty', { kind: 'operator' }, { stage: 'closed', target: c.victim, bounties: open.length });
  const notices = new Map<string, { bountyId: string; amount: number; paid: boolean; refunded: number }[]>();
  for (const b of open) {
    const poster = g.players.get(b.posterId)!;
    g.markBounty(b);
    g.bounties.delete(b.id);
    if (!b.paidTo) {
      if (!poster.dead?.settled) {
        g.markPlayer(poster);
        addItems(poster.bank, [{ item: 'silver', qty: b.amount }]);
      } else g.store.ledger('destroyed.estate', b.amount);
    }
    notices.set(poster.id, [...(notices.get(poster.id) ?? []), { bountyId: b.id, amount: b.amount, paid: !!b.paidTo, refunded: b.paidTo ? 0 : b.amount }]);
  }
  for (const [id, bounties] of notices) g.emitCopy(closing, 'bounty.closed', id, { target: c.victim, bounties });

  // Membership last: the last member's goes into the stockpile and spills with it.
  const s = settlementOf(g, p);
  if (s) removeMember(g, s, p, 'death');
  const pt = partyOf(g, p);
  if (pt) removePartner(g, pt, p, 'death');
}

// ---------- corpses and reports ----------

export function corpseShown(g: Game, c: Corpse): boolean {
  return g.now() < c.at + g.ms(DEATH.corpseMs);
}

function timeWindow(g: Game, ts: number) {
  const size = g.ms(DEATH.timeWindowMs);
  const from = Math.floor(ts / size) * size;
  return { from, to: from + size };
}

function requireCorpse(g: Game, p: Player, payload: Record<string, any>): Corpse {
  const id = reqStr(payload, 'corpseId', 80);
  requireArrived(g, p);
  const c = g.corpses.get(id);
  if (!c || !corpseShown(g, c)) fail('NOT_FOUND', `no corpse ${id}`, undefined, 'observe().zone.corpses lists the corpses in view');
  requireInRange(g, p, c!, id, 'corpse');
  return c!;
}

function examine(g: Game, p: Player, payload: Record<string, any>): CorpseExamination {
  const c = requireCorpse(g, p, payload);
  const diedAbout = timeWindow(g, c.at);
  const from = diedAbout.from - g.ms(DEATH.clueBeforeMs);
  const until = diedAbout.to + g.ms(DEATH.clueAfterMs);
  const watchtower = new Map<string, CorpseExamination['watchtower'][number]>();
  for (const s of g.settlements.values()) {
    if (s.zone !== c.zone) continue;
    const rows = g.store.all<{ ts: number; player_id: string; name: string; move: 'arrive' | 'depart' }>(
      "SELECT ts, player_id, name, move FROM watch_log WHERE settlement_id = ? AND ts BETWEEN ? AND ? AND move IN ('arrive', 'depart') ORDER BY id", s.id, from, until);
    // Two towers log the same crossing. No entry ids: they count per settlement.
    for (const r of rows) watchtower.set(`${r.ts} ${r.player_id} ${r.move}`, { ts: r.ts, playerId: r.player_id, name: r.name, move: r.move });
  }
  return {
    corpseId: c.id, victim: { ...c.victim }, zone: c.zone, cause: { ...c.blow.cause }, bledOut: c.bledOut, diedAbout,
    bagId: c.bagId && g.bags.has(c.bagId) ? c.bagId : null,
    watchtower: [...watchtower.values()].sort((a, b) => a.ts - b.ts),
    reported: c.reports.length > 0,
  };
}

function report(g: Game, p: Player, payload: Record<string, any>) {
  const c = requireCorpse(g, p, payload);
  const text = cleanText(payload, 'text', DEATH.reportTextMax);
  let accuse: Who | null = null;
  if (payload.accuse !== undefined && payload.accuse !== null) {
    const id = reqStr(payload, 'accuse', 40);
    const accused = g.players.get(id);
    if (!accused) fail('NOT_FOUND', `no player ${id} to accuse`, undefined, 'accuse takes a player id (player.lookup finds one by name). Describe someone you cannot name in text.');
    accuse = { id: accused!.id, name: accused!.name };
  }
  if (c.reports.some((r) => r.byId === p.id)) fail('BAD_REQUEST', 'you already reported this death', undefined, 'say more in chat or on the forum');

  const first = !c.reports.length;
  g.markCorpse(c);
  g.markPlayer(p);
  const reporter = seenAs(p);
  c.reports.push({ ts: g.now(), byId: p.id, reporter, accuse, text });
  g.emit('death.report', { kind: 'public' }, { corpseId: c.id, victim: c.victim, zone: c.zone, reporter, accuse, text, first }, { zone: c.zone, actor: p });
  let reward = 0;
  if (first) {
    // Before the estate passes: the last member's death takes the stockpile with it.
    const s = c.settlementId ? g.settlements.get(c.settlementId) : undefined;
    if (s) reward = Math.min(s.charter.reportReward, s.stockpile.silver ?? 0);
    if (s && reward > 0) {
      g.markSettlement(s);
      const paid: ItemStack[] = removeItems(s.stockpile, [{ item: 'silver', qty: reward }]);
      addItems(p.inventory, paid);
      audit(g, s, p, 'reward', paid);
    } else g.skipEventId();
    if (!c.settledAt) settleEstate(g, c);
  }
  g.setLastAction(p, 'report', `reported ${c.victim.name}'s death${accuse ? `, accusing ${accuse.name}` : ''}${reward ? ` (${describe([{ item: 'silver', qty: reward }])} reward)` : ''}`);
  return { corpseId: c.id, first, reward };
}

function deathList(g: Game, payload: Record<string, any>) {
  const limit = optInt(payload, 'limit', 1, 200, SETTLEMENT.logPage);
  const deaths: DeathNoticeView[] = [...g.corpses.values()]
    .filter((c) => c.reports.length)
    .sort((a, b) => b.reports[0].ts - a.reports[0].ts || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((c) => ({ corpseId: c.id, victim: { ...c.victim }, zone: c.zone, reports: c.reports.map(({ byId, ...r }, i) => ({ ...r, first: i === 0 })) }));
  return { deaths };
}

// ---------- wills ----------

function heirView(g: Game, p: Player): HeirView | null {
  if (!p.will) return null;
  const { kind, id } = p.will;
  return { kind, id, name: (kind === 'player' ? g.players : g.settlements).get(id)?.name ?? 'unknown' };
}

/** One event id whatever it says, with the notices as copies. An heir who is dropped is not told. */
function willSet(g: Game, p: Player, payload: Record<string, any>) {
  requireFace(p, g.now(), 'making a will');
  requirePlace(g, p, 'bank', 'making a will');
  let will: Player['will'];
  if (payload.heir !== null) {
    if (payload.heir === undefined) fail('BAD_REQUEST', 'heir must be a player id, a settlement id, or null to clear the will');
    const id = reqStr(payload, 'heir', 40);
    if (id === p.id) fail('BAD_REQUEST', 'you cannot be your own heir');
    if (g.players.has(id)) will = { kind: 'player', id };
    else if (g.settlements.has(id)) will = { kind: 'settlement', id };
    else fail('NOT_FOUND', `no player or settlement ${id}`, undefined, 'player.lookup finds player ids, settlement.list shows settlement ids');
  }
  g.markPlayer(p);
  if (will) p.will = will; else delete p.will;
  const heir = heirView(g, p);
  const ev = g.emit('will', { kind: 'operator' }, { playerId: p.id, name: p.name, heir }, { zone: p.zone, actor: p });
  if (heir) {
    const told = heir.kind === 'player' ? [heir.id] : Object.keys(g.settlements.get(heir.id)!.members).filter((id) => id !== p.id);
    for (const id of told) {
      g.emitCopy(ev, 'will.named', id, { from: { id: p.id, name: p.name }, as: heir.kind, note: 'This will names you. When that death is made known the bank and stashes pass to the heir.' });
    }
  }
  g.setLastAction(p, 'will', heir ? `named ${heir.name} heir` : 'cleared the will');
  return { heir };
}

function willView(g: Game, p: Player) {
  const heirOf = [...g.players.values()]
    .filter((o) => o.id !== p.id && o.will && !o.dead?.settled && (o.will.id === p.id || o.will.id === p.settlementId))
    .map((o) => ({ id: o.id, name: o.name, as: o.will!.kind }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { heir: heirView(g, p), heirOf };
}

// ---------- bounties ----------

const bountyView = (b: Bounty): BountyView => ({ id: b.id, target: { ...b.target }, amount: b.amount, poster: { ...b.poster }, postedAt: b.postedAt });

function bountyPost(g: Game, p: Player, payload: Record<string, any>) {
  requirePlace(g, p, 'bank', 'posting a bounty');
  const targetId = reqStr(payload, 'targetId', 40);
  const amount = reqInt(payload, 'amount', 1, 1_000_000);
  if (targetId === p.id) fail('BAD_REQUEST', 'you cannot put a bounty on yourself');
  const target = g.players.get(targetId);
  if (!target) fail('NOT_FOUND', `no player ${targetId}`, undefined, 'player.lookup finds a player id by name');
  // Only once the death is known: until then this must go through as for the living.
  if (target!.dead?.settled) fail('TARGET_DEAD', `${target!.name} is known to be dead`);
  if ([...g.bounties.values()].filter((b) => b.posterId === p.id).length >= DEATH.maxBounties) {
    fail('BAD_REQUEST', `you already have ${DEATH.maxBounties} open bounties`, undefined, 'each stands until its target dies');
  }
  if (!available(p.inventory, 'silver') || p.inventory.silver < amount) {
    fail('NOT_ENOUGH_ITEMS', `you carry ${p.inventory.silver ?? 0} silver, not ${amount}`, undefined, 'withdraw silver from the bank first');
  }
  g.markPlayer(p);
  removeItems(p.inventory, [{ item: 'silver', qty: amount }]);
  const b: Bounty = { id: newId('bounty'), target: { id: target!.id, name: target!.name }, amount, posterId: p.id, poster: seenAs(p), postedAt: g.now() };
  g.bounties.set(b.id, b);
  g.markBounty(b);
  g.emit('bounty', { kind: 'operator' }, { bountyId: b.id, target: b.target, amount, playerId: p.id, name: p.name }, { zone: p.zone, actor: p });
  g.setLastAction(p, 'bounty', `put ${amount} silver on ${target!.name}`);
  return { bounty: bountyView(b), inventory: toStacks(p.inventory) };
}

function bountyList(g: Game) {
  return { bounties: [...g.bounties.values()].sort((a, b) => a.postedAt - b.postedAt || (a.id < b.id ? -1 : 1)).map(bountyView) };
}

// ---------- hood ----------

function wearHood(g: Game, p: Player) {
  requireReady(g, p);
  if (!available(p.inventory, HOOD.item)) {
    fail('NOT_ENOUGH_ITEMS', `you carry no ${HOOD.item}`, undefined, `craft one (recipe "${HOOD.item}", tanning at a workbench) or buy one from a tanner`);
  }
  g.markPlayer(p);
  removeItems(p.inventory, [{ item: HOOD.item, qty: 1 }]);
  const now = g.now();
  const leftMs = g.ms(HOOD.ms);
  p.hood = { as: p.hood?.as ?? newId('hood'), until: now + leftMs };
  const busyMs = g.ms(TIMING.hoodMs);
  p.busyUntil = now + busyMs;
  g.emit('hood', { kind: 'operator' }, { playerId: p.id, name: p.name, as: p.hood.as, leftMs }, { zone: p.zone, actor: p });
  g.setLastAction(p, 'hood', 'pulled up a hood');
  return { as: p.hood.as, leftMs, busyMs };
}

const ro = (run: CommandDef['run']): CommandDef => ({ mutates: false, run });
const rw = (run: CommandDef['run']): CommandDef => ({ mutates: true, run });

export const deathCommands: Record<string, CommandDef> = {
  revive: rw(revive),
  'corpse.examine': ro(examine),
  'death.report': rw(report),
  'death.list': ro((g, _p, payload) => deathList(g, payload)),
  'will.set': rw(willSet),
  'will.view': ro((g, p) => willView(g, p)),
  'bounty.post': rw(bountyPost),
  'bounty.list': ro((g) => bountyList(g)),
  'hood.wear': rw((g, p) => wearHood(g, p)),
};
