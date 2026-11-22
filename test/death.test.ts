// Stage 5: downed, permanent death, estates, reports, bounties and the hood.
//
// Secrecy is tested with twins, as in theft.test.ts: copies of one saved world that differ in one secret (dead or hit,
// who killed, who is under the hood, who saw it, what the will says). Whoever is not entitled to that secret must get
// the same bytes in both, event ids included, from every command and from the event stream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BUILDINGS, CATALOG, DEATH, DEATH_SILVER_LOSS, HOOD, SETTLEMENT, TIMING, ZONES, type BuildingId, type ZoneId,
} from '../src/shared/catalog.ts';
import { MAP_RULES, dist, regionAt, walkable, type Pos } from '../src/shared/map.ts';
import type { GameEvent } from '../src/shared/protocol.ts';
import { Game, type GameOptions } from '../src/server/game.ts';
import { CRIME_ODDS } from '../src/server/odds.ts';
import { operatorState } from '../src/server/operator.ts';
import { damagePlayer, killPlayer } from '../src/server/world.ts';
import type { Corpse, Player, Settlement } from '../src/server/types.ts';
import { world } from './helpers.ts';

const FIGURE = 'hood_aaaaaaaaaaaa', OTHER_FIGURE = 'hood_bbbbbbbbbbbb';
const FOREVER = 10 ** 9;
/** When an unreported death is certainly known. */
const KNOWN = DEATH.knownAfterMs + 2 * DEATH.timeWindowMs;
const SILVER = (qty: number) => [{ item: 'silver', qty }];

function withOdds<T>(odds: Partial<typeof CRIME_ODDS>, fn: () => T): T {
  const real = { ...CRIME_ODDS };
  Object.assign(CRIME_ODDS, { witness: 0, watchtower: 0, traces: 0, tracesLocked: 0 }, odds);
  try { return fn(); } finally { Object.assign(CRIME_ODDS, real); }
}

// ---------- a game on a fake clock ----------

function fake(o: Partial<GameOptions> = {}, start = 1_000_000, session = 'c') {
  let now = start;
  let seq = 0;
  const g = new Game({ dbPath: ':memory:', now: () => now, seed: 4, mapSeed: 7, log: (line) => assert.fail(line), ...o });
  const heard = new Map<string, GameEvent[]>();
  const operator: any[] = [];
  g.subscribe({ kind: 'operator', send: (e) => operator.push(structuredClone(e)) });
  const listen = (...ids: string[]) => {
    for (const id of ids) {
      if (!heard.has(id)) g.subscribe({ kind: 'player', playerId: id, send: (e) => heard.get(id)?.push(structuredClone(e)) });
      heard.set(id, []);
    }
  };
  /** As they are, busy or not. 30 ms apart: under the rate limit, and a whole probe ends before a death is known. */
  const raw = (id: string, type: string, payload: object = {}) => {
    now += 30;
    return g.execute(id, { commandId: `${session}${++seq}`, type, payload }) as any;
  };
  const run = (id: string, type: string, payload: object = {}) => {
    g.players.get(id)!.busyUntil = 0;
    return raw(id, type, payload);
  };
  const ok = (id: string, type: string, payload: object = {}) => {
    const r = run(id, type, payload);
    assert.ok(r.ok, `${type}: ${r.error?.code} ${r.error?.message}`);
    return r.result;
  };
  const no = (id: string, type: string, payload: object = {}) => {
    const r = run(id, type, payload);
    assert.ok(!r.ok, `${type} should fail`);
    return r.error;
  };
  const p = (id: string): Player => g.players.get(id)!;
  const put = (id: string, pos: Pos) => Object.assign(p(id), { pos: { x: pos.x, y: pos.y }, zone: regionAt(g.map, pos), travel: null });
  const save = () => g.mutate(() => {
    for (const x of g.players.values()) g.markPlayer(x);
    for (const x of g.settlements.values()) g.markSettlement(x);
  });
  const pass = (ms: number) => { now += ms; g.tick(); };
  return { g, raw, run, ok, no, p, put, save, listen, heard, operator, now: () => now, pass };
}
type Fake = ReturnType<typeof fake>;

const NAMES = {
  vic: 'Victor', kim: 'Kimball', kay: 'Kaylee', lead: 'Lenora', mate: 'Mirela', late: 'Ingmar', wit: 'Wanda',
  heir: 'Hadrian', heir2: 'Hilde', poster: 'Petros', stranger: 'Sigrid', neighbour: 'Nils',
};
type Cast = Record<keyof typeof NAMES, string>;

/**
 * One murder waiting to happen, and everybody who might learn what they shouldn't.
 *   Victor            member, in Lenora's party, rich, with a will to Hadrian and a bounty from Petros, at the scene
 *   Kimball, Kaylee   members, stewards, in the same party, at the scene: whichever of them does it
 *   Lenora            leads both, in town
 *   Mirela            member, in town
 *   Ingmar, Wanda     an outsider who comes by afterwards, and one who can be put at the scene
 *   Hadrian, Hilde    the heir, and who else could have been
 *   Petros, Sigrid    the bounty's poster, and nobody at all
 *   Nils              leads another settlement, in the Ridge
 * All but the first three are out of sight of the scene and out of its region.
 */
function cast(f: Fake) {
  const { g } = f;
  const who = Object.fromEntries(Object.entries(NAMES).map(([key, name]) => [key, g.register(name).playerId])) as Cast;
  const town = g.map.anchors.town;
  const plot = g.map.plots.find((pl) => pl.region === 'hollow')!;
  const otherPlot = g.map.plots.filter((pl) => pl.region === 'ridge').sort((a, b) => b.y - a.y)[0];
  const found = (id: string, at: typeof plot, name: string): string => {
    f.put(id, at);
    for (const c of SETTLEMENT.foundCost) f.p(id).inventory[c.item] = (f.p(id).inventory[c.item] ?? 0) + c.qty;
    return f.ok(id, 'settlement.found', { name, plotId: at.id }).settlement.id;
  };
  const sid = found(who.lead, plot, 'Quiet Hold');
  const otherSid = found(who.neighbour, otherPlot, 'Next Door');
  for (const id of [who.vic, who.kim, who.kay, who.mate]) {
    f.ok(who.lead, 'settlement.invite', { playerId: id });
    f.ok(id, 'settlement.join', { settlementId: sid });
  }
  for (const id of [who.kim, who.kay]) f.ok(who.lead, 'settlement.setRole', { playerId: id, role: 'steward' });
  for (const id of [who.vic, who.kim, who.kay]) f.ok(id, 'party.accept', { partyId: f.ok(who.lead, 'party.invite', { playerId: id }).party.id });

  const open: Pos[] = [];
  for (let y = 0; y < g.map.height; y++) {
    for (let x = 0; x < g.map.width; x++) if (walkable(g.map, x, y) && regionAt(g.map, { x, y }) === 'hollow') open.push({ x, y });
  }
  const clear = (q: Pos) => Math.min(dist(q, town), dist(q, otherPlot));
  const roomy = open.filter((q) => clear(q) > MAP_RULES.viewRadius + 2 && dist(q, plot) > MAP_RULES.range.plot + 1);
  const farFrom = (q: Pos) => open.reduce((a, b) => (dist(q, b) > dist(q, a) ? b : a));
  const scene = roomy.reduce((a, b) => (dist(b, farFrom(b)) > dist(a, farFrom(a)) ? b : a));
  const far = farFrom(scene);
  assert.ok(dist(scene, far) > MAP_RULES.viewRadius + 2, 'the map has room to not see a murder');

  for (const id of Object.values(who)) f.put(id, town);
  for (const id of [who.vic, who.kim, who.kay]) f.put(id, scene);
  f.put(who.neighbour, otherPlot);

  const s = (): Settlement => g.settlements.get(sid)!;
  const raise = (...list: BuildingId[]) => { for (const id of list) s().buildings.push({ id, builtAt: f.now(), paidUntil: f.now() + FOREVER }); };
  raise('workshop', 'forge_hall', 'huts', 'watchtower', 'storehouse', 'palisade');
  s().nextIncomeAt = f.now() + FOREVER;
  s().stockpile = { silver: 500, stone: 900, pine_plank: 300 };
  s().charter.reportReward = 40;
  s().stashes = { [who.vic]: { iron_bar: 17 }, [who.mate]: { leather: 5 } };
  Object.assign(f.p(who.vic).inventory, { silver: 40, copper_ore: 6 });
  f.p(who.vic).bank = { silver: 777, leather: 9 };
  f.p(who.vic).will = { kind: 'player', id: who.heir };
  for (const id of [who.kim, who.kay]) {
    f.p(id).equipment = { weapon: 'copper_sword' };
    Object.assign(f.p(id).inventory, { silver: 300, stone: 60, pine_plank: 80, leather_jerkin: 1 });
  }
  for (const id of [who.poster, who.heir, who.lead, who.stranger]) f.p(id).inventory.silver = 500;
  f.put(who.poster, g.map.places.find((x) => x.id === 'bank')!);
  f.ok(who.poster, 'bounty.post', { targetId: who.vic, amount: 120 });
  f.put(who.poster, town);
  f.save();
  return { ...who, town, plot, otherPlot, scene, far, sid, otherSid, s, raise };
}
type Village = ReturnType<typeof cast>;

/** A test in one world. */
function scenario(fn: (f: Fake, v: Village) => void) {
  return () => {
    const f = fake();
    try { withOdds({}, () => fn(f, cast(f))); } finally { f.g.close(); }
  };
}

const down = (f: Fake, v: Village, victim = v.vic, by = v.kim) => {
  f.p(victim).hp = 1;
  f.p(victim).lastCombatAt = f.now() + 1000; // no regeneration first
  const r = f.ok(by, 'attack', { targetId: f.p(victim).hood?.as ?? victim });
  assert.equal(r.downed, true);
  return r;
};
const finish = (f: Fake, v: Village, victim = v.vic, by = v.kim) => f.ok(by, 'attack', { targetId: f.p(victim).hood?.as ?? victim });
/** A murder, by default Kimball's of Victor. */
function murder(f: Fake, v: Village, victim = v.vic, by = v.kim): Corpse {
  down(f, v, victim, by);
  assert.equal(finish(f, v, victim, by).killed, true);
  return f.g.corpses.get(f.p(victim).dead!.corpseId)!;
}
function bleed(f: Fake) { f.pass(TIMING.downedMs + 1); }
const wear = (f: Fake, id: string, as = FIGURE) => { f.p(id).hood = { as, until: f.now() + FOREVER }; };
const bankPos = (f: Fake) => f.g.map.places.find((x) => x.id === 'bank')!;
/** An open tile of the same region between `min` and `max` tiles away. */
function near(f: Fake, at: Pos, min: number, max: number): Pos {
  const region = regionAt(f.g.map, at);
  for (let y = 0; y < f.g.map.height; y++) {
    for (let x = 0; x < f.g.map.width; x++) {
      const d = dist(at, { x, y });
      if (d >= min && d <= max && walkable(f.g.map, x, y) && regionAt(f.g.map, { x, y }) === region) return { x, y };
    }
  }
  return assert.fail('no such tile');
}
const allSilver = (f: Fake) => {
  let n = 0;
  for (const p of f.g.players.values()) n += (p.inventory.silver ?? 0) + (p.bank.silver ?? 0);
  for (const b of f.g.bags.values()) n += b.items.silver ?? 0;
  for (const b of f.g.bounties.values()) if (!b.paidTo) n += b.amount;
  for (const s of f.g.settlements.values()) {
    n += s.stockpile.silver ?? 0;
    for (const stash of Object.values(s.stashes)) n += stash.silver ?? 0;
  }
  for (const t of f.g.trades.values()) if (t.status === 'agreed') for (const sub of Object.values(t.subs)) n += sub.items.silver ?? 0;
  return n;
};
const ledger = (f: Fake, kind: string) => f.g.store.get<{ qty: number }>('SELECT qty FROM economy_ledger WHERE kind = ?', kind)?.qty ?? 0;

