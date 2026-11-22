// Boss balance, simulated on the real rules with a fake clock: whole fights take milliseconds and are deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AFFIXES, MOB_TYPES, UNIQUE_SEP, itemDef, type AbilityId } from '../src/shared/catalog.ts';
import { Game } from '../src/server/game.ts';
import { AFFIX_RANGES } from '../src/server/odds.ts';

/** `good`: all four combat affixes at the middle of tier 2. `perfect`: all four at the top of tier 3. */
interface Build { weapon?: string; armor?: string; level: number; affixes?: 'good' | 'perfect' }
const BUILDS = {
  fresh: { level: 0 },
  t1: { weapon: 'copper_sword', armor: 'leather_jerkin', level: 3 },
  t2: { weapon: 'iron_sword', armor: 'iron_mail', level: 0 },
  t2Veteran: { weapon: 'iron_sword', armor: 'iron_mail', level: 30 },
  t3: { weapon: 'duskiron_sword', armor: 'wraithhide_armor', level: 0 },
  t3Skilled: { weapon: 'duskiron_sword', armor: 'wraithhide_armor', level: 10 },
  t3Veteran: { weapon: 'duskiron_sword', armor: 'wraithhide_armor', level: 30 },
  t1Veteran: { weapon: 'copper_sword', armor: 'leather_jerkin', level: 30 },
  t3GoodAffixes: { weapon: 'duskiron_sword', armor: 'wraithhide_armor', level: 15, affixes: 'good' },
  bestGearVeteran: { weapon: 'duskiron_sword', armor: 'wyrmscale_mail', level: 30 },
  // Really maxed out: best gear, good affixes, capped damage skill. These may solo a boss.
  nearlyPerfect: { weapon: 'duskiron_sword', armor: 'wyrmscale_mail', level: 30, affixes: 'good' },
  maxed: { weapon: 'duskiron_sword', armor: 'wyrmscale_mail', level: 30, affixes: 'perfect' },
} satisfies Record<string, Build>;
type BuildId = keyof typeof BUILDS;
const MAXED: BuildId[] = ['nearlyPerfect', 'maxed'];

/** `never`: attack only. `always`: every buff as soon as it is ready. `timed`: Evade just before a hit, Brace otherwise. `sdk`: what fight() does, a buff below half HP. */
type Defense = 'never' | 'always' | 'timed' | 'sdk';
const DEFENSES: Defense[] = ['never', 'always', 'timed', 'sdk'];
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
      if (b.affixes) {
        item = `${base}${UNIQUE_SEP}${i}`;
        const affixes = Object.values(AFFIXES).filter((a) => a.group === 'combat').map((a) => {
          const [, [lo, hi], [, top]] = AFFIX_RANGES[a.id];
          return b.affixes === 'perfect' ? { id: a.id, tier: 3, value: top } : { id: a.id, tier: 2, value: Math.floor((lo + hi) / 2) };
        });
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

/** `lagMs`: how late each player acts once ready. */
function fight(type: string, team: BuildId[], defense: Defense = 'timed', lagMs = 0) {
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
        if (p.downed || p.dead) { alive.delete(id); continue; }
        if (p.busyUntil + lagMs > s.now()) continue;
        const armor = p.equipment.armor ? itemDef(p.equipment.armor)?.abilities ?? [] : [];
        const ready = (a: AbilityId) => armor.includes(a) && (p.cooldowns[a] ?? 0) <= s.now();
        let buff: AbilityId | undefined;
        if (s.boss.engagedAt !== undefined && defense === 'always') buff = (['brace', 'evade'] as const).find(ready);
        if (defense === 'sdk' && p.hp < s.g.maxHp(p) / 2) buff = (['evade', 'brace'] as const).find(ready);
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

test('players who are not maxed out cannot solo a boss, however they play', () => {
  for (const type of BOSSES) {
    for (const build of (Object.keys(BUILDS) as BuildId[]).filter((b) => !MAXED.includes(b))) {
      for (const defense of DEFENSES) {
        for (const lag of [0, 100]) assert.equal(fight(type, [build], defense, lag).won, false, `${build} (${defense}, ${lag} ms lag) soloed the ${type}`);
      }
    }
  }
});

test('a really maxed-out player can solo both bosses', () => {
  for (const type of BOSSES) {
    for (const build of MAXED) assert.equal(fight(type, [build], 'timed').won, true, `${build} should solo the ${type}`);
    assert.equal(fight(type, ['maxed'], 'sdk').won, true, `maxed should solo the ${type} with plain fight()`);
  }
});

test('small geared groups still kill both bosses', () => {
  const groups: [string, BuildId[]][] = [
    ['elder_bear', ['t2', 't2', 't2']],
    ['elder_bear', ['t1', 't1', 't1', 't1']],
    ['elder_bear', ['t3', 't3']],
    ['elder_bear', ['maxed', 't1']],
    ['ash_wyrm', ['t3', 't3', 't3']],
    ['ash_wyrm', ['t2', 't2', 't2', 't2']],
    ['ash_wyrm', ['maxed', 't1']],
  ];
  for (const [type, team] of groups) {
    for (const defense of ['timed', 'sdk'] as const) assert.equal(fight(type, team, defense).won, true, `${team} (${defense}) should beat the ${type}`);
  }
  assert.equal(fight('ash_wyrm', ['t3Skilled', 't3Skilled']).won, true, 'a skilled duo that times its defenses beats the wyrm');
});

test('enrage comes into play in slow fights and not in quick ones', () => {
  assert.deepEqual(fight('elder_bear', ['t2', 't2', 't2']), { won: true, enraged: true }, 'a bare trio finishes the bear enraged');
  assert.deepEqual(fight('elder_bear', ['t3Veteran', 't3Veteran', 't3Veteran']), { won: true, enraged: false }, 'a veteran trio beats the timer');
  assert.deepEqual(fight('ash_wyrm', ['t3', 't3']), { won: false, enraged: true }, 'an untrained duo runs out of time');
  assert.deepEqual(fight('ash_wyrm', ['t3', 't3', 't3']), { won: true, enraged: false }, 'a trio beats the timer');
});

test('a bandage is no second wind: going down alone resets the boss', () => {
  for (const type of BOSSES) {
    const s = setup(type, ['t3Veteran']);
    try {
      const [id] = s.ids;
      const p = () => s.g.players.get(id)!;
      for (let i = 0; i < 20_000 && !p().downed; i++) {
        if (p().busyUntil <= s.now()) s.send(id, 'attack', { targetId: s.boss.id });
        s.step();
      }
      assert.ok(p().downed, `${type} downs a lone veteran`);
      assert.ok(s.send(id, 'revive').ok, 'the bandage from the kit');
      for (let i = 0; i < 400 && p().downed; i++) s.step();
      assert.ok(!p().downed && p().hp > 0 && p().hp < s.g.maxHp(p()) / 2, 'back on little HP');
      assert.equal(s.boss.hp, MOB_TYPES[type].hp, `the ${type} is whole again`);
      assert.equal(s.boss.engagedAt, undefined);
    } finally { s.g.close(); }
  }
});
