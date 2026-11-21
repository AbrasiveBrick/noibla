// Currency orbs: modifying unique gear at the altar, and salvaging gear into orb shards.
// Every roll uses the game RNG (seedable/injectable), and both commands run through the
// idempotent command layer, so a retried command never consumes a second orb.

import { AFFIXES, AFFIX_TIER_MIN_ILVL, ORBS, RARITY_MAX_AFFIXES, XP, affixText, gearGroup, isUnique, itemDef, rollAffix, type OrbId } from '../shared/catalog.ts';
import type { AffixRoll, UniqueItem } from '../shared/protocol.ts';
import type { Game } from './game.ts';
import type { CommandDef, Player } from './types.ts';
import { addItems, fail, removeItems, reqStr } from './util.ts';
import { affixSum, gainXp, requirePlace, skillLevel } from './world.ts';

const ORB_IDS = Object.keys(ORBS.items) as OrbId[];

/** Fee and luck for a modder: equipped hammer affixes plus enchanting level. */
export function modderTerms(p: Player, orb: OrbId, mods: number): { fee: number; luck: number; feeCut: number } {
  const level = skillLevel(p, 'enchanting');
  const feeCut = Math.min(ORBS.maxFeeCut, affixSum(p, ['tool'], 'orb_fee') / 100 + ORBS.feeCutPerLevel * level);
  const fee = Math.max(1, Math.ceil(ORBS.baseFee[orb] * (1 + ORBS.feeGrowth * mods) * (1 - feeCut)));
  const luck = Math.min(ORBS.maxLuck, affixSum(p, ['tool'], 'mod_odds') / 100 + ORBS.luckPerLevel * level);
  return { fee, luck, feeCut };
}

function requireOwned(p: Player, id: string): 'inventory' | 'equipped' {
  if ((p.inventory[id] ?? 0) > 0) return 'inventory';
  if (Object.values(p.equipment).includes(id)) return 'equipped';
  return fail('NOT_FOUND', `you do not carry or wear ${id}`, undefined, 'use the exact unique id from observe().self.uniques; banked items must be withdrawn first');
}

/** Resolves an item argument to a unique the player carries or wears (a base id picks the first match). */
function resolveUnique(g: Game, p: Player, asked: string): UniqueItem {
  let id = asked;
  if (!isUnique(asked)) {
    const owned = [...Object.keys(p.inventory), ...Object.values(p.equipment).filter((x): x is string => !!x)].filter((k) => isUnique(k) && k.startsWith(`${asked}#`)).sort();
    if (!owned.length) fail('NOT_FOUND', `${asked} is not a unique item you own`, undefined, 'only crafted gear (ids like iron_sword#3f9a1c2b) can be modified or salvaged; shop and starter items cannot');
    id = owned[0];
  }
  requireOwned(p, id);
  const u = g.uniques.get(id);
  if (!u) fail('NOT_FOUND', `no unique item ${id}`);
  return u!;
}

function roll(g: Game, u: UniqueItem, luck: number): AffixRoll | null {
  return rollAffix(g.rng, u.base, u.ilvl, u.affixes.map((a) => a.id), luck);
}

function rollMany(g: Game, u: UniqueItem, n: number, luck: number): AffixRoll[] {
  u.affixes = [];
  for (let i = 0; i < n; i++) { const a = roll(g, u, luck); if (a) u.affixes.push(a); }
  return u.affixes;
}