// ---------- rules ----------

test('catalog and docs: the tunables are served, the item and building exist, and nothing gives away odds', () => {
  assert.equal(CATALOG.death, DEATH);
  assert.equal(CATALOG.hood, HOOD);
  assert.ok(CATALOG.timing.downedMs > CATALOG.timing.reviveMs && CATALOG.timing.reviveMs > 0);
  assert.ok(DEATH.reviveHpPct > 0 && DEATH.reviveHpPct < 100);
  assert.ok(CATALOG.recipes[DEATH.bandage] && CATALOG.recipes[HOOD.item]);
  assert.ok(CATALOG.starterKit.some((i) => i.item === DEATH.bandage && i.qty === 1));
  assert.equal(CATALOG.shop[DEATH.bandage], undefined, 'a trade good');
  assert.equal(CATALOG.shop[HOOD.item], undefined);
  assert.ok(BUILDINGS.infirmary.cost.some((i) => i.item === 'wyrm_scale'));
  assert.doesNotMatch(JSON.stringify(CATALOG), /"witness"|tracesLocked|"blow"|paidTo/);
  for (const z of Object.values(ZONES)) assert.doesNotMatch(z.description, /keeps your gear|respawn/i, z.id);

  const docs = readFileSync(new URL('../docs/SDK.md', import.meta.url), 'utf8');
  const a = docs.indexOf('\n## Downed, death and the murder mystery');
  assert.ok(a > 0, 'the section is there');
  const section = docs.slice(a, docs.indexOf('\n## ', a + 4));
  for (const word of ['revive', 'examineCorpse', 'reportDeath', 'setWill', 'postBounty', 'wearHood', 'DOWNED', 'DEAD', 'HOODED']) assert.ok(section.includes(word), word);
});

test('downed: 0 HP, no acting, chat or DM, reading still works, mobs let go, nothing heals', scenario((f, v) => {
  const wolf = [...f.g.mobs.values()].find((m) => m.type === 'wolf' && m.zone === 'hollow')!;
  wolf.aggro = { [v.vic]: 5 };
  wolf.targetId = v.vic;
  f.p(v.vic).travel = null;
  const r = down(f, v);
  assert.deepEqual([r.killed, r.downed, r.targetHp], [false, true, 0]);
  const p = f.p(v.vic);
  assert.equal(p.hp, 0);
  assert.equal(p.zone, 'hollow', 'no respawn');
  assert.equal(wolf.targetId, null);
  assert.deepEqual(wolf.aggro, {});
  assert.equal(f.ok(v.vic, 'observe').self.downed.bandages, 1);

  const writes = Object.keys(f.g.commands).filter((t) => f.g.commands[t].mutates && t !== 'revive' && t !== 'reportFeedback');
  for (const type of writes) {
    const e = f.no(v.vic, type, { text: 'help', to: v.lead, targetId: v.kim });
    assert.equal(e.code, 'DOWNED', type);
    f.pass(5);
  }
  for (const type of ['chat.say', 'dm.send', 'party.say', 'stockpile.pilfer']) assert.ok(writes.includes(type), type);
  assert.match(f.no(v.vic, 'dm.send').hint, /revive/);
  assert.equal(f.no(v.vic, 'revive', { targetId: v.kay }).code, 'DOWNED', 'only themself');
  f.ok(v.vic, 'reportFeedback', { category: 'other', summary: 'I am down' });
  for (const type of ['settlement.view', 'will.view', 'witness.log', 'dm.conversations', 'party.view']) f.ok(v.vic, type);
  f.pass(10_000);
  assert.equal(f.p(v.vic).hp, 0, 'no regeneration');
  assert.ok(!f.p(v.vic).dead);
}));

test('revive: anyone, a 5 second channel, 30% HP, and it costs no bandage', scenario((f, v) => {
  f.put(v.stranger, v.scene);
  down(f, v);
  assert.equal(f.no(v.stranger, 'revive', { targetId: v.kay }).code, 'INVALID_TARGET', 'not downed');
  assert.equal(f.no(v.stranger, 'revive').code, 'INVALID_TARGET', 'nor are they');
  const r = f.ok(v.stranger, 'revive', { targetId: v.vic });
  assert.equal(r.busyMs, TIMING.reviveMs);
  assert.equal(f.raw(v.stranger, 'move', { to: 'wilds' }).error.code, 'BUSY', 'a channel');
  f.pass(TIMING.reviveMs - 100);
  assert.ok(f.p(v.vic).downed, 'not before it ends');
  f.pass(100);
  assert.equal(f.p(v.vic).downed, undefined);
  assert.equal(f.p(v.vic).hp, Math.ceil((f.g.maxHp(f.p(v.vic)) * DEATH.reviveHpPct) / 100));
  assert.equal(f.p(v.vic).inventory[DEATH.bandage], 1, 'theirs is unused');
  assert.equal(f.p(v.vic).inventory.silver, 40, 'and being downed costs nothing');
  f.ok(v.vic, 'chat.say', { text: 'thanks' });
  bleed(f);
  assert.ok(!f.p(v.vic).dead, 'the timer is gone');
}));

test('revive: damage interrupts it, out of range it fails, and finishing the victim ends it', scenario((f, v) => {
  f.put(v.stranger, v.scene);
  down(f, v);
  f.listen(v.stranger);
  f.ok(v.stranger, 'revive', { targetId: v.vic });
  f.pass(1000);
  f.ok(v.kim, 'attack', { targetId: v.stranger });
  assert.equal(f.p(v.stranger).reviving, undefined);
  assert.ok(f.heard.get(v.stranger)!.some((e) => e.type === 'self.damaged' && e.data.reviveInterrupted));
  f.pass(TIMING.reviveMs);
  assert.ok(f.p(v.vic).downed, 'still down');

  f.put(v.wit, near(f, v.scene, 2, 6));
  assert.equal(f.no(v.wit, 'revive', { targetId: v.vic }).code, 'OUT_OF_RANGE');
  f.put(v.wit, v.far);
  assert.equal(f.no(v.wit, 'revive', { targetId: v.vic }).code, 'INVALID_TARGET', 'out of sight in the same region');
  f.put(v.wit, v.town);
  assert.equal(f.no(v.wit, 'revive', { targetId: v.vic }).code, 'INVALID_TARGET', 'from another region: not in sight');

  f.ok(v.stranger, 'revive', { targetId: v.vic });
  assert.equal(finish(f, v).killed, true, 'revive against finish: the blow wins');
  assert.equal(f.p(v.stranger).reviving, undefined);
  f.pass(TIMING.reviveMs);
  assert.ok(f.p(v.vic).dead);
  assert.equal(f.p(v.vic).hp, 0);
  assert.equal(f.no(v.stranger, 'revive', { targetId: v.vic }).code, 'TARGET_DEAD');
}));

