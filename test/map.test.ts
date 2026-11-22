import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZONES, RECIPES } from '../src/shared/catalog.ts';
import { MAP_RULES, dist, findPath, generateMap, pathLength, regionAt, walkable, type WorldMap } from '../src/shared/map.ts';
import { world } from './helpers.ts';

const spawns = Object.values(ZONES).map((z) => ({ region: z.id, nodes: z.nodes, mobs: z.mobs, plots: z.plots }));

function checkMap(m: WorldMap) {
  const rect = (id: string) => m.regions.find((r) => r.id === id)!;
  const [town, hollow, wilds, ridge, frontier] = ['town', 'hollow', 'wilds', 'ridge', 'frontier'].map(rect);
  assert.deepEqual(m.regions.map((r) => r.id).sort(), Object.keys(ZONES).sort());
  assert.equal(town.x0, 0);
  assert.equal(frontier.x1, m.width - 1);
  assert.ok(town.x1 < wilds.x0 && wilds.x1 < frontier.x0, 'safety gradient west → east');
  assert.ok(hollow.y1 < wilds.y0 && wilds.y1 < ridge.y0, 'hollow / wilds / ridge north → south');
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    assert.equal(m.regions.filter((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1).length, 1, `regions tile the map at (${x}, ${y})`);
  }
  assert.equal(m.tiles.length, m.height);
  for (const row of m.tiles) assert.equal(row.length, m.width);
  for (const z of Object.values(ZONES)) assert.equal(regionAt(m, m.anchors[z.id]), z.id, `${z.id} anchor lies in ${z.id}`);
  assert.deepEqual(m.spawn, m.anchors.town);
  const reach = (p: { x: number; y: number }, what: string) => {
    assert.ok(walkable(m, p.x, p.y), `${what} on an open tile`);
    assert.ok(findPath(m, m.spawn, p), `${what} reachable from the spawn`);
  };
  for (const z of Object.values(ZONES)) reach(m.anchors[z.id], `${z.id} anchor`);
  // Places: one per station plus bank, quest board and shop, all usable from the plaza.
  const placeIds = m.places.map((p) => p.id).sort();
  for (const station of new Set(Object.values(RECIPES).map((r) => r.station))) {
    if (station === 'kitchen') assert.ok(!(placeIds as string[]).includes(station), 'only settlements have kitchens');
    else assert.ok(placeIds.includes(station), `station ${station} placed`);
  }
  for (const id of ['bank', 'quest_board', 'shop']) assert.ok(placeIds.includes(id as any), `${id} placed`);
  for (const p of m.places) {
    reach(p, p.id);
    assert.equal(regionAt(m, p), 'town');
    assert.ok(dist(p, m.anchors.town) <= MAP_RULES.range.place, `${p.id} usable from the plaza`);
  }
  // Every spawn from the catalog is placed in its region.
  for (const z of Object.values(ZONES)) {
    for (const n of z.nodes) assert.equal(m.nodes.filter((x) => x.region === z.id && x.type === n.type).length, n.count);
    for (const mob of z.mobs) assert.equal(m.mobSpawns.filter((x) => x.region === z.id && x.type === mob.type).length, mob.count);
  }
  for (const n of [...m.nodes, ...m.mobSpawns]) {
    reach(n, n.id);
    assert.equal(regionAt(m, n), n.region, `${n.id} inside ${n.region}`);
  }
  for (const z of Object.values(ZONES)) assert.equal(m.plots.filter((x) => x.region === z.id).length, z.plots);
  for (const pl of m.plots) {
    reach(pl, pl.id);
    assert.equal(regionAt(m, pl), pl.region, `${pl.id} inside ${pl.region}`);
  }
  // Every region is crossed without leaving it, and no walk takes PvP land as a shortcut.
  const stays = (from: { x: number; y: number }, to: { x: number; y: number }, range: number, allowed: string[], what: string) => {
    const path = findPath(m, from, to, range)!;
    assert.ok(path, what);
    for (const p of path) assert.ok(allowed.includes(regionAt(m, p)), `seed ${m.seed}: ${what} passes through ${regionAt(m, p)}`);
    return path;
  };
  for (const n of [...m.nodes, ...m.mobSpawns, ...m.plots]) {
    stays(m.anchors[n.region], n, 0, [n.region], `${n.region} anchor → ${n.id}`);
    const path = stays(m.spawn, n, 1.5, [...new Set(['town', 'wilds', n.region])], `town → ${n.id}`);
    assert.equal(regionAt(m, path[path.length - 1]), n.region, `walking to ${n.id} ends in its region`);
  }
  stays(m.spawn, m.anchors.frontier, 0, ['town', 'wilds', 'frontier'], 'town → frontier');
  stays(m.anchors.hollow, m.anchors.frontier, 0, ['hollow', 'town', 'wilds', 'frontier'], 'hollow → frontier');
  stays(m.anchors.ridge, m.anchors.frontier, 0, ['ridge', 'frontier'], 'ridge → frontier (its own ford)');
  // The frontier is only reachable through the wilds.
  const toFrontier = findPath(m, m.spawn, m.anchors.frontier)!;
  assert.ok(toFrontier.some((p) => regionAt(m, p) === 'wilds'));
}

