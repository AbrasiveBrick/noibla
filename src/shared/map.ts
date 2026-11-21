// The world map: a 2D tile grid, generated procedurally from a seed when a world is created.
// Shared by the server (authoritative movement, ranges, spawns) and the SDK (path previews,
// nearest-thing lookups). Bots read the generated map with `catalog()` as `catalog.map`.
//
// Layout rules (every seed): three regions as vertical bands, west → east:
//   town (safe) | wilds (PvE) | frontier (lethal PvP).
// The town is walled with one gate; a river separates the wilds from the frontier and is crossed
// at two fords. Lakes and rocks are scattered in the wilds and frontier. Every open tile is reachable.

import type { StationId, ZoneId } from './catalog.ts';

export interface Pos { x: number; y: number }

/** Things you use by standing near them in town. Crafting stations plus the bank, quest board and shop. */
export type PlaceId = StationId | 'bank' | 'quest_board' | 'shop';

export interface MapRegion { id: ZoneId; x0: number; x1: number }
export interface MapPlace { id: PlaceId; x: number; y: number }
export interface MapNode { id: string; type: string; region: ZoneId; x: number; y: number }
export interface MapMobSpawn { id: string; type: string; region: ZoneId; x: number; y: number }

export interface WorldMap {
  seed: number;
  width: number;
  height: number;
  /** Rows (y = 0 is the top), one char per tile. See MAP_RULES.legend. Only '.', '+' and '=' are walkable. */
  tiles: string[];
  /** Vertical bands covering the full height: a tile (x, y) belongs to the region with x0 <= x <= x1. */
  regions: MapRegion[];
  /** Where `move { to: '<region>' }` / travelTo(region) walks. The town anchor is the plaza, next to every place. */
  anchors: Record<ZoneId, Pos>;
  /** Respawn point after death (the town plaza). */
  spawn: Pos;
  places: MapPlace[];
  /** Resource nodes never move. Ids match observe().zone.nodes. */
  nodes: MapNode[];
  /** Mob home tiles. Mobs chase their attacker inside their region and return home when they lose it. */
  mobSpawns: MapMobSpawn[];
}

/** Fixed map rules (same for every seed). Distances are in tiles (Euclidean). */
export const MAP_RULES = {
  width: 64,
  height: 24,
  /** Walking time per tile at world speed 1 (diagonal steps cost √2 tiles). */
  msPerTile: 250,
  /** Mobs chasing a target move this fast (a bit faster than players: you cannot outrun one inside its region). */
  mobMsPerTile: 200,
  /** observe() lists nodes, mobs, players, loot bags and places within this distance. */
  viewRadius: 12,
  range: {
    /** Gather from a node, attack a mob or player, take from a loot bag. */
    interact: 1.5,
    /** Use a place (bank, crafting station, quest board, shop). */
    place: 3,
  },
  legend: { '.': 'ground', '+': 'town gate', '=': 'ford', '#': 'wall or rock (blocked)', '~': 'water (blocked)' },
} as const;

const WALKABLE = new Set(['.', '+', '=']);

// ---------- geometry ----------

export function dist(a: Pos, b: Pos): number { return Math.hypot(a.x - b.x, a.y - b.y); }

export function inBounds(m: WorldMap, x: number, y: number): boolean { return x >= 0 && y >= 0 && x < m.width && y < m.height; }

export function walkable(m: WorldMap, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && inBounds(m, x, y) && WALKABLE.has(m.tiles[y][x]);
}

export function regionAt(m: WorldMap, p: Pos): ZoneId {
  const x = Math.round(p.x);
  for (const r of m.regions) if (x >= r.x0 && x <= r.x1) return r.id;
  return x < 0 ? m.regions[0].id : m.regions[m.regions.length - 1].id;
}

