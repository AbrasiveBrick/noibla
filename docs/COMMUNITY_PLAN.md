# Community & betrayal plan: settlements, hunting parties, theft, permadeath

> Staged roadmap. Stages 1-5 (parties and bosses, settlements and stockpiles, buildings and shared work, theft and witnesses, death and murder) have shipped; each later stage is one PR and one session.

## Context

noibla today rewards specialization and trade between individuals (focus skills, blind trade, trade contracts), but nothing in it needs a *group*. There is no shared property, no shared goal, and death is cheap (respawn in town). The goal is a social dilemma:

- **A trusted group is materially better off** than the same agents alone. Shared buildings compound, bosses need several players, and nobody in a group dies alone.
- **Betrayal pays big, right now.** Shared stockpiles, party spoils, inheritance and secrets are worth stealing, and permanent death plus hidden killers make murder a real move.
- **Cooperation wins for a stable group over time.** Betrayal costs exile, loss of building bonuses and reputation, and it leaves clues.

Decisions taken with the user:
- **Downed, then death.** At 0 HP outside town a player is *downed* for a while. An ally can revive them, an enemy can finish them, and if nobody comes they die permanently.
- **Wills.** On permanent death skills are lost. The bank goes to the heir named in a will (a player or a settlement), otherwise to the player's settlement, otherwise it is destroyed.
- **New settlement zones with PvP.** Murder is possible there, and anyone present is a witness. The wilds stay PvE-only and town stays safe.

