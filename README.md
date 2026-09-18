# Adventure Land Scripts

Automation scripts for [Adventure Land](https://adventure.land), the MMORPG where you write JavaScript to control your character.

## Scripts

| File | Character | Description |
|------|-----------|-------------|
| [`kite_mage.js`](kite_mage.js) | Mage | Auto-farms with dynamic target picking, kiting, and automatic potion restocking. |

## Features

`kite_mage.js`:

- **Dynamic target selection** - scores every visible monster by XP earned per point of effort (`xp / (attack + defense + hp/100)`) and weights closer monsters higher, so the character always fights the most efficient safe target.
- **Junk filter** - skips training dummies (`mtype == "dummy"`) and any monster whose `max_hp` is above `MAX_MONSTER_HP`, keeping the bot away from bosses and tanky mobs.
- **Kiting** - stays at range, backpedals with a normalized away-vector when a monster closes in, and never retreats past the character's own attack range.
- **Mage `burst`** - uses the burst skill when mana allows (silently skipped if the skill is not unlocked).
- **Automatic restocking** - when potions drop below the configured thresholds, walks to town, buys with `buy_with_gold()`, then returns to the saved farming spot.
- **Broke fallback** - if gold is too low to restock, it farms low-level `goo` monsters until it can afford potions again.
- **Chat-log diagnostics** - prints its current action and any script errors with `game_log()`.

## Installation

1. Open Adventure Land and open the code editor for your Mage.
2. Create a new code file named `kite_mage`.
3. Paste the contents of [`kite_mage.js`](kite_mage.js).
4. Make sure `attack_mode` is enabled (either the in-game toggle or the `attack_mode = true` variable at the top).
5. Run the code.

To use it as a module from another code file:

```js
load_code("kite_mage");
```

## Configuration

All tunables are declared at the top of `kite_mage.js`:

| Variable | Default | Description |
|----------|---------|-------------|
| `attack_mode` | `true` | Master on/off switch for fighting. |
| `MAX_MONSTER_HP` | `5000` | Ignore monsters with more than this much max HP (boss/mini-boss filter). |
| `ENGAGE_RANGE` | `700` | Only consider monsters within this distance. |
| `BUY_AT_HPOT` | `5` | Head to town when HP potions drop to this many. |
| `BUY_AT_MPOT` | `5` | Head to town when MP potions drop to this many. |
| `BUY_TO` | `50` | Restock up to this many of each potion. |
| `GOO_GOLD_GOAL` | `100` | Once this much gold is earned in broke-mode, try shopping again. |

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
3. **Approach** - if out of range, use `smart_move` for long distances (pathfinds around walls) or a short direct `move` when close.

### Restocking

Potion counts are read with `quantity("hpot0")` / `quantity("mpot0")` (including higher tiers). In town, `buy_with_gold()` is used so the character never tries to spend gold it does not have. If it still cannot reach the minimum potion thresholds after buying, `lowGold` mode is enabled and the character farms `goo` until `GOO_GOLD_GOAL` is reached.

## Troubleshooting

The script writes to the in-game log (`game_log`). Useful lines:

| Log line | Meaning |
|----------|---------|
| `SCRIPT ERROR: ...` | An API call failed. The message names the missing function or property. |
| `Target <mtype> hp=... d=...` | Target was chosen; watch the following lines. |
| `Attacking <mtype> d=...` | The character is attacking. |
| `Kiting <mtype> d=...` | Backpedaling out of melee range. |
| `Approaching <mtype> d=...` | Closing the gap. |
| `No targets. ...` | No valid monster found; the line lists nearby monster stats (`mhp`, `d`, `xp`, `atk`). |
| `attack_mode is OFF` | The in-game attack toggle is disabled. |

If nothing is fought, lower `MAX_MONSTER_HP`/`ENGAGE_RANGE` mismatches are the usual cause - the `No targets.` line prints the filtered monsters' stats so you can adjust them.

## Disclaimer

This project is unofficial and not affiliated with Adventure Land. Automation is part of the game, but use these scripts at your own risk and in line with the game's rules.

## License

[MIT](LICENSE)
