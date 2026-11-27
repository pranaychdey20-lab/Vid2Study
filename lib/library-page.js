/**
 * The master page of a saved library (Vid2Study.html), also shown inside the extension (library-open.html).
 * It opens by double-click from any drive, needs no server and loads nothing from the internet; its script lives once in the library
 * folder (.vid2study/library.js = lib/library-ui.js), shared with the extension's page. The saved lectures are linked with relative
 * paths, so the folder can be moved or copied.
 *
 * The look is a dark dashboard: charcoal panels, one orange accent, a sidebar with a sliding active pill,
 * a top bar with search, a hero with a rotating stack of subject covers, and a lecture table. Light mode keeps the same structure and
 * accent on warm paper. Without JavaScript the sidebar is still a complete list of links (written into the page, then enhanced).
 */
const esc = (value) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const href = (row) => './' + row.path.map(encodeURIComponent).join('/');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** subject -> module -> category -> lectures, in reading order. */
export function shelve(entries) {
  const subjects = new Map();
  for (const row of entries) {
    const modules = subjects.get(row.subject) || subjects.set(row.subject, new Map()).get(row.subject);
    const categories = modules.get(row.module) || modules.set(row.module, new Map()).get(row.module);
    (categories.get(row.category) || categories.set(row.category, []).get(row.category)).push(row);
  }
  const sortMap = (map) => new Map([...map.entries()].sort(([a], [b]) => natural(a, b)));
  return new Map([...subjects.entries()].sort(([a], [b]) => natural(a, b)).map(([name, modules]) => [name,
    new Map([...sortMap(modules)].map(([m, cats]) => [m, new Map([...sortMap(cats)].map(([c, rows]) => [c, rows.sort((x, y) => natural(x.title, y.title))]))]))]));
}

const PLAIN = new Set(['General', 'Lectures']);

function staticTree(shelf) {
  let out = '';
  for (const [subject, modules] of shelf) {
    const count = [...modules.values()].flatMap(c => [...c.values()]).reduce((n, rows) => n + rows.length, 0);
    out += '<details class="t-subject"><summary><span>' + esc(subject) + '</span><small>' + count + '</small></summary>';
    for (const [module, cats] of modules) {
      const showModule = !(PLAIN.has(module) && modules.size === 1);
      out += (showModule ? '<div class="t-module"><div class="t-label">' + esc(module) + '</div>' : '<div>');
      for (const [category, rows] of cats) {
        if (!(PLAIN.has(category) && cats.size === 1)) out += '<div class="t-category">' + esc(category) + '</div>';
        out += '<ul>' + rows.map(row => '<li><a href="' + esc(href(row)) + '" data-id="' + esc(row.id) + '">' + esc(row.title) + '</a></li>').join('') + '</ul>';
      }
      out += '</div>';
    }
    out += '</details>';
  }
  return out;
}

