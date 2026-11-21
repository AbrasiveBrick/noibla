// Static game data shared by the server and the SDK.
// Everything here is public knowledge: bots can fetch it with the `catalog` command.

import { STARTERS } from './starters.ts';

export type ZoneId = 'town' | 'wilds' | 'frontier';
export type Safety = 'safe' | 'safe-wild' | 'lethal';
export type StationId = 'smelter' | 'sawmill' | 'tannery' | 'forge' | 'workbench';
export type Slot = 'weapon' | 'armor' | 'tool';
export const SLOTS: Slot[] = ['weapon', 'armor', 'tool'];
export type ItemKind = 'currency' | 'resource' | 'material' | 'tool' | 'weapon' | 'armor';
export type SkillId =
  | 'mining' | 'woodcutting'
  | 'smelting' | 'woodworking' | 'tanning'
  | 'toolcraft' | 'weaponcraft' | 'armorcraft'
  | 'swords' | 'unarmed';
/** What a tool is for. `skinning` is the hide harvest when you kill a beast; the rest are skills. */
export type ToolJob = SkillId | 'skinning';
export type AbilityId = 'punch' | 'slash' | 'heavy_strike' | 'evade' | 'brace';

export interface ItemStack { item: string; qty: number }

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  tier: number;
  /** Only obtainable in the lethal frontier (gathered or dropped there). */
  frontierExclusive?: boolean;
  slot?: Slot;
  /** Weapons: base damage of weapon abilities. */
  power?: number;
  /** Armor: fraction of incoming damage removed. */
  defense?: number;
  /** Armor: extra max HP. */
  hpBonus?: number;
  /** Tools: tier. A job of tier T (node, recipe, beast) needs the matching tool of tier >= max(1, T-1) equipped in the tool slot. */
  toolTier?: number;
  /** Tools: the job(s) this tool does. */
  toolFor?: ToolJob[];
  /** Abilities granted while equipped. */
  abilities?: AbilityId[];
  weaponSkill?: SkillId;
  description: string;
}

/** Crafted gear is unique: its id is `<base>#<suffix>` (for example `iron_sword#3f9a1c2b`). Stackable items use the plain id. */
export const UNIQUE_SEP = '#';
export function baseOf(id: string): string { const i = id.indexOf(UNIQUE_SEP); return i < 0 ? id : id.slice(0, i); }
export function isUnique(id: string): boolean { return id.includes(UNIQUE_SEP); }
/** Item definition for a plain or unique id. */
export function itemDef(id: string): ItemDef | undefined { return ITEMS[baseOf(id)]; }

