# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- When a player opens the terminal, they always see a waiting screen until the GM approves the session and selects spectators; reopening the terminal repeats the authorization flow.
- Full CRT boot screen in the player terminal: Weyland-Yutani logo graphic, animated startup lines, scanline effects, and power-down transition; configurable boot text still types into the terminal log afterward.
- GM console help panel (`?` in the window header) listing player commands and GM console actions.
- CRT text rendering ported from alien-mu-th-ur: scramble decode typewriter, per-line scanline sweep, animated boot text, and client settings to toggle each effect.
- Fixed boot animation being skipped when ApplicationV2 re-rendered before the typewriter finished.
- Restored localized defaults in module settings UI for Boot Text, Terminal Prompt, and Custom STATUS Text.
- Fixed multiline boot, STATUS, and reply text rendering (line breaks in terminal and textarea settings).
- Module settings for Boot Text and Custom STATUS Text now use proper textarea controls with newline-preserving defaults.
- Settings UI hook converts Boot Text and Custom STATUS fields to textareas when Foundry renders single-line inputs.

## [1.1.6] - 2026-07-07

### Fixed

- Boot text and terminal prompt no longer display raw i18n keys (`MUTHUR.SettingBootTextDefault`, etc.); settings resolve at render time and legacy worlds auto-migrate.

### Changed

- README, release notes template, and manifest description aligned with current features (scripted responses, i18n, v14 compatibility).

## [1.1.5] - 2026-07-07

### Added

- French, German, Spanish, and Italian localizations (`lang/fr.json`, `de.json`, `es.json`, `it.json`).

### Changed

- Wired all player and GM console UI strings to i18n (window titles, labels, dialogs, notifications, log tags).
- Localized default boot text, prompt, and custom STATUS text for new worlds.

## [1.1.4] - 2026-07-07

### Changed

- Foundry verified compatibility set to v14 (was v14.364).

## [1.1.3] - 2026-07-07

### Changed

- Improved Foundry manifest metadata: HTML description, author contact links, and structured styles/language entries.

## [1.1.2] - 2026-07-07

### Fixed

- Manifest URL now points to `/releases/latest/download/module.json` so Foundry can detect and install updates.

## [1.1.1] - 2026-07-07

### Changed

- Module title updated to **Alien RPG - MU/TH/UR Terminal**.
- Declared `alienrpg` system relationship in `module.json` for Foundry's module browser.
- Removed empty Unreleased section from changelog.

## [1.1.0] - 2026-07-07

### Added

- Scripted auto-responses for `STATUS`, `TIME`, `DATE`, `CREW`, `MANIFEST`, `LOCATION`, `VERSION`, `INTERFACE`, and `ORDERS`.
- World settings: scripted responses toggle, STATUS preset, and custom STATUS text.
- Expanded `HELP` command listing all available commands.

### Changed

- GitHub project documentation (`AUTHORS`, `CHANGELOG`, `LICENCE`, `VERSION`, release templates).
- README expanded with manifest install, usage tables, and configuration guide.

## [1.0.0] - 2026-07-07

### Added

- Interactive player terminal with retro CRT styling (Foundry ApplicationV2, v13+).
- GM console for reading player queries and sending live MU/TH/UR replies.
- Scoped replies (single player or all terminals) and system alert broadcasts.
- Socket relay for player commands and force-open-all terminals.
- World-scoped transcript persisted via Foundry settings and synced to all clients.
- Scene control buttons for player terminal and GM console.
- `game.muthur` API: `open()`, `openGM()`, `forceOpenAll()`, `clearTranscript()`.
- Local player commands: `HELP`, `CLEAR`.
- Character-by-character typewriter effect for MU/TH/UR output.
- Retro terminal sound effects (keypress, return, reply loop, communication, error).
- Client settings: terminal sounds on/off and volume.
- World settings: boot text and terminal prompt.
- English localization (`lang/en.json`).
- GitHub release packaging and manifest install URLs.

[1.1.6]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.1.6
[1.1.5]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.1.5
[1.1.4]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.1.4
[1.1.3]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.1.3
[1.1.2]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.1.2
[1.1.1]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.1.1
[1.1.0]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.1.0
[1.0.0]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.0.0