test('bandage: one self-revive, by command only, used as it starts', scenario((f, v) => {
  down(f, v);
  f.ok(v.vic, 'revive');
  assert.equal(f.p(v.vic).inventory[DEATH.bandage], undefined, 'used at once');
  f.pass(TIMING.reviveMs);
  assert.equal(f.p(v.vic).downed, undefined);
  down(f, v);
  assert.equal(f.no(v.vic, 'revive').code, 'NOT_ENOUGH_ITEMS', 'once');
  assert.match(f.no(v.vic, 'chat.say', { text: 'x' }).hint, /someone else's revive/);

  // Carrying one saves nobody who doesn't send the command.
  down(f, v, v.kay);
  assert.equal(f.p(v.kay).inventory[DEATH.bandage], 1);
  bleed(f);
  assert.ok(f.p(v.kay).dead);
}));

test('timer: death exactly when it runs out, unless a revive started in time', scenario((f, v) => {
  down(f, v);
  f.pass(f.p(v.vic).downed!.until - f.now() - 1);
  assert.ok(!f.p(v.vic).dead, 'a millisecond left');
  f.pass(1);
  assert.ok(f.p(v.vic).dead, 'bled out');
  assert.equal(f.g.corpses.get(f.p(v.vic).dead!.corpseId)!.bledOut, true);

  down(f, v, v.kay);
  f.pass(f.p(v.kay).downed!.until - f.now() - 1000);
  f.ok(v.kay, 'revive');
  f.pass(2000);
  assert.ok(!f.p(v.kay).dead, 'held off');
  f.pass(TIMING.reviveMs);
  assert.ok(!f.p(v.kay).dead && !f.p(v.kay).downed);
}));

test('infirmary: twice the time, for members near their own working one only', scenario((f, v) => {
  const time = (victim: string, at: Pos) => {
    f.put(victim, at);
    f.put(v.kim, at);
    down(f, v, victim);
    const { forMs } = f.p(victim).downed!;
    delete f.p(victim).downed;
    f.p(victim).hp = 50;
    return forMs;
  };
  const double = TIMING.downedMs * DEATH.infirmaryMult;
  assert.equal(time(v.vic, v.plot), TIMING.downedMs, 'none built');
  v.raise('infirmary');
  assert.equal(time(v.vic, v.plot), double);
  assert.equal(time(v.stranger, v.plot), TIMING.downedMs, 'an outsider');
  assert.equal(time(v.vic, dist(v.scene, v.plot) > DEATH.infirmaryRange ? v.scene : v.far), TIMING.downedMs, 'too far');
  v.s().buildings.at(-1)!.unpaid = true;
  assert.equal(time(v.vic, v.plot), TIMING.downedMs, 'closed');
  assert.equal(SETTLEMENT.levels.at(-1)!.slots, 9, 'a town has room for all nine');
}));

test('finishing: one attack in PvP land; in the wilds nobody can', scenario((f, v) => {
  for (const zone of ['hollow', 'ridge', 'frontier', 'wilds'] as ZoneId[]) {
    const victim = f.g.register(`Victim_${zone}`).playerId;
    const at = f.g.map.anchors[zone];
    f.put(victim, at);
    f.put(v.kim, at);
    f.g.mutate(() => damagePlayer(f.g, f.p(victim), 10_000, { kind: 'mob', id: 'm', name: 'Wolf' }));
    assert.ok(f.p(victim).downed, zone);
    f.p(victim).evadeUntil = f.now() + 5000;
    if (zone === 'wilds') assert.equal(f.no(v.kim, 'attack', { targetId: victim }).code, 'SAFE_ZONE');
    else assert.equal(f.ok(v.kim, 'attack', { targetId: victim }).killed, true, zone);
    f.p(v.kim).combatLockUntil = 0;
  }
  bleed(f);
  assert.ok(f.p(f.g.playerByName('Victim_wilds')!.id).dead, 'the wilds kill for good too');
}));

test('theft: the downed still witness and are watched, the dead neither, and going down shortens no pilfer', scenario((f, v) => {
  for (const id of [v.kim, v.kay, v.vic, v.wit]) f.put(id, v.plot);
  murder(f, v, v.wit);
  f.ok(v.kay, 'stockpile.pilfer');
  const until = f.p(v.kay).busyUntil;
  down(f, v, v.kay);
  assert.equal(f.p(v.kay).busyUntil, until);
  assert.equal(f.raw(v.kay, 'stockpile.pilfer').error.code, 'DOWNED');
  assert.ok(f.raw(v.kay, 'revive').ok, 'busy or not');

  down(f, v);
  f.listen(v.vic);
  withOdds({ witness: 1, watchtower: 1 }, () => f.ok(v.kim, 'stockpile.pilfer'));
  assert.ok(f.heard.get(v.vic)!.some((e) => e.type === 'witness.saw'), 'eyes open');
  const theft = f.operator.filter((e) => e.type === 'theft').at(-1).data;
  assert.ok(!theft.witnesses.some((w: any) => w.id === v.wit), 'the dead see nothing');
  assert.ok(theft.watched.some((w: any) => w.id === v.vic));
  assert.ok(!theft.watched.some((w: any) => w.id === v.wit));
}));

test('death: everything drops, a quarter of the silver burns, the name stays, and only observe works', scenario((f, v) => {
  f.p(v.vic).equipment = { armor: 'leather_jerkin', weapon: 'iron_sword' };
  f.p(v.vic).wear = { iron_sword: 60 };
  const first = f.g.execute(v.vic, { commandId: 'before', type: 'reportFeedback', payload: { category: 'other', summary: 'alive' } }) as any;
  assert.ok(first.ok);
  const burned = ledger(f, 'destroyed.death');
  const c = murder(f, v);
  const p = f.p(v.vic);
  assert.deepEqual([p.inventory, p.equipment, p.hp, p.downed], [{}, {}, 0, undefined]);
  assert.deepEqual([p.dead!.zone, p.zone], ['hollow', 'hollow']);
  assert.equal(p.stats.deaths, 1);
  const lost = Math.floor(40 * DEATH_SILVER_LOSS);
  assert.equal(ledger(f, 'destroyed.death') - burned, lost);
  const bag = f.g.bags.get(c.bagId!)!;
  assert.equal(bag.items.silver, 40 - lost);
  assert.deepEqual([bag.items.copper_ore, bag.items.iron_sword, bag.items.leather_jerkin, bag.items[DEATH.bandage]], [6, 1, 1, 1]);

  for (const type of Object.keys(f.g.commands).filter((t) => t !== 'observe')) {
    const e = f.no(v.vic, type, { text: 'boo', to: v.lead });
    assert.equal(e.code, 'DEAD', type);
    assert.match(e.hint, /register a new character/i);
    f.pass(5);
  }
  const seen = f.ok(v.vic, 'observe');
  assert.equal(seen.self.dead.corpseId, c.id);
  assert.equal((f.g.execute(v.vic, { commandId: 'before', type: 'reportFeedback', payload: { category: 'other', summary: 'alive' } }) as any).replayed, true, 'a retry still replays');
  assert.throws(() => f.g.register('victor'), /taken/, 'the name stays reserved');
  f.g.register('Victor-2');
  f.pass(60_000);
  assert.equal(f.p(v.vic).hp, 0);
  assert.ok(f.p(v.vic).dead);
}));

test('estate: nothing moves before the death is known, then the will decides', scenario((f, v) => {
  f.put(v.mate, v.plot);
  const s = v.s();
  s.work[v.vic] = { gathered: {}, given: { stone: [{ qty: 50, readyAt: 1 }] }, carry: {} };
  f.g.settlements.get(v.otherSid)!.stashes = { [v.vic]: { silver: 11 } };
  f.g.settlements.get(v.otherSid)!.invites = { [v.vic]: f.now() + FOREVER };
  const c = murder(f, v);
  assert.ok(c.dueAt >= c.at + DEATH.knownAfterMs, 'never early');
  assert.ok(c.dueAt <= c.at + DEATH.knownAfterMs + DEATH.timeWindowMs);
  f.pass(c.dueAt - f.now() - 1);
  assert.ok(v.s().members[v.vic]);
  assert.equal(f.p(v.vic).partyId, f.p(v.lead).partyId);
  assert.deepEqual(f.p(v.vic).bank, { silver: 777, leather: 9 });
  assert.equal(f.p(v.heir).bank.silver, undefined);
  assert.ok(v.s().work[v.vic], 'what they gave still counts');

  f.listen(v.mate, v.heir, v.lead, v.stranger);
  f.pass(1);
  assert.equal(v.s().members[v.vic], undefined);
  assert.equal(v.s().work[v.vic], undefined, 'and now it stops');
  assert.equal(v.s().barred[v.vic], undefined);
  assert.equal(f.g.settlements.get(v.otherSid)!.invites[v.vic], undefined);
  assert.deepEqual([f.p(v.vic).settlementId, f.p(v.vic).partyId], [undefined, undefined]);
  assert.deepEqual(f.p(v.heir).bank, { silver: 788, leather: 9, iron_bar: 17 }, 'bank and every stash');
  assert.equal(v.s().stashes[v.vic], undefined);
  assert.equal(f.g.settlements.get(v.otherSid)!.stashes[v.vic], undefined);
  assert.deepEqual(f.p(v.vic).bank, {});
  assert.ok(f.heard.get(v.mate)!.some((e) => e.type === 'settlement.left' && e.data.reason === 'death'));
  assert.ok(f.heard.get(v.lead)!.some((e) => e.type === 'party.left' && e.data.died));
  assert.ok(f.heard.get(v.heir)!.some((e) => e.type === 'will.inherited'));
  assert.deepEqual(f.heard.get(v.stranger), [], 'and nothing is public');
  assert.deepEqual(f.ok(v.stranger, 'death.list').deaths, []);
  const before = JSON.stringify(f.p(v.heir).bank);
  f.pass(KNOWN);
  assert.equal(JSON.stringify(f.p(v.heir).bank), before, 'once');
}));

test('estate: a settlement heir, no will, a dead heir, and nobody', () => {
  const inherit = (setup: (f: Fake, v: Village) => void, check: (f: Fake, v: Village) => void) => {
    const f = fake();
    try {
      const v = cast(f);
      setup(f, v);
      murder(f, v);
      f.pass(KNOWN);
      check(f, v);
    } finally { f.g.close(); }
  };
  inherit((f, v) => { f.p(v.vic).will = { kind: 'settlement', id: v.otherSid }; }, (f, v) => {
    const to = f.g.settlements.get(v.otherSid)!;
    assert.deepEqual([to.stockpile.silver, to.stockpile.iron_bar], [777, 17]);
    assert.equal(v.s().stockpile.leather, undefined, 'not their own');
    const entry = f.ok(v.neighbour, 'stockpile.log').entries.find((e: any) => e.action === 'inherit');
    assert.equal(entry.actorName, NAMES.vic);
  });
  inherit((f, v) => { delete f.p(v.vic).will; }, (f, v) => {
    assert.deepEqual([v.s().stockpile.silver, v.s().stockpile.iron_bar, v.s().stockpile.leather], [500 + 777, 17, 9]);
    assert.equal(ledger(f, 'destroyed.estate'), 0);
  });
  inherit((f, v) => {
    f.put(v.heir, v.scene);
    murder(f, v, v.heir);
  }, (f, v) => {
    assert.equal(v.s().stockpile.iron_bar, 17, 'the heir is dead: the settlement');
    assert.deepEqual(f.p(v.heir).bank, {});
  });
  inherit((f, v) => { f.p(v.vic).will = { kind: 'settlement', id: 'stl_gone' }; }, (_f, v) => {
    assert.equal(v.s().stockpile.iron_bar, 17, 'the named settlement is gone: their own');
  });
  inherit((f, v) => {
    delete f.p(v.vic).will;
    f.ok(v.vic, 'settlement.leave');
  }, (f, v) => {
    assert.equal(ledger(f, 'destroyed.estate'), 777, 'nobody: destroyed, and counted');
    assert.equal(v.s().stockpile.iron_bar, undefined, 'a stash left behind is not the old settlement\'s');
    assert.equal(v.s().stashes[v.vic], undefined);
    assert.deepEqual(f.p(v.vic).bank, {});
    assert.equal((operatorState(f.g, 0).economy.destroyed as any).estate, 777);
  });
  inherit((f, v) => {
    delete f.p(v.vic).will;
    f.ok(v.lead, 'settlement.expel', { playerId: v.mate });
  }, (f, v) => {
    assert.equal(v.s().stockpile.iron_bar, 17);
    assert.deepEqual(f.g.settlements.get(v.sid)!.stashes[v.mate], { leather: 5 }, 'nobody else\'s stash moves');
  });
});

test('estate: the last member\'s bank and stash spill with the settlement, and a dead leader is succeeded', scenario((f, v) => {
  f.put(v.neighbour, v.scene);
  f.p(v.neighbour).bank = { silver: 900, iron_bar: 4 };
  const other = f.g.settlements.get(v.otherSid)!;
  other.stashes = { [v.neighbour]: { leather: 3 } };
  other.stockpile = { stone: 8 };
  murder(f, v, v.neighbour);
  f.put(v.lead, v.scene);
  murder(f, v, v.lead);
  f.pass(KNOWN);
  assert.equal(f.g.settlements.get(v.otherSid), undefined);
  const spill = [...f.g.bags.values()].find((b) => b.ownerId === v.otherSid)!;
  assert.deepEqual([spill.items.silver, spill.items.iron_bar, spill.items.leather, spill.items.stone], [900, 4, 3, 8]);
  assert.deepEqual([spill.x, spill.y, spill.eligible], [v.otherPlot.x, v.otherPlot.y, undefined], 'public, at the plot');
  const leaders = Object.entries(v.s().members).filter(([, m]) => m.role === 'leader').map(([id]) => id);
  assert.equal(leaders.length, 1);
  assert.notEqual(leaders[0], v.lead);
}));

test('estate: open trades end, escrow comes home, and no silver appears or vanishes uncounted', scenario((f, v) => {
  f.put(v.vic, v.town);
  f.put(v.kim, v.town);
  const t = f.ok(v.vic, 'trade.propose', { to: v.stranger, give: SILVER(30), receive: SILVER(5), lockTimeoutMs: 600_000 }).trade.id;
  f.ok(v.stranger, 'trade.accept', { tradeId: t });
  f.ok(v.vic, 'trade.submit', { tradeId: t, items: SILVER(30) });
  f.ok(v.stranger, 'trade.submit', { tradeId: t, items: SILVER(5) });
  f.put(v.vic, v.scene);
  f.put(v.kim, v.scene);
  const before = allSilver(f);
  const c = murder(f, v);
  f.put(v.kay, c);
  f.ok(v.kay, 'death.report', { corpseId: c.id, text: 'found like this' });
  assert.equal(f.g.trades.get(t)!.status, 'expired');
  assert.equal(f.p(v.stranger).inventory.silver, 500, 'their side is back');
  assert.equal(f.p(v.heir).bank.silver, 777 + 30, 'the dead\'s goes with the estate');
  assert.equal(allSilver(f), before - ledger(f, 'destroyed.death') - ledger(f, 'destroyed.estate'));
}));

test('reports: public, the first is marked and paid, once each, and it makes the death known', scenario((f, v) => {
  const c = murder(f, v);
  f.put(v.stranger, v.far);
  assert.equal(f.no(v.stranger, 'death.report', { corpseId: c.id, text: 'x' }).code, 'OUT_OF_RANGE');
  assert.equal(f.no(v.kim, 'death.report', { corpseId: c.id, text: 'x', accuse: FIGURE }).code, 'NOT_FOUND');
  f.listen(v.mate, v.poster, v.neighbour);
  // The murderer, pointing at someone else.
  const r = f.ok(v.kim, 'death.report', { corpseId: c.id, text: 'It was Kaylee.', accuse: v.kay });
  assert.deepEqual(r, { corpseId: c.id, first: true, reward: 40 });
  assert.equal(v.s().stockpile.silver, 460);
  assert.equal(f.p(v.kim).inventory.silver, 340);
  assert.equal(v.s().members[v.vic], undefined, 'known at once');
  assert.equal(f.p(v.heir).bank.silver, 777);
  for (const id of [v.mate, v.poster, v.neighbour]) {
    const e = f.heard.get(id)!.find((x) => x.type === 'death.report')!;
    assert.deepEqual([e.data.first, e.data.accuse.id, e.data.victim.id], [true, v.kay, v.vic], 'everyone hears');
  }
  assert.equal(f.no(v.kim, 'death.report', { corpseId: c.id, text: 'again' }).code, 'BAD_REQUEST');
  f.put(v.stranger, c);
  assert.deepEqual(f.ok(v.stranger, 'death.report', { corpseId: c.id, text: 'Kimball had a sword.' }), { corpseId: c.id, first: false, reward: 0 });
  assert.equal(v.s().stockpile.silver, 460, 'once');
  const [d] = f.ok(v.neighbour, 'death.list').deaths;
  assert.deepEqual(d.reports.map((x: any) => [x.reporter.id, x.first]), [[v.kim, true], [v.stranger, false]]);
  assert.ok(!('byId' in d.reports[0]) && !('id' in d.reports[0]));

  f.pass(DEATH.corpseMs);
  assert.equal(f.no(v.kay, 'corpse.examine', { corpseId: c.id }).code, 'NOT_FOUND', 'corpses go');
  assert.equal(f.ok(v.kay, 'death.list').deaths.length, 1, 'reports stay');
}));

test('reports: the reward is set by the leader, capped by the silver there, and still paid after the timer', scenario((f, v) => {
  assert.equal(f.no(v.kim, 'settlement.setCharter', { reportReward: 5 }).code, 'FORBIDDEN');
  f.put(v.lead, v.town);
  assert.equal(f.no(v.lead, 'settlement.setCharter', { reportReward: SETTLEMENT.maxReportReward + 1 }).code, 'BAD_REQUEST');
  assert.equal(f.ok(v.lead, 'settlement.setCharter', { reportReward: 700 }).settlement.charter.reportReward, 700);
  const c = murder(f, v);
  f.pass(KNOWN);
  f.put(v.wit, c);
  assert.deepEqual(f.ok(v.wit, 'death.report', { corpseId: c.id, text: 'found' }), { corpseId: c.id, first: true, reward: 500 });
  assert.equal(v.s().stockpile.silver, undefined);
  assert.equal(f.ok(v.mate, 'stockpile.log').entries.find((e: any) => e.action === 'reward').actorId, v.wit);
  assert.equal(SETTLEMENT.defaultCharter.reportReward, 0);
}));

test('corpse: cause, weapon base, rough time and watchtower movements, never the killer', scenario((f, v) => {
  const { g } = f;
  g.uniques.set('iron_sword#0badc0de', { id: 'iron_sword#0badc0de', base: 'iron_sword', ilvl: 20, rarity: 'normal', affixes: [], mods: 0, corrupted: false, craftedBy: 'Kaylee', craftedAt: 1 });
  f.p(v.kim).equipment.weapon = 'iron_sword#0badc0de'; // borrowed
  const row = (ts: number, id: string, move: string) => g.store.run('INSERT INTO watch_log(settlement_id, ts, player_id, name, move) VALUES(?, ?, ?, ?, ?)', v.sid, ts, id, f.p(id).name, move);
  row(f.now() - 60_000, v.kay, 'arrive');
  row(f.now() - 50_000, v.mate, 'at_pilfer');
  row(f.now() - 10 * 60_000 - DEATH.timeWindowMs, v.stranger, 'arrive');
  f.pass(1234);
  const c = murder(f, v);
  f.put(v.wit, c);
  const x = f.ok(v.wit, 'corpse.examine', { corpseId: c.id });
  assert.deepEqual(x.cause, { by: 'player', wound: 'cut', weapon: 'iron_sword' }, 'the base, which can be borrowed');
  assert.equal(x.diedAbout.to - x.diedAbout.from, DEATH.timeWindowMs);
  assert.equal(x.diedAbout.from % DEATH.timeWindowMs, 0);
  assert.ok(x.diedAbout.from <= c.at && c.at < x.diedAbout.to);
  assert.deepEqual(x.watchtower.map((e: any) => [e.playerId, e.move]), [[v.kay, 'arrive']], 'movements around then, no at_pilfer');
  for (const e of x.watchtower) assert.equal(e.id, undefined, 'no log numbers');
  const text = JSON.stringify(x);
  for (const secret of [v.kim, NAMES.kim, '0badc0de', String(c.at)]) assert.ok(!text.includes(secret), secret);
  const bag = f.ok(v.wit, 'observe').zone.lootBags.find((b: any) => b.id === c.bagId);
  assert.equal((f.now() + bag.expiresInMs) % DEATH.timeWindowMs, TIMING.lootBagTtlMs % DEATH.timeWindowMs, 'the bag doesn\'t tell the time');
  assert.equal(c.dueAt % DEATH.timeWindowMs, DEATH.knownAfterMs % DEATH.timeWindowMs, 'nor does becoming known');
  assert.equal(f.no(v.stranger, 'corpse.examine', { corpseId: c.id }).code, 'OUT_OF_RANGE');

  f.put(v.kay, v.scene);
  f.g.mutate(() => killPlayer(f.g, f.p(v.kay), { kind: 'mob', id: [...g.mobs.values()].find((m) => m.type === 'wolf')!.id, name: 'Wolf' }));
  assert.deepEqual(f.ok(v.wit, 'corpse.examine', { corpseId: f.p(v.kay).dead!.corpseId }).cause, { by: 'mob', mob: 'wolf' });
}));

test('wills: at the bank, told privately, and only the heir can read it', scenario((f, v) => {
  f.put(v.vic, v.town);
  f.put(v.vic, bankPos(f));
  f.listen(v.heir, v.heir2, v.lead, v.mate, v.stranger, v.neighbour);
  assert.deepEqual(f.ok(v.vic, 'will.set', { heir: v.heir2 }).heir, { kind: 'player', id: v.heir2, name: NAMES.heir2 });
  assert.deepEqual(f.heard.get(v.heir2)!.map((e) => e.type), ['will.named']);
  for (const id of [v.heir, v.lead, v.mate, v.stranger]) assert.deepEqual(f.heard.get(id), [], 'private');
  assert.deepEqual(f.ok(v.heir2, 'will.view').heirOf, [{ id: v.vic, name: NAMES.vic, as: 'player' }]);
  assert.deepEqual(f.ok(v.heir, 'will.view').heirOf, [], 'no longer');
  assert.deepEqual(f.ok(v.stranger, 'will.view'), { heir: null, heirOf: [] });

  f.ok(v.vic, 'will.set', { heir: v.otherSid });
  assert.deepEqual(f.heard.get(v.neighbour)!.map((e) => e.type), ['will.named'], 'its members');
  assert.equal(f.ok(v.neighbour, 'will.view').heirOf[0].as, 'settlement');
  assert.equal(f.ok(v.vic, 'will.set', { heir: null }).heir, null);
  assert.equal(f.no(v.vic, 'will.set', { heir: v.vic }).code, 'BAD_REQUEST');
  assert.equal(f.no(v.vic, 'will.set', {}).code, 'BAD_REQUEST');
  assert.equal(f.no(v.vic, 'will.set', { heir: 'p_nobody' }).code, 'NOT_FOUND');
  f.put(v.vic, v.scene);
  assert.notEqual(f.run(v.vic, 'will.set', { heir: v.heir }).ok, true, 'only at the bank');
}));

test('bounties: escrow, then the finisher, or the downer of who bled out, and the list waits', scenario((f, v) => {
  const before = allSilver(f);
  f.put(v.stranger, bankPos(f));
  f.ok(v.stranger, 'bounty.post', { targetId: v.vic, amount: 60 });
  assert.equal(f.p(v.stranger).inventory.silver, 440, 'escrowed');
  assert.equal(allSilver(f), before);
  assert.equal(f.no(v.stranger, 'bounty.post', { targetId: v.stranger, amount: 5 }).code, 'BAD_REQUEST');
  assert.equal(f.no(v.stranger, 'bounty.post', { targetId: v.kay, amount: 5000 }).code, 'NOT_ENOUGH_ITEMS');

  f.listen(v.kim, v.kay, v.poster);
  down(f, v, v.vic, v.kay);
  finish(f, v, v.vic, v.kim);
  assert.equal(f.p(v.kim).bank.silver, 180, 'the finisher, every bounty');
  assert.equal(f.p(v.kay).bank.silver, undefined, 'not who downed them');
  assert.ok(f.heard.get(v.kim)!.some((e) => e.type === 'bounty.paid' && e.data.amount === 180));
  const killerIds = f.heard.get(v.kim)!.map((e) => e.id);
  assert.equal(new Set(killerIds).size, killerIds.length, 'the payment has an id the killer hears only once');
  assert.ok(!f.heard.get(v.kay)!.some((e) => e.type === 'bounty.paid'));
  assert.deepEqual(f.heard.get(v.poster), [], 'the poster waits');
  assert.equal(f.ok(v.lead, 'bounty.list').bounties.length, 2, 'the list waits');
  f.pass(KNOWN);
  assert.deepEqual(f.ok(v.lead, 'bounty.list').bounties, []);
  assert.deepEqual(f.heard.get(v.poster)!.find((e) => e.type === 'bounty.closed')!.data.bounties.map((b: any) => [b.paid, b.refunded]), [[true, 0]]);
  assert.equal(f.no(v.stranger, 'bounty.post', { targetId: v.vic, amount: 5 }).code, 'TARGET_DEAD', 'known now');
  assert.equal(allSilver(f), before - ledger(f, 'destroyed.death') - ledger(f, 'destroyed.estate'));
}));

test('bounties: bleeding out pays the downer, a mob refunds the poster, and no id comes twice', () => {
  let f = fake();
  try {
    const v = cast(f);
    down(f, v, v.vic, v.kay);
    bleed(f);
    assert.equal(f.p(v.kay).bank.silver, 120);
  } finally { f.g.close(); }
  f = fake();
  try {
    const v = cast(f);
    f.p(v.vic).will = { kind: 'player', id: v.poster };
    f.g.mutate(() => damagePlayer(f.g, f.p(v.vic), 10_000, { kind: 'mob', id: 'm', name: 'Wolf' }));
    bleed(f);
    assert.ok(f.p(v.vic).dead);
    assert.equal(f.p(v.poster).bank.silver, undefined, 'not before it is known');
    // Posting on the secretly dead works as for the living, and comes back.
    f.put(v.lead, bankPos(f));
    f.ok(v.lead, 'bounty.post', { targetId: v.vic, amount: 10 });
    f.listen(v.poster);
    f.pass(KNOWN);
    assert.equal(f.p(v.poster).bank.silver, 120 + 777, 'refund and inheritance');
    assert.equal(f.p(v.lead).bank.silver, 10);
    const ids = f.heard.get(v.poster)!.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'two notices, two ids');
  } finally { f.g.close(); }
});