export const ITEMS: Record<string, ItemDef> = {
  silver: { id: 'silver', name: 'Silver', kind: 'currency', tier: 0, description: 'Currency. Dropped by mobs and paid by quests.' },
  // Raw resources
  copper_ore: { id: 'copper_ore', name: 'Copper Ore', kind: 'resource', tier: 1, description: 'Mined from copper veins in the wilds.' },
  iron_ore: { id: 'iron_ore', name: 'Iron Ore', kind: 'resource', tier: 2, description: 'Mined from iron veins in the wilds. Needs a T1+ pickaxe.' },
  pine_log: { id: 'pine_log', name: 'Pine Log', kind: 'resource', tier: 1, description: 'Cut from pine groves in the wilds.' },
  rough_hide: { id: 'rough_hide', name: 'Rough Hide', kind: 'resource', tier: 1, description: 'Dropped by wolves and boars in the wilds.' },
  duskiron_ore: { id: 'duskiron_ore', name: 'Duskiron Ore', kind: 'resource', tier: 3, frontierExclusive: true, description: 'Frontier exclusive. Mined from duskiron veins. Needs a T2 pickaxe.' },
  wraith_essence: { id: 'wraith_essence', name: 'Wraith Essence', kind: 'resource', tier: 3, frontierExclusive: true, description: 'Frontier exclusive. Dropped by wraiths.' },
  // Refined materials
  copper_bar: { id: 'copper_bar', name: 'Copper Bar', kind: 'material', tier: 1, description: 'Smelted copper.' },
  iron_bar: { id: 'iron_bar', name: 'Iron Bar', kind: 'material', tier: 2, description: 'Smelted iron.' },
  duskiron_bar: { id: 'duskiron_bar', name: 'Duskiron Bar', kind: 'material', tier: 3, description: 'Smelted from frontier duskiron ore.' },
  pine_plank: { id: 'pine_plank', name: 'Pine Plank', kind: 'material', tier: 1, description: 'Sawn pine.' },
  leather: { id: 'leather', name: 'Leather', kind: 'material', tier: 1, description: 'Tanned hide.' },
  // Tools: equip one in the tool slot. Each job needs its own tool family (see TOOL_FAMILIES).
  copper_pickaxe: { id: 'copper_pickaxe', name: 'Copper Pickaxe', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['mining'], description: 'Tier 1. Mines veins (wilds and frontier).' },
  iron_pickaxe: { id: 'iron_pickaxe', name: 'Iron Pickaxe', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['mining'], description: 'Tier 2. Mines veins (wilds and frontier).' },
  duskiron_pickaxe: { id: 'duskiron_pickaxe', name: 'Duskiron Pickaxe', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['mining'], description: 'Tier 3. Mines veins (wilds and frontier).' },
  copper_axe: { id: 'copper_axe', name: 'Copper Axe', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['woodcutting'], description: 'Tier 1. Chops pine groves.' },
  iron_axe: { id: 'iron_axe', name: 'Iron Axe', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['woodcutting'], description: 'Tier 2. Chops pine groves.' },
  duskiron_axe: { id: 'duskiron_axe', name: 'Duskiron Axe', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['woodcutting'], description: 'Tier 3. Chops pine groves.' },
  copper_skinning_knife: { id: 'copper_skinning_knife', name: 'Copper Skinning Knife', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['skinning'], description: 'Tier 1. Skins beasts you kill: without one equipped they drop no hides.' },
  iron_skinning_knife: { id: 'iron_skinning_knife', name: 'Iron Skinning Knife', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['skinning'], description: 'Tier 2. Skins beasts you kill: without one equipped they drop no hides.' },
  duskiron_skinning_knife: { id: 'duskiron_skinning_knife', name: 'Duskiron Skinning Knife', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['skinning'], description: 'Tier 3. Skins beasts you kill: without one equipped they drop no hides.' },
  copper_tongs: { id: 'copper_tongs', name: 'Copper Tongs', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['smelting'], description: 'Tier 1. Smelts ore into bars at the smelter.' },
  iron_tongs: { id: 'iron_tongs', name: 'Iron Tongs', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['smelting'], description: 'Tier 2. Smelts ore into bars at the smelter.' },
  duskiron_tongs: { id: 'duskiron_tongs', name: 'Duskiron Tongs', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['smelting'], description: 'Tier 3. Smelts ore into bars at the smelter.' },
  copper_saw: { id: 'copper_saw', name: 'Copper Saw', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['woodworking'], description: 'Tier 1. Saws logs into planks at the sawmill.' },
  iron_saw: { id: 'iron_saw', name: 'Iron Saw', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['woodworking'], description: 'Tier 2. Saws logs into planks at the sawmill.' },
  duskiron_saw: { id: 'duskiron_saw', name: 'Duskiron Saw', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['woodworking'], description: 'Tier 3. Saws logs into planks at the sawmill.' },
  copper_hammer: { id: 'copper_hammer', name: 'Copper Hammer', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['toolcraft', 'weaponcraft', 'armorcraft'], description: 'Tier 1. Forges tools, weapons and armor.' },
  iron_hammer: { id: 'iron_hammer', name: 'Iron Hammer', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['toolcraft', 'weaponcraft', 'armorcraft'], description: 'Tier 2. Forges tools, weapons and armor.' },
  duskiron_hammer: { id: 'duskiron_hammer', name: 'Duskiron Hammer', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['toolcraft', 'weaponcraft', 'armorcraft'], description: 'Tier 3. Forges tools, weapons and armor.' },
  copper_needle: { id: 'copper_needle', name: 'Copper Needle', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['tanning'], description: 'Tier 1. Tans hides into leather at the tannery.' },
  iron_needle: { id: 'iron_needle', name: 'Iron Needle', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['tanning'], description: 'Tier 2. Tans hides into leather at the tannery.' },
  duskiron_needle: { id: 'duskiron_needle', name: 'Duskiron Needle', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['tanning'], description: 'Tier 3. Tans hides into leather at the tannery.' },
  // Weapons
  copper_sword: { id: 'copper_sword', name: 'Copper Sword', kind: 'weapon', tier: 1, slot: 'weapon', power: 8, weaponSkill: 'swords', abilities: ['slash', 'heavy_strike'], description: 'Starter sword.' },
  iron_sword: { id: 'iron_sword', name: 'Iron Sword', kind: 'weapon', tier: 2, slot: 'weapon', power: 12, weaponSkill: 'swords', abilities: ['slash', 'heavy_strike'], description: 'Solid sword.' },
  duskiron_sword: { id: 'duskiron_sword', name: 'Duskiron Sword', kind: 'weapon', tier: 3, slot: 'weapon', power: 20, weaponSkill: 'swords', abilities: ['slash', 'heavy_strike'], description: 'Tier 3 blade forged from frontier duskiron.' },
  // Armor
  leather_jerkin: { id: 'leather_jerkin', name: 'Leather Jerkin', kind: 'armor', tier: 1, slot: 'armor', defense: 0.08, hpBonus: 20, abilities: ['evade'], description: 'Light armor. Grants Evade.' },
  iron_mail: { id: 'iron_mail', name: 'Iron Mail', kind: 'armor', tier: 2, slot: 'armor', defense: 0.15, hpBonus: 40, abilities: ['brace'], description: 'Medium armor. Grants Brace.' },
  wraithhide_armor: { id: 'wraithhide_armor', name: 'Wraithhide Armor', kind: 'armor', tier: 3, slot: 'armor', defense: 0.25, hpBonus: 70, abilities: ['evade', 'brace'], description: 'Tier 3 armor woven with wraith essence. Grants Evade and Brace.' },
};