export function placeOf(m: WorldMap, id: string): MapPlace | undefined { return m.places.find((s) => s.id === id); }

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** Nearest walkable tile to `p` (itself when walkable). */
export function nearestWalkable(m: WorldMap, p: Pos): Pos {
  const sx = Math.min(m.width - 1, Math.max(0, Math.round(p.x)));
  const sy = Math.min(m.height - 1, Math.max(0, Math.round(p.y)));
  let best: Pos | null = null;
  let bestD = Infinity;
  for (let r = 0; r < Math.max(m.width, m.height) && !best; r++) {
    for (let y = sy - r; y <= sy + r; y++) for (let x = sx - r; x <= sx + r; x++) {
      if (Math.max(Math.abs(x - sx), Math.abs(y - sy)) !== r || !walkable(m, x, y)) continue;
      const d = dist({ x, y }, p);
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best ?? { x: sx, y: sy };
}

/**
 * Shortest 8-directional path (no cutting corners past blocked tiles) from `from` to the closest
 * tile that is within `range` of `target`. Returns the tiles to step through, starting with `from`,
 * or null when unreachable. `range` 0 means "onto the target tile".
 */
export function findPath(m: WorldMap, from: Pos, target: Pos, range = 0): Pos[] | null {
  const start = nearestWalkable(m, from);
  const W = m.width;
  const idx = (x: number, y: number) => y * W + x;
  const goal = (x: number, y: number) => dist({ x, y }, target) <= range + 1e-9;
  const cost = new Float64Array(W * m.height).fill(Infinity);
  const prev = new Int32Array(W * m.height).fill(-1);
  // Dijkstra with a binary heap; the grid is small (64×24).
  const heap: [number, number][] = [];
  const push = (c: number, i: number) => {
    heap.push([c, i]);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let s = k;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === k) break;
        [heap[s], heap[k]] = [heap[k], heap[s]];
        k = s;
      }
    }
    return top;
  };
  cost[idx(start.x, start.y)] = 0;
  push(0, idx(start.x, start.y));
  while (heap.length) {
    const [c, i] = pop();
    if (c > cost[i]) continue;
    const x = i % W, y = (i - x) / W;
    if (goal(x, y)) {
      const path: Pos[] = [];
      for (let k = i; k !== -1; k = prev[k]) path.unshift({ x: k % W, y: Math.floor(k / W) });
      return path;
    }
    for (const [dx, dy, step] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!walkable(m, nx, ny)) continue;
      if (dx && dy && (!walkable(m, x + dx, y) || !walkable(m, x, y + dy))) continue;
      const nc = c + step;
      const ni = idx(nx, ny);
      if (nc < cost[ni]) { cost[ni] = nc; prev[ni] = i; push(nc, ni); }
    }
  }
  return null;
}

/** Walking length of a path in tiles. */
export function pathLength(path: Pos[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += dist(path[i - 1], path[i]);
  return n;
}

/** Position after walking `tiles` along `path` (clamped to its ends). */
export function pointAlong(path: Pos[], tiles: number): Pos {
  let left = Math.max(0, tiles);
  for (let i = 1; i < path.length; i++) {
    const seg = dist(path[i - 1], path[i]);
    if (left <= seg) {
      const t = seg === 0 ? 1 : left / seg;
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t };
    }
    left -= seg;
  }
  return { ...path[path.length - 1] };
}

// ---------- generation ----------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpawnSpec { region: ZoneId; nodes: { type: string; count: number }[]; mobs: { type: string; count: number }[] }

const PLACE_IDS: PlaceId[] = ['bank', 'quest_board', 'shop', 'smelter', 'sawmill', 'tannery', 'forge', 'workbench'];
/** Offsets around the plaza, all within MAP_RULES.range.place. */
const PLACE_RING: [number, number][] = [[0, -3], [3, 0], [0, 3], [-3, 0], [2, -2], [2, 2], [-2, 2], [-2, -2], [1, -2], [-1, 2]];

/**
 * Generates the map for `seed`. Deterministic: the same seed and spawn table give the same map.
 * `spawns` comes from the catalog's ZONES (what lives where); the generator decides where exactly.
 */
export function generateMap(seed: number, spawns: SpawnSpec[]): WorldMap {
  const base = seed >>> 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    const m = tryGenerate(base, base + attempt * 7919, spawns, attempt < 40);
    if (m) return m;
  }
  throw new Error(`could not generate a map for seed ${seed}`);
}

