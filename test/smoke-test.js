// AI vs. AI: checks that the game logic runs through without errors.  Usage: node test/smoke-test.js
// Plays six headless games and fails (non-zero exit code) if anything throws or a unit ends up on the wrong terrain.
const G = require('../public/js/game.js');
const wins = {};
let maxUnits = 0;
for (let seed = 1; seed <= 6; seed++) {
  const s = G.newGame(seed * 1337);
  if (seed === 1) {   // print the first map as ASCII: o = neutral city, A–D = player city, # = land, . = water
    for (let y = 0; y < s.H; y++) {
      let l = '';
      for (let x = 0; x < s.W; x++) { const c = G.cityAt(s, x, y); l += c ? (c.owner < 0 ? 'o' : 'ABCD'[c.owner]) : s.terrain[y * s.W + x] ? '#' : '.'; }
      console.log(l);
    }
  }
  let t = 0;
  while (s.winner == null && t++ < 800) {
    G.runAI(s, s.current); if (s.winner != null) break; G.endTurn(s);
    maxUnits = Math.max(maxUnits, s.units.length);
  }
  const n = new Array(s.players + 1).fill(0); for (const c of s.cities) n[c.owner + 1]++;
  for (const u of s.units) {
    if (u.carrier != null) continue;
    const land = s.terrain[u.y * s.W + u.x], d = G.UNIT_TYPES[u.type].domain, c = G.cityAt(s, u.x, u.y);
    if ((d === 'land' && !land) || (d === 'sea' && land && !c)) throw new Error('Unit on wrong terrain: ' + JSON.stringify(u));
  }
  wins[String(s.winner)] = (wins[String(s.winner)] || 0) + 1;
  console.log(`seed ${seed}: turn ${s.turn}, winner ${s.winner}, cities neutral/players ${n}, units ${s.units.length}`);
}
console.log('Wins per player (null = undecided)', wins, '| max units', maxUnits);
console.log('Smoke test passed.');
