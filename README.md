# Adventure Land Scripts

Automation scripts for [Adventure Land](https://adventure.land), the MMORPG where you write JavaScript to control your character.

Shared farming / town logic lives in [`common.js`](common.js). Each character runs a thin class script that `load_code("common")`s and calls `begin_farming(...)`.

## Scripts

| File | Character | Role |
|------|-----------|------|
| [`common.js`](common.js) | (library) | Shared throttle, targeting, kite/melee engage, roam, restock, gear tidy, respawn |
| [`mage-farming.js`](mage-farming.js) | Mage | Kite farmer + `burst` |
| [`warrior-farming.js`](warrior-farming.js) | Warrior | Melee farmer + taunt/charge/cleave |
| [`ranger-farming.js`](ranger-farming.js) | Ranger | Kite farmer + supershot / 3shot / huntersmark |
| [`rogue-farming.js`](rogue-farming.js) | Rogue | Melee farmer + invis / punches |
| [`priest-farming.js`](priest-farming.js) | Priest | Kite farmer + curse / heal / partyheal |
| [`paladin-farming.js`](paladin-farming.js) | Paladin | Melee farmer + smash / self-heal |
| [`merchant.js`](merchant.js) | Merchant | Town idle, potion restock, compound/equip/bank (no combat) |

## Installation

1. In Adventure Land, create a code file named **`common`** and paste [`common.js`](common.js).
2. Create a second code file for your character (e.g. **`mage-farming`**) and paste the matching class file.
3. Run the **class** file (not `common` alone). It loads the library and starts the loop.
4. Leave `attack_mode` on for farmers (merchants force it off).

Example character code:

```js
load_code("common");
// ...class skills...
begin_farming({ role: "farmer", style: "kite", skills: mage_skills });
```

Or just paste the ready-made class file as-is.

## How class scripts plug in

`begin_farming(opts)` accepts:

| Option | Values | Purpose |
|--------|--------|---------|
| `role` | `"farmer"` / `"merchant"` | Combat loop vs town hangout |
| `style` | `"kite"` / `"melee"` | Default engage (ignored if `engage` is set) |
| `skills` | `function(target)` | Class skills after a basic attack |
| `engage` | `function(target)` | Full engage override (optional) |
| `tick` | `function()` | Full tick override (merchant) |

Shared helpers class scripts can call: `try_skill(name, target, mpReserveFrac)`, `attack_target`, `engage_kite`, `engage_melee`, `maybe_restock`, `go_shopping`, `leave_bank`.

Skill calls are best-effort: missing / locked skills fail quietly so early characters still farm.

## Features (common)

- **Dynamic target selection** - scores farms by XP/sec vs your DPS and survivability (from `G.monsters`), soft-penalizes trivial goo-tier packs, and biases toward `get_progression()` when available
- **Junk / risk filters** - skips dummies, bosses (`MAX_MONSTER_HP`), chickens; fight risk uses HP-relative DPS (pathing keeps its own higher attack backstop)
- **Kite or melee engage** - selected per class
- **Danger-aware pathing** - steers around high-DPS aggro packs while traveling
- **Roaming** - relocates to better farmable spawns; prefers current map
- **Potion restock + gear tidy** - compound (3 items + cscroll), auto-equip, bank junk; if the vault is full, leave the bank and sell junk at a town vendor so potion buys still fit
- **Broke fallback** - farmers grind `goo` for gold; merchants wait in town
- **Action throttle** (`ACTION_INTERVAL` 125ms) + attack cooldown backoff
- **Auto-respawn** - one delayed `respawn()` after death

## Configuration

All tunables are at the top of [`common.js`](common.js). Class files do not duplicate them — edit `common` (or override globals in the class file *after* `load_code("common")` and *before* `begin_farming`).

| Variable | Default | Description |
|----------|---------|-------------|
| `attack_mode` | `true` | Master on/off for fighting (merchants force `false`). |
| `MAX_MONSTER_HP` | `5000` | Ignore monsters above this max HP. |
| `ENGAGE_RANGE` | `700` | Only consider monsters within this distance. |
| `IGNORE_MTYPES` | `["rooster", "hen"]` | Never fight / roam to these. |
| `PATH_MAX_ATT` | `150` | Absolute path-hazard attack backstop. |
| `PATH_RISK_PER_SEC` | `0.15` | Path hazard if DPS > 15% of max HP/s. |
| `TARGET_RISK_FRAC` | `0.30` | Never pick fights above this DPS ratio. |
| `ROAM_RISK_FRAC` | `0.25` | Don't roam to species above this ratio. |
| `DANGER_PAD` | `60` | Extra clearance around hazards (px). |
| `STEER_STEP` | `44` | Danger-aware hop size (px). |
| `BUY_AT_HPOT` | `20` | Town when HP pots ≤ this. |
| `BUY_AT_MPOT` | `20` | Town when MP pots ≤ this. |
| `BUY_TO` | `300` | Restock each potion type up to this. |
| `GOO_GOLD_GOAL` | `0` | Gold to leave broke-mode (`0` = auto: cost of a full pot restock). |
| `ROAM_MAX_ATT` | `400` | Hard attack cap when scoring roam targets (risk_frac is the main gate). |
| `ROAM_OTHER_RATIO` | `1.6` | Leave current map if foreign species scores this much better (goo exits sooner). |
| `USE_PROGRESSION` | `true` | Bias farms toward `get_progression()` when the guide is available. |
| `TRIVIAL_HP_FRAC` | `0.5` | Soft-penalize mobs with max HP below `attack * this` (anti-goo parking). |
| `ROAM_MAX_RESPAWN` | `600` | Ignore species with slower respawns (seconds). |
| `ROAM_DELAY` | `8` | Seconds with no target before roaming. |
| `ROAM_COOLDOWN` | `30` | Seconds between roam attempts. |
| `ACTION_INTERVAL` | `125` | Min ms between game actions (~8/s). |
| `SHOP_FAIL_COOLDOWN` | `60000` | Backoff after failed town / bag-full trips. |
| `GEAR_ENABLED` | `true` | Auto-equip during tidy. |
| `KEEP_NAMES` | `[]` | Never compound/bank these names. |
| `BANK_NAMES` | `[]` | Always bank these names. |
| `BANK_JUNK` | `true` | Bank other non-potion drops. |
| `BANK_MAX_ITEMS` | `900` | Soft cap on occupied bank slots (real "full" is also zero free pack slots). |
| `BANK_FULL_SELL` | `true` | When the vault is full, leave the bank and sell junk at a town vendor. |
| `COMPOUND_TARGETS` | `[]` | Names allowed to auto-compound. |
| `COMPOUND_MAX_TIER` | `3` | Max `item.level` to compound toward. |
| `COMPOUND_BUY_SCROLLS` | `true` | Buy `cscroll*` at the scrolls NPC when needed. |
| `COMPOUND_FAIL_SKIP_MS` | `3600000` | Backoff after compound/scroll failures. |
| `ACTION_SKIP_MS` | `600000` | Backoff after equip/bank failures. |

Override example in a class file:

```js
load_code("common");
BUY_TO = 100;
COMPOUND_TARGETS = ["hpamulet", "hpbelt"];
begin_farming({ role: "farmer", style: "kite", skills: mage_skills });
```

## Class notes

- **Mage / Ranger / Priest** — ranged kite style; keep distance and burn class skills in range.
- **Warrior / Rogue / Paladin** — melee stick style; close to range and stay on target.
- **Priest** — also heals self/party when HP is low; still farms solo when alone.
- **Merchant** — no combat. Parks in town, restocks, runs the same gear tidy/bank path. Party loot transfer / stands can be layered on later.

Skills that are not unlocked yet are skipped automatically (`try_skill`).

## Troubleshooting

| Log line | Meaning |
|----------|---------|
| `Started farmer (mage, kite)` | Class script booted correctly through `begin_farming`. |
| `SCRIPT ERROR: ...` | Exception in the loop; message names the failure. |
| `Pots low, going to town` / `Bag full, going to town` | Restock / tidy trip. |
| `Broke! Farming goo for gold` | Farmer cannot afford pots. |
| `Broke! Merchant waiting for gold` | Merchant cannot afford pots (stays in town). |
| `Dead, respawning...` | Queued a single delayed `respawn()`. |
| `attack_mode is OFF` | Combat disabled for a farmer. |
| `No targets nearby` | Will roam after `ROAM_DELAY`. |

If `load_code("common")` fails, the in-game code file must be named exactly `common` (no `.js`).

## Disclaimer

This project is unofficial and not affiliated with Adventure Land. Automation is part of the game, but use these scripts at your own risk and in line with the game's rules.

## License

[MIT](LICENSE)