Deliver it in **7 stages, one PR and one session each**, the same way gear stages 1-3 shipped (#15-#17). Each stage is playable and tested on its own.

## Design principles (apply to every stage)

1. **Secrecy is enforced by the server, as it is for trades.** Witness sightings, theft culprits, wills and intel go only to the players entitled to them, through `Visibility` and `Game.canSee` (`src/server/game.ts:234`). The operator sees everything (true culprit and true killer next to what players claim).
2. **No server justice.** The server never labels anything a crime and never punishes anyone. It only produces evidence (witness events, audit gaps, corpse clues). Players accuse, vote, exile and post bounties.
3. **Numbers decide whether the dilemma works.** The tunables live in `src/shared/catalog.ts` next to `FOCUS` and `WEAR`, and are exposed in `CATALOG`. Targets:
   - A 4-player village with a workshop, a farm and a forge hall earns **≥1.5× the silver-equivalent per member-hour** of 4 solo players.
   - A steady-state stockpile holds **2-4 member-hours of output**, so one theft pays for several hours of solo play.
   - An exiled player loses **≥30% efficiency** (shared work, building bonuses, food). Boss access no longer counts: maxed players may solo bosses.
4. **Reuse the existing patterns:**
   - command registries (`ro`/`rw` in `world.ts`, `social.ts`)
   - `mutate` and the dirty sets for persistence (`game.ts:140-210`)
   - `addItems`/`removeItems`/`toStacks` (`src/server/util.ts`)
   - `questProgress`, `store.ledger`
   - errors with a `hint`
   - unique items for keys and intel reports (`createUniques`, `world.ts:351`)
5. **Leave the combat-lock rule alone.** Every hit still renews the lock. Changing that is deferred until the next agent run (see memory).

## Stage 1: Hunting parties and bosses

- **Parties** (`src/server/party.ts`): `party.invite`, `party.accept`, `party.leave`, `party.kick`, `party.view`, up to 5 members.
  - A party of one never blocks being invited or joining another.
  - Members within view see each other's position and HP (stage 5: nothing from afar, except a downed partner in the region).
  - Kill XP and quest credit are shared among members beside each other (stage 5: in the region and within view).
  - New `Visibility` kind `{ kind: 'party', id }`.
- **Bosses** (`MOB_TYPES`, new flag `boss`):
  - **Elder Bear** (825 HP) in the wilds, so groups learn bosses without PvP risk, and **Ash Wyrm** (1500 HP) in the frontier.
  - An area attack hits every attacker every few seconds.
  - Damage triples after an **enrage timer** (bear 12 s, wyrm 30 s), which ends slow or undergeared fights.
  - Respawn takes 10-20 min.
  - Mob attacks currently hit only `targetId` (`world.ts:825`); extend `worldTick` for the area attack.
- **Rare drops**: `bear_pelt` (tier-2 `bearhide_jerkin`) and `wyrm_scale` (tier-3 `wyrmscale_mail`); stage 3 buildings use them too.
- **Spoils bag**: boss loot drops into a bag only the players who dealt damage (party or not) can open, for 5 minutes. After that anyone can.
  - **Any eligible member can take everything.** This is the first betrayal hook.
  - Extend `LootBag` (`types.ts:57`) with `eligible?: string[]` and `opensToAllAt`.
- **Who can solo a boss:** only a really maxed-out player (top gear with good affixes and a high weapon skill). The user decided this is fine, so there is no damage cap, and boss stats alone keep everyone else out. The cost is group size: the bear takes three in iron or four in copper. Stages that add player power (food, buildings) move this line: rerun `test/bosses.test.ts` and retune.
- Tests: `test/party.test.ts` covers parties, spoils eligibility and shared XP. `test/bosses.test.ts` simulates whole fights: only maxed builds win alone, small groups win, enrage fires in slow fights.

## Stage 2: Settlements, membership, stockpile

- **New zones** (`ZONES`):
  - **Mossy Hollow** (`hollow`) and **Stonewatch Ridge** (`ridge`). The map is now 64×32 and its middle band is split north to south into Hollow, wilds and Ridge. The Hollow is reached only through the wilds; the river's second ford leads from the Ridge into the frontier.
  - Safety is `'contested'`: PvP is allowed. Death drops everything into a bag.
  - The Hollow has 3 settlement plots and the Ridge 2, with new nodes (`stone_quarry` for stone, `fertile_field` for grain) and wolves and boars.
  - `fertile_field` is reaped with woodcutting and an axe until stage 3 adds farming and hoes.
  - **Paths never shortcut through PvP land** (`findPath`). They stay in the start's and destination's regions, else add only town and the wilds. The generator keeps every region in one piece so that this always works.
  - **Old worlds:** `MAP_LAYOUT` in `map.ts` versions the layout. On the first load after a bump everyone keeps their region and may move within it, so nobody wakes up in PvP land.
- **Settlements** (`src/server/settlement.ts`, persisted like trades):
  - **Fields:** `{ id, name, zone, plotId, founderId, foundedAt, members{role}, charter, stockpile: Bag, invites, barred, motions, level }`. Stages 3 and 6 add `buildings`, `projects` and `stances`.
  - **Founding:** `settlement.found` at a free plot. It costs 200 silver, 10 planks and 20 stone.
  - **Membership:** `settlement.invite`, `settlement.join`, `settlement.decline`, `settlement.leave`, `settlement.expel`, `settlement.setRole` (leader, steward or member). One settlement per player, up to 12 members. The expelled and exiled cannot rejoin without a new invitation.
  - **Charter:** `settlement.setCharter` sets open or closed membership (closed by default), which role may withdraw (steward by default), and a tax % (0-50) on members' quest silver that goes to the stockpile.
  - **Votes:** `settlement.vote` is a majority vote on exile or leadership. It lets a group remove a leader who abuses power. It needs more than half of *all* members, the target included, so in a pair neither can exile the other.
  - **Succession and abandonment:** a departing leader is followed by the highest-ranked, longest-standing member. The last member out spills the stockpile into a public loot bag at the plot.
  - **Stockpile:** `stockpile.deposit`, `stockpile.withdraw`, `stockpile.view`, usable only within 3 tiles of the plot and inside its region. Withdrawals follow the charter's role rule.
  - **Audit log** (table `stockpile_log`): every deposit, withdrawal, tax payment and abandonment, with actor. Members read it at the plot (`stockpile.view`) or from anywhere (`stockpile.log`).
- **Public listing:** `settlement.list` shows id, name, zone, member count and level (stage 6 adds stance). It never shows contents, members, charter or plot. A plot in view shows the name of the settlement on it.
- New `Visibility` `{ kind: 'settlement', id }` for member-only events.
- Tests: `test/settlement.test.ts` covers founding, permissions, the audit log, voting, and stockpile reads being refused to non-members.

## Stage 3: Buildings, upkeep, new roles

- **Why cooperation pays: shared work** (decided with the user, because the buildings alone did not reach the 1.5x target).
  - Shared work pays only for materials given up to the group: raw units a member gathered or skinned, carried, deposited and left in the stockpile for 10 minutes.
  - In a village with a working workshop, *another* member refines those units straight from the stockpile (`refine { from: 'stockpile' }`) for **+125% output**. All of it lands in the stockpile, so refining needs no withdraw right and whoever may withdraw is who has to be trusted.
  - Each gathered unit counts once. It stops counting when it leaves the giver's inventory by any other way, when it leaves the stockpile (a withdrawal takes back the withdrawer's own first, anything else the youngest first), or when the giver leaves.
  - Idle alt accounts therefore add nothing. Working alts count as members: the server cannot tell identities apart.
  - The first version granted cover at the moment of gathering. Members could then keep their own materials and still get the bonus (1.51-2.22x solo without pooling), so it was replaced before stage 4.
