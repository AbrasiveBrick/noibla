// Boss balance, simulated on the real rules with a fake clock: whole fights take milliseconds and are deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AFFIXES, MOB_TYPES, UNIQUE_SEP, itemDef, type AbilityId } from '../src/shared/catalog.ts';
import { Game } from '../src/server/game.ts';
import { AFFIX_RANGES } from '../src/server/odds.ts';

interface Build { weapon?: string; armor?: string; level: number; perfectAffixes?: boolean }
const BUILDS = {
  fresh: { level: 0 },
  t1: { weapon: 'copper_sword', armor: 'leather_jerkin', level: 3 },
  t2: { weapon: 'iron_sword', armor: 'iron_mail', level: 0 },
  t2Veteran: { weapon: 'iron_sword', armor: 'iron_mail', level: 30 },
  t3: { weapon: 'duskiron_sword', armor: 'wraithhide_armor', level: 0 },
  t3Skilled: { weapon: 'duskiron_sword', armor: 'wraithhide_armor', level: 10 },
  t3Veteran: { weapon: 'duskiron_sword', armor: 'wraithhide_armor', level: 30 },
  // The strongest player the rules allow: best gear, every combat affix at its maximum, capped damage skill.
  maxed: { weapon: 'duskiron_sword', armor: 'wyrmscale_mail', level: 30, perfectAffixes: true },
} satisfies Record<string, Build>;
type BuildId = keyof typeof BUILDS;

/** `never`: attack only. `always`: every buff as soon as it is ready. `timed`: Evade just before a hit, Brace otherwise. */
type Defense = 'never' | 'always' | 'timed';
const DEFENSES: Defense[] = ['never', 'always', 'timed'];
const BOSSES = ['elder_bear', 'ash_wyrm'];

function setup(type: string, team: BuildId[]) {
  let now = 1_000_000;
  let seq = 0;
  const g = new Game({ dbPath: ':memory:', now: () => now, seed: 1, mapSeed: 7, log: (line) => assert.fail(line) });
  const boss = [...g.mobs.values()].find((m) => m.type === type)!;
  const send = (id: string, command: string, payload: object = {}) => g.execute(id, { commandId: `c${++seq}`, type: command, payload }) as any;
  const must = (id: string, command: string, payload: object) => { const r = send(id, command, payload); assert.ok(r.ok, r.error?.message); return r.result; };
  const ids = team.map((_, i) => g.register(`Fighter${i}`).playerId);
  for (const id of ids.slice(1)) must(id, 'party.accept', { partyId: must(ids[0], 'party.invite', { playerId: id }).party.id });
  const placeAtBoss = (id: string) => {
    const p = g.players.get(id)!;
    Object.assign(p, { pos: { x: boss.x, y: boss.y }, zone: boss.zone, travel: null, busyUntil: 0 });
    p.hp = g.maxHp(p);
  };
  team.forEach((name, i) => {
    const b: Build = BUILDS[name];
    const p = g.players.get(ids[i])!;
    for (const base of [b.weapon, b.armor]) {
      if (!base) continue;
      let item = base;
      if (b.perfectAffixes) {
        item = `${base}${UNIQUE_SEP}${i}`;
        const affixes = Object.values(AFFIXES).filter((a) => a.group === 'combat').map((a) => ({ id: a.id, tier: 3, value: AFFIX_RANGES[a.id][2][1] }));
        g.uniques.set(item, { id: item, base, ilvl: 60, rarity: 'rare', affixes, mods: 4, corrupted: false, craftedBy: 'test', craftedAt: now });
      }
      p.inventory[item] = 1;
      must(p.id, 'equip', { item });
    }
    p.focus = ['swords', 'unarmed'];
    p.skills[b.weapon ? 'swords' : 'unarmed'] = 10 * b.level * b.level;
    placeAtBoss(p.id);
  });
  return { g, boss, ids, send, must, placeAtBoss, now: () => now, step: () => { now += 25; g.tick(); } };
}