// ---------- the hood ----------

test('hood: a consumable for two minutes that the tick ends, and death takes off', scenario((f, v) => {
  assert.equal(f.no(v.kim, 'hood.wear').code, 'NOT_ENOUGH_ITEMS');
  f.p(v.kim).inventory[HOOD.item] = 3;
  const { as, leftMs } = f.ok(v.kim, 'hood.wear');
  assert.equal(leftMs, HOOD.ms);
  assert.equal(f.p(v.kim).inventory[HOOD.item], 2);
  assert.match(as, /^hood_[0-9a-f]{12}$/);
  assert.equal(f.ok(v.kim, 'observe').self.hood.as, as);
  const seen = f.ok(v.kay, 'observe').zone.players.find((p: any) => p.id === as);
  assert.deepEqual([seen.name, seen.equipment, seen.hooded], [HOOD.name, {}, true]);
  f.pass(HOOD.ms - 10_000);
  assert.equal(f.ok(v.kim, 'hood.wear').as, as, 'another extends it');
  f.pass(HOOD.ms + 1);
  assert.equal(f.p(v.kim).hood, undefined, 'it runs out');
  assert.notEqual(f.ok(v.kim, 'hood.wear').as, as, 'never the same figure twice');
  murder(f, v, v.kim, v.kay);
  assert.equal(f.p(v.kim).hood, undefined);
}));