const CSS = String.raw`
:root { color-scheme: dark; --bg:#150f0c; --shell:#121215; --panel:#18181c; --panel2:#1f1f25; --raise:#26262d; --line:rgba(255,255,255,.075); --line2:rgba(255,255,255,.13);
  --ink:#f5f5f7; --muted:#8e8e99; --soft:#b9b9c4; --accent:#ff8a2b; --accent2:#f2701a; --accent-ink:#1b0f05; --glow:rgba(255,138,43,.38); --good:#38d38a; --bad:#ff6161; --shadow:rgba(0,0,0,.55);
  --grad:linear-gradient(135deg,#ffab57,#f2701a); --paper:#fff; --thumb:#6b6b78; --track:#1b1b21;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif; --sans:"Segoe UI Variable Display","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif; --ease:cubic-bezier(.22,.8,.24,1); }
:root[data-theme=light] { color-scheme: light; --bg:#f1e6da; --shell:#fffdf9; --panel:#ffffff; --panel2:#f6f0e8; --raise:#efe6da; --line:rgba(40,25,10,.09); --line2:rgba(40,25,10,.17); --ink:#1f1a16; --muted:#7d7266; --soft:#54493f;
  --accent:#ef7a12; --accent2:#d9650a; --accent-ink:#fff; --glow:rgba(239,122,18,.3); --shadow:rgba(80,50,20,.22); --grad:linear-gradient(135deg,#ff9d3f,#ea6b0c); --thumb:#b9a994; --track:#efe6da; }
@media (prefers-color-scheme: light) { :root:not([data-theme=dark]) { color-scheme: light; --bg:#f1e6da; --shell:#fffdf9; --panel:#ffffff; --panel2:#f6f0e8; --raise:#efe6da; --line:rgba(40,25,10,.09); --line2:rgba(40,25,10,.17); --ink:#1f1a16; --muted:#7d7266; --soft:#54493f;
  --accent:#ef7a12; --accent2:#d9650a; --accent-ink:#fff; --glow:rgba(239,122,18,.3); --shadow:rgba(80,50,20,.22); --grad:linear-gradient(135deg,#ff9d3f,#ea6b0c); --thumb:#b9a994; --track:#efe6da; } }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; color: var(--ink); font: 14.5px/1.55 var(--sans); background: var(--shell); overflow: hidden; }
body.ask-docked { padding-right: 0 !important; }
a { color: inherit; } button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

/* the window: the whole page (no backdrop, no margin, no rounded frame) */
.shell { position: relative; display: grid; grid-template-columns: 17.5rem minmax(0, 1fr); height: 100vh; background: var(--shell); overflow: hidden; animation: shell-in .6s var(--ease) both; transition: grid-template-columns .4s var(--ease); }
@keyframes shell-in { from { opacity: 0; } }
.shell.reading { grid-template-columns: 0 minmax(0, 1fr); }
.shell.reading .side { transform: translateX(-100%); visibility: hidden; opacity: 0; }
/* the assistant docks beside the page, also in full screen */
body.ask-docked .shell { width: calc(100vw - var(--ask-w, 420px)); }

/* sidebar */
.side { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--shell); border-right: 1px solid var(--line); transition: transform .4s var(--ease), opacity .3s, visibility .4s; }
.brand { display: flex; align-items: center; gap: .7rem; padding: 1.15rem 1.2rem .9rem; text-decoration: none; }
.brand svg { width: 34px; height: 34px; flex: none; filter: drop-shadow(0 4px 12px var(--glow)); }
.brand b { display: block; font: 700 1.28rem/1.1 var(--sans); letter-spacing: -.01em; }
.brand span { display: block; color: var(--muted); font-size: 12px; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 .75rem 1rem; }
.group { margin: 1.1rem .5rem .4rem; color: var(--muted); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; }
.nav { position: relative; display: flex; flex-direction: column; gap: 2px; }
.nav a, .nav button { position: relative; z-index: 1; display: flex; align-items: center; gap: .75rem; width: 100%; padding: .62rem .8rem; border: 0; border-radius: 12px; background: none; color: var(--soft); text-align: left; text-decoration: none; cursor: pointer; font-size: 14.5px; transition: color .2s, background .2s, transform .2s var(--ease); }
.nav a:hover, .nav button:hover { color: var(--ink); background: rgba(255,255,255,.045); transform: translateX(3px); }
:root[data-theme=light] .nav a:hover, :root[data-theme=light] .nav button:hover { background: rgba(60,40,20,.05); }
.nav a svg, .nav button svg { width: 18px; height: 18px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.nav small { margin-left: auto; padding: 0 .45rem; border-radius: 999px; background: var(--raise); color: var(--muted); font-size: 11.5px; line-height: 1.55; }
.nav a[aria-current=page] { color: var(--accent-ink); font-weight: 600; background: var(--grad); box-shadow: 0 10px 24px -10px var(--glow), 0 0 0 1px rgba(255,255,255,.12) inset; }
.nav a[aria-current=page] small { background: rgba(0,0,0,.18); color: var(--accent-ink); }
.tree details { margin: 0; }
.t-subject > summary { display: flex; align-items: center; gap: .55rem; padding: .5rem .8rem; border-radius: 12px; cursor: pointer; list-style: none; color: var(--soft); font-size: 14px; transition: background .2s, color .2s; }
.t-subject > summary::-webkit-details-marker { display: none; }
.t-subject > summary::before { content: ""; width: .42rem; height: .42rem; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform .25s var(--ease); flex: none; }
.t-subject[open] > summary::before { transform: rotate(45deg); }
.t-subject > summary:hover { background: rgba(255,255,255,.045); color: var(--ink); }
.t-subject > summary span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-subject > summary small { color: var(--muted); font-size: 11.5px; }
.t-module, .t-subject > div { margin: .1rem 0 .3rem .9rem; padding-left: .6rem; border-left: 1px solid var(--line); }
.t-label, .t-category { margin: .35rem 0 .1rem; color: var(--muted); font-size: 12px; }
.tree ul { list-style: none; margin: 0; padding: 0; }
.tree li a { display: block; padding: .32rem .65rem; border-radius: 9px; color: var(--soft); text-decoration: none; font-size: 13.5px; line-height: 1.35; transition: background .2s, color .2s, transform .2s var(--ease); }
.tree li a:hover { background: rgba(255,255,255,.05); color: var(--ink); transform: translateX(3px); }
.tree li a[aria-current=page] { background: var(--grad); color: var(--accent-ink); font-weight: 600; }
.tree li[hidden], .tree details[hidden] { display: none; }
.side-foot { display: flex; align-items: center; gap: .5rem; padding: .8rem 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
.side-foot .sp { flex: 1; }

/* top bar */
.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--panel); }
.top { display: flex; align-items: center; gap: .7rem; padding: .8rem 1.3rem; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,255,255,.025), transparent); }
.find { position: relative; flex: 1; max-width: 34rem; }
.find input { width: 100%; padding: .62rem 3rem .62rem 2.4rem; border: 1px solid var(--line); border-radius: 12px; background: var(--panel2); color: var(--ink); font: inherit; font-size: 14px; transition: border-color .2s, box-shadow .2s; }
.find input::placeholder { color: var(--muted); }
.find input:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
.find svg { position: absolute; left: .8rem; top: 50%; width: 16px; height: 16px; margin-top: -8px; stroke: var(--muted); fill: none; stroke-width: 2; stroke-linecap: round; }
.find kbd { position: absolute; right: .6rem; top: 50%; transform: translateY(-50%); padding: .05rem .45rem; border: 1px solid var(--line2); border-radius: 6px; color: var(--muted); font: 11.5px var(--sans); }
.shell.reading .find { display: none; }
.crumbs { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 13.5px; }
.crumbs[hidden] { display: none; }
.crumbs a { text-decoration: none; transition: color .2s; } .crumbs a:hover { color: var(--accent); } .crumbs b { color: var(--ink); font-weight: 600; }
.chip { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; min-width: 2.35rem; height: 2.35rem; padding: 0 .75rem; border: 1px solid var(--line); border-radius: 11px; background: var(--panel2); color: var(--soft); text-decoration: none; cursor: pointer; font-size: 13.5px; transition: border-color .2s, color .2s, transform .2s var(--ease), background .2s; white-space: nowrap; }
.chip:hover { border-color: var(--accent); color: var(--ink); transform: translateY(-1px); }
.chip svg { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.chip[aria-pressed=true] { color: var(--accent); border-color: var(--accent); }
.chip.on { background: var(--grad); color: var(--accent-ink); border-color: transparent; }
.chip:disabled { opacity: .45; cursor: default; transform: none; }
.menu { display: none; }
.shell.reading .menu { display: inline-flex; }
.actions { display: flex; gap: .4rem; align-items: center; margin-left: auto; }
.toolbar { position: sticky; top: 0; z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .65rem 1.3rem; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 88%, transparent); backdrop-filter: blur(12px); }
.toolbar [hidden] { display: none !important; }
.toolbar .note { margin-left: auto; color: var(--muted); font-size: 12.5px; }

/* pages */
.stage { flex: 1; min-height: 0; overflow-y: auto; }
/* scroll bars you can see: a lighter thumb on a visible track, orange when held */
.stage, .scroll, .tabs { scrollbar-width: auto; scrollbar-color: var(--thumb) var(--track); }
.stage::-webkit-scrollbar, .scroll::-webkit-scrollbar { width: 13px; height: 13px; }
.stage::-webkit-scrollbar-track, .scroll::-webkit-scrollbar-track { background: var(--track); }
.stage::-webkit-scrollbar-thumb, .scroll::-webkit-scrollbar-thumb { border: 3px solid var(--track); border-radius: 999px; background: var(--thumb); }
.stage::-webkit-scrollbar-thumb:hover, .scroll::-webkit-scrollbar-thumb:hover, .stage::-webkit-scrollbar-thumb:active { background: var(--accent); }
.stage > .page { animation: page-in .55s var(--ease) both; }
@keyframes page-in { from { opacity: 0; transform: translateY(14px); } }
.page { max-width: 74rem; margin: 0 auto; padding: 1.8rem clamp(1.1rem, 3.4vw, 2.6rem) 3.5rem; }
.reader { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.paper { background: var(--paper); color: #000; min-height: 100%; }
.hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 2.4rem; align-items: center; min-height: 20rem; }
.hero > :last-child { min-width: 0; }
.hero h1 { margin: 0; font: 700 clamp(2.2rem, 4.4vw, 3.5rem)/1.04 var(--sans); letter-spacing: -.025em; }
.hero h1 em { font-style: normal; background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero p { margin: 1rem 0 0; max-width: 32rem; color: var(--soft); }
.cta { display: flex; flex-wrap: wrap; gap: .7rem; margin-top: 1.5rem; }
.btn { position: relative; overflow: hidden; display: inline-flex; align-items: center; gap: .55rem; padding: .7rem 1.25rem; border: 1px solid transparent; border-radius: 12px; background: var(--grad); color: var(--accent-ink); font-weight: 600; text-decoration: none; cursor: pointer; box-shadow: 0 12px 28px -12px var(--glow); transition: transform .25s var(--ease), box-shadow .25s; }
.btn::after { content: ""; position: absolute; inset: 0; background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,.5) 50%, transparent 70%); transform: translateX(-120%); }
.btn:hover { transform: translateY(-2px); box-shadow: 0 18px 34px -12px var(--glow); }
.btn:hover::after { transform: translateX(120%); transition: transform .7s var(--ease); }
.btn.ghost { background: var(--panel2); color: var(--ink); border-color: var(--line2); box-shadow: none; }
.btn small { display: block; font-weight: 400; opacity: .8; font-size: 12px; }

/* the rotating stack of subject covers */
.deckwrap { overflow: hidden; padding: 2.2rem 0 .4rem; }
.deck { position: relative; height: 16.5rem; perspective: 1100px; }
.card { position: absolute; left: 50%; top: 0; width: 11.5rem; height: 14.5rem; margin-left: -5.75rem; display: flex; flex-direction: column; justify-content: space-between; padding: 1.1rem; border-radius: 18px; color: #fff; text-decoration: none;
  background: linear-gradient(160deg, var(--c1), var(--c2)); box-shadow: 0 30px 50px -22px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.16) inset; transition: transform .75s var(--ease), opacity .6s, filter .6s; transform-style: preserve-3d; will-change: transform; overflow: hidden; }
.card::before { content: ""; position: absolute; inset: 0; background: radial-gradient(120% 70% at 20% 0%, rgba(255,255,255,.28), transparent 60%), repeating-linear-gradient(135deg, rgba(255,255,255,.05) 0 2px, transparent 2px 10px); pointer-events: none; }
.card::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 45%; background: linear-gradient(transparent, rgba(0,0,0,.55)); pointer-events: none; }
.card h3 { position: relative; z-index: 1; margin: 0; font: 700 1.25rem/1.15 var(--serif); text-shadow: 0 2px 10px rgba(0,0,0,.35); overflow-wrap: anywhere; }
.card span { position: relative; z-index: 1; font-size: 12.5px; opacity: .92; }
.card .tag { align-self: flex-start; padding: .15rem .55rem; border-radius: 999px; background: rgba(0,0,0,.32); backdrop-filter: blur(6px); font-size: 11.5px; }
.card[data-pos="0"] { transform: translateX(0) translateZ(40px) rotateY(0) scale(1.04); z-index: 3; }
.card[data-pos="1"] { transform: translateX(6.4rem) translateZ(-30px) rotateY(-24deg) scale(.88); z-index: 2; filter: brightness(.7); }
.card[data-pos="-1"] { transform: translateX(-6.4rem) translateZ(-30px) rotateY(24deg) scale(.88); z-index: 2; filter: brightness(.7); }
.card[data-pos="far"] { transform: translateX(0) translateZ(-160px) scale(.6); opacity: 0; z-index: 0; pointer-events: none; }
.card[data-pos="0"]:hover { transform: translateX(0) translateZ(70px) rotateY(-4deg) rotateX(3deg) scale(1.07); }
.deck-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-top: .6rem; }
.deck-meta b { font: 700 1.2rem/1.2 var(--sans); } .deck-meta span { color: var(--muted); font-size: 13px; }
.dashes { display: flex; gap: .3rem; margin-top: .7rem; }
.dashes i { flex: 1; height: 3px; border-radius: 3px; background: var(--line2); overflow: hidden; cursor: pointer; }
.dashes i.on::after { content: ""; display: block; height: 100%; background: var(--accent); animation: fill 4.8s linear both; }
@keyframes fill { from { width: 0; } to { width: 100%; } }

/* sections and the lecture table */
h2.sec { display: flex; align-items: center; gap: .8rem; margin: 2.2rem 0 .9rem; font: 700 1.25rem/1.2 var(--sans); letter-spacing: -.01em; }
h2.sec small { color: var(--muted); font: 400 13px var(--sans); }
.tabs { display: flex; align-items: center; gap: .3rem; overflow-x: auto; padding-bottom: .2rem; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab { flex: none; padding: .42rem .95rem; border: 0; border-radius: 999px; background: none; color: var(--muted); cursor: pointer; font-size: 13.5px; transition: color .2s, background .2s, transform .2s var(--ease); }
.tab:hover { color: var(--ink); background: rgba(255,255,255,.05); }
.tab[aria-selected=true] { background: var(--grad); color: var(--accent-ink); font-weight: 600; box-shadow: 0 8px 18px -10px var(--glow); }
.table { width: 100%; margin-top: .7rem; border-collapse: separate; border-spacing: 0 6px; }
.table th { padding: .4rem 1rem; color: var(--muted); font-weight: 500; font-size: 12.5px; text-align: left; white-space: nowrap; }
.table td { padding: .85rem 1rem; background: var(--panel2); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); vertical-align: middle; transition: background .25s, border-color .25s; }
.table td:first-child { width: 3.2rem; color: var(--muted); border-left: 1px solid var(--line); border-radius: 14px 0 0 14px; font-variant-numeric: tabular-nums; }
.table td:last-child { border-right: 1px solid var(--line); border-radius: 0 14px 14px 0; text-align: right; color: var(--muted); white-space: nowrap; }
.table tr.row { cursor: pointer; animation: row-in .5s var(--ease) both; animation-delay: calc(var(--i, 0) * 45ms); }
@keyframes row-in { from { opacity: 0; transform: translateY(10px); } }
.table tr.row:hover td { background: var(--raise); border-color: var(--line2); }
.table tr.row:hover td:first-child { color: var(--accent); }
.table tr.row .go { transition: transform .3s var(--ease), color .2s; display: inline-block; }
.table tr.row:hover .go { transform: translateX(4px); color: var(--accent); }
.t-title { display: flex; flex-direction: column; min-width: 0; } .t-title a { color: var(--ink); font-weight: 600; text-decoration: none; overflow-wrap: anywhere; } .t-title span { color: var(--muted); font-size: 12.5px; }
.badge { display: inline-block; padding: .1rem .6rem; border-radius: 999px; background: var(--raise); color: var(--soft); font-size: 12px; }
.star { border: 0; background: none; cursor: pointer; color: var(--muted); font-size: 1.05rem; line-height: 1; transition: transform .3s var(--ease), color .2s; }
.star:hover { transform: scale(1.25) rotate(-12deg); } .star[aria-pressed=true] { color: var(--accent); }
.empty { padding: 2.4rem 1rem; text-align: center; color: var(--muted); border: 1px dashed var(--line2); border-radius: 16px; }
.mark { background: var(--glow); color: inherit; border-radius: 3px; }
.sub-hero h1 { margin: 0; font: 700 clamp(1.9rem, 3.6vw, 2.8rem)/1.08 var(--sans); letter-spacing: -.02em; } .sub-hero p { margin: .5rem 0 0; color: var(--muted); }
.mod { margin: 1.8rem 0 .2rem; font: 600 1.05rem var(--sans); color: var(--soft); } .cat { margin: .8rem 0 0; color: var(--muted); font-size: 13px; }
.toast { position: fixed; left: 50%; bottom: 2rem; z-index: 60; max-width: min(34rem, 92vw); padding: .7rem 1.1rem; border: 1px solid var(--line2); border-radius: 12px; background: var(--raise); color: var(--ink); box-shadow: 0 20px 40px -16px var(--shadow); transform: translate(-50%, 16px); opacity: 0; pointer-events: none; transition: opacity .3s, transform .4s var(--ease); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
dialog { max-width: min(34rem, 92vw); padding: 1.4rem; border: 1px solid var(--line2); border-radius: 18px; background: var(--panel); color: var(--ink); box-shadow: 0 40px 80px -20px var(--shadow); }
dialog::backdrop { background: rgba(0,0,0,.55); backdrop-filter: blur(4px); }
dialog h2 { margin: 0 0 .8rem; font: 700 1.2rem var(--sans); } dialog label { display: block; margin: .8rem 0 .25rem; color: var(--soft); font-size: 13px; }
dialog select, dialog textarea, dialog input[type=file] { width: 100%; padding: .55rem .7rem; border: 1px solid var(--line2); border-radius: 10px; background: var(--panel2); color: var(--ink); font: inherit; }
dialog textarea { min-height: 7rem; } dialog button { margin: 1rem .5rem 0 0; padding: .55rem 1.1rem; border: 1px solid var(--line2); border-radius: 10px; background: var(--panel2); color: var(--ink); cursor: pointer; }
dialog button[type=submit], dialog button[value=yes] { background: var(--grad); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
.scrim { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.5); backdrop-filter: blur(3px); animation: page-in .3s both; } .scrim[hidden] { display: none; }

@media (max-width: 960px) { .hero { grid-template-columns: 1fr; } }
@media (max-width: 880px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .shell.reading { grid-template-columns: minmax(0, 1fr); }
  .side, .shell.reading .side { position: fixed; inset: 0 auto 0 0; width: min(20rem, 88vw); z-index: 30; transform: translateX(-102%); visibility: visible; opacity: 1; box-shadow: 14px 0 40px var(--shadow); }
  .side.open, .shell.reading .side.open { transform: none; }
  .menu { display: inline-flex; }
  .table .hide-s { display: none; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
@media print { .side, .top, .toolbar { display: none; } .shell { display: block; height: auto; } body { overflow: visible; } }
`;