test('map generation: every seed gives a valid, connected map; same seed, same map', () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 150; seed++) {
    const m = generateMap(seed, spawns);
    checkMap(m);
    seen.add(m.tiles.join('\n'));
  }
  assert.ok(seen.size > 140, 'seeds give different maps');
  assert.deepEqual(generateMap(12345, spawns), generateMap(12345, spawns));
});

test('the map is generated once per world, served by catalog(), and survives a restart with positions', async () => {
  const w1 = await world();
  const dir = w1.dir;
  const a = await w1.bot('Mapper');
  const m1 = await a.map();
  checkMap(m1);
  assert.equal(m1.viewRadius, MAP_RULES.viewRadius, 'catalog.map carries the map rules');
  const o0 = await a.observe();
  assert.deepEqual(o0.self.pos, m1.spawn, 'new players start on the plaza');
  const node = m1.nodes.find((n) => n.region === 'wilds')!;
  await a.goTo(node.id);
  const before = (await a.observe()).self.pos;
  const { name } = await a.whoami();
  assert.ok(dist(before, node) <= MAP_RULES.range.interact);
  await w1.close({ keepDir: true });

  const w2 = await world({ dir });
  try {
    const st = await w2.operator();
    assert.deepEqual(st.map.tiles, m1.tiles, 'same map after a restart');
    const bot = st.bots.find((x: any) => x.name === name);
    assert.deepEqual(bot.pos, before, 'position persisted');
    assert.equal(bot.zone, 'wilds');
  } finally { await w2.close(); }
});

test('walking takes time in proportion to path length, avoids blocked tiles, and crosses regions', async () => {
  const w = await world({ speed: 10 });
  try {
    const c = await w.bot('Walker');
    const m = await c.map();
    const r = await c.move('wilds');
    assert.ok(r.travel);
    const path = findPath(m, m.spawn, m.anchors.wilds)!;
    for (const p of path) assert.ok(walkable(m, p.x, p.y));
    const expected = pathLength(path) * (MAP_RULES.msPerTile / 10);
    assert.ok(Math.abs(r.travel!.arriveInMs - expected) <= 5, `${r.travel!.arriveInMs} vs ${expected}`);
    assert.equal(r.travel!.from, 'town');
    assert.equal(r.travel!.to, 'wilds');
    const busy = await c.request('gather', { nodeId: m.nodes[0].id });
    assert.equal(!busy.ok && busy.error.code, 'TRAVELING');
    const mid = await c.observe();
    assert.ok(mid.self.travel && mid.zone, 'you see the world while walking');
    const arrived = await c.waitForEvent((e) => e.type === 'self.arrived', 10_000);
    assert.deepEqual(arrived.data.pos, m.anchors.wilds);
    const o = await c.observe();
    assert.equal(o.self.zone, 'wilds');
    assert.ok(c.received.some((e) => e.type === 'travel.arrive' && e.data.to === 'wilds'));
    // Exact coordinates: blocked or out-of-bounds tiles are refused with a hint.
    const blocked = m.tiles.flatMap((row, y) => [...row].map((ch, x) => ({ ch, x, y }))).find((t) => t.ch === '~' || t.ch === '#')!;
    const bad = await c.request('move', { x: blocked.x, y: blocked.y });
    assert.equal(!bad.ok && bad.error.code, 'BAD_REQUEST');
    assert.match(!bad.ok ? bad.error.hint! : '', /nearest open tile/);
  } finally { await w.close(); }
});