export interface AbilityDef {
  id: AbilityId;
  name: string;
  kind: 'attack' | 'buff';
  /** Attack: damage = weapon power * powerMult (or flatDamage when unarmed). */
  powerMult?: number;
  flatDamage?: number;
  cooldownMs: number;
  /** Buff duration. */
  durationMs?: number;
  description: string;
}

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  punch: { id: 'punch', name: 'Punch', kind: 'attack', flatDamage: 4, cooldownMs: 0, description: 'Always available when no weapon is equipped.' },
  slash: { id: 'slash', name: 'Slash', kind: 'attack', powerMult: 1, cooldownMs: 0, description: 'Basic weapon attack.' },
  heavy_strike: { id: 'heavy_strike', name: 'Heavy Strike', kind: 'attack', powerMult: 2, cooldownMs: 4000, description: 'Double damage, 4s cooldown.' },
  evade: { id: 'evade', name: 'Evade', kind: 'buff', durationMs: 3000, cooldownMs: 10000, description: 'Dodge the next hit within 3s.' },
  brace: { id: 'brace', name: 'Brace', kind: 'buff', durationMs: 4000, cooldownMs: 12000, description: 'Halve incoming damage for 4s.' },
};

export interface RecipeDef {
  id: string;
  kind: 'refine' | 'craft';
  station: StationId;
  skill: SkillId;
  tier: number;
  /** Minimum level in `skill`. */
  minLevel: number;
  /** Only players who have `skill` among their focus skills can make it (see FOCUS). */
  requiresFocus?: boolean;
  inputs: ItemStack[];
  output: ItemStack;
}

