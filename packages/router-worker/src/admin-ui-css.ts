import { ADMIN_UI_RESPONSIVE } from './admin-ui-contract'

/**
 * Design tokens + stylesheet for the admin console. Derived from the
 * codeflare.ch product design language: sans interface typography with mono
 * values/code, zinc near-black surfaces, hairline borders, one locked coral accent with dark ink on it,
 * and a semantic status set where danger is distinct from the accent.
 * Every size/colour/space flows from the token block below.
 */
export function adminUiCss(): string {
  return `:root{
  color-scheme:dark;
  --font-sans:'Inter',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --bg:#0a0a0c;
  --bg-rgb:10 10 12;
  --surface:#101015;
  --surface-rgb:16 16 21;
  --surface-2:#16161d;
  --surface-3:#1f1f26;
  --line:#1c1c22;
  --line-strong:#2a2a33;
  --text:#f6f6f7;
  --text-2:#adadb6;
  --muted:#9a9aa3;
  --accent:#ff5c3c;
  --accent-hover:#ff734f;
  --accent-ink:#160a06;
  --accent-rgb:255 92 60;
  --accent-soft:rgb(var(--accent-rgb)/.12);
  --accent-line:rgb(var(--accent-rgb)/.32);
  --flare-gradient:linear-gradient(96deg,#ff8a3d 0%,#ff5c3c 52%,#ff3f7c 100%);
  --page-glow:radial-gradient(ellipse 80% 42% at 50% -12%,rgb(var(--accent-rgb)/.16),transparent 64%);
  --ok:#22c55e;
  --warn:#f59e0b;
  --danger:#ef4444;
  --danger-text:#f87171;
  --danger-hover:#dc2626;
  --danger-soft:rgb(239 68 68/.12);
  --danger-line:rgb(239 68 68/.35);
  --info:#3b82f6;
  --fs-xs:.75rem;
  --fs-sm:.8125rem;
  --fs-md:.875rem;
  --fs-lg:1rem;
  --fs-xl:1.125rem;
  --radius-sm:6px;
  --radius-md:8px;
  --radius-lg:12px;
  --focus:0 0 0 2px var(--bg),0 0 0 4px var(--accent);
  --speed-fast:.1s;
  --speed-base:.15s;
  --nav-w:13rem;
  --tab-h:3.5rem;
}
*,*::before,*::after{box-sizing:border-box}
*{margin:0}
html{-webkit-text-size-adjust:100%;background:var(--bg);max-width:100%;overflow-x:hidden}
body{min-height:100vh;max-width:100%;overflow-x:hidden;background:var(--page-glow),var(--bg);color:var(--text-2);font:var(--fs-md)/1.55 var(--font-sans);-webkit-font-smoothing:antialiased}
::selection{background:rgb(255 92 60/.28);color:var(--text)}
a{color:inherit;text-decoration:none}
button,input,select{font:inherit}
h1,h2,h3{color:var(--text);letter-spacing:-.04em;text-wrap:balance;font-weight:800}
h1{font-size:var(--fs-xl)}
h2{font-size:var(--fs-lg)}
h3{font-size:var(--fs-md)}
code,pre,.metric-value,.endpoint-chip{font-family:var(--font-mono)}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:none;box-shadow:var(--focus)}
[hidden]{display:none!important}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;max-width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-3);color:var(--text);font-size:var(--fs-md);font-weight:600;padding:.55rem .95rem;cursor:pointer;white-space:nowrap;transition:background var(--speed-base) ease-out,border-color var(--speed-base) ease-out,transform var(--speed-fast) ease-out,opacity var(--speed-base) ease-out}
.btn:hover{background:var(--line-strong)}
.btn:active{transform:scale(.98)}
.btn:disabled{cursor:not-allowed;opacity:.5}
.btn-primary{background:var(--accent);border-color:transparent;color:var(--accent-ink)}
.btn-primary:hover{background:var(--accent-hover)}
.btn-ghost{background:transparent;border-color:transparent;color:var(--text-2)}
.btn-ghost:hover{background:var(--surface-2);color:var(--text)}
.btn-danger{background:transparent;border-color:var(--danger-line);color:var(--danger-text)}
.btn-danger:hover{background:var(--danger-soft)}
.btn-danger.is-armed,.btn-danger[data-armed=true]{background:var(--danger-hover);border-color:transparent;color:#fff}
.field{display:grid;gap:.35rem;min-width:0;align-content:start}
.field>label{color:var(--muted);font-size:var(--fs-xs);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.field-hint{color:var(--muted);font-size:var(--fs-xs)}
input,select{min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);padding:.55rem .7rem;transition:border-color var(--speed-base) ease-out}
input::placeholder{color:var(--muted);opacity:1}
input:focus-visible,select:focus-visible{border-color:var(--accent)}
.check{display:inline-flex;align-items:center;gap:.5rem;color:var(--text-2);font-size:var(--fs-sm)}
.check input{min-height:auto;width:auto;accent-color:var(--accent)}
.chip{display:inline-flex;align-items:center;gap:.3rem;max-width:100%;min-width:0;border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);font-size:var(--fs-xs);font-weight:600;padding:.12rem .55rem;white-space:nowrap}
.chip>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis}
.chip[data-tone=ok]{color:var(--ok);border-color:rgb(34 197 94/.35)}
.chip[data-tone=warn]{color:var(--warn);border-color:rgb(245 158 11/.35)}
.chip[data-tone=danger]{color:var(--danger-text);border-color:var(--danger-line)}
.chip[data-tone=accent]{color:var(--accent);border-color:var(--accent-line)}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--muted);flex:none}
.dot[data-tone=ok]{background:var(--ok)}
.dot[data-tone=warn]{background:var(--warn)}
.dot[data-tone=danger]{background:var(--danger)}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--line);background:rgb(var(--bg-rgb)/.92);backdrop-filter:blur(12px);padding:.7rem clamp(1rem,3vw,1.5rem)}
.brand{display:inline-flex;align-items:center;gap:.6rem;min-width:0}
.brand-mark{width:.7rem;height:.7rem;border-radius:3px;background:linear-gradient(96deg,#ff8a3d 0%,#ff5c3c 52%,#ff3f7c 100%);flex:none}
.brand strong{color:var(--text);font-size:var(--fs-lg);font-weight:600;line-height:1}
.brand-path{color:var(--muted);font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-side{display:flex;align-items:center;gap:.6rem;min-width:0;flex:none}
.mobile-menu-btn{display:none}
.mobile-menu-icon{width:1.25rem;height:1.25rem;fill:currentColor;flex:none}
.health-pill{display:inline-flex;align-items:center;gap:.4rem;border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);font-size:var(--fs-xs);font-weight:600;padding:.3rem .65rem}
.health-pill[data-health=ok]{color:var(--ok);border-color:rgb(34 197 94/.35)}
.health-pill[data-health=error]{color:var(--danger-text);border-color:var(--danger-line)}
main{width:min(1120px,100%);max-width:100%;overflow:hidden;margin:0 auto;padding:1.25rem clamp(1rem,3vw,1.5rem) 4.5rem}
.view-gate{display:block;padding-top:clamp(.75rem,3vh,1.25rem)}
.gate-flow{width:min(1120px,100%);display:grid;grid-template-areas:"setup-hero" "setup-body";gap:1.25rem}
.setup-layout{grid-area:setup-body;display:grid;grid-template-columns:var(--nav-w) minmax(0,1fr);gap:1.25rem;align-items:start;min-width:0}
.setup-rail{position:sticky;top:4.5rem;display:grid;gap:.75rem;min-width:0}
.setup-panels{display:grid;gap:1rem;min-width:0}
.dashboard-hero.setup-hero{grid-area:setup-hero}
.dashboard-hero.setup-hero h1{max-width:12ch}
.setup-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
.setup-stats [data-setup-stat=node]{grid-column:1/-1}
.slot{display:contents}
.gate-card{width:100%;display:grid;gap:1rem;border:1px solid var(--line);border-radius:var(--radius-lg);background:linear-gradient(180deg,rgb(var(--surface-rgb)/.95),var(--surface));box-shadow:0 12px 42px rgb(0 0 0/.16);padding:clamp(1rem,2.5vw,1.25rem);min-width:0}
.gate-card h2{display:flex;align-items:center;gap:.55rem}
.gate-card h2::before{content:"";width:.5rem;height:.5rem;border-radius:2px;background:var(--accent);flex:none}
.gate-card>p{color:var(--text-2);font-size:var(--fs-sm);max-width:65ch}
.gate-alt{color:var(--muted);font-size:var(--fs-sm)}
.gate-alt a{color:var(--accent);text-decoration:underline}
.stepper{display:flex;gap:.5rem;list-style:none;padding:0;margin:0 0 1rem}
.stepper li{flex:1;min-width:0;display:grid;gap:.45rem;color:var(--muted)}
.stepper li::before{content:"";display:block;height:3px;border-radius:999px;background:var(--line-strong)}
.stepper li[aria-current=step]{color:var(--text)}
.stepper li[aria-current=step]::before{background:var(--accent)}
.stepper li[data-done=true]{color:var(--text-2)}
.stepper li[data-done=true]::before{background:var(--ok)}
.stepper li span{display:block;font-size:var(--fs-sm);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.setup-rail .stepper{display:grid;gap:.2rem;margin:0}
.setup-rail .stepper li{grid-template-columns:.7rem minmax(0,1fr);align-items:center;gap:.6rem;border-left:2px solid transparent;border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:.55rem .75rem;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px}
.setup-rail .stepper li::before{width:.5rem;height:.5rem;border-radius:2px}
.setup-rail .stepper li[aria-current=step]{border-left-color:var(--accent);background:var(--surface)}
.setup-rail .stepper li[data-done=true]{color:var(--text-2)}
.wizard-actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}
.email-chips{display:flex;flex-wrap:wrap;gap:.45rem;list-style:none;padding:0;margin:0}
.email-chips:empty{display:none}
.email-chip{display:inline-flex;align-items:center;gap:.35rem;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-2);color:var(--text);font-size:var(--fs-sm);padding:.25rem .35rem .25rem .75rem}
.email-chip .btn{min-height:1.8rem;padding:.15rem .5rem;font-size:var(--fs-xs)}
.handoff-panel{display:grid;gap:.7rem;border:1px solid var(--accent-line);border-radius:var(--radius-md);background:var(--accent-soft);padding:.9rem}
.handoff-panel p{color:var(--text);font-size:var(--fs-sm)}
.handoff-panel .btn{justify-self:start}
.signin-form{display:grid;gap:.75rem;padding-top:.75rem}
.token-warning{display:flex;gap:.5rem;border:1px solid rgb(245 158 11/.35);border-radius:var(--radius-sm);background:rgb(245 158 11/.08);color:var(--warn);font-size:var(--fs-sm);padding:.65rem .8rem}
.token-card{display:grid;gap:.35rem;border:1px solid var(--line-strong);border-radius:var(--radius-md);background:var(--surface-2);padding:.7rem}
.token-card strong{color:var(--muted);font-size:var(--fs-xs);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.token-card code{color:var(--text);font-size:var(--fs-sm);overflow-wrap:anywhere}
.token-card .btn{justify-self:start;min-height:2.2rem;padding:.35rem .7rem}
.dash{display:grid;grid-template-columns:var(--nav-w) minmax(0,1fr);grid-template-areas:"hero hero" "nav sections";gap:1.25rem;align-items:start}
.dashboard-hero{grid-area:hero;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(min(22rem,100%),.92fr);gap:clamp(1rem,3vw,1.5rem);align-items:end;border:1px solid var(--line);border-radius:calc(var(--radius-lg) + 6px);background:linear-gradient(135deg,rgb(var(--surface-rgb)/.95),rgb(var(--surface-rgb)/.72)),radial-gradient(circle at 12% 0%,rgb(var(--accent-rgb)/.18),transparent 34%);box-shadow:0 24px 80px rgb(0 0 0/.24);padding:clamp(1.1rem,3.5vw,2rem);overflow:hidden;min-width:0}
.hero-copy{display:grid;gap:.65rem;min-width:0}
.eyebrow{color:var(--accent);font-size:var(--fs-xs);font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.dashboard-hero h1{max-width:13ch;font-size:clamp(2rem,5vw,3.85rem);line-height:.94;letter-spacing:-.055em}
.dashboard-hero p{max-width:39rem;color:var(--text-2)}
.hero-accent{display:inline-block;background:var(--flare-gradient);background-clip:text;-webkit-background-clip:text;color:transparent;-webkit-text-fill-color:transparent}
.scramble-word{display:inline-block;white-space:nowrap;text-align:left;vertical-align:baseline;overflow:visible;color:inherit}
.hero-stats{align-self:stretch;align-content:end}
.side-nav{grid-area:nav;position:sticky;top:4.5rem;display:grid;gap:.2rem}
.mobile-menu{display:none}
.nav-item{display:grid;gap:.1rem;border-left:2px solid transparent;border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:.55rem .75rem;color:var(--text-2);min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item[aria-current=page]{border-left-color:var(--accent);background:var(--surface);color:var(--text)}
.nav-item small{color:var(--muted);font-size:var(--fs-xs)}
.sections{grid-area:sections;display:grid;gap:1rem;min-width:0}
.panel{border:1px solid var(--line);border-radius:var(--radius-lg);background:linear-gradient(180deg,rgb(var(--surface-rgb)/.95),var(--surface));box-shadow:0 12px 42px rgb(0 0 0/.16);padding:clamp(.9rem,2.5vw,1.25rem);display:grid;gap:.9rem;min-width:0}
.panel-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem}
.panel-head h2{display:flex;align-items:center;gap:.55rem}
.panel-head h2::before{content:"";width:.5rem;height:.5rem;border-radius:2px;background:var(--accent);flex:none}
.panel-head p{width:100%;color:var(--muted);font-size:var(--fs-sm)}
.subpanel{display:grid;gap:.75rem;border-top:1px solid var(--line-strong);padding-top:1.1rem;margin-top:.35rem}
.panel h3{display:flex;align-items:center;gap:.5rem}
.panel h3::before{content:"";width:.45rem;height:.45rem;border-radius:2px;background:var(--accent);flex:none}
.state-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:.35rem .75rem;border:1px solid var(--line);border-radius:var(--radius-md);background:linear-gradient(180deg,rgb(var(--surface-rgb)/.98),var(--surface-2));box-shadow:inset 0 1px 0 rgb(255 255 255/.03);padding:.9rem 1rem;min-width:0}
.state-card .state-label{grid-column:1/-1;color:var(--muted);font-size:var(--fs-xs);font-weight:650;letter-spacing:.06em;text-transform:uppercase}
.state-card .state-value{grid-column:1;color:var(--text);font-size:var(--fs-lg);font-weight:800;letter-spacing:-.025em;overflow-wrap:anywhere;min-width:0}
.state-card>.chip{grid-column:2;grid-row:2;align-self:center;justify-self:end}
.state-card .state-sub{grid-column:1/-1;color:var(--text-2);font-family:var(--font-mono);font-size:var(--fs-xs);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state-card.is-ok{border-color:rgb(34 197 94/.28);background:radial-gradient(circle at 100% 0%,rgb(34 197 94/.12),transparent 34%),linear-gradient(180deg,rgb(var(--surface-rgb)/.98),var(--surface-2))}
.state-card.is-empty{border-color:var(--line-strong);background:linear-gradient(180deg,rgb(var(--surface-rgb)/.94),var(--surface-2))}
.state-card.is-empty .state-value{color:var(--muted);font-weight:650;font-size:var(--fs-md);letter-spacing:0}
.model-name-row{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;min-width:0}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr));gap:.75rem;min-width:0}
.form-actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;min-width:0}
.form-actions>*{max-width:100%;min-width:0}
.command-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem;align-items:center;border:1px solid var(--line-strong);border-radius:var(--radius-md);background:linear-gradient(180deg,rgb(var(--surface-rgb)/.96),var(--surface-2));padding:.75rem;min-width:0}
.model-sources{display:grid;gap:.6rem;margin:.75rem 0;min-width:0}
.model-sources h4{margin:0;color:var(--text);font-size:var(--fs-sm);font-weight:800;letter-spacing:-.01em}
.model-sources .source-format{margin:0;color:var(--muted);font-size:var(--fs-sm)}
.model-sources[data-model-sources="single"] .command-row[data-command-row="model-source-layers"],.model-sources[data-model-sources="single"] .command-row[data-command-row="model-source-split-guide"]{display:none}
.model-sources[data-model-sources="split"] .command-row[data-command-row="model-source-gguf"]{display:none}
.command-copy{display:grid;gap:.35rem;min-width:0}
.command-copy strong{color:var(--text);font-weight:800;letter-spacing:-.02em}
.command-copy span{color:var(--muted);font-size:var(--fs-sm)}
.command-chips{display:flex;flex-wrap:wrap;gap:.35rem;min-width:0}
.endpoint-chip{display:inline-flex;align-items:center;min-height:1.75rem;border:1px solid var(--accent-line);border-radius:999px;background:var(--accent-soft);color:var(--text);font-size:var(--fs-xs);font-weight:600;padding:.2rem .55rem;overflow-wrap:anywhere}
.endpoint-chip[data-scope-chip]{border-color:var(--line-strong);background:var(--surface-3);color:var(--muted)}
.endpoint-chip[data-status-chip]{border-color:rgb(34 197 94/.32);background:rgb(34 197 94/.08);color:var(--ok)}
.command-actions{display:flex;justify-content:flex-end;min-width:0}
.result{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text-2);font-size:var(--fs-sm);line-height:1.6;padding:.65rem .75rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.result:empty{display:none}
.result.is-error{border-color:var(--danger-line);background:var(--danger-soft);color:var(--danger-text)}
.token-grid{display:grid;gap:.6rem}
.tile-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(10.5rem,100%),1fr));gap:.6rem;min-width:0}
.tile{display:grid;gap:.2rem;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface-2);padding:.65rem .75rem;min-width:0}
.tile strong{color:var(--muted);font-size:var(--fs-xs);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.tile code{color:var(--text);font-size:var(--fs-sm);overflow-wrap:anywhere;word-break:break-word}
code[data-mesh-field]{display:block}
.split-readiness-block{display:grid;gap:.45rem;border:1px solid var(--line);border-radius:var(--radius-sm);background:rgb(var(--surface-rgb)/.55);padding:.7rem;min-width:0}
.split-readiness-row{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem .6rem;color:var(--text-2);font-size:var(--fs-sm);min-width:0}
.split-readiness-row strong{color:var(--muted);font-size:var(--fs-xs);font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.split-participant-list{display:flex;flex-wrap:wrap;gap:.35rem;min-width:0}
.mini-chip{display:inline-flex;align-items:center;max-width:100%;border:1px solid var(--line-strong);border-radius:999px;color:var(--text);font-size:var(--fs-xs);font-weight:650;padding:.18rem .5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#overview-tiles [data-stat=domain] code,#overview-tiles [data-stat=version] code{font-size:var(--fs-xs)}
.row-list{display:grid;gap:.5rem}
.row-item{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface-2);padding:.6rem .75rem;min-width:0}
.row-item>*{min-width:0;max-width:100%}
.key-list{display:grid;gap:.5rem;margin-top:.6rem}
.key-list time{color:var(--muted);font-size:var(--fs-xs)}
.row-item code{color:var(--text);font-size:var(--fs-sm);overflow-wrap:anywhere}
.row-item .grow{flex:1 1 10rem;min-width:0;display:grid;gap:.15rem}
.row-item small{color:var(--muted);font-size:var(--fs-xs)}
.row-item .btn{min-height:2.2rem;padding:.35rem .7rem;margin-left:auto}
.empty-note{color:var(--muted);font-size:var(--fs-sm)}
.feed{display:grid;gap:.35rem}
.feed-item{display:flex;flex-wrap:wrap;gap:.5rem;color:var(--text-2);font-size:var(--fs-sm);border-top:1px solid var(--line);padding-top:.35rem}
.feed-item:first-child{border-top:0;padding-top:0}
.feed-item time{color:var(--muted);font-size:var(--fs-xs);margin-left:auto}
.banner{display:flex;gap:.5rem;border:1px solid var(--danger-line);border-radius:var(--radius-sm);background:var(--danger-soft);color:var(--danger-text);font-size:var(--fs-sm);padding:.65rem .8rem}
.api-list{display:grid;gap:.3rem;padding:.5rem 0 0}
.api-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;border-top:1px solid var(--line);padding:.3rem 0}
.api-row:first-child{border-top:0}
.api-list code{color:var(--muted);font-size:var(--fs-xs)}
.api-list a{color:var(--accent);font-size:var(--fs-xs);font-weight:700;text-decoration:none}
.api-list a:hover{text-decoration:underline}
details summary{cursor:pointer;color:var(--text-2);font-size:var(--fs-sm);font-weight:600}
.toast{position:fixed;left:50%;bottom:calc(1rem + env(safe-area-inset-bottom));z-index:40;display:flex;align-items:center;gap:.7rem;max-width:min(26rem,calc(100vw - 2rem));border:1px solid var(--line-strong);border-radius:var(--radius-md);background:var(--surface-3);color:var(--text);font-size:var(--fs-sm);box-shadow:0 8px 32px rgb(0 0 0/.5);opacity:0;pointer-events:none;padding:.7rem .85rem;transform:translate(-50%,.4rem);transition:opacity var(--speed-base) ease-out,transform var(--speed-base) ease-out}
.toast.show{opacity:1;pointer-events:auto;transform:translate(-50%,0)}
.toast.is-error{border-color:var(--danger-line);color:var(--danger-text)}
.toast .btn{min-height:2rem;padding:.25rem .55rem}
.noscript-banner{display:block;border:1px solid var(--warn);color:var(--warn);border-radius:var(--radius-sm);font-size:var(--fs-sm);margin:1rem;padding:.7rem .85rem;text-align:center}
.topology{display:grid;gap:.5rem;min-width:0;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:1rem;margin-top:1rem}
.topo-caption{margin:0;font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--text-2)}
.topo-canvas{position:relative;aspect-ratio:2/1;min-height:220px}
.topo-canvas.is-empty{aspect-ratio:auto;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem}
.topo-canvas.is-empty .topo-hub{position:static;transform:none}
.topo-canvas.is-empty .topo-empty{position:static;transform:none;left:auto;bottom:auto}
.topo-empty{position:absolute;left:50%;bottom:14%;transform:translateX(-50%);margin:0;max-width:90%;text-align:center;color:var(--muted);font-size:var(--fs-xs)}
.topo-hub{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;display:grid;place-items:center;width:64px;height:64px;border:1px solid var(--accent-line);border-radius:50%;background:var(--accent-soft);color:var(--accent);font-family:var(--font-mono);font-size:var(--fs-xs)}
.topo-spoke{position:absolute;left:50%;top:50%;width:38%;height:0;border-top:1px dashed var(--line-strong);transform-origin:left center}
.topo-node{position:absolute;transform:translate(-50%,-50%);z-index:3;max-width:9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-2);color:var(--text);font-family:var(--font-mono);font-size:var(--fs-xs);padding:.35rem .6rem;cursor:pointer;min-height:0}
.topo-node.tone-ok{border-color:var(--ok);box-shadow:0 0 12px rgb(34 197 94/.25)}
.topo-node.tone-warn{border-color:var(--warn)}
.topo-node.tone-danger{border-color:var(--danger)}
.topo-list{display:none;gap:.35rem}
.topo-list .topo-node{position:static;transform:none;max-width:none;text-align:left;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px}
.toks-trace{display:flex;align-items:flex-end;gap:2px;height:56px;padding:.35rem 0 .25rem}
.toks-trace:empty{display:none}
.trace-bar{flex:1 1 auto;min-width:2px;min-height:2px;border-top:2px solid var(--accent);background:var(--accent-soft);border-radius:2px 2px 0 0}
.prompt-input{min-height:6rem;width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);padding:.55rem .7rem;font:inherit;line-height:1.55;resize:vertical}
.prompt-input::placeholder{color:var(--muted);opacity:1}
.prompt-input:focus-visible{outline:none;border-color:var(--accent);box-shadow:var(--focus)}
.table-wrap{overflow-x:auto;max-width:100%;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface)}
.nodes-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.nodes-table th{text-align:left;border-bottom:1px solid var(--line-strong);padding:.2rem .45rem}
.nodes-table td{border-bottom:1px solid var(--line);padding:.5rem .65rem;vertical-align:middle;min-width:0}
.nodes-table td>*{min-width:0;max-width:100%}
.nodes-table td .btn{margin-left:.5rem}
.nodes-table td[data-cell=version]{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.sort-btn{border:0;background:none;color:var(--text-2);font-family:var(--font-mono);font-size:var(--fs-xs);letter-spacing:.08em;text-transform:uppercase;cursor:pointer;padding:.45rem .2rem;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px}
.sort-btn:hover{color:var(--text)}
.link-btn{border:0;background:none;color:var(--text);font-family:var(--font-mono);font-size:var(--fs-sm);cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:.35rem 0;min-height:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drawer{position:fixed;top:0;right:0;bottom:0;z-index:40;width:min(26rem,92vw);max-width:100vw;border-left:1px solid var(--line-strong);background:linear-gradient(180deg,var(--surface-2),var(--surface));box-shadow:-16px 0 48px rgb(0 0 0/.45);padding:1.25rem;overflow-y:auto;overflow-x:hidden}
.drawer-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:1rem;border-bottom:1px solid var(--line);padding-bottom:.9rem}
.drawer-head h2{margin:0;font-size:var(--fs-lg);font-weight:800;letter-spacing:-.03em;overflow:hidden;text-overflow:ellipsis}
.drawer-body{display:grid;gap:.45rem}
.drawer-row{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem .75rem;min-width:0;border-bottom:1px solid var(--line);padding:.5rem 0;font-size:var(--fs-sm)}
.drawer-row>*{min-width:0;overflow-wrap:anywhere}
.drawer-row strong{color:var(--text-2);font-weight:600}
.drawer-row code{font-family:var(--font-mono)}
.drawer-row[data-tone=danger]{border-color:var(--danger-line)}
.drawer-row[data-tone=danger] code{color:var(--danger-text);word-break:break-word}
.drawer-subhead{flex-basis:100%;margin-top:.9rem;font-weight:600;color:var(--text-2);font-size:var(--fs-sm)}
.drawer-hint{flex-basis:100%;color:var(--muted);font-size:var(--fs-xs);margin:.1rem 0 0}
@media (min-width:${ADMIN_UI_RESPONSIVE.mobileBreakpointPx + 1}px){
.section-panel[data-active=false]{display:none}
}
@media (max-width:${ADMIN_UI_RESPONSIVE.mobileBreakpointPx}px){
.dash{grid-template-columns:1fr;grid-template-areas:"hero" "sections"}
.dashboard-hero{grid-template-columns:1fr;align-items:start}
.dashboard-hero h1{max-width:11ch}
.setup-layout{grid-template-columns:1fr}
.setup-rail{position:static}
.setup-rail .stepper{display:flex;gap:.5rem}
.setup-rail .stepper li{display:grid;grid-template-columns:1fr;border-left:0;border-radius:0;padding:.2rem 0;min-height:auto}
.setup-rail .stepper li::before{width:100%;height:3px;border-radius:999px}
#overview-tiles,.setup-stats{grid-template-columns:1fr}
#overview-tiles [data-stat=domain],#overview-tiles [data-stat=version],.setup-stats [data-setup-stat=node]{grid-column:auto}
.side-nav{display:none}
.section-panel[data-active=false]{display:none}
.brand-path{display:none}
main{padding:1rem .75rem 1.25rem}
.mobile-menu-btn{display:inline-flex}
.mobile-menu:not([hidden]){position:fixed;left:.75rem;right:.75rem;top:4rem;z-index:35;display:grid;gap:.2rem;border:1px solid var(--line-strong);border-radius:var(--radius-lg);background:rgb(var(--surface-rgb)/.98);backdrop-filter:blur(16px);box-shadow:0 18px 56px rgb(0 0 0/.5);padding:.5rem}
.mobile-menu .nav-item{border-left:0;border-radius:var(--radius-sm)}
.mobile-menu .nav-item:hover{background:var(--surface-2)}
.row-item .btn{margin-left:0;width:100%}
.topo-canvas{display:none}
.topo-list{display:grid}
.drawer{width:100vw;border-left:0}
.command-row{grid-template-columns:1fr}
.command-actions{justify-content:stretch}
.command-actions .btn,.form-actions .btn,.wizard-actions .btn{width:100%}
.node-filters .btn{width:auto}
.node-search{flex:1 1 100%}
.stepper li span{display:none}
.nodes-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.nodes-table tr{display:block;border-bottom:1px solid var(--line-strong);padding:.35rem 0}
.nodes-table td{display:flex;flex-wrap:wrap;justify-content:flex-start;align-items:center;gap:.3rem .6rem;border:0;padding:.4rem .65rem}
.nodes-table td::before{content:attr(data-label);flex:1 0 100%;color:var(--muted);font-weight:600}
.nodes-table td.empty-note::before{content:none}
.nodes-table td .btn{margin-left:0}
}
@media (max-width:480px){
.btn,input,select{min-height:48px}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}
}`
}
