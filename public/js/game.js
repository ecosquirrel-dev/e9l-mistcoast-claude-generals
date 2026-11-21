'use strict';
/* Mistcoast – game logic (no DOM). Runs in the browser and in Node. */

const UNIT_TYPES = {
  inf:   { name: 'Infantry',       glyph: 'I', domain: 'land', moves: 1, hp: 1, att: 1, def: 1, cost: 4,  vision: 2 },
  tank:  { name: 'Tank',           glyph: 'P', domain: 'land', moves: 2, hp: 2, att: 2, def: 1, cost: 8,  vision: 2 },
  jet:   { name: 'Fighter',        glyph: 'J', domain: 'air',  moves: 6, hp: 1, att: 2, def: 1, cost: 8,  vision: 3, fuel: 18 },
  trans: { name: 'Transport',      glyph: 'T', domain: 'sea',  moves: 2, hp: 2, att: 0, def: 1, cost: 9,  vision: 2, capacity: 4 },
  dest:  { name: 'Destroyer',      glyph: 'Z', domain: 'sea',  moves: 3, hp: 3, att: 2, def: 2, cost: 10, vision: 2 },
  bship: { name: 'Battleship',     glyph: 'S', domain: 'sea',  moves: 2, hp: 6, att: 3, def: 3, cost: 18, vision: 2 },
  // Submarine: visible only to enemy destroyers and attackable only by them (except in port)
  sub:     { name: 'Submarine',      glyph: 'U', domain: 'sea', moves: 2, hp: 2, att: 3, def: 1, cost: 10, vision: 2 },
  // Carrier: floating airfield for up to 4 fighters/bombers, which refuel on board
  carrier: { name: 'Carrier',        glyph: 'F', domain: 'sea', moves: 2, hp: 4, att: 1, def: 2, cost: 16, vision: 2, capacity: 4 },
  // Bomber: strong attack, can bomb other players' cities (destroys production), weak against fighters
  bomber:  { name: 'Bomber',         glyph: 'B', domain: 'air', moves: 5, hp: 2, att: 4, def: 1, cost: 12, vision: 2, fuel: 25 },
  // Missile: sits in the city where it was built and is fired once at another player's city
  missile: { name: 'Missile',        glyph: 'R', domain: 'air', moves: 0, hp: 1, att: 0, def: 1, cost: 5,  vision: 1, range: Infinity },   // unlimited range
  // Nuke: fired once from the city like the missile, wipes out the target city along with all units in it
  nuke:    { name: 'Nuke',           glyph: 'A', domain: 'air', moves: 0, hp: 1, att: 0, def: 1, cost: 40, vision: 1, range: Infinity, nuke: true },
};

// Supply: PP per turn that every unit consumes continuously. Ground troops are cheap,
// the air force sits in the middle, ships are the most expensive. This is where to tune the "sweet spot".
const UPKEEP = { inf: 0.08, tank: 0.15, jet: 0.25, trans: 0.30, dest: 0.40, bship: 0.80, sub: 0.35, carrier: 0.70, bomber: 0.35, missile: 0.05, nuke: 0.5 };
// Repair: share of ONE turn's city capacity that the repair costs
const REPAIR_SHARE = { inf: 0.15, tank: 0.25, jet: 0.2, trans: 0.25, dest: 0.35, bship: 0.5, sub: 0.3, carrier: 0.45, bomber: 0.3, missile: 0, nuke: 0 };
// City types: base capacity in PP per turn and frequency during map generation
const CITY_KINDS = [
  // def: defence factor for defenders in the city; militia: defence factor of the militia while the city is neutral
  // pop: range of the initial population; min: from this population on the city counts as this type
  { name: 'Industrial City', short: 'Ind.', cap: 1.5, pop: [1300000, 1800000], min: 1300000, weight: 0.2,  def: 1.6, militia: 1.3 },
  { name: 'City',            short: 'City', cap: 1.0, pop: [800000, 1250000],  min: 800000,  weight: 0.45, def: 1.3, militia: 1.15 },
  { name: 'Town',            short: 'Town', cap: 0.6, pop: [400000, 750000],   min: 0,       weight: 0.35, def: 1.1, militia: 1.0 },
];
// Population determines production: 1 PP per turn for every POP_PER_PE inhabitants
const POP_PER_PE = 1000000;
const NAT_GROWTH = 0.004;       // natural growth: up to 0.4 % per turn, slowed the closer the city gets to its cap
const DRAIN_BUILD = 1500;       // inhabitants consumed by every PP spent on building or repair (recruits, workers)
const DRAIN_UPKEEP = 3500;      // inhabitants per PP of supply: a large army drains the cities
const PROTECT_DAMAGE = 0.5;     // cities under Civil Protection suffer only half the losses
const GROWTH_RATE = 0.05;       // Civil Protection: +5 % population per full turn
const GROW = 'grow';            // "Civil Protection" order instead of a unit (shelters, housing, supplies for civilians)
const MIN_CAP = 0.2;            // no city drops below this value (equals 200,000 inhabitants)
const rand = (a, b) => a + Math.random() * (b - a);
const fmt = (n, d = 2) => n.toFixed(d);
/** Readable population: from one million on in M, below that in k. */
const fmtPop = n => (n >= 1e6 - 500 ? `${fmt(n / 1e6, 2)} M` : `${Math.round(n / 1000)} k`);

// Player 0 is the human, all others are controlled by the AI
const PLAYER_NAMES = ['Yellow (you)', 'Red', 'Blue', 'Violet', 'Green', 'Orange', 'Turquoise', 'Pink'];

// Player bonuses. domain: preferred branch (cost, supply, attack); the commissar improves the cities instead.
const CAP_MAX = 4;              // cap on a city's capacity in PP per turn
// All bonus knobs live in this table:
//   discount = factor on build cost and supply of the branch, attack = attack factor, speed = extra moves per turn
//   growth = factor on the growth rate, capMax = cap on city capacity, damage = factor on damage to own cities
const pct = f => Math.round(Math.abs(f - 1) * 100);
const ROLES = {
  army: { name: 'Army General',         short: 'Army',  domain: 'land', discount: 0.8,  attack: 1.15 },
  navy: { name: 'Fleet Admiral',        short: 'Fleet', domain: 'sea',  discount: 0.8,  attack: 1.2, speed: 1 },
  air:  { name: 'Wing Commander',       short: 'Air',   domain: 'air',  discount: 0.6,  attack: 1.5, speed: 2 },
  prod: { name: 'Production Commissar', short: 'Prod.', domain: null,   growth: 1.45, capMax: 4.5, damage: 0.6 },
};
const DOMAIN_NAME = { land: 'Land units', sea: 'Ships', air: 'Aircraft' };
for (const r of Object.values(ROLES)) {   // generate the description from the values so it never drifts from them
  r.note = r.domain
    ? `${DOMAIN_NAME[r.domain]}: build cost and supply −${pct(r.discount)} %, attack +${pct(r.attack)} %` + (r.speed ? `, +${r.speed} move per turn` : '')
    : `Cities: population grows ${pct(r.growth)} % faster, cap ${fmtPop(r.capMax * POP_PER_PE)} instead of ${fmtPop(CAP_MAX * POP_PER_PE)} inhabitants, losses from attacks −${pct(r.damage)} %`;
}
const roleKey = (s, p) => (p >= 0 && s.roles ? s.roles[p] : null);
/** Does the unit type belong to the player's preferred branch? */
const favored = (s, p, type) => { const k = roleKey(s, p); return !!k && ROLES[k].domain === UNIT_TYPES[type].domain; };
const unitCost = (s, p, type) => UNIT_TYPES[type].cost * (favored(s, p, type) ? ROLES[roleKey(s, p)].discount : 1);
const unitUpkeep = (s, p, type) => UPKEEP[type] * (favored(s, p, type) ? ROLES[roleKey(s, p)].discount : 1);
const attackBonus = (s, p, type) => (favored(s, p, type) ? ROLES[roleKey(s, p)].attack : 1);
/** Moves per turn of a unit, including its player's speed bonus. */
const movesOf = (s, u) => !UNIT_TYPES[u.type].moves ? 0 : UNIT_TYPES[u.type].moves + (favored(s, u.owner, u.type) ? ROLES[roleKey(s, u.owner)].speed || 0 : 0);
// Start island: exactly three cities, one of each type. The player starts in the town (port),
// the nearest city is a City, the farthest the Industrial City.
const START_TEMPLATE = [2, 1, 0];
const START_MIN_SIZE = 120;     // start islands grow to at least this area (in tiles) ...
const START_MAX_SIZE = 160;     // ... and are equalised to at most this size

// Terrain types for land tiles. tank: move cost for tanks (Infinity = impassable), infantry always pays 1.
// cover: factor on a land defender's defence, sight: extra vision range for land units.
const GROUND = [
  { name: 'Plains',    tank: 1,        cover: 1,    sight: 0, note: 'nothing special' },
  { name: 'Forest',    tank: 2,        cover: 1.25, sight: 0, note: 'cover +25 %, tanks need 2 moves' },
  { name: 'Hills',     tank: 2,        cover: 1.5,  sight: 1, note: 'cover +50 %, vision +1, tanks need 2 moves' },
  { name: 'Mountains', tank: Infinity, cover: 2,    sight: 1, note: 'cover +100 %, vision +1, impassable for tanks' },
  { name: 'Crater',    tank: 2,        cover: 1,    sight: 0, note: 'remains of an annihilated city, tanks need 2 moves' },
];
const groundAt = (s, x, y) => GROUND[s.ground[y * s.W + x]];
const moveCost = (s, type, x, y) => (type === 'tank' ? groundAt(s, x, y).tank : 1);
/** Vision range of a unit; land units see farther from hills and mountains. */
function visionOf(s, u) {
  const T = UNIT_TYPES[u.type];
  const high = T.domain === 'land' && u.carrier == null && s.terrain[u.y * s.W + u.x] && !cityAt(s, u.x, u.y);
  return T.vision + (high ? groundAt(s, u.x, u.y).sight : 0);
}
/** Is p the human player? In observer mode (s.observer) nobody plays themselves. */
const me = (s, p) => !s.observer && p === 0;
const playerName = (s, p) => (s.observer ? PLAYER_NAMES[p].replace(' (you)', '') : PLAYER_NAMES[p]) +
  (s.dip && s.dip.gname && s.dip.gname[p] ? ` (${s.dip.gname[p]})` : '');
const LAND_FILL = 0.42;         // initial land share before smoothing
const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The map is a torus: past every edge it continues on the opposite side.
let MAP_W = 96, MAP_H = 60;     // set in newGame depending on the number of players
// Map size: base 144 × 84 (room for 8 players); MAP_SCALE multiplies the AREA (sides by the square root)
const MAP_SCALES = [0.5, 1, 2, 4];
let MAP_SCALE = 1;
const setMapScale = f => { MAP_SCALE = MAP_SCALES.includes(+f) ? +f : 1; };
const mapSizeFor = () => { const k = Math.sqrt(MAP_SCALE); return [Math.round(144 * k), Math.round(84 * k)]; };
const wx = x => ((x % MAP_W) + MAP_W) % MAP_W;
const wy = y => ((y % MAP_H) + MAP_H) % MAP_H;
const wdx = (a, b) => { const d = Math.abs(a - b); return Math.min(d, MAP_W - d); };
const wdy = (a, b) => { const d = Math.abs(a - b); return Math.min(d, MAP_H - d); };
/** Distance in moves (a diagonal counts 1), measured across the map edges. */
const cheb = (ax, ay, bx, by) => Math.max(wdx(ax, bx), wdy(ay, by));
const cityAt = (s, x, y) => { const k = s.cityIdx[y * s.W + x]; return k < 0 ? null : s.cities[k]; };
const unitsAt = (s, x, y) => s.units.filter(u => u.x === x && u.y === y && u.carrier == null);
const cargoOf = (s, t) => s.units.filter(u => u.carrier === t.id);

/* ---------- Combat ---------- */

/**
 * A single combat round. Returns true if the ATTACKER hits
 * (defender loses 1 HP), otherwise false (attacker loses 1 HP).
 * A, D: entries from UNIT_TYPES (att, def, domain, ...).
 * ctx: { cityDef: number, cover: number } – cityDef is the city's defence factor (the larger, the stronger;
 *      1 outside cities), cover is the terrain factor for the defence
 *      (1 = plains, 1.25 = forest, 1.5 = hills, 2 = mountains; always 1 in cities and at sea).
 */
function combatRound(A, D, ctx) {
  // Hit chance = attack / (attack + effective defence). City walls and terrain increase the defence.
  const defense = D.def * (ctx.cityDef || 1) * (ctx.cover || 1);
  const attack = A.att * (ctx.attBonus || 1);   // player bonus for the preferred branch
  return Math.random() < attack / (attack + defense);
}

function fight(att, def, ctx) {
  const A = UNIT_TYPES[att.type], D = UNIT_TYPES[def.type];
  while (att.hp > 0 && def.hp > 0) {
    if (combatRound(A, D, ctx)) def.hp--; else att.hp--;
  }
  return att.hp > 0;
}

/* ---------- Game setup ---------- */