/** Applies one orb to the item in place. Returns a short outcome tag (Vaal: better/bricked/unchanged). */
function applyOrb(g: Game, u: UniqueItem, orb: OrbId, luck: number): string {
  const max = RARITY_MAX_AFFIXES[u.rarity];
  const need = (cond: boolean, msg: string, hint?: string) => { if (!cond) fail('INVALID_TARGET', msg, undefined, hint); };
  switch (orb) {
    case 'transmute':
      need(u.rarity === 'normal', `Transmutation needs a normal item; ${u.id} is ${u.rarity}`, 'use orb_scour first to make it normal');
      u.rarity = 'magic'; rollMany(g, u, 1, luck); return 'magic';
    case 'augment':
      need(u.rarity === 'magic' && u.affixes.length < max, `Augmentation needs a magic item with fewer than ${RARITY_MAX_AFFIXES.magic} affixes`);
      { const a = roll(g, u, luck); if (a) u.affixes.push(a); }
      return 'added';
    case 'alteration':
      need(u.rarity === 'magic', `Alteration needs a magic item; ${u.id} is ${u.rarity}`);
      rollMany(g, u, g.rng() < ORBS.extraAffixChance ? 2 : 1, luck); return 'rerolled';
    case 'regal':
      need(u.rarity === 'magic', `Regal needs a magic item; ${u.id} is ${u.rarity}`);
      u.rarity = 'rare'; { const a = roll(g, u, luck); if (a) u.affixes.push(a); }
      return 'rare';
    case 'chaos':
      need(u.rarity === 'rare', `Chaos needs a rare item; ${u.id} is ${u.rarity}`);
      rollMany(g, u, g.rng() < ORBS.extraAffixChance ? 4 : 3, luck); return 'rerolled';
    case 'scour':
      need(u.rarity !== 'normal', `${u.id} is already normal`);
      u.rarity = 'normal'; u.affixes = []; return 'normal';
    case 'annul':
      need(u.affixes.length > 0, `${u.id} has no affix to remove`);
      u.affixes.splice(Math.floor(g.rng() * u.affixes.length), 1); return 'removed';
    case 'vaal': {
      u.corrupted = true;
      const bricked = ORBS.vaal.bricked * (1 - luck);
      const better = ORBS.vaal.better + ORBS.vaal.bricked * luck;
      const r = g.rng();
      if (r < bricked) { u.affixes = []; return 'bricked'; }
      if (r < bricked + better) {
        // One random affix jumps a tier (past the item-level cap: only Vaal can do that); with no affixes, gain one.
        if (!u.affixes.length) { const a = roll(g, u, luck); if (a) u.affixes.push(a); return 'better'; }
        const a = u.affixes[Math.floor(g.rng() * u.affixes.length)];
        const tier = Math.min(3, a.tier + 1);
        const [lo, hi] = AFFIXES[a.id].tiers[tier - 1];
        a.tier = tier;
        a.value = Math.max(a.value + 1, lo + Math.floor(g.rng() * (hi - lo + 1)));
        return 'better';
      }
      return 'unchanged';
    }
  }
}

