import type { Child } from 'hono/jsx';
import { clientScript } from './client';

export const ICON_GLOBE = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
);

export const ICON_SEARCH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

// One stylesheet for every page. System fonts and inline only: the CSP allows nothing from outside.
const STYLES = `
  :root {
    --bg: #f4f5fb; --glow-1: rgba(99,102,241,.16); --glow-2: rgba(34,211,238,.14);
    --surface: #ffffff; --surface-hover: #f8f8ff; --chip: #f1f2f8;
    --text: #0f172a; --muted: #64748b; --faint: #a3acbd;
    --accent: #6366f1; --accent-2: #06b6d4; --accent-soft: #eef0ff; --accent-text: #4f46e5;
    --pink: #ec4899; --red: #ef4444; --red-soft: #fee2e2; --green: #10b981; --green-soft: #d1fae5;
    --blue: #3b82f6; --blue-soft: #dbeafe; --violet: #8b5cf6; --violet-soft: #ede9fe;
    --amber-soft: #fef3c7; --amber-text: #92400e;
    --row-shadow: 0 1px 2px rgba(15,23,42,.04);
    --lift: 0 8px 24px -8px rgba(79,70,229,.28), 0 2px 6px rgba(15,23,42,.06);
    --radius: 14px;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0b14; --glow-1: rgba(99,102,241,.22); --glow-2: rgba(6,182,212,.12);
      --surface: #141625; --surface-hover: #1b1e33; --chip: #20233a;
      --text: #e7e9f5; --muted: #9aa3b8; --faint: #5b637a;
      --accent: #818cf8; --accent-soft: #23264a; --accent-text: #c7cbff;
      --red-soft: #3a1620; --green-soft: #0d2e24; --blue-soft: #14254a; --violet-soft: #251d45;
      --amber-soft: #3a2a08; --amber-text: #fcd34d;
      --row-shadow: none; --lift: 0 8px 28px -8px rgba(129,140,248,.35);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; color: var(--text);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(900px 500px at 8% -10%, var(--glow-1), transparent 60%),
      radial-gradient(800px 500px at 100% 0%, var(--glow-2), transparent 60%), var(--bg);
    background-attachment: fixed; }
  a { color: inherit; text-decoration: none; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  .right { text-align: right; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }

  header { position: sticky; top: 0; z-index: 5; padding: 14px 24px 0; }
  .bar { max-width: 1200px; margin: 0 auto; height: 56px; padding: 0 14px; display: flex; align-items: center; gap: 22px;
    background: color-mix(in srgb, var(--surface) 78%, transparent); backdrop-filter: blur(14px);
    border-radius: 16px; box-shadow: 0 4px 20px -6px rgba(15,23,42,.12); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 750; letter-spacing: -.02em; font-size: 15px; }
  .logo { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: #fff; font-size: 15px;
    background: linear-gradient(135deg, var(--accent), var(--pink) 55%, #f59e0b); box-shadow: 0 4px 12px -2px rgba(236,72,153,.45); }
  .brand span { background: linear-gradient(90deg, var(--accent), var(--pink)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  nav.tabs { display: flex; gap: 2px; padding: 4px; background: var(--chip); border-radius: 11px; }
  nav.tabs a { color: var(--muted); padding: 6px 14px; border-radius: 8px; font-weight: 600; }
  nav.tabs a:hover { color: var(--text); }
  nav.tabs a.active { background: var(--surface); color: var(--accent-text); box-shadow: 0 1px 3px rgba(15,23,42,.12); }
  .user { margin-left: auto; color: var(--muted); font-size: 13px; }

  main { max-width: 1200px; margin: 0 auto; padding: 30px 24px 56px; }
  h1 { font-size: 28px; margin: 0; letter-spacing: -.03em; display: flex; align-items: center; gap: 10px; }
  .count { font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 999px; color: #fff; letter-spacing: 0;
    background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
  .sub { color: var(--muted); margin: 6px 0 0; }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }

  .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .field { position: relative; display: flex; align-items: center; }
  .field svg { position: absolute; left: 12px; width: 16px; height: 16px; color: var(--accent); pointer-events: none; }
  select, input[type=search] { height: 40px; border: 0; background: var(--surface); color: var(--text); border-radius: 12px;
    font: inherit; font-weight: 500; padding: 0 14px; box-shadow: var(--row-shadow), 0 0 0 1px rgba(15,23,42,.04); transition: box-shadow .15s; }
  select { padding-right: 34px; appearance: none; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%236366f1' stroke-width='2'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 12px center; }
  .field select, .field input { padding-left: 36px; }
  input[type=search] { width: 250px; }
  select:hover, input[type=search]:hover { box-shadow: var(--lift); }
  select:focus-visible, input:focus-visible, a:focus-visible, button:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent); }
  .live { display: inline-flex; align-items: center; gap: 8px; color: var(--green); font-size: 12.5px; font-weight: 600;
    background: var(--green-soft); padding: 7px 12px; border-radius: 999px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,.55); } 70%, 100% { box-shadow: 0 0 0 7px rgba(16,185,129,0); } }

  .btn { height: 34px; padding: 0 14px; border-radius: 10px; border: 0; font: inherit; font-weight: 600; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px; background: var(--surface); color: var(--accent-text); box-shadow: var(--row-shadow); }
  .btn:hover { box-shadow: var(--lift); }
  .btn.danger { color: #fff; background: linear-gradient(135deg, #ef4444, #ec4899); box-shadow: 0 6px 16px -6px rgba(239,68,68,.6); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }

  .selbar { display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 16px; margin-bottom: 8px; border-radius: 14px;
    background: linear-gradient(90deg, var(--accent-soft), color-mix(in srgb, var(--accent-soft) 40%, transparent)); color: var(--accent-text); font-weight: 650; }
  .selbar[hidden] { display: none; }
  .selbar .btn { background: transparent; box-shadow: none; }
  .selbar .btn.danger { margin-left: auto; background: linear-gradient(135deg, #ef4444, #ec4899); }

  .scroll { overflow-x: auto; margin: 0 -8px; padding: 0 8px; }
  /* No table lines: rows are rounded strips, columns come from header labels and alignment. */
  table.list { width: 100%; border-collapse: separate; border-spacing: 0 6px; margin-top: -6px; }
  table.list th { text-align: left; font-size: 11.5px; font-weight: 700; color: var(--faint); text-transform: uppercase;
    letter-spacing: .07em; padding: 4px 16px 2px; white-space: nowrap; }
  table.list th.right { text-align: right; }
  table.list td { padding: 12px 16px; background: var(--surface); vertical-align: middle; transition: background .12s; }
  table.list tbody tr { box-shadow: var(--row-shadow); transition: transform .12s, box-shadow .12s; }
  table.list tbody td:first-child { border-radius: var(--radius) 0 0 var(--radius); }
  table.list tbody td:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
  table.list tbody td:only-child { border-radius: var(--radius); }
  tr.mail { cursor: pointer; }
  tr.mail:hover { transform: translateY(-1px); box-shadow: var(--lift); }
  tr.mail:hover td { background: var(--surface-hover); }
  tr.selected td { background: var(--accent-soft); }
  tr.empty td { text-align: center; color: var(--muted); padding: 36px; }
  td.check, th.check { width: 44px; padding-right: 0 !important; }
  input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--accent); cursor: pointer; }

  .inbox { padding: 3px 10px; border-radius: 8px; font-weight: 600; color: var(--accent-text); background: var(--accent-soft);
    /* Long names wrap to two lines, then end in an ellipsis; the full name is in the title. */
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; word-break: break-all; max-width: 230px; }
  .to-wrap { display: flex; align-items: center; gap: 6px; min-width: 170px; }
  .newtag { flex: none; display: inline-block; font-size: 10.5px; font-weight: 800; color: #fff; padding: 1px 6px; border-radius: 6px;
    background: linear-gradient(90deg, var(--accent), var(--pink)); vertical-align: 1px; }
  .from { display: flex; align-items: center; gap: 10px; }
  .from .name, .from .addr { display: block; white-space: nowrap; max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
  .from .name { font-weight: 600; }
  .from .addr { color: var(--muted); font-size: 12.5px; }
  .av { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 12px; }
  .av0 { background: linear-gradient(135deg, #6366f1, #8b5cf6); } .av1 { background: linear-gradient(135deg, #06b6d4, #3b82f6); }
  .av2 { background: linear-gradient(135deg, #f59e0b, #ec4899); } .av3 { background: linear-gradient(135deg, #10b981, #06b6d4); }
  .av4 { background: linear-gradient(135deg, #ec4899, #8b5cf6); } .av5 { background: linear-gradient(135deg, #f97316, #ef4444); }
  .subject { display: block; font-weight: 600; max-width: clamp(120px, 20vw, 430px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subject .preview { color: var(--muted); font-weight: 400; }
  .pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
  .pill.pdf { background: var(--red-soft); color: var(--red); }
  .age { color: var(--muted); white-space: nowrap; text-align: right; }
  .zero { color: var(--faint); }

  .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 4px 0; flex-wrap: wrap; color: var(--muted); }
  .foot label { display: inline-flex; align-items: center; gap: 10px; font-weight: 500; }
  .foot select { height: 34px; }
  .pager { display: flex; gap: 6px; align-items: center; }
  .pager a, .pager span { min-width: 34px; height: 34px; padding: 0 8px; border-radius: 10px; display: grid; place-items: center;
    background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--row-shadow); }
  .pager a:hover { box-shadow: var(--lift); color: var(--accent-text); }
  .pager .cur { color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 16px -6px rgba(99,102,241,.7); }
  .pager .off { opacity: .35; }
  .pager .gap { background: transparent; box-shadow: none; color: var(--faint); }

  /* statistics */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 26px; }
  .kpi { position: relative; overflow: hidden; background: var(--surface); border-radius: 18px; padding: 18px; box-shadow: var(--row-shadow); }
  .kpi::after { content: ""; position: absolute; right: -30px; top: -30px; width: 110px; height: 110px; border-radius: 50%; background: var(--tint); opacity: .14; }
  .kpi .icon { width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; color: #fff; font-size: 17px; font-weight: 800; background: var(--grad); margin-bottom: 12px; }
  .kpi .label { color: var(--muted); font-size: 13px; font-weight: 600; }
  .kpi .value { font-size: 30px; font-weight: 800; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
  .kpi .hint { color: var(--muted); font-size: 12.5px; }
  .k-in { --grad: linear-gradient(135deg, #3b82f6, #06b6d4); --tint: #3b82f6; }
  .k-read { --grad: linear-gradient(135deg, #10b981, #84cc16); --tint: #10b981; }
  .k-api { --grad: linear-gradient(135deg, #8b5cf6, #ec4899); --tint: #8b5cf6; }
  .k-err { --grad: linear-gradient(135deg, #ef4444, #f97316); --tint: #ef4444; }
  .k-err.bad .value { color: var(--red); }
  .grp { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: 0; text-transform: none; }
  .g-in { background: var(--blue-soft); color: var(--blue); }
  .g-read { background: var(--green-soft); color: var(--green); }
  .g-api { background: var(--violet-soft); color: var(--violet); }
  #stats th.group { text-align: center; padding-bottom: 0; }
  #stats th.n { text-align: right; }
  #stats .gap { padding-left: 34px; }
  #stats .c-in { color: var(--blue); } #stats .c-read { color: var(--green); } #stats .c-api { color: var(--violet); }
  #stats td.zero { color: var(--faint); }
  #stats .err { color: var(--red); font-weight: 800; }
  .day { font-weight: 600; white-space: nowrap; }
  .day small { color: var(--muted); font-weight: 500; margin-left: 6px; }
  table.list tr.total td { font-weight: 800; background: var(--accent-soft); }
  .barcell { display: flex; align-items: center; justify-content: flex-end; gap: 8px; font-weight: 700; }
  .minibar { height: 6px; border-radius: 3px; background: linear-gradient(90deg, #3b82f6, #06b6d4); }

  /* message page */
  .back { display: inline-flex; align-items: center; gap: 6px; color: var(--accent-text); font-weight: 600; }
  .msghead { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
  .card { background: var(--surface); border-radius: 18px; padding: 18px 20px; box-shadow: var(--row-shadow); margin-bottom: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); margin: 0 0 10px; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 14px 0 0; }
  .meta dt { color: var(--muted); font-weight: 600; } .meta dd { margin: 0; word-break: break-all; }
  .warn { color: var(--amber-text); background: var(--amber-soft); padding: 8px 12px; border-radius: 10px; margin: 6px 0; }
  .atts { width: 100%; border-collapse: collapse; }
  .atts td { padding: 6px 12px 6px 0; }
  .atts a { color: var(--accent-text); font-weight: 600; }
  .msgtabs { display: inline-flex; gap: 2px; padding: 4px; background: var(--chip); border-radius: 11px; margin-bottom: 12px; }
  .msgtabs button { border: 0; background: transparent; color: var(--muted); padding: 6px 16px; border-radius: 8px; font: inherit; font-weight: 700; cursor: pointer; }
  .msgtabs button.active { background: var(--surface); color: var(--accent-text); box-shadow: 0 1px 3px rgba(15,23,42,.12); }
  .panel iframe { width: 100%; height: 600px; border: 0; border-radius: 14px; background: #fff; box-shadow: var(--row-shadow); }
  .panel pre { white-space: pre-wrap; word-break: break-word; background: var(--surface); padding: 16px; border-radius: 14px; margin: 0; box-shadow: var(--row-shadow); }
  .panel ul { background: var(--surface); padding: 14px 14px 14px 34px; border-radius: 14px; margin: 0; }
  .panel li { padding: 3px 0; word-break: break-all; }
  .panel li a { color: var(--accent-text); }

  @media (max-width: 760px) {
    header { padding: 10px 12px 0; } .bar { gap: 10px; } .user { display: none; }
    main { padding: 22px 16px; } input[type=search] { width: 100%; }
    .hide-sm { display: none; } .subject { max-width: 160px; } .from .addr { display: none; }
  }
`;

export function Layout(props: {
  title: string;
  user: string;
  active: 'inbox' | 'stats' | 'message';
  children?: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} - flaky inbox</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <header>
          <div class="bar">
            <div class="brand">
              <div class="logo">✉</div>
              <span>flaky inbox</span>
            </div>
            <nav class="tabs">
              <a href="/" class={props.active === 'inbox' ? 'active' : ''}>
                Inbox
              </a>
              <a href="/stats" class={props.active === 'stats' ? 'active' : ''}>
                Statistics
              </a>
            </nav>
            <span class="user">{props.user}</span>
          </div>
        </header>
        <main>{props.children}</main>
        <script dangerouslySetInnerHTML={{ __html: clientScript }} />
      </body>
    </html>
  );
}