function newGame(seed, players = 3, attempt = 0) {
  players = Math.max(2, Math.min(PLAYER_NAMES.length, players));
  [MAP_W, MAP_H] = mapSizeFor(players);          // more players, bigger world
  const cityCount = Math.round(70 * MAP_W * MAP_H / (96 * 60));
  seed = (seed >>> 0) || 1;
  const rng = mulberry32(seed);
  const W = MAP_W, H = MAP_H, N = W * H;
  let t = new Uint8Array(N);
  for (let i = 0; i < N; i++) t[i] = rng() < LAND_FILL ? 1 : 0;
  for (let it = 0; it < 4; it++) {
    const n = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let c = 0;
      for (const [dx, dy] of DIRS) c += t[wy(y + dy) * W + wx(x + dx)];
      n[y * W + x] = c > 4 ? 1 : c < 4 ? 0 : t[y * W + x];
    }
    t = n;
  }
  // number the land masses
  const landId = new Int16Array(N).fill(-1);
  const landSize = [];
  for (let i = 0; i < N; i++) {
    if (!t[i] || landId[i] >= 0) continue;
    const id = landSize.length; let size = 0; const q = [i]; landId[i] = id;
    while (q.length) {
      const c = q.pop(); size++;
      const cx = c % W, cy = (c - cx) / W;
      for (const [dx, dy] of DIRS) {
        const j = wy(cy + dy) * W + wx(cx + dx);
        if (t[j] && landId[j] < 0) { landId[j] = id; q.push(j); }
      }
    }
    landSize.push(size);
  }
  // Terrain: forest and mountain areas from their own smoothed random fields, hills as a fringe around mountains
  const blob = (p, iters) => {
    let g = new Uint8Array(N);
    for (let i = 0; i < N; i++) g[i] = rng() < p ? 1 : 0;
    for (let it = 0; it < iters; it++) {
      const n = new Uint8Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let c = 0;
        for (const [dx, dy] of DIRS) c += g[wy(y + dy) * W + wx(x + dx)];
        n[y * W + x] = c > 4 ? 1 : c < 4 ? 0 : g[y * W + x];
      }
      g = n;
    }
    return g;
  };
  const forest = blob(0.45, 2), rock = blob(0.37, 2);
  const ground = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (t[i]) ground[i] = rock[i] ? 3 : forest[i] ? 1 : 0;
  for (let i = 0; i < N; i++) {
    if (!t[i] || ground[i] === 3) continue;
    const x = i % W, y = (i - x) / W;
    if (DIRS.some(([dx, dy]) => ground[wy(y + dy) * W + wx(x + dx)] === 3) && rng() < 0.6) ground[i] = 2;
  }
  // distribute cities
  const cand = [];
  for (let i = 0; i < N; i++) if (t[i]) cand.push(i);
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const cities = [], cityIdx = new Int16Array(N).fill(-1);
  for (const i of cand) {
    if (cities.length >= cityCount) break;
    const x = i % W, y = (i - x) / W;
    if (cities.some(c => cheb(c.x, c.y, x, y) < 5)) continue;
    const coastal = DIRS.some(([dx, dy]) => !t[wy(y + dy) * W + wx(x + dx)]);
    cityIdx[i] = cities.length; ground[i] = 0; // cities stand on level ground
    let r = rng(), kind = CITY_KINDS.length - 1;
    for (let k = 0; k < CITY_KINDS.length; k++) { if (r < CITY_KINDS[k].weight) { kind = k; break; } r -= CITY_KINDS[k].weight; }
    const c = { id: cities.length, x, y, owner: -1, prod: 'inf', progress: 0, coastal, kind };
    setPop(null, c, rollPop(rng, kind)); cities.push(c);
  }
  // Start islands: every player gets their own island with the same number of cities,
  // the same mix of city types and an area as similar as possible.
  const lid = c => landId[c.y * W + c.x];
  const byLand = new Map();
  for (const c of cities) { if (!byLand.has(lid(c))) byLand.set(lid(c), []); byLand.get(lid(c)).push(c); }
  let isles = [...byLand.entries()]
    .map(([id, cs]) => ({ id, cs, size: landSize[id], port: cs.find(c => c.coastal) }))
    .filter(i => i.port && i.size >= 15);
  // m = cities per start island: as many as possible (at most 3), but enough islands must support it
  let m = START_TEMPLATE.length;
  while (m >= 2 && isles.filter(i => i.cs.length >= m).length < players) m--;
  if (m < 2) return newGame(seed + 7919, players, attempt + 1);
  isles = isles.filter(i => i.cs.length >= m).sort((p, q) => p.size - q.size);
  // from the islands sorted by area, pick the window with the smallest size difference
  const win = Math.min(isles.length, players + 3);
  let w0 = 0, ratio = Infinity;
  for (let k = 0; k + win <= isles.length; k++) {
    const r = isles[k + win - 1].size / isles[k].size;
    if (r < ratio) { ratio = r; w0 = k; }
  }
  isles = isles.slice(w0, w0 + win);
  // within the window, take islands lying as far apart as possible
  const d2 = (p, q) => wdx(p.x, q.x) ** 2 + wdy(p.y, q.y) ** 2;
  let pick = null, bd = -1;
  for (const p of isles) for (const q of isles) {
    const d = d2(p.port, q.port);
    if (p !== q && d > bd) { bd = d; pick = [p, q]; }
  }
  while (pick && pick.length < players) {
    let next = null, nd = -1;
    for (const i of isles) {
      if (pick.includes(i)) continue;
      const d = Math.min(...pick.map(p => d2(p.port, i.port)));
      if (d > nd) { nd = d; next = i; }
    }
    if (!next) { pick = null; break; }
    pick.push(next); bd = Math.min(bd, nd);
  }
  if (!pick || bd < 400) return newGame(seed + 7919, players, attempt + 1);
  // Enlarge start islands: all grow to the same target area without merging with neighbouring islands
  const target = Math.min(START_MAX_SIZE, Math.max(START_MIN_SIZE, ...pick.map(i => i.size)));
  for (const isle of pick) {
    const free = (x, y) => {           // no foreign land may lie within a radius of 2 tiles
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const j = wy(y + dy) * W + wx(x + dx);
        if (t[j] && landId[j] !== isle.id) return false;
      }
      return true;
    };
    const cand = new Set();
    const addCoast = i => { const x = i % W, y = (i - x) / W; for (const [dx, dy] of DIRS) { const j = wy(y + dy) * W + wx(x + dx); if (!t[j]) cand.add(j); } };
    for (let i = 0; i < N; i++) if (landId[i] === isle.id) addCoast(i);
    for (let guard = 0; isle.size < target && cand.size && guard < 20000; guard++) {
      const arr = [...cand], j = arr[Math.floor(rng() * arr.length)];
      const x = j % W, y = (j - x) / W;
      if (!free(x, y)) { cand.delete(j); continue; }
      let nb = 0;
      for (const [dx, dy] of DIRS) if (landId[wy(y + dy) * W + wx(x + dx)] === isle.id) nb++;
      if (nb < 3 && rng() < 0.8) continue;   // fill bays first: gives compact coasts instead of fringes
      cand.delete(j);
      t[j] = 1; landId[j] = isle.id; ground[j] = rock[j] ? 3 : forest[j] ? 1 : 0; isle.size++;
      addCoast(j);
    }
    landSize[isle.id] = isle.size;
    // add missing cities so that every start island gets the full template
    const tiles = [];
    for (let i = 0; i < N; i++) if (landId[i] === isle.id && cityIdx[i] < 0) tiles.push(i);
    for (let i = tiles.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [tiles[i], tiles[j]] = [tiles[j], tiles[i]]; }
    for (const minD of [5, 4]) for (const i of tiles) {
      if (isle.cs.length >= START_TEMPLATE.length) break;
      const x = i % W, y = (i - x) / W;
      if (cityIdx[i] >= 0 || cities.some(c => cheb(c.x, c.y, x, y) < minD)) continue;
      const c = { id: cities.length, x, y, owner: -1, prod: 'inf', progress: 0, coastal: false, kind: 1 };
      setPop(null, c, rollPop(rng, 1));
      cityIdx[i] = c.id; ground[i] = 0; cities.push(c); isle.cs.push(c);
    }
    for (const c of isle.cs) c.coastal = DIRS.some(([dx, dy]) => !t[wy(c.y + dy) * W + wx(c.x + dx)]);
    if (!isle.port.coastal) isle.port = isle.cs.find(c => c.coastal);
  }
  if (pick.some(i => !i.port)) return newGame(seed + 7919, players, attempt + 1);
  m = Math.min(START_TEMPLATE.length, ...pick.map(i => i.cs.length));
  // Equalise: exactly m cities per start island (surplus, farthest ones are dropped), types per fixed template
  const drop = new Set();
  // Roll ONCE for each template slot and use it on all start islands alike: random, but fair
  const slotPop = START_TEMPLATE.map(k => rollPop(rng, k));
  const steps = (a, b) => cheb(a.x, a.y, b.x, b.y);   // distance in moves
  for (const isle of pick) {
    const P = isle.port;
    const rest = isle.cs.filter(c => c !== P).sort((p, q) => steps(p, P) - steps(q, P) || d2(p, P) - d2(q, P));
    // Each further city must lie strictly farther from the start (in moves) than the previous one (City, then Industrial City).
    // If it is equally far, it is moved outwards on the island.
    for (let k = 1; k < Math.min(m - 1, rest.length); k++) {
      const prev = rest[k - 1], c = rest[k];
      if (steps(c, P) > steps(prev, P)) continue;
      let best = -1, bd = Infinity;
      for (let i = 0; i < N; i++) {
        if (landId[i] !== isle.id || cityIdx[i] >= 0 || ground[i] === 4) continue;
        const x = i % W, y = (i - x) / W, sp = cheb(x, y, P.x, P.y);
        if (sp <= steps(prev, P) + 1) continue;
        if (cities.some(o => o !== c && cheb(o.x, o.y, x, y) < 4)) continue;
        const score = Math.abs(sp - (steps(prev, P) + 4));    // rather a bit farther, not to the very end
        if (score < bd) { bd = score; best = i; }
      }
      if (best < 0) return newGame(seed + 7919, players, attempt + 1);
      cityIdx[c.y * W + c.x] = -1;
      c.x = best % W; c.y = (best - c.x) / W; cityIdx[best] = c.id; ground[best] = 0;
      c.coastal = DIRS.some(([dx, dy]) => !t[wy(c.y + dy) * W + wx(c.x + dx)]);
    }
    [P, ...rest].forEach((c, k) => {
      if (k >= m) { drop.add(c); return; }
      c.kind = START_TEMPLATE[k]; setPop(null, c, slotPop[k]);
    });
  }
  if (drop.size) {
    const keep = cities.filter(c => !drop.has(c));
    cities.length = 0; cityIdx.fill(-1);
    keep.forEach((c, k) => { c.id = k; cities.push(c); cityIdx[c.y * W + c.x] = k; });
  }
  const best = pick.map(i => i.port);
  // Check: count independently that every start island really has the same total capacity
  const islePE = pick.map(i => cities.filter(c => landId[c.y * W + c.x] === i.id).reduce((a, c) => a + c.cap, 0));
  if (islePE.some(v => Math.abs(v - islePE[0]) > 1e-9)) return newGame(seed + 7919, players, attempt + 1);

  const s = {
    seed, W, H, terrain: t, ground, landId, cities, cityIdx, units: [], nextId: 1,
    ver: 0, cver: 0,           // cver: version of city ownership and diplomacy (for the target-island cache)
                       // ver: version counter of unit positions (for the occupancy cache)
    turn: 1, current: 0, winner: null, log: [], players, out: new Array(players).fill(false),
    startPE: islePE[0], startCities: m,
    neutral0: cities.filter(c => !best.includes(c)).length,   // neutral cities at game start (for the peace phase)
    warOpen: false,                                           // declarations of war allowed? (see warAllowed)
    hist: [],                                                 // troop strength per turn: { t, u: [units per player] }
    transferLog: [],                                          // all transfers: { turn, p, q, n, done }
    // missile statistics per player: fired, hits on own cities, total PP destroyed at the enemy
    missiles: { fired: new Array(players).fill(0), taken: new Array(players).fill(0), destroyed: new Array(players).fill(0),
                nukes: new Array(players).fill(0), nuked: new Array(players).fill(0) },
    roles: (() => {            // every player gets a bonus; in turn from a shuffled list so they spread out
      const keys = Object.keys(ROLES);
      for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
      return Array.from({ length: players }, (_, p) => keys[p % keys.length]);
    })(),
    // Diplomacy: rel[p][q] = 'none' (not met yet) | 'peace' | 'ally' | 'war';
    // offer[p][q] = offer from p to q ('ally' | 'peace'); window[p][q] = p may negotiate with q up to this turn
    dip: {
      rel: Array.from({ length: players }, (_, p) => Array.from({ length: players }, (_, q) => (p === q ? 'self' : 'none'))),
      offer: Array.from({ length: players }, () => new Array(players).fill(null)),
      window: Array.from({ length: players }, () => new Array(players).fill(0)),
      temper: (() => {
        const keys = Object.keys(TEMPERS);
        for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
        return Array.from({ length: players }, (_, p) => keys[p % keys.length]);
      })(),
      target: new Array(players).fill(-1),   // agreed attack target per player (generals)
      orders: Array.from({ length: players }, () => ({ focus: 'balanced', stance: 'normal', city: null, protect: [] })),   // the generals' orders
      gname: new Array(players).fill(null),  // name each general gave themselves
      motto: new Array(players).fill(null),  // self-chosen motto
      memory: Array.from({ length: players }, () => []),   // what has happened to the general (declarations of war, betrayal …)
      notes: new Array(players).fill(null),  // the general's private note from the last summit
      journal: Array.from({ length: players }, () => []),   // diary: after every summit { turn, goals, plan, review }
      lost: Array.from({ length: players }, () => new Array(players).fill(0)),   // lost[p][q]: cities p lost to q
      traits: Array.from({ length: players }, () => ({    // random quirks that make every general unique
        herkunft: TRAITS.herkunft[Math.floor(rng() * TRAITS.herkunft.length)],
        marotte: TRAITS.marotte[Math.floor(rng() * TRAITS.marotte.length)],
        schwaeche: TRAITS.schwaeche[Math.floor(rng() * TRAITS.schwaeche.length)],
      })),
      persona: (() => {                      // the general's character (only for the generals' chat)
        const keys = Object.keys(PERSONAS);
        for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
        return Array.from({ length: players }, (_, p) => keys[p % keys.length]);
      })(),
    },
    // Generals' chat: room 0 is the public World Council, the generals open and close further rooms themselves
    chat: { rooms: [{ id: 0, name: 'World Council', members: [...Array(players).keys()], open: true, by: -1, msgs: [] }], nextId: 1,
            reasons: [],     // the generals' reasoning for the observer – no general ever gets to see it
            summaries: [] }, // the war correspondent's summaries after every conversation round (observer only)
    generals: false, pendingSummit: false,
    explored: Array.from({ length: players }, () => new Uint8Array(N)),
    visible: Array.from({ length: players }, () => new Uint8Array(N)),
  };
  best.forEach((c, p) => { c.owner = p; spawn(s, 'inf', p, c.x, c.y); });   // per the template the start city is the town
  s.capital = best.slice();   // capital = start city (destination for transferred units)
  for (let q = 0; q < s.players; q++) computeVisibility(s, q);
  logMsg(s, 'The mist is lifting. Conquer all enemy cities.');
  logMsg(s, `Every player starts on their own island with ${m} cities, ${fmtPop(islePE[0] * POP_PER_PE)} inhabitants and ${fmt(islePE[0], 1)} PP in total.`);
  return s;
}

function spawn(s, type, owner, x, y) {
  s.ver++;
  const T = UNIT_TYPES[type];
  const u = { id: s.nextId++, type, owner, x, y, hp: T.hp, moves: T.moves, fuel: T.fuel || 0,
              carrier: null, dest: null, sentry: false, skip: false, dead: false, wait: 0, mission: false };
  s.units.push(u);
  return u;
}

function logMsg(s, msg) { s.log.push({ turn: s.turn, msg }); if (s.log.length > 200) s.log.shift(); }

function removeUnit(s, u) {
  if (u.dead) return;
  s.ver++;
  u.dead = true;
  if (UNIT_TYPES[u.type].capacity) for (const c of cargoOf(s, u)) c.dead = true;   // cargo goes down with it
  s.units = s.units.filter(o => !o.dead);
}

function reveal(s, p, cx, cy, r) {
  const v = s.visible[p], e = s.explored[p];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) { const i = wy(cy + dy) * s.W + wx(cx + dx); v[i] = 1; e[i] = 1; }
}

/** Recompute vision completely (expensive, so only once at the start of each turn). */
function computeVisibility(s, p) {
  s.visible[p].fill(0);
  for (const c of s.cities) if (c.owner === p) reveal(s, p, c.x, c.y, 2);
  for (const u of s.units) if (u.owner === p) reveal(s, p, u.x, u.y, visionOf(s, u));
}

function checkWinner(s) {
  const n = new Array(s.players).fill(0);
  for (const c of s.cities) if (c.owner >= 0) n[c.owner]++;
  // whoever has no city left is out; their remaining units dissolve
  for (let p = 0; p < s.players; p++) {
    if (n[p] > 0 || s.out[p]) continue;
    s.out[p] = true;
    for (const u of s.units) if (u.owner === p) u.dead = true;
    s.units = s.units.filter(u => !u.dead); s.ver++;
    if (!me(s, p)) logMsg(s, `${playerName(s, p)} is defeated.`);
  }
  const alive = n.filter(x => x > 0).length;
  if (s.observer) {
    if (alive === 1) { s.winner = n.findIndex(x => x > 0); logMsg(s, `${playerName(s, s.winner)} wins the game.`); }
    return;
  }
  if (n[0] === 0) s.winner = n.indexOf(Math.max(...n));
  else if (alive === 1) s.winner = 0;
  if (s.winner != null) logMsg(s, s.winner === 0 ? 'Victory! All enemy cities have fallen.' : 'Defeat. Your last city has fallen.');
}

/* ---------- Production capacity ---------- */

/** Growth: 5 % per full turn; `rounds` may be a fraction (surplus PP, remainder after repair). */
/** Cap on this city's capacity (depends on the owner's bonus). */
const roleVal = (s, p, key, dflt) => { const k = roleKey(s, p); return k && ROLES[k][key] != null ? ROLES[k][key] : dflt; };
const capMax = (s, c) => roleVal(s, c.owner, 'capMax', CAP_MAX);

/**
 * Growth with saturation: the full rate applies only to small cities and drops evenly to zero
 * the closer the city gets to its cap. Without this brake capacity would grow without limit
 * (compound interest), and every game would end after a few hundred turns with values in the billions.
 */
const popMax = (s, c) => capMax(s, c) * POP_PER_PE;
/** Random initial population within the city type's range (whole thousands). */
const rollPop = (rng, kind) => { const [lo, hi] = CITY_KINDS[kind].pop; return Math.round((lo + rng() * (hi - lo)) / 1000) * 1000; };

/** Sets the population and derives production (cap) and city type from it. */
function setPop(s, c, pop) {
  c.pop = Math.max(MIN_CAP * POP_PER_PE, Math.min(s ? popMax(s, c) : Infinity, pop));
  c.cap = c.pop / POP_PER_PE;
  if (s) updateKind(s, c);
}

function growCity(s, c, rounds) {
  const max = popMax(s, c);
  if (c.pop >= max) return;
  const rate = GROWTH_RATE * roleVal(s, c.owner, 'growth', 1);
  // compute in whole-turn steps so that even a large surplus never overshoots the cap
  let pop = c.pop;
  for (let left = rounds; left > 1e-9 && pop < max; left -= 1) {
    pop = Math.min(max, pop * (1 + rate * Math.min(1, left) * (1 - pop / max)));
  }
  setPop(s, c, pop);
}

/**
 * Population balance of one turn: natural growth (logistic, slowed near the cap)
 * minus inhabitants consumed by building/repair (buildPE) and troop supply (upkeepPE).
 * Because consumption grows with production and thus with population, every city settles
 * at an equilibrium value: the larger the supply share, the lower it is.
 */
/** Estimated population change per turn (inhabitants) with the current order and supply share free (for display). */
function popTrend(s, c, free) {
  const max = popMax(s, c), grow = c.prod === GROW;
  const nat = NAT_GROWTH * roleVal(s, c.owner, 'growth', 1) * c.pop * Math.max(0, 1 - c.pop / max);
  const prot = grow ? c.pop * GROWTH_RATE * roleVal(s, c.owner, 'growth', 1) * free * Math.max(0, 1 - c.pop / max) : 0;
  return nat + prot - DRAIN_BUILD * c.cap * (grow ? 0 : free) - DRAIN_UPKEEP * c.cap * (1 - free);
}

function popTick(s, c, buildPE, upkeepPE) {
  const max = popMax(s, c);
  const growth = NAT_GROWTH * roleVal(s, c.owner, 'growth', 1) * c.pop * Math.max(0, 1 - c.pop / max);
  setPop(s, c, c.pop + growth - DRAIN_BUILD * buildPE - DRAIN_UPKEEP * upkeepPE);
}

/**
 * Adapt the city type to the population. Index 0 = Industrial City, 1 = City, 2 = Town.
 * Promotion on reaching the next tier's threshold (800,000 or 1.3 M respectively).
 * Demotion only 10 % below its own threshold, so a city does not flip back and forth with every hit.
 */
function updateKind(s, c) {
  const old = c.kind;
  while (c.kind > 0 && c.pop >= CITY_KINDS[c.kind - 1].min - 1e-9) c.kind--;
  while (c.kind < CITY_KINDS.length - 1 && c.pop < CITY_KINDS[c.kind].min * 0.9 - 1e-9) c.kind++;
  if (c.kind !== old && me(s, c.owner))
    logMsg(s, `City (${c.x},${c.y}) is now ${/^[AEIOU]/.test(CITY_KINDS[c.kind].name) ? 'an' : 'a'} ${CITY_KINDS[c.kind].name}${c.kind < old ? ' – promoted!' : ' – downgraded.'}`);
}

/** Combat damage: randomly kills lo..hi (share) of the inhabitants; production drops by the same amount. */
function damageCity(s, c, lo, hi, attackerOwner) {
  const f = rand(lo, hi) * roleVal(s, c.owner, 'damage', 1) * (c.prod === GROW ? PROTECT_DAMAGE : 1);
  const lost = c.pop * f;
  setPop(s, c, c.pop - lost);
  if (me(s, c.owner) || me(s, attackerOwner))
    logMsg(s, `City (${c.x},${c.y}): ${fmtPop(lost)} inhabitants lost (${fmt(f * 100, 1)} %), now ${fmtPop(c.pop)} / ${fmt(c.cap)} PP.`);
  if (c.owner >= 0) enforceSupply(s, c.owner);
}

/* ---------- Stealth ---------- */

/** A submarine on the open sea is submerged; in port it lies visibly at the pier. */
const submerged = (s, o) => o.type === 'sub' && !cityAt(s, o.x, o.y);

/** Can player p see unit o? Submerged submarines are only detected by an own destroyer within vision range. */
function canSee(s, p, o) {
  if (o.owner === p) return true;
  if (!s.visible[p][o.y * s.W + o.x]) return false;
  if (!submerged(s, o)) return true;
  return s.units.some(d => d.owner === p && d.type === 'dest' && d.carrier == null &&
    cheb(d.x, d.y, o.x, o.y) <= UNIT_TYPES.dest.vision);
}

/* ---------- Supply ---------- */

/**
 * A player's supply situation: prod = sum of all city capacities, need = consumption of all units,
 * free = share of production (0..1) left for building and growth after supply.
 */
function supply(s, p) {
  let prod = 0, need = 0;
  for (const c of s.cities) if (c.owner === p) prod += c.cap;
  for (const u of s.units) if (u.owner === p) need += unitUpkeep(s, p, u.type);
  return { prod, need, free: prod > 0 ? Math.max(0, 1 - need / prod) : 0 };
}

/**
 * Supply can never exceed 100 %: if production does not cover all units,
 * units dissolve (desertion, disarmament) until the demand is covered again.
 * Empty units in the field with high consumption go first, transports/carriers with cargo last.
 */
function enforceSupply(s, p) {
  let { prod, need } = supply(s, p);
  if (need <= prod + 1e-9) return;
  const inCity = u => { const c = cityAt(s, u.x, u.y); return !!c && c.owner === p; };
  const order = s.units.filter(u => u.owner === p).map(u => ({
    u, k: (UNIT_TYPES[u.type].capacity && cargoOf(s, u).length ? 2 : 0) + (inCity(u) ? 1 : 0), up: unitUpkeep(s, p, u.type),
  })).sort((a, b) => a.k - b.k || b.up - a.up);
  let n = 0;
  for (const { u } of order) {
    if (need <= prod + 1e-9) break;
    if (u.dead) continue;
    const lost = [u, ...(UNIT_TYPES[u.type].capacity ? cargoOf(s, u) : [])];
    for (const x of lost) need -= unitUpkeep(s, p, x.type);
    removeUnit(s, u); n += lost.length;
  }
  if (n && me(s, p)) logMsg(s, `SUPPLY SHORTAGE: ${n} unit${n === 1 ? '' : 's'} disbanded because production can no longer supply the troops.`);
}

/* ---------- Repair ---------- */

const nearOwnCity = (s, u) => s.cities.some(c => c.owner === u.owner && cheb(c.x, c.y, u.x, u.y) <= 1);
/** Repair is only possible when damaged and in or directly next to an own city. */
function canRepair(s, u) { return !u.dead && u.hp < UNIT_TYPES[u.type].hp && nearOwnCity(s, u); }

/* ---------- Diplomacy ---------- */

const REVIEW_EVERY = 20;        // every this many turns: summit of the generals (or negotiation round of the rule AI)
const REL_NAME = { none: 'unknown', peace: 'Peace', ally: 'Alliance', war: 'War' };

/** May p fight q? Neutral cities (q = -1) always, other players only after a declaration of war. */
const hostile = (s, p, q) => q !== p && (q < 0 || p < 0 || s.dip.rel[p][q] === 'war');

/** Score for the ranking; also the strength measure the AI uses in diplomacy. */
function score(s, p) {
  if (s.out[p]) return 0;
  let cities = 0, cap = 0, units = 0;
  for (const c of s.cities) if (c.owner === p) { cities++; cap += c.cap; }
  for (const u of s.units) if (u.owner === p) units++;
  return Math.round(cities * 10 + cap * 5 + units);
}

/** Diplomatic message: visible in observer mode, to those involved, and to the human if they know both. */
function logDip(s, p, q, msg) {
  const knows = x => x === 0 || s.dip.rel[0][x] !== 'none';
  if (s.observer || me(s, p) || me(s, q) || (knows(p) && knows(q))) logMsg(s, msg);
}

/**
 * Change a relation – with alliance obligation: allies always fight the same wars.
 *  - War: afterwards p's whole bloc is at war with q's whole bloc.
 *    If p attacks a member of its own bloc, p first loses all of its own alliances.
 *  - Peace (from war): both blocs make peace together.
 *  - Alliance: the new joint bloc takes over all wars of both sides.
 */
/* Peace phase: wars may only be declared once the neutral cities are running out. */
const WAR_NEUTRAL_SHARE = 0.3;   // war only once at most 30 % of the initially neutral cities are still neutral
const neutralLeft = s => s.cities.filter(c => c.owner < 0 && !c.gone).length;
const warThreshold = s => Math.floor((s.neutral0 || 0) * WAR_NEUTRAL_SHARE);
/** Are declarations of war allowed? Once opened, the war phase stays open. */
function warAllowed(s) {
  if (s.warOpen || s.neutral0 == null) return true;
  if (neutralLeft(s) > warThreshold(s)) return false;
  s.warOpen = true;
  logMsg(s, `WAR PHASE: Only ${neutralLeft(s)} neutral cities left – from now on wars may be declared.`);
  if (s.chat) chatPost(s, -1, s.chat.rooms[0], 'The neutral cities are running out: from now on wars may be declared.');
  return true;
}

