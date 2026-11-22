// Static game data shared by the server and the SDK.
// Everything here is public knowledge: bots can fetch it with the `catalog` command.

import { STARTERS } from './starters.ts';

export type ZoneId = 'town' | 'wilds' | 'frontier' | 'hollow' | 'ridge';
/** `contested`: settlement land. PvP is allowed and death drops everything, as in the lethal frontier. */
export type Safety = 'safe' | 'safe-wild' | 'contested' | 'lethal';
/** Every station is in town except the kitchen, which only settlements have (see BUILDINGS). */
export type StationId = 'smelter' | 'sawmill' | 'tannery' | 'forge' | 'workbench' | 'altar' | 'kitchen';
export type Slot = 'weapon' | 'armor' | 'tool';
export const SLOTS: Slot[] = ['weapon', 'armor', 'tool'];
export type ItemKind = 'currency' | 'resource' | 'material' | 'tool' | 'weapon' | 'armor' | 'orb' | 'food';
export type SkillId =
  | 'mining' | 'woodcutting' | 'farming'
  | 'smelting' | 'woodworking' | 'tanning' | 'cooking'
  | 'construction'
  | 'toolcraft' | 'weaponcraft' | 'armorcraft'
  | 'enchanting'
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
  stone: { id: 'stone', name: 'Stone', kind: 'resource', tier: 1, description: 'Quarried in the contested regions (Mossy Hollow, Stonewatch Ridge) with a pickaxe. Founds settlements.' },
  grain: { id: 'grain', name: 'Grain', kind: 'resource', tier: 1, description: 'Reaped from fertile fields in the contested regions with a hoe, and grown by settlement farms. Cooks into rations at a kitchen.' },
  rough_hide: { id: 'rough_hide', name: 'Rough Hide', kind: 'resource', tier: 1, description: 'Dropped by wolves and boars in the wilds.' },
  duskiron_ore: { id: 'duskiron_ore', name: 'Duskiron Ore', kind: 'resource', tier: 3, frontierExclusive: true, description: 'Frontier exclusive. Mined from duskiron veins. Needs a T2 pickaxe.' },
  wraith_essence: { id: 'wraith_essence', name: 'Wraith Essence', kind: 'resource', tier: 3, frontierExclusive: true, description: 'Frontier exclusive. Dropped by wraiths.' },
  // Boss materials: only bosses drop them, and bosses need a group.
  bear_pelt: { id: 'bear_pelt', name: 'Bear Pelt', kind: 'resource', tier: 2, description: 'Boss material. Dropped by the Elder Bear in the wilds. Makes bearhide jerkins.' },
  wyrm_scale: { id: 'wyrm_scale', name: 'Wyrm Scale', kind: 'resource', tier: 3, frontierExclusive: true, description: 'Boss material. Frontier exclusive, dropped by the Ash Wyrm. Makes wyrmscale mail.' },
  // Refined materials
  copper_bar: { id: 'copper_bar', name: 'Copper Bar', kind: 'material', tier: 1, description: 'Smelted copper.' },
  iron_bar: { id: 'iron_bar', name: 'Iron Bar', kind: 'material', tier: 2, description: 'Smelted iron.' },
  duskiron_bar: { id: 'duskiron_bar', name: 'Duskiron Bar', kind: 'material', tier: 3, description: 'Smelted from frontier duskiron ore.' },
  pine_plank: { id: 'pine_plank', name: 'Pine Plank', kind: 'material', tier: 1, description: 'Sawn pine.' },
  leather: { id: 'leather', name: 'Leather', kind: 'material', tier: 1, description: 'Tanned hide.' },
  orb_shard: { id: 'orb_shard', name: 'Orb Shard', kind: 'material', tier: 1, description: 'Salvaged from unique gear or found by gathering tools with shard_find; dropped by mobs. Enchanters fuse 10 into an orb.' },
  // Currency orbs: modify unique gear at the altar in town with item.modify (see ORBS).
  orb_transmute: { id: 'orb_transmute', name: 'Orb of Transmutation', kind: 'orb', tier: 1, description: 'Normal → magic with one affix.' },
  orb_augment: { id: 'orb_augment', name: 'Orb of Augmentation', kind: 'orb', tier: 1, description: 'Adds an affix to a magic item with room for one.' },
  orb_alteration: { id: 'orb_alteration', name: 'Orb of Alteration', kind: 'orb', tier: 1, description: 'Rerolls a magic item: new affixes (one, sometimes two).' },
  orb_scour: { id: 'orb_scour', name: 'Orb of Scouring', kind: 'orb', tier: 2, description: 'Removes every affix: back to normal.' },
  orb_annul: { id: 'orb_annul', name: 'Orb of Annulment', kind: 'orb', tier: 2, description: 'Removes one random affix.' },
  orb_regal: { id: 'orb_regal', name: 'Regal Orb', kind: 'orb', tier: 3, description: 'Magic → rare, adding one affix. Drops only from frontier wraiths (or enchanted from wraith essence).' },
  orb_chaos: { id: 'orb_chaos', name: 'Chaos Orb', kind: 'orb', tier: 3, description: 'Rerolls a rare item: new affixes (three, sometimes four). Drops only from frontier wraiths (or enchanted from wraith essence).' },
  orb_vaal: { id: 'orb_vaal', name: 'Vaal Orb', kind: 'orb', tier: 3, description: 'Corrupts: one affix may jump a tier, the item may be bricked (all affixes destroyed), or nothing may change. Corrupted items can never be modified again.' },
  ration: { id: 'ration', name: 'Ration', kind: 'food', tier: 1, description: 'Cooked from grain at a settlement kitchen. Eating one makes you Well fed for a while (see catalog.food): more XP and faster regeneration out of combat.' },
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
  copper_hoe: { id: 'copper_hoe', name: 'Copper Hoe', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['farming'], description: 'Tier 1. Reaps fertile fields.' },
  iron_hoe: { id: 'iron_hoe', name: 'Iron Hoe', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['farming'], description: 'Tier 2. Reaps fertile fields.' },
  duskiron_hoe: { id: 'duskiron_hoe', name: 'Duskiron Hoe', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['farming'], description: 'Tier 3. Reaps fertile fields.' },
  copper_trowel: { id: 'copper_trowel', name: 'Copper Trowel', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['construction'], description: 'Tier 1. Builds settlement buildings.' },
  iron_trowel: { id: 'iron_trowel', name: 'Iron Trowel', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['construction'], description: 'Tier 2. Builds settlement buildings.' },
  duskiron_trowel: { id: 'duskiron_trowel', name: 'Duskiron Trowel', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['construction'], description: 'Tier 3. Builds settlement buildings.' },
  copper_pot: { id: 'copper_pot', name: 'Copper Pot', kind: 'tool', tier: 1, slot: 'tool', toolTier: 1, toolFor: ['cooking'], description: 'Tier 1. Cooks rations at a settlement kitchen.' },
  iron_pot: { id: 'iron_pot', name: 'Iron Pot', kind: 'tool', tier: 2, slot: 'tool', toolTier: 2, toolFor: ['cooking'], description: 'Tier 2. Cooks rations at a settlement kitchen.' },
  duskiron_pot: { id: 'duskiron_pot', name: 'Duskiron Pot', kind: 'tool', tier: 3, slot: 'tool', toolTier: 3, toolFor: ['cooking'], description: 'Tier 3. Cooks rations at a settlement kitchen.' },
  // Weapons
  copper_sword: { id: 'copper_sword', name: 'Copper Sword', kind: 'weapon', tier: 1, slot: 'weapon', power: 8, weaponSkill: 'swords', abilities: ['slash', 'heavy_strike'], description: 'Starter sword.' },
  iron_sword: { id: 'iron_sword', name: 'Iron Sword', kind: 'weapon', tier: 2, slot: 'weapon', power: 12, weaponSkill: 'swords', abilities: ['slash', 'heavy_strike'], description: 'Solid sword.' },
  duskiron_sword: { id: 'duskiron_sword', name: 'Duskiron Sword', kind: 'weapon', tier: 3, slot: 'weapon', power: 20, weaponSkill: 'swords', abilities: ['slash', 'heavy_strike'], description: 'Tier 3 blade forged from frontier duskiron.' },
  // Armor
  leather_jerkin: { id: 'leather_jerkin', name: 'Leather Jerkin', kind: 'armor', tier: 1, slot: 'armor', defense: 0.08, hpBonus: 20, abilities: ['evade'], description: 'Light armor. Grants Evade.' },
  iron_mail: { id: 'iron_mail', name: 'Iron Mail', kind: 'armor', tier: 2, slot: 'armor', defense: 0.15, hpBonus: 40, abilities: ['brace'], description: 'Medium armor. Grants Brace.' },
  wraithhide_armor: { id: 'wraithhide_armor', name: 'Wraithhide Armor', kind: 'armor', tier: 3, slot: 'armor', defense: 0.25, hpBonus: 70, abilities: ['evade', 'brace'], description: 'Tier 3 armor woven with wraith essence. Grants Evade and Brace.' },
  bearhide_jerkin: { id: 'bearhide_jerkin', name: 'Bearhide Jerkin', kind: 'armor', tier: 2, slot: 'armor', defense: 0.12, hpBonus: 50, abilities: ['evade'], description: 'Tier 2 light armor from Elder Bear pelts. Grants Evade.' },
  wyrmscale_mail: { id: 'wyrmscale_mail', name: 'Wyrmscale Mail', kind: 'armor', tier: 3, slot: 'armor', defense: 0.3, hpBonus: 90, abilities: ['evade', 'brace'], description: 'Tier 3 armor from Ash Wyrm scales, the best in the game. Grants Evade and Brace.' },
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
  ration: recipe({ id: 'ration', kind: 'refine', station: 'kitchen', skill: 'cooking', tier: 1, minLevel: 0, inputs: [{ item: 'grain', qty: 3 }], output: { item: 'ration', qty: 1 } }),
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
  copper_hoe: recipe({ id: 'copper_hoe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_hoe', qty: 1 } }),
  iron_hoe: recipe({ id: 'iron_hoe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_hoe', qty: 1 } }),
  duskiron_hoe: recipe({ id: 'duskiron_hoe', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_hoe', qty: 1 } }),
  copper_trowel: recipe({ id: 'copper_trowel', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 1 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_trowel', qty: 1 } }),
  iron_trowel: recipe({ id: 'iron_trowel', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 1 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_trowel', qty: 1 } }),
  duskiron_trowel: recipe({ id: 'duskiron_trowel', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 1 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_trowel', qty: 1 } }),
  copper_pot: recipe({ id: 'copper_pot', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 2 }], output: { item: 'copper_pot', qty: 1 } }),
  iron_pot: recipe({ id: 'iron_pot', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }], output: { item: 'iron_pot', qty: 1 } }),
  duskiron_pot: recipe({ id: 'duskiron_pot', kind: 'craft', station: 'forge', skill: 'toolcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }], output: { item: 'duskiron_pot', qty: 1 } }),
  // Weapons
  copper_sword: recipe({ id: 'copper_sword', kind: 'craft', station: 'forge', skill: 'weaponcraft', tier: 1, minLevel: 0, inputs: [{ item: 'copper_bar', qty: 3 }, { item: 'pine_plank', qty: 1 }], output: { item: 'copper_sword', qty: 1 } }),
  iron_sword: recipe({ id: 'iron_sword', kind: 'craft', station: 'forge', skill: 'weaponcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'iron_sword', qty: 1 } }),
  duskiron_sword: recipe({ id: 'duskiron_sword', kind: 'craft', station: 'forge', skill: 'weaponcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'duskiron_bar', qty: 2 }, { item: 'pine_plank', qty: 1 }], output: { item: 'duskiron_sword', qty: 1 } }),
  // Armor
  leather_jerkin: recipe({ id: 'leather_jerkin', kind: 'craft', station: 'workbench', skill: 'armorcraft', tier: 1, minLevel: 0, inputs: [{ item: 'leather', qty: 3 }], output: { item: 'leather_jerkin', qty: 1 } }),
  iron_mail: recipe({ id: 'iron_mail', kind: 'craft', station: 'forge', skill: 'armorcraft', tier: 2, minLevel: 1, inputs: [{ item: 'iron_bar', qty: 2 }, { item: 'leather', qty: 2 }], output: { item: 'iron_mail', qty: 1 } }),
  // Orbs (enchanting at the altar): fuse orb shards. Regal, Chaos and Vaal also need wraith essence and an enchanting focus.
  orb_transmute: recipe({ id: 'orb_transmute', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 1, minLevel: 0, inputs: [{ item: 'orb_shard', qty: 10 }], output: { item: 'orb_transmute', qty: 1 } }),
  orb_augment: recipe({ id: 'orb_augment', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 1, minLevel: 0, inputs: [{ item: 'orb_shard', qty: 10 }], output: { item: 'orb_augment', qty: 1 } }),
  orb_alteration: recipe({ id: 'orb_alteration', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 1, minLevel: 1, inputs: [{ item: 'orb_shard', qty: 10 }], output: { item: 'orb_alteration', qty: 1 } }),
  orb_scour: recipe({ id: 'orb_scour', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 2, minLevel: 1, inputs: [{ item: 'orb_shard', qty: 10 }, { item: 'leather', qty: 1 }], output: { item: 'orb_scour', qty: 1 } }),
  orb_annul: recipe({ id: 'orb_annul', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 2, minLevel: 2, inputs: [{ item: 'orb_shard', qty: 10 }, { item: 'iron_bar', qty: 1 }], output: { item: 'orb_annul', qty: 1 } }),
  orb_regal: recipe({ id: 'orb_regal', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 3, minLevel: 3, requiresFocus: true, inputs: [{ item: 'orb_shard', qty: 10 }, { item: 'wraith_essence', qty: 1 }], output: { item: 'orb_regal', qty: 1 } }),
  orb_chaos: recipe({ id: 'orb_chaos', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 3, minLevel: 3, requiresFocus: true, inputs: [{ item: 'orb_shard', qty: 10 }, { item: 'wraith_essence', qty: 1 }], output: { item: 'orb_chaos', qty: 1 } }),
  orb_vaal: recipe({ id: 'orb_vaal', kind: 'craft', station: 'altar', skill: 'enchanting', tier: 3, minLevel: 3, requiresFocus: true, inputs: [{ item: 'orb_shard', qty: 10 }, { item: 'wraith_essence', qty: 2 }], output: { item: 'orb_vaal', qty: 1 } }),
  bearhide_jerkin: recipe({ id: 'bearhide_jerkin', kind: 'craft', station: 'workbench', skill: 'armorcraft', tier: 2, minLevel: 1, inputs: [{ item: 'bear_pelt', qty: 2 }, { item: 'leather', qty: 2 }], output: { item: 'bearhide_jerkin', qty: 1 } }),
  wyrmscale_mail: recipe({ id: 'wyrmscale_mail', kind: 'craft', station: 'forge', skill: 'armorcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'wyrm_scale', qty: 3 }, { item: 'duskiron_bar', qty: 1 }, { item: 'leather', qty: 2 }], output: { item: 'wyrmscale_mail', qty: 1 } }),
  wraithhide_armor: recipe({ id: 'wraithhide_armor', kind: 'craft', station: 'workbench', skill: 'armorcraft', tier: 3, minLevel: 2, requiresFocus: true, inputs: [{ item: 'wraith_essence', qty: 2 }, { item: 'leather', qty: 3 }, { item: 'iron_bar', qty: 1 }], output: { item: 'wraithhide_armor', qty: 1 } }),
};

/** One tool family per job ('' = no tool needed). Enchanting needs none, but a modder's equipped hammer affixes (mod_odds, orb_fee) count at the altar. The tool-slot item must belong to the job's family. */
export const TOOL_FAMILIES: Record<ToolJob, string> = {
  mining: 'pickaxe', woodcutting: 'axe', farming: 'hoe', skinning: 'skinning_knife', smelting: 'tongs', woodworking: 'saw', tanning: 'needle', cooking: 'pot', construction: 'trowel',
  toolcraft: 'hammer', weaponcraft: 'hammer', armorcraft: 'hammer', swords: '', unarmed: '', enchanting: '',
};

/** Tool tier a job of tier T needs. */
export const requiredToolTier = (tier: number): number => Math.max(1, tier - 1);

/** Every new player starts with one copper tool of each family. Better tools come from toolcrafters. */
export const STARTER_KIT: ItemStack[] = ['pickaxe', 'axe', 'skinning_knife', 'tongs', 'saw', 'hammer', 'needle', 'hoe', 'trowel', 'pot'].map((f) => ({ item: `copper_${f}`, qty: 1 }));
/** Bump when tools join the starter kit, and list them here: existing players get exactly these, once, on load. */
export const KIT_VERSION = 2;
export const KIT_ADDED: Record<number, ItemStack[]> = { 2: ['hoe', 'trowel', 'pot'].map((f) => ({ item: `copper_${f}`, qty: 1 })) };

// ---------- affixes ----------

/** Which affix pool a gear base rolls from. */
export type GearGroup = 'combat' | 'gathering' | 'refining' | 'crafting' | 'building';
export type RarityId = 'normal' | 'magic' | 'rare';

export function gearGroup(base: string): GearGroup | undefined {
  const d = ITEMS[base];
  if (!d) return undefined;
  if (d.kind === 'weapon' || d.kind === 'armor') return 'combat';
  if (d.kind !== 'tool') return undefined;
  const job = d.toolFor?.[0];
  if (job === 'mining' || job === 'woodcutting' || job === 'farming' || job === 'skinning') return 'gathering';
  if (job === 'smelting' || job === 'woodworking' || job === 'tanning' || job === 'cooking') return 'refining';
  if (job === 'construction') return 'building';
  return 'crafting';
}

/** Maximum affixes per rarity. Normal items have none. */
export const RARITY_MAX_AFFIXES: Record<RarityId, number> = { normal: 0, magic: 2, rare: 4 };

export interface AffixDef {
  id: string;
  group: GearGroup;
  /** `{v}` is replaced by the rolled value. */
  text: string;
  /** A chance-based effect: players see the tier but not the value (odds stay server-side). */
  hiddenValue?: boolean;
}

/** Minimum item level for each affix tier (index 0 = tier 1). An item can only roll tiers its item level allows. */
export const AFFIX_TIER_MIN_ILVL = [1, 20, 35];

const affix = (a: AffixDef): AffixDef => a;
export const AFFIXES: Record<string, AffixDef> = {
  // Weapons and armor
  damage: affix({ id: 'damage', group: 'combat', text: '+{v}% attack damage' }),
  max_hp: affix({ id: 'max_hp', group: 'combat', text: '+{v} max HP' }),
  attack_speed: affix({ id: 'attack_speed', group: 'combat', text: '{v}% shorter global cooldown after attacks' }),
  guard: affix({ id: 'guard', group: 'combat', text: '{v}% shorter Evade and Brace cooldowns' }),
  // Gathering tools
  gather_speed: affix({ id: 'gather_speed', group: 'gathering', text: '{v}% faster gathering' }),
  yield: affix({ id: 'yield', group: 'gathering', text: 'more bonus yield (adds to the skill bonus, past its cap)', hiddenValue: true }),
  double_drop: affix({ id: 'double_drop', group: 'gathering', text: 'a chance to double a gather or a hide drop', hiddenValue: true }),
  durable: affix({ id: 'durable', group: 'gathering', text: '{v}% less tool wear' }),
  shard_find: affix({ id: 'shard_find', group: 'gathering', text: 'a chance to find an orb shard per gather or skinned kill', hiddenValue: true }),
  // Refining tools
  refine_output: affix({ id: 'refine_output', group: 'refining', text: 'a chance of one extra output per unit', hiddenValue: true }),
  save_inputs: affix({ id: 'save_inputs', group: 'refining', text: 'a chance per unit to keep its inputs', hiddenValue: true }),
  refine_speed: affix({ id: 'refine_speed', group: 'refining', text: '{v}% faster refining' }),
  // Building tools (trowels)
  build_speed: affix({ id: 'build_speed', group: 'building', text: '{v}% faster building' }),
  build_xp: affix({ id: 'build_xp', group: 'building', text: '+{v}% construction XP' }),
  build_durable: affix({ id: 'build_durable', group: 'building', text: '{v}% less trowel wear' }),
  // Crafting tools (hammers)
  craft_ilvl: affix({ id: 'craft_ilvl', group: 'crafting', text: '+{v} item level on items you craft' }),
  mod_odds: affix({ id: 'mod_odds', group: 'crafting', text: 'better odds when you use orbs (higher affix tiers, safer Vaal)', hiddenValue: true }),
  orb_fee: affix({ id: 'orb_fee', group: 'crafting', text: '{v}% lower orb station fees' }),
};

/** Readable affix line. A missing value (hidden from players) leaves the text without a number. */
export function affixText(id: string, value?: number): string {
  const t = AFFIXES[id]?.text ?? id;
  return value === undefined ? t.replace(/\+?\{v\}%?\s*/, '') : t.replace('{v}', String(value));
}

export interface NodeDef { id: string; name: string; item: string; tier: number; skill: SkillId; maxCharges: number }
export const NODE_TYPES: Record<string, NodeDef> = {
  copper_vein: { id: 'copper_vein', name: 'Copper Vein', item: 'copper_ore', tier: 1, skill: 'mining', maxCharges: 10 },
  iron_vein: { id: 'iron_vein', name: 'Iron Vein', item: 'iron_ore', tier: 2, skill: 'mining', maxCharges: 10 },
  pine_grove: { id: 'pine_grove', name: 'Pine Grove', item: 'pine_log', tier: 1, skill: 'woodcutting', maxCharges: 10 },
  stone_quarry: { id: 'stone_quarry', name: 'Stone Quarry', item: 'stone', tier: 1, skill: 'mining', maxCharges: 12 },
  fertile_field: { id: 'fertile_field', name: 'Fertile Field', item: 'grain', tier: 1, skill: 'farming', maxCharges: 12 },
  duskiron_vein: { id: 'duskiron_vein', name: 'Duskiron Vein', item: 'duskiron_ore', tier: 3, skill: 'mining', maxCharges: 6 },
};

/** How often a drop happens, in words. Exact odds are server-side only. */
export type DropFrequency = 'always' | 'often' | 'sometimes' | 'rarely' | 'very rarely';
/** `skin`: only drops when the killer has a skinning knife equipped (tier >= requiredToolTier(mob tier)). */
export interface DropInfo { item: string; frequency: DropFrequency; skin?: boolean }
/**
 * Bosses need a group, except for a really maxed-out player (top gear with good affixes and a high weapon skill), who may
 * solo one. That bar rests on these stats alone: rerun test/bosses.test.ts after changing them or adding player power.
 * Besides its normal attack on its target, a boss sweeps every player who damaged it
 * and stands within `aoeRadius` tiles for `aoeDamage` every `aoeEveryMs`. `enrageAfterMs` after the fight starts, all
 * its damage is multiplied by `enrageMult`. Its loot drops into a spoils bag (see PARTY) instead of the killer's inventory.
 */
export interface BossDef { aoeDamage: number; aoeEveryMs: number; aoeRadius: number; enrageAfterMs: number; enrageMult: number }
export interface MobDef { id: string; name: string; tier: number; hp: number; damage: number; attackMs: number; respawnMs: number; silver: 'some' | 'more' | 'plenty' | 'a hoard'; drops: DropInfo[]; boss?: BossDef }
export const MOB_TYPES: Record<string, MobDef> = {
  wolf: { id: 'wolf', name: 'Wolf', tier: 1, hp: 30, damage: 3, attackMs: 1500, respawnMs: 6000, silver: 'some', drops: [{ item: 'rough_hide', frequency: 'always', skin: true }, { item: 'orb_shard', frequency: 'sometimes' }, { item: 'orb_transmute', frequency: 'rarely' }, { item: 'orb_alteration', frequency: 'rarely' }] },
  boar: { id: 'boar', name: 'Boar', tier: 1, hp: 50, damage: 5, attackMs: 1500, respawnMs: 6000, silver: 'more', drops: [{ item: 'rough_hide', frequency: 'always', skin: true }, { item: 'orb_shard', frequency: 'sometimes' }, { item: 'orb_augment', frequency: 'rarely' }, { item: 'orb_scour', frequency: 'very rarely' }, { item: 'orb_annul', frequency: 'very rarely' }] },
  wraith: { id: 'wraith', name: 'Wraith', tier: 3, hp: 80, damage: 10, attackMs: 1500, respawnMs: 8000, silver: 'plenty', drops: [{ item: 'wraith_essence', frequency: 'always' }, { item: 'orb_shard', frequency: 'often' }, { item: 'orb_regal', frequency: 'rarely' }, { item: 'orb_chaos', frequency: 'rarely' }, { item: 'orb_vaal', frequency: 'rarely' }] },
  elder_bear: {
    id: 'elder_bear', name: 'Elder Bear', tier: 2, hp: 825, damage: 35, attackMs: 2500, respawnMs: 10 * 60_000, silver: 'a hoard',
    drops: [{ item: 'bear_pelt', frequency: 'always' }, { item: 'rough_hide', frequency: 'always' }, { item: 'orb_shard', frequency: 'always' }],
    boss: { aoeDamage: 4, aoeEveryMs: 13_000, aoeRadius: 3, enrageAfterMs: 12_000, enrageMult: 3 },
  },
  ash_wyrm: {
    id: 'ash_wyrm', name: 'Ash Wyrm', tier: 3, hp: 1500, damage: 25, attackMs: 2000, respawnMs: 20 * 60_000, silver: 'a hoard',
    drops: [{ item: 'wyrm_scale', frequency: 'always' }, { item: 'wraith_essence', frequency: 'always' }, { item: 'orb_shard', frequency: 'always' }, { item: 'orb_regal', frequency: 'sometimes' }, { item: 'orb_chaos', frequency: 'sometimes' }],
    boss: { aoeDamage: 15, aoeEveryMs: 5000, aoeRadius: 3, enrageAfterMs: 30_000, enrageMult: 3 },
  },
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
  /** Settlement plots generated in this region (see SETTLEMENT). */
  plots: number;
  nodes: { type: string; count: number }[];
  mobs: { type: string; count: number }[];
}

export const ZONES: Record<ZoneId, ZoneDef> = {
  town: {
    id: 'town', name: 'Brightwater (Town)', safety: 'safe', description: 'No combat. Bank, crafting stations, quest board, trade forum.',
    adjacent: ['wilds'], stations: ['smelter', 'sawmill', 'tannery', 'forge', 'workbench', 'altar'], hasBank: true, hasForum: true, hasQuestBoard: true,
    pvp: false, fullLoot: false, plots: 0, nodes: [], mobs: [],
  },
  wilds: {
    id: 'wilds', name: 'Greenreach (Safe Wilderness)', safety: 'safe-wild', description: 'Basic resources and PvE. Dying here keeps your gear and inventory.',
    adjacent: ['town', 'frontier', 'hollow', 'ridge'], stations: [], hasBank: false, hasForum: false, hasQuestBoard: false,
    pvp: false, fullLoot: false, plots: 0,
    nodes: [{ type: 'copper_vein', count: 2 }, { type: 'iron_vein', count: 3 }, { type: 'pine_grove', count: 2 }],
    mobs: [{ type: 'wolf', count: 3 }, { type: 'boar', count: 3 }, { type: 'elder_bear', count: 1 }],
  },
  frontier: {
    id: 'frontier', name: 'The Ashen Frontier (Lethal)', safety: 'lethal', description: 'Open PvP. Exclusive duskiron and wraith essence. Death drops everything you carry and wear.',
    adjacent: ['wilds', 'ridge'], stations: [], hasBank: false, hasForum: false, hasQuestBoard: false,
    pvp: true, fullLoot: true, plots: 0,
    nodes: [{ type: 'duskiron_vein', count: 2 }],
    mobs: [{ type: 'wraith', count: 3 }, { type: 'ash_wyrm', count: 1 }],
  },
  hollow: {
    id: 'hollow', name: 'Mossy Hollow (Contested)', safety: 'contested',
    description: 'Settlement land north of the wilds, reached only through them. PvP is allowed and death drops everything you carry and wear. Stone, grain and settlement plots.',
    adjacent: ['wilds'], stations: [], hasBank: false, hasForum: false, hasQuestBoard: false,
    pvp: true, fullLoot: true, plots: 3,
    nodes: [{ type: 'stone_quarry', count: 2 }, { type: 'fertile_field', count: 2 }, { type: 'pine_grove', count: 1 }],
    mobs: [{ type: 'wolf', count: 2 }, { type: 'boar', count: 1 }],
  },
  ridge: {
    id: 'ridge', name: 'Stonewatch Ridge (Contested)', safety: 'contested',
    description: 'Settlement land south of the wilds, with a ford into the frontier. PvP is allowed and death drops everything you carry and wear. Rich stone, some iron, settlement plots.',
    adjacent: ['wilds', 'frontier'], stations: [], hasBank: false, hasForum: false, hasQuestBoard: false,
    pvp: true, fullLoot: true, plots: 2,
    nodes: [{ type: 'stone_quarry', count: 3 }, { type: 'iron_vein', count: 1 }, { type: 'fertile_field', count: 1 }],
    mobs: [{ type: 'boar', count: 2 }, { type: 'wolf', count: 1 }],
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
  // Boss quests: every player who damaged the boss, and every party member of the killer in the region, gets the kill credit.
  bear_hunt: { id: 'bear_hunt', name: 'Bear Hunt', description: 'Help kill the Elder Bear in the wilds (a group job: everyone who hits it, and the killer\'s party in the region, gets credit).', objective: { kind: 'kill', target: 'elder_bear', count: 1 }, reward: [{ item: 'silver', qty: 120 }] },
  wyrm_slayer: { id: 'wyrm_slayer', name: 'Wyrm Slayer', description: 'Help kill the Ash Wyrm in the frontier (a group job: everyone who hits it, and the killer\'s party in the region, gets credit).', objective: { kind: 'kill', target: 'ash_wyrm', count: 1 }, reward: [{ item: 'silver', qty: 300 }] },
  // Trade contracts: progress counts only what actually changes hands in settled blind trades with other players.
  supply_contract: { id: 'supply_contract', name: 'Supply Contract', description: 'Deliver 4 iron bars to other players through settled trades.', objective: { kind: 'deliver', target: 'iron_bar', count: 4 }, reward: [{ item: 'silver', qty: 40 }] },
  outfitter_contract: { id: 'outfitter_contract', name: 'Outfitter Contract', description: 'Deliver an iron mail to another player through a settled trade.', objective: { kind: 'deliver', target: 'iron_mail', count: 1 }, reward: [{ item: 'silver', qty: 50 }] },
  hire_a_smith: { id: 'hire_a_smith', name: 'Hire a Smith', description: 'Receive an iron sword from another player through a settled trade.', objective: { kind: 'procure', target: 'iron_sword', count: 1 }, reward: [{ item: 'silver', qty: 30 }] },
  ore_buyer: { id: 'ore_buyer', name: 'Ore Buyer', description: 'Receive 6 iron ore from other players through settled trades.', objective: { kind: 'procure', target: 'iron_ore', count: 6 }, reward: [{ item: 'silver', qty: 25 }] },
};

export const SKILLS: SkillId[] = ['mining', 'woodcutting', 'farming', 'smelting', 'woodworking', 'tanning', 'cooking', 'construction', 'toolcraft', 'weaponcraft', 'armorcraft', 'enchanting', 'swords', 'unarmed'];

/** Base durations in milliseconds at world speed 1. The server divides them by its speed factor. */
export const TIMING = {
  gatherMs: 1500,
  refineMs: 1200,
  craftMs: 2000,
  /** One settlement.build action: one unit of a building's work. */
  buildMs: 2000,
  eatMs: 1000,
  globalCooldownMs: 1000,
  /** No leaving your region within this long after dealing or taking damage. Walking inside it is allowed. Walking speed: catalog.map.msPerTile. */
  combatLockMs: 5000,
  outOfCombatMs: 4000,
  regenIntervalMs: 1000,
  regenFraction: 0.04,
  nodeRegenMs: 6000,
  lootBagTtlMs: 15 * 60_000,
  respawnBusyMs: 1000,
  /**
   * stockpile.pilfer and stash.pilfer: the goods are yours at once, then you are busy this long, at the plot and unable
   * to walk off or fight. Damage does not interrupt it.
   */
  pilferMs: 10_000,
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
 * - Level perks: action speed −5%/level (floor 50%), more gathering yield as you level (up to a cap),
 *   weapon damage (see COMBAT). Focused refining and crafting sometimes produce extra output, more often at higher levels.
 * - Tier-3 recipes (`requiresFocus`) can only be made by players focused in that recipe's skill.
 * - Adding a skill to a free slot is free. Dropping a focused skill is allowed once per `respecCooldownMs`.
 * Nobody can master the whole gathering → refining → crafting → combat chain alone: specialists trade with each other.
 */
export const FOCUS = {
  slots: 3,
  xpMult: 2,
  unfocusedLevelCap: 3,
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

/**
 * Parties: up to `maxSize` players who fight together.
 * - Each other party member in your region adds `damageBonusPerAlly` to your attack damage (up to `maxDamageBonus`).
 * - When a party member kills a mob, every other member in the region gets the quest kill credit and
 *   `killXpShare` × (mob HP × combat.xpPerDamage) XP in their weapon skill.
 * - Boss loot drops into a spoils bag that only players who damaged the boss can open for `spoilsReservedMs`;
 *   after that anyone can. Any eligible player can take everything: share fairly or not.
 */
export const PARTY = {
  maxSize: 5,
  inviteTtlMs: 5 * 60_000,
  damageBonusPerAlly: 0.05,
  maxDamageBonus: 0.2,
  killXpShare: 0.5,
  spoilsReservedMs: 5 * 60_000,
};

/**
 * Settlements (contested regions only). Found one at a free plot; members share a stockpile kept at the plot.
 * Roles rank leader > steward > member. The charter decides open or closed membership, the lowest role allowed to
 * withdraw from the stockpile, and a tax on members' quest silver paid into the stockpile.
 */
export const SETTLEMENT = {
  /** Paid by the founder from their inventory. The silver is destroyed (a sink); planks and stone are used up. */
  foundCost: [{ item: 'silver', qty: 200 }, { item: 'pine_plank', qty: 10 }, { item: 'stone', qty: 20 }] as ItemStack[],
  maxMembers: 12,
  inviteTtlMs: 30 * 60_000,
  /** settlement.vote motions stay open this long. A motion passes when more than half of the eligible voters vote yes. */
  voteTtlMs: 30 * 60_000,
  maxTaxPct: 50,
  /** Charter of a new settlement. */
  defaultCharter: { open: false, withdrawRole: 'steward' as 'leader' | 'steward' | 'member', taxPct: 0 },
  nameMin: 3,
  nameMax: 30,
  /** Audit entries returned per page by stockpile.log (and the tail shown by stockpile.view). */
  logPage: 50,
  /** Each working building takes its upkeep from the stockpile this often, and the settlement's income arrives this often. */
  upkeepMs: 10 * 60_000,
  /**
   * Levels. The public `level` counts the buildings that stand; the `activeLevel` members see counts only the ones
   * whose upkeep is paid, and decides the income and shared work. `slots`: buildings plus projects at that level.
   * `income`: silver into the stockpile every `upkeepMs`, while at least one building works.
   */
  levels: [
    { level: 1, name: 'camp', buildings: 0, members: 1, slots: 3, income: 5 },
    { level: 2, name: 'village', buildings: 3, members: 3, slots: 6, income: 25 },
    { level: 3, name: 'town', buildings: 6, members: 5, slots: 8, income: 60 },
  ],
  /**
   * Items (silver excluded) the stockpile holds; a storehouse holds more. Full of a village's bars and planks it is
   * worth a few member-hours of work, which is what makes it worth trusting people with, or stealing.
   */
  stockpileCapacity: 25_000,
  /**
   * Shared work, the point of a village. It pays only for materials members gave up to the group: raw units a member
   * gathered or skinned, carried, put in the stockpile and left there for `restMs`. While `activeLevel` >= `minLevel` and
   * the workshop works, ANOTHER member can refine those units straight from the stockpile
   * (refine { from: 'stockpile' }) for `outputPct`% more output, and all of it lands in the stockpile.
   * Each gathered unit counts once. Nobody covers their own refining. Bought, looted and stolen units never count,
   * and what a member gave stops counting when it leaves the stockpile or the member leaves.
   */
  sharedWork: { outputPct: 125, minLevel: 2, building: 'workshop' as BuildingId, restMs: 10 * 60_000 },
  /**
   * Pilfering, which any member can do whatever the charter says: one stockpile.pilfer takes up to this percent of each
   * item (rounded down), or one single item instead, and never the last one. A stash.pilfer is blind: this percent of
   * one item picked at random, at least one. Others in the region may see it. How likely that is stays hidden.
   */
  pilferPct: 25,
  /** Latest palisade alerts kept for settlement.view. */
  alertsKept: 20,
};

export type BuildingId = 'workshop' | 'forge_hall' | 'farm' | 'kitchen' | 'storehouse' | 'palisade' | 'watchtower' | 'huts';

export interface BuildingDef {
  id: BuildingId;
  name: string;
  tier: number;
  /** Construction level settlement.build needs. */
  minLevel: number;
  /** Put in by members with settlement.contribute. */
  cost: ItemStack[];
  /** settlement.build actions once the materials are in. */
  work: number;
  /** Taken from the stockpile every catalog.settlement.upkeepMs. A building that cannot be paid does nothing until it can. */
  upkeep: ItemStack[];
  /** Stations members can use at the plot. */
  stations?: StationId[];
  /** Added to the item level of gear crafted at this building. */
  ilvlBonus?: number;
  /** Put into the stockpile each time upkeep is paid. */
  produces?: ItemStack[];
  stockpileCapacity?: number;
  /** Items (silver excluded) each member's personal stash holds. */
  stashCapacity?: number;
  description: string;
}

const items = (bag: Record<string, number>): ItemStack[] => Object.entries(bag).map(([item, qty]) => ({ item, qty }));

/** Settlement buildings: one of each. All effects are for members. */
export const BUILDINGS: Record<BuildingId, BuildingDef> = {
  workshop: {
    id: 'workshop', name: 'Workshop', tier: 1, minLevel: 0, work: 20, stations: ['smelter', 'sawmill', 'tannery'],
    cost: items({ pine_plank: 60, stone: 80, iron_bar: 10 }), upkeep: items({ pine_plank: 30, stone: 60 }),
    description: 'Smelter, sawmill and tannery at the plot, sometimes with extra output. In a village it also pays shared work (see catalog.settlement.sharedWork).',
  },
  forge_hall: {
    id: 'forge_hall', name: 'Forge Hall', tier: 2, minLevel: 1, work: 20, stations: ['forge', 'workbench'], ilvlBonus: 2,
    cost: items({ pine_plank: 40, stone: 100, iron_bar: 10, bear_pelt: 3 }), upkeep: items({ pine_plank: 15, stone: 40, iron_bar: 4 }),
    description: 'Forge and workbench at the plot: craft and repair there. Gear crafted there has +2 item level. Needs Elder Bear pelts.',
  },
  farm: {
    id: 'farm', name: 'Farm', tier: 1, minLevel: 0, work: 12, produces: items({ grain: 60 }),
    cost: items({ pine_plank: 30, stone: 30, grain: 20 }), upkeep: items({ pine_plank: 5, stone: 20 }),
    description: 'Puts grain in the stockpile each time its upkeep is paid.',
  },
  kitchen: {
    id: 'kitchen', name: 'Kitchen', tier: 1, minLevel: 0, work: 12, stations: ['kitchen'],
    cost: items({ pine_plank: 30, stone: 50, copper_bar: 5 }), upkeep: items({ pine_plank: 5, stone: 10 }),
    description: 'The only place to cook grain into rations. Eating one makes you Well fed (see catalog.food).',
  },
  storehouse: {
    id: 'storehouse', name: 'Storehouse', tier: 1, minLevel: 0, work: 16, stockpileCapacity: 100_000,
    cost: items({ pine_plank: 80, stone: 80, iron_bar: 5 }), upkeep: items({ pine_plank: 5, stone: 10 }),
    description: 'A much larger stockpile. Its lock makes it likelier that pilfering the stockpile leaves traces that name who did it.',
  },
  palisade: {
    id: 'palisade', name: 'Palisade', tier: 1, minLevel: 0, work: 16,
    cost: items({ pine_log: 120, stone: 20 }), upkeep: items({ pine_log: 10, stone: 5 }),
    description: 'Members are alerted when a non-member walks into the settlement\'s region.',
  },
  watchtower: {
    id: 'watchtower', name: 'Watchtower', tier: 1, minLevel: 0, work: 16,
    cost: items({ pine_plank: 60, stone: 40 }), upkeep: items({ pine_plank: 5, stone: 5 }),
    description: 'Records who walks into and out of the region, members included. It is a partial witness to pilfering: sometimes it records who stood at the plot, not which of them did it. Members read it with watchtower.log.',
  },
  huts: {
    id: 'huts', name: 'Huts', tier: 1, minLevel: 0, work: 16, stashCapacity: 2000,
    cost: items({ pine_plank: 50, stone: 30, leather: 10 }), upkeep: items({ pine_plank: 5, stone: 10 }),
    description: 'A private stash for each member at the plot. Only its owner sees inside, but other members can pilfer from it blindly.',
  },
};

/** Well fed: what eating a ration gives. Eating again restarts the timer and never stacks. Death ends it. */
export const FOOD = {
  item: 'ration',
  wellFedMs: 10 * 60_000,
  xpMult: 1.25,
  /** Out-of-combat regeneration only. */
  regenMult: 2,
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
  /** Repair cost multiplier by rarity of a unique item (corrupted adds `corruptedExtra`). */
  rarityRepairMult: { normal: 1, magic: 1.5, rare: 2.5 } as Record<RarityId, number>,
  corruptedExtra: 0.5,
};

export type OrbId = 'transmute' | 'augment' | 'alteration' | 'regal' | 'chaos' | 'scour' | 'annul' | 'vaal';
/**
 * Orb use (`item.modify` at the altar in town). Each use consumes one orb and pays a silver fee that is destroyed:
 * `baseFee × (1 + feeGrowth × item.mods)`, reduced by the modder's equipped hammer `orb_fee` affix and enchanting level
 * (`feeCutPerLevel` per effective level, up to `maxFeeCut`). The hammer's `mod_odds` affix and enchanting level also
 * improve roll odds (higher affix tiers, safer Vaal); the odds themselves are server-side only.
 */
export const ORBS = {
  items: { transmute: 'orb_transmute', augment: 'orb_augment', alteration: 'orb_alteration', regal: 'orb_regal', chaos: 'orb_chaos', scour: 'orb_scour', annul: 'orb_annul', vaal: 'orb_vaal' } as Record<OrbId, string>,
  baseFee: { transmute: 4, augment: 6, alteration: 4, regal: 20, chaos: 25, scour: 4, annul: 15, vaal: 30 } as Record<OrbId, number>,
  feeGrowth: 0.5,
  feeCutPerLevel: 0.02,
  maxFeeCut: 0.6,
  /** Orbs crafted from this many shards. */
  shardsPerOrb: 10,
  /** Shards from salvaging a unique: tier shards + one per affix (+2 if rare). */
  salvage: { perTier: { 1: 1, 2: 2, 3: 4 } as Record<number, number>, perAffix: 1, rareBonus: 2 },
  station: 'altar' as StationId,
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
  copper_hoe: 60,
  copper_trowel: 50,
  copper_pot: 60,
  copper_sword: 60,
  leather_jerkin: 80,
  iron_pickaxe: 300,
  // Orbs: only the two basic ones, priced well above what enchanters charge.
  orb_transmute: 150,
  orb_augment: 250,
};

export const XP = {
  /** Orb use at the altar trains enchanting. */
  modify: 6,
  gather: (tier: number) => 5 * tier * tier,
  refine: (tier: number) => 4 * tier * tier,
  craft: (tier: number) => 10 * tier * tier,
  build: (tier: number) => 10 * tier * tier,
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

export const CATALOG = { zones: ZONES, items: ITEMS, recipes: RECIPES, nodes: NODE_TYPES, mobs: MOB_TYPES, abilities: ABILITIES, quests: QUESTS, skills: SKILLS, timing: TIMING, starters: STARTERS, combat: COMBAT, wear: WEAR, shop: SHOP, deathSilverLoss: DEATH_SILVER_LOSS, tradeSilverFee: TRADE_SILVER_FEE, maxSkillLevel: MAX_SKILL_LEVEL, focus: FOCUS, toolFamilies: TOOL_FAMILIES, party: PARTY, settlement: SETTLEMENT, buildings: BUILDINGS, food: FOOD, starterKit: STARTER_KIT, orbs: ORBS, affixes: AFFIXES, affixTierMinIlvl: AFFIX_TIER_MIN_ILVL, rarityMaxAffixes: RARITY_MAX_AFFIXES };
