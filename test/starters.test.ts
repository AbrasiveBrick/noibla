import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, QUESTS, ZONES } from '../src/shared/catalog.ts';
import { STARTERS, pickStarter, renderStarter } from '../src/shared/starters.ts';
import { world } from './helpers.ts';

test('starters: ids are unique and every referenced item, quest and zone exists', () => {
  const ids = STARTERS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(STARTERS.length >= 10);
  assert.equal(new Set(STARTERS.map((s) => s.archetype)).size, 6, 'covers every archetype');
  for (const s of STARTERS) {
    for (const z of s.zones) assert.ok(ZONES[z], `${s.id}: zone ${z}`);
    for (const i of s.milestone.items ?? []) assert.ok(ITEMS[i], `${s.id}: item ${i}`);
    for (const q of s.milestone.quests ?? []) assert.ok(QUESTS[q], `${s.id}: quest ${q}`);
    for (const q of s.firstSteps.join(' ').matchAll(/Quest\('(\w+)'\)/g)) assert.ok(QUESTS[q[1]], `${s.id}: quest ${q[1]}`);
    for (const m of s.firstSteps.join(' ').matchAll(/(?:gatherItem|refineItem|craftItem|equip)\('(\w+)'/g)) assert.ok(ITEMS[m[1]], `${s.id}: item ${m[1]}`);
    assert.ok(s.firstSteps.length > 0 && s.prompt.length > 0);
  }
});

test('starters: pickStarter filters by id, risk and archetype; renderStarter includes the brief', () => {
  assert.equal(pickStarter({ id: 'village_smith' }).id, 'village_smith');
  assert.throws(() => pickStarter({ id: 'nope' }), /unknown starter/);
  for (let i = 0; i < 20; i++) assert.equal(pickStarter({ maxRisk: 'low', random: () => i / 20 }).risk, 'low');
  assert.equal(pickStarter({ archetype: 'trader', random: () => 0 }).archetype, 'trader');
  const text = renderStarter(STARTERS[0]);
  assert.ok(text.includes(STARTERS[0].title) && text.includes('First steps') && text.includes('Milestone'));
});

test('starters: bots receive them through catalog()', async () => {
  const w = await world();
  try {
    const bot = await w.bot('Starter', { connect: false });
    const cat = await bot.catalog();
    assert.deepEqual(cat.starters.map((s) => s.id), STARTERS.map((s) => s.id));
  } finally { await w.close(); }
});
