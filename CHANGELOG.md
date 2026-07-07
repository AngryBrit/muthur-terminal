# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

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

[Unreleased]: https://github.com/AngryBrit/muthur-terminal/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AngryBrit/muthur-terminal/releases/tag/v1.0.0
