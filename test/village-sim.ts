// The economy simulator behind the group-versus-solo check in economy.test.ts. It plays the real server rules on a
// fake clock through Game.execute: scripted players walk, gather, hunt, refine, craft, repair, pay upkeep, die and
// fetch their bags. Nothing here multiplies catalog constants into a result: income is what the players hold at the
// end, minus what they held at the start.
//
// All sides use the same player script. They differ only in what the rules give them:
//   solo         four players, each alone, using town
//   founders     four players, each alone in a settlement they founded, with its buildings and income
//   altFounders  the same, each with two idle accounts as members (the cheapest way to fake a village)
//   village      four members of one settlement who pool at the stockpile and refine what the others gave
//   exile        a village of three, plus the fourth player alone in the same world
//   separate     four members of one village who each keep their own materials, by any of the tricks in Keep
//   freeRider    a village in which three pool and the fourth keeps their own materials
//
// Income is what the first AMORTIZE_HOURS of play from nothing come to: the run's first `warmMinutes` as played
// (materials given to the group rest before they pay), then the rate of the rest of the run.
import {
  AFFIXES, BUILDINGS, FOOD, ITEMS, MOB_TYPES, NODE_TYPES, RECIPES, SETTLEMENT, SKILLS, TOOL_FAMILIES, UNIQUE_SEP, WEAR,
  baseOf, gearGroup, requiredToolTier, type BuildingId, type RecipeDef, type SkillId,
} from '../src/shared/catalog.ts';
import { MAP_RULES, dist, placeOf, regionAt, type MapPlot } from '../src/shared/map.ts';
import { Game } from '../src/server/game.ts';
import { AFFIX_RANGES, MOB_LOOT, SKILL_ODDS } from '../src/server/odds.ts';
import { SHARED_ITEMS, capacityOf, units } from '../src/server/buildings.ts';
import { equippedToolTier, repairCost, skillLevel } from '../src/server/world.ts';
import type { Player } from '../src/server/types.ts';

// ---------- silver values ----------

/**
 * Raw materials, in silver. The first five come from what quests pay (ore_run: 15 for 6 copper ore; ore_buyer: 25
 * for 6 iron ore) and their equally easy neighbours. Frontier and boss materials are set by how hard they are to get.
 */
const RAW: Record<string, number> = {
  silver: 1, copper_ore: 2.5, pine_log: 2.5, stone: 2.5, grain: 2.5, iron_ore: 4, rough_hide: 3, orb_shard: 3,
  duskiron_ore: 12, wraith_essence: 15, bear_pelt: 30, wyrm_scale: 80,
};
/** Refined materials where the market pays for the work (supply_contract: 40 for 4 iron bars). */
const REFINED: Record<string, number> = { copper_bar: 6, pine_plank: 6, leather: 7, iron_bar: 10, duskiron_bar: 38, ration: 9 };

/** Everything at the value of its inputs: refining and crafting add nothing but their bonus output. */
function atCost(): Record<string, number> {
  const v = { ...RAW };
  const value = (item: string): number => (v[item] ??= RECIPES[item].inputs.reduce((n, i) => n + value(i.item) * i.qty, 0));
  for (const id of Object.keys(RECIPES)) value(id);
  return v;
}

/** The three valuations the target must hold under. An item not listed keeps its value at cost. */
export const VALUES = {
  cost: atCost(),
  /** Anchored on what quests pay for goods: hire_a_smith 30 per iron sword, outfitter_contract 50 per iron mail. */
  quest: { ...atCost(), ...REFINED, copper_sword: 24, iron_sword: 30, leather_jerkin: 24, iron_mail: 50, iron_pickaxe: 28, duskiron_sword: 90, wraithhide_armor: 80, orb_transmute: 35 },
  /** Half of shop prices, extended to what the shop does not sell in proportion. */
  shop: { ...atCost(), ...REFINED, copper_sword: 30, iron_sword: 60, leather_jerkin: 40, iron_mail: 80, iron_pickaxe: 150, duskiron_sword: 160, wraithhide_armor: 160, orb_transmute: 75 },
} satisfies Record<string, Record<string, number>>;
export type ValueId = keyof typeof VALUES;

/**
 * An upper bound on boss income: every respawn of both bosses killed on cooldown, all its loot, in zero time.
 * Maxed players may solo bosses, so the solo baseline gets this on top.
 */
export function bossIncomePerHour(values: ValueId): number {
  const v: Record<string, number> = VALUES[values];
  let n = 0;
  for (const m of Object.values(MOB_TYPES)) {
    if (!m.boss) continue;
    const loot = MOB_LOOT[m.id];
    let kill = (loot.silver[0] + loot.silver[1]) / 2;
    for (const d of loot.drops) kill += (v[d.item] ?? 0) * d.chance * (d.min + d.max) / 2;
    n += (kill * 3_600_000) / m.respawnMs;
  }
  return n;
}