function modify(g: Game, p: Player, payload: Record<string, any>) {
  requirePlace(g, p, 'altar', 'modifying items');
  const orb = reqStr(payload, 'orb', 20).replace(/^orb_/, '') as OrbId;
  if (!ORB_IDS.includes(orb)) fail('BAD_REQUEST', `unknown orb "${payload.orb}"; orbs are ${ORB_IDS.join(', ')}`);
  const u = resolveUnique(g, p, reqStr(payload, 'item', 60));
  if (u.corrupted) fail('CORRUPTED', `${u.id} is corrupted and can never be modified again`);
  if (!gearGroup(u.base)) fail('INVALID_TARGET', `${u.base} cannot hold affixes`);
  const orbItem = ORBS.items[orb];
  if ((p.inventory[orbItem] ?? 0) < 1) fail('NOT_ENOUGH_ITEMS', `you need 1× ${orbItem}`, undefined,
    `orbs drop from mobs (Regal, Chaos and Vaal only from frontier wraiths), are fused by enchanters from 10 orb shards at the altar, or bought from players${orb === 'transmute' || orb === 'augment' ? '; the shop sells this one' : ''}`);
  const { fee, luck, feeCut } = modderTerms(p, orb, u.mods);
  if ((p.inventory.silver ?? 0) < fee) fail('NOT_ENOUGH_ITEMS', `the altar fee is ${fee} silver (carried: ${p.inventory.silver ?? 0})`, undefined, 'fees grow with each modification of the same item; an enchanter with a good hammer pays less');
  const before = { rarity: u.rarity, affixes: u.affixes.map((a) => ({ ...a })) };
  g.markUnique(u); // marked first: a failed command reloads it from the database
  const outcome = applyOrb(g, u, orb, luck); // validates before anything is spent
  removeItems(p.inventory, [{ item: orbItem, qty: 1 }, { item: 'silver', qty: fee }]);
  u.mods++;
  g.store.ledger('destroyed.orbFee', fee);
  g.store.ledger(`orbs.used.${orb}`, 1);
  const xp = gainXp(p, 'enchanting', XP.modify * (itemDef(orbItem)?.tier ?? 1));
  const lines = u.affixes.map((a) => `T${a.tier} ${affixText(a.id, a.value)}`);
  g.emit('item.modified', { kind: 'operator' }, { playerId: p.id, name: p.name, item: u.id, base: u.base, orb, outcome, fee, rarity: u.rarity, corrupted: u.corrupted, affixes: lines }, { zone: 'town', actor: p });
  g.setLastAction(p, 'modify', `${orb} on ${u.base}: ${outcome}${lines.length ? ` (${lines.join('; ')})` : ''}`);
  g.markPlayer(p);
  return { item: u, orb, outcome, fee, feeCut: Math.round(feeCut * 100) / 100, luck: Math.round(luck * 100) / 100, before, xp };
}

function salvage(g: Game, p: Player, payload: Record<string, any>) {
  requirePlace(g, p, 'altar', 'salvaging');
  const u = resolveUnique(g, p, reqStr(payload, 'item', 60));
  if (requireOwned(p, u.id) === 'equipped') fail('BAD_REQUEST', `${u.id} is equipped; unequip it first`);
  const tier = itemDef(u.base)?.tier ?? 1;
  const shards = (ORBS.salvage.perTier[tier] ?? 1) + ORBS.salvage.perAffix * u.affixes.length + (u.rarity === 'rare' ? ORBS.salvage.rareBonus : 0);
  removeItems(p.inventory, [{ item: u.id, qty: 1 }]);
  g.uniques.delete(u.id);
  g.markUnique(u);
  if (p.wear) delete p.wear[u.id];
  addItems(p.inventory, [{ item: 'orb_shard', qty: shards }]);
  g.store.ledger('shards.created.salvage', shards);
  g.emit('item.salvaged', { kind: 'operator' }, { playerId: p.id, name: p.name, item: u.id, base: u.base, shards }, { zone: 'town', actor: p });
  g.setLastAction(p, 'salvage', `salvaged ${u.base} into ${shards} orb shards`);
  g.markPlayer(p);
  return { salvaged: u.id, shards, inventoryShards: p.inventory.orb_shard ?? 0 };
}

/** Fee and odds a modification would cost this player right now (read-only). */
function quote(g: Game, p: Player, payload: Record<string, any>) {
  const orb = reqStr(payload, 'orb', 20).replace(/^orb_/, '') as OrbId;
  if (!ORB_IDS.includes(orb)) fail('BAD_REQUEST', `unknown orb "${payload.orb}"`);
  const u = resolveUnique(g, p, reqStr(payload, 'item', 60));
  const t = modderTerms(p, orb, u.mods);
  const maxTier = AFFIX_TIER_MIN_ILVL.filter((m) => u.ilvl >= m).length;
  return { item: u.id, orb, fee: t.fee, feeCut: Math.round(t.feeCut * 100) / 100, luck: Math.round(t.luck * 100) / 100, mods: u.mods, corrupted: u.corrupted, maxAffixTier: maxTier };
}

export const orbCommands: Record<string, CommandDef> = {
  'item.modify': { mutates: true, run: modify },
  'item.salvage': { mutates: true, run: salvage },
  'item.quote': { mutates: false, run: quote },
};
