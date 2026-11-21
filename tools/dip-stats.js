// Evaluates the computer players' diplomacy.  Usage: node tools/dip-stats.js [games] [players] [turns]
// After every negotiation round with at least 3 players alive, the current war pattern is counted.
const G = require('../public/js/game.js');
const games = +process.argv[2] || 8, players = +process.argv[3] || 4, rounds = +process.argv[4] || 400;
const pat = { 'all against one': 0, 'several fronts': 0, 'no war': 0 };
const byAlive = {};   // patterns by number of players alive
let snaps = 0, decided = 0, sumTurn = 0;
const ev = { ally: 0, war: 0, peace: 0, leave: 0 };
for (let k = 1; k <= games; k++) {
  const s = G.newGame(k * 509, players); s.observer = true;
  const push = s.log.push.bind(s.log);
  s.log.push = x => {
    if (/^ALLIANCE/.test(x.msg)) ev.ally++; else if (/^WAR/.test(x.msg)) ev.war++;
    else if (/^PEACE/.test(x.msg)) ev.peace++; else if (/ends the alliance/.test(x.msg)) ev.leave++;
    return push(x);
  };
  let lastReview = 0;
  for (let r = 0; r < rounds && s.winner == null; r++) {
    G.observerRound(s);
    if (s.turn % G.REVIEW_EVERY !== 0 || s.turn === lastReview) continue;
    lastReview = s.turn;
    const alive = [...Array(players).keys()].filter(p => !s.out[p]);
    if (alive.length < 3) continue;
    const war = (a, b) => s.dip.rel[a][b] === 'war';
    const wars = alive.flatMap(a => alive.filter(b => b > a && war(a, b)).map(b => [a, b]));
    snaps++;
    const kind = !wars.length ? 'no war'
      : alive.some(x => alive.every(y => y === x || war(x, y)) && wars.every(([a, b]) => a === x || b === x)) ? 'all against one' : 'several fronts';
    pat[kind]++;
    const b = byAlive[alive.length] = byAlive[alive.length] || { n: 0, one: 0 };
    b.n++; if (kind === 'all against one') b.one++;
  }
  if (s.winner != null) { decided++; sumTurn += s.turn; }
}
console.log(`${games} games, ${players} players, up to ${rounds} turns – ${snaps} negotiation rounds with at least 3 players evaluated`);
for (const [k, v] of Object.entries(pat)) console.log(`  ${k.padEnd(18)} ${String(v).padStart(3)}  (${Math.round(v / (snaps || 1) * 100)} %)`);
for (const [n, b] of Object.entries(byAlive)) console.log(`  with ${n} players alive: ${b.one} of ${b.n} all against one (${Math.round(b.one / b.n * 100)} %)`);
console.log(`Events: ${ev.ally} alliances, ${ev.war} declarations of war, ${ev.peace} peace treaties, ${ev.leave} alliances ended`);
console.log(`Decided: ${decided}/${games}` + (decided ? `, on average after ${Math.round(sumTurn / decided)} turns` : ''));
