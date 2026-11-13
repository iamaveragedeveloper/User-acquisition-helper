// Shared by the on-page panel (content.js) and the toolbar popup (popup.html).
self.RT_CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; }
.card {
  --bg: #0e1116; --panel: #161b22; --panel2: #1c232c; --line: #262e38; --fg: #eef1f5; --muted: #8b97a5;
  --accent: #5b9dff; --good: #34d399; --goodbg: rgba(52,211,153,.13); --warn: #fbbf24; --warnbg: rgba(251,191,36,.13);
  --bad: #f87171; --night: #11151b; --day: #2c3a4d;
  position: fixed; right: 16px; bottom: 16px; width: 360px; max-height: calc(100vh - 32px); overflow-y: auto; overflow-x: hidden;
  z-index: 2147483647; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 18px;
  font: 13px/1.45 Inter, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 14px 44px rgba(0,0,0,.55);
  font-variant-numeric: tabular-nums;
}
.card::-webkit-scrollbar { width: 6px; } .card::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
.sec { padding: 12px 14px; border-top: 1px solid var(--line); display: grid; gap: 8px; }
.sec.first { border-top: 0; }
.muted, .sub { color: var(--muted); font-size: 12px; }
.lbl { color: var(--muted); font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
a, .link { color: var(--accent); cursor: pointer; text-decoration: none; }
a:hover, .link:hover { text-decoration: underline; }

/* who */
.hd { display: flex; align-items: center; gap: 10px; padding: 12px 14px; }
.av { width: 38px; height: 38px; border-radius: 50%; flex: none; background: var(--panel2) center/cover; display: grid; place-items: center;
  font-weight: 700; color: var(--accent); font-size: 15px; border: 1px solid var(--line); }
.id { flex: 1; min-width: 0; }
.id b { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.id span { color: var(--muted); font-size: 12px; }
.ib { background: none; border: 0; color: var(--muted); cursor: pointer; width: 28px; height: 28px; border-radius: 8px; font-size: 15px; line-height: 1; }
.ib:hover { background: var(--panel2); color: var(--fg); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--panel2); color: var(--muted); border: 1px solid var(--line); }
.chip.on { color: var(--good); background: var(--goodbg); border-color: transparent; }

/* the one answer */
.hero { display: block; padding: 14px 16px; border-radius: 16px; }
.hero b { display: block; font-size: 24px; line-height: 1.15; letter-spacing: -.4px; margin-bottom: 3px; }
.hero span { display: block; font-size: 13.5px; opacity: .92; }
.hero.go { background: var(--goodbg); color: var(--good); }
.hero.wait { background: var(--warnbg); color: var(--warn); }
.hero.na { background: var(--panel2); color: var(--muted); }
.cta { display: inline-block; margin-top: 9px; padding: 6px 12px; border-radius: 999px; background: var(--good); color: #052e1c !important;
  font-weight: 700; font-size: 12.5px; }
.cta:hover { text-decoration: none; filter: brightness(1.08); }

/* you vs them */
.clocks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.clock { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; min-width: 0; display: grid; gap: 2px; }
.clock .top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.clock .name { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clock .time { font-size: 30px; font-weight: 700; letter-spacing: -.6px; line-height: 1.1; }
.clock .time small { font-size: 12px; font-weight: 600; color: var(--muted); margin-left: 3px; letter-spacing: 0; }
.clock .meta { color: var(--muted); font-size: 11.5px; }
.clock.me .lbl { color: var(--accent); }
.delta { text-align: center; font-size: 12.5px; color: var(--muted); margin-top: 8px; }

/* the four rows: label on the left, value on the right */
.rows { display: grid; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; padding: 9px 2px; border-top: 1px solid var(--line); font-size: 13.5px; }
.row:first-child { border-top: 0; }
.row .k { color: var(--muted); flex: none; }
.row .v { font-weight: 600; text-align: right; }
.row .v small { font-weight: 400; color: var(--muted); font-size: 11.5px; }
.row .v a { font-weight: 500; font-size: 12px; margin-left: 4px; }
.hot { color: var(--good); }

/* their posts */
.post { display: flex; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); color: var(--fg); }
a.post:hover { text-decoration: none; border-color: var(--accent); }
.ago { flex: none; width: 58px; font-size: 12px; font-weight: 700; color: var(--good); }
.pbody { min-width: 0; display: grid; gap: 1px; }
.ptxt { font-size: 12.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.when { color: var(--muted); font-size: 11px; }

/* when they usually post */
.fact { font-size: 13px; }
.fact b { color: var(--fg); }
.fact.muted { font-size: 12px; }
.tip { margin-top: 2px; padding: 8px 10px; border-radius: 10px; background: var(--panel2); color: var(--muted); font-size: 12px; }

/* more details */
.morebtn { background: none; border: 0; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; text-align: left; padding: 0; }
.morebtn:hover { text-decoration: underline; }
.block { display: grid; gap: 3px; padding-top: 4px; }
.note { background: var(--warnbg); color: var(--warn); padding: 7px 10px; border-radius: 10px; font-size: 12px; }
.err { color: var(--bad); font-size: 12px; }
.links { display: flex; gap: 6px; flex-wrap: wrap; }
.links a { background: var(--panel2); border: 1px solid var(--line); padding: 2px 9px; border-radius: 999px; font-size: 12px; }
.links a:hover { text-decoration: none; border-color: var(--accent); }
.bio { color: var(--muted); font-size: 12px; line-height: 1.5; }

/* shared 24h timeline (inside More details) */
.tl-hd { margin-top: 6px; }
.tl-body { position: relative; display: grid; gap: 2px; padding-top: 12px; }
.tl-row { display: grid; grid-template-columns: 38px 1fr; align-items: center; gap: 6px; }
.tl-row .who { font-size: 11px; font-weight: 600; color: var(--muted); }
.track { display: grid; grid-template-columns: repeat(24, 1fr); gap: 1px; height: 18px; }
.cell { background: var(--night); border-radius: 2px; }
.cell.day { background: var(--day); }
.cell.good { background: #2a9d74; }
.cell.both { box-shadow: 0 0 0 1.5px var(--good) inset; }
.ticks { position: relative; height: 14px; }
.ticks span { position: absolute; top: 0; width: 56px; text-align: center; font-size: 10px; color: var(--muted); white-space: nowrap; }
.nowline { position: absolute; top: 10px; bottom: 0; width: 2px; background: #fff; border-radius: 1px; opacity: .9;
  left: calc(44px + (100% - 44px) * var(--p) / 100); pointer-events: none; }
.nowtag { position: absolute; top: -2px; transform: translateX(-50%); font-size: 9.5px; font-weight: 700; color: #fff; background: #3b82f6;
  padding: 0 5px; border-radius: 4px; left: calc(44px + (100% - 44px) * var(--p) / 100); pointer-events: none; }
.legend { display: flex; gap: 10px; font-size: 10.5px; color: var(--muted); flex-wrap: wrap; }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }

/* actions: the save button stays visible while the card scrolls */
.foot { position: sticky; bottom: 0; background: var(--bg); z-index: 2; }
.btn { width: 100%; padding: 10px 12px; border: 0; border-radius: 12px; background: var(--fg); color: #0b0e12; font: inherit; font-weight: 700; cursor: pointer; }
.btn:hover:not(:disabled) { filter: brightness(.92); }
.btn:disabled { opacity: .6; cursor: default; }
.btn.ghost { background: var(--panel2); color: var(--fg); border: 1px solid var(--line); font-weight: 600; }
.pillbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; }
.pillbar b { flex: 1; }
.pillbar .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
.pillbar .dot.go { background: var(--good); } .pillbar .dot.wait { background: var(--warn); }
`;
