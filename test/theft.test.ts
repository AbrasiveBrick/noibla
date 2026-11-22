// Stage 4: pilfering, witnesses, traces and the watchtower.
//
// Secrecy is tested by comparing twins: copies of one saved world that differ in a single secret (who stole, what was
// in the stash, who saw it). Whoever is not entitled to that secret must get the same bytes in both, from every
// command and from the event stream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILDINGS, CATALOG, SETTLEMENT, TIMING, type BuildingId, type ItemStack } from '../src/shared/catalog.ts';
import { MAP_RULES, dist, regionAt, type Pos } from '../src/shared/map.ts';
import type { GameEvent } from '../src/shared/protocol.ts';
import { Game, type GameOptions } from '../src/server/game.ts';
import { CRIME_ODDS } from '../src/server/odds.ts';
import { operatorState } from '../src/server/operator.ts';
import { damagePlayer, killPlayer } from '../src/server/world.ts';
import type { Player, Settlement } from '../src/server/types.ts';
import { world } from './helpers.ts';

const bag = (list: ItemStack[]) => Object.fromEntries(list.map((s) => [s.item, s.qty]));
const SWORD_A = 'iron_sword#aaaaaaaa', SWORD_B = 'iron_sword#bbbbbbbb';

type Odds = Partial<typeof CRIME_ODDS>;
const NOTHING: Odds = { witness: 0, watchtower: 0, traces: 0, tracesLocked: 0 };

/** By then every witness.saw of an act has been sent: they follow it by up to a second. */
const TOLD_BY_MS = 1000;

/** Runs `fn` with these odds and no evidence otherwise. */
function withOdds<T>(odds: Odds, fn: () => T): T {
  const real = { ...CRIME_ODDS };
  Object.assign(CRIME_ODDS, NOTHING, odds);
  try { return fn(); } finally { Object.assign(CRIME_ODDS, real); }
}

// ---------- a game on a fake clock ----------