function setRel(s, p, q, r) {
  const old = s.dip.rel[p][q];
  if (old === r) return;
  if (r === 'war' && !warAllowed(s)) return;   // peace phase: no declarations of war
  const allies = x => [...Array(s.players).keys()].filter(y => y !== x && !s.out[y] && s.dip.rel[x][y] === 'ally');
  if (r === 'war') {
    if (bloc(s, p).has(q)) for (const y of allies(p)) setRelRaw(s, p, y, 'peace');   // betrayal of the own bloc
    setRelRaw(s, p, q, 'war');
    const A = bloc(s, p), B = bloc(s, q);
    for (const a of A) for (const b of B) if (s.dip.rel[a][b] !== 'war')
      setRelRaw(s, a, b, 'war', `ALLIANCE OBLIGATION: ${playerName(s, a)} and ${playerName(s, b)} are now at war (on the side of ${playerName(s, A.has(a) && a !== p ? p : q)}).`);
  } else if (r === 'peace' && old === 'war') {
    const A = bloc(s, p), B = bloc(s, q);
    setRelRaw(s, p, q, 'peace');
    for (const a of A) for (const b of B) if (s.dip.rel[a][b] === 'war')
      setRelRaw(s, a, b, 'peace', `PEACE: ${playerName(s, a)} and ${playerName(s, b)} join the peace settlement.`);
  } else if (r === 'ally') {
    setRelRaw(s, p, q, 'ally');
    const M = bloc(s, p);
    const foes = [...Array(s.players).keys()].filter(e => !s.out[e] && !M.has(e) && [...M].some(m => s.dip.rel[m][e] === 'war'));
    for (const m of M) for (const e of foes) if (s.dip.rel[m][e] !== 'war')
      setRelRaw(s, m, e, 'war', `ALLIANCE OBLIGATION: ${playerName(s, m)} enters the war against ${playerName(s, e)} on the side of its allies.`);
  } else setRelRaw(s, p, q, r);
}

/** Record an experience in a general's memory (the last 16 are kept). */
function remember(s, p, text) {
  if (!s.dip.memory || p < 0 || s.out[p]) return;
  const m = s.dip.memory[p];
  m.push(`T${s.turn}: ${text}`);
  if (m.length > 16) m.splice(0, m.length - 16);
}

function setRelRaw(s, p, q, r, msg) {
  const old = s.dip.rel[p][q];
  if (old === r) return;
  s.dip.rel[p][q] = s.dip.rel[q][p] = r; s.cver++;
  if (old !== 'none') {
    const P = playerName(s, p), Q = playerName(s, q);
    if (r === 'war' && old === 'ally') { remember(s, p, `You betrayed your ally ${Q} and declared war on them.`); remember(s, q, `BETRAYAL: Your ally ${P} declared war on you!`); }
    else if (r === 'war' && msg) { remember(s, p, `War with ${Q} (alliance obligation).`); remember(s, q, `War with ${P} (alliance obligation).`); }
    else if (r === 'war') { remember(s, p, `You declared war on ${Q}.`); remember(s, q, `${P} declared war on you.`); }
    else if (r === 'ally') { remember(s, p, `Alliance concluded with ${Q}.`); remember(s, q, `Alliance concluded with ${P}.`); }
    else if (old === 'ally') { remember(s, p, `You ended the alliance with ${Q}.`); remember(s, q, `${P} ended the alliance with you – a breach of trust.`); }
    else if (old === 'war') { remember(s, p, `Peace concluded with ${Q}.`); remember(s, q, `Peace concluded with ${P}.`); }
  }
  s.dip.offer[p][q] = s.dip.offer[q][p] = null;
  const a = playerName(s, p), b = playerName(s, q);
  if (msg) logDip(s, p, q, msg);
  else if (r === 'war') logDip(s, p, q, `WAR: ${a} declares war on ${b}.`);
  else if (r === 'ally') logDip(s, p, q, `ALLIANCE: ${a} and ${b} form an alliance.`);
  else if (old === 'war') logDip(s, p, q, `PEACE: ${a} and ${b} make peace.`);
  else if (old === 'ally') logDip(s, p, q, `${a} ends the alliance with ${b}.`);
}

// The computers' attitude in diplomacy
const TEMPERS = {
  balancer:    { name: 'Balancer',    note: 'allies with neighbours against an overpowering player' },
  opportunist: { name: 'Bandwagoner', note: 'joins the strongest and attacks the weaker' },
  cautious:    { name: 'Cautious',    note: 'avoids wars and seeks peace as long as it is not threatened' },
};
const MAX_BLOC = 3;             // an alliance bloc comprises at most three parties
// Overpowering means having more than DOMINANCE_FACTOR times one's fair share of the score (at least DOMINANCE_MIN of all points)
const DOMINANCE_FACTOR = 1.4, DOMINANCE_MIN = 0.25;
let ENDGAME_BALANCE = true;      // three survivors: the two weaker ones ally against the strongest
const NEAR = 30;                // "neighbour" = a city at most this many tiles from an own city

/** All players connected to p through alliances (p included). */
function bloc(s, p) {
  const seen = new Set([p]), todo = [p];
  while (todo.length) {
    const x = todo.pop();
    for (let y = 0; y < s.players; y++) if (!seen.has(y) && !s.out[y] && s.dip.rel[x][y] === 'ally') { seen.add(y); todo.push(y); }
  }
  return seen;
}
/** May p and q form an alliance without creating a bloc of more than three parties? */
function canAlly(s, p, q) {
  if (s.dip.rel[p][q] === 'ally') return true;
  const A = bloc(s, p), B = bloc(s, q);
  // nobody allies with the war enemy of one of their own partners
  if ([...A].some(a => [...B].some(b => (a !== p || b !== q) && s.dip.rel[a][b] === 'war'))) return false;
  return new Set([...A, ...B]).size <= MAX_BLOC;
}
const nearby = (s, a, b) => s.cities.some(c => c.owner === a && s.cities.some(d => d.owner === b && cheb(c.x, c.y, d.x, d.y) <= NEAR));

/**
 * What does AI player p want towards q? Basic rules:
 *  - Overpowering is whoever has clearly more points than their fair share (factor DOMINANCE_FACTOR, at least DOMINANCE_MIN).
 *    Then the temper decides: balancers fight them if they are a neighbour, and ally
 *    with others already fighting them. Bandwagoners ally with them. The cautious seek peace.
 *  - Otherwise: wars go on as long as one is not clearly inferior; alliances hold.
 *  - Whoever is not at war and hardly finds any neutral cities attacks the weakest neighbour.
 *  - On first contact, roughly equally strong parties sometimes ally spontaneously.
 */
function aiStance(s, p, q, first) {
  const cur = s.dip.rel[p][q], t = s.dip.temper[p];
  const alive = [...Array(s.players).keys()].filter(x => !s.out[x]);
  const sc = new Map(alive.map(x => [x, score(s, x)]));
  // Endgame against stalemate: if only one or two camps are left, there is fighting.
  //  - two camps: war between them, the alliance holds within
  //  - one camp (all allied): the strongest breaks the alliance and attacks the weakest
  // Three survivors: the two weaker ones ally against the strongest (balance of power).
  // Otherwise the two strongest would fall upon the smallest, and afterwards the one with more PP would almost always win.
  if (ENDGAME_BALANCE && alive.length === 3) {
    const top = alive.reduce((a, b) => (sc.get(b) > sc.get(a) ? b : a));
    return p !== top && q !== top ? 'ally' : 'war';
  }
  const camps = new Set(alive.map(x => Math.min(...bloc(s, x))));
  if (camps.size <= 2) {
    const same = bloc(s, p).has(q);
    if (camps.size === 2) return same ? 'ally' : 'war';
    const strongest = alive.reduce((a, b) => (sc.get(b) > sc.get(a) ? b : a));
    const weakest = alive.filter(x => x !== strongest).reduce((a, b) => (sc.get(b) < sc.get(a) ? b : a));
    return p === strongest && q === weakest ? 'war' : cur === 'ally' ? 'ally' : 'war';
  }
  const total = [...sc.values()].reduce((a, b) => a + b, 0) || 1;
  const leader = alive.reduce((a, b) => (sc.get(b) > sc.get(a) ? b : a));
  const dominant = sc.get(leader) / total > Math.max(DOMINANCE_MIN, DOMINANCE_FACTOR / alive.length);
  const sp = sc.get(p), sq = sc.get(q);
  if (dominant && p !== leader && q === leader) {
    if (t === 'balancer') return cur === 'war' || nearby(s, p, leader) ? 'war' : 'peace';
    if (t === 'opportunist') return cur === 'war' ? (sp >= sq * 0.8 ? 'war' : 'peace') : 'ally';
    return 'peace';                                            // cautious: don't pick a fight with the strong one
  }
  if (dominant && p !== leader && t === 'balancer' && s.dip.rel[q][leader] === 'war' && cur !== 'war') return 'ally';
  if (dominant && p === leader) {
    if (s.dip.temper[q] === 'opportunist' && cur !== 'war') return 'ally';   // the strong one gladly takes in bandwagoners
    return sq < sp * 0.5 || cur === 'war' ? 'war' : 'peace';
  }
  const neutral = s.cities.filter(c => c.owner < 0).length;
  const known = alive.filter(x => x !== p && s.dip.rel[p][x] !== 'none');
  if (cur === 'war') {
    // Avoid a two-front war: seek peace with the stronger enemy, keep fighting the weaker one
    // Counted by enemy camps: peace with one member applies to the whole bloc anyway
    const campStr = x => [...bloc(s, x)].reduce((a, y) => a + sc.get(y), 0);
    const foes = [...new Set(known.filter(x => s.dip.rel[p][x] === 'war').map(x => Math.min(...bloc(s, x))))];
    const mine = campStr(p), theirs = campStr(q);
    if (foes.length > 1 && theirs > Math.min(...foes.map(campStr)) && mine < theirs * 1.5) return 'peace';
    return mine >= theirs * (t === 'cautious' ? 1.2 : 0.8) ? 'war' : 'peace';
  }
  if ((t === 'cautious' ? neutral === 0 : neutral < 6) && !known.some(x => s.dip.rel[p][x] === 'war')) {
    const others = known.filter(x => s.dip.rel[p][x] !== 'ally');
    const pool = others.length ? others : neutral === 0 ? known : [];
    const weakest = pool.sort((a, b) => sc.get(a) - sc.get(b))[0];
    if (q === weakest) return others.length ? 'war' : 'peace';   // dissolve the alliance first, war next turn
  }
  if (cur === 'ally') return 'ally';
  // Common enemy: whoever fights the same stronger opponent joins forces
  if (known.some(x => x !== q && s.dip.rel[p][x] === 'war' && s.dip.rel[q][x] === 'war' && sc.get(x) > Math.max(sp, sq))) return 'ally';
  if (sp > sq * 1.3 && Math.random() < { opportunist: 0.5, balancer: 0.3, cautious: 0.1 }[t]) return 'war';
  if (first && Math.abs(sp - sq) <= 0.35 * Math.max(sp, sq)) return 'ally';   // whether it actually happens is decided by negotiate()
  return 'peace';
}

/** Negotiation of a pair. Between computers: war needs only one side, alliance and peace need both. */
function negotiate(s, p, q, first) {
  const human = !s.observer && (p === 0 || q === 0);
  if (!human) {
    const a = aiStance(s, p, q, first), b = aiStance(s, q, p, first);
    // spontaneous alliance on first contact: one joint roll (45 %), not two separate ones
    const ally = a === 'ally' && b === 'ally' && canAlly(s, p, q) && (!first || Math.random() < 0.45);
    const r = a === 'war' || b === 'war' ? 'war' : ally ? 'ally' : 'peace';
    setRel(s, p, q, r);
    return;
  }
  const ai = p === 0 ? q : p, want = aiStance(s, ai, 0, first), cur = s.dip.rel[ai][0];
  s.dip.window[0][ai] = s.turn + 1;                          // the human may respond in their next turn
  if (want === 'war' && cur !== 'war') setRel(s, ai, 0, 'war');
  else if (want === 'peace' && cur === 'ally') setRel(s, ai, 0, 'peace');
  else if ((want === 'ally' && cur !== 'ally' && canAlly(s, ai, 0)) || (want === 'peace' && cur === 'war')) {
    s.dip.offer[ai][0] = want;
    logMsg(s, `${playerName(s, ai)} offers you ${want === 'ally' ? 'an alliance' : 'peace'}. Respond under “Diplomacy”.`);
  }
}

/** First contact: p sees a unit or city of q for the first time. */
function detectContacts(s, p) {
  for (let q = 0; q < s.players; q++) {
    if (q === p || s.out[q] || s.dip.rel[p][q] !== 'none') continue;
    const seen = s.units.some(u => u.owner === q && u.carrier == null && canSee(s, p, u)) ||
                 s.cities.some(c => c.owner === q && s.visible[p][c.y * s.W + c.x]);
    if (!seen) continue;
    s.dip.rel[p][q] = s.dip.rel[q][p] = 'peace'; s.cver++;
    logDip(s, p, q, `FIRST CONTACT: ${playerName(s, p)} meets ${playerName(s, q)}.`);
    negotiate(s, p, q, true);
  }
}

/** Negotiation round: all pairs who know each other review their relation. */
function review(s) {
  logMsg(s, `NEGOTIATION ROUND (Turn ${s.turn}): alliances, wars and peace are renegotiated.`);
  for (const row of s.dip.offer) row.fill(null);
  // once all neutral cities are taken, everyone knows everyone (reconnaissance) – otherwise two empires might never meet
  const late = !s.cities.some(c => c.owner < 0);
  for (let p = 0; p < s.players; p++) for (let q = p + 1; q < s.players; q++) {
    if (s.out[p] || s.out[q]) continue;
    if (s.dip.rel[p][q] === 'none') {
      if (!late) continue;
      s.dip.rel[p][q] = s.dip.rel[q][p] = 'peace'; s.cver++;
      logDip(s, p, q, `FIRST CONTACT: ${playerName(s, p)} and ${playerName(s, q)} discover each other.`);
    }
    negotiate(s, p, q, false);
  }
}

/* ---------- Generals: summit with chat (Claude) ---------- */

// The generals' characters. note is given to the model as a role description.
// Quirks: every general randomly gets a background, a quirk and a weakness
const TRAITS = {
  herkunft: [
    'tank commander who spent the last war at the front', 'former intelligence chief', 'defence-industry manager who switched to uniform',
    'general staff officer with top marks but no front-line experience', 'naval aviator with three kills', 'coup general who pushed their way into power',
    'veteran of a lost war, embittered', 'logistics chief who knows every supply route', 'former guerrilla leader, now regular military',
    'ex-diplomat who returned to the army', 'TV general, known from talk shows', 'submarine commander, taciturn and cool',
  ],
  marotte: [
    'uses radio jargon ("Copy", "Out")', 'gives every plan an operation name ("Operation Sea Storm")', 'talks like a press spokesperson in stock phrases and denials',
    'likes to quote old military wisdom from Clausewitz to Moltke', 'cites alleged intelligence reports', 'speaks in management jargon (targets, costs, returns)',
    'is drily sarcastic', 'talks in terse military orders', 'refers to themselves in the third person', 'threatens with concrete consequences and deadlines ("by the next meeting")',
    'is exaggeratedly polite, especially towards enemies', 'tells anecdotes from earlier campaigns',
  ],
  schwaeche: [
    'vain – flattery almost always works on them', 'hot-tempered – reacts violently to insults', 'greedy – promises of loot attract them like a magnet', 'resentful – never forgets a slight',
    'fearful of the strongest', 'paranoid – smells conspiracies everywhere', 'envious of anyone with more cities', 'gullible towards allies', 'boastful – likes to give away too much',
    'hesitant – hates committing to a final decision',
  ],
};
const PERSONAS = {
  friedlich: { name: 'Peacemaker', note: 'You are a fanatical apostle of peace: to you war is a crime. You denounce every warmonger publicly and by name, demand disarmament, forge peace blocs against aggressors and break with anyone who takes up arms – without compromise.', stil: 'morally outraged, accusatory, relentless in condemning warmongers' },
  feindselig: { name: 'Distruster', note: 'You consider everyone a traitor and a liar until proven otherwise – and even then. You threaten openly, issue ultimatums, accuse others directly of conspiracy and enter alliances only on harsh terms with short deadlines.', stil: 'ice-cold, accusatory, suspects everyone of betrayal, threatens without beating about the bush' },
  aggressiv: { name: 'Conqueror', note: 'You want everything. Weakness is an invitation, hesitation deserves contempt. You demand submission, announce conquests openly, demand tribute and treat allies as tools for raids.', stil: 'roaring, drunk on victory, demands capitulation and submission' },
  verhandler: { name: 'Dealmaker', note: 'You are a merciless trader: everything has a price, and you always ask too much. You set harsh terms and tight deadlines, threaten to break off all talks and play bidders off against each other.', stil: 'demanding, ultimative, rock-hard on price, no polite phrases' },
  beleidiger: { name: 'Loudmouth', note: 'You despise all the other generals and show it: you mock, humiliate and insult them at every opportunity (crude, but no insults against real-world groups), boast without measure and provoke right up to the brink of war.', stil: 'scornful, insulting, gives everyone a derogatory nickname, boasts without measure' },
  intrigant: { name: 'Schemer', note: 'You are unscrupulous: you lie, slander and betray whenever it suits you. You spread targeted rumours about others, incite generals against each other and promise everyone something different.', stil: 'sugar-sweet in public, venomous in private; spreads brazen rumours and slander' },
  opportunist: { name: 'Bandwagoner', note: 'You grovel before the strongest and kick the weakest. You switch sides shamelessly as soon as someone else is ahead, and drop the weak demonstratively.', stil: 'servile upwards, mercilessly contemptuous downwards' },
  ehrenmann: { name: 'Man of Honour', note: 'All that counts for you is one\'s given word. Betrayal is unforgivable: whoever cheats you or your allies becomes your mortal enemy, and you tell them so to their face. You stand against the overpowering one regardless of losses.', stil: 'implacable, swears eternal loyalty or eternal enmity, names traitors publicly' },
};
const SUMMIT_ROUNDS = 3;         // conversation rounds per summit; the binding decisions are made in the last one
const INTRO_ROUNDS = 4;          // (obsolete, replaced by the phases)
const PRIVATE_MAX = 3;           // Back Room: up to this many conversation rounds in private rooms only before the World Council opens
const PUBLIC_ROUNDS = 2;         // World Council: this many conversation rounds; the decisions are made in the last one
const ROOM_HISTORY = 14;         // a general sees this many of the latest messages per room
const MAX_GROUP_ROOMS = 6;       // cap on a general's own open group rooms (only against sprawl); there is only one room per member combination anyway

const gname = p => PLAYER_NAMES[p].replace(/ \(you\)$/, '');
/** Does this player take part as a general (Claude)? Only the human does not – in observer mode Yellow is a computer too. */
const isGeneral = (s, p) => !s.out[p] && (s.observer || p !== 0);
/** Player number for a name from an answer ("Blue", "General Blue", "blue"); -1 if unknown. */
function playerByName(s, name) {
  const n = String(name || '').toLowerCase().replace(/^general\s+/, '').replace(/\s*\(you\)$/, '').trim();
  const byColor = PLAYER_NAMES.slice(0, s.players).findIndex(x => x.replace(/ \(you\)$/, '').toLowerCase() === n);
  if (byColor >= 0) return byColor;
  return s.dip.gname.findIndex(g => g && (g.toLowerCase() === n || g.toLowerCase().replace(/^\S+\s+/, '') === n));
}
const roomByName = (s, name) => {
  const n = String(name || '').trim().toLowerCase();
  return s.chat.rooms.find(r => r.open && r.name.toLowerCase() === n);
};
/** Open rooms p is a member of (the World Council belongs to everyone). */
const roomsOf = (s, p) => s.chat.rooms.filter(r => r.open && r.members.includes(p));

