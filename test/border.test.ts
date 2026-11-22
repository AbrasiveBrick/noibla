// A mob only fights players in its own region, so a player may only attack it from there. Standing just across a
// region border (within interaction range) used to give free hits: the mob never hit back and healed up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_RULES, dist, regionAt, type Pos } from '../src/shared/map.ts';
import { Game } from '../src/server/game.ts';

function setup() {
  let now = 1_000_000;
  let seq = 0;
  const g = new Game({ dbPath: ':memory:', now: () => now, seed: 1, mapSeed: 7, log: (line) => assert.fail(line) });
  const send = (id: string, type: string, payload: object = {}) => g.execute(id, { commandId: `c${++seq}`, type, payload }) as any;
  // Two walkable tiles within interaction range of each other on either side of the wilds / hollow border.
  const mobSide: Pos = { x: 30, y: 8 }, farSide: Pos = { x: 30, y: 7 };
  assert.equal(regionAt(g.map, mobSide), 'wilds');
  assert.equal(regionAt(g.map, farSide), 'hollow');
  assert.ok(dist(mobSide, farSide) <= MAP_RULES.range.interact);
  const place = (id: string, pos: Pos) => {
    const p = g.players.get(id)!;
    Object.assign(p, { pos: { ...pos }, zone: regionAt(g.map, pos), travel: null, busyUntil: 0 });
    p.hp = g.maxHp(p);
    return p;
  };
  const putMob = (type: string, pos: Pos) => {
    const m = [...g.mobs.values()].find((x) => x.type === type && x.zone === 'wilds')!;
    Object.assign(m, { x: pos.x, y: pos.y, home: { ...pos } });
    return m;
  };
  return { g, send, place, putMob, mobSide, farSide, step: (ms = 25) => { now += ms; g.tick(); } };
}

for (const type of ['boar', 'elder_bear']) {
  test(`a ${type} cannot be attacked from across a region border`, () => {
    const s = setup();
    try {
      const mob = s.putMob(type, s.mobSide);
      const across = reg(s, 'Across');
      const inside = reg(s, 'Inside');
      s.place(across, s.farSide);
      s.place(inside, s.mobSide);
      const hpBefore = mob.hp;

      const r = s.send(across, 'attack', { targetId: mob.id });
      assert.equal(r.ok, false, 'the free hit across the border must be refused');
      assert.equal(r.error.code, 'WRONG_ZONE');
      assert.match(r.error.message, /wilds/);
      assert.match(r.error.hint, /travelTo\('wilds'\)/);
      assert.equal(mob.hp, hpBefore, 'the mob took no damage');
      assert.deepEqual(mob.aggro, {}, 'the attempt gave no aggro');
      assert.equal(s.g.players.get(across)!.combatLockUntil, 0, 'a refused attack does not start a combat lock');

      // From inside the region the same attack works, and the mob fights back.
      const hit = s.send(inside, 'attack', { targetId: mob.id });
      assert.ok(hit.ok, hit.error?.message);
      assert.ok(mob.hp < hpBefore);
      const insideHp = s.g.players.get(inside)!.hp;
      for (let i = 0; i < 200 && s.g.players.get(inside)!.hp === insideHp; i++) s.step();
      assert.ok(s.g.players.get(inside)!.hp < insideHp, 'the mob hits back at the player in its region');
    } finally { s.g.close(); }
  });
}

test('a boss cannot be hit from across the border, so a hitter there never escapes its area attack', () => {
  const s = setup();
  try {
    const boss = s.putMob('elder_bear', s.mobSide);
    const across = reg(s, 'Across');
    s.place(across, s.farSide);
    const refused = s.send(across, 'attack', { targetId: boss.id });
    assert.equal(refused.error?.code, 'WRONG_ZONE');
    assert.equal(boss.aggro[across], undefined, 'the player across the border is not on the boss\'s aggro list');
    assert.equal(boss.engagedAt, undefined, 'the attempt does not engage the boss');
  } finally { s.g.close(); }
});

test('buffs and PvP are unchanged next to a border', () => {
  const s = setup();
  try {
    const a = reg(s, 'Alice'), b = reg(s, 'Bobby');
    s.place(a, { x: 30, y: 4 });
    s.place(b, { x: 30, y: 5 });
    const hit = s.send(a, 'attack', { targetId: b });
    assert.ok(hit.ok, hit.error?.message);
    // A buff has no target: a player across the border from a mob can still use it.
    const p = s.place(a, s.farSide);
    s.putMob('boar', s.mobSide);
    p.inventory['leather_jerkin'] = 1;
    assert.ok(s.send(a, 'equip', { item: 'leather_jerkin' }).ok);
    const buff = s.send(a, 'observe').result.self.abilities.find((x: any) => x.kind === 'buff');
    assert.ok(buff, 'leather jerkin grants a buff');
    const used = s.send(a, 'ability.use', { ability: buff.id });
    assert.ok(used.ok, used.error?.message);
  } finally { s.g.close(); }
});

function reg(s: ReturnType<typeof setup>, name: string): string { return s.g.register(name).playerId; }