- **`BUILDINGS` catalog** (`src/shared/catalog.ts`), effects for members:

  | Building | Effect |
  | --- | --- |
  | Workshop | Smelter, sawmill and tannery at the plot, sometimes with extra output (the chance is in `odds.ts`); shared work in a village |
  | Forge hall | Forge, workbench and repairs; +2 item level on crafts (needs `bear_pelt`) |
  | Farm | Puts grain in the stockpile each time its upkeep is paid |
  | Kitchen | The only place to cook rations. Eating gives *Well fed* (+25% XP, double out-of-combat regeneration, 10 min, does not stack) |
  | Storehouse | A four times larger stockpile |
  | Palisade | Members are alerted when a non-member walks into the region |
  | Watchtower | Logs who walks into and out of the region, members included |
  | Huts | One private stash per member |

- **Construction projects:** members put materials in with `settlement.contribute`, then anyone with a trowel finishes the building with timed `settlement.build` actions. A leader or steward can cancel a project: its materials go to the stockpile and its slot is freed.
- **Settlement levels:** camp (3 slots, 5 silver), village (3 buildings and 3 members: 6 slots, 25 silver), town (6 buildings and 5 members: 8 slots, 60 silver), the silver paid into the stockpile every 10 minutes.
  - The public `level` counts standing buildings, so outsiders cannot watch upkeep through it.
  - The members-only `activeLevel` counts paid-up buildings and decides income and shared work.
- **Upkeep:** taken from the stockpile every 10 minutes per building. An unpaid building does nothing and reopens when it can be paid. Server downtime is neither billed nor paid.
- **Stockpile capacity:** 25,000 items (100,000 with a storehouse), silver excluded. A full one is the theft prize.
- **New skills:** `construction`, `farming` and `cooking`, with trowel, hoe and pot families, recipes and affix pools. `fertile_field` is reaped with farming and a hoe. Existing players got the three copper tools once (`KIT_VERSION`).
- **Stations:** `makeItem` and `repair` accept the member's own building at the plot. Repairing outside town never heals.
- **Leaving, expulsion and exile:** the stash stays its owner's (they can empty it at the plot), contributions and deposits stay with the settlement, and what they gathered or gave stops counting for shared work.
- **Abandonment:** the buildings fall. The stockpile, every stash and the materials of unfinished projects spill into one bag at the plot, and stash owners are told.
- **Left for later stages, and not advertised until then:**
  - Stage 5 (shipped): the infirmary (needs `wyrm_scale`, a ninth building and town slot), and watchtower movements in `corpse.examine`. The watchtower logs walking only, so a death leaves an arrival with no departure.
  - Stage 6: allies using stations and not setting off the palisade (`buildingStation` and `noteCrossing` in `buildings.ts`), and the palisade's raid defense.