function tryGenerate(seed: number, rngSeed: number, spawns: SpawnSpec[], obstacles: boolean): WorldMap | null {
  const r = rng(rngSeed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const { width: W, height: H } = MAP_RULES;
  const grid: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  const set = (x: number, y: number, c: string) => { if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = c; };

  const townW = int(13, 16);
  const frontierW = int(17, 21);
  const regions: MapRegion[] = [
    { id: 'town', x0: 0, x1: townW - 1 },
    { id: 'wilds', x0: townW, x1: W - frontierW - 1 },
    { id: 'frontier', x0: W - frontierW, x1: W - 1 },
  ];
  const wilds = regions[1], frontier = regions[2];

  // Town palisade on its east edge, one gate (3 tiles).
  const wallX = townW - 1;
  const gateY = int(6, H - 9);
  for (let y = 0; y < H; y++) set(wallX, y, y >= gateY && y < gateY + 3 ? '+' : '#');
  const plaza = { x: Math.floor(townW / 2) - 1, y: Math.min(H - 5, Math.max(4, gateY + 1 + int(-3, 3))) };

  // River on the wilds/frontier border, crossed at two fords (2 tiles each).
  const riverX = frontier.x0;
  const fordA = int(2, 8), fordB = int(H - 9, H - 4);
  for (let y = 0; y < H; y++) for (const x of [riverX, riverX + 1]) set(x, y, (y >= fordA && y < fordA + 2) || (y >= fordB && y < fordB + 2) ? '=' : '~');

  // A few houses in town, away from the plaza and the gate.
  const keepClear: { p: Pos; r: number }[] = [{ p: plaza, r: 4.5 }, { p: { x: wallX, y: gateY + 1 }, r: 3 }];
  const clearOf = (x: number, y: number, w: number, h: number) =>
    keepClear.every(({ p, r: rad }) => {
      const cx = Math.max(x, Math.min(p.x, x + w - 1)), cy = Math.max(y, Math.min(p.y, y + h - 1));
      return dist({ x: cx, y: cy }, p) > rad;
    });
  const scatter = (x0: number, x1: number, n: number, chars: string[], wMax: number, hMax: number) => {
    for (let i = 0; i < n; i++) {
      for (let tries = 0; tries < 20; tries++) {
        const w = int(2, wMax), h = int(2, hMax);
        const x = int(x0, x1 - w + 1), y = int(1, H - h - 1);
        if (!clearOf(x, y, w, h)) continue;
        const c = chars[int(0, chars.length - 1)];
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c);
        break;
      }
    }
  };
  if (obstacles) {
    scatter(1, wallX - 2, int(2, 4), ['#'], 3, 3);
    const wildsAnchorHint = { x: Math.round((wilds.x0 + wilds.x1) / 2), y: Math.round(H / 2) };
    keepClear.push({ p: wildsAnchorHint, r: 3 }, { p: { x: riverX - 1, y: fordA }, r: 2.5 }, { p: { x: riverX - 1, y: fordB }, r: 2.5 }, { p: { x: riverX + 2, y: fordA }, r: 2.5 }, { p: { x: riverX + 2, y: fordB }, r: 2.5 }, { p: { x: wilds.x0, y: gateY + 1 }, r: 3 });
    scatter(wilds.x0 + 2, riverX - 3, int(3, 5), ['~', '#'], 5, 4);
    scatter(riverX + 3, W - 2, int(2, 4), ['#'], 4, 4);
  }

  const tiles = grid.map((row) => row.join(''));
  const m: WorldMap = {
    seed, width: W, height: H, tiles, regions,
    anchors: { town: plaza, wilds: plaza, frontier: plaza },
    spawn: plaza, places: [], nodes: [], mobSpawns: [],
  };
  if (!walkable(m, plaza.x, plaza.y)) return null;

  // Connectivity: every open tile must be reachable from the plaza.
  const seen = new Uint8Array(W * H);
  const queue: Pos[] = [plaza];
  seen[plaza.y * W + plaza.x] = 1;
  let reached = 1;
  while (queue.length) {
    const p = queue.pop()!;
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx, ny = p.y + dy;
      if (!walkable(m, nx, ny) || seen[ny * W + nx]) continue;
      if (dx && dy && (!walkable(m, p.x + dx, p.y) || !walkable(m, p.x, p.y + dy))) continue;
      seen[ny * W + nx] = 1;
      reached++;
      queue.push({ x: nx, y: ny });
    }
  }
  let open = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (walkable(m, x, y)) open++;
  if (reached !== open) return null;

  m.anchors = {
    town: plaza,
    wilds: nearestWalkable(m, { x: Math.round((wilds.x0 + wilds.x1) / 2), y: Math.round(H / 2) }),
    frontier: nearestWalkable(m, { x: Math.round((riverX + 2 + frontier.x1) / 2), y: Math.round(H / 2) }),
  };

  // Places around the plaza, shuffled, all within use range of the plaza tile.
  const ring = PLACE_RING.filter(([dx, dy]) => walkable(m, plaza.x + dx, plaza.y + dy));
  if (ring.length < PLACE_IDS.length) return null;
  for (let i = ring.length - 1; i > 0; i--) { const j = int(0, i); [ring[i], ring[j]] = [ring[j], ring[i]]; }
  m.places = PLACE_IDS.map((id, i) => ({ id, x: plaza.x + ring[i][0], y: plaza.y + ring[i][1] }));

  // Nodes and mob homes: open tiles inside their region, spread out, away from borders and anchors.
  const taken: Pos[] = [...Object.values(m.anchors), { x: wallX, y: gateY + 1 }];
  const pick = (region: MapRegion, minSpacing: number): Pos | null => {
    const lo = region.id === 'frontier' ? riverX + 3 : region.x0 + 3;
    const hi = region.id === 'wilds' ? riverX - 2 : region.x1 - 1;
    for (let tries = 0; tries < 400; tries++) {
      const spacing = tries < 200 ? minSpacing : minSpacing - 1;
      const p = { x: int(lo, hi), y: int(1, H - 2) };
      if (!walkable(m, p.x, p.y)) continue;
      if (taken.some((t) => dist(t, p) < spacing)) continue;
      taken.push(p);
      return p;
    }
    return null;
  };
  for (const spec of spawns) {
    const region = regions.find((x) => x.id === spec.region)!;
    for (const n of spec.nodes) for (let i = 1; i <= n.count; i++) {
      const p = pick(region, 3);
      if (!p) return null;
      m.nodes.push({ id: `n_${spec.region}_${n.type}_${i}`, type: n.type, region: spec.region, ...p });
    }
    for (const mob of spec.mobs) for (let i = 1; i <= mob.count; i++) {
      const p = pick(region, 4);
      if (!p) return null;
      m.mobSpawns.push({ id: `m_${spec.region}_${mob.type}_${i}`, type: mob.type, region: spec.region, ...p });
    }
  }
  return m;
}