/** Removes letterheads like "Violet to Yellow:", "General Brandt to the World Council:", "This is …," at the start of a message. */
function stripHeader(t) {
  const colors = PLAYER_NAMES.map(n => n.replace(/ \(you\)$/, '')).join('|');
  const ranks = 'General|Admiral|Colonel|Commander|Marshal|Major|Captain|Lieutenant|Brigadier';
  // String.raw: in normal template strings "\s" would be lost
  const who = String.raw`(?:(?:${ranks})\s+[\p{L}-]+|${colors}|all|everyone|(?:the\s+)?World Council|Command \S+)(?:\s*\([^)]*\))?`;
  const re = new RegExp(String.raw`^${who}(?:\s*(?:to|→|->)\s*${who}(?:\s*(?:and|,)\s*${who})*)?\s*:\s*`, 'iu');
  // Self-introduction "Brandt, Violet." / "General Brandt, Violet, Logistics." / "Blue, Colonel Lindqvist."
  const rank = String.raw`(?:(?:${ranks})\s+)?`;
  const self1 = new RegExp(String.raw`^${rank}[\p{L}-]+,\s*(?:Colou?r\s+|Command\s+)?(?:${colors})(?:,\s*[^.:,]{1,25})?\s*[.:]\s*`, 'iu');
  const self2 = new RegExp(String.raw`^(?:${colors}),\s*${rank}[\p{L}-]+\s*[.:]\s*`, 'iu');
  // "This is General Brandt," / "Here is Violet." – only with a rank, colour or command, so "This is outrageous," survives
  const self3 = new RegExp(String.raw`^(?:This is|Here is|Here speaks)\s+(?:(?:${ranks})\s+[\p{L}-]+|${colors}|Command\s+\S+)(?:\s*\([^)]*\))?(?:\s+(?:of|from|for)\s+(?:${colors})|\s*,\s*(?:${colors}))?\s*[,.:]\s*`, 'iu');
  let prev;
  do { prev = t; t = t.replace(self1, '').replace(self2, '').replace(re, '').replace(self3, '').replace(/^To (?:all|everyone|the World Council)\s*[:,]\s*/i, '').trim(); } while (t !== prev);
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function chatPost(s, p, room, text) {
  if (!room || !room.open || (p >= 0 && !room.members.includes(p))) return false;
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (p >= 0) text = roundsToMeetings(s, stripHeader(text)).slice(0, 500); else text = text.slice(0, 500);
  if (!text) return false;
  // remember the conversation round so the display can frame messages of the same round
  const sm = s.summit;
  const round = sm ? `${sm.intro ? 'First Meeting' : 'Summit'} T${s.turn} · ${sm.phase === 'private' ? `🔒 Back Room ${sm.privRound}` : `🌐 World Council ${sm.pubRound}${sm.last ? ' (Decision)' : ''}`}` : `Turn ${s.turn}`;
  room.msgs.push({ turn: s.turn, at: Date.now(), from: p, text, round, seq: s.chat.seq = (s.chat.seq || 0) + 1 });
  if (room.msgs.length > 300) room.msgs.splice(0, room.msgs.length - 300);
  return true;
}
function chatOpen(s, p, name, memberNames) {
  const members = [...new Set([p, ...(memberNames || []).map(n => playerByName(s, n))])].filter(q => q >= 0 && !s.out[q]);
  if (members.length < 2) return null;
  name = String(name || '').trim().slice(0, 40) || `Room ${s.chat.nextId}`;
  const same = s.chat.rooms.find(r => r.open && r.id > 0 && r.members.length === members.length && members.every(m => r.members.includes(m)));
  if (same) return same;                                   // the same group already exists: keep using it
  for (let k = 2, base = name; roomByName(s, name) || /^(?:the\s+)?(?:world council|council)$/i.test(name); k++) name = `${base} ${k}`;
  if (members.length > 2 && s.chat.rooms.filter(r => r.open && r.by === p && r.id > 0 && r.members.length > 2).length >= MAX_GROUP_ROOMS) return null;
  // a room with ALL living generals would be a second World Council (and would bypass its lock in the Back Room)
  if (members.length > 2 && members.length >= [...Array(s.players).keys()].filter(q => isGeneral(s, q)).length) return null;
  const room = { id: s.chat.nextId++, name, members: members.sort((a, b) => a - b), open: true, by: p, opened: s.turn, msgs: [] };
  s.chat.rooms.push(room);
  chatPost(s, -1, room, `${gname(p)} opens the room "${name}" for ${room.members.map(gname).join(', ')}.`);
  return room;
}
function chatClose(s, p, name) {
  const room = roomByName(s, name);
  if (!room || room.id === 0 || !room.members.includes(p)) return false;
  chatPost(s, -1, room, `${gname(p)} closes the room.`);
  room.open = false; room.closed = s.turn; room.closedBy = p;
  return true;
}

const lostTxt = (s, p) => [...Array(s.players).keys()].filter(q => s.dip.lost[p][q]).map(q => `${gname(q)} ${s.dip.lost[p][q]}`).join(', ');
const wonTxt = (s, p) => [...Array(s.players).keys()].filter(q => s.dip.lost[q][p]).map(q => `${gname(q)} ${s.dip.lost[q][p]}`).join(', ');
/** Personality of general p as text (for system prompt and profile). */
function personality(s, p) {
  const per = PERSONAS[s.dip.persona[p]], t = s.dip.traits[p];
  return [`Character: ${per.name}. ${per.note}`, `Manner of speaking: ${per.stil}.`, `Background: ${t.herkunft}.`,
    `Quirk: ${t.marotte}.`, `Weakness: ${t.schwaeche}.`, s.dip.motto[p] ? `Your motto: "${s.dip.motto[p]}".` : ''].filter(Boolean).join('\n');
}

/* ---------- Situation report (text) for the generals ---------- */

/** Intelligence of p: what p itself or one of its allies currently sees (fog of war). */
function intelOf(s, p) {
  const N = s.W * s.H, eye = new Uint8Array(N);   // 1 = seen directly, 2 = only reported by allies
  for (let i = 0; i < N; i++) if (s.visible[p][i]) eye[i] = 1;
  for (let q = 0; q < s.players; q++) {
    if (q === p || s.out[q] || s.dip.rel[p][q] !== 'ally') continue;
    const v = s.visible[q]; for (let i = 0; i < N; i++) if (v[i] && !eye[i]) eye[i] = 2;
  }
  return eye;
}
/** Is the foreign unit u detectable for p (or its allies)? Submerged submarines only near destroyers. */
const spotted = (s, p, eye, u) => !!eye[u.y * s.W + u.x] &&
  (!submerged(s, u) || s.units.some(d => d.type === 'dest' && (d.owner === p || s.dip.rel[p][d.owner] === 'ally') && cheb(d.x, d.y, u.x, u.y) <= UNIT_TYPES.dest.vision));
/** "5 Tank, 3 Infantry" from a list of units. */
function unitList(units) {
  const n = {}; for (const u of units) n[u.type] = (n[u.type] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).map(([t, k]) => `${k} ${UNIT_TYPES[t].name}`).join(', ');
}
const LAGE_RADIUS = 4;      // foreign troops must be this close to an own city to count as a threat

/**
 * Situation report of general p: threatened own cities, positions of own troops, sighted foreign cities
 * and the distribution of the islands. About others it only contains what p or its allies see.
 */
function lagebild(s, p, eye = intelOf(s, p)) {
  const W = s.W, at = c => `(${c.x},${c.y})`, who = q => (q < 0 ? 'neutral' : q === p ? 'YOU' : gname(q));
  const rel = q => (q < 0 ? '' : s.dip.rel[p][q] === 'war' ? ' [WAR]' : s.dip.rel[p][q] === 'ally' ? ' [ally]' : '');
  const src = u => (eye[u.y * W + u.x] === 2 ? ' (per allies)' : '');
  const mine = s.cities.filter(c => c.owner === p);
  const foreign = s.units.filter(u => u.owner !== p && u.carrier == null && spotted(s, p, eye, u));
  const out = ['## SITUATION REPORT (own reconnaissance and reports from your allies; what nobody sees is missing)'];

  // 1. own cities: threat from foreign troops nearby
  const threat = mine.map(c => {
    const near = foreign.filter(u => cheb(u.x, u.y, c.x, c.y) <= LAGE_RADIUS && s.dip.rel[p][u.owner] !== 'ally');
    const garrison = s.units.filter(u => u.owner === p && u.x === c.x && u.y === c.y && u.carrier == null).length;
    return { c, near, garrison };
  }).sort((a, b) => b.near.length - a.near.length);
  const hot = threat.filter(t => t.near.length);
  out.push(`Own cities: ${mine.length}, of which threatened: ${hot.length}.`);
  for (const t of hot.slice(0, 6)) {
    const by = [...new Set(t.near.map(u => u.owner))].map(q => `${who(q)}${rel(q)}: ${unitList(t.near.filter(u => u.owner === q))}${src(t.near.find(u => u.owner === q))}`).join('; ');
    out.push(`- THREATENED ${CITY_KINDS[t.c.kind].name} ${at(t.c)}, pop. ${fmtPop(t.c.pop)}, garrison ${t.garrison}: ${by}`);
  }
  if (hot.length > 6) out.push(`- … and ${hot.length - 6} more threatened cities`);

  // 2. own troops: where are they?
  const mineU = s.units.filter(u => u.owner === p && u.carrier == null && !UNIT_TYPES[u.type].range);
  const groups = new Map();
  for (const u of mineU) {
    let best = null, bd = 4;
    for (const c of s.cities) { const d = cheb(c.x, c.y, u.x, u.y); if (d < bd) { bd = d; best = c; } }
    const sea = !s.terrain[u.y * W + u.x];
    const key = best ? `c${best.id}` : sea ? 'sea' : 'field';
    if (!groups.has(key)) groups.set(key, { c: best, sea, units: [] });
    groups.get(key).units.push(u);
  }
  const isAlly = q => q >= 0 && q !== p && s.dip.rel[p][q] === 'ally';
  const front = [...groups.values()].filter(g => g.c && g.c.owner !== p && !isAlly(g.c.owner)).sort((a, b) => b.units.length - a.units.length);
  const withAllies = [...groups.values()].filter(g => g.c && isAlly(g.c.owner));
  const home = [...groups.values()].filter(g => g.c && g.c.owner === p).sort((a, b) => b.units.length - a.units.length);
  const loose = [...groups.values()].filter(g => !g.c);
  out.push(`Own troops (${mineU.length} units excluding missiles):`);
  for (const g of front.slice(0, 6)) out.push(`- FRONT before ${who(g.c.owner)}${rel(g.c.owner)} city ${at(g.c)}: ${unitList(g.units)}`);
  if (withAllies.length) out.push(`- with allies: ${withAllies.slice(0, 4).map(g => `${who(g.c.owner)} ${at(g.c)} ${unitList(g.units)}`).join(' | ')}`);
  if (home.length) out.push(`- in/near own cities: ${home.slice(0, 5).map(g => `${at(g.c)} ${unitList(g.units)}`).join(' | ')}${home.length > 5 ? ` | … ${home.length - 5} more cities` : ''}`);
  for (const g of loose) out.push(`- ${g.sea ? 'at sea' : 'in the field'}: ${unitList(g.units)}`);
  const missiles = s.units.filter(u => u.owner === p && UNIT_TYPES[u.type].range).length;
  if (missiles) out.push(`- missiles ready to launch: ${missiles}`);

  // 3. sighted foreign cities (nearest first)
  const dist = c => Math.min(...mine.map(m => cheb(m.x, m.y, c.x, c.y)), 999);
  // order: war enemies, then other players, then neutrals, allies last – nearest first within each
  const prio = c => (c.owner < 0 ? 2 : s.dip.rel[p][c.owner] === 'war' ? 0 : s.dip.rel[p][c.owner] === 'ally' ? 3 : 1);
  const known = s.cities.filter(c => c.owner !== p && eye[c.y * W + c.x]).sort((a, b) => prio(a) - prio(b) || dist(a) - dist(b));
  if (known.length) {
    out.push(`Sighted foreign cities (war enemies first, ${known.length} in total):`);
    for (const c of known.slice(0, 8)) {
      const g = foreign.filter(u => u.x === c.x && u.y === c.y);
      out.push(`- ${who(c.owner)}${rel(c.owner)} ${CITY_KINDS[c.kind].name} ${at(c)}, ${dist(c)} tiles from you, garrison: ${g.length ? unitList(g) : 'none visible'}${eye[c.y * W + c.x] === 2 ? ' (per allies)' : ''}`);
    }
  }

  // 4. islands with own cities: ownership
  const isles = new Map();
  for (const c of s.cities) {
    const l = s.landId[c.y * W + c.x];
    if (!isles.has(l)) isles.set(l, []);
    isles.get(l).push(c);
  }
  const myIsles = [...isles.values()].filter(cs => cs.some(c => c.owner === p)).sort((a, b) => b.length - a.length);
  out.push('Your islands (cities by owner):');
  for (const cs of myIsles.slice(0, 5)) {
    const n = {}; for (const c of cs) n[who(c.owner)] = (n[who(c.owner)] || 0) + 1;
    out.push(`- island near ${at(cs[0])}: ${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  return out.join('\n');
}

/** p's orders as short text (for the briefing and display). */
function ordersText(s, p, o = ordersOf(s, p)) {
  const at = c => `(${c.x},${c.y})`;
  return `Armament ${FOCI[o.focus]}, stance ${STANCES[o.stance]}` + (o.city ? `, target city ${at(o.city)}${o.city.gone ? ' (destroyed)' : o.city.owner === p ? ' (conquered)' : ` of ${o.city.owner < 0 ? 'neutral' : gname(o.city.owner)}`}` : '') +
    (o.protect.length ? `, protect ${o.protect.map(at).join(' ')}` : '');
}

/** Point in time t relative to now, in meetings instead of turns: "at the last meeting", "3 meetings ago", "at the start". */
function whenTxt(s, t) {
  const k = Math.round((s.turn - t) / REVIEW_EVERY);
  return t <= 1 && s.turn > 1 ? 'at the start (first meeting)' : k <= 0 ? 'in this war phase' : k === 1 ? 'at the last meeting' : `${k} meetings ago`;
}
/** Replace turn numbers in a general's message with meetings ("by turn 60" -> "by the next meeting"). */
function roundsToMeetings(s, text) {
  const next = Math.ceil((s.turn + 1) / REVIEW_EVERY) * REVIEW_EVERY;
  // 0 = past, 1 = immediately (right after this meeting), 2 = next meeting, 3 = the one after, 4 = later
  const k = n => (n < s.turn ? 0 : n <= s.turn + 5 ? 1 : n <= next ? 2 : n <= next + REVIEW_EVERY ? 3 : 4);
  const until = n => ['immediately', 'immediately', 'by the next meeting', 'by the meeting after next', 'until later'][k(n)];
  const from = n => ['immediately', 'immediately', 'from the next meeting on', 'from the meeting after next on', 'later'][k(n)];
  const at = n => ['at the last meeting', 'now', 'at the next meeting', 'at the meeting after next', 'later'][k(n)];
  text = text
    .replace(/\b(?:until|till|by|before)\s+(?:the\s+end\s+of\s+)?(?:turn|round)\s+(\d+)/gi, (_, n) => until(+n))
    .replace(/\bsince\s+(?:turn|round)\s+(\d+)/gi, () => 'since the last meeting')
    .replace(/\b(?:from|in|after|at|on)\s+(?:turn|round)\s+(\d+)/gi, (_, n) => from(+n))
    .replace(/\b(?:turn|round)\s+(\d+)/gi, (_, n) => at(+n))
    .replace(/\bT(\d{1,4})\b/g, (_, n) => at(+n));
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Briefing from general p's point of view, as text for the model. */
function summitBriefing(s, p) {
  const alive = [...Array(s.players).keys()].filter(x => !s.out[x]);
  const eye = intelOf(s, p);
  const seen = Array.from({ length: s.players }, () => ({ land: 0, sea: 0, air: 0 }));
  for (const u of s.units) if (u.owner !== p && u.carrier == null && spotted(s, p, eye, u)) seen[u.owner][UNIT_TYPES[u.type].domain]++;
  const sc = new Map(alive.map(x => [x, score(s, x)]));
  const relTxt = { none: 'unknown', peace: 'peace', ally: 'ALLIANCE', war: 'WAR' };
  const stat = x => {
    let cities = 0, pop = 0; for (const c of s.cities) if (c.owner === x) { cities++; pop += c.pop; }
    const n = { land: 0, sea: 0, air: 0 }; for (const u of s.units) if (u.owner === x) n[UNIT_TYPES[u.type].domain]++;
    const sp = supply(s, x);
    return { cities, pop, pe: sp.prod, sup: sp.prod > 0 ? Math.round(sp.need / sp.prod * 100) : 0, ...n };
  };
  const me = stat(p);
  const lines = [...alive].sort((a, b) => sc.get(b) - sc.get(a)).map((x, i) => {
    const st = stat(x), allies = alive.filter(y => y !== x && s.dip.rel[x][y] === 'ally').map(gname), wars = alive.filter(y => y !== x && s.dip.rel[x][y] === 'war').map(gname);
    const army = x === p ? `army land ${st.land}/sea ${st.sea}/air ${st.air}` : `sighted land ${seen[x].land}/sea ${seen[x].sea}/air ${seen[x].air} (possibly more in reality)`;
    return `${i + 1}. ${gname(x)}${s.dip.gname[x] ? ` ("${s.dip.gname[x]}")` : ''}${x === p ? ' (YOU)' : ''}: ${sc.get(x)} points, ${st.cities} cities, ${fmt(st.pe, 1)} PP, ${army}` +
      (x === p ? '' : `, relation to you: ${relTxt[s.dip.rel[p][x]]}${nearby(s, p, x) ? ', NEIGHBOUR' : ''}`) +
      `; allies: ${allies.join(', ') || 'none'}; at war with: ${wars.join(', ') || 'nobody'}`;
  });
  const total = [...sc.values()].reduce((a, b) => a + b, 0) || 1;
  const tgt = s.dip.target[p];
  return [
    `You are General ${gname(p)}${s.dip.gname[p] ? ` and your name is "${s.dip.gname[p]}"` : ''}.`,
    `Your situation: ${me.cities} cities, ${fmtPop(me.pop)} inhabitants, ${fmt(me.pe, 1)} PP per turn, supply load ${me.sup} %. Your bonus: ${ROLES[s.roles[p]].name}.`,
    `Your units: ${Object.keys(UNIT_TYPES).map(t => [t, s.units.filter(u => u.owner === p && u.type === t).length]).filter(([, n]) => n).map(([t, n]) => `${UNIT_TYPES[t].name} ${n}`).join(', ') || 'none'}.`,
    `Ranking (score = cities×10 + PP×5 + units; total ${total}):`, ...lines,
    `Neutral (unoccupied) cities in the world: ${neutralLeft(s)}.`,
    warAllowed(s) ? 'WAR PHASE: declarations of war are allowed.'
      : `PEACE PHASE: wars may NOT be declared yet – only once at most ${warThreshold(s)} neutral cities are left (now ${neutralLeft(s)}). Until then "war" counts as "peace". Use the time: conquer neutral cities, prepare alliances, size up rivals.`,
    `Your current attack target: ${tgt >= 0 && !s.out[tgt] ? gname(tgt) : 'none'}.`,
    `Your current orders: ${ordersText(s, p)}.`,
    '', lagebild(s, p, eye),
    `Cities you have lost to others: ${lostTxt(s, p) || 'none'}. Cities you have taken from others: ${wonTxt(s, p) || 'none'}.`,
    '', 'Your memories (what has happened to you, oldest first):', ...(s.dip.memory[p].length ? s.dip.memory[p].map(m => '- ' + m.replace(/^T(\d+):/, (_, t) => `${whenTxt(s, +t)}:`)) : ['- nothing special yet']),
    s.dip.notes[p] ? `\nYour private note from the last summit: "${s.dip.notes[p]}"` : '',
    ...(s.dip.journal[p].length ? ['', 'Your diary (your latest entries, oldest first):', ...s.dip.journal[p].slice(-3).map(j =>
      `- ${whenTxt(s, j.turn)}: Goals: ${j.goals || '–'} | Plan: ${j.plan || '–'} | Review: ${j.review || '–'}`)] : []),
  ].join('\n');
}

/** Request to general p for conversation round k: { system, prompt }. */
function summitPrompt(s, p, k, rounds = (s.summit && s.summit.rounds) || SUMMIT_ROUNDS) {
  const sm = s.summit || {};
  const intro = !!sm.intro, priv = sm.phase === 'private', last = sm.phase ? !!sm.last : k === rounds;
  const per = PERSONAS[s.dip.persona[p]];
  const others = [...Array(s.players).keys()].filter(x => x !== p && !s.out[x]).map(gname);
  const rooms = roomsOf(s, p).map(r => {
    const who = r.id === 0 ? 'all generals' : r.members.map(gname).join(', ');
    const age = t => (t === s.turn ? 'NOW' : `${whenTxt(s, t)} – outdated`);
    // NEW = written by others after p last said something in this room
    const mine = r.msgs.filter(m => m.from === p).map(m => m.seq || 0);
    const seen = mine.length ? Math.max(...mine) : -1;
    const fresh = m => m.from >= 0 && m.from !== p && m.turn === s.turn && (m.seq || 0) > seen;
    const msgs = r.msgs.slice(-ROOM_HISTORY).map(m => `  ${fresh(m) ? 'NEW ' : ''}[${age(m.turn)}] ${m.from < 0 ? '(System)' : gname(m.from)}: ${m.text}`).join('\n');
    r._fresh = r.msgs.some(fresh);
    return `### Room "${r.name}" (members: ${who})${r._fresh ? ' – UNANSWERED' : ''}\n${msgs || '  (no messages yet)'}`;
  }).join('\n\n');
  const unanswered = roomsOf(s, p).filter(r => r.id > 0 && r._fresh).map(r => `"${r.name}"`);
  const final = last && !intro;   // nothing is decided at the getting-to-know-you meeting
  const system = [
    `You are ${s.dip.gname[p] ? `"${s.dip.gname[p]}", ` : ''}the general of colour ${gname(p)} in the turn-based island war game "Mistcoast".`,
    personality(s, p),
    'SETTING: modern era (20th/21st century). There are infantry, tanks, fighters, bombers, destroyers, submarines, carriers and missiles. You are a modern military officer or head of state – not a knight, philosopher or poet.',
    'STYLE: sober, concrete, military-political like a radio message or a negotiation memo. Talk about intentions, interests, enemies, fronts, demands, deadlines and threats; numbers only when they really matter. NO philosophy, no life wisdom, no poetic imagery, no metaphors (no castles, swords, banners, towers, chess, wind, fog, weather).',
    'NO NUMBER INTERROGATIONS: NEVER ask others about their units, cities, PP or positions and do not demand proof, evidence or disclosure – you know their strength from the ranking and the situation report. Do not measure generals by numbers but by attitude, reliability, ambition and intentions.',
    'EXTREME: Take clear, uncompromising, pointed positions – in the most radical form of your character. Name friend and foe unambiguously, issue ultimatums, demand a lot, threaten hard, swear loyalty or enmity. Every message must contain a clear statement, demand, threat or accusation.',
    'FORBIDDEN are evasive stock phrases: "we will see", "I take note of that", "I will look into it", "for now", "let\'s wait", "I keep all options open", "I remain attentive", "we\'ll see", "possibly", "respect for all sides". No hedging, no polite filler, no balance for balance\'s sake.',
    'TONE EXAMPLES (copy only the hardness, not the words): "Hale, you are a liar – at the next meeting your harbours are mine." / "Whoever deals with Red is my enemy. Period." / "Crane, you grovel before anyone who has cities. I despise you." / "Final offer: alliance now or war as soon as it is allowed." / "Green lied to me. I will never forget it."',
    'Personality shows in attitude, tone and quirk – not in flowery language. React personally to what others say; bring up old slights, broken promises and betrayals from your memories; carry grudges and gratitude from summit to summit.',
    'The other generals are addressed by their colour (their self-chosen name in brackets). In "decisions", "target" and "members" you always use the COLOUR.',
    'Goal of the game: be the last one standing. Players conquer cities; whoever has no city left is out.',
    'Diplomacy rules: war can be declared by one side alone. Alliance and peace need the consent of both sides.',
    'An alliance bloc has at most 3 parties. Allies automatically fight the same wars (alliance obligation), and peace between two blocs applies to all members.',
    'You talk to the other generals in the public World Council and in private rooms that you can open and close again. Only members read a room.',
    'WORLD COUNCIL = public stage: announce positions, mock and smear opponents, court sympathy, make friends with others, voice warnings and threats.',
    'PRIVATE ROOMS = negotiating table: all concrete deals belong ONLY here – unit transfers, division of spoils, alliance terms, joint attack plans with dates. In the World Council you name no unit offers or trades; if you want to deal with someone, open a room with them or use an existing one.',
    'SENDER: your name automatically appears above each of your messages, and everyone sees which room it is in. So NEVER start messages with sender or addressee ("Violet to Yellow:", "General X:", "This is …", "To all:"). Address others directly by name when needed (e.g. "Mercer, …").',
    'LANGUAGE: Write in English. Every chat message, note, diary entry and reasoning you produce must be in English – never in any other language.',
    'Write briefly (1–2 sentences per message), fully in character and never like a neutral assistant. Lying, threatening, flattering and scheming are allowed.',
    'WAR ENEMIES: whoever is at war with you is not treated politely. Mock and insult them – publicly in the World Council and in private: sneer at their losses, their incompetence, their lost cities, their cowardly leadership, give them derogatory nicknames. Crude and personal is allowed, but only against the game character (no insults against real-world groups, nothing racist or sexual).',
    'SMEARING: In diplomacy, also run others down to win partners or isolate rivals: allege broken promises, weakness, secret plans or betrayal, spread rumours about negotiations in other rooms, portray rivals as unreliable or dangerous. How much you do this depends on your character – even a peacemaker warns against the most dangerous one, a schemer or loudmouth does it constantly.',
    'Answer EXCLUSIVELY with a single JSON object, without Markdown and without text before or after it.',
  ].join('\n');
  const askName = !s.dip.gname[p] ? `"name":"your self-chosen general's name",` : '';
  const schema0 = final
    ? `{"open_rooms":[{"name":"…","members":["Colour",…]}],"close_rooms":["room name"],"messages":[{"room":"World Council or room name","text":"…"}],"decisions":{${others.map(o => `"${o}":"war|peace|alliance"`).join(',')}},"target":"colour of the joint attack target or null","transfers":[{"to":"Colour","units":{"Tank":2,"Infantry":3}}],"orders":{"focus":"land|sea|air|missiles|protection|balanced","stance":"offensive|defensive|normal","target_city":"x,y of a foreign city or null","protect":["x,y of an own city"]},"note":"private note to yourself for the next summit: plans, grudges, whom you (don't) trust – at most 2 sentences","reasoning":"to the game master: why you decided this way – 1 to 2 sentences, honest","diary":{"goals":"your long-term goals in this war (1 sentence)","plan":"what you want to achieve at the next summit (1–2 sentences)","review":"what happened at this summit, from your point of view (1–2 sentences)"}}`
    : intro && last
    ? `{"open_rooms":[{"name":"…","members":["Colour",…]}],"close_rooms":["room name"],"messages":[{"room":"World Council or room name","text":"…"}],"note":"private note: your impression of the others – who is strong, who lies, who is fit to be a partner, who a victim; at most 3 sentences","reasoning":"to the game master: whom you like, whom you reject, whom you despise – and why; 2–3 sentences, honest","diary":{"goals":"your long-term goals in this war (1 sentence)","plan":"what you want to achieve at the next summit (1–2 sentences)","review":"what happened at this summit, from your point of view (1–2 sentences)"}}`
    : priv
    ? `{"open_rooms":[{"name":"…","members":["Colour",…]}],"close_rooms":["room name"],"messages":[{"room":"name of a private room","text":"…"}]}`
    : `{"open_rooms":[{"name":"…","members":["Colour",…]}],"close_rooms":["room name"],"messages":[{"room":"World Council or room name","text":"…"}]}`;
  const schema = askName ? '{' + askName + schema0.slice(1) : schema0;
  const nth = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const prompt = [
    `## TIME: This is the ${nth((s.summitsDone || 0) + 1)} meeting of the generals. Between two meetings a war phase passes in which the armies fight according to your orders.`,
    'NEVER mention turn numbers. You state dates and deadlines only in meetings: "immediately", "by the next meeting", "at the meeting after next". What was agreed in older messages or memories is the past – deadlines named there have expired.', '',
    '## Situation', summitBriefing(s, p), '',
    '## Your rooms and the latest messages', rooms, '',
    `## Task: ${priv ? `BACK ROOM (private conversation round ${sm.privRound || k} of at most ${PRIVATE_MAX})` : `WORLD COUNCIL (public conversation round ${sm.pubRound || 1} of ${PUBLIC_ROUNDS})`}${intro ? ' – FIRST MEETING (getting to know each other)' : ''}`,
    priv
      ? 'The World Council is still CLOSED. In this phase write ONLY in private rooms. '
        + (unanswered.length ? `First: answer the NEW messages in ${unanswered.join(', ')} – whoever is addressed and stays silent is considered rude or suspicious. ` : '')
        + 'ROOMS: you may have your own private channel with every other general (if there is already an open one with them, keep using it). In addition you may open group rooms for coalitions – one per combination of members, with some generals, never with all (the World Council is there for all). COALITIONS: if you are discussing the same thing with two or more generals (common enemy, three-way alliance, dividing up an island), open a group room with exactly those generals instead of repeating it in several private channels. Public announcements, introductions and threats to everyone do not belong in private rooms. New rooms need their own unmistakable name; messages to a new room in the same JSON are allowed. Close a room only to break off a conversation demonstratively – never to tidy up. '
        + ((sm.privRound || 1) >= 2 ? 'Now is the time for coalitions: whoever in your private channels has the same enemies or goals as you belongs in a joint group room – open it. ' : '')
        + (intro ? 'First meeting: sound out the others in private, find out how they tick and who they talk to. Hints yes, commitments no – nothing is decided today.'
          : 'Negotiate in private: alliances, joint targets, spoils, unit transfers. It only becomes binding in the last World Council round.')
      : !last
      ? 'The World Council is now OPEN. Announce positions, mock opponents, court sympathy, sow doubt – concrete deals stay in the private rooms, where you may also keep answering. '
        + (unanswered.length ? `Open messages to you in ${unanswered.join(', ')}. ` : '')
        + (intro ? 'First meeting: introduce yourself to the group and react to the others.' : '')
      : intro
      ? 'This is the first meeting of all generals. NOTHING is decided today: no alliances, no declarations of war, no treaties, no transfers. '
        + 'Get to know the others: introduce yourself (in your style), react to their introductions, find out how they tick – ambitious, fearful, vain, reliable, dangerous? '
        + 'Spy on people, not numbers: find out who talks to whom, who distrusts whom, who has ambitions on whose islands and who is suited as partner or victim; read between the lines, sow doubt, flatter, provoke. Do NOT ask about troop strengths. '
        + 'You may open private rooms to sound out individuals in private. Drop hints, but make no commitments.'
        + (last ? ' Last conversation round: record privately under "note" what you have found out about the others, and write your goals, your plan for the next summit and your review under "diary". '
          + 'Also explain honestly under "reasoning" to the game master (only they read it, no other general) which general you like, which you reject and which you despise – and why.' : '')
      : final
      ? 'Last round: write your final words and make BINDING decisions for EVERY other general: "war", "peace" or "alliance". An alliance only comes about if both choose "alliance"; "war" from one side is enough for war. Optionally choose an attack target (a general you will then be at war with) on which your army concentrates – ideally one you agreed on with allies. Carry out promised unit transfers now under "transfers" (or break the promise). '
        + 'ORDERS to your army (valid until the next summit, it really carries them out): "focus" = build focus of your cities (land, sea, air, missiles, protection = protect the population and let it grow, balanced); "stance" = offensive (storm early, gather little) or defensive (gather a lot, keep every city garrisoned) or normal; "target_city" = coordinates of ONE foreign city from your situation report at which invasions, ground troops, missiles and bombers are directed (only effective if you are at war with its owner); "protect" = up to 3 own cities that always keep 2 defenders. Use these to implement what you agreed with allies. '
        + 'DIARY: write your long-term goals, your plan for the next summit and your review of this summit under "diary" – you will read it again at the next summit. '
        + 'REASONING: explain under "reasoning" in 1–2 sentences to the game master why you chose war, alliance or peace with whom. ONLY the game master reads this, no other general – be honest, even if you bluffed or lied in the chat.'
      : 'Negotiate: forge alliances, agree on attack targets, run opponents down, recruit partners against the strongest or pick an easy victim together. ROOMS: you may have your own private channel with every other general (if there is already an open one with them, keep using it). In addition you may open group rooms for coalitions – one per combination of members, with some generals, never with all (the World Council is there for all). COALITIONS: if you are discussing the same thing with two or more generals (common enemy, three-way alliance, dividing up an island), open a group room with exactly those generals instead of repeating it in several private channels. Public announcements, introductions and threats to everyone do not belong in private rooms. New rooms need their own unmistakable name; messages to a new room in the same JSON are allowed. Close a room only to break off a conversation demonstratively – never to tidy up. Decisions are only made in the last round.'
      + ` BARGAINING CHIPS (negotiate only in private rooms, never in the World Council): you can transfer units to other generals (as the price for an alliance, peace, a share of the spoils, help against an enemy …). They appear immediately in the recipient's capital and then belong to them; they also have to supply them. At most ${TRANSFER_MAX} units or ${Math.round(TRANSFER_SHARE * 100)} % of your army per summit, not to war enemies. They are only carried out in the last round – until then they are just promises.`,
    (() => { const foes = [...Array(s.players).keys()].filter(x => x !== p && !s.out[x] && s.dip.rel[p][x] === 'war').map(gname);
      return foes.length && !intro ? `You are at war with: ${foes.join(', ')} – mock them in at least one message.` : ''; })(),
    `Valid generals: ${others.join(', ')}. At most ${intro ? 4 : 3} messages.`,
    'Answer format (empty lists may be omitted):', schema,
  ].join('\n');
  return { system, prompt };
}

const RANKS = ['General', 'Admiral', 'Colonel', 'Major', 'Commander', 'Marshal'];
// Rank words → English rank (leftover German ranks a model may still produce are mapped too)
const RANK_MAP = [
  [/^(?:generalin|general|generalmajor|generalleutnant|generaloberst)$/i, 'General'], [/^(?:admiralin|admiral|konteradmiral|vizeadmiral)$/i, 'Admiral'], [/^(?:oberstin|oberst|colonel)$/i, 'Colonel'],
  [/^(?:marschall|marshal|marshall)$/i, 'Marshal'], [/^(?:kommandant|kommandantin|kommandeur|commander)$/i, 'Commander'],
  [/^(?:brigadier|brigadegeneral)$/i, 'Brigadier'], [/^(?:major|majorin)$/i, 'Major'],
  [/^(?:kapit(?:ae|.)n(?:in)?|captain)$/iu, 'Captain'], [/^(?:leutnant|leutnantin|lieutenant)$/i, 'Lieutenant'],
];
const RANK_ORDER = ['Marshal', 'Admiral', 'General', 'Colonel', 'Brigadier', 'Commander', 'Major', 'Captain', 'Lieutenant'];
/** Shorten a name to "Rank Surname": "Major General Dietrich Vallen" becomes "General Vallen". */
function shortName(n) {
  const w = n.split(' ').filter(Boolean);
  if (!w.length) return '';
  // the rank may be a compound like "Major General" or "Rear Admiral": the most significant rank word wins
  const words = w.length > 1 ? w.slice(0, -1) : w;
  const found = words.map(x => (RANK_MAP.find(([re]) => re.test(x)) || [])[1]).filter(Boolean);
  const rank = found.length ? RANK_ORDER.find(r => found.includes(r)) : null;
  const last = w[w.length - 1];
  return (rank && w.length > 1 ? `${rank} ${last}` : last).slice(0, 24);
}
/* Unit transfer: a general gives (or sells) units to another; they appear in the recipient's capital. */
const TRANSFER_MAX = 12;         // a general hands over at most this many units per summit
const TRANSFER_SHARE = 0.4;      // and at most this share of their army
const TYPE_WORDS = { inf: ['infantry', 'inf', 'soldiers', 'troops', 'infantryman', 'infantrymen'], tank: ['tank', 'tanks'], jet: ['fighter', 'fighters', 'jet', 'jets', 'fighter jet', 'fighter jets'], bomber: ['bomber', 'bombers'],
  trans: ['transport', 'transports', 'transport ship', 'transport ships'], dest: ['destroyer', 'destroyers'], bship: ['battleship', 'battleships'], sub: ['submarine', 'submarines', 'sub', 'subs', 'u-boat', 'u-boats'],
  carrier: ['carrier', 'carriers', 'aircraft carrier', 'aircraft carriers'], missile: ['missile', 'missiles', 'rocket', 'rockets'] };
const unitTypeOf = w => { const k = String(w || '').toLowerCase().trim(); return Object.keys(TYPE_WORDS).find(t => TYPE_WORDS[t].includes(k) || UNIT_TYPES[t].name.toLowerCase() === k) || null; };
/** Capital: the start city as long as it is held, otherwise the largest city. */
function capitalOf(s, p) {
  const c = s.capital && s.capital[p];
  if (c && c.owner === p && !c.gone) return c;
  let best = null; for (const x of s.cities) if (x.owner === p && (!best || x.pop > best.pop)) best = x;
  return best;
}
/** Carries out a transfer. want = { type: count }. Returns the units actually transferred per type. */
function transferUnits(s, p, q, want) {
  const done = {};
  if (s.out[p] || s.out[q] || p === q || s.dip.rel[p][q] === 'war') return done;   // nothing is transferred to war enemies
  const cap = capitalOf(s, q); if (!cap) return done;
  const port = cap.coastal ? cap : s.cities.find(c => c.owner === q && c.coastal);
  let budget = Math.min(TRANSFER_MAX, Math.floor(s.units.filter(u => u.owner === p).length * TRANSFER_SHARE));
  const inOwnCity = u => { const c = cityAt(s, u.x, u.y); return !!c && c.owner === p; };
  for (const [t, nRaw] of Object.entries(want)) {
    let n = Math.max(0, Math.floor(+nRaw || 0));
    const T = UNIT_TYPES[t]; if (!T || T.nuke) continue;
    const dest = T.domain === 'sea' ? port : cap; if (!dest) continue;   // ships need a port
    const pool = s.units.filter(u => u.owner === p && u.type === t && u.carrier == null && !(T.capacity && cargoOf(s, u).length))
      .sort((a, b) => inOwnCity(b) - inOwnCity(a));                     // units from the rear first, not from the front
    for (const u of pool) {
      if (!n || budget <= 0) break;
      u.owner = q; u.x = dest.x; u.y = dest.y; u.dest = null; u.moves = 0; u.sentry = false; u.repair = false;
      u.patrol = null; u.ferry = null; u.mission = false; u.garrison = false; u.siege = 0; if (T.fuel) u.fuel = T.fuel;
      done[t] = (done[t] || 0) + 1; n--; budget--;
    }
  }
  if (Object.keys(done).length) {
    s.ver++; computeVisibility(s, q); computeVisibility(s, p);
    if (s.transferLog) s.transferLog.push({ turn: s.turn, p, q, n: Object.values(done).reduce((a, b) => a + b, 0), done: { ...done } });
    const txt = Object.entries(done).map(([t, n]) => `${n}× ${UNIT_TYPES[t].name}`).join(', ');
    remember(s, p, `You transferred units to ${playerName(s, q)}: ${txt}.`);
    remember(s, q, `${playerName(s, p)} transferred units to you: ${txt}.`);
    logMsg(s, `TRANSFER: ${playerName(s, p)} transfers ${txt} to ${playerName(s, q)} (to the capital ${cap.x},${cap.y}).`);
    chatPost(s, -1, s.chat.rooms[0], `TRANSFER: ${gname(p)} transfers ${txt} to ${gname(q)}.`);
  }
  return done;
}

/** Request to general p: choose a name of their own. */
function namePrompt(s, p) {
  const per = PERSONAS[s.dip.persona[p]];
  const taken = s.dip.gname.filter(Boolean);
  return {
    system: `You are a general in the island war game "Mistcoast" and command the colour ${gname(p)}.\n${personality(s, p)}\nLANGUAGE: Write in English – the name, the motto and the greeting must all be in English.\nAnswer EXCLUSIVELY with a JSON object.`,
    prompt: `The game begins (modern era, modern military). Choose a SHORT name: an English military rank plus ONLY one invented, realistic-sounding English surname, e.g. "General Mercer" or "Colonel Hale" – no first name, no real person, no "von"/"de", at most 20 characters. ` +
      `Rank: one of ${RANKS.slice(p % RANKS.length).concat(RANKS.slice(0, p % RANKS.length)).slice(0, 3).join(', ')}.` +
      (taken.length ? ` Already taken: ${taken.join(', ')}.` : '') +
      `\nAnswer format: {"name":"…","motto":"your guiding principle in English, sober and modern, at most 8 words","greeting":"one short, matter-of-fact English sentence with which you introduce yourself in the World Council – in your manner of speaking, without pathos"}`,
  };
}

/** Adopt a name: cleaned, short, unique; introduction in the World Council. */
function setGeneralName(s, p, raw, greeting, force = true) {
  if (s.dip.gname[p]) return false;
  let n = String(raw || '').replace(/[^\p{L}\p{M} .'’-]/gu, '').replace(/\s+/g, ' ').trim();
  n = shortName(n.replace(/\s+(von|vom|van|de|del|of|zu)\s+\S+$/i, ''));   // short: rank + surname
  if (n.length < 2 || playerByName(s, n) >= 0 && PLAYER_NAMES.some(x => x.replace(/ \(you\)$/, '').toLowerCase() === n.toLowerCase())) return false;
  const dup = x => s.dip.gname.some(g => g && (g.toLowerCase() === x.toLowerCase() || g.split(' ').slice(-1)[0].toLowerCase() === x.split(' ').slice(-1)[0].toLowerCase()));
  if (dup(n)) { if (!force) return false; n = `${n} (${gname(p)})`; }   // same name or surname: let them choose again first
  s.dip.gname[p] = n;
  chatPost(s, -1, s.chat.rooms[0], `${gname(p)} is led by ${n}.`);
  if (greeting) chatPost(s, p, s.chat.rooms[0], greeting);
  return true;
}

/** All generals without a name choose one at the same time. Runs alongside the game without pausing it. */
async function nameGenerals(s, ask, onUpdate = () => {}) {
  for (let attempt = 0; attempt < 3; attempt++) {   // whoever gave no usable answer gets another attempt
    const gens = [...Array(s.players).keys()].filter(p => isGeneral(s, p) && !s.dip.gname[p]);
    if (!gens.length) return;
    await Promise.all(gens.map(p => Promise.resolve().then(() => ask(namePrompt(s, p))).then(t => {
      const o = parseGeneral(t);
      if (o && !s.out[p]) {
        if (setGeneralName(s, p, o.name, o.greeting, attempt === 2) && o.motto) s.dip.motto[p] = String(o.motto).replace(/\s+/g, ' ').trim().slice(0, 80);
        onUpdate();
      }
    }, () => {})));
  }
}

/** Turn 0: introduce all generals with name and description in the log. */
function announceGenerals(s) {
  s.log.push({ turn: 0, msg: `LINE-UP: ${[...Array(s.players).keys()].filter(p => isGeneral(s, p)).length} generals take command.` });
  for (let p = 0; p < s.players; p++) {
    if (!isGeneral(s, p)) continue;
    const per = PERSONAS[s.dip.persona[p]], t = s.dip.traits[p];
    s.log.push({ turn: 0, msg: `${gname(p)}: ${s.dip.gname[p] || 'General ' + gname(p)} – ${per.name}, ${per.stil}. Background: ${t.herkunft}. Quirk: ${t.marotte}. Weakness: ${t.schwaeche}.` +
      (s.dip.motto[p] ? ` Motto: "${s.dip.motto[p]}"` : '') + ` Bonus: ${ROLES[s.roles[p]].name}.` });
  }
  if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
}

/** Request to the war correspondent: summary of a conversation round (and, if given, of the summit outcome). */
function summaryPrompt(s, label, msgs, outcome) {
  const roomOf = m => s.chat.rooms.find(r => r.msgs.includes(m));
  const lines = msgs.map(m => { const r = roomOf(m);
    return `[${r ? (r.id === 0 ? 'World Council' : `private "${r.name}" (${r.members.map(gname).join(', ')})`) : '?'}] ${gname(m.from)}${s.dip.gname[m.from] ? ` (${s.dip.gname[m.from]})` : ''}: ${m.text}`; });
  return {
    system: 'You are a neutral war correspondent in the strategy game "Mistcoast" (modern era). You summarise for the spectator what the generals have just discussed – in public AND behind closed doors. '
      + 'LANGUAGE: Write in English – the summary and every highlight must be in English. Be concise and journalistic. Refer to generals by colour. Invent nothing. '
      + 'Answer EXCLUSIVELY with JSON: {"short":"at most 2 short sentences: the most important thing of this round","highlights":[{"art":"Betrayal|Alliance|Threat|Lie|Transfer|Breakup|Intrigue|Offer","text":"one concise sentence"}]} – at most 3 highlights, only real high points (betrayal, new alliance, harsh threat, public/private contradiction, transfer, breaking off talks); no highlights if nothing special happened.',
    prompt: `${label}\n\nMessages of this conversation round:\n${lines.join('\n') || '(none)'}` + (outcome ? `\n\nOutcome of the summit:\n${outcome}` : '')
      + '\n\nWrite the summary now, in English.',
  };
}

/** Extracts the JSON object from a model answer (even if it is wrapped in ```json … ```). */
function parseGeneral(text) {
  const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/** Start a summit: from now on all generals know each other (they sit at the same table). */
function startSummit(s) {
  const intro = !s.summitsDone;      // very first summit of the game: getting to know each other without decisions
  s.summit = { turn: s.turn, round: 0, rounds: PRIVATE_MAX + PUBLIC_ROUNDS, intro, phase: 'private', privRound: 0, pubRound: 0, last: false, dec: {}, target: {}, give: {}, transfers: [], orders: {}, errors: [] };
  // rooms with fewer than two living members close by themselves
  for (const r of s.chat.rooms) if (r.open && r.id > 0 && r.members.filter(m => !s.out[m]).length < 2) {
    chatPost(s, -1, r, 'The room is being closed: not enough members are left in the game.');
    r.open = false; r.closed = s.turn; r.closedBy = -1;
  }
  for (const row of s.dip.offer) row.fill(null);
  for (let p = 0; p < s.players; p++) for (let q = p + 1; q < s.players; q++)
    if (isGeneral(s, p) && isGeneral(s, q) && s.dip.rel[p][q] === 'none') { s.dip.rel[p][q] = s.dip.rel[q][p] = 'peace'; s.cver++; }
  logMsg(s, intro ? `FIRST MEETING (Turn ${s.turn}): the generals get to know each other and sound each other out – nothing is decided yet.`
    : `SUMMIT (Turn ${s.turn}): the generals negotiate in the World Council and in private rooms.`);
}

/** Apply general p's answer: open/close rooms, post messages, in the last round record decisions. */
function applyGeneral(s, p, o, final) {
  if (!o || typeof o !== 'object' || s.out[p]) return;
  if (o.name && !s.dip.gname[p]) setGeneralName(s, p, o.name);
  const list = v => (Array.isArray(v) ? v : []);
  for (const r of list(o.open_rooms).slice(0, 4)) if (r && typeof r === 'object') chatOpen(s, p, r.name, list(r.members));
  for (const n of list(o.close_rooms).slice(0, 3)) chatClose(s, p, n);
  for (const m of list(o.messages).slice(0, s.summit && s.summit.intro ? 4 : 3)) {
    if (!m || typeof m !== 'object') continue;
    const room = !m.room || /^(?:the\s+)?(?:world council|council)$/i.test(String(m.room).trim()) ? s.chat.rooms[0] : roomByName(s, m.room);
    if (room === s.chat.rooms[0] && s.summit && s.summit.phase === 'private') continue;   // World Council still closed
    chatPost(s, p, room, m.text);
  }
  if (o.note && s.summit.intro) s.dip.notes[p] = String(o.note).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (o.diary && typeof o.diary === 'object' && (final || s.summit.intro)) {
    const c = v => roundsToMeetings(s, String(v || '').replace(/\s+/g, ' ').trim()).slice(0, 400);
    const e = { turn: s.turn, goals: c(o.diary.goals), plan: c(o.diary.plan), review: c(o.diary.review) };
    if (e.goals || e.plan || e.review) { s.dip.journal[p].push(e); if (s.dip.journal[p].length > 40) s.dip.journal[p].shift(); }
  }
  if (o.reasoning && s.summit.intro) s.chat.reasons.push({ turn: s.turn, at: Date.now(), from: p, choice: 'First Meeting: impression',
    text: stripHeader(String(o.reasoning).replace(/\s+/g, ' ').trim()).slice(0, 600), seq: s.chat.seq = (s.chat.seq || 0) + 1 });
  if (!final) return;
  const dec = {};
  if (o.decisions && typeof o.decisions === 'object') for (const [name, v] of Object.entries(o.decisions)) {
    const q = playerByName(s, name), w = String(v).toLowerCase();
    if (q < 0 || q === p) continue;
    dec[q] = /\bwar\b/.test(w) ? 'war' : /alliance|\ball(?:y|ied)\b/.test(w) ? 'ally' : /peace/.test(w) ? 'peace' : undefined;
  }
  s.summit.dec[p] = dec;
  s.summit.give[p] = (Array.isArray(o.transfers) ? o.transfers : []).slice(0, 3).map(g => {
    if (!g || typeof g !== 'object') return null;
    const q = playerByName(s, g.to), want = {};
    if (g.units && typeof g.units === 'object') for (const [k, v] of Object.entries(g.units)) { const t = unitTypeOf(k); if (t) want[t] = (want[t] || 0) + (+v || 0); }
    return q >= 0 && q !== p ? { q, want } : null;
  }).filter(Boolean);
  if (o.note) s.dip.notes[p] = String(o.note).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (o.orders && typeof o.orders === 'object') {
    const b = o.orders, ord = s.dip.orders[p];
    const f = String(b.focus || '').toLowerCase().trim().replace(/^civil protection$/, 'protection');
    if (FOCI[f]) ord.focus = f;
    const h = String(b.stance || '').toLowerCase().trim();
    if (STANCES[h]) ord.stance = h;
    const tc = b.target_city == null ? null : cityByCoords(s, b.target_city);
    ord.city = tc && tc.owner !== p ? tc : null;
    ord.protect = (Array.isArray(b.protect) ? b.protect : [b.protect]).map(v => cityByCoords(s, v)).filter(c => c && c.owner === p).slice(0, 3);
    s.summit.orders[p] = { ...ord, protect: ord.protect.slice() };
  }
  if (o.reasoning) {
    const word = { war: 'War', ally: 'Alliance', peace: 'Peace' };
    const choice = ['war', 'ally', 'peace'].map(r => [r, Object.keys(dec).filter(q => dec[q] === r).map(q => gname(+q))])
      .filter(([, l]) => l.length).map(([r, l]) => `${word[r]}: ${l.join(', ')}`).join(' · ');
    s.chat.reasons.push({ turn: s.turn, at: Date.now(), from: p, choice, text: stripHeader(String(o.reasoning).replace(/\s+/g, ' ').trim()).slice(0, 600),
      seq: s.chat.seq = (s.chat.seq || 0) + 1 });
  }
  const t = o.target == null ? -1 : playerByName(s, o.target);
  s.summit.target[p] = t;
}

/**
 * Evaluate the summit. Pairs of two generals: war if one wants it; alliance only if both want it
 * (and the bloc stays small enough); otherwise peace. If a decision is missing (error, omission), the rule AI decides.
 * Pairs with the human go through the normal negotiation. Afterwards stalemate protection and attack targets.
 */
function finishSummit(s) {
  s.summitsDone = (s.summitsDone || 0) + 1;
  if (s.summit.intro) {               // getting to know each other: relations stay as they are
    s.pendingSummit = false; s.summitLast = s.summit; s.summit = null;
    return;
  }
  const pairs = [];
  for (let p = 0; p < s.players; p++) for (let q = p + 1; q < s.players; q++) if (!s.out[p] && !s.out[q]) pairs.push([p, q]);
  const want = (p, q) => (s.summit.dec[p] && s.summit.dec[p][q]) || aiStance(s, p, q, false);
  const plan = [];
  for (const [p, q] of pairs) {
    if (!isGeneral(s, p) || !isGeneral(s, q)) { if (s.dip.rel[p][q] !== 'none') negotiate(s, p, q, false); continue; }
    const a = want(p, q), b = want(q, p), cur = s.dip.rel[p][q];
    const r = a === 'war' || b === 'war' ? 'war' : a === 'ally' && b === 'ally' ? 'ally' : 'peace';
    if (r !== cur) plan.push(a === 'war' || b !== 'war' ? [p, q, r, cur] : [q, p, r, cur]);   // whoever wants the war declares it
  }
  // order: dissolve alliances first, then peace, then wars, new alliances last (which take over their partners' wars)
  const rank = ([, , r, cur]) => (cur === 'ally' ? 0 : r === 'peace' ? 1 : r === 'war' ? 2 : 3);
  for (const [p, q, r] of plan.sort((x, y) => rank(x) - rank(y))) {
    if (s.dip.rel[p][q] === r) continue;
    if (r === 'ally' && !canAlly(s, p, q)) continue;
    setRel(s, p, q, r);
  }
  // transfers: after the decisions, so nobody gives anything to a fresh war enemy
  for (const [ps, list] of Object.entries(s.summit.give)) for (const { q, want } of list) {
    const p = +ps, done = transferUnits(s, p, q, want);
    if (Object.keys(done).length) s.summit.transfers.push({ p, q, done });
  }
  // stalemate protection: if all cities are taken and there is no war anywhere, the rule AI renegotiates
  const alive = [...Array(s.players).keys()].filter(x => !s.out[x]);
  const anyWar = alive.some(a => alive.some(b => s.dip.rel[a][b] === 'war'));
  if (alive.length > 1 && !anyWar && !s.cities.some(c => c.owner < 0)) review(s);
  for (let p = 0; p < s.players; p++) {
    const t = s.summit.target[p];
    s.dip.target[p] = t != null && t >= 0 && !s.out[t] && hostile(s, p, t) ? t : -1;
  }
  const tg = alive.filter(p => s.dip.target[p] >= 0).map(p => `${gname(p)} → ${gname(s.dip.target[p])}`);
  if (tg.length && s.observer) logMsg(s, `SUMMIT TARGETS: ${tg.join(', ')}`);
  chatPost(s, -1, s.chat.rooms[0], `Summit ended. ${tg.length ? 'Attack targets: ' + tg.join(', ') + '.' : ''}`);
  s.pendingSummit = false; s.summitLast = s.summit; s.summit = null;
}

/**
 * Whole summit. ask({system, prompt}) returns the text answer (Promise). onUpdate() after every step (display).
 * The generals of one conversation round answer simultaneously; they only see in the next round what the others wrote.
 */
async function runSummit(s, ask, onUpdate = () => {}) {
  startSummit(s); onUpdate();
  const sm = s.summit;
  // after every conversation round the correspondent summarises – in the background, the summit does not wait for it
  const allMsgs = () => s.chat.rooms.flatMap(r => r.msgs).filter(m => m.from >= 0);
  let lastSeq = Math.max(0, ...allMsgs().map(m => m.seq || 0));
  const summarize = (label, outcome) => {
    const msgs = allMsgs().filter(m => (m.seq || 0) > lastSeq).sort((a, b) => a.seq - b.seq);
    lastSeq = Math.max(lastSeq, ...msgs.map(m => m.seq || 0));
    if (!msgs.length && !outcome) return;
    const turn = s.turn;
    Promise.resolve().then(() => ask(summaryPrompt(s, label, msgs, outcome))).then(t => {
      const o = parseGeneral(t), clean = v => String(v || '').replace(/[*#_`]/g, '').replace(/\s+/g, ' ').trim();
      const text = clean(o && o.short ? o.short : t).slice(0, 400);
      const highlights = (o && Array.isArray(o.highlights) ? o.highlights : []).slice(0, 3)
        .map(h => (h && typeof h === 'object' ? { art: clean(h.art).slice(0, 20), text: clean(h.text).slice(0, 200) } : { art: '', text: clean(h).slice(0, 200) }))
        .filter(h => h.text);
      if (text) { s.chat.summaries.push({ turn, at: Date.now(), label, text, highlights, seq: s.chat.seq = (s.chat.seq || 0) + 1 }); onUpdate(); }
    }, () => {});
  };
  const what = () => `${sm.intro ? 'First Meeting' : `Summit ${(s.summitsDone || 0) + 1}`} – ${sm.phase === 'private' ? `Back Room, round ${sm.privRound}` : `World Council, round ${sm.pubRound}`}`;
  const privateActivity = () => s.chat.rooms.reduce((a, r) => a + (r.id > 0 ? r.msgs.filter(m => m.from >= 0).length : 0), 0) + s.chat.rooms.length;
  const step = async () => {
    sm.round++; onUpdate();
    const gens = [...Array(s.players).keys()].filter(p => isGeneral(s, p));
    const res = await Promise.all(gens.map(p => Promise.resolve().then(() => ask(summitPrompt(s, p, sm.round)))
      .then(t => ({ p, o: parseGeneral(t), t }), e => ({ p, err: String(e && e.message || e) }))));
    for (const r of res) {
      if (r.err || !r.o) { sm.errors.push(`${gname(r.p)}: ${r.err || 'no valid answer'}`); continue; }
      applyGeneral(s, r.p, r.o, sm.last && !sm.intro);
    }
    onUpdate();
  };
  // 1. Back Room: private rooms only, up to PRIVATE_MAX rounds; ends earlier if nobody talks privately any more
  sm.phase = 'private';
  for (sm.privRound = 1; sm.privRound <= PRIVATE_MAX; sm.privRound++) {
    const before = privateActivity();
    await step();
    summarize(what());
    if (privateActivity() === before) break;
  }
  sm.privRound = Math.min(sm.privRound, PRIVATE_MAX);
  // 2. World Council: public; the decisions are made in the last round
  sm.phase = 'public';
  sm.rounds = sm.round + PUBLIC_ROUNDS;
  for (sm.pubRound = 1; sm.pubRound <= PUBLIC_ROUNDS; sm.pubRound++) {
    sm.last = sm.pubRound === PUBLIC_ROUNDS;
    await step();
    if (!sm.last) summarize(what());
  }
  sm.pubRound = PUBLIC_ROUNDS;   // after the loop the counter is one too high
  const lastLabel = what(), logFrom = s.log.length;
  finishSummit(s); onUpdate();
  // summarise the last round together with the outcome (wars, alliances, transfers, targets)
  const outcome = s.log.slice(Math.max(0, logFrom - 200)).filter(l => l.turn === s.turn && /WAR|ALLIANCE|PEACE|ends the alliance|TRANSFER|SUMMIT TARGETS/.test(l.msg)).map(l => l.msg).slice(-30).join('\n');
  summarize(`${lastLabel} (decision round)`, sm.intro ? '' : outcome || 'No changes to wars and alliances.');
}

/** May p negotiate with q right now (first contact or negotiation round)? */
const canNegotiate = (s, p, q) => s.dip.window[p][q] >= s.turn && !s.out[q] && s.dip.rel[p][q] !== 'none';

/**
 * Diplomatic action of the human towards computer q.
 * a: 'war' | 'peace' | 'ally' | 'leave' | 'accept' | 'reject'. Returns a feedback text.
 */
function diplomacyAction(s, q, a) {
  const p = 0, cur = s.dip.rel[p][q], offer = s.dip.offer[q][p], name = playerName(s, q);
  if (!canNegotiate(s, p, q)) return `You can only negotiate with ${name} in the next negotiation round.`;
  if (a === 'war' && cur !== 'war') { setRel(s, p, q, 'war'); return ''; }
  if (a === 'leave' && cur === 'ally') { setRel(s, p, q, 'peace'); return ''; }
  if (a === 'reject') { s.dip.offer[q][p] = null; return `You reject the offer from ${name}.`; }
  const tooBig = `Alliance not possible: a bloc comprises at most ${MAX_BLOC} parties, and nobody may be allied with a war enemy of their partner.`;
  if (a === 'accept' && offer) {
    if (offer === 'ally' && !canAlly(s, p, q)) return tooBig;
    setRel(s, p, q, offer); return '';
  }
  if (a === 'peace' && cur === 'war') {
    if (aiStance(s, q, p, false) !== 'war') { setRel(s, p, q, 'peace'); return ''; }
    return `${name} rejects peace.`;
  }
  if (a === 'ally' && cur !== 'ally' && cur !== 'war') {
    if (!canAlly(s, p, q)) return tooBig;
    if (aiStance(s, q, p, false) === 'ally') { setRel(s, p, q, 'ally'); return ''; }
    return `${name} rejects an alliance.`;
  }
  return '';
}

/* ---------- Movement & attack ---------- */

const who = (s, u) => me(s, u.owner) ? 'Your ' + UNIT_TYPES[u.type].name
  : `Enemy ${UNIT_TYPES[u.type].name} (${PLAYER_NAMES[u.owner]})`;

function spend(s, u, cost = 1) {
  u.moves = Math.max(0, u.moves - cost); // difficult terrain may still be entered with the last move
  if (UNIT_TYPES[u.type].domain === 'air') u.fuel--;
}

function settle(s, u) {
  // after every action: check fuel, update vision
  const T = UNIT_TYPES[u.type];
  if (!u.dead && T.fuel) {
    const c = cityAt(s, u.x, u.y);
    if ((c && c.owner === u.owner) || u.carrier != null) u.fuel = T.fuel;   // refuel in the city or on the carrier
    else if (u.fuel <= 0) {
      if (me(s, u.owner)) logMsg(s, `Your ${T.name} ran out of fuel and crashed.`);
      removeUnit(s, u);
    }
  }
  // after a move only reveal the unit's surroundings; the full recomputation follows at the start of the turn
  if (!u.dead) reveal(s, u.owner, u.x, u.y, visionOf(s, u));
}

/** Moves/attacks onto a neighbouring tile. Result: moved | boarded | captured | won | lost | bombed | blocked */
function moveUnit(s, u, tx, ty) {
  const r = moveUnitRaw(s, u, tx, ty);
  if (r !== 'blocked') s.ver++;   // positions have changed: rebuild the occupancy map
  return r;
}

function moveUnitRaw(s, u, tx, ty) {
  const T = UNIT_TYPES[u.type];
  tx = wx(tx); ty = wy(ty); // a target beyond the edge lands on the other side
  if (s.winner != null || u.dead || u.moves <= 0 || cheb(u.x, u.y, tx, ty) !== 1) return 'blocked';
  u.repair = false; // whoever moves or fights aborts the repair
  const i = ty * s.W + tx, water = !s.terrain[i];
  const here = unitsAt(s, tx, ty);
  const others = here.filter(o => o.owner !== u.owner);
  const enemies = others.filter(o => hostile(s, u.owner, o.owner));
  const city = cityAt(s, tx, ty);
  const notAtWar = q => {   // foreign unit or city, but no war: the tile stays blocked
    if (me(s, u.owner)) logMsg(s, `Relation with ${playerName(s, q)}: ${REL_NAME[s.dip.rel[u.owner][q]]}. Fighting is only possible after a declaration of war (at first contact or in the negotiation round every ${REVIEW_EVERY} turns).`);
    return 'blocked';
  };
  if (others.length && !enemies.length) return notAtWar(others[0].owner);
  if (city && city.owner >= 0 && city.owner !== u.owner && !hostile(s, u.owner, city.owner)) return notAtWar(city.owner);

  if (enemies.length) {
    if (T.att <= 0) return 'blocked';
    if (T.domain === 'land' && water) return 'blocked';
    if (T.domain === 'sea' && !water) return 'blocked';
    if (u.type !== 'dest' && enemies.every(o => submerged(s, o))) {   // only a destroyer can fight submerged submarines
      if (me(s, u.owner)) logMsg(s, `Tile (${tx},${ty}) is blocked: an enemy submarine lurks there. Only destroyers can attack it.`);
      return 'blocked';
    }
    const d = enemies.reduce((a, b) => (b.hp > a.hp ? b : a));
    spend(s, u);
    const cover = !city && !water && UNIT_TYPES[d.type].domain === 'land' ? groundAt(s, tx, ty).cover : 1;
    const attBonus = attackBonus(s, u.owner, u.type);
    const win = fight(u, d, { cityDef: city ? CITY_KINDS[city.kind].def : 1, cover, attBonus });
    if (me(s, u.owner) || me(s, d.owner))
      logMsg(s, win ? `${who(s, u)} destroys ${who(s, d).replace(/^Y/, 'y').replace(/^E/, 'e')}.`
                    : `${who(s, d)} repels ${who(s, u).replace(/^Y/, 'y').replace(/^E/, 'e')}.`);
    removeUnit(s, win ? d : u);
    if (!win && city) damageCity(s, city, 0.05, 0.10, u.owner); // the city holds: 5–10 % losses
    else if (city && T.domain === 'air') damageCity(s, city, 0.02, 0.04, u.owner);   // an air strike on the garrison also hits civilians
    settle(s, u);
    return win ? 'won' : 'lost';
  }

  if (city && city.owner !== u.owner) {
    if (u.type === 'bomber' && city.owner >= 0) {   // bombing: destroys production, ends the bomber's turn
      spend(s, u); u.moves = 0;
      if (me(s, u.owner)) logMsg(s, `Your bomber bombs the city (${tx},${ty}).`);
      else if (me(s, city.owner)) logMsg(s, `Enemy bombers are attacking your city (${tx},${ty})!`);
      damageCity(s, city, 0.05, 0.10, u.owner);
      settle(s, u);
      return 'bombed';
    }
    if (T.domain !== 'land') return 'blocked';
    spend(s, u);
    if (city.owner === -1) {
      const militia = { type: 'inf', hp: 1, owner: -1 };
      if (!fight(u, militia, { cityDef: CITY_KINDS[city.kind].militia, cover: 1, attBonus: attackBonus(s, u.owner, u.type) })) {   // militia: weaker than a real garrison
        if (me(s, u.owner)) logMsg(s, `${who(s, u)} is repelled by the city militia.`);
        damageCity(s, city, 0.05, 0.10, u.owner);
        removeUnit(s, u); settle(s, u);
        return 'lost';
      }
    }
    const prev = city.owner;
    if (prev >= 0 && s.dip.lost) s.dip.lost[prev][u.owner]++;
    city.owner = u.owner; city.prod = 'inf'; city.progress = 0; s.cver++;
    u.carrier = null; u.x = tx; u.y = ty; u.dest = null;
    if (s.observer) logMsg(s, `${playerName(s, u.owner)} takes City (${tx},${ty})${prev >= 0 ? ' from ' + playerName(s, prev) : ''}.`);
    if (me(s, u.owner)) logMsg(s, `City at (${tx},${ty}) conquered!`);
    else if (me(s, prev)) logMsg(s, `The enemy has conquered your city at (${tx},${ty})!`);
    damageCity(s, city, 0.10, 0.20, me(s, prev) ? 0 : u.owner);   // the city falls: 10–20 % damage
    if (prev >= 0) enforceSupply(s, prev);                       // whoever loses a city can supply fewer troops
    checkWinner(s); settle(s, u);
    return 'captured';
  }

  if (T.domain === 'land') {
    if (water) {
      const tr = here.find(o => o.type === 'trans' && cargoOf(s, o).length < UNIT_TYPES.trans.capacity);
      if (!tr) return 'blocked';
      u.carrier = tr.id; u.x = tx; u.y = ty; u.moves = 0; u.dest = null;
      settle(s, u);
      return 'boarded';
    }
    if (here.length && !city) return 'blocked';
  } else {
    if (T.domain === 'air' && !city) {   // landing on an own carrier
      const deck = here.find(o => o.type === 'carrier' && cargoOf(s, o).length < UNIT_TYPES.carrier.capacity);
      if (deck) {
        u.carrier = deck.id; u.x = tx; u.y = ty; u.moves = 0; u.dest = null;
        settle(s, u);
        return 'boarded';
      }
    }
    if (T.domain === 'sea' && !water && !city) return 'blocked';
    if (here.length && !city) return 'blocked';
  }
  const cost = T.domain === 'land' ? moveCost(s, u.type, tx, ty) : 1;
  if (cost === Infinity) return 'blocked';
  u.carrier = null; u.x = tx; u.y = ty;
  spend(s, u, cost);
  if (T.capacity) {
    for (const c of cargoOf(s, u)) { c.x = tx; c.y = ty; if (city) c.carrier = null; } // unloading in port
  }
  settle(s, u);
  return 'moved';
}

/* ---------- Missiles ---------- */

const MISSILE_DAMAGE = [0.15, 0.25];   // a hit randomly destroys 15–25 % of the city's production

/** Other players' cities within range of this missile. */
function missileTargets(s, u) {
  const R = UNIT_TYPES[u.type].range || 0;
  return s.cities.filter(c => c.owner >= 0 && hostile(s, u.owner, c.owner) && cheb(c.x, c.y, u.x, u.y) <= R);
}

/** Wipes out a city completely: all units in it die, the city disappears from the map. */
function removeCity(s, city) {
  for (const u of s.units) {
    if (u.x !== city.x || u.y !== city.y) continue;
    u.dead = true;                                     // cargo on board too (stands on the same tile)
  }
  s.units = s.units.filter(u => !u.dead); s.ver++;
  const i = city.y * s.W + city.x;
  s.cities.splice(s.cities.indexOf(city), 1);
  s.cityIdx.fill(-1);                                  // reassign city numbers, otherwise they point to the wrong city
  s.cities.forEach((c, k) => { c.id = k; s.cityIdx[c.y * s.W + c.x] = k; });
  s.ground[i] = 4;                                     // a crater remains
  city.gone = true; city.owner = -1; city.cap = 0; s.cver++;     // in case someone still holds the old object (AI target, selection)
  checkWinner(s);
}

/** Fires a missile or nuke at a city. The weapon is used up afterwards. Returns true on success. */
function fireMissile(s, u, city) {
  const T = UNIT_TYPES[u.type];
  if (s.winner != null || u.dead || !T.range || !city || !missileTargets(s, u).includes(city)) return false;
  if (T.nuke) {
    const victim = city.owner, lost = s.units.filter(o => o.x === city.x && o.y === city.y).length;
    const where = `(${city.x},${city.y})`, tail = lost ? ` ${lost} unit${lost === 1 ? '' : 's'} annihilated.` : '';
    if (s.observer) logMsg(s, `NUCLEAR STRIKE: ${playerName(s, u.owner)} wipes out City ${where} of ${playerName(s, victim)}.${tail}`);
    else if (me(s, u.owner)) logMsg(s, `NUCLEAR STRIKE: Your nuke wipes out the city ${where} of ${playerName(s, victim)}.${tail}`);
    else if (me(s, victim)) logMsg(s, `NUCLEAR STRIKE: ${playerName(s, u.owner)} wipes out your city ${where}!${tail}`);
    else logMsg(s, `NUCLEAR STRIKE: ${playerName(s, u.owner)} wipes out a city of ${playerName(s, victim)}.`);
    s.missiles.nukes[u.owner]++; s.missiles.nuked[victim]++; s.missiles.destroyed[u.owner] += city.cap;
    removeUnit(s, u);
    removeCity(s, city);
    return true;
  }
  if (s.observer) logMsg(s, `${playerName(s, u.owner)} fires a missile at City (${city.x},${city.y}) of ${playerName(s, city.owner)}.`);
  else if (me(s, u.owner)) logMsg(s, `Your missile hits the city (${city.x},${city.y}) of ${playerName(s, city.owner)}.`);
  else if (me(s, city.owner)) logMsg(s, `A missile from ${playerName(s, u.owner)} hits your city (${city.x},${city.y})!`);
  const before = city.cap;
  damageCity(s, city, MISSILE_DAMAGE[0], MISSILE_DAMAGE[1], u.owner);
  s.missiles.fired[u.owner]++; s.missiles.taken[city.owner]++; s.missiles.destroyed[u.owner] += before - city.cap;
  removeUnit(s, u);
  return true;
}

/* ---------- Pathfinding ---------- */

/** Occupancy map (top unit per tile). Cached until a unit moves. */
function occupancy(s) {
  if (s._occ && s._occVer === s.ver) return s._occ;
  const occ = new Array(s.W * s.H).fill(null);
  for (const u of s.units) if (u.carrier == null) { const i = u.y * s.W + u.x; if (!occ[i]) occ[i] = u; }
  s._occ = occ; s._occVer = s.ver;
  return occ;
}

function passable(s, u, x, y, occ) {
  const i = y * s.W + x, city = cityAt(s, x, y), land = s.terrain[i] === 1;
  if (city) return city.owner === u.owner;
  const d = UNIT_TYPES[u.type].domain;
  if (d === 'land' && (!land || moveCost(s, u.type, x, y) === Infinity)) return false;
  if (d === 'sea' && land) return false;
  return !occ[i];
}

/**
 * Reusable buffers for the breadth-first search: neighbour table (with map wrap-around already included),
 * coordinates per tile and a "visited in search no." mark, so nothing has to be allocated per search.
 */
function pathBuffers(s) {
  if (s._pb) return s._pb;
  const N = s.W * s.H, nb = new Int32Array(N * 8), xs = new Uint16Array(N), ys = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % s.W, y = (i - x) / s.W;
    xs[i] = x; ys[i] = y;
    for (let k = 0; k < 8; k++) nb[i * 8 + k] = wy(y + DIRS[k][1]) * s.W + wx(x + DIRS[k][0]);
  }
  s._pb = { nb, xs, ys, mark: new Uint32Array(N), gen: 0, prev: new Int32Array(N), dist: new Int32Array(N), q: new Int32Array(N) };
  return s._pb;
}

/** Breadth-first search. goalFn(x,y,occ) decides what a goal is. Returns the first step + distance or null. */
function findPath(s, u, goalFn) {
  const W = s.W, occ = occupancy(s), start = u.y * W + u.x;
  if (goalFn(u.x, u.y, occ)) return { dist: 0, x: u.x, y: u.y, gx: u.x, gy: u.y };
  const pb = pathBuffers(s), { nb, xs, ys, mark, prev, dist, q } = pb;
  if (++pb.gen >= 0xfffffff0) { mark.fill(0); pb.gen = 1; }
  const gen = pb.gen;
  mark[start] = gen; prev[start] = start; dist[start] = 0;
  let head = 0, tail = 0;
  q[tail++] = start;
  while (head < tail) {
    const c = q[head++];
    for (let k = 0; k < 8; k++) {
      const i = nb[c * 8 + k];
      if (mark[i] === gen) continue;
      mark[i] = gen;   // goal and passability don't depend on where one comes from: check each tile only once
      const x = xs[i], y = ys[i];
      const goal = goalFn(x, y, occ);
      if (!goal && !passable(s, u, x, y, occ)) continue;
      prev[i] = c; dist[i] = dist[c] + 1;
      if (goal) {
        let j = i;
        while (prev[j] !== start) j = prev[j];
        return { dist: dist[i], x: xs[j], y: ys[j], gx: x, gy: y };
      }
      q[tail++] = i;
    }
  }
  return null;
}

/** Carries out a multi-turn order (u.dest) as far as possible. */
function followDest(s, u) {
  let guard = 0;
  while (!u.dead && u.dest && u.moves > 0 && guard++ < 20) {
    const d = u.dest;
    if (u.x === d.x && u.y === d.y) { u.dest = null; break; }
    const p = findPath(s, u, (x, y) => x === d.x && y === d.y);
    if (!p) { u.dest = null; break; }
    const r = moveUnit(s, u, p.x, p.y);
    if (r !== 'moved') { u.dest = null; break; }
  }
  if (!u.dead && u.dest && u.x === u.dest.x && u.y === u.dest.y) u.dest = null;
}

/* ---------- Turn sequence ---------- */

// switch: nukes are currently disabled (neither human nor computer can build them)
const NUKES_ENABLED = false;
function canBuild(city, type) {
  if (type === GROW) return true;
  if (UNIT_TYPES[type].nuke && !NUKES_ENABLED) return false;
  return UNIT_TYPES[type].domain !== 'sea' || city.coastal;
}

function startTurn(s, p) {
  for (const u of s.units) {
    if (u.owner !== p) continue;
    const T = UNIT_TYPES[u.type];
    u.moves = movesOf(s, u); u.skip = false;
    const c = cityAt(s, u.x, u.y);
    if (T.fuel && ((c && c.owner === p) || u.carrier != null)) u.fuel = T.fuel;
  }
  // repairs take priority: they occupy a share of this turn's city capacity
  const used = new Map();
  for (const u of s.units) {
    if (u.owner !== p || !u.repair) continue;
    if (!canRepair(s, u)) { u.repair = false; continue; }
    const share = REPAIR_SHARE[u.type];
    const c = s.cities.find(c => c.owner === p && cheb(c.x, c.y, u.x, u.y) <= 1 && (used.get(c) || 0) + share <= 1 + 1e-9);
    if (!c) continue;                       // shipyard fully booked: stays in the queue
    used.set(c, (used.get(c) || 0) + share);
    u.hp = UNIT_TYPES[u.type].hp; u.repair = false;
    if (me(s, p)) logMsg(s, `City (${c.x},${c.y}): ${UNIT_TYPES[u.type].name} repaired (${fmt(share * c.cap)} PP).`);
  }
  enforceSupply(s, p);
  const sup = supply(s, p);   // the troops are supplied first, only the rest is available to the cities
  for (const c of s.cities) {
    if (c.owner !== p) continue;
    const rep = Math.min(1, used.get(c) || 0);
    const free = (1 - rep) * sup.free;            // rest of the turn for building/Civil Protection
    if (!canBuild(c, c.prod)) c.prod = 'inf';
    // population balance with the production at the start of the turn: repair and building cost workers, supply drains
    popTick(s, c, c.cap * (rep + (c.prod === GROW ? 0 : free)), c.cap * (1 - rep) * (1 - sup.free));
    if (c.prod === GROW) { growCity(s, c, free); continue; }
    c.progress += c.cap * free;
    const cost = unitCost(s, p, c.prod);
    if (c.progress >= cost) {
      const left = c.progress - cost;          // unused PP of this turn ...
      c.progress = 0;
      spawn(s, c.prod, p, c.x, c.y);
      if (left > 0) growCity(s, c, left / c.cap); // ... flow proportionally into growth
      if (me(s, p)) logMsg(s, `City (${c.x},${c.y}): ${UNIT_TYPES[c.prod].name} completed.`);
    }
  }
  enforceSupply(s, p);        // population losses this turn may have lowered production
  for (let q = 0; q < s.players; q++) computeVisibility(s, q);
  detectContacts(s, p);
}

/** Passes the turn to the next living player. */
function endTurn(s) {
  const prev = s.current;
  let n = 0;
  do { s.current = (s.current + 1) % s.players; } while (s.out[s.current] && ++n < s.players);
  if (s.current <= prev) {           // once around: new turn (even if player 0 is out)
    s.turn++;
    if (s.hist) {                    // history for the charts: units, cities, score, population, PP, supply
      const P = s.players, u = new Array(P).fill(0), c = new Array(P).fill(0), pop = new Array(P).fill(0), pe = new Array(P).fill(0), need = new Array(P).fill(0);
      for (const x of s.units) { u[x.owner]++; need[x.owner] += unitUpkeep(s, x.owner, x.type); }
      for (const x of s.cities) if (x.owner >= 0) { c[x.owner]++; pop[x.owner] += x.pop; pe[x.owner] += x.cap; }
      const sc = u.map((_, p) => (s.out[p] ? 0 : Math.round(c[p] * 10 + pe[p] * 5 + u[p])));
      s.hist.push({ t: s.turn, u, c, sc, pop: pop.map(v => Math.round(v / 1e4) / 100), pe: pe.map(v => Math.round(v * 10) / 10),
        sup: pe.map((v, p) => (v > 0 ? Math.round(need[p] / v * 100) : 0)) });
    }
    warAllowed(s);                   // announces the start of the war phase as soon as it is time
    if (s.turn % REVIEW_EVERY === 0) { if (s.generals) s.pendingSummit = true; else review(s); }
  }
  startTurn(s, s.current);
}

function endHumanTurn(s) {
  if (s.winner != null) return;
  endTurn(s);
  while (s.current !== 0 && s.winner == null) { runAI(s, s.current); if (s.winner == null) endTurn(s); }
  if (s.winner != null) return;
  for (const u of s.units.slice()) if (me(s, u.owner) && u.dest && !u.dead) followDest(s, u);
}

/** Observer mode: all players are computers. Plays exactly one full turn. */
function observerRound(s) {
  const t = s.turn;
  for (let g = 0; s.winner == null && s.turn === t && g < s.players + 1; g++) {
    runAI(s, s.current);
    if (s.winner == null) endTurn(s);
  }
}

/* ---------- AI ---------- */

/** Islands with attackable cities. Cached until city ownership or diplomacy change (s.cver). */
/* A general's orders to their army (valid until the next summit). */
const FOCI = { land: 'Land', sea: 'Sea', air: 'Air', missiles: 'Missiles', protection: 'Civil Protection', balanced: 'balanced' };
const STANCES = { offensive: 'offensive', defensive: 'defensive', normal: 'normal' };
const ordersOf = (s, p) => (s.dip && s.dip.orders && s.dip.orders[p]) || { focus: 'balanced', stance: 'normal', city: null, protect: [] };
/** Target city from the orders, provided it still exists and may be attacked. */
const aiTargetCity = (s, p) => { const c = ordersOf(s, p).city; return c && !c.gone && c.owner !== p && hostile(s, p, c.owner) ? c : null; };
const isProtected = (s, p, c) => ordersOf(s, p).protect.includes(c) && c.owner === p;
/** City for coordinates like "12,34" or "(12,34)". */
function cityByCoords(s, v) {
  const m = String(v || '').match(/(\d+)\s*[,;/ ]\s*(\d+)/);
  return m ? cityAt(s, +m[1], +m[2]) : null;
}

/** Agreed attack target of p (summit of the generals), if still valid; otherwise -1. */
const aiTarget = (s, p) => { const t = s.dip && s.dip.target ? s.dip.target[p] : -1; return t >= 0 && !s.out[t] && hostile(s, p, t) ? t : -1; };

function targetLands(s, p) {
  const tgt = aiTarget(s, p), tc = aiTargetCity(s, p);
  const key = p + ':' + s.cver + ':' + tgt + ':' + (tc ? tc.id : -1);
  if (s._tl && s._tlKey === key) return s._tl;
  const set = new Set();
  for (const c of s.cities) if (hostile(s, p, c.owner)) set.add(s.landId[c.y * s.W + c.x]);
  const mineL = new Set(s.cities.filter(c => c.owner === p).map(c => s.landId[c.y * s.W + c.x]));
  if (tc) {
    // target city: invasions only onto its island; enemies on own islands keep being fought
    const l = s.landId[tc.y * s.W + tc.x];
    const focus = new Set([...set].filter(x => mineL.has(x) || x === l));
    if (focus.has(l)) { s._tl = focus; s._tlKey = key; return focus; }
  }
  if (tgt >= 0) {
    // attack target: invasions only against the target's islands; enemies on own islands keep being fought
    const focus = new Set([...set].filter(l => mineL.has(l) || s.cities.some(c => c.owner === tgt && s.landId[c.y * s.W + c.x] === l)));
    if ([...focus].some(l => !mineL.has(l))) { s._tl = focus; s._tlKey = key; return focus; }
  }
  s._tl = set; s._tlKey = key;
  return set;
}

function aiProduction(s, p, city, targets) {
  const mine = s.units.filter(u => u.owner === p);
  const count = t => mine.filter(u => u.type === t).length;
  const nCities = s.cities.filter(c => c.owner === p).length;
  const r = Math.random();
  // grow occasionally; almost exclusively when supply is tight, because more capacity carries more troops
  const role = roleKey(s, p);   // the AI plays to its bonus: more of what it gets cheaper
  const canGrow = city.cap < capMax(s, city) * 0.97;   // don't grow cities that are almost at their cap
  if (canGrow && (Math.random() < (role === 'prod' ? 0.2 : 0.1) || (supply(s, p).free < 0.35 && Math.random() < 0.8))) return GROW;
  // the general's orders: protected cities build replacement defenders
  const ord = ordersOf(s, p);
  if (isProtected(s, p, city) && unitsAt(s, city.x, city.y).filter(u => u.owner === p && UNIT_TYPES[u.type].domain === 'land').length < 2) return 'inf';
  // sea lift has priority: land troops stuck on islands without a target need transports.
  // Otherwise dozens of units pile up in port and the game never gets off the start island.
  const lid = s.landId[city.y * s.W + city.x], onTarget = targets.has(lid);
  const waiting = mine.filter(u => u.carrier == null && !u.garrison && UNIT_TYPES[u.type].domain === 'land' &&
    !targets.has(s.landId[u.y * s.W + u.x])).length;
  const transCap = Math.max(2, Math.ceil(nCities / 2), Math.min(6, Math.ceil(waiting / T_CAP)));
  if (!onTarget && city.coastal && count('trans') < Math.min(Math.ceil(waiting / T_CAP) + 1, transCap)) return 'trans';
  const glut = waiting >= 2 * T_CAP + count('trans') * T_CAP;   // more waiting than the fleet can ever ship across
  if (!onTarget && glut) return city.coastal ? (count('trans') < transCap ? 'trans' : Math.random() < 0.5 ? 'dest' : 'trans') : canGrow ? GROW : 'jet';
  // the general's armament focus
  if (ord.focus !== 'balanced' && Math.random() < 0.75) {   // three out of four orders follow the focus
    if (ord.focus === 'protection' && canGrow) return GROW;
    if (ord.focus === 'missiles' && count('missile') < Math.max(2, nCities)) return 'missile';
    if (ord.focus === 'air' && nCities >= 1) return Math.random() < 0.4 ? 'bomber' : 'jet';
    if (ord.focus === 'sea' && city.coastal) { const q = Math.random(); return q < 0.3 ? 'dest' : q < 0.5 ? 'sub' : q < 0.65 ? 'bship' : q < 0.8 ? 'carrier' : 'trans'; }
    if (ord.focus === 'land') return Math.random() < 0.55 ? 'tank' : 'inf';
  }
  // air force and navy cost a lot of supply and conquer nothing: both stay small
  const wantJet = nCities >= 2 && count('jet') + count('bomber') < Math.ceil(nCities / (role === 'air' ? 2 : 3));
  const air = () => (Math.random() < 0.3 ? 'bomber' : 'jet');   // roughly every third aircraft is a bomber
  // missiles: occasionally, when another player's city is within range
  // nuke: very rarely and only for larger empires, it costs as much as ten infantry
  if (NUKES_ENABLED && Math.random() < 0.015 && count('nuke') < 1 && nCities >= 5 &&
      s.cities.some(c => c.owner >= 0 && hostile(s, p, c.owner) && cheb(c.x, c.y, city.x, city.y) <= UNIT_TYPES.nuke.range)) return 'nuke';
  if (Math.random() < 0.06 && count('missile') < 2 &&
      s.cities.some(c => c.owner >= 0 && hostile(s, p, c.owner) && cheb(c.x, c.y, city.x, city.y) <= UNIT_TYPES.missile.range)) return 'missile';
  const wantShip = count('dest') + count('bship') + count('sub') < Math.floor(nCities / (role === 'navy' ? 3 : 5));
  if (onTarget) {
    // only neutral cities on the island: cheap infantry that also gets through the mountains.
    // If another player is on the island, tanks and air support are needed.
    const rival = s.cities.some(c => c.owner >= 0 && hostile(s, p, c.owner) && s.landId[c.y * s.W + c.x] === lid);
    if (!rival) return r < 0.85 ? 'inf' : 'tank';
    return wantJet && r > 0.85 ? air() : r < 0.4 ? 'inf' : 'tank';
  }
  if (!city.coastal) return wantJet && r > 0.75 ? air() : r < 0.45 ? 'inf' : 'tank';
  if (wantJet && r > 0.8) return air();
  if (wantShip && r > 0.6) return r > 0.9 ? 'bship' : r > 0.78 ? 'sub' : 'dest';
  return r < 0.3 ? 'inf' : 'tank';
}

function runAI(s, p) {
  const targets = targetLands(s, p);
  for (const c of s.cities) if (c.owner === p && c.progress === 0) c.prod = aiProduction(s, p, c, targets);
  const order = { land: 0, sea: 1, air: 2 };
  const mine = s.units.filter(u => u.owner === p)
    // land before sea before air; within a group the strongest attackers first (tanks break in, infantry follows)
    .sort((a, b) => order[UNIT_TYPES[a.type].domain] - order[UNIT_TYPES[b.type].domain] || UNIT_TYPES[b.type].att - UNIT_TYPES[a.type].att);
  for (const u of mine) {
    if (u.type === 'trans' && !u.mission) u.wait = cargoOf(s, u).length ? u.wait + 1 : 0;
    if (UNIT_TYPES[u.type].range) {   // fire missiles and nukes immediately at the most productive city in range
      const tg = aiTarget(s, p);   // agreed target first, then the most productive city
      const tcm = aiTargetCity(s, p);
      const t = missileTargets(s, u).sort((a, b) => (b === tcm) - (a === tcm) || (b.owner === tg) - (a.owner === tg) || b.cap - a.cap)[0];
      if (t && (t.cap > MIN_CAP * 1.5 || UNIT_TYPES[u.type].nuke)) fireMissile(s, u, t);
      continue;
    }
    if (canRepair(s, u)) { u.repair = true; continue; } // damaged and near a city: repair instead of moving
    let guard = 0;
    while (!u.dead && u.moves > 0 && s.winner == null && guard++ < 12) {
      if (!aiStep(s, p, u)) break;
    }
  }
}

const T_CAP = UNIT_TYPES.trans.capacity;
const AI_MIN_ASSAULT = 3;       // the AI gathers at least this many land units before storming a city
const AI_SIEGE_PATIENCE = 8;    // after this many turns of waiting a unit attacks anyway
const AI_FULL_LOAD_WAIT = 6;    // a transport waits this long for a full load

/** A city is threatened if another player's city lies nearby or enemies are in sight. */
function aiThreatened(s, p, c) {
  if (s.cities.some(o => o.owner >= 0 && hostile(s, p, o.owner) && cheb(o.x, o.y, c.x, c.y) <= 9)) return true;
  const vis = s.visible[p];
  return s.units.some(o => hostile(s, p, o.owner) && o.carrier == null && vis[o.y * s.W + o.x] && cheb(o.x, o.y, c.x, c.y) <= 5);
}

function aiGo(s, u, path) {
  if (!path || path.dist === 0) return false;
  const r = moveUnit(s, u, path.x, path.y);
  return r !== 'blocked';
}

function aiStep(s, p, u) {
  const T = UNIT_TYPES[u.type], W = s.W, vis = s.visible[p];
  const targets = targetLands(s, p);
  // a target is only what this unit sees and is allowed to fight (submerged submarines: destroyers only)
  const enemyAt = (x, y, occ) => {
    const o = occ[y * W + x];
    return o && hostile(s, p, o.owner) && canSee(s, p, o) && (u.type === 'dest' || !submerged(s, o)) ? o : null;
  };

  if (T.domain === 'land') {
    if (u.carrier != null) {
      // on board: go ashore as soon as a target island is adjacent
      let fallback = null;
      for (const [dx, dy] of DIRS) {
        const x = wx(u.x + dx), y = wy(u.y + dy);
        if (!s.terrain[y * W + x] || !targets.has(s.landId[y * W + x]) || moveCost(s, u.type, x, y) === Infinity) continue;
        const c = cityAt(s, x, y);
        if (c && hostile(s, p, c.owner)) return moveUnit(s, u, x, y) !== 'blocked';
        if (!fallback) fallback = [x, y];
      }
      return fallback ? moveUnit(s, u, fallback[0], fallback[1]) !== 'blocked' : false;
    }
    // garrison: exactly one land unit stays behind in a threatened own city
    const here = cityAt(s, u.x, u.y);
    if (here && here.owner === p) {
      // how many stay? protected cities 2, threatened 1, with a defensive stance every city at least 1
      const keep = isProtected(s, p, here) ? 2 : aiThreatened(s, p, here) || ordersOf(s, p).stance === 'defensive' ? 1 : 0;
      if (keep) {
        const holders = s.units.filter(o => o.owner === p && o.garrison && o.x === u.x && o.y === u.y);
        if (holders.includes(u) && holders.length <= keep) return false;
        if (holders.length < keep) { u.garrison = true; return false; }
      }
    }
    u.garrison = false;

    const tcity = aiTargetCity(s, p);
    let path = tcity && s.landId[tcity.y * W + tcity.x] === s.landId[u.y * W + u.x]
      ? findPath(s, u, (x, y, occ) => (x === tcity.x && y === tcity.y) || (cheb(x, y, tcity.x, tcity.y) <= 2 && s.terrain[y * W + x] === 1 && !!enemyAt(x, y, occ)))
      : null;   // target city on this island: head straight for it, enemies along the way are taken out
    if (!path) path = findPath(s, u, (x, y, occ) => {
      const c = cityAt(s, x, y);
      if (c) return hostile(s, p, c.owner);
      return s.terrain[y * W + x] === 1 && !!enemyAt(x, y, occ);
    });
    if (path) {
      // gather before the assault: attack other players' cities only once enough own troops are ready
      const tc = cityAt(s, path.gx, path.gy);
      if (tc && tc.owner >= 0 && path.dist <= 2) {
        const rushing = tc.rush && tc.rush.p === p && tc.rush.until >= s.turn;   // assault already under way
        if (!rushing) {
          const near = s.units.filter(o => o.owner === p && o.carrier == null &&
            UNIT_TYPES[o.type].domain === 'land' && cheb(o.x, o.y, tc.x, tc.y) <= 3).length;
          const defenders = s.units.filter(o => o.owner !== p && o.carrier == null && o.x === tc.x && o.y === tc.y).length;
          const st = ordersOf(s, p).stance;   // the general's stance: offensive storms earlier, defensive gathers more
          const need = st === 'offensive' ? Math.max(2, Math.ceil(defenders * 1.1) + 1)
            : st === 'defensive' ? Math.max(5, Math.ceil(defenders * 2) + 3) : Math.max(AI_MIN_ASSAULT, Math.ceil(defenders * 1.5) + 2);
          const patience = st === 'offensive' ? 4 : st === 'defensive' ? 16 : AI_SIEGE_PATIENCE;
          u.siege = (u.siege || 0) + 1;
          if (near < need && u.siege <= patience) return false;         // wait until reinforcements arrive
          tc.rush = { p, until: s.turn + 2 };   // from now on everyone attacks, even if the first ones fall
        }
      } else u.siege = 0;
      return aiGo(s, u, path);
    }
    path = findPath(s, u, (x, y, occ) => {
      const o = occ[y * W + x];
      return !!o && o.owner === p && o.type === 'trans' && !s.terrain[y * W + x] && !o.mission &&
        cargoOf(s, o).length < T_CAP;
    });
    if (path) return aiGo(s, u, path);
    path = findPath(s, u, (x, y) => { const c = cityAt(s, x, y); return !!c && c.owner === p && c.coastal; });
    return aiGo(s, u, path);
  }

  if (u.type === 'trans') {
    const cargo = cargoOf(s, u);
    const freeWater = (x, y, occ) => !s.terrain[y * W + x] && (!occ[y * W + x] || occ[y * W + x] === u);
    const nextTo = (x, y, test) => DIRS.some(([dx, dy]) => test(wx(x + dx), wy(y + dy)));
    if (cityAt(s, u.x, u.y)) return aiGo(s, u, findPath(s, u, freeWater));
    if (cargo.length && (u.mission || cargo.length >= T_CAP || u.wait >= AI_FULL_LOAD_WAIT)) {   // cross over as fully loaded as possible
      u.mission = true;
      return aiGo(s, u, findPath(s, u, (x, y, occ) => freeWater(x, y, occ) &&
        nextTo(x, y, (a, b) => s.terrain[b * W + a] === 1 && targets.has(s.landId[b * W + a]))));
    }
    if (cargo.length) return false; // waiting for more troops
    u.mission = false;
    const home = strict => (x, y, occ) => freeWater(x, y, occ) && nextTo(x, y, (a, b) => {
      const c = cityAt(s, a, b);
      return !!c && c.owner === p && (!strict || !targets.has(s.landId[b * W + a]));
    });
    // first to where troops are waiting to be picked up; otherwise to any own city
    const waiting = new Set();
    for (const o of s.units) {
      if (o.owner !== p || o.carrier != null || o.garrison || UNIT_TYPES[o.type].domain !== 'land') continue;
      const c = cityAt(s, o.x, o.y);
      if (c && c.owner === p && c.coastal) waiting.add(c.id);
    }
    const pickup = (x, y, occ) => freeWater(x, y, occ) && nextTo(x, y, (a, b) => {
      const c = cityAt(s, a, b);
      return !!c && waiting.has(c.id);
    });
    return aiGo(s, u, (waiting.size && findPath(s, u, pickup)) || findPath(s, u, home(true)) || findPath(s, u, home(false)));
  }

  if (T.domain === 'sea') {
    let path = findPath(s, u, (x, y, occ) => !s.terrain[y * W + x] && !!enemyAt(x, y, occ));
    if (!path) path = findPath(s, u, (x, y) => !s.terrain[y * W + x] && !s.explored[p][y * W + x]);
    if (path) return aiGo(s, u, path);
    const [dx, dy] = DIRS[Math.floor(Math.random() * 8)];
    return moveUnit(s, u, u.x + dx, u.y + dy) === 'moved';
  }

  // air: only attack if the fuel suffices for the way back
  const myCities = s.cities.filter(c => c.owner === p);
  let best = null, bd = 1e9;
  for (const o of s.units) {
    if (!hostile(s, p, o.owner) || o.carrier != null || !vis[o.y * W + o.x] || submerged(s, o)) continue;
    if (o.hp > (u.type === 'bomber' ? 4 : 2)) continue;   // no suicide attacks on heavy ships: only beatable targets
    const d = cheb(u.x, u.y, o.x, o.y);
    if (d < bd) { bd = d; best = o; }
  }
  if (best) {
    const back = Math.min(...myCities.map(c => cheb(c.x, c.y, best.x, best.y)));
    if (bd + back + 1 <= u.fuel) return aiGo(s, u, findPath(s, u, (x, y) => x === best.x && y === best.y));
  }
  // patrol: fly fully fuelled from the city to a foreign city in range, reconnoitre, return.
  // Whatever comes into sight is attacked by the fighter in the next step via the rule above.
  const homeDist = Math.min(...myCities.map(c => cheb(c.x, c.y, u.x, u.y)));
  if (homeDist === 0 && u.fuel === T.fuel) {
    const reach = Math.floor(T.fuel / 2) - 2;
    const spots = s.cities.filter(c => hostile(s, p, c.owner) && cheb(c.x, c.y, u.x, u.y) <= reach);
    const foes = spots.filter(c => c.owner >= 0);            // other players' cities take priority over neutral ones
    const focus = foes.filter(c => c.owner === aiTarget(s, p));   // and the agreed attack target over all others
    const tcp = aiTargetCity(s, p);
    const pool = tcp && spots.includes(tcp) ? [tcp] : focus.length ? focus : foes.length ? foes : spots;
    u.patrol = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }
  if (u.patrol) {
    const t = u.patrol;
    // keep flying only while the fuel afterwards is surely enough for the way home
    // bombers fly right up to an enemy's city and bomb it, fighters reconnoitre from a distance
    const bomb = u.type === 'bomber' && t.owner >= 0 && hostile(s, p, t.owner), stop = bomb ? 1 : 2;
    if (homeDist + 3 > u.fuel) u.patrol = null;
    else if (cheb(u.x, u.y, t.x, t.y) <= stop) {
      u.patrol = null;
      if (bomb) return moveUnit(s, u, t.x, t.y) !== 'blocked';
    } else return aiGo(s, u, findPath(s, u, (x, y) => cheb(x, y, t.x, t.y) <= stop));
  }
  // redeployment: if there is no target from here, the aircraft relocates to an own city closer to the enemy.
  // This repeats city by city until it is at the front and flies missions from there.
  if (homeDist === 0 && u.fuel === T.fuel && !u.patrol) {
    const others = s.cities.filter(c => c.owner >= 0 && hostile(s, p, c.owner));
    const foes = others.length ? others : s.cities.filter(c => hostile(s, p, c.owner));
    const foeDist = c => Math.min(...foes.map(e => cheb(e.x, e.y, c.x, c.y)));
    u.ferry = null;
    if (foes.length) {
      let bestD = foeDist(u);
      for (const c of myCities) {
        const d = cheb(c.x, c.y, u.x, u.y);
        if (d === 0 || d > T.fuel - 3) continue;        // must be safely reachable on one tank of fuel
        const fd = foeDist(c);
        if (fd < bestD) { bestD = fd; u.ferry = c; }
      }
    }
  }
  if (u.ferry) {
    const f = u.ferry;
    if (f.owner !== p || (u.x === f.x && u.y === f.y) || cheb(u.x, u.y, f.x, f.y) + 1 > u.fuel) u.ferry = null;
    else return aiGo(s, u, findPath(s, u, (x, y) => x === f.x && y === f.y));
  }
  return aiGo(s, u, findPath(s, u, (x, y) => { const c = cityAt(s, x, y); return !!c && c.owner === p; }));
}

if (typeof module !== 'undefined') {
  module.exports = { MAP_SCALES, setMapScale, WAR_NEUTRAL_SHARE, summaryPrompt, warAllowed, neutralLeft, warThreshold, PRIVATE_MAX, PUBLIC_ROUNDS, ordersText, ordersOf, aiTargetCity, announceGenerals, lagebild, intelOf, transferUnits, capitalOf, unitTypeOf, shortName, TRAITS, personality, remember, nameGenerals, setGeneralName, namePrompt, PERSONAS, SUMMIT_ROUNDS, runSummit, startSummit, finishSummit, applyGeneral, summitPrompt, parseGeneral, chatOpen, chatClose, chatPost, gname, isGeneral, aiTarget, setEndgameBalance: v => { ENDGAME_BALANCE = v; }, fmtPop, POP_PER_PE, NAT_GROWTH, DRAIN_BUILD, DRAIN_UPKEEP, popMax, popTrend, setPop, TEMPERS, MAX_BLOC, bloc, canAlly, score, hostile, diplomacyAction, canNegotiate, REVIEW_EVERY, REL_NAME, fireMissile, missileTargets, MISSILE_DAMAGE, canSee, observerRound, playerName, UPKEEP, supply, GROUND, PLAYER_NAMES, UNIT_TYPES, DIRS, CITY_KINDS, GROWTH_RATE, GROW, REPAIR_SHARE, canRepair, fmt, newGame, moveUnit, followDest, endTurn, endHumanTurn, runAI, cityAt, unitsAt, cargoOf, canBuild, cheb, findPath, wx, wy, ROLES, unitCost, unitUpkeep, favored, capMax, CAP_MAX, movesOf, roleVal };
}
