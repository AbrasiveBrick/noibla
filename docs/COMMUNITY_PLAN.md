# Community & betrayal plan: settlements, hunting parties, theft, permadeath

> Staged roadmap. Stages 1 (parties and bosses) and 2 (settlements and stockpiles) have shipped; each later stage is one PR and one session.

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
   - An exiled player loses **≥30% efficiency** (building bonuses, boss access, food).
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
  - Members see each other's zone and HP.
  - Kill XP and quest credit are shared among members in the zone.
  - New `Visibility` kind `{ kind: 'party', id }`.
- **Bosses** (`MOB_TYPES`, new flag `boss`):
  - **Elder Bear** (800 HP) in the wilds, so groups learn bosses without PvP risk, and **Ash Wyrm** (1500 HP) in the frontier.
  - An area attack hits every attacker every few seconds.
  - Damage triples after an **enrage timer** (~90 s), so a solo T2 player cannot reliably win before it.
  - Respawn takes 10-20 min.
  - Mob attacks currently hit only `targetId` (`world.ts:825`); extend `worldTick` for the area attack.
- **Rare drops**: `bear_pelt` (tier-2 `bearhide_jerkin`) and `wyrm_scale` (tier-3 `wyrmscale_mail`); stage 3 buildings use them too.
- **Spoils bag**: boss loot drops into a bag only the players who dealt damage (party or not) can open, for 5 minutes. After that anyone can.
  - **Any eligible member can take everything.** This is the first betrayal hook.
  - Extend `LootBag` (`types.ts:57`) with `eligible?: string[]` and `opensToAllAt`.
- Tests: `test/party.test.ts` covers enrage making a solo kill fail and a party kill succeed, spoils eligibility, and shared XP.

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

- **`BUILDINGS` catalog**: each building has a cost, an upkeep per interval taken from the stockpile, and an effect for members (allies where noted).

  | Building | Effect |
  | --- | --- |
  | Workshop | Smelter, sawmill and tannery in the settlement zone; +10% refine output |
  | Forge hall | Forge and workbench; +2 item level on crafts (needs `bear_pelt`) |
  | Farm | Produces grain each interval |
  | Kitchen | Turns grain into rations. Eating gives *Well fed* (+25% XP, faster regen) |
  | Storehouse | Larger stockpile; a lock raises theft detection |
  | Palisade | Members are told when a non-member enters; boss and raid defense |
  | Watchtower | Logs arrivals and departures in the zone for members; acts as a partial witness |
  | Infirmary | Doubles the downed timer for members in the zone; faster revive (needs `wyrm_scale`) |
  | Huts | One personal stash per member, which others can steal from |

- **Construction projects:** members contribute materials with `settlement.contribute`, then builders finish the building with timed `settlement.build` actions.
- **Settlement levels:** camp, then village (3 buildings, 3 members), then town (6 buildings, 5 members). Each level unlocks more building slots and a small passive silver income into the stockpile.
- **Upkeep:** unpaid upkeep disables a building. This keeps the stockpile in steady use and always worth stealing.
- **New skills:** `construction`, `farming` and `cooking`, with tool families trowel, hoe and pot.
  - Added to `SKILLS`, `TOOL_FAMILIES`, `STARTER_KIT` and the affix pools. Move `fertile_field` from woodcutting to farming.
  - Focus stays at 3 slots, so groups need more specialists.
- **Station bonuses:** `makeItem` (`world.ts:298`) checks settlement stations and bonuses besides `ZONES[zone].stations`.
- Tests: `test/buildings.test.ts` covers projects, upkeep disabling a building, bonuses, food, and a numeric check of the group-versus-solo target.

## Stage 4: Theft and witnesses

- **Who can steal:**
  - `stockpile.pilfer` is open to any member, and to outsiders who carry a key.
  - `stash.pilfer` targets another member's hut stash.
  - Each takes up to a capped share per action, and the action takes time.
- **Witnesses:** at the moment of the act, every other player present in the zone (not traveling) has a chance to see it, and so does the watchtower.
  - Each witness gets a private event, `witness.saw { actor, act, items }`.
  - Nothing is broadcast. A witness decides whether to tell, keep quiet, or lie.
- **Undetected theft:** the audit log shows a `missing` entry with the items and no actor. The storehouse lock raises the chance of a `traces` entry that names the culprit to members.
- The operator feed gets `theft` events with the true culprit.
- Tests: `test/theft.test.ts` covers no-witness theft leaving `missing` without an actor, a witness getting the private event, and non-witnesses learning nothing through any command or event.

## Stage 5: Downed, permanent death, murder mysteries

- **Downed** (replaces respawn in `killPlayer`, `world.ts:594`):
  - At 0 HP outside town the player becomes `downed` for `TIMING.downedMs` (~60 s; doubled near an infirmary).
  - While downed the player cannot act, chat or DM. Mobs drop their aggro.
  - Any player can `revive` them (a 5 s channel that damage interrupts), bringing them back at 30% HP.
  - In PvP zones, any player can `attack` a downed player to finish them.
  - **Field bandage:** a craftable item that allows one self-revive. It is a trade good and stops solo deaths from wiping out every bot.
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
- Stage 3 adds a numeric economy check (group versus solo) to `test/economy.test.ts` against the ≥1.5× target.
- After stages 5 and 7, run a sandboxed agent session (`sandbox/run-agent.sh`) and watch the dashboard for these signals:
  - Do settlements form?
  - Do thefts and murders happen, and are they caught?
  - How many bots die permanently?
  - Did the `COMBAT_LOCKED` count change (the deferred decision)?

## Suggested order and models

Stages 1 → 7 in order. Stage 1 is mostly mechanical: Sonnet. Stages 2-6 are rule-heavy, span several files and have subtle secrecy: Opus. Stage 7 docs and starters: Sonnet; the dashboard: Opus.