// ---------- players ----------

export const BUILDS = {
  /** A newcomer who has bought the first weapon and armor. */
  fresh: { level: 0, metal: 'copper', sword: 'copper_sword', armor: 'leather_jerkin', perfect: false, purse: 500 },
  veteran: { level: 20, metal: 'duskiron', sword: 'duskiron_sword', armor: 'wyrmscale_mail', perfect: false, purse: 5000 },
  /** The strongest the rules allow: best gear and every affix at its maximum, tools included. */
  maxed: { level: 30, metal: 'duskiron', sword: 'duskiron_sword', armor: 'wyrmscale_mail', perfect: true, purse: 5000 },
} as const;
export type BuildId = keyof typeof BUILDS;

export type Side = 'solo' | 'founders' | 'altFounders' | 'village' | 'exile' | 'separate' | 'freeRider';

/**
 * How a member who keeps their own materials tries for shared work all the same. Each still tries to refine from the
 * stockpile whatever it will let them.
 *   own    deposits nothing but upkeep
 *   cycle  deposits what they gathered and takes as much back at once
 *   swap   deposits it, and takes as much back, whoever's it was, at the next trip, which comes before it has rested
 */
export type Keep = 'own' | 'cycle' | 'swap';

/** Where a player looks for work: anywhere, only in the frontier, or everywhere but there. */
export type Roam = 'any' | 'frontier' | 'near';

export interface Strategy {
  /** Focus skills of the four players. */
  focus: SkillId[][];
  /** Go home to refine, craft and repair this often. */
  tripMs: number;
  /** Skip recipes that earn less than this many silver per second of work. */
  minGain: number;
  buildings?: BuildingId[];
  /** Per player. Default: anywhere. */
  roam?: Roam[];
  /** How much of the value further down the chain a player sees in a raw material (0-1). Default 0.8. */
  outlook?: number;
  /** separate, freeRider: the trick of whoever keeps their own. Default: own. */
  keep?: Keep;
  /** village: take shared work's output out as soon as it is made, the least trust that still pays. */
  skim?: boolean;
  /** exile, freeRider: the fourth player's own habits. The other three keep the village's. */
  exiled?: { tripMs: number; minGain: number; outlook?: number };
}

export interface SimOptions {
  side: Side;
  strategy: Strategy;
  values: ValueId;
  build: BuildId;
  minutes: number;
  map: number;
  seed: number;
  /** Upkeep the settlement keeps in its stockpile, in intervals. Default: enough for the run. */
  reserveIntervals?: number;
  /** The start of the run that counts as played once, before the rate is measured. Default: none. */
  warmMinutes?: number;
  /** Average the stockpile only from this minute on. */
  stockpileFromMinute?: number;
}

export interface SimResult {
  /** Silver-equivalent per player-hour, after upkeep, repairs, deaths and amortized founding and building. */
  perHour: number;
  /** The same without the shared costs, player by player. A village's income is shared, so `perHour` is what counts there. */
  each: number[];
  /** Growth of the stockpiles per hour, all settlements together. */
  pooled: number;
  /** Silver-equivalent per player-hour once warm, before founding and building. */
  steady: number;
  /** Units refined with shared work. */
  shared: number;
  deaths: number;
  /** Time-averaged value of the settlements' stockpiles, per settlement. */
  stockpile: number;
  /** The same at the end of the run. */
  stockpileEnd: number;
  /** Buildings that were unpaid at any moment. */
  lapsed: boolean;
}

/** Founding and building are paid off over this much play. */
export const AMORTIZE_HOURS = 2;

const REFINES = ['duskiron_bar', 'iron_bar', 'copper_bar', 'pine_plank', 'leather'];
const CRAFTS = ['wraithhide_armor', 'duskiron_sword', 'iron_pickaxe', 'iron_mail', 'iron_sword', 'leather_jerkin', 'copper_sword', 'orb_transmute'];
const POOLED = new Set(['copper_ore', 'iron_ore', 'duskiron_ore', 'pine_log', 'rough_hide', 'stone', 'grain', 'wraith_essence', 'orb_shard', ...REFINES]);

interface Bot {
  id: string;
  focus: SkillId[];
  tools: Partial<Record<string, string>>;
  weapon: string;
  armor: string;
  home?: MapPlot;
  settlementId?: string;
  /** Pools with other working players. */
  team?: Bot[];
  /** A village member who keeps their own materials. */
  keep?: Keep;
  /** keep swap: what is theirs to take back at the next trip. */
  lent: Record<string, number>;
  /** Their own share, taken out when the stockpile filled up. It is not pooled again. */
  share: Record<string, number>;
  worth: Record<string, number>;
  tripMs: number;
  minGain: number;
  outlook: number;
  roam: Roam;
  nextTripAt: number;
  deposited: boolean;
  job?: { id: string; mob: boolean; engaged?: boolean };
  deaths: number;
  bagId?: string;
  /** Value of the crafted gear shelved at the station it was made at. */
  shelved: number;
}

