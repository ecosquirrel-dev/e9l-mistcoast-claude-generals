// Compares the four player bonuses.  Usage: node tools/role-stats.js [games] [turns]
// Every game has 4 computer players and each bonus appears exactly once (that is how newGame assigns them).
// Scored by the share of cities at the end, because many games do not run until someone wins.
const G = require('../public/js/game.js');
const games = +process.argv[2] || 24, rounds = +process.argv[3] || 250;
const keys = Object.keys(G.ROLES);
const stat = Object.fromEntries(keys.map(k => [k, { share: 0, first: 0, out: 0, wins: 0 }]));
for (let g = 1; g <= games; g++) {
  const s = G.newGame(g * 6151, 4);
  s.observer = true;
  for (let r = 0; r < rounds && s.winner == null; r++) G.observerRound(s);
  const n = [0, 0, 0, 0];
  for (const c of s.cities) if (c.owner >= 0) n[c.owner]++;
  const total = n.reduce((a, b) => a + b, 0) || 1, best = Math.max(...n);
  for (let p = 0; p < 4; p++) {
    const st = stat[s.roles[p]];
    st.share += n[p] / total;
    if (n[p] === best) st.first += 1 / n.filter(v => v === best).length;
    if (s.out[p]) st.out++;
    if (s.winner === p) st.wins++;
  }
}
console.log(`${games} games, ${rounds} turns each, 4 players (expected if balanced: 25 % of cities, ${Math.round(games / 4)}x in front)\n`);
for (const k of keys) {
  const st = stat[k];
  console.log(`${G.ROLES[k].name.padEnd(22)} city share ${(st.share / games * 100).toFixed(1).padStart(5)} % | in front ${st.first.toFixed(1).padStart(5)}x | wins ${String(st.wins).padStart(2)} | eliminated ${String(st.out).padStart(2)}x`);
}
