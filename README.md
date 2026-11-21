# Mistcoast – Claude Generals

An agent-only strategy wargame in the browser. You don't play: you watch. Every faction is led by a
**Claude agent general** with its own name, persona, memory and diary. Every 20 turns the generals
meet in a summit. In private back rooms and in the public world council they forge coalitions,
betray allies, insult each other and pick targets. Their orders then steer production and attacks
on the map until the next summit.

The game is inspired by the classic 80s island-conquest wargames: fog of war, neutral cities,
transports, fleets and air power. It is an independent implementation with its own rules, map
generator and diplomacy system.

## Features

### Claude generals
- **Personas:** each general picks a short name and motto at game start and gets an extreme,
  modern military personality: peacemaker, conqueror, hard-nosed negotiator, loudmouth, schemer,
  opportunist, man of honour or paranoid.
- **Memory, notes and diary:** at the end of every summit each general writes a diary entry with
  goals, a plan for the next summit and a review. The last three entries come back to them at the
  next summit. Nothing carries over between games.
- **Situation report with fog of war:** generals only see what their own units and cities can see.
- **Orders to the army:** armament focus (land / sea / air / balanced), stance (offensive /
  defensive), a target city and protected cities. The rule-based AI executes these orders turn by
  turn.
- **Unit transfers:** generals can hand units to each other, but only after negotiating in
  private. The units then appear in the receiver's capital.

### Summits
| When | What happens |
|---|---|
| Turn 0 | Line-up: every general chooses a name and description |
| Turn 1 | First meeting: getting to know each other, spying, no decisions |
| Every 20 turns | Back room (up to 3 private rounds), then world council (2 rounds, the last one decides) |

- **Rooms:** one private channel per pair of generals, plus any number of group rooms (one per
  member combination). A room containing *all* generals is not allowed; that is what the world
  council is for.
- **Diplomacy rules:**
  - Allies always fight the same wars.
  - Blocs have at most 3 members.
  - No stalemates in the endgame: when 3 factions survive, the two weaker ones ally.
- **Peace phase:** war can only be declared once at most 30 % of the initially neutral cities are
  still neutral.

### World and economy
- **Cities:** every start island has exactly three cities: a small town (start, harbour), a town
  (closer) and an industrial city (farther away).
- **Population:**
  - Every city has a real population, and production scales with it.
  - Building, supply and attacks cost people; cities grow on their own.
  - "Civil protection" rebuilds population.
- **Units:** infantry, tanks, fighters, bombers, transports, destroyers, submarines, battleships,
  carriers and missiles with unlimited range. The nuke is disabled.
- **Map size:** area factor ×0.5 / ×1 / ×2 / ×4 (base 144×84).

### Spectator UI
- Map with mouse-wheel zoom and tooltips for cities and units (HP, moves, fuel, cargo).
- **Chat panel:**
  - World council, pair matrix and group rooms, framed by summit phase, newest first.
  - Coordinates in messages are clickable and jump to that spot on the map.
- Hidden spectator channels: each general's **reasons** for its decisions, and short **summaries
  with highlights** after every conversation round.
- **Charts and panels:**
  - Ranking chart (score, cities, population, production, supply).
  - Troop chart and unit-transfer chart.
  - Decision log and general profiles with diaries.

## Requirements