test('observe shows only what is within the view radius, with distances; places need proximity', async () => {
  const w = await world();
  try {
    const c = await w.bot('Looker');
    const m = await c.map();
    let o = await c.observe();
    assert.ok(o.zone.places.every((p) => p.inRange), 'every place is usable from the plaza');
    for (const list of [o.zone.nodes, o.zone.mobs, o.zone.places]) for (const e of list) assert.ok(e.distance <= MAP_RULES.viewRadius);
    await c.deposit([{ item: 'silver', qty: 1 }]);
    // A town tile far from the bank.
    const bank = m.places.find((p) => p.id === 'bank')!;
    let far = { x: 0, y: 0 };
    for (let y = 0; y < m.height; y++) for (let x = 0; x <= m.regions[0].x1; x++) if (walkable(m, x, y) && dist({ x, y }, bank) > dist(far, bank) && findPath(m, m.spawn, { x, y })) far = { x, y };
    await c.moveTo(far.x, far.y);
    const away = await c.request('bank.deposit', { items: [{ item: 'silver', qty: 1 }] });
    assert.equal(!away.ok && away.error.code, 'OUT_OF_RANGE');
    assert.match(!away.ok ? away.error.hint! : '', /goTo\('bank'\)/);
    const craft = await c.request('refine', { recipeId: 'copper_bar' });
    assert.equal(!craft.ok && craft.error.code, 'NO_STATION');
    await c.goTo('bank');
    await c.deposit([{ item: 'silver', qty: 1 }]);
    await c.travelTo('frontier');
    o = await c.observe();
    for (const e of [...o.zone.nodes, ...o.zone.mobs]) assert.ok(e.distance <= MAP_RULES.viewRadius);
    assert.ok(!o.zone.places.length, 'town places are out of view from the frontier');
  } finally { await w.close(); }
});

test('mobs chase their attacker inside their region; combat lock blocks leaving the region but not walking inside it', async () => {
  const w = await world({ speed: 20 });
  try {
    const c = await w.bot('Kiter');
    await c.travelTo('wilds');
    const m = await c.map();
    const boar = await c.approachMob('boar');
    await c.attack(boar.id);
    // Walk a few tiles away inside the wilds: allowed while locked, and the boar follows.
    const me = (await c.observe()).self.pos;
    let spot = me;
    const wilds = m.regions.find((r) => r.id === 'wilds')!;
    for (let y = wilds.y0; y <= wilds.y1; y++) for (let x = wilds.x0 + 2; x < wilds.x1 - 2; x++) {
      const d = dist({ x, y }, me);
      if (walkable(m, x, y) && d >= 4 && d <= 6 && findPath(m, me, { x, y })) spot = { x, y };
    }
    await c.waitReady();
    const inside = await c.request('move', { x: spot.x, y: spot.y });
    assert.ok(inside.ok, 'walking inside the region is allowed while combat locked');
    const leave = await c.request('move', { to: 'town' });
    assert.equal(!leave.ok && leave.error.code, 'COMBAT_LOCKED');
    await c.waitArrival();
    const caught = await c.waitFor(async () => {
      const o = await c.observe();
      const b = o.zone.mobs.find((x) => x.id === boar.id)!;
      return b.alive && b.inRange ? b : null;
    }, { timeoutMs: 5000, what: 'the boar to catch up' });
    assert.ok(dist(caught, boar) > 0.5, 'the boar moved');
    const r = await c.fight(boar.id);
    assert.ok(['killed', 'died'].includes(r.result));
  } finally { await w.close(); }
});
