import { ADMIN_UI_RESPONSIVE } from './admin-ui-contract'

/**
 * Design tokens + stylesheet for the admin console. Derived from the
 * codeflare.ch product design language: all-mono typography, zinc near-black
 * surfaces, hairline borders, one locked coral accent with dark ink on it,
 * and a semantic status set where danger is distinct from the accent.
 * Every size/colour/space flows from the token block below.
 */
export function adminUiCss(): string {
  return `:root{
  color-scheme:dark;
  --font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --bg:#09090b;
  --surface:#18181b;
  --surface-2:#1f1f23;
  --surface-3:#27272a;
  --line:#27272a;
  --line-strong:#3f3f46;
  --text:#fafafa;
  --text-2:#a1a1aa;
  --muted:#8a8a94;
  --accent:#ff5c3c;
  --accent-hover:#ff734f;
  --accent-ink:#160a06;
  --accent-soft:rgb(255 92 60/.12);
  --accent-line:rgb(255 92 60/.32);
  --ok:#22c55e;
  --warn:#f59e0b;
  --danger:#ef4444;
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
  --focus:0 0 0 2px rgb(255 92 60/.45);
  --speed-fast:.1s;
  --speed-base:.15s;
  --nav-w:13rem;
  --tab-h:3.5rem;
}
*,*::before,*::after{box-sizing:border-box}
*{margin:0}
html{-webkit-text-size-adjust:100%;background:var(--bg)}
body{min-height:100vh;background:var(--bg);color:var(--text-2);font:var(--fs-md)/1.55 var(--font-mono);-webkit-font-smoothing:antialiased}
::selection{background:rgb(255 92 60/.28);color:var(--text)}
a{color:inherit;text-decoration:none}
button,input,select{font:inherit}
h1,h2,h3{color:var(--text);letter-spacing:-.01em;text-wrap:balance}
h1{font-size:var(--fs-xl)}
h2{font-size:var(--fs-lg)}
h3{font-size:var(--fs-md)}
code,pre{font-family:var(--font-mono)}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:none;box-shadow:var(--focus)}
[hidden]{display:none!important}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:var(--surface-3);color:var(--text);font-size:var(--fs-md);font-weight:600;padding:.55rem .95rem;cursor:pointer;white-space:nowrap;transition:background var(--speed-base) ease-out,border-color var(--speed-base) ease-out,transform var(--speed-fast) ease-out,opacity var(--speed-base) ease-out}
.btn:hover{background:var(--line-strong)}
.btn:active{transform:scale(.98)}
.btn:disabled{cursor:not-allowed;opacity:.5}
.btn-primary{background:var(--accent);border-color:transparent;color:var(--accent-ink)}
.btn-primary:hover{background:var(--accent-hover)}
.btn-ghost{background:transparent;border-color:transparent;color:var(--text-2)}
.btn-ghost:hover{background:var(--surface-2);color:var(--text)}
.btn-danger{background:transparent;border-color:var(--danger-line);color:var(--danger)}
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
.chip{display:inline-flex;align-items:center;gap:.3rem;border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);font-size:var(--fs-xs);font-weight:600;padding:.12rem .55rem;white-space:nowrap}
.chip[data-tone=ok]{color:var(--ok);border-color:rgb(34 197 94/.35)}
.chip[data-tone=warn]{color:var(--warn);border-color:rgb(245 158 11/.35)}
.chip[data-tone=danger]{color:var(--danger);border-color:var(--danger-line)}
.chip[data-tone=accent]{color:var(--accent);border-color:var(--accent-line)}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--muted);flex:none}
.dot[data-tone=ok]{background:var(--ok)}
.dot[data-tone=warn]{background:var(--warn)}
.dot[data-tone=danger]{background:var(--danger)}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--line);background:rgb(9 9 11/.92);backdrop-filter:blur(12px);padding:.7rem clamp(1rem,3vw,1.5rem)}
.brand{display:inline-flex;align-items:center;gap:.6rem;min-width:0}
.brand-mark{width:.7rem;height:.7rem;border-radius:3px;background:linear-gradient(96deg,#ff8a3d 0%,#ff5c3c 52%,#ff3f7c 100%);flex:none}
.brand strong{color:var(--text);font-size:var(--fs-lg);font-weight:600;line-height:1}
.brand-path{color:var(--muted);font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-side{display:flex;align-items:center;gap:.6rem;min-width:0}
.health-pill{display:inline-flex;align-items:center;gap:.4rem;border:1px solid var(--line-strong);border-radius:999px;color:var(--muted);font-size:var(--fs-xs);font-weight:600;padding:.3rem .65rem}
.health-pill[data-health=ok]{color:var(--ok);border-color:rgb(34 197 94/.35)}
.health-pill[data-health=error]{color:var(--danger);border-color:var(--danger-line)}
main{width:min(1120px,100%);margin:0 auto;padding:1.25rem clamp(1rem,3vw,1.5rem) 4.5rem}
.view-gate{display:grid;justify-items:center;padding-top:clamp(1rem,6vh,4rem)}
.gate-flow{width:min(38rem,100%);display:grid;gap:1rem}
.slot{display:contents}
.gate-card{width:min(34rem,100%);display:grid;gap:1rem;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:clamp(1.1rem,4vw,1.75rem)}
.gate-card>p{color:var(--text-2);font-size:var(--fs-sm)}
.gate-alt{color:var(--muted);font-size:var(--fs-sm)}
.gate-alt a{color:var(--accent);text-decoration:underline}
.stepper{display:flex;gap:.25rem;list-style:none;padding:0;margin:0 0 1rem;counter-reset:step}
.stepper li{display:flex;align-items:center;gap:.45rem;flex:1;min-width:0;border-top:2px solid var(--line-strong);color:var(--muted);font-size:var(--fs-xs);font-weight:600;padding-top:.5rem;counter-increment:step}
.stepper li::before{content:counter(step);display:inline-flex;align-items:center;justify-content:center;width:1.3rem;height:1.3rem;border:1px solid var(--line-strong);border-radius:50%;flex:none;font-size:.7rem}
.stepper li[aria-current=step]{border-top-color:var(--accent);color:var(--text)}
.stepper li[aria-current=step]::before{background:var(--accent);border-color:transparent;color:var(--accent-ink)}
.stepper li[data-done=true]{border-top-color:var(--ok);color:var(--text-2)}
.stepper li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wizard-actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}
.token-warning{display:flex;gap:.5rem;border:1px solid rgb(245 158 11/.35);border-radius:var(--radius-sm);background:rgb(245 158 11/.08);color:var(--warn);font-size:var(--fs-sm);padding:.65rem .8rem}
.token-card{display:grid;gap:.35rem;border:1px solid var(--line-strong);border-radius:var(--radius-md);background:var(--surface-2);padding:.7rem}
.token-card strong{color:var(--muted);font-size:var(--fs-xs);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.token-card code{color:var(--text);font-size:var(--fs-sm);overflow-wrap:anywhere}
.token-card .btn{justify-self:start;min-height:2.2rem;padding:.35rem .7rem}
.dash{display:grid;grid-template-columns:var(--nav-w) minmax(0,1fr);gap:1.25rem;align-items:start}
.side-nav{position:sticky;top:4.5rem;display:grid;gap:.2rem}
.nav-item{display:grid;gap:.1rem;border-left:2px solid transparent;border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:.55rem .75rem;color:var(--text-2);min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px}
.nav-item:hover{background:var(--surface);color:var(--text)}
.nav-item[aria-current=page]{border-left-color:var(--accent);background:var(--surface);color:var(--text)}
.nav-item small{color:var(--muted);font-size:var(--fs-xs)}
.sections{display:grid;gap:1rem;min-width:0}
.panel{border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:clamp(.9rem,2.5vw,1.25rem);display:grid;gap:.9rem;min-width:0}
.panel-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem}
.panel-head p{width:100%;color:var(--muted);font-size:var(--fs-sm)}
.subpanel{display:grid;gap:.75rem;border-top:1px solid var(--line);padding-top:.9rem}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.75rem}
.form-actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center}
.result{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text-2);font-size:var(--fs-sm);line-height:1.6;padding:.65rem .75rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.result:empty{display:none}
.result.is-error{border-color:var(--danger-line);background:var(--danger-soft);color:var(--danger)}
.token-grid{display:grid;gap:.6rem}
.tile-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr));gap:.6rem}
.tile{display:grid;gap:.2rem;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface-2);padding:.65rem .75rem;min-width:0}
.tile strong{color:var(--muted);font-size:var(--fs-xs);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.tile code{color:var(--text);font-size:var(--fs-sm);overflow-wrap:anywhere}
.row-list{display:grid;gap:.5rem}
.row-item{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface-2);padding:.6rem .75rem;min-width:0}
.row-item code{color:var(--text);font-size:var(--fs-sm);overflow-wrap:anywhere}
.row-item .grow{flex:1 1 10rem;min-width:0;display:grid;gap:.15rem}
.row-item small{color:var(--muted);font-size:var(--fs-xs)}
.row-item .btn{min-height:2.2rem;padding:.35rem .7rem;margin-left:auto}
.empty-note{color:var(--muted);font-size:var(--fs-sm)}
.feed{display:grid;gap:.35rem}
.feed-item{display:flex;flex-wrap:wrap;gap:.5rem;color:var(--text-2);font-size:var(--fs-sm);border-top:1px solid var(--line);padding-top:.35rem}
.feed-item:first-child{border-top:0;padding-top:0}
.feed-item time{color:var(--muted);font-size:var(--fs-xs);margin-left:auto}
.banner{display:flex;gap:.5rem;border:1px solid var(--danger-line);border-radius:var(--radius-sm);background:var(--danger-soft);color:var(--danger);font-size:var(--fs-sm);padding:.65rem .8rem}
.api-list{display:grid;gap:.3rem;padding:.5rem 0 0}
.api-list code{color:var(--muted);font-size:var(--fs-xs)}
details summary{cursor:pointer;color:var(--text-2);font-size:var(--fs-sm);font-weight:600}
.tab-bar{display:none}
.toast{position:fixed;left:50%;bottom:calc(var(--tab-h) + 1rem);z-index:40;display:flex;align-items:center;gap:.7rem;max-width:min(26rem,calc(100vw - 2rem));border:1px solid var(--line-strong);border-radius:var(--radius-md);background:var(--surface-3);color:var(--text);font-size:var(--fs-sm);box-shadow:0 8px 32px rgb(0 0 0/.5);opacity:0;pointer-events:none;padding:.7rem .85rem;transform:translate(-50%,.4rem);transition:opacity var(--speed-base) ease-out,transform var(--speed-base) ease-out}
.toast.show{opacity:1;pointer-events:auto;transform:translate(-50%,0)}
.toast.is-error{border-color:var(--danger-line);color:var(--danger)}
.toast .btn{min-height:2rem;padding:.25rem .55rem}
.noscript-banner{display:block;border:1px solid var(--warn);color:var(--warn);border-radius:var(--radius-sm);font-size:var(--fs-sm);margin:1rem;padding:.7rem .85rem;text-align:center}
@media (min-width:${ADMIN_UI_RESPONSIVE.mobileBreakpointPx + 1}px){
.section-panel[data-active=false]{display:none}
}
@media (max-width:${ADMIN_UI_RESPONSIVE.mobileBreakpointPx}px){
.dash{grid-template-columns:1fr}
.side-nav{display:none}
.section-panel[data-active=false]{display:none}
.brand-path{display:none}
main{padding-bottom:calc(var(--tab-h) + 2rem)}
.tab-bar{position:fixed;left:0;right:0;bottom:0;z-index:30;display:grid;grid-template-columns:repeat(4,1fr);height:var(--tab-h);border-top:1px solid var(--line);background:rgb(9 9 11/.96);backdrop-filter:blur(12px);padding-bottom:env(safe-area-inset-bottom)}
.tab-item{display:grid;place-items:center;gap:.1rem;color:var(--muted);font-size:var(--fs-xs);font-weight:600;border:0;background:none;cursor:pointer;min-height:${ADMIN_UI_RESPONSIVE.minTouchTargetPx}px}
.tab-item .tab-glyph{font-size:1rem;line-height:1}
.tab-item[aria-current=page]{color:var(--accent)}
.more-sheet{position:fixed;left:.75rem;right:.75rem;bottom:calc(var(--tab-h) + .75rem);z-index:35;display:grid;gap:.2rem;border:1px solid var(--line-strong);border-radius:var(--radius-lg);background:var(--surface-3);box-shadow:0 8px 32px rgb(0 0 0/.5);padding:.5rem}
.more-sheet .nav-item{border-left:0;border-radius:var(--radius-sm)}
.more-sheet .nav-item:hover{background:var(--surface-2)}
.row-item .btn{margin-left:0;width:100%}
.form-actions .btn,.wizard-actions .btn{width:100%}
}
@media (max-width:480px){
.btn,input,select{min-height:48px}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}
}`
}
