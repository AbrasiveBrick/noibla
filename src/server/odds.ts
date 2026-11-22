// Server-only odds. Every probability in the game lives here: drop rates and silver ranges, bonus-output and
// bonus-yield chances, affix tier weights and value ranges, orb outcome odds. Nothing in this file is sent to players
// (catalog, observations, events, hints) or shipped in the agent sandbox image (which copies only src/shared and src/sdk).
// The operator dashboard may show it.

import { AFFIXES, AFFIX_TIER_MIN_ILVL, gearGroup } from '../shared/catalog.ts';

export interface DropOdds { item: string; min: number; max: number; chance: number; skin?: boolean }
export interface MobLoot { silver: [number, number]; drops: DropOdds[] }

export const MOB_LOOT: Record<string, MobLoot> = {
  wolf: { silver: [6, 10], drops: [{ item: 'rough_hide', min: 1, max: 2, chance: 1, skin: true }, { item: 'orb_shard', min: 1, max: 1, chance: 0.12 }, { item: 'orb_transmute', min: 1, max: 1, chance: 0.02 }, { item: 'orb_alteration', min: 1, max: 1, chance: 0.015 }] },
  boar: { silver: [12, 20], drops: [{ item: 'rough_hide', min: 2, max: 2, chance: 1, skin: true }, { item: 'orb_shard', min: 1, max: 2, chance: 0.15 }, { item: 'orb_augment', min: 1, max: 1, chance: 0.02 }, { item: 'orb_scour', min: 1, max: 1, chance: 0.005 }, { item: 'orb_annul', min: 1, max: 1, chance: 0.004 }] },
  wraith: { silver: [30, 50], drops: [{ item: 'wraith_essence', min: 1, max: 1, chance: 1 }, { item: 'orb_shard', min: 1, max: 3, chance: 0.3 }, { item: 'orb_regal', min: 1, max: 1, chance: 0.03 }, { item: 'orb_chaos', min: 1, max: 1, chance: 0.03 }, { item: 'orb_vaal', min: 1, max: 1, chance: 0.02 }] },
  elder_bear: { silver: [80, 120], drops: [{ item: 'bear_pelt', min: 3, max: 4, chance: 1 }, { item: 'rough_hide', min: 4, max: 6, chance: 1 }, { item: 'orb_shard', min: 2, max: 4, chance: 1 }] },
  ash_wyrm: { silver: [200, 300], drops: [{ item: 'wyrm_scale', min: 3, max: 5, chance: 1 }, { item: 'wraith_essence', min: 2, max: 4, chance: 1 }, { item: 'orb_shard', min: 4, max: 8, chance: 1 }, { item: 'orb_regal', min: 1, max: 1, chance: 0.15 }, { item: 'orb_chaos', min: 1, max: 1, chance: 0.15 }] },
};

/** Skill perks that are chances: gathering bonus yield per level (fraction rolls) and focused bonus output per unit. */
export const SKILL_ODDS = {
  bonusYieldPerLevel: 0.1,
  maxBonusYield: 2,
  bonusOutputPerLevel: 0.05,
  maxBonusOutput: 0.5,
};

/** Building perks that are chances: the workshop's extra output per unit refined there. */
export const BUILDING_ODDS = { workshopOutput: 0.1 };

/** Affix value range [min, max] per tier (index 0 = tier 1). */
export const AFFIX_RANGES: Record<string, [[number, number], [number, number], [number, number]]> = {
  damage: [[4, 8], [9, 15], [16, 25]],
  max_hp: [[5, 10], [11, 20], [21, 35]],
  attack_speed: [[3, 5], [6, 9], [10, 15]],
  guard: [[5, 10], [11, 18], [19, 30]],
  gather_speed: [[4, 8], [9, 14], [15, 22]],
  yield: [[5, 12], [13, 25], [26, 40]],
  double_drop: [[3, 6], [7, 11], [12, 18]],
  durable: [[10, 20], [21, 35], [36, 55]],
  shard_find: [[2, 4], [5, 7], [8, 12]],
  refine_output: [[4, 8], [9, 15], [16, 25]],
  save_inputs: [[3, 6], [7, 11], [12, 18]],
  refine_speed: [[5, 10], [11, 18], [19, 28]],
  build_speed: [[5, 10], [11, 18], [19, 28]],
  build_xp: [[5, 10], [11, 20], [21, 35]],
  build_durable: [[10, 20], [21, 35], [36, 55]],
  craft_ilvl: [[1, 2], [3, 5], [6, 9]],
  mod_odds: [[5, 10], [11, 20], [21, 35]],
  orb_fee: [[5, 10], [11, 20], [21, 35]],
};
/** Relative odds of each allowed tier when an affix rolls (higher tiers are rarer). */
export const AFFIX_TIER_WEIGHT = [6, 3, 1];

/** Orb odds. Luck = hammer mod_odds% + luckPerLevel × enchanting level, capped at maxLuck. */
export const ORB_ODDS = {
  luckPerLevel: 0.01,
  maxLuck: 0.5,
  /** Vaal outcome odds before luck: better, bricked (luck moves bricked odds into better). */
  vaal: { better: 0.25, bricked: 0.25 },
  /** Chance an Alteration rolls a second affix, and a Chaos a fourth. */
  extraAffixChance: 0.35,
};

/**
 * Rolls one affix for a base: an id from its group's pool not already on the item, a tier allowed by `ilvl`
 * (weighted toward low tiers; `luck` in [0, 1) shifts weight toward high tiers), and a value in that tier's range.
 * Returns null when no affix is left to roll. `rng` returns [0, 1).
 */
export function rollAffix(rng: () => number, base: string, ilvl: number, exclude: string[], luck = 0): { id: string; tier: number; value: number } | null {
  const group = gearGroup(base);
  const pool = Object.values(AFFIXES).filter((a) => a.group === group && !exclude.includes(a.id));
  if (!pool.length) return null;
  const def = pool[Math.floor(rng() * pool.length)];
  const allowed = AFFIX_TIER_MIN_ILVL.map((m, i) => (ilvl >= m ? i : -1)).filter((i) => i >= 0);
  const weights = allowed.map((i) => AFFIX_TIER_WEIGHT[i] * (1 + luck * 3 * i));
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  let t = allowed[0];
  for (let k = 0; k < allowed.length; k++) { r -= weights[k]; if (r < 0) { t = allowed[k]; break; } }
  const [lo, hi] = AFFIX_RANGES[def.id][t];
  return { id: def.id, tier: t + 1, value: lo + Math.floor(rng() * (hi - lo + 1)) };
}

/** Operator view of every odds table (dashboard only). */
export const ODDS = { mobLoot: MOB_LOOT, skill: SKILL_ODDS, buildings: BUILDING_ODDS, affixRanges: AFFIX_RANGES, affixTierWeight: AFFIX_TIER_WEIGHT, orbs: ORB_ODDS };