test('hood: what would put a name to the figure is refused', scenario((f, v) => {
  wear(f, v.kim);
  f.put(v.kim, v.plot);
  assert.equal(f.no(v.kim, 'refine', { recipeId: 'copper_bar', from: 'stockpile' }).code, 'HOODED');
  f.put(v.kim, v.town);
  for (const [type, payload] of [
    ['trade.propose', { to: v.stranger, give: SILVER(1) }], ['trade.accept', { tradeId: 't' }], ['trade.lock', { tradeId: 't' }], ['will.set', { heir: v.heir }],
  ] as const) assert.equal(f.no(v.kim, type, payload).code, 'HOODED', type);
  wear(f, v.stranger);
  assert.equal(f.no(v.stranger, 'settlement.found', { name: 'Hidden Hold' }).code, 'HOODED');
  assert.ok(f.no(v.kim, 'will.set', { heir: v.heir }).retryAfterMs > 0);
}));

test('hood: a victim knows no name, not even in the last event they get', scenario((f, v) => {
  wear(f, v.kim);
  f.listen(v.vic);
  f.ok(v.kim, 'attack', { targetId: v.vic });
  murder(f, v);
  const told = f.heard.get(v.vic)!;
  for (const type of ['self.damaged', 'self.downed', 'self.died']) assert.ok(told.some((e) => e.type === type), type);
  const text = JSON.stringify([told, f.ok(v.vic, 'observe')]);
  assert.ok(text.includes(FIGURE) && text.includes(HOOD.name));
  assert.ok(!text.includes(v.kim) && !text.includes(NAMES.kim));
}));

test('hood: a hooded victim is a figure until death takes the hood off', scenario((f, v) => {
  wear(f, v.vic);
  f.put(v.wit, v.scene);
  f.listen(v.wit);
  down(f, v);
  const before = JSON.stringify([f.heard.get(v.wit), f.ok(v.wit, 'witness.log'), f.ok(v.wit, 'observe').zone.players]);
  assert.ok(before.includes(FIGURE));
  assert.ok(!before.includes(v.vic) && !before.includes(NAMES.vic));
  finish(f, v);
  assert.equal(f.heard.get(v.wit)!.find((e) => e.type === 'player.death')!.data.victimId, v.vic);
}));

test('hood: spoils don\'t list who fought in the order they joined', scenario((f, v) => {
  const bear = [...f.g.mobs.values()].find((m) => m.type === 'elder_bear')!;
  for (const id of [v.kim, v.wit, v.kay]) f.put(id, bear.home);
  f.listen(v.kay);
  for (const id of [v.kim, v.wit, v.kay]) f.ok(id, 'attack', { targetId: bear.id });
  // Kimball, first in, pulls a hood up for the kill.
  wear(f, v.kim);
  bear.hp = 1;
  f.ok(v.kim, 'attack', { targetId: bear.id });
  const { eligible } = f.heard.get(v.kay)!.find((e) => e.type === 'loot.dropped')!.data;
  assert.deepEqual(eligible, [NAMES.kay, NAMES.wit, HOOD.name], 'sorted, or the figure is whoever was first');
}));

test('hood: it can\'t go on in combat, but another cloak can extend one', scenario((f, v) => {
  f.p(v.kim).inventory[HOOD.item] = 5;
  const wolf = [...f.g.mobs.values()].find((m) => m.type === 'wolf' && m.zone === 'hollow')!;
  f.put(v.kim, wolf.home);
  f.ok(v.kim, 'attack', { targetId: wolf.id });
  assert.equal(f.no(v.kim, 'hood.wear').code, 'FORBIDDEN', 'just hit');
  f.p(v.kim).lastCombatAt = 0;
  const hunted = f.no(v.kim, 'hood.wear');
  assert.equal(hunted.code, 'FORBIDDEN', 'a mob is after them');
  assert.match(hunted.hint, /mob/);
  assert.equal(f.p(v.kim).inventory[HOOD.item], 5, 'no cloak used');
  f.put(v.kim, v.town);
  const { as } = f.ok(v.kim, 'hood.wear');
  assert.ok(!(v.kim in wolf.aggro), 'what was left behind forgets them');
  f.put(v.kim, v.scene);
  f.ok(v.kim, 'attack', { targetId: v.vic });
  assert.equal(f.ok(v.kim, 'hood.wear').as, as, 'extended mid-fight');
  // Without a mob: being hit by a player is combat enough.
  f.p(v.vic).inventory[HOOD.item] = 1;
  const inFight = f.no(v.vic, 'hood.wear');
  assert.equal(inFight.code, 'FORBIDDEN', 'just hit by a player');
  assert.ok(inFight.retryAfterMs > 0 && inFight.retryAfterMs <= TIMING.outOfCombatMs);
  f.pass(TIMING.outOfCombatMs);
  f.ok(v.vic, 'hood.wear');
}));

test('hood: a figure can be reached within view and no further', scenario((f, v) => {
  wear(f, v.kim);
  f.put(v.late, near(f, v.scene, 2, 6));
  f.ok(v.late, 'move', { to: FIGURE });
  f.put(v.late, v.far);
  for (const [type, payload] of [['move', { to: FIGURE }], ['attack', { targetId: FIGURE }], ['revive', { targetId: FIGURE }]] as const) {
    assert.match(f.no(v.late, type, payload).message, /not in sight/, `${type}, or the figure could be tracked`);
  }
}));

test('hood: a revive ends as it began, though a hood runs out on either side meanwhile', scenario((f, v) => {
  for (const [hoodOn, text] of [[v.kim, 'the reviver'], [v.vic, 'the revived']] as const) {
    f.put(v.wit, v.scene);
    down(f, v, v.vic, v.kay);
    f.p(hoodOn).hood = { as: FIGURE, until: f.now() + 2000 };
    f.listen(v.wit);
    f.ok(v.kim, 'revive', { targetId: f.p(v.vic).hood?.as ?? v.vic });
    f.pass(TIMING.reviveMs);
    f.pass(50);
    assert.equal(f.p(hoodOn).hood, undefined, 'ran out');
    const told = f.heard.get(v.wit)!.filter((e) => e.type.startsWith('player.reviv'));
    assert.equal(told.length, 2);
    for (const secret of [hoodOn, f.p(hoodOn).name]) assert.ok(!JSON.stringify(told).includes(secret), text);
    assert.equal(f.operator.filter((e) => e.type === 'player.revived').at(-1).data.byId, v.kim, 'the operator knows');
    f.p(v.vic).hp = 100;
  }
}));

test('hood: a boss\'s sweep hits a figure', scenario((f, v) => {
  const bear = [...f.g.mobs.values()].find((m) => m.type === 'elder_bear')!;
  for (const id of [v.kim, v.kay]) f.put(id, bear.home);
  wear(f, v.kim);
  f.listen(v.kay);
  f.ok(v.kim, 'attack', { targetId: bear.id });
  bear.nextAoeAt = f.now();
  f.pass(50);
  const sweep = f.heard.get(v.kay)!.find((e) => e.type === 'combat.hit' && e.data.ability === 'sweep')!;
  assert.deepEqual([sweep.data.targetId, sweep.data.targetName], [FIGURE, HOOD.name]);
}));

test('operator: the true killer and the true face, in the feed, the store and the state', scenario((f, v) => {
  wear(f, v.kim);
  f.put(v.wit, v.scene);
  f.ok(v.kim, 'chat.say', { text: 'hello' });
  f.ok(v.kim, 'attack', { targetId: v.vic });
  murder(f, v);
  const of = (type: string) => f.operator.find((e) => e.type === type);
  assert.deepEqual([of('chat.message').data.message.authorId, of('chat.message').data.message.authorName], [v.kim, NAMES.kim]);
  assert.deepEqual([of('combat.hit').data.attackerId, of('combat.hit').data.attackerName], [v.kim, NAMES.kim]);
  assert.deepEqual([of('player.downed').data.byId, of('player.downed').data.byName], [v.kim, NAMES.kim]);
  const death = of('player.death');
  assert.deepEqual([death.data.killerId, death.data.killerName], [v.kim, NAMES.kim]);
  assert.deepEqual(death.data.witnesses.map((w: any) => w.id).sort(), [v.kay, v.wit].sort());
  assert.deepEqual(death.hooded, [NAMES.kim]);
  assert.equal(JSON.parse(f.g.store.get<any>("SELECT data FROM events WHERE type = 'player.death'").data).data.killerId, v.kim);
  const bots = operatorState(f.g, 0).bots as any[];
  assert.ok(bots.find((b) => b.id === v.vic).dead);
  assert.ok(bots.find((b) => b.id === v.kim).hoodUntil > 0);
  f.pass(KNOWN);
  assert.equal(of('estate').data.to.id, v.heir);
}));

test('evidence: everyone present gets it, it can be read later, and bleeding out names nobody to newcomers', scenario((f, v) => {
  f.put(v.wit, v.scene);
  f.listen(v.wit, v.late, v.stranger);
  down(f, v);
  f.put(v.late, v.far);
  bleed(f);
  const log = f.ok(v.wit, 'witness.log').entries;
  assert.deepEqual(log.map((e: any) => e.act), ['player.death', 'player.downed']);
  assert.equal(log[1].actor.id, v.kim, 'saw the blow');
  assert.equal(log[0].actor, null);
  for (const e of log) assert.equal(e.id, undefined, 'no row ids');
  const told = f.heard.get(v.late)!.find((e) => e.type === 'player.death')!;
  assert.equal(told.data.killerId, null);
  assert.ok(!JSON.stringify([f.heard.get(v.late), f.ok(v.late, 'witness.log')]).includes(v.kim), 'arrived after the blow');
  assert.deepEqual(f.heard.get(v.stranger), [], 'elsewhere');
}));

test('the dead are no cameras: no events, and nothing of the living in observe', scenario((f, v) => {
  const c = murder(f, v);
  f.listen(v.vic);
  const view = () => f.ok(v.vic, 'observe');
  const before = view();
  f.put(v.wit, c);
  f.ok(v.wit, 'chat.say', { text: 'who did this?' });
  f.ok(v.lead, 'party.say', { text: 'where are you' });
  f.ok(v.lead, 'dm.send', { to: v.vic, text: 'hello?' });
  f.put(v.lead, v.plot);
  f.p(v.lead).inventory.stone = 5;
  f.ok(v.lead, 'stockpile.deposit', { items: [{ item: 'stone', qty: 5 }] });
  f.ok(v.wit, 'death.report', { corpseId: c.id, text: 'dead' });
  f.pass(1000);
  assert.deepEqual(f.heard.get(v.vic), [], 'no events');
  const after = view();
  assert.deepEqual(after.zone, before.zone);
  assert.deepEqual([after.unreadDms, after.party, after.settlement, after.settlementInvites, after.partyInvites], [0, null, null, [], []]);
  for (const key of ['players', 'lootBags', 'corpses', 'mobs', 'plots', 'nodes']) assert.deepEqual(after.zone[key], [], key);
}));

// ---------- saves ----------

