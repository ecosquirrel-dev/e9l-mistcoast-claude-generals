// Measures how decisively the computer players fight.  Usage: node tools/ai-stats.js [games] [players] [maxTurns]
// Runs spectator games and counts decided games, game length and cities changing hands.
const G = require('../public/js/game.js');
const games = +process.argv[2] || 8, players = +process.argv[3] || 3, maxRounds = +process.argv[4] || 300;
let decided = 0, sumRounds = 0, flips = 0, out = 0;
for (let k = 1; k <= games; k++) {
  const s = G.newGame(k * 4409, players);
  s.observer = true;
  let r = 0;
  while (s.winner == null && r++ < maxRounds) G.observerRound(s);
  const f = s.log.filter(l => / from /.test(l.msg)).length;   // conquests from another player (the log keeps the last 200 entries)
  const n = new Array(players).fill(0);
  for (const c of s.cities) if (c.owner >= 0) n[c.owner]++;
  if (s.winner != null) { decided++; sumRounds += s.turn; }
  out += s.out.filter(Boolean).length;
  flips += f;
  console.log(`Game ${k}: ${s.winner != null ? 'winner ' + G.playerName(s, s.winner) + ' in turn ' + s.turn : 'undecided after ' + maxRounds + ' turns'} | cities ${n.join('/')} | units ${s.units.length}`);
}
console.log(`\nDecided: ${decided}/${games}` + (decided ? `, on average after ${Math.round(sumRounds / decided)} turns` : '') +
  ` | eliminated players: ${out} of ${games * players} | conquests in log: ${flips}`);
