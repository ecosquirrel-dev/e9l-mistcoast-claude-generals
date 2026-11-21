'use strict';
/* Mistcoast – rendering and input */
(function () {
  let TILE = 30, K = TILE / 24;     // tile size in pixels (zoom); icons are designed on a 24-unit grid and scaled
  const SMALL = 14;                 // below this tile size only colour patches are drawn instead of icons
  const MS = 3;                     // minimap: pixels per tile
  const C = { fog: '#0a121c', sea: '#17395c', sea2: '#1b4168', p: ['#ffd166', '#ef476f', '#4cc9f0', '#b388ff', '#7bd389', '#ff8c42', '#2ec4b6', '#f7a8d8'], neutral: '#cfd6dd', ink: '#10202f' };
  const cv = document.getElementById('map'), ctx = cv.getContext('2d');
  // minimap disabled (only the large map above the chat remains); an invisible canvas keeps the old code working
  const mini = document.createElement('canvas'), mctx = mini.getContext('2d');
  const wrap = document.getElementById('mapwrap'), side = document.getElementById('side');
  const mod = (a, n) => ((a % n) + n) % n;
  let S = null;
  const sel = null, selCity = null;   // no own selection any more (pure agent game); map drawing still checks them
  let viewMode = 'all';             // view: 'all' = whole map revealed, 'ai' = only what the generals see together
  let playing = false, timer = null;   // automatic playback
  const speed = 400;                    // speed fixed at "normal" (ms per turn)
  let toNext = false;                   // "Until next negotiation": play quickly, stop after the summit
  let cur = null;                   // settings of the running game (for "Play again")
  let mapScale = 1;                 // map size for the next game (area × 0.5 / 1 / 2 / 4)
  let nAI = 3;                      // number of additional generals for the next new map (3 = four generals)
  const cam = { x: 0, y: 0 };       // top-left corner of the viewport in world pixels
  // Generals: Claude negotiates via the local server (serve.py → claude -p)
  const generalsWanted = true;      // generals always negotiate via Claude (if the server is reachable)
  let generalsAvail = false;        // does the server respond with an available Claude CLI?
  let summitBusy = false;           // is a summit running right now? Then the game pauses
  let chatRoom = 0;                 // selected chat tab: 0 = World Council (start), 'all', 'sum', 'why' or a room id
  let chatSig = '';                 // fingerprint of the last drawn chat (avoid needless redraws)
  const chatEl = document.getElementById('chat');
  const ctlEl = document.getElementById('ctlbar');   // control bar to the left of the map
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = t => String(t).replace(/[&<>"']/g, ch => ESC[ch]);
  /** Escape text and make coordinates like (91,13) or 91,13 clickable (centres and zooms the map). */
  const linkCoords = t => {
    const ok = (x, y) => +x < (S ? S.W : 999) && +y < (S ? S.H : 999);
    const a = (m, x, y) => (ok(x, y) ? `<a class="coord" data-coord="${+x},${+y}" title="Show on map">${m}</a>` : m);
    return esc(t)
      // (91,13) – coordinates in parentheses
      .replace(/\((\d{1,3})\s?,\s?(\d{1,3})\)/g, a)
      // "at 23,4" etc. – only after place words, and not before M/k/PP/%/points (numbers with units)
      .replace(/\b(at|near|off|in|on|to|from|around|city|town|island|field|tile|harbour|harbor|port|coast)\s+(\d{1,3}),(\d{1,3})\b(?!\s*(?:M\b|k\b|PP|%|points|score))/gi,
        (m, w, x, y) => (ok(x, y) ? `${w} <a class="coord" data-coord="${+x},${+y}" title="Show on map">${x},${y}</a>` : m));
  };
  let mark = null;   // briefly highlighted tile after clicking a coordinate
  function jumpTo(x, y) {
    if (TILE < 30) setZoom(30);
    centerOn(x, y);
    mark = { x, y, until: performance.now() + 1800 };
    draw();
    setTimeout(() => { if (mark && performance.now() >= mark.until) { mark = null; draw(); } }, 1900);
  }
  fetch('/api/general').then(r => r.json()).then(j => { generalsAvail = !!j.ok; if (S) { S.generals = generalsWanted && generalsAvail; render(); } })
    .catch(() => { generalsAvail = false; });
  async function askGeneral(req) {
    const r = await fetch('/api/general', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Error');
    return j.text;
  }
  let setupBusy = false;            // turn 0 running: generals are being assigned
  /** Does the game still need its line-up (turn 0)? */
  const needsSetup = () => !!S && S.generals && !S.setupDone && S.winner == null;
  /**
   * Turn 0: every general picks a name and motto, the log introduces all generals.
   * The game waits for it. Right after that comes the First Meeting in the World Council (turn 1, getting to know each other).
   */
  function runSetup() {
    if (setupBusy || !needsSetup()) return;
    const game = S;
    setupBusy = true; render();
    nameGenerals(game, askGeneral, () => { if (game === S) { chatSig = ''; renderChat(); } })
      .catch(e => console.error(e))
      .finally(() => {
        if (game !== S) return;                 // a new game was started in the meantime
        announceGenerals(game);
        game.setupDone = true; setupBusy = false;
        game.pendingSummit = true;              // First Meeting right away in turn 1
        render(); holdSummit();
      });
  }
  /** Hold a summit; the game pauses meanwhile, afterwards an observer game continues. */
  function holdSummit() {
    if (summitBusy || !S.pendingSummit) return;
    const game = S;
    summitBusy = true; render();
    runSummit(game, askGeneral, () => { if (game === S) renderChat(); })
      .catch(e => { console.error(e); if (game.pendingSummit) finishSummit(game); })
      .finally(() => {
        if (game !== S) return;                   // a new game was started in the meantime: don't touch its state
        summitBusy = false;
        render();
        if (toNext) { toNext = false; playing = false; render(); return; }   // goal reached: stop after the summit
        if (playing) timer = setTimeout(tick, speed);
      });
  }
  const WW = () => S.W * TILE, WH = () => S.H * TILE;

  /** What is revealed (ex) and currently visible (vis) on the map. In test mode: union of all players. */
  function view() {
    if (viewMode === 'own') return { ex: S.explored[0], vis: S.visible[0] };
    if (viewMode === 'all') { const a = new Uint8Array(S.W * S.H).fill(1); return { ex: a, vis: a }; }
    const n = S.W * S.H, ex = new Uint8Array(n), vis = new Uint8Array(n);
    for (let p = 0; p < S.players; p++) {
      if (S.out[p]) continue;
      const e = S.explored[p], v = S.visible[p];
      for (let i = 0; i < n; i++) { ex[i] |= e[i]; vis[i] |= v[i]; }
    }
    return { ex, vis };
  }

  /** Is the unit drawn? In the own view the stealth rules apply; as an observer you see everything. */
  const seen = (u, vis) => u.owner === 0 || (viewMode === 'own' ? canSee(S, 0, u) : !!vis[u.y * S.W + u.x]);

  /* ---------- Zoom ---------- */

  // If the whole world fits into the window, it is centred instead of drawn repeatedly (off = margin in pixels).
  const offX = () => Math.max(0, Math.floor((cv.width - S.W * TILE) / 2));
  const offY = () => Math.max(0, Math.floor((cv.height - S.H * TILE) / 2));
  const camX = () => (offX() ? 0 : cam.x), camY = () => (offY() ? 0 : cam.y);
  /** Largest tile size at which the whole map fits into the window. */
  const worldTile = () => Math.max(3, Math.floor(Math.min(cv.width / S.W, cv.height / S.H)));

  function setZoom(t) {
    t = Math.max(worldTile(), Math.min(48, Math.round(t)));
    const cx = (cam.x + cv.width / 2) / TILE, cy = (cam.y + cv.height / 2) / TILE;   // keep the view centre fixed in tiles
    TILE = t; K = TILE / 24;
    cam.x = mod(Math.round(cx * TILE - cv.width / 2), WW());
    cam.y = mod(Math.round(cy * TILE - cv.height / 2), WH());
  }
  function zoomStep(dir) {
    const levels = [...new Set([worldTile(), 8, 12, 18, 24, 30, 40, 48])].filter(v => v >= worldTile()).sort((a, b) => a - b);
    const next = dir > 0 ? levels.find(v => v > TILE) : [...levels].reverse().find(v => v < TILE);
    if (next) setZoom(next);
  }
  let lastZoom = 30;                // tile size before jumping to the world view
  function toggleWorld() {
    if (TILE <= worldTile()) setZoom(lastZoom);
    else { lastZoom = TILE; setZoom(worldTile()); }
  }

  function fit() { cv.width = wrap.clientWidth; cv.height = wrap.clientHeight; }

  // cfg = game settings. Without it the ones chosen in the side panel apply;
  // "Play again" passes those of the running game (cur) instead.
  function start(seed, cfg) {
    setPlaying(false);
    cur = cfg || { nAI, scale: mapScale };
    setMapScale(cur.scale || 1);
    S = newGame(seed, 1 + cur.nAI);
    S.observer = true;                  // pure agent game: all players are generals
    S.generals = generalsWanted && generalsAvail;
    chatRoom = 0; chatSig = '';        // generals (Claude) only start once the game is played
    // New game = empty memory: chat, memories, notes and names belong to the new game state S.
    // Answers from a still-running summit or name selection of the old game only end up in the old game state.
    summitBusy = false; setupBusy = false;
    S.log.length = 0; S.log.push({ turn: 0, msg: `New game with ${S.players} generals. Press "▶ Play" to start.` });
    mini.width = S.W * MS; mini.height = S.H * MS;
    fit();
    // Every game starts in the world view; W switches to the last used close-up view
    if (TILE > worldTile()) lastZoom = TILE;
    setZoom(worldTile());
    const home = S.cities.find(c => c.owner === 0);
    centerOn(home.x, home.y);
    // No autostart: observer games also wait until "Play" (or the space bar) is pressed
    render();
  }

  /* ---------- Icons (coordinates on the 24-unit grid) ---------- */

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function poly(...p) {
    ctx.beginPath(); ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath(); ctx.fill();
  }
  const box = (x, y, w, h) => ctx.fillRect(x, y, w, h);
  const dot = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); };

  const ICON = {
    inf() {      // soldier with helmet and rifle
      dot(12, 8.2, 2.6);
      poly(8.6, 7.8, 15.4, 7.8, 14.6, 5.6, 12, 4.6, 9.4, 5.6);
      poly(8.4, 12, 15.6, 12, 14.8, 19, 9.2, 19);
      ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(6.5, 17.5); ctx.lineTo(17.5, 9); ctx.stroke();
    },
    tank() {     // side view: track, hull, turret, barrel
      rr(4.5, 14, 15, 4.6, 2.3); ctx.fill();
      poly(6.5, 14, 8, 11.2, 16.2, 11.2, 17.8, 14);
      rr(9, 7.8, 6, 3.6, 1.2); ctx.fill();
      box(14.8, 8.8, 6, 1.5);
    },
    jet() {      // top view, nose up
      poly(12, 3.5, 13.3, 9, 13.3, 17, 12, 20.5, 10.7, 17, 10.7, 9);
      poly(12, 9.5, 20.5, 15.5, 20.5, 17, 13.2, 15, 10.8, 15, 3.5, 17, 3.5, 15.5);
      poly(12, 16.5, 15.2, 19.6, 15.2, 20.8, 8.8, 20.8, 8.8, 19.6);
    },
    trans() {    // freighter: hull, cargo, bridge at the stern
      poly(3.5, 14, 20.5, 14, 18.5, 18.6, 5.5, 18.6);
      box(6, 10.8, 3.2, 2.8); box(9.8, 10.8, 3.2, 2.8);
      box(14.6, 8, 3.2, 5.6); box(15.4, 5.6, 1.2, 2.4);
    },
    dest() {     // slim warship with mast and bow gun
      poly(3, 14.6, 21, 14.6, 18.8, 18, 6, 18);
      box(9.5, 11.6, 6, 3); box(11, 9.4, 3, 2.2); box(12.1, 5.6, 0.9, 3.8);
      box(5.6, 12.8, 2.4, 1.8); box(3.4, 13.2, 2.4, 0.9);
    },
    bship() {    // battleship: tall tower, two gun turrets
      poly(2.6, 14, 21.4, 14, 19.4, 19, 4.6, 19);
      box(8.4, 11.2, 7.2, 2.8); box(10.2, 6.4, 3.6, 4.8); box(11.5, 4, 1, 2.4);
      box(4.8, 11.8, 3, 2.2); box(2.4, 12.4, 2.6, 1);
      box(16.2, 11.8, 3, 2.2); box(19, 12.4, 2.6, 1);
    },
    sub() {      // submarine: round hull, conning tower, periscope
      rr(2.5, 13.2, 19, 5.4, 2.7); ctx.fill();
      rr(9.5, 9.4, 5, 4.4, 1.2); ctx.fill();
      box(12.6, 5.4, 0.9, 4.2); box(12.6, 5.4, 2.6, 0.9);
    },
    carrier() {  // carrier: long flight deck, island, plane on deck
      poly(3.5, 13.4, 20.5, 13.4, 18.8, 18.8, 5.2, 18.8);
      box(1.8, 11.6, 20.4, 1.8);
      box(14.4, 7, 3.2, 4.6); box(15.5, 4.8, 1, 2.2);
      poly(5, 11.4, 9.6, 11.4, 9.6, 9.2);
    },
    bomber() {   // top view: wide wings, two engines
      poly(12, 2.8, 13.7, 8, 13.7, 18, 12, 21.2, 10.3, 18, 10.3, 8);
      poly(12, 8.4, 22.2, 12.8, 22.2, 15.4, 13.7, 13.6, 10.3, 13.6, 1.8, 15.4, 1.8, 12.8);
      poly(12, 17, 16.6, 19.8, 16.6, 21.2, 7.4, 21.2, 7.4, 19.8);
      box(6.2, 10.6, 1.8, 4); box(16, 10.6, 1.8, 4);
    },
    nuke() {     // nuke: mushroom cloud
      ctx.beginPath(); ctx.ellipse(12, 8.2, 7.4, 4.6, 0, 0, 7); ctx.fill();
      poly(9.6, 11, 14.4, 11, 13.6, 16.5, 10.4, 16.5);
      ctx.beginPath(); ctx.ellipse(12, 18.6, 6.4, 2.2, 0, 0, 7); ctx.fill();
    },
    missile() {  // missile: pointed body, two fins, flame
      poly(12, 2.8, 14.6, 8, 14.6, 16.6, 9.4, 16.6, 9.4, 8);
      poly(9.4, 12, 6.2, 18.6, 9.4, 16.6); poly(14.6, 12, 17.8, 18.6, 14.6, 16.6);
      poly(10.6, 17.4, 12, 21.6, 13.4, 17.4);
    },
  };

  const CITY_ICON = [
    col => {     // industrial city: sawtooth-roof hall and chimney with smoke
      poly(3.8, 19.5, 3.8, 13.4, 7.6, 10.6, 7.6, 13.4, 11.4, 10.6, 11.4, 13.4, 15.2, 10.6, 15.2, 19.5);
      box(16.2, 5.6, 3.4, 13.9);
      ctx.globalAlpha = 0.55; dot(15.4, 4.4, 1.5); dot(12.8, 3.8, 1.2); ctx.globalAlpha = 1;
      ctx.fillStyle = C.ink; box(5.4, 15.4, 2, 2); box(9, 15.4, 2, 2); ctx.fillStyle = col;
    },
    col => {     // city: high-rise silhouette
      box(4, 11, 4.6, 8.5); box(9.4, 5.4, 5.2, 14.1); box(15.4, 8.8, 4.6, 10.7);
      ctx.fillStyle = C.ink;
      for (let y = 7.4; y < 17; y += 2.8) { box(10.6, y, 1.1, 1.3); box(12.4, y, 1.1, 1.3); }
      box(5.4, 13, 1.6, 1.3); box(16.9, 11, 1.6, 1.3); box(16.9, 14, 1.6, 1.3);
      ctx.fillStyle = col;
    },
    col => {     // town: two houses with gable roofs
      poly(3.6, 13.6, 8, 9, 12.4, 13.6); box(4.8, 13.6, 6.4, 5.9);
      poly(12.4, 14.6, 16.2, 10.8, 20, 14.6); box(13.4, 14.6, 5.6, 4.9);
      ctx.fillStyle = C.ink; box(7, 16, 2, 3.5); box(15.3, 16.2, 1.8, 1.8); ctx.fillStyle = col;
    },
  ];

  function badge(x, y, n, col) {
    ctx.fillStyle = C.ink; dot(x, y, 4.6);
    ctx.fillStyle = col; ctx.font = 'bold 7px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x, y + 0.4);
  }

  function drawUnit(u, px, py) {
    const T = UNIT_TYPES[u.type], col = C.p[u.owner];
    if (TILE < SMALL) {               // far zoomed out: unit as a small colour dot
      const m = Math.max(1, Math.round(TILE * 0.25));
      ctx.fillStyle = col; ctx.fillRect(px + m, py + m, TILE - 2 * m, TILE - 2 * m);
      return;
    }
    ctx.save(); ctx.translate(px, py); ctx.scale(K, K);
    rr(2, 2, 20, 20, 4); ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = C.ink; ctx.stroke();
    ctx.fillStyle = C.ink; ctx.strokeStyle = C.ink;
    ICON[u.type]();
    if (T.hp > 1) {
      ctx.fillStyle = C.ink; box(4, 19.6, 16, 2);
      ctx.fillStyle = u.hp / T.hp > 0.5 ? '#7bd389' : '#ff8c42'; box(4.4, 20, 15.2 * u.hp / T.hp, 1.2);
    }
    if (T.capacity) { const n = cargoOf(S, u).length; if (n) badge(19.5, 4.5, n, col); }
    if (u.owner === 0 && (u.sentry || u.repair)) badge(4.5, 4.5, u.repair ? '+' : 'z', col);
    ctx.restore();
  }

  function drawCity(c, px, py, count) {
    const col = c.owner < 0 ? C.neutral : C.p[c.owner];
    if (TILE < SMALL) {               // far zoomed out: city as a colour patch with dark border
      ctx.fillStyle = C.ink; ctx.fillRect(px - 1, py - 1, TILE + 2, TILE + 2);
      ctx.fillStyle = col; ctx.fillRect(px, py, TILE, TILE);
      return;
    }
    ctx.save(); ctx.translate(px, py); ctx.scale(K, K);
    rr(1.5, 1.5, 21, 21, 4); ctx.fillStyle = C.ink; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = col; ctx.stroke();
    ctx.fillStyle = col;
    CITY_ICON[c.kind](col);
    if (count) { ctx.fillStyle = col; dot(19.5, 4.5, 4.6); ctx.fillStyle = C.ink; ctx.font = 'bold 7px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(count), 19.5, 4.9); }
    ctx.restore();
  }

  /* ---------- Map ---------- */

  // minimap: colour per terrain type, [visible, explored only]
  const MINI_LAND = [['#86a86a', '#5b7650'], ['#3f7448', '#2d5335'], ['#a8a465', '#757247'], ['#8f8a85', '#625e5a'], ['#3a3330', '#2a2523']];

  const groundCol = new Map();   // colour per tile and terrain type, computed once
  function drawGround(g, x, y, px, py) {
    const key = (y * 4096 + x) * 8 + g;
    let col = groundCol.get(key);
    if (!col) {
      const h = ((x * 73856093) ^ (y * 19349663)) >>> 0, v = (h >> 4) % 6;
      col = g === 0 ? `hsl(${96 + (h % 14)}, 28%, ${46 + v}%)` : g === 1 ? `hsl(128, 30%, ${31 + v}%)`
        : g === 2 ? `hsl(62, 26%, ${43 + v}%)` : `hsl(30, 8%, ${46 + v}%)`;
      groundCol.set(key, col);
    }
    ctx.fillStyle = col;
    ctx.fillRect(px, py, TILE, TILE);
    if (g === 4) {              // crater of an obliterated city: scorched earth
      ctx.fillStyle = '#3a3330'; ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = '#1e1a19'; ctx.beginPath(); ctx.ellipse(px + TILE / 2, py + TILE / 2, TILE * 0.36, TILE * 0.26, 0, 0, 7); ctx.fill();
      return;
    }
    if (!g || TILE < SMALL) return;   // zoomed out, the terrain colour is enough
    ctx.save(); ctx.translate(px, py); ctx.scale(K, K);
    if (g === 1) {            // forest: three firs
      ctx.fillStyle = 'hsl(134, 40%, 19%)';
      poly(3, 12, 7, 3.5, 11, 12); poly(13, 10.5, 16.5, 3, 20, 10.5); poly(8, 21, 12, 12.5, 16, 21);
    } else if (g === 2) {     // hills: two humps
      ctx.strokeStyle = 'hsl(58, 26%, 27%)'; ctx.lineWidth = 1.7;
      ctx.beginPath(); ctx.arc(8.5, 17, 5.5, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.arc(16, 12.5, 5.5, Math.PI, 0); ctx.stroke();
    } else {                  // mountains: two peaks with snow
      ctx.fillStyle = 'hsl(28, 10%, 27%)';
      poly(1.5, 21.5, 10, 4, 18.5, 21.5); poly(11, 21.5, 17, 10, 23, 21.5);
      ctx.fillStyle = '#eef2f4'; poly(10, 4, 12.6, 9.4, 10.4, 8.2, 7.6, 9);
    }
    ctx.restore();
  }

  function drawMark() {
    if (!mark || performance.now() > mark.until) return;
    const sx = mod(mark.x * TILE - camX(), WW()) + offX() + TILE / 2, sy = mod(mark.y * TILE - camY(), WH()) + offY() + TILE / 2;
    ctx.save(); ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 3;
    for (const r of [TILE * 0.9, TILE * 1.6]) { ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.stroke(); }
    ctx.restore();
  }
  function drawMap() {
    const { W, H } = S, { ex, vis } = view();
    const top = new Map(), cnt = new Map();
    for (const u of S.units) {
      if (u.carrier != null) continue;
      const i = u.y * W + u.x;
      if (!seen(u, vis)) continue;
      if (S.cityIdx[i] >= 0) cnt.set(i, (cnt.get(i) || 0) + 1); else top.set(i, u);
    }
    ctx.fillStyle = C.fog; ctx.fillRect(0, 0, cv.width, cv.height);
    const ox = offX(), oy = offY(), cx = camX(), cy = camY();
    const tgt = sel && !sel.dead && UNIT_TYPES[sel.type].range && sel.owner === 0
      ? new Set(missileTargets(S, sel).filter(c => ex[c.y * W + c.x]).map(c => c.id)) : null;
    const tx0 = Math.floor(cx / TILE), ty0 = Math.floor(cy / TILE);
    const cols = ox ? W : Math.ceil(cv.width / TILE) + 1, rows = oy ? H : Math.ceil(cv.height / TILE) + 1;
    for (let sy = 0; sy < rows; sy++) for (let sx = 0; sx < cols; sx++) {
      // world tile via modulo: the map continues seamlessly at every edge
      const x = mod(tx0 + sx, W), y = mod(ty0 + sy, H), i = y * W + x;
      if (!ex[i]) continue;
      const px = (tx0 + sx) * TILE - cx + ox, py = (ty0 + sy) * TILE - cy + oy;
      if (S.terrain[i]) drawGround(S.ground[i], x, y, px, py);
      else { ctx.fillStyle = (x + y) % 2 ? C.sea : C.sea2; ctx.fillRect(px, py, TILE, TILE); }
      const k = S.cityIdx[i];
      if (k >= 0) drawCity(S.cities[k], px, py, cnt.get(i) || 0);
      else if (top.has(i)) drawUnit(top.get(i), px, py);
      if (!vis[i]) { ctx.fillStyle = 'rgba(6,12,20,0.45)'; ctx.fillRect(px, py, TILE, TILE); }
      if (tgt && tgt.has(S.cityIdx[i])) {   // possible missile target: red ring
        ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = Math.max(2, TILE / 10); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(px + TILE / 2, py + TILE / 2, TILE * 0.72, 0, 7); ctx.stroke();
      }
      if (selCity && selCity.x === x && selCity.y === y) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2); ctx.setLineDash([]);
      }
      if (sel && !sel.dead) {
        if (sel.x === x && sel.y === y) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.setLineDash([]); ctx.strokeRect(px + 1, py + 1, TILE - 2, TILE - 2); }
        if (sel.dest && sel.dest.x === x && sel.dest.y === y) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(px + TILE / 2, py + TILE / 2, TILE / 2 - 4, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        }
      }
    }
  }

  function drawMini() {
    const { W, H } = S, { ex, vis } = view();
    mctx.fillStyle = C.fog; mctx.fillRect(0, 0, mini.width, mini.height);
    for (let i = 0; i < W * H; i++) {
      if (!ex[i]) continue;
      mctx.fillStyle = S.terrain[i] ? MINI_LAND[S.ground[i]][vis[i] ? 0 : 1] : (vis[i] ? '#1f4a75' : '#17395c');
      mctx.fillRect((i % W) * MS, Math.floor(i / W) * MS, MS, MS);
    }
    for (const u of S.units) {
      if (u.carrier != null || !seen(u, vis)) continue;
      mctx.fillStyle = C.p[u.owner]; mctx.fillRect(u.x * MS, u.y * MS, MS, MS);
    }
    for (const c of S.cities) {
      if (!ex[c.y * W + c.x]) continue;
      mctx.fillStyle = C.ink; mctx.fillRect(c.x * MS - 2, c.y * MS - 2, MS + 4, MS + 4);
      mctx.fillStyle = c.owner < 0 ? C.neutral : C.p[c.owner]; mctx.fillRect(c.x * MS - 1, c.y * MS - 1, MS + 2, MS + 2);
    }
    // viewport; if it runs over the edge, the rest appears on the opposite side
    const vx = camX() / TILE * MS, vy = camY() / TILE * MS;
    const vw = Math.min(cv.width / TILE * MS, mini.width), vh = Math.min(cv.height / TILE * MS, mini.height);
    mctx.strokeStyle = '#fff'; mctx.lineWidth = 1;
    for (const ox of [0, -mini.width]) for (const oy of [0, -mini.height]) mctx.strokeRect(vx + ox + 0.5, vy + oy + 0.5, vw, vh);
  }

  function draw() { drawMap(); drawMark(); }
  function render() { draw(); renderSide(); renderChat(); }

  /* ---------- Generals' chat (below the map) ---------- */

  const pdot = p => `<i class="dot" style="background:${C.p[p]}"></i>`;
  const gtitle = p => S.dip.gname[p] || gname(p);   // self-chosen general name, otherwise the colour
  const pname = p => `<b style="color:${C.p[p]}" title="${esc(gname(p))} · ${esc(PERSONAS[S.dip.persona[p]].name)}">${esc(gtitle(p))}</b>`;
  const WORD = { war: 'War', ally: 'Alliance', peace: 'Peace' };
  // timestamp of a chat message: game turn and time of day (date only if not from today)
  const stamp = m => {
    const it = m.round && (m.round.match(/(Back Room|World Council) (\d+)/) || [])[2];
    const tag = it ? ` · ${/Back Room/.test(m.round) ? 'B' : 'W'}${it}` : '';
    if (!m.at) return `T${m.turn}${tag}`;
    const d = new Date(m.at), today = new Date().toDateString() === d.toDateString();
    const t = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `T${m.turn}${tag} · ${today ? t : d.toLocaleDateString('en-US') + ' ' + t}`;
  };
  /** A general's diary: newest entry open, older ones collapsed. */
  function journalHTML(p) {
    const J = (S.dip.journal && S.dip.journal[p]) || [];
    if (!J.length) return '';
    const entry = j => `<div class="je"><div class="jh">Summit Turn ${j.turn}</div>
      ${j.goals ? `<div>🎯 <b>Goals</b> ${linkCoords(j.goals)}</div>` : ''}${j.plan ? `<div>📋 <b>Plan</b> ${linkCoords(j.plan)}</div>` : ''}${j.review ? `<div>🔙 <b>Review</b> ${linkCoords(j.review)}</div>` : ''}</div>`;
    const rev = [...J].reverse();
    return `<div class="journal"><div class="sub2">📓 Diary (${J.length})</div>${entry(rev[0])}${rev.length > 1
      ? `<details><summary>older entries (${rev.length - 1})</summary>${rev.slice(1).map(entry).join('')}</details>` : ''}</div>`;
  }

  /** Profiles of all generals (card below the map). */
  function genHTML() {
    const D = S.dip;
    return `<div class="gens">` + [...Array(S.players).keys()].filter(p => isGeneral(S, p) || S.out[p]).map(p => {
      const per = PERSONAS[D.persona[p]], t = D.traits[p];
      const mem = D.memory[p].slice(-5).map(m => `<li>${linkCoords(m)}</li>`).join('');
      const lost = [...Array(S.players).keys()].filter(q => D.lost[p][q]).map(q => `${pdot(q)}${D.lost[p][q]}`).join(' ');
      return `<div class="gen${S.out[p] ? ' out' : ''}"><div>${pdot(p)}${pname(p)} <small class="muted">${esc(gname(p))}${S.out[p] ? ' · eliminated' : ''}</small></div>
        <div class="muted"><b>${esc(per.name)}</b> – ${esc(per.stil)}</div>
        ${D.motto[p] ? `<div class="motto">“${esc(D.motto[p])}”</div>` : ''}
        <div class="muted">Origin: ${esc(t.herkunft)}<br>Quirk: ${esc(t.marotte)}<br>Weakness: ${esc(t.schwaeche)}</div>
        ${lost ? `<div class="muted">Cities lost to: ${lost}</div>` : ''}
        ${mem ? `<ul>${mem}</ul>` : ''}
        ${D.notes[p] ? `<div class="note">📝 ${linkCoords(D.notes[p])}</div>` : ''}
        ${journalHTML(p)}</div>`;
    }).join('') + `</div>`;
  }

  /** Resolutions of the last summit (card below the map). */
  function decHTML() {
    const L = S.summitLast;
    if (!L) return '<p class="muted">No summit finished yet.</p>';
    if (L.intro) return `<p class="muted">First Meeting in turn ${L.turn}: the generals got to know each other and sounded each other out – nothing was decided. Their impressions are stored as notes under "Generals".</p>`;
    const gens = Object.keys(L.dec).map(Number);
    const cell = (p, q) => {
      if (q === p) return '<td>–</td>';
      const d = L.dec[p][q];
      return `<td class="${d || ''}">${d ? WORD[d] : '<span class="muted">(rule)</span>'}</td>`;
    };
    return `<p class="muted">Binding decisions at the summit in turn ${L.turn} (row = who decides). War needs only one side, an alliance needs both.</p>
      <table class="tbl dec"><thead><tr><th>General</th>${gens.map(q => `<th>${pdot(q)}${esc(gtitle(q))}</th>`).join('')}<th>Target</th><th>Orders to the army</th></tr></thead><tbody>` +
      gens.map(p => `<tr><td>${pdot(p)}${pname(p)} <small class="muted">${esc(PERSONAS[S.dip.persona[p]].name)}</small></td>${gens.map(q => cell(p, q)).join('')}
        <td>${L.target[p] >= 0 ? pdot(L.target[p]) + esc(gtitle(L.target[p])) : '–'}</td>
        <td>${L.orders && L.orders[p] ? linkCoords(ordersText(S, p, L.orders[p])) : '<span class="muted">(none)</span>'}</td></tr>`).join('') + '</tbody></table>' +
      ((L.transfers || []).length ? `<p><b>Transfers</b></p>` + L.transfers.map(t => `<div class="msg">${pdot(t.p)}${pname(t.p)} → ${pdot(t.q)}${pname(t.q)}: ${
        Object.entries(t.done).map(([u, n]) => `${n}× ${esc(UNIT_TYPES[u].name)}`).join(', ')}</div>`).join('') : '<p class="muted">No units transferred.</p>') +
      (L.errors.length ? `<p class="muted">No valid answer: ${esc(L.errors.join('; '))}</p>` : '');
  }

  /** Group messages of the same conversation round into a frame with a heading; the newest round is highlighted. */
  function grouped(items, render, msgOf) {
    let html = '', key = null, first = true;
    for (const it of items) {
      // one frame per summit and phase: conversation rounds 1–3 of the Back Room (or 1–2 of the World Council) belong together
      const m = msgOf(it), k = (m.round || `Turn ${m.turn}`).replace(/(Back Room|World Council) \d+( \(Decision\))?/, '$1');
      if (k + m.turn !== key) {
        if (key !== null) html += '</div>';
        html += `<div class="grp${first ? ' now' : ''}"><div class="grph">${esc(k)}</div>`;
        key = k + m.turn; first = false;
      }
      html += render(it);
    }
    return key === null ? '' : html + '</div>';
  }

  function chatBody() {
    const rooms = S.chat.rooms, next = Math.ceil((S.turn + 1) / REVIEW_EVERY) * REVIEW_EVERY;
    if (chatRoom === 'sum') {   // for the observer only: summary of every conversation round
      const list = [...S.chat.summaries].reverse();
      return `<p class="muted">Visible only to you: after every conversation round a neutral reporter summarises what was discussed in public and in the private rooms.</p>` +
        (list.map(m => `<div class="msg sumry"><span class="room">${esc(m.label)}</span><small>${stamp(m)}</small>${linkCoords(m.text)}${(m.highlights || []).length
          ? `<ul class="hl">${m.highlights.map(h => `<li class="hl-${esc((h.art || '').toLowerCase())}"><b>${esc(h.art || 'Highlight')}</b> ${linkCoords(h.text)}</li>`).join('')}</ul>` : ''}</div>`).join('')
          || '<p class="muted">No summaries yet.</p>');
    }
    if (chatRoom === 'why') {   // for the observer only: why did each general decide that way?
      const list = [...S.chat.reasons].reverse();
      return `<p class="muted">Visible only to you – no general reads this channel. After the First Meeting every general says whom they like, reject or despise; after every further summit, why they chose War, Alliance or Peace.</p>` +
        (list.map(m => `<div class="msg">${pdot(m.from)}${pname(m.from)}<small>${stamp(m)}</small>${m.choice ? `<span class="room">${esc(m.choice)}</span>` : ''}${linkCoords(m.text)}</div>`).join('')
          || '<p class="muted">No reasoning yet.</p>');
    }
    const line = (m, r) => m.from < 0
      ? `<div class="msg sys">${r ? `<span class="room">${esc(r.name)}</span>` : ''}<small>${stamp(m)}</small>${esc(m.text)}</div>`
      : `<div class="msg">${r ? `<span class="room">${r.id === 0 ? '🌐' : '🔒'} ${esc(r.name)}</span>` : ''}${pdot(m.from)}${pname(m.from)}<small>${stamp(m)}</small>${linkCoords(m.text)}</div>`;
    if (chatRoom === 'all') {
      const all = rooms.flatMap(r => r.msgs.filter(m => m.from >= 0).map(m => [m, r]))    // generals only, no system lines
        .sort((a, b) => (b[0].seq || 0) - (a[0].seq || 0)).slice(0, 250);                // newest on top
      return grouped(all, ([m, r]) => line(m, r), ([m]) => m) || `<p class="muted">No conversations yet. The first summit is in turn ${next}.</p>`;
    }
    const r = rooms.find(x => String(x.id) === String(chatRoom));
    if (!r) return '';
    const info = r.id === 0 ? 'Public room of all generals.'
      : `Private room of ${r.members.map(gtitle).map(esc).join(', ')}, opened by ${esc(gtitle(r.by))} in turn ${r.opened}${r.open ? '' : `, closed in turn ${r.closed}`}.`;
    return `<p class="muted">${info}</p>` + (grouped(r.msgs.filter(m => m.from >= 0).reverse(), m => line(m, null), m => m) || '<p class="muted">No messages yet.</p>');
  }
  let channelsOpen = true;          // channel overview expanded?
  let closedOpen = false;           // list of closed rooms expanded?
  /**
   * Overview of the private channels: private channels as a matrix (general × general), group rooms below,
   * closed rooms collapsed. A cell shows the number of messages; active at the last summit = highlighted.
   */
  function channelPanel(rooms) {
    const priv = rooms.filter(r => r.id > 0);
    if (!priv.length) return '';
    const n = m => m.msgs.filter(x => x.from >= 0).length;
    const lastT = S.summit ? S.turn : S.summitLast ? S.summitLast.turn : -1;
    const hot = r => r.msgs.some(m => m.from >= 0 && m.turn === lastT);
    const ids = [...Array(S.players).keys()];
    const pair = (a, b) => priv.filter(r => r.members.length === 2 && r.members.includes(a) && r.members.includes(b))
      .sort((x, y) => (y.open - x.open) || y.id - x.id)[0];
    const sel = r => (String(chatRoom) === String(r.id) ? ' on' : '');
    const cell = (a, b) => {
      if (a === b) return '<td class="self"></td>';
      const r = pair(a, b);
      if (!r) return '<td class="none"></td>';
      return `<td><button data-room="${r.id}" class="pc${r.open ? '' : ' closed'}${hot(r) ? ' hot' : ''}${sel(r)}" title="${esc(r.name)} – ${esc(gtitle(a))} and ${esc(gtitle(b))}${r.open ? '' : ' (closed)'}">${n(r)}</button></td>`;
    };
    const matrix = `<table class="pairs"><thead><tr><th></th>${ids.map(q => `<th title="${esc(gtitle(q))}">${pdot(q)}</th>`).join('')}</tr></thead><tbody>` +
      ids.map(a => `<tr><th title="${esc(gtitle(a))}">${pdot(a)}<span>${esc(gname(a))}</span></th>${ids.map(b => cell(a, b)).join('')}</tr>`).join('') + '</tbody></table>';
    const groups = priv.filter(r => r.members.length > 2);
    const gbtn = r => `<button data-room="${r.id}" class="${r.open ? '' : 'closed'}${hot(r) ? ' hot' : ''}${sel(r)}">${esc(r.name)} ${r.members.map(pdot).join('')} <small>${n(r)}</small></button>`;
    const openG = groups.filter(r => r.open).sort((a, b) => b.id - a.id), closedAll = priv.filter(r => !r.open).sort((a, b) => b.id - a.id);
    const pairsOpen = priv.filter(r => r.open && r.members.length === 2).length;
    return `<details class="chans" id="chans"${channelsOpen ? ' open' : ''}><summary>🔒 Private channels – ${pairsOpen} private channels, ${openG.length} group rooms open${closedAll.length ? `, ${closedAll.length} closed` : ''}</summary>
      <div class="chanbody"><div><div class="sub">Private channels (number = messages, bright = active at the last summit)</div>${matrix}</div>
      <div><div class="sub">Group rooms</div><div class="glist">${openG.map(gbtn).join('') || '<span class="muted">none open</span>'}</div>
      ${closedAll.length ? `<details id="closedrooms"${closedOpen ? ' open' : ''}><summary>Closed (${closedAll.length})</summary><div class="glist">${closedAll.map(gbtn).join('')}</div></details>` : ''}</div></div></details>`;
  }

  function renderChat() {
    if (!S) return;
    const rooms = S.chat.rooms, sm = S.summit;
    const nMsg = rooms.reduce((a, r) => a + r.msgs.length, 0);
    const sig = [nMsg, S.chat.reasons.length, S.chat.summaries.length, sm ? sm.phase + sm.privRound + sm.pubRound : '', rooms.length, rooms.filter(r => r.open).length, chatRoom, summitBusy, sm ? sm.round : -1,
      S.generals, generalsAvail, S.summitLast ? S.summitLast.turn : 0, Math.floor(S.turn / REVIEW_EVERY),
      S.dip.gname.join(), S.dip.memory.reduce((a, m) => a + m.length, 0)].join('|');
    if (sig === chatSig) return;
    chatSig = sig;
    const next = Math.ceil((S.turn + 1) / REVIEW_EVERY) * REVIEW_EVERY;
    const L = S.summitLast;
    const status = !generalsAvail ? 'Claude not reachable (start the server with python serve.py) – rule-based diplomacy'
      : !S.generals ? 'off – rule-based diplomacy'
      : setupBusy ? '<span class="busy">⏳ Turn 0: the generals are being assigned and choose their names …</span>'
      : !S.setupDone ? 'Turn 0: "▶ Play" assigns the generals, followed by the First Meeting in the World Council'
      : summitBusy && sm ? `<span class="busy">⏳ ${sm.intro ? 'First Meeting (getting acquainted)' : 'Summit'} – ${sm.phase === 'private'
        ? `🔒 Back Room, private round ${sm.privRound} of at most ${PRIVATE_MAX}` : `🌐 World Council, round ${sm.pubRound} of ${PUBLIC_ROUNDS}${sm.last ? ' (decisions)' : ''}`} – the generals are thinking …</span>`
      : `next summit in turn ${next}` + (L && L.errors.length ? ` · at the last summit ${L.errors.length} answers were missing, the rule AI decided there` : '');
    const tab = (id, label, extra = '') => `<button data-room="${id}" class="${String(chatRoom) === String(id) ? 'on' : ''} ${extra}">${label}</button>`;
    const roomPanel = channelPanel(rooms);
    const old = document.getElementById('chatlog');
    const stick = !old || old.scrollTop < 40;   // was the reader at the top (at the newest)? Then stay at the top
    const keep = old ? old.scrollTop : 0;
    chatEl.innerHTML = `<div class="head"><b>Generals</b><span>${status}</span></div>
      <div class="tabs">${tab(0, `🌐 World Council <small>${rooms[0].msgs.filter(m => m.from >= 0).length}</small>`)}${tab('all', 'All rooms')}${tab('sum', `📋 Summary <small>${S.chat.summaries.length}</small>`, 'why')}${tab('why', `🎙 Reasoning <small>${S.chat.reasons.length}</small>`, 'why')}</div>
      ${roomPanel}
      <div id="chatlog">${chatBody()}</div>`;
    const nl = document.getElementById('chatlog');
    nl.scrollTop = stick ? 0 : keep;
  }
  chatEl.addEventListener('toggle', e => {
    if (e.target.id === 'chans') channelsOpen = e.target.open;
    if (e.target.id === 'closedrooms') closedOpen = e.target.open;
  }, true);
  const onCoord = e => {
    const a = e.target.closest && e.target.closest('[data-coord]');
    if (!a) return false;
    const [x, y] = a.dataset.coord.split(',').map(Number);
    jumpTo(x, y); return true;
  };
  chatEl.addEventListener('click', e => { if (onCoord(e)) e.stopImmediatePropagation(); }, true);
  side.addEventListener('click', e => { if (onCoord(e)) e.stopImmediatePropagation(); }, true);
  chatEl.addEventListener('click', e => {
    const b = e.target.closest('[data-room]'); if (!b) return;
    const v = b.dataset.room;
    chatRoom = v === 'all' || v === 'why' || v === 'sum' ? v : +v;
    chatSig = ''; renderChat();
    const nl = document.getElementById('chatlog'); if (nl) nl.scrollTop = 0;
  });

  /* ---------- Charts (military) ---------- */

  const CH = { w: 640, h: 210, l: 64, r: 12, t: 10, b: 26 };   // drawing area and margins of the line chart
  const niceMax = v => { const m = Math.max(5, v); const p = 10 ** Math.floor(Math.log10(m)); return Math.ceil(m / p * 2) / 2 * p; };
  const legend = ids => `<div class="legend">${ids.map(p => `<span>${pdot(p)}${esc(S.dip.gname[p] || gname(p))}${S.out[p] ? ' †' : ''}</span>`).join('')}</div>`;

  const geos = {};   // geometry per chart (for hover)
  /** Units per general over the turns. */
  const troopChart = () => lineChart('u', 'Units');
  /**
   * Line chart of one metric per general over the turns (at most ~200 points per line).
   * key = field in the history (u, c, sc, pop, pe, sup), unit = unit suffix for axis and tooltip.
   */
  function lineChart(key, label, unit = '') {
    const H = (S.hist || []).filter(h => h[key]);
    if (H.length < 2) return '<p class="muted">The history appears once the game is played.</p>';
    const step = Math.max(1, Math.ceil(H.length / 200)), pts = H.filter((_, i) => i % step === 0 || i === H.length - 1);
    const ids = [...Array(S.players).keys()];
    const maxY = niceMax(Math.max(...pts.flatMap(h => h[key])));
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t, W = CH.w - CH.l - CH.r, Hh = CH.h - CH.t - CH.b;
    const X = t => CH.l + (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * W, Y = v => CH.t + Hh - v / maxY * Hh;
    geos[key] = { pts, X, key, unit };
    const grid = [0, 0.5, 1].map(f => `<line x1="${CH.l}" x2="${CH.w - CH.r}" y1="${Y(maxY * f)}" y2="${Y(maxY * f)}" class="grid"/>
      <text x="${CH.l - 6}" y="${Y(maxY * f) + 4}" class="ax" text-anchor="end">${String(+(maxY * f).toFixed(1))}${unit}</text>`).join('');
    // summits as thin vertical lines, start of the war phase highlighted
    const summits = []; for (let t = Math.ceil(t0 / REVIEW_EVERY) * REVIEW_EVERY; t <= t1; t += REVIEW_EVERY) summits.push(t);
    const marks = summits.map(t => `<line x1="${X(t)}" x2="${X(t)}" y1="${CH.t}" y2="${CH.t + Hh}" class="tick"/>`).join('');
    const ticks = [t0, Math.round((t0 + t1) / 2), t1].map(t => `<text x="${X(t)}" y="${CH.h - 8}" class="ax" text-anchor="middle">T${t}</text>`).join('');
    const lines = ids.map(p => `<path d="${pts.map((h, i) => `${i ? 'L' : 'M'}${X(h.t).toFixed(1)},${Y(h[key][p] || 0).toFixed(1)}`).join('')}" stroke="${C.p[p]}" class="ln${S.out[p] ? ' out' : ''}"/>`).join('');
    return `<div class="chartbox"><svg class="lc" data-key="${key}" viewBox="0 0 ${CH.w} ${CH.h}" role="img" aria-label="${esc(label)} per general over the turns">${grid}${marks}${lines}${ticks}
      <line class="cross" x1="0" x2="0" y1="${CH.t}" y2="${CH.t + Hh}" style="display:none"/>
      <rect class="hit" x="${CH.l}" y="${CH.t}" width="${W}" height="${Hh}"/></svg><div class="tip" style="display:none"></div></div>` + legend(ids);
  }

  /** Transfers: one row per giving general, dots in the receiver's colour, size = number of units. */
  function transferChart() {
    const T = S.transferLog || [];
    if (!T.length) return '<p class="muted">No transfers yet. Generals can negotiate them at a summit.</p>';
    const ids = [...Array(S.players).keys()], rowH = 22, l = 120, w = 640, r = 16, h = ids.length * rowH + 30;
    const t0 = 0, t1 = Math.max(S.turn, ...T.map(x => x.turn)), X = t => l + (t - t0) / Math.max(1, t1 - t0) * (w - l - r);
    const rows = ids.map((p, i) => `<text x="${l - 8}" y="${i * rowH + 18}" class="ax" text-anchor="end">${esc(S.dip.gname[p] || gname(p))}</text>
      <line x1="${l}" x2="${w - r}" y1="${i * rowH + 14}" y2="${i * rowH + 14}" class="grid"/>`).join('');
    const dots = T.map(x => {
      const cy = x.p * rowH + 14, rr = Math.min(10, 3 + Math.sqrt(x.n) * 2);
      const what = Object.entries(x.done).map(([u, n]) => `${n}× ${UNIT_TYPES[u].name}`).join(', ');
      return `<g><title>Turn ${x.turn}: ${S.dip.gname[x.p] || gname(x.p)} (${gname(x.p)}) → ${S.dip.gname[x.q] || gname(x.q)} (${gname(x.q)}): ${what}</title>
        <circle cx="${X(x.turn)}" cy="${cy}" r="${rr}" fill="${C.p[x.q]}" class="dot2"/>
        <text x="${X(x.turn) + rr + 3}" y="${cy + 4}" class="ax">→${esc(gname(x.q))} ${x.n}</text></g>`;
    }).join('');
    const ticks = [0, Math.round(t1 / 2), t1].map(t => `<text x="${X(t)}" y="${h - 6}" class="ax" text-anchor="middle">T${t}</text>`).join('');
    return `<svg class="tc" viewBox="0 0 ${w} ${h}" role="img" aria-label="Unit transfers between generals">${rows}${dots}${ticks}</svg>
      <p class="muted">Row = who gives, dot colour = who receives, size = count. Hover over a dot to see the units.</p>`;
  }

  // hover over the line chart: crosshair and values of all generals in that turn
  side.addEventListener('mousemove', e => {
    const svg = e.target.closest && e.target.closest('svg.lc');
    const g = svg && geos[svg.dataset.key];
    if (!g) return;
    const box = svg.getBoundingClientRect(), x = (e.clientX - box.left) / box.width * CH.w;
    const { pts, X, key, unit } = g;
    let best = pts[0]; for (const h of pts) if (Math.abs(X(h.t) - x) < Math.abs(X(best.t) - x)) best = h;
    const cross = svg.querySelector('.cross'); cross.setAttribute('x1', X(best.t)); cross.setAttribute('x2', X(best.t)); cross.style.display = '';
    const tip = svg.parentNode.querySelector('.tip');
    const order = [...Array(S.players).keys()].sort((a, b) => best[key][b] - best[key][a]);
    tip.innerHTML = `<b>Turn ${best.t}</b>` + order.map(p => `<div>${pdot(p)}${esc(S.dip.gname[p] || gname(p))} <b>${String(best[key][p])}${unit}</b></div>`).join('');
    tip.style.display = ''; tip.style.left = Math.min(box.width - 170, (X(best.t) / CH.w) * box.width + 12) + 'px';
  });
  side.addEventListener('mouseout', e => {
    const box = e.target.closest && e.target.closest('.chartbox');
    if (!box || box.contains(e.relatedTarget)) return;
    const t = box.querySelector('.tip'), c = box.querySelector('.cross'); if (t) t.style.display = 'none'; if (c) c.style.display = 'none';
  });

  // metrics of the ranking chart
  const RANK_METRICS = [{ key: 'sc', label: 'Score', unit: '' }, { key: 'c', label: 'Cities', unit: '' },
    { key: 'pop', label: 'Population', unit: ' M' }, { key: 'pe', label: 'PP', unit: '' }, { key: 'sup', label: 'Supply', unit: ' %' }];
  let rankMetric = 'sc';

  /* ---------- Detail view below the map (cards) ---------- */

  function renderSide() {
    const card = (title, body, cls = '') => `<section class="card ${cls}"><h3>${title}</h3>${body}</section>`;
    // controls: narrow bar to the left of the map
    const off = S.winner != null ? ' disabled' : '';
    const ctl = `<div class="rnd">Turn<b>${needsSetup() ? '0' : S.turn}</b></div>
      <div class="phase ${S.warOpen ? 'war' : ''}" title="${S.warOpen ? 'Wars may be declared' : `Wars only from ${warThreshold(S)} neutral cities`}">${S.warOpen ? 'War phase' : 'Peace phase'}<small>${neutralLeft(S)} neutral${S.warOpen ? '' : ` · war at ${warThreshold(S)}`}</small></div>
      ${S.winner != null ? `<div class="banner win">${esc(playerName(S, S.winner))} wins</div>` : ''}
      <button data-act="play" class="primary"${off} title="Play continuously (space bar)">${playing && !toNext ? '⏸ Pause' : '▶ Play'}</button>
      <button data-act="next"${off}${toNext ? ' class="primary"' : ''} title="Play quickly to the next summit, let them negotiate, then stop">${toNext ? '⏩ running …' : '⏭ To summit'}</button>
      <button data-act="end"${off} title="Advance one turn (Enter)">+1 Turn</button>
      <div class="sep"></div>
      <select id="nai" title="Number of generals for the next game">${[2, 3, 4, 5, 6, 7, 8].map(n =>
          `<option value="${n - 1}"${n - 1 === nAI ? ' selected' : ''}>${n} generals</option>`).join('')}</select>
      <select id="mapscale" title="Map size for the next game (area; base 144 × 84 tiles). Large maps compute more slowly.">${MAP_SCALES.map(f =>
          `<option value="${f}"${f === mapScale ? ' selected' : ''}>Map ×${String(f)}</option>`).join('')}</select>
      <button data-act="new" title="New game with a new map">New game</button>
      ${generalsAvail ? '' : '<div class="warn" title="Start the server with python serve.py, otherwise the generals negotiate by fixed rules">Claude not reachable</div>'}`;
    ctlEl.innerHTML = ctl;

    const ranked = [...Array(S.players).keys()].map(p => ({ p, pts: score(S, p) }))
      .sort((a, b) => (S.out[a.p] - S.out[b.p]) || b.pts - a.pts);
    const dots = (p, r) => [...Array(S.players).keys()].filter(q => q !== p && !S.out[q] && S.dip.rel[p][q] === r)
      .map(q => `<i class="dot" title="${esc(playerName(S, q))}" style="background:${C.p[q]}"></i>`).join('') || '<span class="muted">–</span>';
    const nameCell = p => `<td title="${esc(gname(p))}${S.generals ? ` · ${PERSONAS[S.dip.persona[p]].name}` : ''}"><i class="dot" style="background:${C.p[p]}"></i>${esc(S.dip.gname[p] || gname(p))}${S.out[p] ? ' †' : ''}</td>`;
    const rank = `<table class="tbl"><thead><tr><th class="num">#</th><th>General</th><th>Bonus</th>
      <th class="num" title="Score = cities × 10 + production (PP) × 5 + units">Score</th><th class="num">Cities</th><th class="num" title="Population of all cities in millions">Pop. M</th><th class="num">PP</th>
      <th class="num" title="Supply utilisation">Supply</th><th title="Allies">Alliance</th><th title="Enemies at war">War</th></tr></thead><tbody>`
      + ranked.map(({ p, pts }, k) => {
        const sp = supply(S, p), pc = sp.prod > 0 ? Math.round(sp.need / sp.prod * 100) : 0;
        return `<tr data-jump="${p}" class="${S.out[p] ? 'done' : ''}" style="cursor:pointer"><td class="num">${S.out[p] ? '–' : k + 1}</td>${nameCell(p)}
          <td title="${ROLES[S.roles[p]].name}: ${ROLES[S.roles[p]].note}">${ROLES[S.roles[p]].short}</td><td class="num"><b>${pts}</b></td>
          <td class="num">${S.cities.filter(c => c.owner === p).length}</td><td class="num">${fmt(S.cities.reduce((a, c) => a + (c.owner === p ? c.pop : 0), 0) / 1e6, 1)}</td><td class="num">${fmt(sp.prod, 1)}</td><td class="num">${pc} %</td>
          <td>${S.out[p] ? '' : dots(p, 'ally')}</td><td>${S.out[p] ? '' : dots(p, 'war')}</td></tr>`;
      }).join('') + `</tbody></table>`;
    const mil = `<table class="tbl"><thead><tr><th>General</th><th class="num" title="Land units">Land</th><th class="num" title="Ships">Sea</th>
      <th class="num" title="Aircraft and missiles in stock">Air</th><th class="num" title="Missiles fired">Msl.↑</th><th class="num" title="Missile hits on own cities">Msl.↓</th>
      <th class="num" title="Enemy production destroyed by own missiles, in PP">destr.</th></tr></thead><tbody>`
      + ranked.map(({ p }) => `<tr data-jump="${p}" class="${S.out[p] ? 'done' : ''}" style="cursor:pointer">${nameCell(p)}${['land', 'sea', 'air'].map(d =>
          `<td class="num">${S.units.filter(u => u.owner === p && UNIT_TYPES[u.type].domain === d).length}</td>`).join('')}
        <td class="num">${S.missiles.fired[p]}</td><td class="num">${S.missiles.taken[p]}</td><td class="num">${fmt(S.missiles.destroyed[p], 1)}</td></tr>`).join('') + `</tbody></table>`;
    const milFull = `<div class="milgrid"><div>${mil}</div>
      <div><div class="sub">Units per general over the turns (vertical lines = summits)</div>${troopChart()}</div>
      <div><div class="sub">Transfers: who gave troops to whom and when</div>${transferChart()}</div></div>`;
    const M = RANK_METRICS.find(m => m.key === rankMetric) || RANK_METRICS[0];
    const rankFull = `<div class="rankgrid"><div>${rank}</div><div>
      <div class="btns metric">${RANK_METRICS.map(m => `<button data-metric="${m.key}" class="${m.key === M.key ? 'on' : ''}">${m.label}</button>`).join('')}</div>
      ${lineChart(M.key, M.label, M.unit)}</div></div>`;
    side.innerHTML = card('Ranking', rankFull, 'full') + card('Military', milFull, 'full') +
      card(`⚖ Resolutions${S.summitLast ? ` – Summit Turn ${S.summitLast.turn}` : ''}`, decHTML(), 'full') +
      card('👤 Generals', genHTML(), 'full');
  }

  /* ---------- Camera ---------- */

  function centerOn(x, y) {
    cam.x = mod(Math.round(x * TILE + TILE / 2 - cv.width / 2), WW());
    cam.y = mod(Math.round(y * TILE + TILE / 2 - cv.height / 2), WH());
  }

  /** Brings a tile into view if it is outside or too close to the edge. */
  function focus(o) {
    if (offX() && offY()) return;   // world view: everything is in view anyway
    const sx = mod(o.x * TILE - cam.x, WW()), sy = mod(o.y * TILE - cam.y, WH()), m = TILE * 2;
    if (sx < m || sx > cv.width - m - TILE || sy < m || sy > cv.height - m - TILE) centerOn(o.x, o.y);
  }

  // observer mode: turns run automatically on a timer
  function setPlaying(on) {
    playing = !!on && S && S.winner == null;
    if (!playing) toNext = false;
    clearTimeout(timer);
    if (playing) timer = setTimeout(tick, toNext ? 10 : speed);
  }
  // In fast mode as many turns are computed as fit into ~40 ms, and only then drawn once.
  // The side panel (lots of HTML) is rebuilt at most every 250 ms, the map on every frame.
  let lastSide = 0;
  function tick() {
    if (!playing) return;
    if (needsSetup()) { render(); return runSetup(); }        // turn 0: line-up, then it continues by itself
    if (S.pendingSummit) { render(); return holdSummit(); }    // summit: game pauses, then it continues by itself
    const t0 = performance.now();
    const fast = toNext;   // until the next negotiation: as many turns per frame as fit into ~40 ms
    do observerRound(S); while (fast && S.winner == null && !S.pendingSummit && performance.now() - t0 < 40);
    if (S.pendingSummit && S.winner == null) { render(); return holdSummit(); }
    if (S.winner != null) { playing = false; toNext = false; }
    const now = performance.now();
    if (!playing || !fast || now - lastSide > 250) { render(); lastSide = now; } else draw();
    if (playing) timer = setTimeout(tick, fast ? 10 : speed);
  }

  function act(a) {
    if (a === 'new') return start(Math.floor(Math.random() * 1e9));
    if (a === 'again') return start(Math.floor(Math.random() * 1e9), cur);   // same settings, new map
    if (a === 'same') return start(S.seed, cur);                             // same settings, same map
    if (a === 'play') { toNext = false; setPlaying(!playing); return render(); }        // keep running
    if (a === 'next') { if (summitBusy || setupBusy || S.winner != null) return; toNext = true; setPlaying(true); return render(); }
    if (a === 'zoomin' || a === 'zoomout' || a === 'world') {
      if (a === 'world') toggleWorld(); else zoomStep(a === 'zoomin' ? 1 : -1);
      return render();
    }
    if (S.winner != null || summitBusy || setupBusy) return;
    if (a === 'end') {
      if (needsSetup()) return runSetup();     // first step: turn 0 (line-up) and First Meeting
      observerRound(S); if (S.pendingSummit) holdSummit();
    }
    render();
  }

  // drag the map with the left mouse button held
  let drag = null, dragged = false;
  cv.addEventListener('mousedown', e => { if (e.button === 0) { drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y }; dragged = false; } });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 5) return;
    dragged = true;
    cam.x = mod(drag.cx - dx, WW()); cam.y = mod(drag.cy - dy, WH());
    draw();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  // mouse wheel zooms; the tile under the cursor stays in place. Pan: drag the map.
  let wheelAcc = 0;
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 40) return;             // touchpads deliver many small steps
    const dir = wheelAcc < 0 ? 1 : -1; wheelAcc = 0;
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const fx = (mx - offX() + camX()) / TILE, fy = (my - offY() + camY()) / TILE;   // tile under the mouse
    const before = TILE;
    zoomStep(dir);
    if (TILE === before) return;
    cam.x = mod(Math.round(fx * TILE - mx), WW());
    cam.y = mod(Math.round(fy * TILE - my), WH());
    render();
  }, { passive: false });

  cv.addEventListener('click', () => { dragged = false; });

  /* ---------- Map tooltip: city and units on the tile under the mouse ---------- */
  const mapTip = document.createElement('div');
  mapTip.className = 'maptip'; mapTip.style.display = 'none';
  wrap.appendChild(mapTip);
  const tileAt = e => {
    const r = cv.getBoundingClientRect();
    return [mod(Math.floor((e.clientX - r.left - offX() + camX()) / TILE), S.W), mod(Math.floor((e.clientY - r.top - offY() + camY()) / TILE), S.H)];
  };
  /** Stats of a single unit for the tooltip (one line, cargo indented below). */
  function unitInfo(u, sub = false) {
    const T = UNIT_TYPES[u.type], parts = [];
    parts.push(`HP ${u.hp}/${T.hp}`);
    if (T.moves) parts.push(`Moves ${u.moves}/${movesOf(S, u)}`);
    if (T.att) parts.push(`Attack ${T.att}`);
    parts.push(`Defence ${T.def}`);
    if (T.fuel) parts.push(`<span class="${u.fuel <= T.moves ? 'warn' : ''}">Fuel ${u.fuel}/${T.fuel}</span> (range left ${u.fuel} tiles)`);
    if (T.range) parts.push(`Range ${isFinite(T.range) ? T.range + ' tiles' : 'unlimited'}, single use${T.nuke ? ', obliterates a city' : `, kills ${MISSILE_DAMAGE.map(v => Math.round(v * 100)).join('–')} % of the population`}`);
    parts.push(`Vision ${T.vision}`);
    parts.push(`Supply ${fmt(unitUpkeep(S, u.owner, u.type))} PP`);
    if (u.type === 'sub') parts.push(cityAt(S, u.x, u.y) ? 'visible in harbour' : 'submerged');
    const state = [u.repair && 'under repair', u.sentry && 'sentry', u.garrison && 'garrison', u.mission && 'on mission', u.dest && `target (${u.dest.x},${u.dest.y})`].filter(Boolean);
    if (state.length) parts.push(state.join(', '));
    let h = `<div class="${sub ? 'cargo' : 'ui'}"><b>${esc(T.name)}</b> <span class="muted">${parts.join(' · ')}</span></div>`;
    if (T.capacity) {
      const cg = cargoOf(S, u);
      h += `<div class="cargo muted">Cargo ${cg.length}/${T.capacity}${cg.length ? ':' : ' – empty'}</div>` + cg.map(x => unitInfo(x, true)).join('');
    }
    return h;
  }
  /** All units on the tile, one by one (at most 10, same types next to each other). */
  function unitLines(units) {
    const list = [...units].sort((a, b) => a.type.localeCompare(b.type) || b.hp - a.hp);
    return list.slice(0, 10).map(u => unitInfo(u)).join('') + (list.length > 10 ? `<div class="muted">… and ${list.length - 10} more</div>` : '');
  }
  cv.addEventListener('mousemove', e => {
    if (!S || drag) { mapTip.style.display = 'none'; return; }
    const [x, y] = tileAt(e), c = cityAt(S, x, y);
    const here = S.units.filter(u => u.x === x && u.y === y && u.carrier == null && (viewMode === 'all' || seen(u, view().vis)));
    if (!c && !here.length) { mapTip.style.display = 'none'; return; }
    const owner = c ? c.owner : here[0].owner;
    const who = owner < 0 ? 'neutral' : `${pdot(owner)}${esc(S.dip.gname[owner] || gname(owner))} <span class="muted">(${esc(gname(owner))})</span>`;
    let h = '';
    if (c) {
      const K = CITY_KINDS[c.kind];
      h += `<div class="tt">${esc(K.name)} (${x},${y})${c.coastal ? ' ⚓' : ''}</div><div>${who}</div>
        <div class="muted">${fmtPop(c.pop)} population · ${fmt(c.cap)} PP · Defence ×${fmt(K.def, 1)}${c.owner >= 0 ? ` · building ${c.prod === GROW ? 'Civil Protection' : esc(UNIT_TYPES[c.prod].name)}` : ''}</div>`;
      if (c.owner >= 0 && S.capital && S.capital[c.owner] === c) h += '<div class="muted">★ Capital</div>';
      if (c.owner < 0) h += `<div class="muted">Militia defends (Defence ×${fmt(K.militia, 2)})</div>`;
    } else h += `<div class="tt">Tile (${x},${y})</div><div>${who}</div>`;
    h += here.length ? `<div class="sub2">Units (${here.length})</div>${unitLines(here)}` : (c && c.owner >= 0 ? '<div class="muted">no units in the city</div>' : '');
    mapTip.innerHTML = h;
    mapTip.style.display = '';
    const r = wrap.getBoundingClientRect(), tw = mapTip.offsetWidth, th = mapTip.offsetHeight;
    let lx = e.clientX - r.left + 16, ly = e.clientY - r.top + 16;
    if (lx + tw > r.width) lx = e.clientX - r.left - tw - 12;
    if (ly + th > r.height) ly = e.clientY - r.top - th - 12;
    mapTip.style.left = Math.max(4, lx) + 'px'; mapTip.style.top = Math.max(4, ly) + 'px';
  });
  cv.addEventListener('mouseleave', () => { mapTip.style.display = 'none'; });

  mini.addEventListener('click', e => {
    const r = mini.getBoundingClientRect();
    centerOn((e.clientX - r.left) / r.width * S.W - 0.5, (e.clientY - r.top) / r.height * S.H - 0.5);
    draw();
  });

  new ResizeObserver(() => { if (S) { fit(); draw(); } }).observe(wrap);

  const onPanelClick = e => {
    const mb = e.target.closest('[data-metric]');
    if (mb) { rankMetric = mb.dataset.metric; return renderSide(); }
    const b = e.target.closest('[data-act],[data-jump]'); if (!b) return;
    if (b.dataset.jump) {   // camera to a general's units (otherwise the first city)
      const p = +b.dataset.jump; if (S.out[p]) return;
      const t = S.units.find(u => u.owner === p && !cityAt(S, u.x, u.y)) || S.cities.find(c => c.owner === p);
      if (t) { centerOn(t.x, t.y); draw(); }
      return;
    }
    if (b.dataset.act) return act(b.dataset.act);
  };
  const onPanelChange = e => { if (e.target.id === 'nai') nAI = +e.target.value; if (e.target.id === 'mapscale') mapScale = +e.target.value; };
  for (const el of [side, ctlEl]) { el.addEventListener('click', onPanelClick); el.addEventListener('change', onPanelChange); }

  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === ' ') { e.preventDefault(); act('play'); }
    else if (k === '+') act('zoomin');
    else if (k === '-') act('zoomout');
    else if (k === '0' || k === 'w') act('world');
    else if (k === 'Enter') { e.preventDefault(); act('end'); }
  });

  start(Math.floor(Math.random() * 1e9));
})();