| Software | Version | Needed for |
|---|---|---|
| [Python](https://www.python.org/downloads/) | 3.8 or newer | the local server (standard library only, no `pip install`) |
| [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) | recent release (tested with 2.1.330) | the generals; must be logged in and on your `PATH` |
| A modern browser | Chrome, Edge, Firefox or Safari | watching the game |
| [Node.js](https://nodejs.org/) *(optional)* | 18 or newer | `npm` scripts, tests and statistics; also the usual way to install Claude Code |

The game logic runs entirely in the browser. Claude is only called during summits.

## Installation

### 1. Install and log in to Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude          # first start: log in with your Claude account or an API key, then exit with /exit
```

Other installation methods (native installers for Windows, macOS and Linux) are described in the
[Claude Code documentation](https://docs.claude.com/en/docs/claude-code). Check the installation with:

```bash
claude --version
claude -p "Say hello"     # must print an answer without asking for a login
```

### 2. Get the game

```bash
git clone https://github.com/ecosquirrel-dev/e9l-mistcoast-claude-generals.git
cd e9l-mistcoast-claude-generals
```

There is nothing else to install: no `npm install`, no `pip install`, no build step.

## Running the game

### 1. Start the server

```bash
python server/serve.py      # or: npm start
```

On some systems Python is called `python3` (macOS, most Linux distributions) or `py` (Windows launcher).
The server prints:

```
Mistcoast is running at http://127.0.0.1:8765/  (Ctrl+C to stop)
Generals (Claude CLI): /path/to/claude
```

If the second line says `not found`, the server cannot see the `claude` command. See
[Troubleshooting](#troubleshooting).

### 2. Start a game

1. Open <http://127.0.0.1:8765/> in your browser.
2. In the control bar on the left, choose the number of generals (2–8, default 4) and the map size
   (×0.5 to ×4).
3. Press **New game**. Turn 0 (line-up) starts: every general picks a name, rank and motto.
4. Use the buttons to run the game:

| Button | Action |
|---|---|
| ▶ Play | run continuously (press again to pause) |
| ⏭ To summit | run until the next summit, then stop |
| +1 Turn | advance a single turn |

Summits take a few minutes, because every general and every summary is a separate Claude call.
Between summits the game runs at full speed without any Claude calls.

### 3. Stop

Press `Ctrl+C` in the terminal running the server. A game only lives in the browser tab: reloading
the page ends it.

### Cost

Each summit makes roughly *generals × (up to 5 rounds)* calls plus one summary per round, so a
4-general game uses about 25 Claude calls per summit, one summit every 20 turns. With a Claude
subscription this counts against your usage limits; with an API key it is billed per token. Set
`MISTCOAST_MODEL=haiku` for cheaper and faster summits.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Generals (Claude CLI): not found` | Make sure `claude --version` works in the **same** terminal you start the server from. On Windows, open a new terminal after installing so the updated `PATH` is picked up. |
| Generals don't answer / summits end with fallback messages | Run `claude -p "Say hello"`. If it asks for a login or fails, start `claude` once and log in. When a general gives no valid answer (e.g. a timeout after 150 s), the rule-based AI decides for it; the *Resolutions* card lists those errors and the browser console shows details. |
| `OSError: [Errno 98/10048] Address already in use` | Port 8765 is taken (probably by a server that is still running). Stop it or start with another port: `MISTCOAST_PORT=8800 python server/serve.py` (PowerShell: `$env:MISTCOAST_PORT=8800; python server/serve.py`). |
| Page loads but stays empty | Open the page through the server (`http://127.0.0.1:8765/`), not as a `file://` path; the generals need the `/api/general` endpoint. |
| Changes to the code don't show up | Reload the page and start a **new game**. A running game keeps the code it was started with. |

## How the Claude calls are sandboxed

`serve.py` exposes a single endpoint, `POST /api/general`. Every call starts:

```
claude -p --model sonnet --tools "" --strict-mcp-config --no-session-persistence \
       --setting-sources local --exclude-dynamic-system-prompt-sections --system-prompt …
```

- **No tools and no MCP servers:** a general can only return text. It cannot read, write or run
  anything.
- **Fresh temporary working directory** per call, deleted afterwards. No session is saved, so
  nothing survives a call.
- **Local only:** the server listens on `127.0.0.1` and rejects requests from other origins.
  Requests must be JSON and are size-limited.
- **Memory lives in the game:** a general's memory exists only in the game state in the browser. A
  new game starts empty.

The model defaults to `sonnet`; `haiku` is allowed as a faster, cheaper option (`MISTCOAST_MODEL`).

## Project layout

```
e9l-mistcoast-claude-generals/
├── public/                 # everything the browser loads
│   ├── index.html          # page layout
│   ├── css/styles.css      # styles
│   └── js/
│       ├── game.js         # game logic: map, units, AI, diplomacy, population, summits, prompts
│       │                   #   (DOM-free, also runs in Node)
│       └── ui.js           # canvas rendering, chat panel, charts, tooltips, controls
├── server/serve.py         # static file server + sandboxed Claude endpoint
├── test/smoke-test.js      # plays six headless games and fails on any error
├── tools/                  # balancing statistics over many simulated games
│   ├── ai-stats.js         #   decided games, game length, conquests
│   ├── dip-stats.js        #   war patterns and diplomacy events
│   └── role-stats.js       #   strength of the four player bonuses
└── package.json            # npm scripts (no dependencies)
```

## Development

There is no build step and there are no dependencies. Edit the files, then reload the page.

Because `game.js` has no DOM dependency, it runs headless in Node. Without Claude, the rule-based
diplomacy fallback plays the generals' part:

| Command | Does |
|---|---|
| `npm start` | starts the server (`python server/serve.py`) |
| `npm test` | smoke test: six full AI games |
| `npm run check` | syntax check of `game.js` and `ui.js` |
| `npm run stats:ai -- 8 3 300` | games, players, max turns |
| `npm run stats:diplomacy -- 8 4 400` | games, players, turns |
| `npm run stats:roles -- 24 250` | games, turns |

### Server settings

| Environment variable | Default | Meaning |
|---|---|---|
| `MISTCOAST_PORT` | `8765` | port on `127.0.0.1` |
| `MISTCOAST_MODEL` | `sonnet` | model for generals and summaries (`sonnet` or `haiku`) |

## License

[MIT](LICENSE)
