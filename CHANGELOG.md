# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `mage-farming.js` (renamed from `kite_mage.js`) gear management:
  - Junk bin: banks every non-potion drop during town restock trips for manual selling (`BANK_JUNK`, capped by `BANK_MAX_ITEMS`).
  - Auto-compound duplicate gear (data-driven material check via `G.items[name].compound`; stackable materials now counted).
  - Auto-equip upgrades with the client's `find_equipment()`, never downgrading.
  - `BANK_NAMES` safe-stores valuables/event items via `bank_store` with a `smart_move` bank detour.
  - Potions (`hpot`/`mpot`/`cpot`/`vpot`) and `KEEP_NAMES` items are always exempt from compounding and banking.
  - All gear actions share the same `ACTION_INTERVAL` throttle as combat so the server action cap is never exceeded.

### Changed
- `mage-farming.js` renamed; README updated (feature list, config table, gear-management section, repository layout).
- Gear policy reworked: junk is banked for manual selling instead of auto-sold (no hard-coded junk-name list needed).
- `IGNORE_MTYPES` config: town chickens (`rooster`/`hen`) are never engaged or roam-targeted, so the character stops getting stuck in combat around town after a potion run.
- Survival: threat is now level-relative. Since monsters carry no level, danger is `attack/frequency` (DPS) ÷ the character's max HP: `PATH_RISK_PER_SEC` steers around species above 15%, `TARGET_RISK_FRAC` (30%) excludes them from pickable fights and lightly prefers lower-risk targets, and `ROAM_RISK_FRAC` (25%) stops roaming to deadly spawns. `PATH_MAX_ATT` stays as an absolute backstop. The same species stops being a hazard as you out-level it.
- Roaming prefers the current map: the bot now stays put whenever a farmable species spawns locally and only travels for a species scoring at least `ROAM_OTHER_RATIO` (2.5x) better — fewer map changes means less time walking through dangerous zones (replaces the old 1.3x same-map bonus).
- Town trip order fixed: gear tidy now runs *before* the potion purchase, so a junk-heavy inventory can't block the buy with `buy_cant_space`; failed trips back off for `SHOP_FAIL_COOLDOWN`, and `buy_cant_afford` now drops into `goo` farming. This kills the tight "searching for path / path found + shop trip failed" retry loop.
- Kite backpedal fans the escape angle up to a full circle when retreating into water/walls, and fights in place when fully boxed in.
- Attack pacing is adaptive: server-side "cool-down" rejections widen the gap, successes narrow it, and routine rejections are logged only every 5th time.
- All `distance()` calls use `parent.distance`; `performance_trick()` called once on load; `smart_move` always given an explicit `map`.
- Roaming: `ROAM_COOLDOWN` + `failedMaps` memory prevent "Unrecognized location" spam and retry loops; `returnPos` is anchored only on arrival.

## [0.1.0] - 2026-09-17

### Added

- `kite_mage.js`: Mage auto-farming script.
  - Dynamic target scoring weighted by XP-per-effort and distance.
  - Filters training dummies and monsters above `MAX_MONSTER_HP`.
  - Kiting with normalized retreat vector and attack-range safety cap.
  - Optional `burst` skill usage.
  - Automatic potion restocking in town via `buy_with_gold`.
  - Broke fallback that farms `goo` until potions are affordable.
  - Chat-log diagnostics via `game_log`.
- Project documentation: `README.md`, `LICENSE`, `.gitignore`.
