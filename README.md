# Alien RPG - MU/TH/UR Terminal

[![Foundry v13+](https://img.shields.io/badge/Foundry-v13%2B-ff6400)](https://foundryvtt.com/)
[![Version](https://img.shields.io/badge/version-1.1.4-blue)](VERSION)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENCE)
[![Release](https://img.shields.io/github/v/release/AngryBrit/muthur-terminal)](https://github.com/AngryBrit/muthur-terminal/releases)

A fully interactive **MU/TH/UR** terminal module for **Alien RPG Evolved** on [Foundry VTT](https://foundryvtt.com/). Built against the v13+ ApplicationV2 API (verified for v14.364).

Players get a retro green CRT terminal they can type into. The GM gets a companion console to read every query and puppet MU/TH/UR's replies live — whispered to one crew member or broadcast to the whole ship.

## Features

- **Player terminal** — retro CRT window with command history, boot text, and local `HELP` / `CLEAR`
- **GM console** — incoming queries tagged by player, targeted or broadcast replies, system alerts
- **Live sync** — transcript stored in a world setting and pushed to every connected client
- **Atmosphere** — character-by-character typewriter replies and retro terminal sound effects
- **Scene controls** — terminal icon for all users; satellite-dish GM console icon for the GM
- **API** — `game.muthur.open()`, `openGM()`, `forceOpenAll()`, `clearTranscript()`

## Installation

### Install via manifest (recommended)

1. In Foundry, open **Install Module**.
2. Paste the manifest URL for the latest release:

   ```
   https://github.com/AngryBrit/muthur-terminal/releases/latest/download/module.json
   ```

3. Click **Install**, then enable **MU/TH/UR Terminal** in your world's **Manage Modules** screen.

### Manual install

1. Download the latest `muthur-terminal-vX.Y.Z.zip` from [Releases](https://github.com/AngryBrit/muthur-terminal/releases).
2. Extract the `muthur-terminal` folder into your Foundry `Data/modules/` directory.
3. Enable the module in **Manage Modules**.

## Usage

### Scene controls

| Control | Who | Action |
|---------|-----|--------|
| Terminal icon | Everyone | Opens the player MU/TH/UR terminal |
| Satellite dish icon | GM only | Opens the GM console |

### Macros

```js
game.muthur.open()           // Player terminal
game.muthur.openGM()         // GM console (GM only)
game.muthur.forceOpenAll()   // Pop terminal on every connected client
game.muthur.clearTranscript() // Wipe the shared transcript (GM only)
```

### Player terminal

- Type a command and press **Enter** — it is relayed to the GM console.
- `HELP` and `CLEAR` are handled locally without bothering the GM.

### GM console

- Every incoming query appears in the log with the player's name.
- Choose a target (**ALL TERMINALS** or a specific player) and type MU/TH/UR's response.
- **Send System Alert** — unprompted broadcast (hull breach, warnings, etc.).
- **Force-Open All Terminals** — open the player terminal on every connected client.
- **Clear Transcript** — erase the shared log for everyone.

## Configuration

In **Module Settings → MU/TH/UR Terminal**:

| Setting | Scope | Description |
|---------|-------|-------------|
| Boot Text | World | Flavor text when a player's terminal boots each session |
| Terminal Prompt | World | Input prompt string (default `INTERFACE 2037>`) |
| Typing Speed | Client | ms per character for MU/TH/UR reply typewriter |
| Terminal Sounds | Client | Enable/disable retro sound effects |
| Terminal Sound Volume | Client | Volume for sound effects (0.0–1.0) |

## Development

```text
muthur-terminal/
├── module.json          # Foundry manifest (version should match VERSION)
├── VERSION              # Single source of truth for release version
├── scripts/muthur.js    # Module entry point
├── styles/muthur.css
├── templates/           # Handlebars ApplicationV2 templates
├── lang/en.json
└── sounds/              # Terminal SFX (OGG)
```

Symlink or copy the folder into `Data/modules/muthur-terminal` and reload Foundry.

## Documentation

| File | Purpose |
|------|---------|
| [AUTHORS](AUTHORS) | Maintainers and attributions |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [LICENCE](LICENCE) | MIT licence and disclaimers |
| [VERSION](VERSION) | Current semantic version |
| [.github/RELEASE_NOTES_TEMPLATE.md](.github/RELEASE_NOTES_TEMPLATE.md) | Template for GitHub releases |

## Design notes

This module treats MU/TH/UR as **GM-puppeted**, not a scripted parser — matching how MU/TH/UR is meant to be played in Alien RPG. The GM is the intelligence behind the curtain.

To add scripted auto-responses (e.g. `STATUS`, `CREW MANIFEST`), extend the `onSocketEvent` handler in `scripts/muthur.js` before queries fall through to the GM relay.

## Licence

Released under the [MIT Licence](LICENCE). Unofficial fan project — not affiliated with Free League Publishing or the Alien franchise.