const MARK = '<svg viewBox="0 0 34 34" aria-hidden="true"><defs><linearGradient id="vm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffab57"/><stop offset="1" stop-color="#f2701a"/></linearGradient></defs><rect x="2" y="2" width="30" height="30" rx="9" fill="url(#vm)"/><path d="M10 9h9a4 4 0 014 4v12l-4-2.4L15 25V13h-5z" fill="#1b0f05" opacity=".9"/><path d="M11 15h7M11 19h5" stroke="#fff" stroke-opacity=".85" stroke-width="1.6" stroke-linecap="round"/></svg>';
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect x="2" y="2" width="30" height="30" rx="9" fill="#f2701a"/><path d="M10 9h9a4 4 0 014 4v12l-4-2.4L15 25V13h-5z" fill="#1b0f05"/></svg>');
const ICON = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/></svg>'
};

/** The page's markup and its data, without the document around them (the extension's own page supplies that). */
function parts(entries, { extensionId = '' } = {}) {
  const shelf = shelve(entries);
  const assistant = /^[a-p]{32}$/.test(extensionId) ? 'chrome-extension://' + extensionId + '/library-open.html' : '';
  const json = JSON.stringify({ version: 1, entries, assistant }).replace(/</g, String.fromCharCode(92) + 'u003c').replace(new RegExp(String.fromCharCode(0x2028) + '|' + String.fromCharCode(0x2029), 'g'), '');
  const body =
    '<div class="shell" id="shell"><aside class="side" id="side" aria-label="Library"><a class="brand" href="#/" aria-label="Library home">' + MARK + '<div><b>Vid2Study</b><span>Your lecture library</span></div></a>' +
    '<div class="scroll"><div class="group">Library</div><nav class="nav" id="nav" aria-label="Library sections"></nav><div class="group">Subjects</div>' +
    '<nav class="tree" id="tree" aria-label="Subjects and lectures">' + staticTree(shelf) + '</nav></div>' +
    '<div class="side-foot"><span id="count">' + entries.length + (entries.length === 1 ? ' lecture' : ' lectures') + '</span><span class="sp"></span><span id="foot"></span><button class="chip" id="theme" type="button" title="Switch between light and dark" aria-label="Switch between light and dark">' + ICON.moon + '</button></div></aside>' +
    '<div class="scrim" id="scrim" hidden></div>' +
    '<div class="main"><div class="top"><button class="chip menu" id="menu" type="button" aria-label="Show the library menu">' + ICON.menu + '</button>' +
    '<label class="find" id="findbox">' + ICON.search + '<input id="find" type="search" placeholder="Search lectures" aria-label="Search lectures" autocomplete="off"><kbd>/</kbd></label>' +
    '<div class="crumbs" id="crumbs" hidden></div><div class="actions" id="actions"></div></div>' +
    '<main class="stage" id="stage"><div class="page"><div class="hero"><div><h1>Your lectures</h1><p>This library needs JavaScript for the reader. The list of lectures on the left still opens each one.</p></div></div></div></main></div></div>' +
    '<div class="toast" id="toast" role="status"></div>';
  return { json, body };
}

/** The pieces of the master page for a page that supplies its own document (the extension's library page): style, markup, data. */
export function libraryShell(entries) {
  return { css: CSS, ...parts(entries) };
}

/** Where a saved library keeps the shelf script (one copy for every page that shows it). */
export const SCRIPT_PATH = '.vid2study/library.js';

/** The whole standalone master page for `entries` ({ id, subject, module, category, title, path, savedAt? }). */
export function libraryPage(entries, options) {
  const { json, body } = parts(entries, options);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Vid2Study library</title><link rel="icon" href="' + FAVICON + '"><style>' + CSS + '</style></head><body>' + body +
    '<script type="application/json" id="lib-data">' + json + '</script><script src="' + SCRIPT_PATH + '"></script></body></html>';
}
