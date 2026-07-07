# MU/TH/UR Terminal

A fully interactive MU/TH/UR terminal module for **Alien RPG Evolved** on Foundry VTT (built against the v13+ ApplicationV2 API, verified for v14).

## What it does

- **Players** get a retro green CRT terminal window they can type into, in-character, from a scene control button (or `game.muthur.open()`).
- **The GM** gets a companion console (`game.muthur.openGM()`) that shows every query as it comes in and lets the GM type MU/TH/UR's reply live — targeted at one player's terminal or broadcast to the whole crew.
- Replies type themselves out character-by-character for atmosphere.
- The GM can force-open the terminal on every connected client (great for "MU/TH/UR is contacting you" moments), send unprompted system alerts, and clear the transcript.
- The transcript is stored in a world setting, so it persists across reloads and stays in sync across all clients automatically.

## Installation

1. Copy this whole `muthur-terminal` folder into your Foundry `Data/modules/` directory.
2. Restart Foundry (or refresh), then enable **MU/TH/UR Terminal** in your world's Manage Modules screen.
3. Load the world.

## Usage

- **Scene Controls:** a terminal icon appears in the Token controls group for every user; a second satellite-dish icon (GM console) appears only for the GM.
- **Macros:** you can also drop these into the hotbar:
  - Player terminal: `game.muthur.open()`
  - GM console (GM only): `game.muthur.openGM()`
  - Force-open every player's terminal: `game.muthur.forceOpenAll()`
  - Wipe the transcript: `game.muthur.clearTranscript()`
- **In the player terminal:** type anything and hit Enter — it's sent to the GM's console. `HELP` and `CLEAR` are handled locally (help text / clear the local screen) without bothering the GM.
- **In the GM console:** every incoming query appears in the log tagged with the player's name. Pick a target from the dropdown (a specific player, or "ALL TERMINALS") and type MU/TH/UR's response. Use "Send System Alert" for unprompted broadcasts (alarms, warnings, etc.) and "Force-Open All Terminals" to pop the terminal open on every connected client.

## Configuration

In **Module Settings**, under MU/TH/UR Terminal:
- **Boot Text** (world): the flavor text shown when a player's terminal first boots each session.
- **Terminal Prompt** (world): the prompt string shown before the input line (default `INTERFACE 2037>`).
- **Typing Speed** (per-client): how fast MU/TH/UR's replies type out on your own screen.

## Notes / extension ideas

- This module intentionally treats MU/TH/UR as GM-puppeted rather than a scripted parser, matching how MU/TH/UR is meant to be played in Alien RPG — a mysterious, unreliable AI whose "personality" is really the GM behind the curtain.
- If you want scripted auto-responses for specific commands (e.g. `STATUS`, `CREW MANIFEST`), that logic would slot neatly into the `onSocketEvent` handler in `scripts/muthur.js`, before it falls through to relaying the query to the GM.
