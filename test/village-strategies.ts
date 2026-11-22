// The best strategy an offline search found for each side in each case (values, build, map), under the first shared
// work rule, which paid at the moment of gathering. Not searched again under the pooling rule, so no proof of the
// economy: economy.test.ts replays a few of them as a smoke check. The search was a hill climb over every player's focus skills, where they look for work,
// how often they go home and what they refine, started from what every other case found. For the exile, the three who
// stay re-planned for their own income and the exile answered, three rounds in a row.
// Change a rule that moves the economy and these may stop being the best: search again before trusting a pass.

import type { BuildingId, SkillId } from '../src/shared/catalog.ts';
import type { BuildId, Roam, Side, Strategy, ValueId } from './village-sim.ts';

/** Seconds between trips home, least silver per second worth refining, how far down the chain a player looks. */
interface Found { focus: string; trip: number; gain: number; outlook?: number; roam?: string; buildings?: string; exiled?: [number, number, number] }

export const MAPS = [11, 23, 42];
type Searched = Exclude<Side, 'separate'>;

const FOUND: Record<string, Record<Searched, Found>> = {
  'cost fresh 11': {
    solo: { focus: 'armorcraft swords woodworking / mining woodcutting smelting / tanning enchanting swords / mining woodcutting toolcraft', trip: 75, gain: 14, roam: 'frontier any frontier near' },
    founders: { focus: 'mining smelting weaponcraft / mining woodcutting woodworking / mining smelting weaponcraft / mining smelting weaponcraft', trip: 120, gain: 8, roam: 'near any any any', buildings: 'workshop' },
    altFounders: { focus: 'mining swords woodcutting / swords woodworking weaponcraft / mining weaponcraft toolcraft / mining woodcutting toolcraft', trip: 120, gain: 8, roam: 'any frontier frontier any', buildings: 'workshop farm kitchen' },
    village: { focus: 'woodworking mining toolcraft / woodcutting smelting toolcraft / smelting tanning mining / mining enchanting armorcraft', trip: 45, gain: 0, outlook: 0.5 },
    exile: { focus: 'toolcraft smelting mining / mining smelting enchanting / swords mining enchanting / enchanting mining toolcraft', trip: 45, gain: 4, outlook: 0.3, roam: 'any any any near', exiled: [75, 0, 1] },
  },
  'cost fresh 23': {
    solo: { focus: 'enchanting tanning swords / mining armorcraft smelting / toolcraft armorcraft swords / mining weaponcraft smelting', trip: 180, gain: 1e9, outlook: 0.5, roam: 'frontier any frontier any' },
    founders: { focus: 'mining smelting weaponcraft / mining woodcutting toolcraft / mining toolcraft weaponcraft / swords woodworking weaponcraft', trip: 120, gain: 8, roam: 'any any any frontier', buildings: 'workshop' },
    altFounders: { focus: 'woodworking swords smelting / mining enchanting armorcraft / woodworking smelting armorcraft / mining woodworking armorcraft', trip: 450, gain: 22, roam: 'frontier any frontier any', buildings: 'workshop farm kitchen' },
    village: { focus: 'weaponcraft woodworking enchanting / woodcutting smelting woodworking / mining tanning enchanting / mining swords smelting', trip: 45, gain: 0 },
    exile: { focus: 'mining smelting weaponcraft / mining toolcraft enchanting / mining smelting swords / enchanting armorcraft swords', trip: 45, gain: 0, outlook: 0.3, roam: 'any any near frontier', exiled: [450, 14, 0.3] },
  },
  'cost fresh 42': {
    solo: { focus: 'mining tanning toolcraft / enchanting swords woodcutting / tanning armorcraft swords / mining swords toolcraft', trip: 45, gain: 8, roam: 'any frontier any any' },
    founders: { focus: 'mining toolcraft weaponcraft / mining toolcraft swords / mining smelting weaponcraft / mining swords toolcraft', trip: 300, gain: 4, outlook: 0.5, roam: 'any any any frontier', buildings: 'workshop' },
    altFounders: { focus: 'mining swords enchanting / mining tanning woodcutting / mining smelting weaponcraft / mining swords toolcraft', trip: 450, gain: 4, outlook: 0.15, roam: 'frontier any any any', buildings: 'workshop farm kitchen' },
    village: { focus: 'weaponcraft enchanting woodcutting / smelting toolcraft mining / smelting swords mining / mining woodworking armorcraft', trip: 45, gain: 8, outlook: 0.5, roam: 'near any any near' },
    exile: { focus: 'enchanting smelting swords / mining smelting armorcraft / woodworking mining woodcutting / swords woodworking woodcutting', trip: 45, gain: 14, outlook: 0.15, roam: 'frontier any near frontier', exiled: [120, 4, 0.15] },
  },
  'cost veteran 11': {
    solo: { focus: 'weaponcraft enchanting swords / woodworking smelting mining / armorcraft woodcutting swords / tanning smelting mining', trip: 75, gain: 8, outlook: 0.3, roam: 'any any near any' },
    founders: { focus: 'tanning enchanting swords / weaponcraft smelting mining / weaponcraft armorcraft woodcutting / weaponcraft smelting mining', trip: 45, gain: 4, buildings: 'workshop' },
    altFounders: { focus: 'woodworking enchanting swords / weaponcraft smelting mining / weaponcraft smelting swords / enchanting smelting mining', trip: 45, gain: 8, outlook: 0.5, roam: 'any any frontier any', buildings: 'workshop farm kitchen' },
    village: { focus: 'mining smelting enchanting / mining woodworking armorcraft / mining smelting weaponcraft / woodcutting weaponcraft mining', trip: 45, gain: 0, outlook: 0.15 },
    exile: { focus: 'mining smelting tanning / smelting weaponcraft woodcutting / mining smelting woodworking / armorcraft mining swords', trip: 45, gain: 14, outlook: 0.15, roam: 'any any any frontier', exiled: [45, 4, 0.8] },
  },
  'cost veteran 23': {
    solo: { focus: 'armorcraft swords woodcutting / mining swords weaponcraft / mining smelting swords / mining toolcraft woodcutting', trip: 180, gain: 4, roam: 'near frontier any any' },
    founders: { focus: 'mining smelting armorcraft / mining smelting swords / tanning armorcraft swords / mining smelting enchanting', trip: 120, gain: 8, buildings: 'workshop' },
    altFounders: { focus: 'mining swords smelting / mining toolcraft smelting / tanning enchanting swords / mining swords woodcutting', trip: 120, gain: 8, buildings: 'workshop farm kitchen' },
    village: { focus: 'woodworking smelting mining / mining woodcutting weaponcraft / mining smelting armorcraft / tanning mining woodworking', trip: 45, gain: 0, roam: 'any any any frontier' },
    exile: { focus: 'tanning smelting mining / mining smelting woodcutting / tanning mining woodcutting / smelting swords mining', trip: 45, gain: 14, outlook: 1, roam: 'near near frontier frontier', exiled: [450, 14, 0.15] },
  },
  'cost veteran 42': {
    solo: { focus: 'mining swords tanning / mining swords smelting / tanning armorcraft swords / mining swords tanning', trip: 180, gain: 14, roam: 'any any any near' },
    founders: { focus: 'mining smelting swords / mining smelting swords / mining smelting armorcraft / mining smelting swords', trip: 180, gain: 8, outlook: 0.3, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting swords / mining smelting swords / mining smelting tanning / mining smelting swords', trip: 120, gain: 8 },
    village: { focus: 'weaponcraft mining woodworking / woodworking smelting mining / smelting mining swords / mining woodcutting armorcraft', trip: 45, gain: 4, outlook: 0.3 },
    exile: { focus: 'woodcutting mining woodworking / armorcraft smelting mining / smelting mining tanning / swords smelting mining', trip: 45, gain: 4, outlook: 1, roam: 'frontier any any frontier', exiled: [120, 1e9, 0.15] },
  },
  'cost maxed 11': {
    solo: { focus: 'mining enchanting smelting / mining swords smelting / swords woodcutting toolcraft / mining weaponcraft smelting', trip: 75, gain: 8, outlook: 0.15 },
    founders: { focus: 'mining smelting armorcraft / mining smelting swords / mining smelting weaponcraft / mining smelting enchanting', trip: 75, gain: 8, outlook: 0.3, roam: 'any any any near', buildings: 'workshop' },
    altFounders: { focus: 'mining smelting swords / mining smelting tanning / mining smelting weaponcraft / mining smelting tanning', trip: 75, gain: 8, outlook: 0, buildings: 'workshop farm kitchen' },
    village: { focus: 'mining smelting enchanting / mining woodworking armorcraft / mining smelting woodworking / woodcutting weaponcraft mining', trip: 45, gain: 4, outlook: 0.15 },
    exile: { focus: 'mining smelting toolcraft / mining woodworking armorcraft / mining smelting woodworking / swords mining armorcraft', trip: 45, gain: 0, outlook: 0.5, roam: 'any frontier any frontier', exiled: [75, 8, 1] },
  },
  'cost maxed 23': {
    solo: { focus: 'mining swords smelting / mining swords smelting / swords woodcutting weaponcraft / mining swords smelting', trip: 120, gain: 14, outlook: 0.3 },
    founders: { focus: 'mining smelting swords / mining smelting swords / mining smelting weaponcraft / mining smelting swords', trip: 180, gain: 8, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting enchanting / mining smelting armorcraft / mining smelting woodcutting / mining smelting toolcraft', trip: 120, gain: 22, buildings: 'workshop farm kitchen' },
    village: { focus: 'mining smelting tanning / mining woodworking armorcraft / mining smelting woodcutting / woodcutting weaponcraft mining', trip: 45, gain: 0, outlook: 0 },
    exile: { focus: 'weaponcraft smelting mining / enchanting mining smelting / mining swords toolcraft / mining swords enchanting', trip: 45, gain: 4, roam: 'near any frontier frontier', exiled: [300, 14, 0.8] },
  },
  'cost maxed 42': {
    solo: { focus: 'mining smelting armorcraft / mining smelting swords / mining smelting armorcraft / mining smelting swords', trip: 120, gain: 14, outlook: 0.3, roam: 'any near any any' },
    founders: { focus: 'mining smelting swords / mining smelting swords / mining smelting woodworking / mining smelting woodcutting', trip: 120, gain: 22, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting toolcraft / mining smelting woodcutting / mining smelting woodcutting / mining smelting tanning', trip: 75, gain: 14 },
    village: { focus: 'weaponcraft mining woodworking / swords smelting mining / smelting mining woodcutting / mining woodcutting armorcraft', trip: 45, gain: 4, outlook: 0.3, roam: 'frontier any any any' },
    exile: { focus: 'weaponcraft mining toolcraft / swords smelting mining / smelting mining enchanting / mining woodworking toolcraft', trip: 45, gain: 14, outlook: 0.3, roam: 'frontier any any any', exiled: [180, 14, 0.3] },
  },
  'quest fresh 11': {
    solo: { focus: 'mining toolcraft woodcutting / mining smelting woodcutting / mining smelting weaponcraft / woodcutting weaponcraft woodworking', trip: 120, gain: 4 },
    founders: { focus: 'mining smelting weaponcraft / woodcutting enchanting woodworking / mining smelting weaponcraft / mining smelting weaponcraft', trip: 120, gain: 8, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting toolcraft / mining smelting enchanting / mining smelting swords / mining smelting toolcraft', trip: 75, gain: 0, outlook: 0.15, roam: 'any near any any', buildings: 'workshop farm kitchen' },
    village: { focus: 'weaponcraft toolcraft woodcutting / smelting woodworking mining / smelting swords mining / mining enchanting swords', trip: 45, gain: 4 },
    exile: { focus: 'enchanting smelting mining / mining smelting enchanting / woodworking mining woodcutting / weaponcraft woodworking swords', trip: 75, gain: 0, outlook: 0.3, roam: 'any near any frontier', exiled: [450, 22, 0.5] },
  },
  'quest fresh 23': {
    solo: { focus: 'mining smelting weaponcraft / mining smelting enchanting / mining smelting tanning / mining swords enchanting', trip: 120, gain: 4, roam: 'any any near frontier' },
    founders: { focus: 'mining smelting weaponcraft / armorcraft weaponcraft swords / mining smelting weaponcraft / mining smelting weaponcraft', trip: 120, gain: 8, roam: 'any frontier any any', buildings: 'workshop' },
    altFounders: { focus: 'mining smelting weaponcraft / mining smelting armorcraft / mining smelting swords / mining smelting toolcraft', trip: 75, gain: 0, outlook: 0.15, roam: 'any near any near', buildings: 'workshop farm kitchen' },
    village: { focus: 'weaponcraft woodworking tanning / woodcutting smelting tanning / mining woodcutting swords / mining enchanting smelting', trip: 45, gain: 8, outlook: 0.3, roam: 'near any near near' },
    exile: { focus: 'armorcraft smelting tanning / mining armorcraft swords / woodcutting toolcraft smelting / mining woodcutting weaponcraft', trip: 45, gain: 0, outlook: 0.3, roam: 'any near near any', exiled: [20, 4, 0.8] },
  },
  'quest fresh 42': {
    solo: { focus: 'mining toolcraft woodworking / mining smelting woodcutting / mining smelting weaponcraft / woodcutting enchanting woodworking', trip: 120, gain: 4 },
    founders: { focus: 'toolcraft enchanting armorcraft / mining smelting weaponcraft / mining smelting swords / mining woodcutting smelting', trip: 75, gain: 4, roam: 'frontier any any any', buildings: 'workshop' },
    altFounders: { focus: 'mining smelting woodcutting / mining enchanting swords / mining smelting weaponcraft / mining enchanting smelting', trip: 45, gain: 4, roam: 'any any any near', buildings: 'workshop farm kitchen' },
    village: { focus: 'weaponcraft mining swords / woodcutting smelting tanning / mining smelting woodworking / mining enchanting toolcraft', trip: 45, gain: 8, roam: 'near any near near' },
    exile: { focus: 'mining tanning smelting / enchanting tanning mining / mining smelting enchanting / weaponcraft swords woodcutting', trip: 45, gain: 0, outlook: 0.3, roam: 'near any near frontier', exiled: [300, 14, 0.5] },
  },
  'quest veteran 11': {
    solo: { focus: 'mining smelting weaponcraft / woodworking armorcraft swords / tanning woodcutting swords / mining smelting toolcraft', trip: 120, gain: 8, roam: 'any frontier near any' },
    founders: { focus: 'enchanting weaponcraft swords / weaponcraft smelting mining / enchanting tanning swords / woodcutting smelting mining', trip: 75, gain: 22, buildings: 'workshop' },
    altFounders: { focus: 'enchanting weaponcraft swords / woodworking tanning woodcutting / woodworking smelting mining / weaponcraft smelting mining', trip: 45, gain: 8, buildings: 'workshop farm kitchen' },
    village: { focus: 'woodworking smelting mining / mining armorcraft weaponcraft / mining smelting enchanting / woodcutting weaponcraft swords', trip: 45, gain: 22, outlook: 0.3 },
    exile: { focus: 'weaponcraft mining woodworking / armorcraft smelting mining / smelting mining woodcutting / toolcraft armorcraft mining', trip: 75, gain: 14, outlook: 0.3, exiled: [120, 22, 0.3] },
  },
  'quest veteran 23': {
    solo: { focus: 'mining swords smelting / mining enchanting smelting / swords woodcutting toolcraft / mining swords smelting', trip: 180, gain: 22, roam: 'any any near any' },
    founders: { focus: 'mining enchanting smelting / mining swords smelting / tanning toolcraft swords / mining weaponcraft smelting', trip: 75, gain: 4, roam: 'any any frontier any', buildings: 'workshop' },
    altFounders: { focus: 'mining smelting toolcraft / mining smelting toolcraft / mining smelting swords / mining smelting swords', trip: 75, gain: 0, buildings: 'workshop farm kitchen' },
    village: { focus: 'woodcutting smelting armorcraft / mining swords tanning / mining smelting weaponcraft / woodworking weaponcraft mining', trip: 45, gain: 22, outlook: 0, roam: 'any frontier any any' },
    exile: { focus: 'mining armorcraft woodworking / mining smelting woodcutting / smelting weaponcraft mining / swords mining woodworking', trip: 120, gain: 22, outlook: 0.15, roam: 'frontier near near frontier', exiled: [45, 4, 0.5] },
  },
  'quest veteran 42': {
    solo: { focus: 'mining tanning smelting / enchanting swords toolcraft / mining tanning smelting / mining toolcraft smelting', trip: 120, gain: 4, outlook: 0.15 },
    founders: { focus: 'mining smelting swords / mining smelting swords / mining smelting weaponcraft / mining smelting woodcutting', trip: 120, gain: 22, roam: 'any any near any', buildings: 'workshop' },
    altFounders: { focus: 'mining smelting swords / mining smelting swords / mining smelting tanning / mining smelting swords', trip: 120, gain: 8, buildings: 'workshop farm kitchen' },
    village: { focus: 'woodworking smelting mining / mining woodcutting weaponcraft / mining smelting swords / woodcutting mining swords', trip: 45, gain: 8, outlook: 0.5 },
    exile: { focus: 'woodworking smelting mining / mining woodworking tanning / woodcutting weaponcraft enchanting / mining swords woodworking', trip: 75, gain: 14, outlook: 0.5, roam: 'any frontier any any', exiled: [120, 8, 0.5] },
  },
  'quest maxed 11': {
    solo: { focus: 'mining weaponcraft smelting / mining swords smelting / tanning woodcutting smelting / mining armorcraft smelting', trip: 120, gain: 8, outlook: 0, roam: 'any any near any' },
    founders: { focus: 'mining smelting weaponcraft / mining smelting swords / mining smelting woodworking / mining smelting armorcraft', trip: 120, gain: 22, outlook: 0.3, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting woodcutting / mining smelting armorcraft / mining smelting woodcutting / mining smelting woodworking', trip: 75, gain: 8, outlook: 0.15, roam: 'near any any any', buildings: 'workshop farm kitchen' },
    village: { focus: 'mining smelting woodworking / smelting weaponcraft woodcutting / smelting weaponcraft mining / swords smelting mining', trip: 20, gain: 22, outlook: 0.3, roam: 'any near frontier any' },
    exile: { focus: 'weaponcraft mining tanning / tanning smelting mining / smelting mining toolcraft / mining swords smelting', trip: 20, gain: 14, outlook: 0.15, roam: 'any frontier any any', exiled: [180, 8, 0] },
  },
  'quest maxed 23': {
    solo: { focus: 'mining swords smelting / mining swords smelting / swords woodcutting weaponcraft / mining swords smelting', trip: 120, gain: 14, outlook: 0.5 },
    founders: { focus: 'mining smelting swords / mining smelting swords / mining smelting weaponcraft / mining smelting swords', trip: 180, gain: 8, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting weaponcraft / mining smelting armorcraft / mining smelting swords / mining smelting toolcraft', trip: 75, gain: 0 },
    village: { focus: 'tanning smelting mining / armorcraft woodcutting weaponcraft / mining smelting enchanting / woodworking mining tanning', trip: 45, gain: 4, outlook: 0, roam: 'any any any frontier' },
    exile: { focus: 'armorcraft woodcutting weaponcraft / mining smelting armorcraft / woodworking mining tanning / smelting swords mining', trip: 45, gain: 14, outlook: 0, roam: 'near near frontier any', exiled: [75, 4, 0] },
  },
  'quest maxed 42': {
    solo: { focus: 'mining swords smelting / mining swords smelting / swords woodcutting weaponcraft / mining swords smelting', trip: 120, gain: 14, outlook: 0, roam: 'any any near any' },
    founders: { focus: 'mining smelting toolcraft / mining smelting armorcraft / mining smelting tanning / mining smelting swords', trip: 45, gain: 0, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting swords / mining smelting woodcutting / mining smelting tanning / mining smelting swords', trip: 75, gain: 4 },
    village: { focus: 'mining smelting woodworking / toolcraft weaponcraft woodcutting / smelting enchanting mining / enchanting toolcraft mining', trip: 20, gain: 22, outlook: 0.5, roam: 'near any near frontier' },
    exile: { focus: 'weaponcraft mining woodworking / smelting woodcutting mining / smelting mining woodworking / mining toolcraft smelting', trip: 45, gain: 4, outlook: 0, exiled: [300, 4, 0] },
  },
  'shop fresh 11': {
    solo: { focus: 'mining smelting armorcraft / mining weaponcraft woodcutting / mining smelting swords / mining weaponcraft woodcutting', trip: 75, gain: 0, roam: 'near near any any' },
    founders: { focus: 'mining smelting tanning / mining smelting armorcraft / mining woodworking weaponcraft / mining woodworking weaponcraft', trip: 120, gain: 4, outlook: 1, roam: 'any any near any', buildings: 'workshop' },
    altFounders: { focus: 'mining smelting armorcraft / mining smelting armorcraft / mining smelting weaponcraft / mining smelting tanning', trip: 75, gain: 8, outlook: 0.5, buildings: 'workshop farm kitchen' },
    village: { focus: 'swords smelting woodcutting / mining toolcraft woodworking / mining weaponcraft toolcraft / woodcutting weaponcraft armorcraft', trip: 20, gain: 0, outlook: 0.5, roam: 'any near any any' },
    exile: { focus: 'weaponcraft woodworking enchanting / toolcraft smelting weaponcraft / mining woodcutting woodworking / mining weaponcraft woodcutting', trip: 45, gain: 8, roam: 'near any near near', exiled: [120, 1e9, 0.3] },
  },
  'shop fresh 23': {
    solo: { focus: 'tanning weaponcraft smelting / mining enchanting smelting / mining woodcutting weaponcraft / mining woodworking weaponcraft', trip: 45, gain: 0, roam: 'frontier any any any' },
    founders: { focus: 'mining smelting swords / mining smelting weaponcraft / mining swords smelting / mining woodworking weaponcraft', trip: 120, gain: 4, roam: 'near any any any', buildings: 'workshop' },
    altFounders: { focus: 'mining smelting enchanting / mining tanning weaponcraft / woodcutting mining woodworking / mining smelting woodcutting', trip: 120, gain: 4, roam: 'near frontier any any', buildings: 'workshop farm kitchen' },
    village: { focus: 'mining smelting swords / mining toolcraft weaponcraft / woodworking mining weaponcraft / woodcutting weaponcraft armorcraft', trip: 20, gain: 4, outlook: 0.5, roam: 'frontier near near near' },
    exile: { focus: 'mining smelting weaponcraft / woodworking mining toolcraft / woodcutting weaponcraft armorcraft / mining woodworking woodcutting', trip: 45, gain: 4, roam: 'any near near any', exiled: [120, 4, 0.3] },
  },
  'shop fresh 42': {
    solo: { focus: 'mining smelting woodcutting / mining weaponcraft woodcutting / mining smelting armorcraft / mining weaponcraft woodcutting', trip: 75, gain: 0, outlook: 1, roam: 'near near any near' },
    founders: { focus: 'mining smelting swords / mining smelting weaponcraft / mining swords weaponcraft / mining woodworking weaponcraft', trip: 120, gain: 0, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting weaponcraft / mining smelting armorcraft / mining armorcraft swords / mining smelting toolcraft', trip: 75, gain: 0, outlook: 0.15, roam: 'any any frontier any', buildings: 'workshop farm kitchen' },
    village: { focus: 'tanning smelting weaponcraft / mining swords weaponcraft / woodworking mining weaponcraft / woodcutting weaponcraft armorcraft', trip: 45, gain: 14, outlook: 0.3, roam: 'any near near any' },
    exile: { focus: 'tanning smelting woodcutting / woodworking mining weaponcraft / toolcraft weaponcraft mining / mining smelting tanning', trip: 45, gain: 8, outlook: 0.3, roam: 'any near near any', exiled: [75, 22, 0.3] },
  },
  'shop veteran 11': {
    solo: { focus: 'mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 8, roam: 'near any near any' },
    founders: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / mining smelting swords / mining toolcraft woodcutting', trip: 75, gain: 22, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting tanning / mining toolcraft woodcutting / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 14, buildings: 'workshop farm kitchen' },
    village: { focus: 'mining smelting woodworking / smelting toolcraft woodcutting / smelting toolcraft mining / weaponcraft toolcraft mining', trip: 20, gain: 22 },
    exile: { focus: 'mining smelting woodworking / smelting toolcraft woodcutting / smelting toolcraft mining / mining woodcutting toolcraft', trip: 20, gain: 22, outlook: 1, roam: 'near near any near', exiled: [120, 8, 0.5] },
  },
  'shop veteran 23': {
    solo: { focus: 'mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 4, roam: 'any near near near' },
    founders: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / mining smelting swords / mining toolcraft woodcutting', trip: 75, gain: 0, buildings: 'workshop' },
    altFounders: { focus: 'mining smelting woodworking / mining armorcraft woodcutting / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 0, roam: 'any frontier near any', buildings: 'workshop farm kitchen' },
    village: { focus: 'mining smelting woodworking / smelting toolcraft woodcutting / smelting toolcraft mining / tanning toolcraft mining', trip: 20, gain: 22 },
    exile: { focus: 'mining smelting woodworking / smelting toolcraft woodcutting / tanning toolcraft mining / mining woodcutting toolcraft', trip: 20, gain: 22, outlook: 1, roam: 'any near near any', exiled: [45, 14, 0.8] },
  },
  'shop veteran 42': {
    solo: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / mining toolcraft woodcutting / mining toolcraft woodcutting', trip: 45, gain: 8, roam: 'any near near any' },
    founders: { focus: 'mining woodcutting toolcraft / mining toolcraft woodcutting / mining smelting weaponcraft / mining toolcraft woodcutting', trip: 75, gain: 8, roam: 'any near any any', buildings: 'workshop' },
    altFounders: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / mining smelting armorcraft / mining woodcutting toolcraft', trip: 45, gain: 0, buildings: 'workshop farm kitchen' },
    village: { focus: 'mining toolcraft woodworking / mining toolcraft tanning / smelting woodcutting woodworking / mining toolcraft woodworking', trip: 45, gain: 22, roam: 'any any near any' },
    exile: { focus: 'mining woodcutting woodworking / smelting toolcraft woodcutting / smelting toolcraft woodworking / mining toolcraft woodcutting', trip: 20, gain: 22, roam: 'near near frontier near', exiled: [20, 4, 0.3] },
  },
  'shop maxed 11': {
    solo: { focus: 'mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 4, outlook: 0.5, roam: 'near near any near' },
    founders: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / mining smelting weaponcraft / mining woodcutting toolcraft', trip: 45, gain: 8, buildings: 'workshop forge_hall' },
    altFounders: { focus: 'mining woodcutting toolcraft / mining swords smelting / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 22 },
    village: { focus: 'mining smelting woodworking / smelting toolcraft woodcutting / armorcraft toolcraft mining / tanning toolcraft mining', trip: 20, gain: 22, outlook: 1, roam: 'any any any frontier' },
    exile: { focus: 'smelting toolcraft woodcutting / armorcraft toolcraft mining / woodworking toolcraft mining / mining woodcutting toolcraft', trip: 20, gain: 22, roam: 'any any near near', exiled: [75, 4, 0.3] },
  },
  'shop maxed 23': {
    solo: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / mining toolcraft woodcutting / mining toolcraft woodcutting', trip: 45, gain: 22, outlook: 0.5 },
    founders: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / woodworking toolcraft enchanting / mining woodcutting toolcraft', trip: 45, gain: 0, buildings: 'workshop' },
    altFounders: { focus: 'mining woodcutting toolcraft / mining swords smelting / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 22 },
    village: { focus: 'mining smelting woodworking / tanning toolcraft woodcutting / smelting toolcraft mining / tanning toolcraft woodworking', trip: 20, gain: 22, outlook: 0.3, roam: 'near any any frontier' },
    exile: { focus: 'mining smelting woodworking / enchanting toolcraft woodcutting / smelting toolcraft mining / smelting toolcraft woodcutting', trip: 20, gain: 22, outlook: 0.5, roam: 'any any any near', exiled: [300, 14, 0.5] },
  },
  'shop maxed 42': {
    solo: { focus: 'mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 0, outlook: 0.5, roam: 'any any any near' },
    founders: { focus: 'mining toolcraft woodcutting / mining toolcraft woodcutting / mining smelting weaponcraft / mining woodcutting toolcraft', trip: 75, gain: 8, roam: 'any any any near', buildings: 'workshop farm kitchen' },
    altFounders: { focus: 'mining smelting weaponcraft / mining toolcraft woodcutting / mining woodcutting toolcraft / mining woodcutting toolcraft', trip: 45, gain: 8 },
    village: { focus: 'mining toolcraft woodworking / mining toolcraft woodworking / smelting woodcutting woodworking / mining toolcraft woodworking', trip: 45, gain: 22, roam: 'near any any any' },
    exile: { focus: 'mining weaponcraft woodworking / smelting toolcraft woodcutting / smelting toolcraft mining / mining woodcutting toolcraft', trip: 75, gain: 8, outlook: 0.5, roam: 'any any any near', exiled: [45, 8, 0.5] },
  },
};

/** Villages of the 200-minute stockpile test, searched on their own, as long runs reward other habits. */
const LONG_RUN: Record<string, Found> = {
  'fresh': { focus: 'weaponcraft swords woodcutting / smelting toolcraft mining / smelting swords mining / mining woodworking armorcraft', trip: 45, gain: 4 },
  'veteran': { focus: 'weaponcraft mining swords / woodcutting smelting woodworking / smelting mining woodworking / mining woodcutting woodworking', trip: 45, gain: 14 },
  'maxed': { focus: 'mining smelting enchanting / mining woodworking armorcraft / mining smelting woodworking / woodcutting weaponcraft mining', trip: 45, gain: 0 },
};

function parse(f: Found): Strategy {
  return {
    focus: f.focus.split(' / ').map((x) => x.split(' ') as SkillId[]),
    tripMs: f.trip * 1000,
    minGain: f.gain,
    outlook: f.outlook,
    roam: f.roam?.split(' ') as Roam[] | undefined,
    buildings: f.buildings?.split(' ') as BuildingId[] | undefined,
    ...(f.exiled ? { exiled: { tripMs: f.exiled[0] * 1000, minGain: f.exiled[1], outlook: f.exiled[2] } } : {}),
  };
}

export function strategiesFor(values: ValueId, build: BuildId, map: number): Record<Searched | 'stock', Strategy> {
  const found = FOUND[`${values} ${build} ${map}`];
  if (!found) throw new Error(`no strategy searched for ${values} ${build} on map ${map}`);
  return {
    solo: parse(found.solo), founders: parse(found.founders), altFounders: parse(found.altFounders),
    village: parse(found.village), exile: parse(found.exile), stock: parse(LONG_RUN[build]),
  };
}