export function simulate(o: SimOptions): SimResult {
  let now = 1_000_000;
  let seq = 0;
  const g = new Game({ dbPath: ':memory:', now: () => now, seed: o.seed, mapSeed: o.map, log: (line) => { throw new Error(line); } });
  try {
    const send = (id: string, type: string, payload: object = {}) => g.execute(id, { commandId: `c${++seq}`, type, payload }) as any;
    const must = (id: string, type: string, payload: object = {}) => {
      const r = send(id, type, payload);
      if (!r.ok) throw new Error(`${o.side} ${type}: ${r.error.code}: ${r.error.message}`);
      return r.result;
    };
    const player = (b: { id: string }): Player => g.players.get(b.id)!;
    const place = (id: string, at: { x: number; y: number }) => {
      const p = g.players.get(id)!;
      Object.assign(p, { pos: { x: at.x, y: at.y }, zone: regionAt(g.map, at), travel: null });
    };
    const values: Record<string, number> = VALUES[o.values];
    const build = BUILDS[o.build];
    const startingGear = new Set<string>();
    const bagWorth = (bag: Record<string, number>) => {
      let n = 0;
      for (const [item, qty] of Object.entries(bag)) if (!startingGear.has(item)) n += (values[baseOf(item)] ?? 0) * qty;
      return n;
    };

    let serial = 0;
    const gear = (p: Player, base: string) => {
      let item: string = base;
      if (build.perfect) {
        item = `${base}${UNIQUE_SEP}${(++serial).toString(16).padStart(8, '0')}`;
        const affixes = Object.values(AFFIXES).filter((a) => a.group === gearGroup(base)).slice(0, 4).map((a) => ({ id: a.id, tier: 3, value: AFFIX_RANGES[a.id][2][1] }));
        g.uniques.set(item, { id: item, base, ilvl: 60, rarity: 'rare', affixes, mods: 4, corrupted: false, craftedBy: 'test', craftedAt: now });
      }
      p.inventory[item] = 1;
      startingGear.add(item);
      return item;
    };

    const bots: Bot[] = o.strategy.focus.map((focus, i) => {
      const p = g.players.get(g.register(`Worker${i}`).playerId)!;
      p.focus = [...focus];
      for (const s of SKILLS) p.skills[s] = 10 * build.level * build.level;
      p.inventory.silver = build.purse;
      const tools: Bot['tools'] = {};
      const byFamily: Record<string, string> = {};
      for (const [job, family] of Object.entries(TOOL_FAMILIES)) if (family) tools[job] = byFamily[family] ??= gear(p, `${build.metal}_${family}`);
      const weapon = gear(p, build.sword);
      const armor = gear(p, build.armor);
      must(p.id, 'equip', { item: weapon });
      must(p.id, 'equip', { item: armor });
      const own = (o.side === 'exile' || o.side === 'freeRider') && i === 3 ? o.strategy.exiled : undefined;
      return { id: p.id, focus, tools, weapon, armor, worth: {}, share: {}, tripMs: own?.tripMs ?? o.strategy.tripMs, minGain: own?.minGain ?? o.strategy.minGain, outlook: own?.outlook ?? o.strategy.outlook ?? 0.8, roam: o.strategy.roam?.[i] ?? 'any', lent: {}, nextTripAt: 0, deposited: false, deaths: 0, shelved: 0 };
    });

    // Settlements, founded and built with the real commands.
    const groups: Bot[][] = o.side === 'solo' ? [] : ['village', 'separate', 'freeRider'].includes(o.side) ? [bots] : o.side === 'exile' ? [bots.slice(0, 3)] : bots.map((b) => [b]);
    const buildings = o.strategy.buildings ?? ['workshop', 'forge_hall', 'farm'];
    let setupCost = 0;
    let builderMs = 0;
    groups.forEach((members, n) => {
      const lead = members[0];
      const home = g.map.plots[n];
      place(lead.id, home);
      const p = player(lead);
      const pay = (cost: { item: string; qty: number }[]) => {
        for (const c of cost) { p.inventory[c.item] = (p.inventory[c.item] ?? 0) + c.qty; setupCost += (values[c.item] ?? 0) * c.qty; }
      };
      pay(SETTLEMENT.foundCost);
      const sid = must(lead.id, 'settlement.found', { name: `Hold ${n}`, plotId: home.id }).settlement.id as string;
      const join = (id: string) => { must(lead.id, 'settlement.invite', { playerId: id }); must(id, 'settlement.join', { settlementId: sid }); };
      for (const m of members.slice(1)) { join(m.id); place(m.id, home); }
      if (o.side === 'altFounders') for (const k of [1, 2]) join(g.register(`Alt${n}x${k}`).playerId);
      must(lead.id, 'settlement.setCharter', { withdrawRole: 'member' });
      const trained = p.skills.construction ?? 0;
      p.skills.construction = Math.max(trained, 40);
      must(lead.id, 'equip', { item: lead.tools.construction });
      for (const b of buildings) {
        pay(BUILDINGS[b].cost);
        must(lead.id, 'settlement.contribute', { building: b });
        for (;;) {
          p.busyUntil = 0;
          const r = must(lead.id, 'settlement.build', { building: b });
          builderMs += r.busyMs;
          if (r.built) break;
        }
      }
      p.skills.construction = trained;
      if (p.wear) p.wear = {};
      p.busyUntil = 0;
      const team = o.side === 'separate' ? [] : o.side === 'freeRider' ? members.slice(0, 3) : members.length > 1 ? members : [];
      for (const m of members) {
        m.settlementId = sid;
        m.home = home;
        if (team.includes(m)) m.team = team;
        else if (members.length > 1) {
          m.keep = o.strategy.keep ?? 'own';
          if (m.keep === 'swap') m.tripMs = Math.min(m.tripMs, SETTLEMENT.sharedWork.restMs / 2);
        }
      }
    });

    const intervals = o.reserveIntervals ?? Math.ceil(o.minutes * 60_000 / SETTLEMENT.upkeepMs);
    const keep: Record<string, number> = {};
    if (groups.length) for (const id of buildings) for (const u of BUILDINGS[id].upkeep) keep[u.item] = (keep[u.item] ?? 0) + u.qty * intervals;
    for (const s of g.settlements.values()) {
      Object.assign(s.stockpile, keep);
      // Upkeep and income fall due from the first moment, so a run pays for every interval it covers.
      for (const b of s.buildings) b.paidUntil = now;
      s.nextIncomeAt = now;
    }

    const focusedIn = (b: Bot, skill: SkillId) => (b.team ?? []).filter((x) => x.focus.includes(skill));
    // Shared work needs someone else who can refine it. Without one, a member keeps that material and refines it alone.
    const sharesOut = (b: Bot, r: RecipeDef) => !!b.team && r.inputs.some((i) => SHARED_ITEMS.has(i.item))
      && (!r.requiresFocus || focusedIn(b, r.skill).some((x) => x !== b));
    const pools = (b: Bot, item: string) => {
      if (!b.team || !POOLED.has(item)) return false;
      if (!SHARED_ITEMS.has(item)) return !o.strategy.skim;
      const r = RECIPES[REFINES.find((id) => RECIPES[id].inputs.some((i) => i.item === item))!];
      return sharesOut(b, r) || !b.focus.includes(r.skill);
    };
    const expectedOutput = (b: Bot, r: RecipeDef, giver?: Bot) => {
      const p = player(b);
      let n = 1 + (b.focus.includes(r.skill) ? Math.min(SKILL_ODDS.maxBonusOutput, SKILL_ODDS.bonusOutputPerLevel * Math.max(10, skillLevel(p, r.skill))) : 0);
      if (r.kind === 'refine') {
        if (build.perfect) n += AFFIX_RANGES.refine_output[2][1] / 100;
        // Pooled, every unit is refined by someone other than who gave it, unless the giver alone can refine it.
        if (b.team && r.inputs.some((i) => SHARED_ITEMS.has(i.item)) && (!giver || sharesOut(giver, r))) {
          n *= 1 + SETTLEMENT.sharedWork.outputPct / 100;
        }
      }
      return n;
    };
    const someoneFocused = (b: Bot, skill: SkillId) => (b.team ?? [b]).some((x) => x.focus.includes(skill));
    // What a material is worth to this player once the chain behind it is finished.
    for (const b of bots) {
      b.worth = { ...values };
      for (const id of [...CRAFTS, ...REFINES]) {
        const r = RECIPES[id];
        if (r.requiresFocus && !someoneFocused(b, r.skill)) continue;
        const doer = (b.team ?? [b]).find((x) => x.focus.includes(r.skill)) ?? b;
        const out = (r.kind === 'refine' ? b.worth[id] : values[id]) * expectedOutput(doer, r, b);
        const cost = r.inputs.reduce((n, i) => n + values[i.item] * i.qty, 0);
        if (out > cost) for (const i of r.inputs) b.worth[i.item] = Math.max(b.worth[i.item], values[i.item] * (1 + (out / cost - 1) * b.outlook));
      }
    }
    const recipesOf = (b: Bot) => {
      const p = player(b);
      return [...REFINES, ...CRAFTS, ...(b.settlementId && buildings.includes('kitchen') ? ['ration'] : [])]
        .map((id) => RECIPES[id])
        .filter((r) => {
          const focused = b.focus.includes(r.skill);
          if (r.requiresFocus && !focused) return false;
          if (skillLevel(p, r.skill) < r.minLevel) return false;
          if (TOOL_FAMILIES[r.skill] && (ITEMS[baseOf(b.tools[r.skill]!)].toolTier ?? 0) < requiredToolTier(r.tier)) return false;
          // The altar is in town, away from the village's stockpile.
          if (b.team && r.station === 'altar') return false;
          // A lone specialist's own materials need an unskilled hand: theirs earn no shared work.
          return focused || !b.team || !someoneFocused(b, r.skill) || (r.kind === 'refine' && focusedIn(b, r.skill).length === 1);
        })
        .map((r) => {
          const cost = r.inputs.reduce((n, i) => n + values[i.item] * i.qty, 0);
          const gain = (r.kind === 'refine' ? b.worth[r.output.item] : values[r.output.item]) * expectedOutput(b, r) - cost;
          const secs = (r.kind === 'refine' ? 1.2 : 2) * (b.focus.includes(r.skill) ? 0.5 : 0.85);
          return { r, rate: r.output.item === FOOD.item ? 1e6 : gain / secs };
        })
        .filter((x) => x.rate > b.minGain)
        .sort((a, z) => z.rate - a.rate);
    };
    let recipes = new Map(bots.map((b) => [b.id, recipesOf(b)] as const));

    const holdings = (b: Bot) => {
      const p = player(b);
      const worn: Record<string, number> = {};
      for (const item of Object.values(p.equipment)) if (item) worn[item] = 1;
      return b.shelved + bagWorth(p.inventory) + bagWorth(worn);
    };
    const pooledWorth = () => [...g.settlements.values()].reduce((n, s) => n + bagWorth(s.stockpile), 0);
    const startEach = bots.map(holdings);
    const startPool = pooledWorth();

    const end = now + o.minutes * 60_000;
    bots.forEach((b, i) => { b.nextTripAt = now + (i + 1) * Math.min(12_000, b.tripMs / 5); });
    const claimed = new Set<string>();
    let stockTime = 0;
    let stockSum = 0;
    let samples = 0;
    const sampleFrom = now + (o.stockpileFromMinute ?? 0) * 60_000;
    let lapsed = false;
    let sharedUnits = 0;
    const earned = () => {
      const wear = bots.map((b) => Object.entries(player(b).wear ?? {}).reduce((n, [item, w]) => n + repairCost(item, w), 0));
      return { each: bots.map((b, i) => holdings(b) - startEach[i] - wear[i]), pool: pooledWorth() - startPool };
    };
    const warmEnd = now + (o.warmMinutes ?? 0) * 60_000;
    let warm: ReturnType<typeof earned> | undefined;

    const act = (b: Bot) => {
      const p = player(b);
      if (p.travel || p.busyUntil > now) return;
      const drop = () => { if (b.job) claimed.delete(b.job.id); b.job = undefined; };

      // Died: walk back for the bag, then dress.
      if (p.stats.deaths > b.deaths) {
        b.deaths = p.stats.deaths;
        drop();
        b.bagId = [...g.bags.values()].filter((bag) => bag.ownerId === b.id).sort((x, y) => y.createdAt - x.createdAt)[0]?.id;
      }
      if (b.bagId) {
        const bag = g.bags.get(b.bagId);
        if (!bag) { b.bagId = undefined; } else if (dist(p.pos, { x: bag.x!, y: bag.y! }) > MAP_RULES.range.interact) {
          send(b.id, 'move', { to: bag.id });
          return;
        } else {
          send(b.id, 'loot', { bagId: bag.id });
          for (const item of [b.weapon, b.armor]) if (p.inventory[item]) send(b.id, 'equip', { item });
          b.bagId = undefined;
          return;
        }
      }
      if (b.settlementId && (p.wellFedUntil ?? 0) <= now && p.inventory[FOOD.item]) { send(b.id, 'eat'); return; }

      const s = b.settlementId ? g.settlements.get(b.settlementId) : undefined;
      /** A village shares out only the bars that don't fit. */
      const makeRoom = (adding: number) => {
        if (!s || !b.team) return;
        const cap = capacityOf(s);
        let over = units(s.stockpile) + adding - cap;
        if (over <= 0) return;
        over += Math.floor(cap / 20);
        const surplus = REFINES.map((item) => ({ item, qty: (s.stockpile[item] ?? 0) - (keep[item] ?? 0) })).filter((x) => x.qty > 0).sort((x, y) => y.qty - x.qty);
        for (const x of surplus) {
          const qty = Math.min(over, x.qty);
          if (qty <= 0) continue;
          must(b.id, 'stockpile.withdraw', { items: [{ item: x.item, qty }] });
          b.share[x.item] = (b.share[x.item] ?? 0) + qty;
          over -= qty;
        }
      };
      if (now >= b.nextTripAt && !b.job?.engaged) {
        drop();
        const goTown = () => {
          const anchor = g.map.anchors.town;
          if (p.zone === 'town' && dist(p.pos, anchor) <= 1) return true;
          send(b.id, 'move', p.zone === 'town' ? { x: anchor.x, y: anchor.y } : { to: 'town' });
          return false;
        };
        const atHome = () => !!b.home && p.zone === b.home.region && dist(p.pos, b.home) <= MAP_RULES.range.plot;
        if (s && !b.deposited) {
          if (!atHome()) {
            if (!send(b.id, 'move', { to: b.home!.id }).ok) b.nextTripAt = now + 1000;
            return;
          }
          // A village pools everything that refines. A founder only tops up the upkeep reserve.
          for (const [item, qty] of Object.entries(b.lent)) {
            const back = Math.min(qty, s.stockpile[item] ?? 0);
            if (back) send(b.id, 'stockpile.withdraw', { items: [{ item, qty: back }] });
          }
          b.lent = {};
          const items: { item: string; qty: number }[] = [];
          const tried: { item: string; qty: number }[] = [];
          for (const [item, have] of Object.entries(p.inventory)) {
            if (b.share[item]) b.share[item] = Math.min(b.share[item], have);
            const trick = !!b.keep && b.keep !== 'own' && SHARED_ITEMS.has(item);
            const qty = trick ? have
              : b.team && POOLED.has(item) ? (pools(b, item) ? have - (b.share[item] ?? 0) : 0)
                : Math.min(have, Math.max(0, (keep[item] ?? 0) - (s.stockpile[item] ?? 0)));
            if (qty > 0) items.push({ item, qty });
            if (trick && qty > 0) tried.push({ item, qty });
          }
          makeRoom(items.reduce((n, i) => n + i.qty, 0));
          if (items.length && send(b.id, 'stockpile.deposit', { items }).ok && tried.length) {
            if (b.keep === 'cycle') must(b.id, 'stockpile.withdraw', { items: tried });
            else for (const i of tried) b.lent[i.item] = i.qty;
          }
          b.deposited = true;
        }
        const unreserved = (item: string) => (s ? Math.max(0, (s.stockpile[item] ?? 0) - (keep[item] ?? 0)) : 0);
        // What may be withdrawn to work on. Raw materials stay: taken out, they would pay no shared work.
        const spare = (item: string) => ((b.team && !SHARED_ITEMS.has(item)) || item === 'grain' ? unreserved(item) : 0);
        /** Batches of `r` the stockpile lets this member refine with shared work, as stockpile.view would show. */
        const sharedBatches = (r: RecipeDef) => {
          if (!s || r.kind !== 'refine' || !(b.team || b.keep)) return 0;
          if (!r.inputs.some((i) => SHARED_ITEMS.has(i.item))) return 0;
          const hands = focusedIn(b, r.skill);
          // Leave to a specialist what a specialist can take.
          const mine = (giver: string) => giver !== b.id && (b.focus.includes(r.skill) || !hands.some((x) => x.id !== giver));
          let n = 10;
          for (const i of r.inputs) {
            let have = 0;
            if (SHARED_ITEMS.has(i.item)) {
              for (const id in s.work) if (mine(id)) for (const lot of s.work[id].given?.[i.item] ?? []) if (lot.readyAt <= now) have += lot.qty;
            } else have = unreserved(i.item);
            n = Math.min(n, Math.floor(have / i.qty));
          }
          return n;
        };
        const homeHas = (r: RecipeDef) => !!s?.buildings.some((x) => !x.unpaid && BUILDINGS[x.id].stations?.includes(r.station));
        const own = (r: RecipeDef) => r.inputs.every((i) => (p.inventory[i.item] ?? 0) + (homeHas(r) ? spare(i.item) : 0) >= i.qty)
          // Unskilled hands only finish what a specialist gave.
          && !(r.kind === 'refine' && b.team && !b.focus.includes(r.skill) && someoneFocused(b, r.skill));
        const doable = recipes.get(b.id)!.map((x) => ({ ...x, batches: homeHas(x.r) ? sharedBatches(x.r) : 0 }))
          .filter(({ r, batches }) => batches > 0 || (own(r) && (r.station !== 'kitchen' || homeHas(r))));
        const next = doable.find(({ r }) => homeHas(r)) ?? doable[0];
        if (next) {
          const { r, batches } = next;
          const home = homeHas(r);
          if (home) {
            if (!atHome()) { send(b.id, 'move', { to: b.home!.id }); return; }
          } else {
            const station = placeOf(g.map, r.station)!;
            if (p.zone !== 'town' || dist(p.pos, station) > MAP_RULES.range.place) {
              if (!send(b.id, 'move', { to: r.station }).ok) b.nextTripAt = now + 1000;
              return;
            }
          }
          const tool = b.tools[r.skill];
          if (tool && p.equipment.tool !== tool && !send(b.id, 'equip', { item: tool }).ok) { b.nextTripAt = now + 5000; return; }
          if (batches > 0) {
            makeRoom(0);
            const out = send(b.id, 'refine', { recipeId: r.id, count: batches, from: 'stockpile' });
            if (!out.ok) { b.nextTripAt = now + 1000; return; }
            sharedUnits += out.result.shared.units;
            if (o.strategy.skim) {
              const item = r.output.item;
              // Duskiron needs iron bars in the stockpile.
              const qty = Math.min(out.result.output.qty, unreserved(item) - (item === 'iron_bar' ? 100 : 0));
              if (qty > 0) { must(b.id, 'stockpile.withdraw', { items: [{ item, qty }] }); b.share[item] = (b.share[item] ?? 0) + qty; }
            }
            return;
          }
          const count = Math.min(10, ...r.inputs.map((i) => Math.floor(((p.inventory[i.item] ?? 0) + (home ? spare(i.item) : 0)) / i.qty)));
          const draw = r.inputs.map((i) => ({ item: i.item, qty: i.qty * count - (p.inventory[i.item] ?? 0) })).filter((i) => i.qty > 0);
          if (draw.length) must(b.id, 'stockpile.withdraw', { items: draw });
          const made = send(b.id, r.kind, { recipeId: r.id, count });
          if (!made.ok) { b.nextTripAt = now + 1000; return; }
          // Crafted gear is priced and put aside: thousands of uniques in an inventory would make a long run crawl.
          for (const u of made.result.items ?? []) {
            b.shelved += values[u.base] ?? 0;
            delete p.inventory[u.id];
            g.uniques.delete(u.id);
            g.markUnique(u);
          }
          if (made.result.items) g.markPlayer(p);
          if (s && home && r.kind === 'refine') {
            const out = r.output.item;
            const have = p.inventory[out] ?? 0;
            const qty = b.team && pools(b, out) ? Math.max(0, have - (b.share[out] ?? 0)) : Math.min(have, Math.max(0, (keep[out] ?? 0) - (s.stockpile[out] ?? 0)));
            if (qty > 0) send(b.id, 'stockpile.deposit', { items: [{ item: out, qty }] });
          }
          return;
        }
        if (Object.values(p.equipment).some((item) => item && (p.wear?.[item] ?? 0) >= WEAR.max * 0.6)) {
          const hall = s?.buildings.some((x) => x.id === 'forge_hall' && !x.unpaid);
          if (hall) {
            if (!atHome()) { send(b.id, 'move', { to: b.home!.id }); return; }
          } else if (!goTown()) return;
          send(b.id, 'repair');
        }
        b.nextTripAt = now + b.tripMs;
        b.deposited = false;
        return;
      }

      const alive = (id: string) => { const m = g.mobs.get(id); return !!m && m.hp > 0 && m.deadUntil <= now; };
      if (b.job && !(b.job.mob ? alive(b.job.id) : g.nodes.get(b.job.id)!.charges > 0)) drop();
      const hp = p.hp / g.maxHp(p);
      if (hp < 0.35 && !b.job?.engaged) return;
      if (!b.job) {
        // The upkeep's stone has to be mined by somebody.
        const short = !!s && (keep.stone ?? 0) > (s.stockpile.stone ?? 0) + (b.team ?? [b]).reduce((n, x) => n + (player(x).inventory.stone ?? 0), 0);
        let best = 0;
        const roams = (zone: string) => b.roam === 'any' || (b.roam === 'frontier') === (zone === 'frontier');
        for (const n of g.nodes.values()) {
          if (!n.charges || !roams(n.zone) || claimed.has(n.id) || (n.zone !== p.zone && p.combatLockUntil > now)) continue;
          const def = NODE_TYPES[n.type];
          if ((ITEMS[baseOf(b.tools[def.skill]!)].toolTier ?? 0) < requiredToolTier(def.tier)) continue;
          const level = skillLevel(p, def.skill);
          const charges = Math.min(n.charges, 8);
          let qty = 1 + Math.min(SKILL_ODDS.maxBonusYield, SKILL_ODDS.bonusYieldPerLevel * level);
          if (build.perfect) qty = (qty + 0.4) * 1.18;
          let score = (b.worth[def.item] * qty * charges) / (Math.max(0, dist(p.pos, n) - 1.5) * 0.3 + charges * 1.5 * Math.max(0.5, 1 - 0.05 * level) + 0.4);
          if (short && def.item === 'stone') score += 1000;
          if (score > best) { best = score; b.job = { id: n.id, mob: false }; }
        }
        for (const m of g.mobs.values()) {
          const def = MOB_TYPES[m.type];
          if (def.boss || !roams(m.zone) || !alive(m.id) || claimed.has(m.id) || m.targetId || (m.zone !== p.zone && p.combatLockUntil > now)) continue;
          const weapon = p.equipment.weapon ? ITEMS[baseOf(p.equipment.weapon)] : undefined;
          const damage = (weapon?.power ?? 4) * (1 + 0.03 * skillLevel(p, 'swords')) * (build.perfect ? 1.25 : 1);
          const hits = Math.max(1, Math.ceil(def.hp / damage) - 1);
          // Don't start a fight that costs more than half of what is left.
          if (Math.floor(hits / 1.5) * def.damage > p.hp * 0.5) continue;
          const loot = MOB_LOOT[m.type];
          let reward = (loot.silver[0] + loot.silver[1]) / 2;
          for (const d of loot.drops) reward += (b.worth[d.item] ?? 0) * d.chance * (d.min + d.max) / 2;
          const score = reward / (Math.max(0, dist(p.pos, m) - 1.5) * 0.3 + hits + 0.4);
          if (score > best) { best = score; b.job = { id: m.id, mob: true }; }
        }
        if (!b.job) return;
        claimed.add(b.job.id);
      }
      const job = b.job;
      const target = job.mob ? g.mobs.get(job.id)! : g.nodes.get(job.id)!;
      if (dist(p.pos, target) > MAP_RULES.range.interact) {
        if (!send(b.id, 'move', { to: target.id }).ok) drop();
        return;
      }
      const jobType = job.mob ? 'skinning' : NODE_TYPES[target.type].skill;
      const tool = b.tools[jobType]!;
      if (p.equipment.tool !== tool || !equippedToolTier(p, jobType)) {
        if (!send(b.id, 'equip', { item: tool }).ok && !job.mob) { drop(); return; }
      }
      const r = send(b.id, job.mob ? 'attack' : 'gather', job.mob ? { targetId: target.id } : { nodeId: target.id });
      if (r.ok && job.mob) {
        job.engaged = !r.result.killed;
        if (r.result.killed) drop();
      } else if (!r.ok && r.error.code !== 'BUSY') drop();
    };

    let refreshAt = now;
    while (now < end) {
      if (o.warmMinutes && !warm && now >= warmEnd) warm = earned();
      if (now >= refreshAt) {
        // Skills level during a run and open recipes.
        recipes = new Map(bots.map((b) => [b.id, recipesOf(b)] as const));
        refreshAt = now + 30_000;
      }
      for (const b of bots) act(b);
      let next = now + 200;
      for (const b of bots) {
        const p = player(b);
        if (!p.travel && p.busyUntil > now) next = Math.min(next, p.busyUntil);
      }
      next = Math.max(next, now + 25);
      if (groups.length) {
        for (const s of g.settlements.values()) {
          if (s.buildings.some((b) => b.unpaid)) lapsed = true;
          // Sampled each second: pricing every step would cost more than playing it.
          if (now >= stockTime && now >= sampleFrom) stockSum += bagWorth(s.stockpile);
        }
        if (now >= stockTime) {
          if (now >= sampleFrom) samples++;
          stockTime = now + 1000;
        }
      }
      now = next;
      g.tick();
    }

    const last = earned();
    const warmHours = warm ? o.warmMinutes! / 60 : 0;
    const rate = (total: number, atWarm = 0) => (total - atWarm) / (o.minutes / 60 - warmHours);
    /** Per hour over the first AMORTIZE_HOURS: the warm-up as played, then the rate after it. */
    const hourly = (total: number, atWarm = 0) =>
      (warm ? (atWarm + rate(total, atWarm) * (AMORTIZE_HOURS - warmHours)) / AMORTIZE_HOURS : rate(total));
    const each = last.each.map((x, i) => hourly(x, warm?.each[i]));
    const pooled = hourly(last.pool, warm?.pool);
    const gross = (each.reduce((n, x) => n + x, 0) + pooled) / bots.length;
    const steady = (last.each.reduce((n, x, i) => n + rate(x, warm?.each[i]), 0) + rate(last.pool, warm?.pool)) / bots.length;
    // Building takes time that would otherwise have earned at this rate.
    const buildTime = (builderMs / 3_600_000) * Math.max(0, gross);
    const setup = (setupCost + buildTime) / AMORTIZE_HOURS / bots.length;
    return {
      perHour: gross - setup,
      each,
      pooled,
      steady,
      shared: sharedUnits,
      deaths: bots.reduce((n, b) => n + player(b).stats.deaths, 0),
      stockpile: groups.length ? stockSum / Math.max(1, samples) / groups.length : 0,
      stockpileEnd: groups.length ? pooledWorth() / groups.length : 0,
      lapsed,
    };
  } finally {
    g.close();
  }
}
