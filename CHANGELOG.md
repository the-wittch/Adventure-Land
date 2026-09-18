# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