function fight(type: string, team: BuildId[], defense: Defense = 'timed') {
  const s = setup(type, team);
  try {
    const def = MOB_TYPES[type].boss!;
    const alive = new Set(s.ids);
    const start = s.now();
    let enraged = false;
    while (alive.size) {
      assert.ok(s.now() - start < 180_000, `${team} vs ${type} never ended`);
      for (const id of alive) {
        const p = s.g.players.get(id)!;
        if (p.zone !== s.boss.zone) { alive.delete(id); continue; }
        if (p.busyUntil > s.now()) continue;
        const armor = p.equipment.armor ? itemDef(p.equipment.armor)?.abilities ?? [] : [];
        const ready = (a: AbilityId) => armor.includes(a) && (p.cooldowns[a] ?? 0) <= s.now();
        let buff: AbilityId | undefined;
        if (s.boss.engagedAt !== undefined && defense === 'always') buff = (['brace', 'evade'] as const).find(ready);
        if (s.boss.engagedAt !== undefined && defense === 'timed') {
          if (ready('evade') && s.boss.targetId === id && s.boss.nextAttackAt - s.now() < 2500) buff = 'evade';
          else if (ready('brace') && p.braceUntil <= s.now()) buff = 'brace';
        }
        const r = buff ? s.send(id, 'ability.use', { ability: buff }) : s.send(id, 'attack', { targetId: s.boss.id });
        if (r.ok && r.result.killed) return { won: true, enraged };
      }
      if (s.boss.engagedAt !== undefined && s.now() - s.boss.engagedAt >= s.g.ms(def.enrageAfterMs)) enraged = true;
      s.step();
    }
    return { won: false, enraged };
  } finally { s.g.close(); }
}

test('no lone player can kill a boss, whatever their gear, skill or use of defenses', () => {
  for (const type of BOSSES) {
    for (const build of Object.keys(BUILDS) as BuildId[]) {
      for (const defense of DEFENSES) assert.equal(fight(type, [build], defense).won, false, `${build} (${defense}) soloed the ${type}`);
    }
  }
});

test('small geared groups still kill both bosses', () => {
  const groups: [string, BuildId[]][] = [
    ['elder_bear', ['t2', 't2']],
    ['elder_bear', ['t1', 't1', 't1']],
    ['elder_bear', ['maxed', 't1']],
    ['ash_wyrm', ['t3Skilled', 't3Skilled']],
    ['ash_wyrm', ['t3', 't3', 't3']],
    ['ash_wyrm', ['t2', 't2', 't2', 't2']],
    ['ash_wyrm', ['maxed', 't1']],
  ];
  for (const [type, team] of groups) assert.equal(fight(type, team).won, true, `${team} should beat the ${type}`);
});

test('enrage comes into play in slow fights and not in quick ones', () => {
  assert.deepEqual(fight('elder_bear', ['t2', 't2']), { won: true, enraged: true }, 'a bare duo finishes the bear enraged');
  assert.deepEqual(fight('elder_bear', ['t2', 't2', 't2']), { won: true, enraged: false }, 'a trio beats the timer');
  assert.deepEqual(fight('ash_wyrm', ['t3', 't3']), { won: false, enraged: true }, 'an untrained duo runs out of time');
  assert.deepEqual(fight('ash_wyrm', ['t3', 't3', 't3']), { won: true, enraged: false }, 'a trio beats the timer');
});

test('the per-player damage cap survives dying and coming back, and clears when the fight resets', () => {
  const s = setup('elder_bear', ['maxed', 't1']);
  try {
    const [star, mate] = s.ids;
    const def = MOB_TYPES.elder_bear;
    const cap = Math.floor(def.hp * def.boss!.maxSharePerPlayer);
    const hit = (id: string) => { s.g.players.get(id)!.busyUntil = 0; return s.must(id, 'attack', { targetId: s.boss.id }); };
    hit(mate);
    const afterMate = s.boss.hp;
    let last: any;
    for (let i = 0; i < 100 && afterMate - s.boss.hp < cap; i++) last = hit(star);
    assert.equal(afterMate - s.boss.hp, cap);
    assert.match(last.note, /one player can deal/);

    // Dying drops the star's aggro, but the ally keeps the fight going.
    delete s.boss.aggro[star];
    s.placeAtBoss(star);
    const again = hit(star);
    assert.equal(again.damage, 0);
    assert.equal(again.xp, 0, 'hits past the cap train nothing');
    assert.equal(s.boss.hp, afterMate - cap);

    // Nobody left in the region: the boss heals, and the next fight starts with a clean count.
    for (const id of s.ids) Object.assign(s.g.players.get(id)!, { zone: 'town', pos: { ...s.g.map.spawn } });
    s.step();
    assert.equal(s.boss.hp, def.hp);
    s.placeAtBoss(star);
    assert.ok(hit(star).damage > 0);
  } finally { s.g.close(); }
});