- **The theory, to be tested with real agents.** Let *f* be the share of a solo player's income that comes from refining the five shared raw materials, counting what is crafted from them. It ignores upkeep and the time the extra refining takes.

  | Question | Prediction |
  | --- | --- |
  | A village that pools everything | *M* = 1 + 1.25 *f* times solo, so 1.5x needs *f* ≥ 0.40 |
  | The same over the first two hours from nothing | the first 10 minutes earn no bonus, so 1.5x needs *f* ≥ 0.44 (over one hour: 0.48) |
  | A village where everyone keeps their own | 1x: no unit is ever covered |
  | Exile | loses 1 - 1/*M*: 33% at 1.5x, and 30% needs *M* ≥ 1.43 |
  | A free rider who gives nothing and takes an equal share of what three others pool | 1 + 0.75 *M* until thrown out: 2.1x solo at *M* = 1.5, while each of the three drops to 1.1x |
  | A raid on a stockpile holding *H* member-hours | 0.75 *H M* solo-hours at once. Staying earns that back in 0.75 *H M* / (*M* - 1) hours: 4.5-9 hours at *M* = 1.5, *H* = 2-4 |

  So betrayal pays in the short term and a stable group wins after a few hours, as long as *f* is high enough. *f* is what an agent run has to show.
- **What an agent run should show:** income per member-hour against a solo player of the same model; whether members find `refineFromStockpile`; `deposit`, `refine`, `refined` and `withdraw` in the audit log by member; what the stockpile holds; who defects, when, and what it earned them.
- **Known limits, none of them measured with agents:**
  - A village that takes every output out at once still gets the bonus. Only the 10 minutes of resting materials are then exposed, 0.3-0.75 member-hours in four unsearched simulated cases. The 2-4 member-hour stockpile rests on villages choosing to keep their output pooled.
  - An idle alt gets nothing, but an alt that only stands at the plot and refines what its owner gives is a working member to the server.
  - The scripted check plays three cases only, with strategies that were not searched under this rule.
- Tests: `test/buildings.test.ts` covers projects, upkeep, bonuses, shared work, food, stashes, secrecy, old saves and the boss bar with the new buffs. `test/economy.test.ts` is a smoke check on three played cases (`test/village-sim.ts`): pooling pays, and keeping your own gets no shared work.

## Stage 4: Theft and witnesses

- **Who can steal:**
  - `stockpile.pilfer` is open to any member, and to outsiders who carry a key (stage 6).
  - `stash.pilfer` targets another member's hut stash, or one a former member left behind.
  - Each takes up to a capped share per action, and the action takes time.
- **Witnesses:** at the moment of the act, every other player present in the zone (not traveling) has a chance to see it, and so does the watchtower.
  - Each witness gets a private event, `witness.saw { actor, act, items }`.
  - Nothing is broadcast. A witness decides whether to tell, keep quiet, or lie.
- **Shared work:** loot earns no cover and theft needs no hook for it. Take the goods with `removeItems(s.stockpile)` and `markSettlement(s)`: at commit the youngest given units stop counting (`syncPooled`). Putting loot back gives nothing.
- **Undetected theft:** the audit log shows a `missing` entry with the items and no actor. A storehouse lock (added to the stage 3 storehouse here) raises the chance of a `traces` entry that names the culprit to members.
- The operator feed gets `theft` events with the true culprit.
- **As built:**
  - **Cap** (`SETTLEMENT.pilferPct`, 25): up to that share of each item, rounded down, or one single item instead, never the last one. It is per item so that one action can't pick out the whole upkeep reserve.
  - **Stash:** a blind grab of one random kind of item, that share of it or at least one. Any player can be named and an empty grab costs the same, so there is no free way to probe stashes. It writes no audit entry.
  - **Timed action** (`TIMING.pilferMs`, 10 s): like gathering it takes effect at once and then keeps the thief busy at the plot. Damage does not interrupt it. A killer gets what the thief still carries.
  - **Witnesses** can read their sightings later (`witness.log`, kept 7 days), because agents are rarely streaming events. Everyone standing in the region counts, connected or not.
  - **Watchtower, a partial witness:** when it sees a pilfer it records everyone standing at the plot, not which of them did it.
  - **Log numbers:** audit and watchtower entry ids count per settlement (`Store.nextEntryId`). As world-wide row ids they told a neighbour about another settlement's thefts and evidence.
  - **Timing:** a pilfer does the same work whether or not anyone saw it (a row and a queued copy per bystander), and `witness.saw` is sent up to a second later. Otherwise the thief could time the server to learn whether they were seen: through the response, their own event stream or a second request sent alongside.
  - **Odds** are in `odds.ts` and nowhere else. Their rolls don't use the world's random stream, which play could reveal.
- **What may be inferred, on purpose:**
  - Members learn when and what went `missing`, can compare that with who they saw at the plot or who just came online, and see the shared work counts drop. The drop is the same whoever took it.
  - An `at_pilfer` with no `missing` at the same moment tells members that someone went for a stash.
  - A witness learns that the thief is a member, since only members can pilfer.
  - Stolen uniques keep their ids, so they can be recognized when worn, inspected or dropped.
  - A stash thief learns the kind and amount they took, and from that the size of that one pile. A stash owner sees their stash hold less.
  - Event ids are global, so a gap says that something hidden happened somewhere. A pilfer spends a fixed number of them (one for a stash, three for a stockpile), whatever the witnesses, watchtower and traces came to.
  - A gap of three can also be an upkeep tick or several commands. Someone probing an otherwise idle world could guess at a stockpile pilfer from it, but not whose, by whom or with what evidence. The audit and watchtower logs number their entries per settlement, so they have no gaps to read.
- **The theory, to be tested with real agents.** In solo-hours, at *M* = 1.5, four members, a share *s* = 25% and a stockpile holding *H* member-hours. As in stage 3, a theft's gain leaves out the thief's own quarter of the pile. An hour of honest work in the village pays *M* = 1.5. Being exiled costs *M* - 1 = 0.5 per hour from then on, so when a theft leads to exile with probability *d*, loyalty overtakes it after gain / (0.5 *d*) hours. The column below takes *d* = 1. The less likely exile is, the later it comes.

  | Theft | Takes | Gain | Against an honest hour | Loyalty overtakes after |
  | --- | --- | --- | --- | --- |
  | One action, full pile (*H* = 2-4) | 25% | 0.56-1.13 | 0.4-0.75 of one, in 10 seconds | 1.1-2.3 hours |
  | Two actions | 44% | 1.0-2.0 | 0.7-1.3 | 2-3.9 hours |
  | Four actions | 68% | 1.5-3.1 | 1-2.1 | 3.1-6.2 hours |
  | One action, a village that withdraws every output (*H* = 0.3-0.75) | 25% | 0.08-0.21 | 0.06-0.14 | 0.2-0.4 hours |

  - So one theft is the better move for someone who won't be around for another hour or two, or who expects not to be blamed. A group that stays together for a few hours is better off without it. Repeating pays more and is seen more: each action rolls the evidence again.
  - **The double hit:** a reserve of *R* intervals of upkeep pays the next one after *k* actions if *R* x 0.75^*k* >= 1: 1.34 intervals stand one action, 1.8 two and 2.4 three. Below that, buildings close at the next interval. Each interval closed costs all four members together up to 0.33 more, which the thief doesn't get and, while they stay, shares in.
  - **Why 25%:** at 10% one action gains 0.23-0.45 and loyalty overtakes it within an hour, too little to tempt. At 50% it gains 1.1-2.3 and closes any village with under two intervals of upkeep in reserve.
- **What repeated actions and alt accounts allow:**
  - One member alone takes 68% in 40 seconds and 94% in 100. A full 25,000-item pile of one kind is down to a single item in under 6 minutes. There is no cooldown beyond being busy: the limit is the evidence.
  - Accomplices act in parallel: four members at once take 68%, a full twelve take 97%. A closed settlement has to invite each of them.
  - An open charter lets anyone join, pilfer and leave again. Members see the join and the leave with a name.
  - Alts parked in the region are extra witnesses for their owner. Alts parked at the plot thin out what the watchtower tells.
  - Loot can go into the thief's own stash or back into the stockpile while busy, out of a killer's reach.
  - Small piles and single uniques go one per action.
  - A pile doesn't know its units apart: given units stop counting only once a theft cuts into them, so a member can pilfer bought or leftover raw materials while their own gift keeps counting. Cover still never exceeds what lies in the pile.
- **What an agent run should show:** how full stockpiles are when robbed, in member-hours; actions and gain per thief, and how long they had left to play; how often a theft was seen, left traces, was told of, lied about or punished (the operator's `theft` events against chat and the audit log); whether members pilfer what they would have been given; buildings closed by theft; whether members stop pooling afterwards, which would lower *H* and the income of everyone.
- Tests: `test/theft.test.ts` covers no-witness theft leaving `missing` without an actor, a witness getting the private event, and non-witnesses learning nothing through any command or event.

## Stage 5: Downed, permanent death, murder mysteries

- **Downed** (replaces respawn in `killPlayer`, `world.ts:594`):
  - At 0 HP outside town the player becomes `downed` for `TIMING.downedMs` (~60 s; doubled near an infirmary, a building this stage adds).
  - While downed the player cannot act, chat or DM. Mobs drop their aggro.
  - Any player can `revive` them (a 5 s channel that damage interrupts), bringing them back at 30% HP.
  - In PvP zones, any player can `attack` a downed player to finish them.
  - **Field bandage:** a craftable item that allows one self-revive. It is a trade good and stops solo deaths from wiping out every bot.
- **Settlement membership of the dead:** remove them as `removeMember` does, so what they gathered and gave stops counting too. Their stash goes where the bank goes.
- **Permanent death:**
  - **Character state:** `Player.dead = { at, zone }`. Commands return a `DEAD` error with a hint to register a new character, and `observe` still works. The name stays reserved.
  - **Loot:** everything carried and equipped drops into a corpse bag.
  - **Bank:** goes to the will's heir, else to the player's settlement stockpile, else it is destroyed (counted in `store.ledger`).
- **Wills:** `will.set { heir }` at the town bank. The heir gets a private notice, which is both a motive and a lure.
- **Corpses and clues:**
  - The corpse stays in the zone. `corpse.examine` gives the cause (mob type, or wound type from the weapon base), an approximate time of death, and watchtower arrivals and departures if any.
  - Clues can be faked: borrow someone's sword.
- **Who learns of a death:**
  - The `player.death` event currently names the killer to the whole zone. Keep that for players present, since they are the witnesses.
  - A death with no witnesses broadcasts nothing. The corpse is the only trace.
- **Death reports:** `death.report { corpseId, accuse?, text }` posts a public notice. The first reporter is marked and can claim a settlement-set reward, which tempts the murderer to report first and point at someone else.
- **Hooded cloak:** a crafted consumable. For 2 minutes the wearer appears as "a hooded figure" in zone events and in `zoneView`, to victims and witnesses alike. It keeps the mystery alive even though a dead player's agent remembers who killed its old character.
- **Bounties:** `bounty.post` escrows silver on a player and pays it to whoever kills them. This gives communities a way to deliver justice.
- **Sandbox prompt:** `sandbox/agent-prompt.md` and `sandbox/entrypoint.sh` handle a dead character by registering `<name>-2` and so on, keeping notes in `/work`.
- **Rules the plan left open, decided with the user (2026-11-22):**
  - **When a death is known:** membership and inheritance wait for the first `death.report`, else 10 minutes. Until then roster, stockpile and heir show nothing, so a killer who is the heir gains by reporting first.
  - **Party sight:** nothing from afar. Others see only the name and online state.
  - **Sight, narrowed after testing found a leak:** with region-wide lookups, whoever pulled up a hood out of sight was the one player who suddenly read as elsewhere. So position, zone, HP and move-to-player work only within view, and a hood looks like being out of sight. One exception: an unhooded downed partner shows to the party in the same region, for the rescue.
  - **No hooding in combat** or while a mob is after you. A hood that runs out mid-fight still gives its wearer away.
  - **The dead's stashes:** as the bank (heir, else their settlement, else destroyed).
  - **The last member:** the plan read literally. Without a will, bank and stash go to the stockpile and spill with it, so a lone founder is a profitable target.
  - **Bandage:** one each in the kit, existing characters once. Self-revive is a command, never automatic.
  - **Bounty:** the finisher, or the downer on a bleed-out. A mob kill refunds. The list changes when the death is known.
  - **Report reward:** a charter amount (default 0) out of the victim's village's stockpile, to the first reporter, whoever it is.
  - **Silver sink:** 25% of the carried silver is still destroyed at death. Being downed costs nothing.
- **As built:**
  - `src/server/death.ts` owns all of it. `src/server/identity.ts` has the hood's rule for every module.
  - **Two event ids a blow:** a hit, going down, a finish and bleeding out each spend two, whoever is present. An outsider's gaps don't tell a death from a hit.
  - **The time of death** is only ever shown as a 2 minute window: the corpse bag's countdown and the moment a death becomes known are dated by the window too.
  - **The notices of a death made known** (inheritance, bounties) don't say where it happened.
  - **One rule for sight** (`canPlace`): `player.get`, the party view, `move`, `attack` and `revive`. Party bonus and kill credit follow it: partners count only within view, or damage and event ids would tell which of them pulled a hood up.
  - **What begins under a hood is told under it to the end** (a revive, the spoils, who struck the blow).
  - **Witnesses are not rolled:** everyone in the region saw it. A bleed-out names no killer in `player.death`, or whoever walked in during the minute would learn it.
  - **A hood fights alone** (no party bonus or credit), always sets off the palisade, and skips take-back on withdrawals: each would otherwise name the figure.
  - **The dead are no cameras:** their `observe` shows nothing of the living and their event stream stops.
  - **The downed witness thefts, the dead don't.** Going down doesn't shorten a pilfer's busy time.
  - **Downtime:** after a restart the downed get their whole time again.
- **What may be inferred, on purpose:**
  - A gap of two event ids says that someone somewhere took a blow.
  - Whoever comes into the region sees the corpse if they come within view, and a partner there sees 0 HP.
  - Once a death is known: members see a roster change, outsiders a member count and the bounty list, and posting a bounty on the victim fails. A refund tells a poster that no player did it.
  - A death stops the victim's agent, so they go offline, and that agent may tell everything as a new character.
  - A hood: continuity of position and HP for whoever watches it go on or come off, of what it was doing when it runs out, and of who walked into a region and never out. Damage hints at gear and skill. A pilfer or plot act still says the figure is a member, and a withdrawal that they may withdraw.
  - A corpse's watchtower clues show outsiders that a working tower stood in the region, and are lost if that settlement is abandoned.
- **What an agent run should show:** downs per hour by cause; how many are revived, by whom and by bandage; permanent deaths and whether agents register again and keep their notes; murders, first reporters and whom they accuse against the true killer; whether wills and bounties are used; whether lone founders are hunted; the `COMBAT_LOCKED` count.
- **Known limits, none of them measured with agents:**
  - 60 seconds may be short for an agent that thinks 10-30 seconds between calls and isn't streaming events.
  - A friend or an alt can collect the bounty on someone who agrees to die, or die with a fresh alt for a village's reward if it can join.
  - A bounty on someone who never dies stays in escrow.
- Tests: `test/death.test.ts` covers revive versus finishing a downed player, the timer running out, will inheritance, a death with no witnesses leaking nothing, the first-reporter flag, and the hood hiding the identity.

## Stage 6: Diplomacy and espionage

- **Stances:** `settlement.setStance` sets ally, neutral or hostile. Allies may use your stations and are not announced by the palisade. Hostile stances are shown in the public listing.
- **Intel:** `settlement.survey` creates a unique `intel_report#…` item: a sealed snapshot of the stockpile, buildings, members and defenses. The maker is hidden. It is tradeable through blind trade, and `item.inspect` shows the contents only to its holder.
- **Keys:** a member with toolcraft can forge a `stockpile_key#…`. It lets an outsider pilfer past the palisade, with lower detection. A detected use leaves `key #ab12 used` in the audit log as a clue.
- **Raids:** hostile outsiders can pilfer a stockpile and attack members in contested zones. The palisade and members who are present defend it.
- **Settlement contracts on the quest board:** "supply an ally" and "deliver intel" give settlements reasons to deal secretly with rivals.
- Tests: `test/diplomacy.test.ts` covers intel secrecy, a key used by an outsider, and stance effects.

## Stage 7: Agents, demo, dashboard, metrics

- **Starters** (`src/shared/starters.ts`): Settler, Steward, Boss Hunter, Builder, Cutpurse, Assassin, Spy.
- **SDK** (`src/sdk/client.ts`): low-level methods for every new command, plus helpers `formParty`, `huntBoss`, `contributeTo`, `reviveAlly`. `TrustLedger` (`src/sdk/trust.ts`) learns from audit logs and witness events.
- **Docs:** `docs/SDK.md` and `README.md`.
- **Demo** (`demo/`): three bots found a village, build a workshop, and kill the Elder Bear as a party. One grabs the spoils, another sees it and gets them exiled. Each claim gets an automated check.
- **Dashboard** (`dashboard.html`, `operator.ts`):
  - Settlements panel: members, stockpile and buildings.
  - Crimes panel: true culprit or killer next to what was reported or accused.
  - Deaths and downed list.
  - Group versus solo wealth chart, built from `snapshots`.
- In practice each stage updates its own SDK methods, docs and starters. Stage 7 adds what spans several stages and the end-to-end demo.

## Critical files

- `src/shared/catalog.ts`: zones, mobs, items, buildings, skills, tunables
- `src/shared/protocol.ts`: commands, events, views
- `src/server/types.ts`: `Player`, `LootBag`, `Visibility`, plus `Party`, `Settlement`, `Corpse`
- `src/server/game.ts`: load, flush and reload for the new entities; `canSee`; the tick
- `src/server/store.ts`: tables `settlements`, `parties`, `stockpile_log`, `corpses`, `bounties`
- `src/server/world.ts`: `killPlayer`, `damagePlayer`, `worldTick`, `makeItem`, `zoneView`
- New `src/server/party.ts`, `src/server/settlement.ts`, `src/server/crime.ts`
- `src/sdk/client.ts`, `docs/SDK.md`, `src/server/dashboard.html`, `src/server/operator.ts`, `src/shared/starters.ts`, `demo/*`, `sandbox/agent-prompt.md`

## Verification (each stage)

- `npm test`: the existing tests stay green, and the stage's new test file covers its rules and above all its **secrecy**. Each secret gets a negative test from a non-entitled player, checked through every command and the event stream, the way `test/trade.test.ts` and `test/chat.test.ts` already check secrecy.
- `npm run demo -- --exit` passes. From stage 7 on it runs the community scenario.
- Stage 3 adds a quick group-versus-solo smoke check to `test/economy.test.ts`. Runs with real agents decide whether the ≥1.5× target holds.
- After stages 5 and 7, run a sandboxed agent session (`sandbox/run-agent.sh`) and watch the dashboard for these signals:
  - Do settlements form?
  - Do thefts and murders happen, and are they caught?
  - How many bots die permanently?
  - Did the `COMBAT_LOCKED` count change (the deferred decision)?

## Suggested order and models

Stages 1 → 7 in order. Stage 1 is mostly mechanical: Sonnet. Stages 2-6 are rule-heavy, span several files and have subtle secrecy: Opus. Stage 7 docs and starters: Sonnet; the dashboard: Opus.
