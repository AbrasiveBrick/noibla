// What a settlement's buildings do: levels, capacity, stations, shared work, palisade and watchtower.
// State helpers only, so both world.ts and settlement.ts can use them. The commands and the tick are in construction.ts.

import { BUILDINGS, ITEMS, RECIPES, SETTLEMENT, type BuildingDef, type BuildingId, type ItemStack, type RecipeDef, type StationId, type ZoneId } from '../shared/catalog.ts';
import { MAP_RULES, dist, plotOf } from '../shared/map.ts';
import type { BuildingView, ProjectView, SharedStockView, SharedWorkView } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Player, Settlement, SharedWork } from './types.ts';
import { toBag, toStacks, type Bag } from './util.ts';

/**
 * Settlements saved before buildings existed have none of the stage 3 fields. Used on load and after a rollback.
 * Saves from before shared work needed pooling counted `cover` at the moment of gathering: that was never given to the
 * group, so it is dropped. The carried fractions were earned and stay.
 */
export function upgradeSettlement(s: Settlement): Settlement {
  s.buildings ??= [];
  s.projects ??= {};
  s.stashes ??= {};
  s.work ??= {};
  for (const [id, w] of Object.entries(s.work)) s.work[id] = { gathered: w.gathered ?? {}, given: w.given ?? {}, carry: w.carry ?? {} };
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
//
// gather (recordWork) -> deposit (giveWork) -> rest in the stockpile -> another member refines from the stockpile
// (takeShared). The game syncs the books at every commit (syncCarried, syncPooled), so no way out of an inventory or a
// stockpile has to know about them: whatever left stops counting, and nothing that arrives ever starts to.

/** Raw items that shared work pays on: the raw inputs of the workshop's recipes. */
export const SHARED_ITEMS: ReadonlySet<string> = new Set(Object.values(RECIPES)
  .filter((r) => r.kind === 'refine' && BUILDINGS[SETTLEMENT.sharedWork.building].stations!.includes(r.station))
  .flatMap((r) => r.inputs.map((i) => i.item))
  .filter((item) => ITEMS[item].kind === 'resource'));

function workOf(s: Settlement, id: string): SharedWork {
  return (s.work[id] ??= { gathered: {}, given: {}, carry: {} });
}

/** A member gathered or skinned `qty` of `item`, already in their inventory: they may give it to the group. */
export function recordWork(g: Game, p: Player, item: string, qty: number) {
  if (!p.settlementId || qty <= 0 || !SHARED_ITEMS.has(item)) return;
  const s = g.settlements.get(p.settlementId);
  if (!s) return;
  g.markSettlement(s);
  const { gathered } = workOf(s, p.id);
  gathered[item] = { qty: (gathered[item]?.qty ?? 0) + qty, had: p.inventory[item] ?? 0 };
}

/** A deposit, already out of the inventory: the gathered units in it start to rest. Returns them. */
export function giveWork(g: Game, s: Settlement, p: Player, items: ItemStack[]): ItemStack[] {
  const given: Bag = {};
  for (const { item, qty } of items) {
    const carried = s.work[p.id]?.gathered[item];
    if (!carried) continue;
    g.markSettlement(s);
    const { gathered, given: lots } = s.work[p.id];
    const giving = Math.min(qty, carried.qty);
    if (giving === carried.qty) delete gathered[item];
    else gathered[item] = { qty: carried.qty - giving, had: p.inventory[item] ?? 0 };
    addLot(g, (lots[item] ??= []), giving);
    given[item] = giving;
  }
  return toStacks(given);
}

/** Adds a lot. Ready lots merge, and times round up, so an item has a bounded number of lots. */
function addLot(g: Game, lots: SharedWork['given'][string], qty: number) {
  const now = g.now();
  const rest = g.ms(SETTLEMENT.sharedWork.restMs);
  const slot = Math.max(1, Math.round(rest / 60));
  const readyAt = Math.ceil((now + rest) / slot) * slot;
  while (lots.length > 1 && lots[1].readyAt <= now) lots[1].qty += lots.shift()!.qty;
  const last = lots.at(-1);
  if (last?.readyAt === readyAt) last.qty += qty;
  else lots.push({ qty, readyAt });
  lots.sort((a, b) => a.readyAt - b.readyAt);
}

/** Takes up to `qty` off a member's lots of an item, youngest first. Returns how many. */
function dropYoungest(w: SharedWork, item: string, qty: number): number {
  const lots = w.given[item];
  let dropped = 0;
  while (lots?.length && dropped < qty) {
    const last = lots.at(-1)!;
    const n = Math.min(last.qty, qty - dropped);
    last.qty -= n;
    dropped += n;
    if (!last.qty) lots.pop();
  }
  if (lots && !lots.length) delete w.given[item];
  return dropped;
}

/** A withdrawal takes back what the member gave first. */
export function takeBack(g: Game, s: Settlement, p: Player, items: ItemStack[]) {
  const w = s.work[p.id];
  if (!w) return;
  g.markSettlement(s);
  for (const { item, qty } of items) dropYoungest(w, item, qty);
}

/** At commit, for each changed player: what left their inventory takes gathered units first. */
export function syncCarried(g: Game, p: Player) {
  const s = p.settlementId ? g.settlements.get(p.settlementId) : undefined;
  const gathered = s?.work[p.id]?.gathered;
  if (!gathered) return;
  for (const [item, { qty, had }] of Object.entries(gathered)) {
    const have = p.inventory[item] ?? 0;
    if (have === had) continue;
    g.markSettlement(s!);
    const left = qty - Math.max(0, had - have);
    if (left > 0) gathered[item] = { qty: left, had: have };
    else delete gathered[item];
  }
}

/** At commit, for each changed settlement: what left the stockpile stops counting, youngest lots first. */
export function syncPooled(s: Settlement) {
  for (const item of SHARED_ITEMS) {
    const lots = Object.values(s.work).flatMap((w) => (w.given[item] ?? []).map((lot) => ({ w, lot })));
    let over = lots.reduce((n, x) => n + x.lot.qty, 0) - (s.stockpile[item] ?? 0);
    if (over <= 0) continue;
    for (const { w, lot } of lots.sort((a, b) => b.lot.readyAt - a.lot.readyAt)) {
      over -= dropYoungest(w, item, Math.min(over, lot.qty));
      if (over <= 0) break;
    }
  }
}

/** Other members' units of `item` in the stockpile that have rested by `now`, and the ones still resting. */
function pooledByOthers(s: Settlement, viewer: string, item: string, now: number) {
  let ready = 0, resting = 0, nextReadyAt = Infinity;
  for (const [id, w] of Object.entries(s.work)) {
    if (id === viewer || !s.members[id]) continue;
    for (const lot of w.given[item] ?? []) {
      if (lot.readyAt <= now) { ready += lot.qty; continue; }
      resting += lot.qty;
      nextReadyAt = Math.min(nextReadyAt, lot.readyAt);
    }
  }
  return { ready, resting, nextReadyAt };
}

export function sharedWorkActive(s: Settlement): boolean {
  const { minLevel, building } = SETTLEMENT.sharedWork;
  return works(s, building) && activeLevelOf(s).level >= minLevel;
}

/** The raw item that keeps `p` from refining `count` units of `r` with shared work, if one does. */
export function sharedShortfall(g: Game, s: Settlement, p: Player, r: RecipeDef, count: number) {
  for (const i of r.inputs) {
    if (!SHARED_ITEMS.has(i.item)) continue;
    const pooled = pooledByOthers(s, p.id, i.item, g.now());
    if (pooled.ready < i.qty * count) return { item: i.item, need: i.qty * count, ...pooled };
  }
  return undefined;
}

/**
 * Uses up what others gave for `count` units of `r`, oldest first, and returns the extra output. `made` is what the
 * batch makes otherwise. The extra is exact: the fraction left over carries to the player's next batch of that recipe.
 */
export function takeShared(g: Game, s: Settlement, p: Player, r: RecipeDef, count: number, made: number): number {
  const now = g.now();
  g.markSettlement(s);
  for (const i of r.inputs) {
    if (!SHARED_ITEMS.has(i.item)) continue;
    let left = count * i.qty;
    const ready = Object.entries(s.work)
      .filter(([id]) => id !== p.id && s.members[id])
      .flatMap(([, w]) => (w.given[i.item] ?? []).filter((lot) => lot.readyAt <= now).map((lot) => ({ w, lot })))
      .sort((a, b) => a.lot.readyAt - b.lot.readyAt);
    for (const { w, lot } of ready) {
      const take = Math.min(left, lot.qty);
      lot.qty -= take;
      left -= take;
      if (!lot.qty) {
        w.given[i.item] = w.given[i.item].filter((l) => l.qty > 0);
        if (!w.given[i.item].length) delete w.given[i.item];
      }
      if (!left) break;
    }
  }
  const { carry } = workOf(s, p.id);
  const exact = (carry[r.id] ?? 0) + made * (SETTLEMENT.sharedWork.outputPct / 100);
  const output = Math.floor(exact + 1e-9);
  carry[r.id] = Math.max(0, exact - output);
  return output;
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

/** For members anywhere. What the stockpile holds is not in it. */
export function sharedWorkView(s: Settlement): SharedWorkView {
  return { active: sharedWorkActive(s), outputPct: SETTLEMENT.sharedWork.outputPct };
}

/** For a member reading the stockpile at the plot: what others gave that the viewer may refine, now or soon. */
export function sharedStockView(g: Game, s: Settlement, viewer: string): SharedStockView {
  const ready: Bag = {};
  const resting: Bag = {};
  const now = g.now();
  let next = Infinity;
  for (const item of SHARED_ITEMS) {
    const pooled = pooledByOthers(s, viewer, item, now);
    if (pooled.ready) ready[item] = pooled.ready;
    if (pooled.resting) resting[item] = pooled.resting;
    next = Math.min(next, pooled.nextReadyAt);
  }
  return { ready: toStacks(ready), resting: toStacks(resting), ...(next < Infinity ? { nextReadyInMs: next - now } : {}) };
}
