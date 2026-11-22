// What a settlement's buildings do: levels, capacity, stations, shared work, palisade and watchtower.
// State helpers only, so both world.ts and settlement.ts can use them. The commands and the tick are in construction.ts.

import { BUILDINGS, ITEMS, RECIPES, SETTLEMENT, type BuildingDef, type BuildingId, type RecipeDef, type StationId, type ZoneId } from '../shared/catalog.ts';
import { MAP_RULES, dist, plotOf } from '../shared/map.ts';
import type { BuildingView, ProjectView, SharedWorkView } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Player, Settlement } from './types.ts';
import { toBag, toStacks, type Bag } from './util.ts';

/** Settlements saved before buildings existed have none of the stage 3 fields. Used on load and after a rollback. */
export function upgradeSettlement(s: Settlement): Settlement {
  s.buildings ??= [];
  s.projects ??= {};
  s.stashes ??= {};
  s.work ??= {};
  s.alerts ??= [];
  return s;
}

/** A non-empty bag as a count of items. Silver takes no room. */
export function units(bag: Bag): number {
  let n = 0;
  for (const [item, qty] of Object.entries(bag)) if (item !== 'silver') n += qty;
  return n;
}

export function hasBuilding(s: Settlement, id: BuildingId): boolean { return s.buildings.some((b) => b.id === id); }

/** Standing and paid up. */
export function works(s: Settlement, id: BuildingId): boolean { return s.buildings.some((b) => b.id === id && !b.unpaid); }

function levelWith(buildings: number, members: number) {
  return [...SETTLEMENT.levels].reverse().find((l) => buildings >= l.buildings && members >= l.members) ?? SETTLEMENT.levels[0];
}

/** The public level: the buildings that stand, paid or not, so outsiders cannot watch the upkeep through it. */
export function levelOf(s: Settlement) { return levelWith(s.buildings.length, Object.keys(s.members).length); }

/** The level that pays income and shared work: only buildings whose upkeep is paid count. */
export function activeLevelOf(s: Settlement) { return levelWith(s.buildings.filter((b) => !b.unpaid).length, Object.keys(s.members).length); }

export function capacityOf(s: Settlement): number {
  return works(s, 'storehouse') ? BUILDINGS.storehouse.stockpileCapacity! : SETTLEMENT.stockpileCapacity;
}

/** Standing (not walking) within range of the plot and in its region, so plots near a border don't work from the safe wilds. */
export function atPlot(g: Game, p: Player, s: Settlement): boolean {
  return !p.travel && p.zone === s.zone && dist(p.pos, plotOf(g.map, s.plotId)!) <= MAP_RULES.range.plot + 1e-9;
}

/** The building of your own settlement whose `station` you stand at, working or not. */
export function buildingStation(g: Game, p: Player, station: StationId): { s: Settlement; def: BuildingDef; working: boolean } | undefined {
  const s = p.settlementId ? g.settlements.get(p.settlementId) : undefined;
  if (!s || !atPlot(g, p, s)) return undefined;
  for (const b of s.buildings) {
    const def = BUILDINGS[b.id];
    if (def.stations?.includes(station)) return { s, def, working: !b.unpaid };
  }
  return undefined;
}

// ---------- shared work ----------

/** Raw items whose gathering covers other members' refining: the raw inputs of the workshop's recipes. */
export const SHARED_ITEMS: ReadonlySet<string> = new Set(Object.values(RECIPES)
  .filter((r) => r.kind === 'refine' && BUILDINGS[SETTLEMENT.sharedWork.building].stations!.includes(r.station))
  .flatMap((r) => r.inputs.map((i) => i.item))
  .filter((item) => ITEMS[item].kind === 'resource'));

/** A member gathered or skinned `qty` of `item`: that covers as many units of someone else's refining. */
export function recordWork(g: Game, p: Player, item: string, qty: number) {
  if (!p.settlementId || qty <= 0 || !SHARED_ITEMS.has(item)) return;
  const s = g.settlements.get(p.settlementId);
  if (!s) return;
  g.markSettlement(s);
  const cover = (s.work[p.id] ??= { cover: {}, carry: {} }).cover;
  cover[item] = Math.min(SETTLEMENT.sharedWork.maxCoverPerItem, (cover[item] ?? 0) + qty);
}

function coverFromOthers(s: Settlement, playerId: string, item: string): number {
  let n = 0;
  for (const [id, w] of Object.entries(s.work)) if (id !== playerId && s.members[id]) n += w.cover[item] ?? 0;
  return n;
}