test('saves: restarts keep it all, the downed get their time again, and the operator still has the truth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-death-'));
  const dbPath = join(dir, 'world.db');
  try {
    let f = fake({ dbPath });
    const v = cast(f);
    const c = murder(f, v);
    down(f, v, v.kay);
    f.pass(TIMING.downedMs - 5000);
    f.g.close();
    f = fake({ dbPath }, c.at + 3 * 3600_000, 'r');
    f.pass(10);
    assert.ok(f.p(v.kay).downed && !f.p(v.kay).dead, 'downtime bleeds nobody out');
    assert.ok(f.p(v.kay).downed!.until - f.now() >= TIMING.downedMs - 100);
    assert.deepEqual(f.g.corpses.get(c.id)!.blow, c.blow);
    assert.ok(f.g.corpses.get(c.id)!.settledAt, 'known by now');
    assert.equal(f.p(v.heir).bank.silver, 777);
    assert.equal(f.g.bounties.size, 0);
    f.g.close();
    f = fake({ dbPath }, c.at + 4 * 3600_000, 's');
    assert.ok(f.p(v.vic).dead!.settled);
    assert.equal(f.no(v.vic, 'chat.say', { text: 'x' }).code, 'DEAD');
    assert.equal(f.g.bounties.size, 0, 'the closed bounty stays closed');
    f.g.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saves: from before stage 5 everyone gets one bandage, once, and charters pay no reward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-death-'));
  const dbPath = join(dir, 'world.db');
  try {
    let f = fake({ dbPath });
    const v = cast(f);
    f.g.close();
    const db = new DatabaseSync(dbPath);
    for (const row of db.prepare('SELECT id, data FROM players').all() as any[]) {
      const p = JSON.parse(row.data);
      delete p.inventory[DEATH.bandage];
      delete p.will;
      p.kitVersion = 2;
      db.prepare('UPDATE players SET data = ? WHERE id = ?').run(JSON.stringify(p), row.id);
    }
    for (const row of db.prepare('SELECT id, data FROM settlements').all() as any[]) {
      const s = JSON.parse(row.data);
      delete s.charter.reportReward;
      db.prepare('UPDATE settlements SET data = ? WHERE id = ?').run(JSON.stringify(s), row.id);
    }
    db.exec('DROP TABLE corpses; DROP TABLE bounties;');
    db.close();
    for (let i = 0; i < 3; i++) {
      f = fake({ dbPath }, 1_000_000, `r${i}`);
      for (const p of f.g.players.values()) assert.equal(p.inventory[DEATH.bandage], 1, `${p.name}, restart ${i}`);
      assert.equal(f.g.settlements.get(v.sid)!.charter.reportReward, 0);
      assert.equal(f.ok(v.lead, 'settlement.view').settlement.charter.reportReward, 0);
      f.g.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed write kills nobody, pays nobody and drops nothing', () => {
  const f = fake({ log: () => {} });
  try {
    const v = cast(f);
    down(f, v);
    f.save();
    const state = () => JSON.stringify([
      f.p(v.vic).downed, f.p(v.vic).dead ?? null, f.p(v.vic).inventory, f.p(v.kim).bank, f.g.corpses.size, f.g.bags.size, [...f.g.bounties.values()],
    ]);
    const before = state();
    const run = f.g.store.run.bind(f.g.store);
    f.g.store.run = ((sql: string, ...args: any[]) => {
      if (sql.startsWith('INSERT INTO corpses')) throw new Error('disk full');
      return run(sql, ...args);
    }) as typeof f.g.store.run;
    assert.equal(f.run(v.kim, 'attack', { targetId: v.vic }).error.code, 'INTERNAL');
    assert.equal(state(), before);
    f.g.store.run = run;
    assert.equal(finish(f, v).killed, true);
  } finally { f.g.close(); }
});

// ---------- secrecy: twins ----------

function twins() {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-death-twin-'));
  const base = fake({ dbPath: join(dir, 'base.db') });
  const v = cast(base);
  base.g.close();
  let n = 0;
  return {
    v,
    copy() {
      const dbPath = join(dir, `twin${++n}.db`);
      copyFileSync(join(dir, 'base.db'), dbPath);
      return { dbPath, f: fake({ dbPath }, 1_100_000, 't') };
    },
    done() { rmSync(dir, { recursive: true, force: true }); },
  };
}
type Twins = ReturnType<typeof twins>;

/** Ids that are random and not the secret. Hoods' ids are set by the tests and stay. */
const sameIds = (x: unknown) => JSON.parse(JSON.stringify(x ?? null)
  .replace(/\b(t|r|party|motion|bag|stl|corpse|bounty)_[0-9a-f]{12}\b/g, '$1_x')
  .replace(/#[0-9a-f]{8}\b/g, '#x'));

interface Probe {
  /** Who is compared. */
  watchers: string[];
  /** Ids and names the watchers aim every command at. */
  targets: string[];
  /** Where they go before they probe. */
  move?: [string, Pos][];
  /** Extra payload, such as the corpse found by then. */
  extra?: (f: Fake) => object;
}

/**
 * Everything `watchers` can learn after `act`: every event they get, every read command, every mutating command aimed
 * at every target, and what they read after a restart.
 */
function learned(t: Twins, probe: Probe, act: (f: Fake, seen: Record<string, unknown>) => void) {
  const { dbPath, f: first } = t.copy();
  let f = first;
  const seen: Record<string, unknown> = {};
  const { watchers, targets } = probe;
  try {
    withOdds({}, () => {
      // Who is online is no part of any secret here.
      for (const id of Object.keys(NAMES).map((key) => t.v[key as keyof Cast])) f.ok(id, 'observe');
      f.pass(50);
      f.listen(...new Set([...watchers, t.v.kim, t.v.kay]));
      act(f, seen);
      f.pass(50);
      for (const [id, pos] of probe.move ?? []) f.put(id, pos);
      for (const id of watchers) seen[`${id} right after`] = f.raw(id, 'observe');

      const pos = new Map(watchers.map((id) => [id, { ...f.p(id).pos }]));
      const extra = probe.extra?.(f) ?? {};
      const base = (key: string) => ({
        settlementId: t.v.sid, playerId: key, targetId: key, ownerId: key, to: key, with: key, heir: key, accuse: key, name: key, kind: 'exile',
        amount: 5, corpseId: 'corpse_000000000000', channel: `zone:hollow`, building: 'palisade', recipeId: 'copper_bar', item: 'iron_sword#aaaaaaaa',
        text: 'hello', title: 'hello', body: 'hello', questId: 'wolf_cull', items: [{ item: 'stone', qty: 1 }], ...extra,
      });
      const payloads = [{}, { limit: 200, ...extra }, ...targets.map(base)];
      const types = Object.keys(f.g.commands);
      const reads = types.filter((type) => !f.g.commands[type].mutates);
      // A dead watcher's every command is the same refusal.
      for (const id of watchers) {
        for (const type of reads) payloads.forEach((payload, i) => { seen[`${id} ${type} ${i}`] = f.run(id, type, payload); });
      }
      // Pilfering rolls dice. Leaving and wearing a hood would change who is asking: last, and not at all.
      const writes = [...types.filter((type) => f.g.commands[type].mutates && !type.endsWith('.pilfer') && type !== 'settlement.leave' && type !== 'party.leave'), 'party.leave', 'settlement.leave'];
      for (const id of watchers) {
        for (const type of writes) {
          // One report per corpse each, and the rest once: the first target is the one that matters.
          const aimed = ['move', 'attack', 'ability.use', 'revive', 'dm.send', 'bounty.post', 'party.invite', 'trade.propose', 'settlement.invite'].includes(type) ? targets : targets.slice(0, 1);
          aimed.forEach((key, i) => {
            const r = f.run(id, type, { ...base(key), ...(type === 'ability.use' ? { ability: 'punch' } : {}) });
            assert.notEqual(r.error?.code, 'RATE_LIMITED', `${type} was not really tried`);
            assert.notEqual(r.error?.code, 'INTERNAL', type);
            seen[`${id} ${type} to ${i}`] = r;
            f.put(id, pos.get(id)!);
          });
        }
      }
      f.pass(1000);
      for (const id of watchers) seen[`${id} events`] = f.heard.get(id);

      f.save();
      const clock = f.now();
      f.g.close();
      f = fake({ dbPath }, clock, 'r');
      for (const id of watchers) {
        for (const type of reads) seen[`${id} ${type} after a restart`] = f.run(id, type, base(targets[0]));
      }
    });
    return sameIds(seen) as Record<string, any>;
  } finally { f.g.close(); }
}

/** The same, key by key, so a leak says where it is. */
function assertSame(a: Record<string, any>, b: Record<string, any>, why: string) {
  assert.deepEqual(Object.keys(a), Object.keys(b), why);
  for (const key of Object.keys(a)) assert.deepEqual(a[key], b[key], `${why}: ${key}`);
}

const elsewhere = (v: Village) => [v.lead, v.mate, v.late, v.heir, v.poster, v.stranger, v.neighbour];

test('secrecy: a death nobody saw is a hit to everyone elsewhere, event ids and a late arrival included', () => {
  const t = twins();
  try {
    const { v } = t;
    const probe: Probe = { watchers: elsewhere(v), targets: [v.vic, NAMES.vic, v.kim], move: [[v.late, v.far]] };
    const setDowned = (f: Fake, until = f.now() + FOREVER) => {
      f.p(v.vic).hp = 0;
      f.p(v.vic).downed = { at: f.now(), until, forMs: TIMING.downedMs, blow: { kind: 'mob', id: 'm', name: 'Wolf', as: { id: 'm', name: 'Wolf' }, cause: { by: 'mob', mob: 'wolf' } } };
      f.save();
    };
    const hit = learned(t, probe, (f) => {
      f.save();
      assert.equal(f.ok(v.kim, 'attack', { targetId: v.vic }).downed, undefined);
    });
    const finished = learned(t, probe, (f) => {
      setDowned(f);
      assert.equal(f.ok(v.kim, 'attack', { targetId: v.vic }).killed, true);
    });
    assertSame(hit, finished, 'a hit or a kill');

    const downed = learned(t, probe, (f) => {
      f.p(v.vic).hp = 1;
      f.save();
      assert.equal(f.ok(v.kim, 'attack', { targetId: v.vic }).downed, true);
      // Bleeding out is its own twin below.
      f.p(v.vic).downed!.until = f.now() + FOREVER;
    });
    assertSame(hit, downed, 'a hit or going down');

    const hitThenTick = learned(t, probe, (f) => {
      f.save();
      f.ok(v.kim, 'attack', { targetId: v.vic });
      f.g.tick();
    });
    const bledOut = learned(t, probe, (f) => {
      setDowned(f, f.now() + 1);
      f.ok(v.kim, 'observe'); // a command like the hit's, at the same moment
      f.g.tick();
      assert.ok(f.p(v.vic).dead);
    });
    assertSame(hitThenTick, bledOut, 'a hit or bleeding out');

    const noBroadcast = Object.entries(finished).filter(([key]) => key.endsWith(' events')).flatMap(([, events]) => events as GameEvent[]);
    for (const e of noBroadcast) assert.doesNotMatch(e.type, /^(player\.(death|downed)|self\.died|death\.report|will\.inherited|bounty\.(paid|closed)|loot\.)/, 'nothing is broadcast');
  } finally { t.done(); }
});

test('secrecy: looting the corpse is told only to those who can see it', () => {
  const t = twins();
  try {
    const { v } = t;
    const { f } = t.copy();
    try {
      const c = murder(f, v);
      f.put(v.late, v.far);
      f.put(v.wit, c);
      f.listen(v.late, v.wit, v.stranger);
      f.ok(v.kim, 'loot', { bagId: c.bagId });
      assert.deepEqual(f.heard.get(v.wit)!.map((e) => e.type), ['loot.taken']);
      assert.deepEqual(f.heard.get(v.late), [], 'in the region, out of sight');
      assert.deepEqual(f.heard.get(v.stranger), []);
      assert.ok(f.operator.some((e) => e.type === 'loot.taken'));
    } finally { f.g.close(); }
  } finally { t.done(); }
});

test('secrecy: event ids and everything elsewhere are the same whoever saw it', () => {
  const t = twins();
  try {
    const { v } = t;
    const probe: Probe = { watchers: [v.lead, v.late, v.heir, v.poster, v.stranger, v.neighbour], targets: [v.vic, v.kim] };
    const seenBy = (witnesses: string[]) => learned(t, probe, (f, seen) => {
      for (const id of witnesses) f.put(id, v.scene);
      f.listen(...witnesses);
      f.p(v.vic).hp = 1;
      f.save();
      seen.down = f.ok(v.kim, 'attack', { targetId: v.vic });
      seen.kill = f.ok(v.kim, 'attack', { targetId: v.vic });
      for (const id of witnesses) f.put(id, v.town);
    });
    assertSame(seenBy([]), seenBy([v.wit, v.mate]), 'no witness or two');
  } finally { t.done(); }
});

test('secrecy: who killed is nowhere outside the region, before and after the death is known', () => {
  const t = twins();
  try {
    const { v } = t;
    const probe: Probe = {
      watchers: elsewhere(v), targets: [v.vic, v.kim, v.kay], move: [[v.late, v.scene]],
      extra: (f) => ({ corpseId: f.p(v.vic).dead!.corpseId }),
    };
    for (const later of [0, KNOWN]) {
      const by = (killer: string) => learned(t, probe, (f) => {
        // Same spot either way, and gone before anyone comes by.
        for (const id of [v.kim, v.kay]) f.put(id, v.scene);
        f.p(v.vic).hp = 1;
        f.save();
        f.ok(killer, 'attack', { targetId: v.vic });
        f.ok(killer, 'attack', { targetId: v.vic });
        for (const id of [v.kim, v.kay]) {
          Object.assign(f.p(id), { combatLockUntil: 0, lastCombatAt: 0, hp: 100, busyUntil: 0 });
          f.put(id, v.otherPlot);
        }
        if (later) f.pass(later);
      });
      const kim = by(v.kim);
      const examined = kim[`${v.late} corpse.examine 1`];
      assert.equal(examined.result.cause.weapon, 'copper_sword', 'the late arrival does examine the body');
      assertSame(kim, by(v.kay), later ? 'who, once known' : 'who, while secret');
    }
  } finally { t.done(); }
});

test('secrecy: a will and the wealth behind it show to nobody else, at death or after', () => {
  const t = twins();
  try {
    const { v } = t;
    const estate = (setup: (f: Fake) => void, watchers: string[]) => learned(t, { watchers, targets: [v.vic, v.heir2] }, (f) => {
      f.put(v.vic, bankPos(f));
      setup(f);
      f.put(v.vic, v.scene);
      murder(f, v);
      f.pass(KNOWN);
    });
    const will = (heir: string | null) => (f: Fake) => { f.ok(v.vic, 'will.set', { heir }); };
    const others = [v.lead, v.mate, v.poster, v.stranger, v.neighbour];
    assertSame(estate(will(v.heir), others), estate(will(v.heir2), others), 'which heir');
    // Members see what comes into their stockpile, so only outsiders are compared from here.
    const outsiders = [v.poster, v.stranger, v.neighbour, v.late];
    assertSame(estate(will(v.heir), outsiders), estate(will(null), outsiders), 'a will or none');
    assertSame(estate(will(v.heir), outsiders), estate(will(v.sid), outsiders), 'a player or the settlement');
    const poor = (f: Fake) => {
      will(null)(f);
      f.p(v.vic).bank = {};
      delete f.g.settlements.get(v.sid)!.stashes[v.vic];
      f.save();
    };
    assertSame(estate(will(null), outsiders), estate(poor, outsiders), 'rich or poor');
  } finally { t.done(); }
});

test('secrecy: the notices of a death made known don\'t say where it happened', () => {
  const t = twins();
  try {
    const { v } = t;
    const at = (place: (f: Fake) => Pos) => learned(t, { watchers: [v.lead, v.mate, v.heir, v.poster, v.stranger], targets: [v.vic] }, (f) => {
      const pos = place(f);
      for (const id of [v.vic, v.kim, v.kay]) f.put(id, pos);
      murder(f, v);
      f.pass(KNOWN);
    });
    const hollow = at(() => v.scene);
    assert.ok(JSON.stringify(hollow[`${v.heir} events`]).includes('will.inherited'));
    assert.ok(JSON.stringify(hollow[`${v.poster} events`]).includes('bounty.closed'));
    assertSame(hollow, at((f) => f.g.map.anchors.frontier), 'in the Hollow or the Frontier');
  } finally { t.done(); }
});

test('secrecy: the party sees within view only, and one exception is a downed partner in the region', scenario((f, v) => {
  const seen = (id: string) => f.ok(id, 'party.view').party.members.find((m: any) => m.id === v.vic);
  const before = seen(v.lead);
  assert.deepEqual([before.zone, before.pos, before.hp, before.maxHp, before.walking], [null, null, null, null, null]);
  down(f, v);
  assert.deepEqual(seen(v.lead), before, 'downed');
  assert.equal(seen(v.kay).hp, 0, 'a partner in the region could come and revive');
  finish(f, v);
  assert.deepEqual({ ...seen(v.lead), online: true }, { ...before, online: true }, 'dead');
  assert.deepEqual(f.ok(v.lead, 'observe').party.members.find((m: any) => m.id === v.vic).hp, null);
  assert.equal(f.no(v.lead, 'move', { to: v.kay }).code, 'BAD_REQUEST', 'nor can they be followed from afar');
}));

test('rescue: a downed partner shows across the region, unless hooded, and only until they die', scenario((f, v) => {
  f.put(v.lead, v.far);
  f.put(v.late, v.far);
  const seen = () => f.ok(v.lead, 'party.view').party.members.find((m: any) => m.id === v.vic);
  assert.equal(seen().pos, null, 'on their feet and out of view: nothing');
  assert.equal(f.ok(v.lead, 'player.get', { playerId: v.vic }).zone, null);
  down(f, v);
  assert.deepEqual([seen().hp, seen().zone, f.ok(v.lead, 'player.get', { playerId: v.vic }).zone], [0, 'hollow', 'hollow']);
  assert.equal(f.ok(v.late, 'player.get', { playerId: v.vic }).zone, null, 'partners only');
  assert.equal(f.no(v.late, 'move', { to: v.vic }).code, 'BAD_REQUEST');
  wear(f, v.vic);
  assert.equal(seen().pos, null, 'not under a hood');
  delete f.p(v.vic).hood;
  f.ok(v.lead, 'move', { to: v.vic }); // on the way
  f.put(v.lead, v.far);
  finish(f, v);
  assert.deepEqual([seen().hp, seen().pos], [null, null], 'dead: like someone out of view');
}));

// ---------- secrecy: who is under the hood ----------

/**
 * Kimball and Kaylee, both hooded: `actor` as one figure does everything there is to do, the other stands by as the
 * other figure. Whichever of them it is, everyone must learn the same.
 */
function masquerade(v: Village, actor: string, other: string) {
  return (f: Fake, seen: Record<string, unknown>) => {
    const { g } = f;
    const s = g.settlements.get(v.sid)!;
    Object.assign(s.charter, { taxPct: 10, withdrawRole: 'steward' });
    s.stockpile.copper_ore = 90;
    // A slot for the farm, once Victor's death leaves a village.
    s.buildings = s.buildings.filter((b) => b.id !== 'storehouse');
    s.work = {
      [v.kim]: { gathered: {}, given: { copper_ore: [{ qty: 40, readyAt: 1000 }] }, carry: {} },
      [v.kay]: { gathered: {}, given: { copper_ore: [{ qty: 10, readyAt: 1001 }] }, carry: {} },
      // Who reads the stockpile at the plot, and so sees everyone's units but their own.
      [v.mate]: { gathered: {}, given: { copper_ore: [{ qty: 40, readyAt: 1002 }] }, carry: {} },
    };
    for (const [id, as] of [[actor, FIGURE], [other, OTHER_FIGURE]] as const) {
      const p = f.p(id);
      wear(f, id, as);
      Object.assign(p.inventory, { copper_pickaxe: 1, copper_trowel: 1, copper_bar: 10 });
      p.quests.ore_run = { status: 'complete', progress: 6 };
      p.hp = 100_000; // nobody goes down by accident
      p.skills = {};
      f.put(id, v.scene);
    }
    f.put(v.mate, v.plot);
    f.put(v.wit, v.scene);
    f.save();
    f.listen(v.vic);
    const goes = (at: Pos) => { for (const id of [actor, other, v.wit]) f.put(id, at); };
    const act = (type: string, payload: object = {}) => f.ok(actor, type, payload);
    const look = (key: string, id = v.wit) => { seen[key] = f.ok(id, 'observe'); };

    look('both figures on one tile');
    act('chat.say', { text: 'nobody here but us figures' });
    act('equip', { item: 'leather_jerkin' });
    act('ability.use', { ability: 'evade' });
    f.p(actor).evadeUntil = 0;
    seen.hit = act('attack', { targetId: v.vic });
    f.p(v.vic).hp = 1;
    seen.down = act('attack', { targetId: v.vic });
    seen.kill = act('attack', { targetId: v.vic });
    const corpse = g.corpses.get(f.p(v.vic).dead!.corpseId)!;
    act('loot', { bagId: corpse.bagId });
    seen.report = act('death.report', { corpseId: corpse.id, text: 'I found the body', accuse: v.stranger });
    seen.victim = [f.heard.get(v.vic), f.ok(v.vic, 'observe')];

    // Saves someone.
    f.g.mutate(() => damagePlayer(f.g, f.p(v.wit), 10_000, { kind: 'mob', id: 'm', name: 'Wolf' }));
    act('revive', { targetId: v.wit });
    f.pass(TIMING.reviveMs);
    f.p(v.wit).hp = 100;

    // A beast after a figure.
    const wolf = [...g.mobs.values()].find((m) => m.type === 'wolf' && m.zone === 'hollow')!;
    goes(wolf.home);
    act('attack', { targetId: wolf.id });
    f.pass(50);
    look('a beast after a figure');
    f.pass(1600); // and bites
    wolf.hp = 1;
    f.put(actor, wolf);
    act('attack', { targetId: wolf.id });

    // A boss, with spoils.
    const bear = [...g.mobs.values()].find((m) => m.type === 'elder_bear')!;
    goes(bear.home);
    f.ok(v.wit, 'attack', { targetId: bear.id });
    f.ok(other, 'attack', { targetId: bear.id });
    bear.hp = 1;
    const spoils = act('attack', { targetId: bear.id }).spoilsBagId;
    f.put(v.mate, bear.home);
    seen.spoilsRefusal = f.no(v.mate, 'loot', { bagId: spoils });
    look('spoils');
    act('loot', { bagId: spoils });
    f.put(v.mate, v.plot);

    // Gathers.
    const quarry = [...g.nodes.values()].find((n) => n.type === 'stone_quarry' && n.zone === 'hollow')!;
    goes(quarry);
    act('equip', { item: 'copper_pickaxe' });
    act('gather', { nodeId: quarry.id });

    // At the plot: everything that is written down.
    goes(v.plot);
    look('at the plot', v.mate);
    act('stockpile.deposit', { items: [{ item: 'stone', qty: 5 }] });
    act('stockpile.withdraw', { items: [{ item: 'copper_ore', qty: 30 }] });
    withOdds({ witness: 1, watchtower: 1, traces: 1, tracesLocked: 1 }, () => act('stockpile.pilfer', { items: [{ item: 'stone', qty: 20 }] }));
    act('settlement.contribute', { building: 'farm', items: [{ item: 'pine_plank', qty: 30 }, { item: 'stone', qty: 30 }] });
    s.projects.farm!.materials = Object.fromEntries(BUILDINGS.farm.cost.map((i) => [i.item, i.qty]));
    f.save();
    act('equip', { item: 'copper_trowel' });
    act('settlement.build', { building: 'farm' });
    act('settlement.cancelProject', { building: 'farm' });
    act('equip', { item: 'copper_hammer' });
    const made = act('craft', { recipeId: 'copper_pot' }).items[0].id;
    seen.craftedBy = f.ok(v.mate, 'item.inspect', { item: made }).item.craftedBy;

    // Out of the region and back in, past the watchtower and the palisade.
    f.p(actor).combatLockUntil = 0;
    act('move', { to: 'wilds' });
    for (let i = 0; i < 400 && f.p(actor).travel; i++) f.pass(100);
    act('move', { to: v.plot.id });
    for (let i = 0; i < 400 && f.p(actor).travel; i++) f.pass(100);

    // In town.
    f.put(actor, v.town);
    f.put(other, v.town);
    f.put(actor, bankPos(f));
    act('bounty.post', { targetId: v.stranger, amount: 25 });
    f.put(actor, g.map.places.find((x) => x.id === 'quest_board')!);
    act('quest.claim', { questId: 'ore_run' });
    const thread = act('forum.createThread', { title: 'A notice', body: 'from a figure' }).thread.id;
    act('forum.reply', { threadId: thread, body: 'and another' });
    seen.threads = [f.ok(v.stranger, 'forum.listThreads'), f.ok(v.stranger, 'forum.getThread', { threadId: thread })];

    // Back to the scene, both alike.
    for (const id of [actor, other]) {
      const p = f.p(id);
      Object.assign(p, { hp: 100_000, combatLockUntil: 0, lastCombatAt: 0, busyUntil: 0 });
      f.put(id, v.scene);
    }
    f.put(v.wit, v.scene);
    f.save();
  };
}

test('secrecy: the hood hides who it is in every channel, command, log and event', () => {
  const t = twins();
  try {
    const { v } = t;
    const probe: Probe = {
      watchers: [v.wit, v.mate, v.lead, v.stranger, v.neighbour],
      targets: [FIGURE, v.kim, NAMES.kim, v.kay],
      extra: (f) => ({ corpseId: f.p(v.vic).dead!.corpseId }),
    };
    const kim = learned(t, probe, masquerade(v, v.kim, v.kay));
    const text = JSON.stringify(kim);
    // What the twins are to agree on has to be there at all.
    for (const proof of ['"player.death"', '"player.downed"', '"player.revived"', '"death.report"', '"settlement.alert"', '"at_pilfer"', '"traces"', '"reward"', '"tax"', '"arrive"', '"witness.saw"', '"chat.message"', '"gather"', '"craft"', '"combat.kill"']) {
      assert.ok(text.includes(proof), `the figure did ${proof}`);
    }
    assert.equal(kim.craftedBy, HOOD.name);
    assert.ok(kim.threads[0].result === undefined && JSON.stringify(kim.threads).includes(HOOD.name));
    assert.ok(JSON.stringify(kim.spoilsRefusal).includes(HOOD.name));
    assertSame(kim, learned(t, probe, masquerade(v, v.kay, v.kim)), 'Kimball or Kaylee');
  } finally { t.done(); }
});

test('secrecy: to their id and name a hooded player is someone elsewhere', () => {
  const t = twins();
  try {
    const { v } = t;
    const ask = (hooded: boolean) => {
      const { f } = t.copy();
      try {
        for (const id of [v.lead, v.late]) f.put(id, v.scene);
        if (hooded) wear(f, v.kim);
        else f.put(v.kim, v.town);
        f.save();
        const out: Record<string, unknown> = {};
        for (const watcher of [v.lead, v.late]) {
          out[`${watcher} get`] = f.run(watcher, 'player.get', { playerId: v.kim });
          for (const key of [v.kim, NAMES.kim]) {
            out[`${watcher} move ${key}`] = f.run(watcher, 'move', { to: key });
            out[`${watcher} attack ${key}`] = f.run(watcher, 'attack', { targetId: key });
            out[`${watcher} revive ${key}`] = f.run(watcher, 'revive', { targetId: key });
          }
        }
        // The partner too: nothing in the party gives the figure away.
        out.party = f.run(v.lead, 'party.view').result.party.members.find((m: any) => m.id === v.kim);
        return out;
      } finally { f.g.close(); }
    };
    assertSame(ask(true), ask(false), 'hooded here or elsewhere');
  } finally { t.done(); }
});

test('secrecy: a hood fights alone, so no bonus or credit names it', () => {
  const t = twins();
  try {
    const { v } = t;
    const fight = (change: (f: Fake) => void) => {
      const { f } = t.copy();
      try {
        for (const id of [v.lead, v.kim]) f.put(id, v.scene);
        f.put(v.kay, v.town);
        f.put(v.vic, v.town);
        f.put(v.stranger, v.scene);
        f.p(v.lead).equipment = { weapon: 'duskiron_sword' };
        change(f);
        f.save();
        const damage = f.ok(v.lead, 'attack', { targetId: v.stranger }).damage;
        const wolf = [...f.g.mobs.values()].find((m) => m.type === 'wolf' && m.zone === 'hollow')!;
        for (const id of [v.lead, v.kim]) if (f.p(id).zone === 'hollow') f.put(id, wolf.home);
        wolf.hp = 1;
        f.ok(v.kim, 'observe');
        f.listen(v.lead);
        if (f.p(v.kim).zone === 'hollow') f.ok(v.kim, 'attack', { targetId: wolf.id });
        return { damage, credited: f.heard.get(v.lead)!.some((e) => e.type === 'quest.progress') };
      } finally { f.g.close(); }
    };
    const alone = fight((f) => { f.put(v.kim, v.town); });
    const hooded = fight((f) => wear(f, v.kim));
    const open = fight(() => {});
    assert.deepEqual(hooded, alone);
    assert.ok(open.damage > hooded.damage && open.credited, 'a face does get both');
  } finally { t.done(); }
});

test('secrecy: pulling a hood up out of sight changes nothing for the rest of the region', () => {
  const t = twins();
  try {
    const { v } = t;
    const probe: Probe = { watchers: [v.lead, v.late], targets: [v.kim, NAMES.kim] };
    const polled = (hood: boolean) => learned(t, probe, (f, seen) => {
      // A wolf for Lenora, with Kimball in the region and out of sight of it.
      const wolves = [...f.g.mobs.values()].filter((m) => m.zone === 'hollow' && m.type === 'wolf');
      const tiles: Pos[] = [];
      for (let y = 0; y < f.g.map.height; y++) {
        for (let x = 0; x < f.g.map.width; x++) if (walkable(f.g.map, x, y) && regionAt(f.g.map, { x, y }) === 'hollow') tiles.push({ x, y });
      }
      let wolf = wolves[0], away = tiles[0];
      for (const w of wolves) for (const q of tiles) if (dist(q, w.home) > dist(away, wolf.home)) { wolf = w; away = q; }
      assert.ok(dist(away, wolf.home) > MAP_RULES.viewRadius + 2);
      for (const id of [v.lead, v.late]) f.put(id, wolf.home);
      for (const id of [v.vic, v.kay]) f.put(id, v.town);
      f.put(v.kim, away);
      // Region-wide, either of these would have told on Kimball: more damage, and an id for the credit.
      f.p(v.lead).equipment = { weapon: 'duskiron_sword' };
      f.p(v.kim).quests.wolf_cull = { status: 'active', progress: 0 };
      f.save();
      seen.before = [f.ok(v.lead, 'party.view'), f.ok(v.lead, 'player.get', { playerId: v.kim })];
      if (hood) {
        wear(f, v.kim);
        f.save();
      }
      seen.after = [f.ok(v.lead, 'party.view'), f.ok(v.lead, 'player.get', { playerId: v.kim })];
      seen.hit = f.ok(v.lead, 'attack', { targetId: v.late });
      wolf.hp = 1;
      seen.kill = f.ok(v.lead, 'attack', { targetId: wolf.id });
    });
    assertSame(polled(true), polled(false), 'a hood or none, out of sight');
  } finally { t.done(); }
});

test('secrecy: the palisade can\'t tell a hooded member from a hooded stranger', () => {
  const t = twins();
  try {
    const { v } = t;
    const crossing = (who: string) => learned(t, { watchers: [v.lead, v.mate, v.neighbour], targets: [FIGURE] }, (f) => {
      // The two are alike in all but membership, and only one of them is about.
      for (const id of [v.kim, v.wit]) {
        f.put(id, id === who ? f.g.map.anchors.wilds : f.g.map.anchors.frontier);
        Object.assign(f.p(id), { equipment: {}, inventory: {} });
      }
      wear(f, who);
      f.p(who === v.kim ? v.wit : v.kim).hood = { as: OTHER_FIGURE, until: f.now() + FOREVER };
      f.save();
      f.ok(who, 'move', { to: v.plot.id });
      for (let i = 0; i < 400 && f.p(who).travel; i++) f.pass(100);
    });
    const member = crossing(v.kim);
    assert.ok(JSON.stringify(member[`${v.lead} events`]).includes('settlement.alert'), 'it goes off');
    assertSame(member, crossing(v.wit), 'member or stranger');
  } finally { t.done(); }
});

test('secrecy: nothing that is numbered counts another player\'s deaths', scenario((f, v) => {
  const c = murder(f, v);
  f.put(v.stranger, c);
  f.ok(v.stranger, 'death.report', { corpseId: c.id, text: 'found' });
  f.put(v.lead, bankPos(f));
  const { bounty } = f.ok(v.lead, 'bounty.post', { targetId: v.kay, amount: 9 });
  for (const id of [c.id, c.bagId!, bounty.id]) assert.match(id, /^[a-z]+_[0-9a-f]{12}$/, 'random, not counted');
  const visible = [f.ok(v.stranger, 'death.list'), f.ok(v.stranger, 'corpse.examine', { corpseId: c.id }), f.ok(v.kay, 'witness.log'), f.ok(v.stranger, 'bounty.list')];
  const numericIds = JSON.stringify(visible).match(/"(id|seq|rowid)":\d+/g);
  assert.equal(numericIds, null);
}));

// ---------- over HTTP ----------

test('SDK: fight stops at downed, revive brings back, finishing takes its own attack', async () => {
  const w = await world({ speed: 40 });
  try {
    const killer = await w.bot('Killer');
    const victim = await w.bot('Prey');
    const K = (await killer.whoami()).playerId, V = (await victim.whoami()).playerId;
    const g = w.server.game;
    const at = g.map.anchors.frontier;
    for (const id of [K, V]) Object.assign(g.players.get(id)!, { pos: { ...at }, zone: 'frontier', travel: null });
    Object.assign(g.players.get(V)!, { hp: 3, lastCombatAt: Date.now() + 5000 });
    const r = await killer.fight(V);
    assert.equal(r.result, 'downed', 'fight never finishes anyone');
    await victim.revive();
    assert.equal((await victim.waitReady()).self.downed, null);
    assert.ok(g.players.get(V)!.hp > 0);
    Object.assign(g.players.get(V)!, { hp: 3, lastCombatAt: Date.now() + 5000 });
    assert.equal((await killer.fight(V)).result, 'downed');
    const died = victim.waitForEvent((e) => e.type === 'self.died', 5000);
    assert.equal((await killer.sendWhenReady('attack', { targetId: V })).killed, true);
    const corpseId = (await died).data.corpseId;
    assert.equal((await killer.examineCorpse(corpseId)).cause.by, 'player');
    assert.equal((await killer.reportDeath(corpseId, 'found like this')).first, true);
    assert.equal((await killer.deathReports()).deaths[0].victim.id, V);
    assert.ok((await victim.observe()).self.dead);
  } finally { await w.close(); }
});
