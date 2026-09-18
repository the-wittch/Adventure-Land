# Adventure Land Scripts

Automation scripts for [Adventure Land](https://adventure.land), the MMORPG where you write JavaScript to control your character.

## Scripts

| File | Character | Description |
|------|-----------|-------------|
| [`Mage Farming`](https://github.com/the-wittch/Adventure-Land/blob/main/mage-farming.js) | Mage | Auto-farms with dynamic target picking, kiting, and automatic potion restocking. |

## Features

`mage-farming.js`:

- **Dynamic target selection** - scores every visible monster by XP earned per point of effort (`xp / (attack + defense + hp/100)`) and weights closer monsters higher, so the character always fights the most efficient safe target.
- **Junk filter** - skips training dummies (`mtype == "dummy"`) and any monster whose `max_hp` is above `MAX_MONSTER_HP`, keeping the bot away from bosses and tanky mobs.
- **Kiting** - stays at range, backpedals with a normalized away-vector when a monster closes in, and never retreats past the character's own attack range.
- **Defends while traveling** - walking is now danger-aware: the mage steers a path that keeps clear of high-level monsters (attack above `PATH_MAX_ATT` with aggro/charge) and their spawn zones, instead of fighting through them or passively walking into aggro packs. It only fights back mid-travel in an emergency (HP below half with a monster in reach).
- **Mage `burst`** - uses the burst skill when mana allows (silently skipped if the skill is not unlocked).
- **Automatic restocking** - when potions drop below the configured thresholds, walks to town, buys with `buy_with_gold()`, then returns to the saved farming spot.
- **Cross-map roaming** - when nothing good is in range for `ROAM_DELAY` seconds, scores every monster species in `G.monsters`, finds a normal-map spawn in `G.maps`, and `smart_move`s there (even across maps), updating the farming anchor.
- **Broke fallback** - if gold is too low to restock, it farms low-level `goo` monsters until it can afford potions again.
- **Gear management** - during each town restock trip it compounds duplicate gear, auto-equips upgrades, and banks junk/valuables for manual selling (configurable, potions always exempt).
- **Chat-log diagnostics** - prints its current action and any script errors with `game_log()`.

## Installation

1. Open Adventure Land and open the code editor for your Mage.
2. Create a new code file named `mage-farming`.
3. Paste the contents of [`mage-farming.js`](mage-farming.js).
4. Make sure `attack_mode` is enabled (either the in-game toggle or the `attack_mode = true` variable at the top).
5. Run the code.

To use it as a module from another code file:

```js
load_code("mage-farming");
```

## Configuration

All tunables are declared at the top of `mage-farming.js`:

| Variable | Default | Description |
|----------|---------|-------------|
| `attack_mode` | `true` | Master on/off switch for fighting. |
| `MAX_MONSTER_HP` | `5000` | Ignore monsters with more than this much max HP (boss/mini-boss filter). |
| `ENGAGE_RANGE` | `700` | Only consider monsters within this distance. |
| `IGNORE_MTYPES` | `["rooster", "hen"]` | Never fight or roam to these `mtype`s (blocks the town chickens from locking you in combat after a potion run). |
| `PATH_MAX_ATT` | `150` | Absolute backstop: monsters attacking above this (with aggro/charge) are always path hazards, whatever your level. |
| `PATH_RISK_PER_SEC` | `0.15` | Path hazard if a monster's DPS (`attack/frequency`) exceeds 15% of your max HP per second. Scales with level automatically. |
| `TARGET_RISK_FRAC` | `0.30` | Never pick a fight whose DPS exceeds 30% of your max HP per second; also makes scoring prefer targets you can out-sustain. |
| `ROAM_RISK_FRAC` | `0.25` | Don't roam toward species above this DPS-to-maxHP ratio (deadly for your current level). |
| `DANGER_PAD` | `60` | Extra clearance in px kept around dangerous monsters and their spawn zones while moving. |
| `STEER_STEP` | `44` | Hop size in px for the danger-aware walker. |
| `BUY_AT_HPOT` | `5` | Head to town when HP potions drop to this many. |
| `BUY_AT_MPOT` | `5` | Head to town when MP potions drop to this many. |
| `BUY_TO` | `50` | Restock up to this many of each potion. |
| `GOO_GOLD_GOAL` | `100` | Once this much gold is earned in broke-mode, try shopping again. |
| `ROAM_MAX_ATT` | `150` | When roaming, ignore monster species whose attack is above this (survivability). |
 | `ROAM_OTHER_RATIO` | `2.5` | Minimum efficiency multiplier before the bot leaves the current map for a foreign species (prevents map-ping-pong and reduces travel exposure). |
 | `ROAM_DELAY` | `8` | Seconds with no valid target before relocating to a new spawn/map. |
 | `ROAM_COOLDOWN` | `30` | Seconds between roam attempts after a failure (prevents log spam / retry loops). |
 | `ACTION_INTERVAL` | `110` | Min ms between dispatched game actions (attack/move/skill). Keeps total under the server's ~10 actions/s kick limit. |
 | `SHOP_FAIL_COOLDOWN` | `60000` | Min ms before a failed town trip is retried (prevents tight retry loops). |
 | `GEAR_ENABLED` | `true` | Master switch for gear management (compound/equip/bank). |
 | `KEEP_NAMES` | `[]` | Exact item names that must never be compounded or banked (kept carried). |
 | `BANK_NAMES` | `[]` | Exact item names to safe-store in the bank (protect valuables/event items). |
 | `BANK_JUNK` | `true` | Bank every other non-potion drop too, so you can sell it off by hand later. |
 | `BANK_MAX_ITEMS` | `900` | Stop banking once the bank holds this many slots (keeps junk-bin from overflowing). |
 | `COMPOUND_TARGETS` | `[]` | Exact item names whose duplicates may be compounded (e.g. `["glitchblade"]`). |
 | `COMPOUND_MAX_TIER` | `3` | Max `upgrade_level` the bot will auto-compound toward. |
 | `COMPOUND_FAIL_SKIP_MS` | `3600000` | Milliseconds to ignore an item after a rejected compound request. |
 | `ACTION_SKIP_MS` | `600000` | Milliseconds to remember a failed equip/bank request for the same item. |

## How It Works

### Target selection

Monsters live in `parent.entities` with `type == "monster"`; the species is in `mtype` (for example `"goo"`, `"squig"`). Each candidate within `ENGAGE_RANGE` is scored:

```js
score = xp / (attack + defense + hp / 100) / (1 + distance / 300)
```

Every stat is guarded with `Number(value) || 0`, and if no monster produces a positive score the script falls back to the closest valid monster. The current target is dropped automatically if it dies, becomes junk, or wanders beyond `ENGAGE_RANGE`.

### Engagement

`engage()` has three states:

1. **Kite** - if the monster is closer than `min(target.range + 25, character.range * 0.5)`, step away along a normalized vector (with a random direction if the two are stacked exactly on top of each other).
2. **Attack** - if in range and off cooldown, attack and optionally cast `burst`.
3. **Approach** - if out of range, steer toward it hop-by-hop, bending the route around dangerous monsters and their spawn zones (falls back to `smart_move` when the safe route is blocked).

### Danger-aware movement

Monsters don't carry a level, so "too dangerous for me" is computed from their stats against your character's current HP: a monster's threat is `attack / frequency` (avg DPS) divided by `max_hp` — the fraction of your HP it chews per second it lands hits. Because the fraction is recomputed live, the same monster can be a route hazard for a fresh mage yet harmless for a geared one.

That ratio drives three knobs:

- **Pathing** (`PATH_RISK_PER_SEC`) - while steering, the walker keeps `range`/`charge` + `DANGER_PAD` clear of any visible monster or spawn zone whose species exceeds the ratio (plus the `PATH_MAX_ATT` absolute backstop for high-attack species).
- **Targets** (`TARGET_RISK_FRAC`) - never pick a fight above the ratio, and scoring mildly prefers targets with lower risk.
- **Roaming** (`ROAM_RISK_FRAC`) - never roam *to* a spawn whose species is deadly at your current level (a species like the Vampire Rat, `prat`, qualifies early and stops qualifying as you level).

If no safe hop exists it accepts the line of least resistance and eventually hands the remaining leg to `smart_move`. The character only fights on the move as an emergency when HP drops below half with a monster in reach.

### Restocking

Potion counts are read with `quantity("hpot0")` / `quantity("mpot0")` (including higher tiers). When restocking is needed, the script uses `smart_move({to:"potions"})`, which resolves to the correct potion vendor for the current map (including `halloween` and `winterland`), then buys with `buy_with_gold()` so it never tries to spend gold it does not have. The gear tidy runs *before* the purchase so a junk-heavy inventory can never block the buy with `buy_cant_space`. If a trip fails, retries are held for `SHOP_FAIL_COOLDOWN`, and a `buy_cant_afford` failure flips the character into `goo` farming until gold is rebuilt. If it still cannot reach the minimum potion thresholds after buying, `lowGold` mode is enabled and the character farms `goo` until `GOO_GOLD_GOAL` is reached, then returns to shopping.

### Roaming

If no valid monster is within `ENGAGE_RANGE` for `ROAM_DELAY` seconds, `roam()` runs:

1. Build the set of species that actually spawn on normal maps (`G.maps`, skipping `ignore`/`instance`/`pvp` maps).
2. Score each by `xp / (attack + hp/100)`, skipping `dummy` and anything above `MAX_MONSTER_HP`, `ROAM_MAX_ATT`, or deadly for your level (`ROAM_RISK_FRAC`).
3. Prefer species that spawn on the *current* map: the character only leaves for a foreign species when it scores at least `ROAM_OTHER_RATIO` (2.5x) better, so it doesn't ping-pong between maps. Then find the best spawn (`find_spawn`, preferring current map and higher `count`) and travel there; the destination becomes the new `returnPos` anchor for future potion trips.

While low on gold, roaming targets `goo` specifically so the character can rebuild funds.

### Gear management

During each town restock trip, after walking to town, the script runs a tidy pass *before* buying potions (each action throttled by `ACTION_INTERVAL`). Tidying first clears inventory slots so the potion purchase never lands on a full bag:

1. **Compound** - for names in `COMPOUND_TARGETS`, finds duplicate copies at the same `upgrade_level` (below `COMPOUND_MAX_TIER`) and compounds them. Required materials are read from `G.items[name].compound` so no hard-coded names are used; a rejected request just logs and backs off.
2. **Equip** - if `GEAR_ENABLED`, uses the client's `find_equipment()` to detect upgrades and equips them from inventory. It never equips when the better copy is in the bank, and never downgrades.
3. **Bank** - walks to the bank and stores two kinds of items: anything named in `BANK_NAMES` (protected valuables), and, when `BANK_JUNK` is on, every other drop (the "junk bin") so you can sell it off by hand without losing loot to d/cs or a full bag.

Potions (`hpot*`/`mpot*`/`cpot*`/`vpot*`) and anything in `KEEP_NAMES` are **never** compounded or banked. Stackable materials count toward compounding because `has_item()` treats stacks as present. The junk-bin stops at `BANK_MAX_ITEMS` bank slots, and if the walk to the bank fails, banking is skipped for that trip.

The engine loop (attack/move/skill) and the tidy pass share the same action throttle, so gear handling can never trip the server's request cap.

## Troubleshooting

The script writes to the in-game log (`game_log`). Useful lines:

| Log line | Meaning |
|----------|---------|
| `SCRIPT ERROR: ...` | An API call failed. The message names the missing function or property. |
| `Target <mtype> hp=... d=...` | Target was chosen; watch the following lines. |
| `Attacking <mtype> d=...` | The character is attacking. |
| `Kiting <mtype> d=...` | Backpedaling out of melee range. |
| `Approaching <mtype> d=...` | Closing the gap. |
| `Pots low, going to town` | Restock trip started via `smart_move({to:"potions"})`. |
| `Restocked: hpot=... mpot=... gold=...` | Purchase finished; shows counts and remaining gold. |
| `Broke! Farming goo for gold` | Could not afford the minimum potions; switched to `goo` farming. |
| `Shop trip failed: ...` | `smart_move`/purchase rejected; the reason is printed. |
| `No targets. ...` | No valid monster found; the line lists nearby monster stats (`mhp`, `d`, `xp`, `atk`). |
| `attack_mode is OFF` | The in-game attack toggle is disabled. |

If nothing is fought, lower `MAX_MONSTER_HP`/`ENGAGE_RANGE` mismatches are the usual cause - the `No targets.` line prints the filtered monsters' stats so you can adjust them.

## Disclaimer

This project is unofficial and not affiliated with Adventure Land. Automation is part of the game, but use these scripts at your own risk and in line with the game's rules.

## License

[MIT](LICENSE)