const recipe = (r: RecipeDef): RecipeDef => r;

export const RECIPES: Record<string, RecipeDef> = {
  // Refining
  copper_bar: recipe({ id: 'copper_bar', kind: 'refine', station: 'smelter', skill: 'smelting', tier: 1, minLevel: 0, inputs: [{ item: 'copper_ore', qty: 2 }], output: { item: 'copper_bar', qty: 1 } }),
  iron_bar: recipe({ id: 'iron_bar', kind: 'refine', station: 'smelter', skill: 'smelting', tier: 2, minLevel: 1, inputs: [{ item: 'iron_ore', qty: 2 }], output: { item: 'iron_bar', qty: 1 } }),
  duskiron_bar: recipe({ id: 'duskiron_bar', kind: 'refine', station: 'smelter', skill: 'smelting', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_ore', qty: 2 }, { item: 'iron_bar', qty: 1 }], output: { item: 'duskiron_bar', qty: 1 } }),
  pine_plank: recipe({ id: 'pine_plank', kind: 'refine', station: 'sawmill', skill: 'woodworking', tier: 1, minLevel: 0, inputs: [{ item: 'pine_log', qty: 2 }], output: { item: 'pine_plank', qty: 1 } }),
  leather: recipe({ id: 'leather', kind: 'refine', station: 'tannery', skill: 'tanning', tier: 1, minLevel: 0, inputs: [{ item: 'rough_hide', qty: 2 }], output: { item: 'leather', qty: 1 } }),
  // Tools (toolcraft at the forge). Duskiron tools are tier-3 specialist recipes.
  copper_pickaxe: recipe({ id: 'copper_pickaxe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_pickaxe', qty: 1 } }),
  iron_pickaxe: recipe({ id: 'iron_pickaxe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_pickaxe', qty: 1 } }),
  duskiron_pickaxe: recipe({ id: 'duskiron_pickaxe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_pickaxe', qty: 1 } }),
  copper_axe: recipe({ id: 'copper_axe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_axe', qty: 1 } }),
  iron_axe: recipe({ id: 'iron_axe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_axe', qty: 1 } }),
  duskiron_axe: recipe({ id: 'duskiron_axe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_axe', qty: 1 } }),
  copper_skinning_knife: recipe({ id: 'copper_skinning_knife', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 1 }, { item: 'leather', qty: 1 }], output: { item: 'copper_skinning_knife', qty: 1 } }),
  iron_skinning_knife: recipe({ id: 'iron_skinning_knife', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 1 }, { item: 'leather', qty: 1 }], output: { item: 'iron_skinning_knife', qty: 1 } }),
  duskiron_skinning_knife: recipe({ id: 'duskiron_skinning_knife', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 1 }, { item: 'leather', qty: 1 }], output: { item: 'duskiron_skinning_knife', qty: 1 } }),
  copper_tongs: recipe({ id: 'copper_tongs', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_tongs', qty: 1 } }),
  iron_tongs: recipe({ id: 'iron_tongs', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_tongs', qty: 1 } }),
  duskiron_tongs: recipe({ id: 'duskiron_tongs', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_tongs', qty: 1 } }),
  copper_saw: recipe({ id: 'copper_saw', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 1 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_saw', qty: 1 } }),
  iron_saw: recipe({ id: 'iron_saw', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 1 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_saw', qty: 1 } }),
  duskiron_saw: recipe({ id: 'duskiron_saw', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 1 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_saw', qty: 1 } }),
  copper_hammer: recipe({ id: 'copper_hammer', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_hammer', qty: 1 } }),
  iron_hammer: recipe({ id: 'iron_hammer', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_hammer', qty: 1 } }),
  duskiron_hammer: recipe({ id: 'duskiron_hammer', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_hammer', qty: 1 } }),
  copper_needle: recipe({ id: 'copper_needle', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 1 }, { item: 'leather', qty: 1 }], output: { item: 'copper_needle', qty: 1 } }),
  iron_needle: recipe({ id: 'iron_needle', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 1 }, { item: 'leather', qty: 1 }], output: { item: 'iron_needle', qty: 1 } }),
  duskiron_needle: recipe({ id: 'duskiron_needle', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 1 }, { item: 'leather', qty: 1 }], output: { item: 'duskiron_needle', qty: 1 } }),
  // Weapons
  copper_sword: recipe({ id: 'copper_sword', kind: 'craft', station: 'forge', skill: 'weaponcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 3 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_sword', qty: 1 } }),
  iron_sword: recipe({ id: 'iron_sword', kind: 'craft', station: 'forge', skill: 'weaponcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_sword', qty: 1 } }),
  duskiron_sword: recipe({ id: 'duskiron_sword', kind: 'craft', station: 'forge', skill: 'weaponcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_sword', qty: 1 } }),
  // Armor
  leather_jerkin: recipe({ id: 'leather_jerkin', kind: 'craft', station: 'workbench', skill: 'armorcraft', tier: 1, minLevel: 0, inputs: [{ item: 'leather', qty: 3 }], output: { item: 'leather_jerkin', qty: 1 } }),
  iron_mail: recipe({ id: 'iron_mail', kind: 'craft', station: 'forge', skill: 'armorcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'leather', qty: 2 }], output: { item: 'iron_mail', qty: 1 } }),
  wraithhide_armor: recipe({ id: 'wraithhide_armor', kind: 'craft', station: 'workbench', skill: 'armorcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'wraith_essence', qty: 2 }, { item: 'leather', qty: 3 }, { item: 'iron_bar', qty: 1 }], output: { item: 'wraithhide_armor', qty: 1 } }),
};

/** One tool family per job. The tool-slot item must belong to the job's family. */
export const TOOL_FAMILIES: Record<ToolJob, string> = {
  mining: 'pickaxe', woodcutting: 'axe', skinning: 'skinning_knife', smelting: 'tongs', woodworking: 'saw', tanning: 'needle',
  toolcraft: 'hammer', weaponcraft: 'hammer', armorcraft: 'hammer', swords: '', unarmed: '',
};

/** Tool tier a job of tier T needs. */
export const requiredToolTier = (tier: number): number => Math.max(1, tier - 1);

/** Every new player starts with one copper tool of each family. Better tools come from toolcrafters. */
export const STARTER_KIT: ItemStack[] = ['pickaxe', 'axe', 'skinning_knife', 'tongs', 'saw', 'hammer', 'needle'].map((f) => ({ item: `copper_${f}`, qty: 1 }));

export interface NodeDef { id: string; name: string; item: string; tier: number; skill: SkillId; maxCharges: number }
export const NODE_TYPES: Record<string, NodeDef> = {
  copper_vein: { id: 'copper_vein', name: 'Copper Vein', item: 'copper_ore', tier: 1, skill: 'mining', maxCharges: 10 },
  iron_vein: { id: 'iron_vein', name: 'Iron Vein', item: 'iron_ore', tier: 2, skill: 'mining', maxCharges: 10 },
  pine_grove: { id: 'pine_grove', name: 'Pine Grove', item: 'pine_log', tier: 1, skill: 'woodcutting', maxCharges: 10 },
  duskiron_vein: { id: 'duskiron_vein', name: 'Duskiron Vein', item: 'duskiron_ore', tier: 3, skill: 'mining', maxCharges: 6 },
};

/** `skin`: only drops when the killer has a skinning knife equipped (tier >= requiredToolTier(mob tier)). */
export interface DropDef { item: string; min: number; max: number; chance: number; skin?: boolean }
export interface MobDef { id: string; name: string; tier: number; hp: number; damage: number; attackMs: number; silver: [number, number]; drops: DropDef[]; respawnMs: number }
export const MOB_TYPES: Record<string, MobDef> = {
  wolf: { id: 'wolf', name: 'Wolf', tier: 1, hp: 30, damage: 3, attackMs: 1500, silver: [6, 10], drops: [{ item: 'rough_hide', min: 1, max: 2, chance: 1, skin: true }], respawnMs: 6000 },
  boar: { id: 'boar', name: 'Boar', tier: 1, hp: 50, damage: 5, attackMs: 1500, silver: [12, 20], drops: [{ item: 'rough_hide', min: 2, max: 2, chance: 1, skin: true }], respawnMs: 6000 },
  wraith: { id: 'wraith', name: 'Wraith', tier: 3, hp: 80, damage: 10, attackMs: 1500, silver: [30, 50], drops: [{ item: 'wraith_essence', min: 1, max: 1, chance: 1 }], respawnMs: 8000 },
};

export interface ZoneDef {
  id: ZoneId;
  name: string;
  safety: Safety;
  description: string;
  adjacent: ZoneId[];
  stations: StationId[];
  hasBank: boolean;
  hasForum: boolean;
  hasQuestBoard: boolean;
  pvp: boolean;
  /** Death drops carried + equipped items into a loot bag. */
  fullLoot: boolean;
  nodes: { type: string; count: number }[];
  mobs: { type: string; count: number }[];
}

export const ZONES: Record<ZoneId, ZoneDef> = {
  town: {
    id: 'town', name: 'Brightwater (Town)', safety: 'safe', description: 'No combat. Bank, crafting stations, quest board, trade forum.',
    adjacent: ['wilds'], stations: ['smelter', 'sawmill', 'tannery', 'forge', 'workbench'], hasBank: true, hasForum: true, hasQuestBoard: true,
    pvp: false, fullLoot: false, nodes: [], mobs: [],
  },
  wilds: {
    id: 'wilds', name: 'Greenreach (Safe Wilderness)', safety: 'safe-wild', description: 'Basic resources and PvE. Dying here keeps your gear and inventory.',
    adjacent: ['town', 'frontier'], stations: [], hasBank: false, hasForum: false, hasQuestBoard: false,
    pvp: false, fullLoot: false,
    nodes: [{ type: 'copper_vein', count: 2 }, { type: 'iron_vein', count: 3 }, { type: 'pine_grove', count: 2 }],
    mobs: [{ type: 'wolf', count: 3 }, { type: 'boar', count: 3 }],
  },
  frontier: {
    id: 'frontier', name: 'The Ashen Frontier (Lethal)', safety: 'lethal', description: 'Open PvP. Exclusive duskiron and wraith essence. Death drops everything you carry and wear.',
    adjacent: ['wilds'], stations: [], hasBank: false, hasForum: false, hasQuestBoard: false,
    pvp: true, fullLoot: true,
    nodes: [{ type: 'duskiron_vein', count: 2 }],
    mobs: [{ type: 'wraith', count: 3 }],
  },
};

export interface QuestDef {
  id: string;
  name: string;
  description: string;
  /** `deliver`: items you send to another player in settled trades. `procure`: items you receive from another player in settled trades. */
  objective: { kind: 'kill' | 'gather' | 'craft' | 'deliver' | 'procure'; target: string; count: number };
  reward: ItemStack[];
}

export const QUESTS: Record<string, QuestDef> = {
  wolf_cull: { id: 'wolf_cull', name: 'Wolf Cull', description: 'Kill 3 wolves in the wilds.', objective: { kind: 'kill', target: 'wolf', count: 3 }, reward: [{ item: 'silver', qty: 30 }] },
  ore_run: { id: 'ore_run', name: 'Ore Run', description: 'Mine 6 copper ore.', objective: { kind: 'gather', target: 'copper_ore', count: 6 }, reward: [{ item: 'silver', qty: 15 }] },
  apprentice_smith: { id: 'apprentice_smith', name: 'Apprentice Smith', description: 'Craft a copper sword.', objective: { kind: 'craft', target: 'copper_sword', count: 1 }, reward: [{ item: 'silver', qty: 20 }] },
  frontier_hunt: { id: 'frontier_hunt', name: 'Frontier Hunt', description: 'Kill a wraith in the frontier.', objective: { kind: 'kill', target: 'wraith', count: 1 }, reward: [{ item: 'silver', qty: 60 }] },
  // Trade contracts: progress counts only what actually changes hands in settled blind trades with other players.
  supply_contract: { id: 'supply_contract', name: 'Supply Contract', description: 'Deliver 4 iron bars to other players through settled trades.', objective: { kind: 'deliver', target: 'iron_bar', count: 4 }, reward: [{ item: 'silver', qty: 40 }] },
  outfitter_contract: { id: 'outfitter_contract', name: 'Outfitter Contract', description: 'Deliver an iron mail to another player through a settled trade.', objective: { kind: 'deliver', target: 'iron_mail', count: 1 }, reward: [{ item: 'silver', qty: 50 }] },
  hire_a_smith: { id: 'hire_a_smith', name: 'Hire a Smith', description: 'Receive an iron sword from another player through a settled trade.', objective: { kind: 'procure', target: 'iron_sword', count: 1 }, reward: [{ item: 'silver', qty: 30 }] },
  ore_buyer: { id: 'ore_buyer', name: 'Ore Buyer', description: 'Receive 6 iron ore from other players through settled trades.', objective: { kind: 'procure', target: 'iron_ore', count: 6 }, reward: [{ item: 'silver', qty: 25 }] },
};

export const SKILLS: SkillId[] = ['mining', 'woodcutting', 'smelting', 'woodworking', 'tanning', 'toolcraft', 'weaponcraft', 'armorcraft', 'swords', 'unarmed'];

/** Base durations in milliseconds at world speed 1. The server divides them by its speed factor. */
export const TIMING = {
  travelMs: 3000,
  gatherMs: 1500,
  refineMs: 1200,
  craftMs: 2000,
  globalCooldownMs: 1000,
  /** No travel within this long after dealing or taking damage. */
  combatLockMs: 5000,
  outOfCombatMs: 4000,
  regenIntervalMs: 1000,
  regenFraction: 0.04,
  nodeRegenMs: 6000,
  lootBagTtlMs: 15 * 60_000,
  respawnBusyMs: 1000,
};

export const BASE_HP = 100;
export const STARTING_SILVER = 20;
export const MAX_CRAFT_BATCH = 10;

export const MAX_SKILL_LEVEL = 99;

/** Trained level from XP, capped at MAX_SKILL_LEVEL. No global level exists; each skill grows independently through use. */
export function levelFor(xp: number): number {
  return Math.min(MAX_SKILL_LEVEL, Math.floor(Math.sqrt(Math.max(0, xp) / 10)));
}

/**
 * Specialization. Each player picks up to `slots` focus skills (`focus.set`, in town).
 * - Focused skills earn `xpMult`× XP and count their full trained level.
 * - Unfocused skills still work and still earn XP, but count at most `unfocusedLevelCap` levels
 *   (enough for every tier-1 and tier-2 recipe). Refocusing later restores the full trained level: XP is never lost.
 * - Level perks: action speed −5%/level (floor 50%), gathering bonus yield +`bonusYieldPerLevel`/level (up to +`maxBonusYield` items),
 *   weapon damage (see COMBAT). Focused refining and crafting also get a `bonusOutputPerLevel`/level chance of one extra output per unit (up to `maxBonusOutput`).
 * - Tier-3 recipes (`requiresFocus`) can only be made by players focused in that recipe's skill.
 * - Adding a skill to a free slot is free. Dropping a focused skill is allowed once per `respecCooldownMs`.
 * Nobody can master the whole gathering → refining → crafting → combat chain alone: specialists trade with each other.
 */
export const FOCUS = {
  slots: 3,
  xpMult: 2,
  unfocusedLevelCap: 3,
  bonusYieldPerLevel: 0.1,
  maxBonusYield: 2,
  bonusOutputPerLevel: 0.05,
  maxBonusOutput: 0.5,
  respecCooldownMs: 10 * 60_000,
};

/** Level that counts for rules: the full trained level when focused, else capped at FOCUS.unfocusedLevelCap. */
export function effectiveLevel(xp: number, focused: boolean): number {
  const level = levelFor(xp);
  return focused ? level : Math.min(FOCUS.unfocusedLevelCap, level);
}

/** Combat: XP per point of damage dealt, and the weapon-skill damage bonus (+3% per level, counted up to level 30). */
export const COMBAT = {
  xpPerDamage: 0.1,
  damageBonusPerLevel: 0.03,
  damageBonusMaxLevel: 30,
};

/** Fraction of carried (not banked) silver destroyed on any death, before the rest is dropped or kept. */
export const DEATH_SILVER_LOSS = 0.25;

/** Trades: fraction of the silver each party receives that is destroyed at settlement (minimum 1 when any silver moves). */
export const TRADE_SILVER_FEE = 0.02;

/**
 * Gear wear. Equipped weapons wear per attack, equipped armor per hit taken, the equipped tool per use.
 * A broken tool still works, but its actions take 1/`brokenMultiplier` times as long. At `max` the item is broken:
 * its power, defense and HP bonus are multiplied by `brokenMultiplier` until repaired in town.
 * A full repair (from `max` wear) costs `repairCostByTier[tier]` silver; partial wear costs proportionally (rounded up).
 */
export const WEAR = {
  max: 100,
  perAttack: 0.25,
  perHitTaken: 1,
  /** Equipped tool, per gather or per recipe unit made. */
  perToolUse: 0.5,
  brokenMultiplier: 0.5,
  repairCostByTier: { 1: 10, 2: 30, 3: 80 } as Record<number, number>,
};

/** NPC shop in town. Buy-only and priced above the player market, so it caps prices and removes silver. */
export const SHOP: Record<string, number> = {
  copper_pickaxe: 60,
  copper_axe: 60,
  copper_skinning_knife: 50,
  copper_tongs: 60,
  copper_saw: 50,
  copper_hammer: 60,
  copper_needle: 50,
  copper_sword: 60,
  leather_jerkin: 80,
  iron_pickaxe: 300,
};

export const XP = {
  gather: (tier: number) => 5 * tier * tier,
  refine: (tier: number) => 4 * tier * tier,
  craft: (tier: number) => 10 * tier * tier,
};

export function zonePath(from: ZoneId, to: ZoneId): ZoneId[] {
  if (from === to) return [];
  const prev = new Map<ZoneId, ZoneId>();
  const queue: ZoneId[] = [from];
  const seen = new Set<ZoneId>([from]);
  while (queue.length) {
    const z = queue.shift()!;
    for (const n of ZONES[z].adjacent) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, z);
      if (n === to) {
        const path: ZoneId[] = [to];
        let cur = to;
        while (prev.get(cur) !== from) { cur = prev.get(cur)!; path.unshift(cur); }
        return path;
      }
      queue.push(n);
    }
  }
  return [];
}

export const CATALOG = { zones: ZONES, items: ITEMS, recipes: RECIPES, nodes: NODE_TYPES, mobs: MOB_TYPES, abilities: ABILITIES, quests: QUESTS, skills: SKILLS, timing: TIMING, starters: STARTERS, combat: COMBAT, wear: WEAR, shop: SHOP, deathSilverLoss: DEATH_SILVER_LOSS, tradeSilverFee: TRADE_SILVER_FEE, maxSkillLevel: MAX_SKILL_LEVEL, focus: FOCUS, toolFamilies: TOOL_FAMILIES, starterKit: STARTER_KIT };