function fake(o: Partial<GameOptions> = {}, start = 1_000_000, session = 'c') {
  let now = start;
  let seq = 0;
  const g = new Game({ dbPath: ':memory:', now: () => now, seed: 4, mapSeed: 7, log: (line) => assert.fail(line), ...o });
  const heard = new Map<string, GameEvent[]>();
  const operator: GameEvent[] = [];
  g.subscribe({ kind: 'operator', send: (e) => operator.push(structuredClone(e)) });
  const listen = (id: string) => {
    if (!heard.has(id)) g.subscribe({ kind: 'player', playerId: id, send: (e) => heard.get(id)?.push(structuredClone(e)) });
    heard.set(id, []);
  };
  /** As it is, busy or not. */
  const raw = (id: string, type: string, payload: object = {}) => {
    now += 100; // under the command rate limit
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
  /** Setup edits memory: write all of it, for rollbacks, restarts and twins to go back to. */
  const save = () => g.mutate(() => {
    for (const x of g.players.values()) g.markPlayer(x);
    for (const x of g.settlements.values()) g.markSettlement(x);
  });
  return { g, raw, run, ok, no, p, put, save, listen, heard, operator, now: () => now, pass: (ms: number) => { now += ms; g.tick(); } };
}
type Fake = ReturnType<typeof fake>;

/**
 * One village with everything theft touches, and everybody who might learn something they shouldn't.
 *   Lead         leader, owns a stash, at the plot
 *   Bea, Cal     the members who steal, at the plot
 *   Eve          member, in the region but away from the plot
 *   Dan          member, in town
 *   Stranger     an outsider at the plot
 *   Former       left and kept a stash, at the plot
 *   Invited      invited, not joined, in the region
 *   Neighbour    leads the other settlement in the region, which has a watchtower
 */
function village(f: Fake) {
  const { g } = f;
  const [plot, other] = g.map.plots.filter((pl) => pl.region === 'hollow');
  const reg = (name: string) => g.register(name).playerId;
  const who = {
    lead: reg('Lead'), bea: reg('Bea'), cal: reg('Cal'), eve: reg('Eve'), dan: reg('Dan'),
    stranger: reg('Stranger'), former: reg('Former'), invited: reg('Invited'), neighbour: reg('Neighbour'),
  };
  const found = (id: string, at: typeof plot, name: string): string => {
    f.put(id, at);
    for (const [item, qty] of Object.entries(bag(SETTLEMENT.foundCost))) f.p(id).inventory[item] = (f.p(id).inventory[item] ?? 0) + qty;
    return f.ok(id, 'settlement.found', { name, plotId: at.id }).settlement.id;
  };
  const sid = found(who.lead, plot, 'Quiet Hold');
  const otherSid = found(who.neighbour, other, 'Next Door');
  for (const id of [who.bea, who.cal, who.eve, who.dan, who.former]) {
    f.ok(who.lead, 'settlement.invite', { playerId: id });
    f.ok(id, 'settlement.join', { settlementId: sid });
  }
  f.ok(who.former, 'settlement.leave');
  f.ok(who.lead, 'settlement.invite', { playerId: who.invited });

  const away = g.map.nodes.filter((n) => n.region === plot.region && dist(n, plot) > MAP_RULES.range.plot + 1 && dist(n, other) > MAP_RULES.range.plot + 1)[0];
  assert.ok(away && dist(plot, other) > 2 * MAP_RULES.range.plot, 'the map has room for the cast');
  for (const id of [who.lead, who.bea, who.cal, who.stranger, who.former]) f.put(id, plot);
  for (const id of [who.eve, who.invited]) f.put(id, away);
  f.put(who.dan, g.map.anchors.town);

  const s = (): Settlement => g.settlements.get(sid)!;
  const until = f.now() + 5 * 60_000;
  const raise = (to: Settlement, ...list: BuildingId[]) => { for (const id of list) to.buildings.push({ id, builtAt: f.now(), paidUntil: until }); };
  raise(s(), 'workshop', 'huts', 'watchtower', 'storehouse');
  raise(g.settlements.get(otherSid)!, 'watchtower', 'storehouse');
  s().charter.withdrawRole = 'leader';
  s().stockpile = { copper_ore: 120, stone: 1000, pine_plank: 400, silver: 800 };
  // All the ore was given, 40 each by three members, so any theft of ore eats into it. Bea's is the oldest.
  const giving = [who.bea, who.lead, who.cal];
  giving.forEach((id, i) => { s().work[id] = { gathered: {}, given: { copper_ore: [{ qty: 40, readyAt: 1000 + i }] }, carry: {} }; });
  s().stashes = { [who.lead]: { iron_bar: 1873 }, [who.former]: { leather: 731 } };
  g.settlements.get(otherSid)!.stockpile = { stone: 300, pine_plank: 300 };
  f.save();
  return { ...who, plot, other, away, sid, otherSid, s };
}
type Village = ReturnType<typeof village>;

const logOf = (f: Fake, id: string) => f.ok(id, 'stockpile.log', { limit: 200 }).entries as any[];
const thefts = (f: Fake) => f.operator.filter((e) => e.type === 'theft');

// ---------- rules ----------

test('catalog and docs: the cap is a tunable, the odds are in words, and nothing offers keys', () => {
  assert.equal(CATALOG.settlement.pilferPct, SETTLEMENT.pilferPct);
  assert.ok(SETTLEMENT.pilferPct > 0 && SETTLEMENT.pilferPct < 100, 'one action cannot empty anything');
  assert.ok(CATALOG.timing.pilferMs > 0);
  assert.ok(CRIME_ODDS.tracesLocked > CRIME_ODDS.traces, 'the lock raises the chance');
  for (const chance of Object.values(CRIME_ODDS)) assert.ok(chance > 0 && chance < 1);

  const catalog = JSON.stringify(CATALOG);
  assert.doesNotMatch(catalog, /tracesLocked|"witness"|"traces"|crime|stockpile_key/);
  for (const id of ['watchtower', 'storehouse', 'huts'] as const) assert.doesNotMatch(BUILDINGS[id].description, /\d/, `${id} is in words only`);
  assert.match(BUILDINGS.watchtower.description, /witness/);
  assert.match(BUILDINGS.storehouse.description, /\block/);

  const docs = readFileSync(new URL('../docs/SDK.md', import.meta.url), 'utf8');
  const section = docs.slice(docs.indexOf('\n## Theft and witnesses'), docs.indexOf('\n## High-level helpers'));
  assert.ok(section.length > 500);
  assert.deepEqual([...new Set(section.match(/\d+\s*%/g))], [`${SETTLEMENT.pilferPct}%`], 'the only percentage is the cap');
  assert.doesNotMatch(section, /\bkeys?\b|outsiders? (can|may) pilfer/i);
});

test('who may: any member at the plot whatever the charter, and nobody else', () => {
  const f = fake();
  try {
    const v = village(f);
    withOdds({}, () => {
      const one = { items: [{ item: 'stone', qty: 1 }] };
      assert.equal(f.no(v.bea, 'stockpile.withdraw', one).code, 'FORBIDDEN', 'the charter keeps Bea out');
      assert.deepEqual(f.ok(v.bea, 'stockpile.pilfer', one).taken, one.items);
      assert.equal(f.no(v.eve, 'stockpile.pilfer').code, 'OUT_OF_RANGE');
      assert.equal(f.no(v.dan, 'stash.pilfer', { ownerId: v.lead }).code, 'OUT_OF_RANGE');

      for (const id of [v.stranger, v.former, v.invited]) {
        assert.equal(f.no(id, 'stockpile.pilfer').code, 'SETTLEMENT_STATE');
        assert.equal(f.no(id, 'stash.pilfer', { ownerId: v.lead }).code, 'SETTLEMENT_STATE');
      }
      // A member of another settlement only reaches their own, whatever they send.
      f.put(v.neighbour, v.plot);
      const before = { ...v.s().stockpile };
      assert.equal(f.no(v.neighbour, 'stockpile.pilfer', { settlementId: v.sid }).code, 'OUT_OF_RANGE');
      assert.deepEqual(v.s().stockpile, before);
      f.put(v.neighbour, v.other);
      f.ok(v.neighbour, 'stockpile.pilfer', { settlementId: v.sid });
      assert.deepEqual(v.s().stockpile, before);
    });
  } finally { f.g.close(); }
});

test('cap: a share of each item or one single item, never the last, and no amounts in the errors', () => {
  const f = fake();
  try {
    const v = village(f);
    const pilfer = (items?: ItemStack[]) => f.ok(v.bea, 'stockpile.pilfer', items ? { items } : {}).taken;
    const refused = (items?: ItemStack[]) => f.no(v.bea, 'stockpile.pilfer', items ? { items } : {});
    const set = (pile: Record<string, number>) => { v.s().stockpile = pile; f.save(); };
    withOdds({}, () => {
      set({ stone: 1003, pine_plank: 7, iron_bar: 3, silver: 81 });
      assert.deepEqual(pilfer(), [{ item: 'pine_plank', qty: 1 }, { item: 'silver', qty: 20 }, { item: 'stone', qty: 250 }], 'the most, rounded down');

      set({ stone: 1000, silver: 80 });
      const over = refused([{ item: 'stone', qty: 251 }]);
      assert.equal(over.code, 'BAD_REQUEST');
      assert.ok(over.hint.includes(`${SETTLEMENT.pilferPct}%`));
      assert.doesNotMatch(over.message + over.hint, /1000|250/, 'no amounts');
      assert.equal(refused([{ item: 'stone', qty: 250 }, { item: 'silver', qty: 21 }]).code, 'BAD_REQUEST', 'each kind has its own cap');
      const absent = refused([{ item: 'stone', qty: 5000 }]);
      assert.equal(absent.code, 'NOT_ENOUGH_ITEMS');
      assert.doesNotMatch(absent.message + absent.hint, /1000/);
      assert.deepEqual(pilfer([{ item: 'stone', qty: 250 }]), [{ item: 'stone', qty: 250 }]);

      // Uniques count with their base, so naming them one by one gets no more.
      set({ [SWORD_A]: 1, [SWORD_B]: 1, 'iron_sword#cccccccc': 1, iron_sword: 1 });
      assert.equal(refused([{ item: SWORD_A, qty: 1 }, { item: SWORD_B, qty: 1 }]).code, 'BAD_REQUEST');
      assert.equal(refused([{ item: 'iron_sword', qty: 2 }]).code, 'BAD_REQUEST');
      assert.deepEqual(pilfer([{ item: SWORD_B, qty: 1 }]), [{ item: SWORD_B, qty: 1 }]);

      set({ iron_bar: 2, leather: 1 });
      const small = refused();
      assert.equal(small.code, 'NOT_ENOUGH_ITEMS');
      assert.match(small.hint, /qty: 1/);
      assert.equal(refused([{ item: 'iron_bar', qty: 1 }, { item: 'leather', qty: 1 }]).code, 'BAD_REQUEST', 'one single item, not one of each');
      assert.deepEqual(pilfer([{ item: 'leather', qty: 1 }]), [{ item: 'leather', qty: 1 }]);
      pilfer([{ item: 'iron_bar', qty: 1 }]);
      assert.equal(refused([{ item: 'iron_bar', qty: 1 }]).code, 'BAD_REQUEST', 'never the last one');
      set({});
      assert.equal(refused().code, 'NOT_ENOUGH_ITEMS');

      // What repeating allows: much, soon, and never all of it.
      set({ stone: 25_000 });
      let actions = 0;
      while (v.s().stockpile.stone > 1) {
        const left = v.s().stockpile.stone;
        pilfer(left >= 4 ? undefined : [{ item: 'stone', qty: 1 }]);
        assert.ok(left - v.s().stockpile.stone <= Math.max(1, left / 4), 'no action takes more than the cap');
        if (++actions === 4) assert.ok(Math.abs(v.s().stockpile.stone / 25_000 - 0.75 ** 4) < 0.001, 'four actions leave 32%');
      }
      assert.ok(actions * TIMING.pilferMs < 6 * 60_000 && actions > 30, `${actions} actions`);
      assert.equal(refused([{ item: 'stone', qty: 1 }]).code, 'BAD_REQUEST');
    });
  } finally { f.g.close(); }
});

test('timed: the goods at once, then busy; damage does not interrupt; a killer gets the loot', () => {
  const f = fake();
  try {
    const v = village(f);
    withOdds({}, () => {
      const { taken, busyMs } = f.ok(v.bea, 'stockpile.pilfer', { items: [{ item: 'stone', qty: 200 }] });
      assert.equal(busyMs, TIMING.pilferMs);
      assert.equal(f.p(v.bea).inventory.stone, 200);
      for (const [type, payload] of [
        ['stockpile.pilfer', {}], ['stash.pilfer', { ownerId: v.lead }], ['move', { to: 'wilds' }], ['attack', { targetId: v.stranger }],
      ] as const) assert.equal(f.raw(v.bea, type, payload).error?.code, 'BUSY', type);

      const until = f.p(v.bea).busyUntil;
      f.g.mutate(() => damagePlayer(f.g, f.p(v.bea), 5, { kind: 'player', id: v.stranger, name: 'Stranger' }));
      assert.equal(f.p(v.bea).busyUntil, until, 'still at it');
      assert.equal(f.p(v.bea).inventory.stone, 200, 'and still holding it');
      f.g.mutate(() => killPlayer(f.g, f.p(v.bea), { kind: 'player', id: v.stranger, name: 'Stranger' }));
      const dropped = [...f.g.bags.values()].find((b) => b.ownerId === v.bea)!;
      assert.equal(dropped.items.stone, taken[0].qty);

      f.ok(v.cal, 'stockpile.pilfer');
      f.pass(TIMING.pilferMs);
      assert.ok(f.raw(v.cal, 'stockpile.pilfer').ok, 'free again after that');
    });
  } finally { f.g.close(); }
});

test('unseen: `missing` has the items and no actor, in the row, the event and every member view', () => {
  const f = fake();
  try {
    const v = village(f);
    for (const id of [v.lead, v.eve, v.dan]) f.listen(id);
    const taken = withOdds({}, () => f.ok(v.bea, 'stockpile.pilfer').taken);

    const row = f.g.store.get<any>("SELECT * FROM stockpile_log WHERE action = 'missing'")!;
    assert.deepEqual([row.actor_id, row.actor_name, row.building], [null, null, null]);
    assert.deepEqual(JSON.parse(row.items), taken);
    assert.ok(!JSON.stringify(row).includes(v.bea));

    for (const id of [v.lead, v.eve, v.dan]) {
      const events = f.heard.get(id)!;
      assert.deepEqual(events.map((e) => e.type), ['stockpile.changed'], 'members hear of it once');
      const [e] = events;
      assert.deepEqual([e.actorId, e.actorName], [undefined, undefined], 'the event meta names nobody');
      assert.deepEqual([e.data.entry.action, e.data.entry.actorId, e.data.entry.actorName, e.data.entry.items], ['missing', null, null, taken]);
      assert.doesNotMatch(JSON.stringify(events), new RegExp(`${v.bea}|"Bea"`));
      const first = logOf(f, id)[0];
      assert.deepEqual([first.action, first.actorId, first.actorName], ['missing', null, null]);
    }
    assert.deepEqual(f.ok(v.lead, 'stockpile.view').log[0].actorId, null);
    const stored = f.g.store.all<{ data: string }>("SELECT data FROM events WHERE type = 'stockpile.changed'").map((r) => JSON.parse(r.data)).find((e) => e.data.entry.action === 'missing');
    assert.equal(stored.actorId, undefined);

    // The operator sees the truth.
    const [theft] = thefts(f);
    assert.deepEqual([theft.actorId, theft.data.actor, theft.data.act], [v.bea, { id: v.bea, name: 'Bea' }, 'stockpile.pilfer']);
    assert.deepEqual([theft.data.items, theft.data.witnesses, theft.data.watched, theft.data.traces], [taken, [], [], false]);
    const shown = operatorState(f.g, 0).events.find((e) => e.type === 'theft')!;
    assert.deepEqual(shown.data, theft.data);
  } finally { f.g.close(); }
});

test('witnesses: everyone else standing in the region may see it, and each is told alone', () => {
  const f = fake();
  try {
    const v = village(f);
    const walker = f.g.register('Walker').playerId;
    f.put(walker, v.away);
    f.ok(walker, 'move', { to: v.plot.id });
    const all = [v.lead, v.bea, v.cal, v.eve, v.dan, v.stranger, v.former, v.invited, v.neighbour, walker];
    for (const id of all) f.listen(id);

    const taken = withOdds({ witness: 1 }, () => f.ok(v.bea, 'stockpile.pilfer').taken);
    const present = [v.lead, v.cal, v.eve, v.stranger, v.former, v.invited, v.neighbour];
    for (const id of present) assert.ok(!f.heard.get(id)!.some((e) => e.type === 'witness.saw'), 'not sent with the command');
    f.pass(TOLD_BY_MS);
    const saw = { settlementId: v.sid, settlementName: 'Quiet Hold', actor: { id: v.bea, name: 'Bea' }, act: 'stockpile.pilfer', items: taken };
    for (const id of present) {
      const told = f.heard.get(id)!.filter((e) => e.type === 'witness.saw');
      assert.equal(told.length, 1, f.p(id).name);
      assert.deepEqual(told[0].data, saw);
      assert.equal(told[0].ts, f.ok(id, 'witness.log').entries[0].ts, 'at the moment of the act');
      assert.deepEqual(Object.keys(f.ok(id, 'witness.log').entries[0]).sort(), ['act', 'actor', 'items', 'settlementId', 'settlementName', 'ts'], 'no row ids');
    }
    for (const id of [v.bea, v.dan, walker]) {
      assert.deepEqual(f.heard.get(id)!.filter((e) => e.type === 'witness.saw'), [], `${f.p(id).name} was not standing in the region, or is the thief`);
      assert.deepEqual(f.ok(id, 'witness.log').entries, []);
    }
    assert.ok(!f.operator.some((e) => e.type === 'witness.saw'));
    assert.deepEqual(thefts(f)[0].data.witnesses.map((w: any) => w.id).sort(), [...present].sort());

    // A stash: the witness also learns whose, and what was taken from it.
    const grabbed = withOdds({ witness: 1 }, () => f.ok(v.cal, 'stash.pilfer', { ownerId: v.former }).taken);
    const last = f.ok(v.stranger, 'witness.log').entries[0];
    assert.deepEqual([last.act, last.actor.id, last.owner, last.items], ['stash.pilfer', v.cal, { id: v.former, name: 'Former' }, grabbed]);
    assert.equal(f.ok(v.stranger, 'witness.log', { limit: 1 }).entries.length, 1);

    f.pass(8 * 24 * 3600_000);
    f.g.prune();
    assert.deepEqual(f.ok(v.stranger, 'witness.log').entries, [], 'kept about a week');
  } finally { f.g.close(); }
});

test('witnesses: the one who saw it is the only one who knows', () => {
  const f = fake();
  try {
    const v = village(f);
    const present = [v.lead, v.cal, v.eve, v.stranger, v.former, v.invited, v.neighbour];
    let seers: string[] = [];
    let mark = 0;
    // Until some saw it and some did not.
    for (let i = 0; i < 100 && (!seers.length || seers.length === present.length); i++) {
      for (const id of present) f.listen(id);
      withOdds({ witness: 0.5 }, () => f.ok(v.bea, 'stockpile.pilfer', { items: [{ item: 'stone', qty: 1 }] }));
      seers = thefts(f).at(-1)!.data.witnesses.map((w: any) => w.id);
      mark = thefts(f).at(-1)!.ts;
    }
    assert.ok(seers.length && seers.length < present.length);
    f.pass(TOLD_BY_MS);
    for (const id of present) {
      const saw = seers.includes(id);
      assert.equal(f.heard.get(id)!.some((e) => e.type === 'witness.saw'), saw, f.p(id).name);
      assert.equal(f.ok(id, 'witness.log').entries.some((e: any) => e.ts === mark), saw, f.p(id).name);
      if (!saw) assert.doesNotMatch(JSON.stringify(f.heard.get(id)), new RegExp(`${v.bea}|"Bea"`));
    }
  } finally { f.g.close(); }
});

test('watchtower: a partial witness that names who stood at the plot, not whose hand it was', () => {
  const f = fake();
  try {
    const v = village(f);
    const sighted = () => f.ok(v.dan, 'watchtower.log', { limit: 200 }).entries.filter((e: any) => e.move === 'at_pilfer');
    withOdds({ watchtower: 1 }, () => {
      f.ok(v.cal, 'stockpile.pilfer');
      const first = sighted();
      assert.deepEqual(first.map((e: any) => e.playerId).sort(), [v.lead, v.bea, v.cal, v.stranger, v.former].sort(), 'the thief among the others there');
      assert.equal(new Set(first.map((e: any) => e.ts)).size, 1);
      for (const e of first) assert.deepEqual(Object.keys(e).sort(), ['id', 'move', 'name', 'playerId', 'ts'], 'no act and no items');

      f.ok(v.bea, 'stash.pilfer', { ownerId: v.lead });
      const second = sighted().slice(0, first.length);
      assert.deepEqual(second.map((e: any) => e.playerId), first.map((e: any) => e.playerId), 'the same order, whoever stole');
      assert.equal(f.no(v.stranger, 'watchtower.log').code, 'SETTLEMENT_STATE');
      assert.deepEqual(f.ok(v.neighbour, 'watchtower.log').entries, [], 'it watches only its own plot');

      v.s().buildings.find((b) => b.id === 'watchtower')!.unpaid = true;
      f.save();
      f.ok(v.cal, 'stockpile.pilfer');
      assert.equal(sighted().length, 2 * first.length, 'a closed tower sees nothing');
    });
  } finally { f.g.close(); }
});

test('traces: they name the culprit to members, and the lock makes them likelier', () => {
  const f = fake();
  try {
    const v = village(f);
    const traces = () => logOf(f, v.dan).filter((e) => e.action === 'traces');
    withOdds({ tracesLocked: 1 }, () => {
      f.listen(v.eve);
      f.listen(v.stranger);
      const { taken } = f.ok(v.cal, 'stockpile.pilfer');
      const [entry] = traces();
      assert.deepEqual([entry.actorId, entry.actorName, entry.items], [v.cal, 'Cal', taken]);
      const named = f.heard.get(v.eve)!.find((e) => e.data.entry?.action === 'traces')!;
      assert.equal(named.data.entry.actorId, v.cal);
      assert.deepEqual(f.heard.get(v.stranger), [], 'members only');
      const missing = logOf(f, v.dan).find((e) => e.action === 'missing');
      assert.equal(missing.actorId, null, 'missing still names nobody');

      f.ok(v.cal, 'stash.pilfer', { ownerId: v.lead });
      assert.equal(traces().length, 1, 'stashes are never in the log');
      v.s().buildings.find((b) => b.id === 'storehouse')!.unpaid = true;
      f.save();
      f.ok(v.cal, 'stockpile.pilfer');
      assert.equal(traces().length, 1, 'a closed storehouse locks nothing');
    });

    // With the real odds: both leave some, the lock clearly more.
    const rate = (locked: boolean) => {
      const b = v.s().buildings.find((x) => x.id === 'storehouse')!;
      if (locked) delete b.unpaid; else b.unpaid = true;
      const before = thefts(f).length;
      for (let i = 0; i < 400; i++) {
        v.s().stockpile.stone = 100;
        f.ok(v.cal, 'stockpile.pilfer', { items: [{ item: 'stone', qty: 1 }] });
      }
      return thefts(f).slice(before).filter((e) => e.data.traces).length;
    };
    const open = rate(false), locked = rate(true);
    assert.ok(open > 0 && locked > open * 1.5, `${open} without the lock, ${locked} with it`);
  } finally { f.g.close(); }
});

test('the rolls stay out of the world\'s random stream', () => {
  const f = fake();
  try {
    const v = village(f);
    let drawn = 0;
    const rng = f.g.rng;
    (f.g as any).rng = () => { drawn++; return rng(); };
    withOdds({ witness: 0.5, watchtower: 0.5, tracesLocked: 0.5 }, () => {
      f.ok(v.bea, 'stockpile.pilfer');
      f.ok(v.bea, 'stash.pilfer', { ownerId: v.lead });
    });
    assert.equal(drawn, 0);
  } finally { f.g.close(); }
});

test('stash: a blind grab of one kind, from members and from what former members left', () => {
  const f = fake();
  try {
    const v = village(f);
    withOdds({}, () => {
      const logged = logOf(f, v.dan).length;
      assert.deepEqual(f.ok(v.bea, 'stash.pilfer', { ownerId: v.lead }).taken, [{ item: 'iron_bar', qty: 468 }]);
      assert.equal(v.s().stashes[v.lead].iron_bar, 1873 - 468);
      assert.deepEqual(f.ok(v.bea, 'stash.pilfer', { ownerId: v.former }).taken, [{ item: 'leather', qty: 182 }]);
      assert.deepEqual(f.ok(v.former, 'stash.view').stashes[0].items, [{ item: 'leather', qty: 549 }], 'the owner finds out by looking');
      assert.equal(logOf(f, v.dan).length, logged, 'no audit entry');

      // Blind: asking for something gets no say in it, so it is no probe either.
      v.s().stashes[v.lead] = { iron_bar: 100 };
      f.save();
      assert.deepEqual(f.ok(v.bea, 'stash.pilfer', { ownerId: v.lead, items: [{ item: SWORD_A, qty: 1 }] }).taken, [{ item: 'iron_bar', qty: 25 }]);
      const kinds = new Set<string>();
      for (let i = 0; i < 60; i++) {
        v.s().stashes[v.lead] = { iron_bar: 40, [SWORD_A]: 1, silver: 8 };
        f.save();
        const { taken } = f.ok(v.bea, 'stash.pilfer', { ownerId: v.lead });
        assert.equal(taken.length, 1, 'one kind per grab');
        assert.equal(taken[0].qty, ({ iron_bar: 10, [SWORD_A]: 1, silver: 2 } as any)[taken[0].item]);
        kinds.add(taken[0].item);
      }
      assert.equal(kinds.size, 3, 'any of them');

      v.s().stashes[v.lead] = { [SWORD_A]: 1 };
      f.save();
      f.ok(v.bea, 'stash.pilfer', { ownerId: v.lead });
      assert.equal(v.s().stashes[v.lead], undefined, 'emptied, like a withdrawal that empties it');

      // No stash, an emptied one, and someone who was never here cost and answer alike.
      const answers = [v.lead, v.eve, v.neighbour].map((ownerId) => {
        const { taken, busyMs } = f.ok(v.bea, 'stash.pilfer', { ownerId });
        return { taken, busyMs };
      });
      assert.deepEqual(answers, Array(3).fill({ taken: [], busyMs: TIMING.pilferMs }));
      assert.equal(f.no(v.bea, 'stash.pilfer', { ownerId: v.bea }).code, 'BAD_REQUEST');
      assert.equal(f.no(v.bea, 'stash.pilfer', { ownerId: 'p_000000000000' }).code, 'NOT_FOUND');
      assert.equal(f.no(v.bea, 'stash.pilfer', { ownerId: '__proto__' }).code, 'NOT_FOUND');

      v.s().buildings.find((b) => b.id === 'huts')!.unpaid = true;
      f.save();
      assert.ok(f.ok(v.bea, 'stash.pilfer', { ownerId: v.former }).taken.length, 'closed huts still hold what is in them');
      v.s().buildings = v.s().buildings.filter((b) => b.id !== 'huts');
      f.save();
      assert.equal(f.no(v.bea, 'stash.pilfer', { ownerId: v.former }).code, 'SETTLEMENT_STATE');
    });
  } finally { f.g.close(); }
});

test('shared work: theft drops given units, whoever steals, and loot put back gives nothing', () => {
  const f = fake();
  try {
    const v = village(f);
    const covered = () => Object.values(v.s().work).flatMap((w) => w.given.copper_ore ?? []).reduce((n, lot) => n + lot.qty, 0);
    const givenBy = (id: string) => (v.s().work[id]?.given.copper_ore ?? []).reduce((n, lot) => n + lot.qty, 0);
    withOdds({}, () => {
      assert.equal(covered(), 120);
      const { taken } = f.ok(v.bea, 'stockpile.pilfer', { items: [{ item: 'copper_ore', qty: 30 }] });
      assert.equal(covered(), 90);
      assert.deepEqual([givenBy(v.bea), givenBy(v.lead), givenBy(v.cal)], [40, 40, 10], 'the youngest, not the thief\'s own');

      assert.deepEqual(f.ok(v.bea, 'stockpile.deposit', { items: taken }).given, [], 'putting it back gives nothing');
      assert.equal(covered(), 90);
      assert.equal(v.s().stockpile.copper_ore, 120);

      // Around and around: cover never comes back, and never exceeds what lies there.
      let least = covered();
      for (let i = 0; i < 30; i++) {
        const thief = [v.bea, v.cal, v.lead][i % 3];
        const loot = f.ok(thief, 'stockpile.pilfer', { items: [{ item: 'copper_ore', qty: 1 + (i % 30) }] }).taken;
        assert.ok(covered() <= v.s().stockpile.copper_ore);
        if (i % 2) assert.deepEqual(f.ok(thief, 'stockpile.deposit', { items: loot }).given, []);
        assert.ok(covered() <= least, 'loot laundered into shared work');
        least = covered();
        if (v.s().stockpile.copper_ore < 124) v.s().stockpile.copper_ore += 60; // somebody's bought ore
      }

      // From a stash it was never cover, and earns none.
      v.s().stashes[v.lead] = { pine_log: 80 };
      f.save();
      const logs = f.ok(v.cal, 'stash.pilfer', { ownerId: v.lead }).taken;
      assert.deepEqual(f.ok(v.cal, 'stockpile.deposit', { items: logs }).given, []);
    });
  } finally { f.g.close(); }
});

test('upkeep: a reserve of two intervals stands one theft, a bare one closes at the next interval', () => {
  for (const [intervals, stands] of [[2, true], [1, false]] as const) {
    const f = fake();
    try {
      const v = village(f);
      v.s().buildings = v.s().buildings.filter((b) => b.id === 'workshop');
      v.s().stockpile = Object.fromEntries(BUILDINGS.workshop.upkeep.map((i) => [i.item, i.qty * intervals]));
      f.save();
      withOdds({}, () => f.ok(v.bea, 'stockpile.pilfer'));
      assert.ok(!v.s().buildings[0].unpaid, 'nothing closes before the interval');
      f.pass(6 * 60_000);
      assert.equal(!v.s().buildings[0].unpaid, stands, `${intervals} intervals in reserve`);
    } finally { f.g.close(); }
  }
});

// ---------- secrecy: twins ----------

/** One saved world, and as many identical copies of it as a test needs. */
function twins() {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-theft-'));
  const base = fake({ dbPath: join(dir, 'base.db') });
  const v: Village = village(base);
  const clock = base.now();
  base.g.close();
  let n = 0;
  const copy = () => {
    const dbPath = join(dir, `twin${++n}.db`);
    copyFileSync(join(dir, 'base.db'), dbPath);
    return { dbPath, f: fake({ dbPath }, clock, 't') };
  };
  return { v, copy, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Ids drawn at random by the probing commands themselves. */
const sameIds = (x: unknown) => JSON.parse(JSON.stringify(x ?? null).replace(/\b(t|party|motion|bag|stl)_[0-9a-f]{12}\b/g, '$1_x'));

/**
 * Everything `watchers` can learn after `act`: every event they get, every read command, every mutating command, the
 * next upkeep tick, and what they read after a restart.
 */
function learned(copy: ReturnType<typeof twins>['copy'], v: Village, watchers: string[], act: (f: Fake) => unknown, odds: Odds = {}) {
  const { dbPath, f: first } = copy();
  let f = first;
  const seen: Record<string, unknown> = {};
  try {
    withOdds(odds, () => {
      // Both possible thieves are active either way: being online is no part of the secret.
      for (const id of [v.bea, v.cal]) f.ok(id, 'observe');
      f.pass(50);
      for (const id of watchers) f.listen(id);
      seen.result = act(f);
      f.pass(50);
      // First as it stands: everything below clears busy times to get through.
      for (const id of watchers) seen[`${id} right after`] = f.raw(id, 'observe');

      const pos = new Map(watchers.map((id) => [id, { ...f.p(id).pos }]));
      const base = {
        settlementId: v.sid, id: v.sid, playerId: v.dan, targetId: v.dan, ownerId: v.lead, to: v.dan, with: v.dan, kind: 'exile', name: 'Probe',
        channel: 'zone:hollow', building: 'palisade', recipeId: 'copper_bar', item: SWORD_A, text: 'hello', title: 'hello', body: 'hello',
        questId: 'wolf_cull', items: [{ item: 'stone', qty: 1 }],
      };
      const payloads = [{}, base, { ...base, playerId: v.bea }, { ...base, playerId: v.cal }, { limit: 200 }];
      const types = Object.keys(f.g.commands);
      const reads = types.filter((t) => !f.g.commands[t].mutates);
      for (const id of watchers) {
        for (const type of reads) payloads.forEach((payload, i) => { seen[`${id} ${type} ${i}`] = f.run(id, type, payload); });
      }
      // Members don't probe by pilfering, which is random. Leaving comes last.
      const writes = [...types.filter((t) => f.g.commands[t].mutates && t !== 'settlement.leave'), 'settlement.leave'];
      for (const id of watchers) {
        const member = !!f.p(id).settlementId;
        for (const type of writes) {
          if (member && type.endsWith('.pilfer')) continue;
          const r = f.run(id, type, base);
          assert.notEqual(r.error?.code, 'RATE_LIMITED', `${type} was not really tried`);
          assert.notEqual(r.error?.code, 'INTERNAL', type);
          seen[`${id} ${type}`] = r;
          f.put(id, pos.get(id)!);
        }
      }
      f.pass(10 * 60_000);
      for (const id of watchers) seen[`${id} events`] = f.heard.get(id);

      f.save();
      const clock = f.now();
      f.g.close();
      f = fake({ dbPath }, clock, 'r');
      for (const id of watchers) {
        for (const type of reads) seen[`${id} ${type} after a restart`] = f.run(id, type, base);
      }
    });
    return sameIds(seen) as Record<string, any>;
  } finally { f.g.close(); }
}

/** The same, key by key, so a leak says where it is. */
function assertSame(a: Record<string, any>, b: Record<string, any>, why: string, skip: string[] = []) {
  assert.deepEqual(Object.keys(a), Object.keys(b), why);
  for (const key of Object.keys(a)) if (!skip.includes(key)) assert.deepEqual(a[key], b[key], `${why}: ${key}`);
}

/** Without event ids, whose gaps only say that something hidden happened somewhere. */
function withoutIds(seen: Record<string, any>) {
  const out = { ...seen };
  for (const key of Object.keys(out)) {
    if (key.endsWith(' events')) out[key] = out[key].map(({ id, ...rest }: GameEvent) => rest);
  }
  return out;
}

const steal = (thief: string) => (f: Fake) => void f.ok(thief, 'stockpile.pilfer');
const grab = (thief: string, owner: string) => (f: Fake) => void f.ok(thief, 'stash.pilfer', { ownerId: owner });
const idle = (who: string) => (f: Fake) => void f.ok(who, 'observe');

test('secrecy: who stole from the stockpile changes nothing anyone can see', () => {
  const t = twins();
  try {
    const { v } = t;
    const watchers = [v.lead, v.eve, v.dan, v.stranger, v.former, v.invited, v.neighbour];
    const bea = learned(t.copy, v, watchers, steal(v.bea));
    assert.ok(JSON.stringify(bea[`${v.eve} stockpile.log 4`]).includes('"missing"'), 'the twins do hold a theft');
    assert.ok(bea[`${v.lead} events`].length > 0);
    assertSame(bea, learned(t.copy, v, watchers, steal(v.cal)), 'Bea or Cal');
  } finally { t.done(); }
});

test('secrecy: who robbed a stash changes nothing anyone can see, the owner included', () => {
  const t = twins();
  try {
    const { v } = t;
    const watchers = [v.lead, v.eve, v.dan, v.stranger, v.former, v.invited, v.neighbour];
    for (const owner of [v.lead, v.former]) {
      assertSame(learned(t.copy, v, watchers, grab(v.bea, owner)), learned(t.copy, v, watchers, grab(v.cal, owner)), 'Bea or Cal');
    }
  } finally { t.done(); }
});

test('secrecy: outsiders cannot tell a theft happened', () => {
  const t = twins();
  try {
    const { v } = t;
    const watchers = [v.stranger, v.former, v.invited, v.neighbour];
    const quiet = withoutIds(learned(t.copy, v, watchers, idle(v.bea)));
    assertSame(quiet, withoutIds(learned(t.copy, v, watchers, steal(v.bea))), 'a stockpile theft');
    assertSame(quiet, withoutIds(learned(t.copy, v, watchers, grab(v.bea, v.lead))), 'a stash theft');
    const open = { traces: 1, tracesLocked: 1, watchtower: 1 };
    assertSame(quiet, withoutIds(learned(t.copy, v, watchers, steal(v.bea), open)), 'a theft with every trace');
  } finally { t.done(); }
});

test('secrecy: a stash theft shows no member the theft, or the stash', () => {
  const t = twins();
  try {
    const { v } = t;
    const others = [v.eve, v.dan, v.cal];
    assertSame(withoutIds(learned(t.copy, v, others, idle(v.bea))), withoutIds(learned(t.copy, v, others, grab(v.bea, v.lead))), 'a stash theft');
    // Something, or nothing: not even the ids differ.
    const everyone = [...others, v.stranger, v.invited, v.neighbour];
    assertSame(learned(t.copy, v, everyone, grab(v.bea, v.lead)), learned(t.copy, v, everyone, grab(v.bea, v.eve)), 'a full stash or none');
  } finally { t.done(); }
});

test('secrecy: the thief learns nothing of witnesses, and nor does anyone who saw nothing', () => {
  const t = twins();
  try {
    const { v } = t;
    // Dan is away. Everyone else present sees it when the chance is 1.
    const watchers = [v.bea, v.dan];
    for (const act of ['stockpile.pilfer', 'stash.pilfer']) {
      const go = (f: Fake) => f.ok(v.bea, act, act === 'stash.pilfer' ? { ownerId: v.lead } : {});
      const unseen = learned(t.copy, v, watchers, go);
      assertSame(unseen, learned(t.copy, v, watchers, go, { witness: 1 }), `${act}, unseen or seen by all`);
      assert.deepEqual(Object.keys(unseen.result).sort(), ['busyMs', 'inventory', 'taken'], 'nothing in the result');
    }
  } finally { t.done(); }
});

test('secrecy: a pilfer does the same work whether anyone saw it or not, so the clock tells the thief nothing', () => {
  /** Everything a command does that takes time with the world waiting: the queries it runs, how much they write and where, and the streams it writes. */
  const work = (act: 'stockpile.pilfer' | 'stash.pilfer', witness: number) => {
    const f = fake();
    try {
      const v = village(f);
      const done: string[] = [];
      const streaming = [v.lead, v.bea, v.cal, v.eve, v.stranger, v.former, v.invited, v.neighbour];
      for (const id of streaming) f.g.subscribe({ kind: 'player', playerId: id, send: (e) => done.push(`send ${streaming.indexOf(id)} ${e.type}`) });
      f.g.subscribe({ kind: 'operator', send: (e) => done.push(`operator ${e.type}`) });
      const run = f.g.store.run.bind(f.g.store);
      f.g.store.run = ((sql: string, ...args: any[]) => {
        // Names differ by run, not in length. Where a sighting lands in the index is the player's id.
        done.push(`${sql} ${JSON.stringify(args).length}${sql.includes('INTO sightings') ? ` ${Object.values(v).indexOf(args[1])}` : ''}`);
        return run(sql, ...args);
      }) as typeof f.g.store.run;
      // An empty stash: a random pick from a full one would change the lengths by itself.
      withOdds({ witness }, () => f.ok(v.bea, act, act === 'stash.pilfer' ? { ownerId: v.dan } : {}));
      const during = done.splice(0);
      f.pass(TOLD_BY_MS);
      return { during, told: done.filter((x) => x.endsWith('witness.saw')).length };
    } finally { f.g.close(); }
  };
  for (const act of ['stockpile.pilfer', 'stash.pilfer'] as const) {
    const unseen = work(act, 0);
    const seen = work(act, 1);
    assert.ok(unseen.during.some((x) => x.includes('INSERT INTO sightings')), 'bystanders who saw nothing cost a row too');
    assert.deepEqual(seen.during, unseen.during, act);
    assert.equal(unseen.told, 0, 'the stand-ins reach nobody');
    assert.ok(seen.told >= 7, 'the real ones follow on a later tick');
  }
});

test('secrecy: traces and the watchtower show only in the logs members read', () => {
  const t = twins();
  try {
    const { v } = t;
    const go = (f: Fake) => f.ok(v.bea, 'stockpile.pilfer');
    for (const odds of [{ traces: 1, tracesLocked: 1 }, { watchtower: 1 }]) {
      const watchers = [v.stranger, v.former, v.invited, v.neighbour];
      // Ids included: those of events and those in the neighbour's own logs.
      assertSame(learned(t.copy, v, watchers, go), learned(t.copy, v, watchers, go, odds), Object.keys(odds)[0]);
    }
    // The thief reads them where any member can, and nowhere else.
    const plain = learned(t.copy, v, [v.bea], go);
    const marked = learned(t.copy, v, [v.bea], go, { traces: 1, tracesLocked: 1, watchtower: 1 });
    const readable = new RegExp(`^${v.bea} (stockpile\\.(log|view)|watchtower\\.log)( |$)|^${v.bea} events$`);
    assertSame(plain, marked, 'the thief', Object.keys(plain).filter((key) => readable.test(key)));
    const types = (seen: Record<string, any>) => new Set(seen[`${v.bea} events`].map((e: GameEvent) => e.type));
    assert.deepEqual(types(marked), types(plain), 'no event of their own for it');
  } finally { t.done(); }
});

test('secrecy: a pilfer spends the same event ids whatever the evidence came to', () => {
  const f = fake();
  try {
    const v = village(f);
    f.listen(v.dan);
    f.listen(v.stranger);
    const spent = (type: string, payload: object, odds: Odds) => {
      const before = f.g.mutate(() => f.g.emit('quest', { kind: 'operator' }, {}).id);
      withOdds(odds, () => f.ok(v.bea, type, payload));
      return f.g.mutate(() => f.g.emit('quest', { kind: 'operator' }, {}).id) - before - 1;
    };
    const all = { witness: 1, watchtower: 1, traces: 1, tracesLocked: 1 };
    for (const odds of [{}, { witness: 1 }, { watchtower: 1 }, { traces: 1, tracesLocked: 1 }, all]) {
      assert.equal(spent('stockpile.pilfer', {}, odds), 3, JSON.stringify(odds));
      assert.equal(spent('stash.pilfer', { ownerId: v.lead }, odds), 1, JSON.stringify(odds));
      assert.equal(spent('stash.pilfer', { ownerId: v.eve }, odds), 1, `empty ${JSON.stringify(odds)}`);
    }
  } finally { f.g.close(); }
});

// ---------- persistence ----------

test('log entries count per settlement, and rows from before that keep their ids', () => {
  const f = fake();
  try {
    const v = village(f);
    const old = (sid: string, action: string, ts: number) => Number(f.g.store.run('INSERT INTO stockpile_log(settlement_id, ts, action, items) VALUES(?, ?, ?, ?)', sid, ts, action, '[]').lastInsertRowid);
    const oldWatch = (sid: string) => Number(f.g.store.run('INSERT INTO watch_log(settlement_id, ts, player_id, name, move) VALUES(?, ?, ?, ?, ?)', sid, f.now(), v.eve, 'Eve', 'arrive').lastInsertRowid);
    old(v.otherSid, 'income', 1);
    const kept = [old(v.sid, 'income', 2), old(v.sid, 'upkeep', 3)];
    oldWatch(v.otherSid);
    const keptWatch = oldWatch(v.sid);
    withOdds({ watchtower: 1 }, () => {
      f.ok(v.bea, 'stockpile.pilfer');
      const log = logOf(f, v.dan);
      assert.deepEqual(log.map((e) => e.id), [kept[1] + 1, kept[1], kept[0]]);
      assert.deepEqual(f.ok(v.dan, 'stockpile.log', { beforeId: kept[1], limit: 5 }).entries.map((e: any) => e.id), [kept[0]]);
      const watch = f.ok(v.dan, 'watchtower.log').entries.map((e: any) => e.id);
      assert.deepEqual(watch, [5, 4, 3, 2, 1, 0].map((n) => keptWatch + n));
      assert.deepEqual(f.ok(v.dan, 'watchtower.log', { beforeId: keptWatch + 1 }).entries.map((e: any) => e.id), [keptWatch]);
      f.pass(8 * 24 * 3600_000);
      f.g.prune();
      f.ok(v.bea, 'stash.pilfer', { ownerId: v.lead });
      const fresh = f.ok(v.dan, 'watchtower.log').entries.map((e: any) => e.id);
      assert.ok(fresh.length && Math.min(...fresh) > watch[0], 'pruning reuses no id');
    });
  } finally { f.g.close(); }
});

test('a failed write leaves goods, evidence and events as they were', () => {
  const f = fake({ log: () => {} });
  try {
    const v = village(f);
    const witnesses = [v.lead, v.eve, v.stranger];
    withOdds({ witness: 1, watchtower: 1, tracesLocked: 1 }, () => {
      for (const [type, payload] of [['stockpile.pilfer', {}], ['stash.pilfer', { ownerId: v.lead }]] as const) {
        for (const broken of ['INSERT INTO sightings', 'INSERT INTO watch_log', 'UPDATE players', 'INSERT INTO settlements', 'INSERT INTO commands']) {
          f.save();
          for (const id of witnesses) f.listen(id);
          const count = (table: string) => f.g.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
          const state = () => ({
            settlement: structuredClone(v.s()), inventory: { ...f.p(v.bea).inventory }, thefts: thefts(f).length,
            rows: [count('sightings'), count('watch_log'), count('stockpile_log'), f.g.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'theft'")!.n],
          });
          const before = state();
          const run = f.g.store.run.bind(f.g.store);
          f.g.store.run = ((sql: string, ...args: any[]) => {
            if (sql.startsWith(broken)) throw new Error('disk full');
            return run(sql, ...args);
          }) as typeof f.g.store.run;
          try {
            assert.equal(f.run(v.bea, type, payload).error?.code, 'INTERNAL', `${type}: ${broken}`);
          } finally { f.g.store.run = run; }
          assert.deepEqual(state(), before, `${type}: ${broken}`);
          for (const id of witnesses) assert.deepEqual(f.heard.get(id), [], 'nothing was dispatched');
          f.pass(TOLD_BY_MS);
          for (const id of witnesses) assert.ok(!f.heard.get(id)!.some((e) => e.type === 'witness.saw'), 'or queued');
        }
      }
    });
  } finally { f.g.close(); }
});

test('a restart keeps the evidence, and a retried command steals once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-theft-'));
  let f = fake({ dbPath: join(dir, 'world.db') });
  try {
    const v = village(f);
    const payload = { commandId: 'heist-1', type: 'stockpile.pilfer', payload: {} };
    const first: any = withOdds({ witness: 1, watchtower: 1, tracesLocked: 1 }, () => f.g.execute(v.bea, payload));
    assert.ok(first.ok);
    const pile = { ...v.s().stockpile };
    const clock = f.now();
    f.g.close();
    f = fake({ dbPath: join(dir, 'world.db') }, clock, 'r');
    const again: any = f.g.execute(v.bea, payload);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, first.result);
    assert.deepEqual(f.g.settlements.get(v.sid)!.stockpile, pile, 'stolen once');
    assert.equal(f.ok(v.stranger, 'witness.log').entries.length, 1);
    assert.deepEqual(logOf(f, v.dan).slice(0, 2).map((e) => e.action), ['traces', 'missing']);
    assert.ok(f.ok(v.dan, 'watchtower.log').entries.some((e: any) => e.move === 'at_pilfer'));
    assert.ok(operatorState(f.g, 0).events.some((e) => e.type === 'theft' && e.actorId === v.bea));
  } finally {
    f.g.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sightings saved before bystanders got rows still read as seen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noibla-theft-'));
  let f = fake({ dbPath: join(dir, 'world.db') });
  try {
    const v = village(f);
    withOdds({ witness: 1 }, () => f.ok(v.bea, 'stockpile.pilfer'));
    const before = f.ok(v.stranger, 'witness.log').entries;
    f.g.store.db.exec('ALTER TABLE sightings DROP COLUMN seen');
    const clock = f.now();
    f.g.close();
    f = fake({ dbPath: join(dir, 'world.db') }, clock, 'r');
    assert.equal(before.length, 1);
    assert.deepEqual(f.ok(v.stranger, 'witness.log').entries, before);
  } finally {
    f.g.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- over HTTP ----------

test('SDK: pilfer, see and read over the real event stream', async () => {
  const w = await world();
  const real = { ...CRIME_ODDS };
  try {
    Object.assign(CRIME_ODDS, NOTHING, { witness: 1 });
    const g = w.server.game;
    const [boss, thief, away] = [await w.bot('Chief'), await w.bot('Pincher'), await w.bot('Away')];
    const [B, T] = await Promise.all([boss, thief].map(async (b) => (await b.whoami()).playerId));
    const plot = g.map.plots.find((pl) => pl.region === 'hollow')!;
    for (const id of [B, T]) Object.assign(g.players.get(id)!, { pos: { x: plot.x, y: plot.y }, zone: plot.region, travel: null });
    Object.assign(g.players.get(B)!.inventory, bag(SETTLEMENT.foundCost));
    const { settlement } = await boss.settlementFound('Open Hold', plot.id);
    await boss.settlementInvite(T);
    await thief.settlementJoin(settlement.id);
    g.mutate(() => {
      const s = g.settlements.get(settlement.id)!;
      g.markSettlement(s);
      s.stockpile = { stone: 400 };
      s.stashes[B] = { iron_bar: 8 };
      s.buildings.push({ id: 'huts', builtAt: g.now(), paidUntil: g.now() + 3600_000 });
    });

    const seen = boss.waitForEvent((e) => e.type === 'witness.saw', 5000);
    assert.deepEqual((await thief.stockpilePilfer([{ item: 'stone', qty: 100 }])).taken, [{ item: 'stone', qty: 100 }]);
    assert.equal((await seen).data.actor.id, T);
    await thief.waitReady();
    assert.deepEqual((await thief.stashPilfer(B)).taken, [{ item: 'iron_bar', qty: 2 }]);

    const { entries } = await boss.witnessLog();
    assert.deepEqual(entries.map((e) => e.act), ['stash.pilfer', 'stockpile.pilfer']);
    assert.deepEqual((await thief.witnessLog()).entries, []);
    assert.deepEqual((await away.witnessLog()).entries, []);
    const missing = (await boss.stockpileLog()).entries.find((e) => e.action === 'missing')!;
    assert.equal(missing.actorId, null);
    for (const bot of [thief, away]) assert.ok(!bot.received.some((e) => e.type === 'witness.saw' || e.type === 'theft'));
    assert.ok(!boss.received.some((e) => e.type === 'theft'), 'operator only');
    const op = (await w.operator()).events.filter((e: any) => e.type === 'theft');
    assert.deepEqual(op.map((e: any) => [e.data.act, e.data.actor.id]), [['stockpile.pilfer', T], ['stash.pilfer', T]]);
  } finally {
    Object.assign(CRIME_ODDS, real);
    await w.close();
  }
});