export function sharedWorkActive(s: Settlement): boolean {
  const { minLevel, building } = SETTLEMENT.sharedWork;
  return works(s, building) && activeLevelOf(s).level >= minLevel;
}

/**
 * Uses up other members' cover for `count` units of `r` refined by `p`. `made` is what the batch made otherwise.
 * The extra output is exact: the fraction left over carries to the player's next batch of the same recipe.
 */
export function useSharedWork(g: Game, s: Settlement, p: Player, r: RecipeDef, count: number, made: number): { units: number; output: number } | undefined {
  if (!sharedWorkActive(s)) return undefined;
  const raw = r.inputs.filter((i) => SHARED_ITEMS.has(i.item));
  if (!raw.length) return undefined;
  const covered = Math.min(count, ...raw.map((i) => Math.floor(coverFromOthers(s, p.id, i.item) / i.qty)));
  if (covered <= 0) return undefined;
  g.markSettlement(s);
  for (const i of raw) {
    let left = covered * i.qty;
    const givers = Object.entries(s.work)
      .filter(([id, w]) => id !== p.id && s.members[id] && (w.cover[i.item] ?? 0) > 0)
      .sort(([, a], [, b]) => b.cover[i.item] - a.cover[i.item]);
    for (const [, w] of givers) {
      const take = Math.min(left, w.cover[i.item]);
      w.cover[i.item] -= take;
      if (!w.cover[i.item]) delete w.cover[i.item];
      left -= take;
      if (!left) break;
    }
  }
  const carry = (s.work[p.id] ??= { cover: {}, carry: {} }).carry;
  const exact = (carry[r.id] ?? 0) + (made * covered / count) * (SETTLEMENT.sharedWork.outputPct / 100);
  const output = Math.floor(exact + 1e-9);
  carry[r.id] = Math.max(0, exact - output);
  return { units: covered, output };
}

// ---------- palisade & watchtower ----------

/** Someone walked over a region border. */
export function noteCrossing(g: Game, p: Player, from: ZoneId, to: ZoneId) {
  const ts = g.now();
  for (const s of g.settlements.values()) {
    if (s.zone !== from && s.zone !== to) continue;
    const move = s.zone === to ? 'arrive' : 'depart';
    if (works(s, 'watchtower')) {
      g.store.run('INSERT INTO watch_log(settlement_id, ts, player_id, name, move) VALUES(?, ?, ?, ?, ?)', s.id, ts, p.id, p.name, move);
    }
    if (move === 'arrive' && !s.members[p.id] && works(s, 'palisade')) {
      g.markSettlement(s);
      s.alerts = [...s.alerts, { ts, playerId: p.id, name: p.name }].slice(-SETTLEMENT.alertsKept);
      g.emit('settlement.alert', { kind: 'settlement', id: s.id }, { settlementId: s.id, zone: s.zone, playerId: p.id, name: p.name }, { zone: s.zone });
    }
  }
}

// ---------- member views ----------

export function buildingViews(g: Game, s: Settlement): BuildingView[] {
  const now = g.now();
  return s.buildings.map((b) => ({
    id: b.id, working: !b.unpaid, upkeep: BUILDINGS[b.id].upkeep.map((i) => ({ ...i })),
    upkeepInMs: b.unpaid ? 0 : Math.max(0, b.paidUntil - now),
  }));
}

export function projectViews(s: Settlement): ProjectView[] {
  return Object.entries(s.projects).map(([id, pr]) => {
    const def = BUILDINGS[id as BuildingId];
    const needs = stillNeeded(def, pr!.materials);
    return { building: def.id, contributed: toStacks(pr!.materials), needs: toStacks(needs), work: pr!.work, workNeeded: def.work, readyToBuild: !Object.keys(needs).length };
  });
}

export function stillNeeded(def: BuildingDef, materials: Bag): Bag {
  const left = toBag(def.cost);
  for (const [item, qty] of Object.entries(materials)) {
    left[item] = (left[item] ?? 0) - qty;
    if (left[item] <= 0) delete left[item];
  }
  return left;
}

/** `covered`: raw units of other members' work waiting to cover the viewer's refining. */
export function sharedWorkView(s: Settlement, viewer: string): SharedWorkView {
  const covered: Bag = {};
  for (const item of SHARED_ITEMS) {
    const n = coverFromOthers(s, viewer, item);
    if (n > 0) covered[item] = n;
  }
  return { active: sharedWorkActive(s), outputPct: SETTLEMENT.sharedWork.outputPct, covered: toStacks(covered) };
}
