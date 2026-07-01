# Admin UI Polish — Implementation Plan

**Source:** `packages/router-worker/src/admin-ui.ts` (409 lines) — single file serving entire admin UI  
**Score:** 24/40 → Target: 35+  
**Changes:** Only `admin-ui.ts` + `router.test.ts`. No new files.

---

## Phase 1: P0 Critical fixes

### 1. Fix toast duration and add dismiss button

**Change in `admin-ui.ts` → `adminUiScript()`:**

Replace the toast function:
```javascript
const toast = (message, isError = false) => {
  const el = byId('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('show');
  const timeout = isError ? 8000 : 3600;
  let dismissed = false;
  const dismiss = () => { dismissed = true; el.classList.remove('show'); };
  el.innerHTML = `<span>${message}</span><button type="button" data-toast-dismiss>Dismiss</button>`;
  el.querySelector('[data-toast-dismiss]')?.addEventListener('click', dismiss);
  setTimeout(() => { if (!dismissed) el.classList.remove('show'); }, timeout);
};
```

Update all calls to `toast()`:
- Info messages (setup complete, token verified, removed, copied): `toast('msg')` — keep 3.6s
- Error messages in catch block: `toast(message, true)` — 8s, error styling

### 2. Add setup-locked banner with scroll-to-auth

**Change in `admin-ui.ts` → `adminUiScript()` → catch block:**

After detecting setup-locked, create a persistent banner:
```javascript
if (action === 'first-run-setup' && error.status === config.setupLockedFeedback.status) {
  let banner = document.querySelector('[data-setup-banner]');
  if (!banner) {
    banner = document.createElement('div');
    banner.setAttribute('data-setup-banner', 'banner');
    banner.className = 'setup-banner';
    banner.innerHTML = '<p>Setup is already complete. <a href="#login" data-banner-action="go-to-auth">Go to Auth</a></p>';
    banner.querySelector('[data-banner-action="go-to-auth"]').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('login').scrollIntoView({ behavior: 'smooth' });
    });
    document.querySelector('.command-grid')?.insertBefore(banner, document.querySelector('.command-grid').firstChild);
  }
  banner.style.display = 'block';
}
```

**CSS to add to `adminUiCss()`:**
```css
.setup-banner{display:none;padding:.9rem 1rem;border:1px solid var(--accent-line);background:rgb(255 106 69/.06);border-radius:var(--radius-sm);color:#ff9a7f;font-size:.85rem;margin-bottom:1rem}
.setup-banner a{color:#ff9a7f;text-decoration:underline;font-weight:700}
.setup-banner p{margin:0}
```

### 3. Add confirmation dialog for "Revoke node"

**Change in `admin-ui.ts` → `adminUiScript()` → click handler:**

Replace the `action === 'node-revoke'` block:
```javascript
else if (action === 'node-revoke') {
  if (button.textContent === 'Revoke node') {
    // First click: show confirmation
    button.textContent = 'Are you sure?';
    button.disabled = false;
    return;
  }
  if (button.textContent === 'Are you sure?') {
    // Second click: confirm and revoke
    button.textContent = 'Revoke node';
    button.disabled = true;
    setScopeState(scope, 'loading');
    const nodeId = encodeURIComponent(byId('node-id').value.trim());
    showJson('node-output', await request('/admin/nodes/' + nodeId + '/revoke', { method: 'POST', headers: headers(true) }));
    setScopeState(scope, 'ready');
    button.textContent = 'Revoke node';
    button.disabled = false;
    return;
  }
}
```

---

## Phase 2: P1 High-impact improvements

### 4. Add `<meta name="color-scheme" content="dark">`

**Change in `admin-ui.ts` → `adminUiHtml()`:**
```html
<!-- Add after <meta name="viewport" ...> -->
<meta name="color-scheme" content="dark">
```

### 5. Add `::selection` styles

**Change in `adminUiCss()`:**
```css
/* Add after body{...} */
::selection{background:var(--accent);color:#170b06}
```

### 6. Mobile layout fixes

**Change in `admin-ui.ts` → `adminUiCss()` → `@media (max-width:760px)` block:**

Replace current mobile styles:
```css
@media (max-width:760px){
  .topbar{position:static;align-items:flex-start;flex-direction:column}
  .origin-pill{align-items:flex-start;flex-direction:column;max-width:100%}
  .console{padding-top:1rem}
  .status-strip{display:flex;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .status-item{min-width:7.5rem}
  /* Gradient fade on right edge */
  .status-strip::after{content:'';position:absolute;right:0;top:0;bottom:0;width:2rem;background:linear-gradient(to right,transparent,var(--surface));pointer-events:none;z-index:1}
  .command-grid{grid-template-columns:1fr}
  /* Collapse rail to vertical stack */
  .workflow-rail{position:static;display:grid;gap:.35rem}
  .rail-item{min-width:0;text-align:center}
  .action-row{grid-template-columns:1fr}
  .row-copy p{max-width:65ch}
  .control-line,.control-stack{align-items:stretch;flex-direction:column}
  .control-input,.control-input.short,select,button{width:100%;max-width:none;min-width:0;flex-basis:auto}
  .result{max-height:none}
}
```

### 7. Add inline help for domain-specific fields

**Change in `admin-ui.ts`:**

Add `help` to `ActionRowOptions` interface:
```typescript
interface ActionRowOptions {
  readonly id: string
  readonly actionId: string
  readonly title: string
  readonly description: string
  readonly controls: string
  readonly outputId: string
  readonly outputKind: string
  readonly empty: string
  readonly help?: string
  readonly tag?: 'div' | 'pre'
  readonly surfaceClass?: string
}
```

Add `field-help` to `actionRow()` function output (after controls):
```typescript
const helpHtml = options.help ? `<div class="field-help">${escapeHtml(options.help)}</div>` : ''
// Include helpHtml in row-controls section
```

Update specific action row calls in `adminUiHtml()`:
```typescript
// Profile rollout:
${actionRow({ ..., help: 'What percentage of traffic should route to this model (0–100)?' })}

// Custom domain:
${actionRow({ ..., help: 'Your Cloudflare zone ID (found in the dashboard URL or DNS settings)' })}
```

**CSS for `.field-help`:**
```css
.field-help{color:var(--dim);font-size:.72rem;margin-top:.25rem}
```

---

## Phase 3: P2 Polish passes

### 8. Convert `renderTokens` from innerHTML to createElement

**Change in `admin-ui.ts` → `adminUiScript()`:**
```javascript
function renderTokens(target, values) {
  const el = byId(target);
  el.classList.remove('is-error');
  el.innerHTML = '';
  const entries = Object.entries(values).filter(([, value]) => typeof value === 'string');
  entries.forEach(([key, value]) => {
    const div = document.createElement('div');
    div.className = 'token';
    const label = document.createElement('strong');
    label.textContent = key;
    div.appendChild(label);
    const code = document.createElement('code');
    code.textContent = value;
    div.appendChild(code);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.dataset.copy = value;
    div.appendChild(copyBtn);
    el.appendChild(div);
  });
  // Add copy-all button after rendering
  if (entries.length > 1) {
    const copyAllBtn = document.createElement('button');
    copyAllBtn.type = 'button';
    copyAllBtn.textContent = 'Copy all';
    copyAllBtn.addEventListener('click', async () => {
      const allValues = entries.map(([k, v]) => k + ': ' + v).join('\n');
      await navigator.clipboard.writeText(allValues);
      toast('Copied all');
    });
    el.prepend(copyAllBtn);
  }
}
```

### 9. Add `role="log"` to all result output areas

**Change in `admin-ui.ts` → `adminUiHtml()` → `actionRow()` function:**
```typescript
// Change from:
// <${outputTag} class="${surfaceClass}" id="${escapeHtml(options.outputId)}" data-output="${escapeHtml(options.outputKind)}" data-empty="${escapeHtml(options.empty)}"${outputTag === 'pre' ? ' tabindex="0"' : ''} aria-live="polite"></${outputTag}>

// To:
// <${outputTag} class="${surfaceClass}" id="${escapeHtml(options.outputId)}" data-output="${escapeHtml(options.outputKind)}" data-empty="${escapeHtml(options.empty)}" role="log"${outputTag === 'pre' ? ' tabindex="0"' : ''} aria-live="polite"></${outputTag}>
```

### 10. Improve focus-visible outline for small screens

**Change in `adminUiCss()`:**
```css
/* Add after @media (prefers-reduced-motion:reduce) */
@media (max-width:480px){
  :root{--focus:0 0 0 2px rgb(255 106 69/.28)}
}
```

### 11. Add `is-error` styling to toast

**Change in `adminUiCss()`:**
```css
/* Add after .toast.show{...} */
.toast.is-error{border-color:var(--accent-line);background:rgb(255 106 69/.1);color:#ff9a7f}
```

### 12. Add touch target sizing for very small screens

**Change in `adminUiCss()`:**
```css
/* Add after @media (max-width:480px) block */
@media (max-width:480px){
  :root{--focus:0 0 0 2px rgb(255 106 69/.28)}
  button{min-height:48px}
  .control-input,select{min-height:48px}
}
```

---

## Phase 4: Testing

### 13. Update `router.test.ts` — add assertions to REQ-ADM-006 test

Add to the existing REQ-ADM-006 test:
```typescript
// After existing assertions, add:
expect(html).toMatch(/color-scheme.*dark/)
expect(html).toMatch(/role="log"/)
expect(html).toMatch(/data-toast-dismiss/)
expect(html).toMatch(/data-setup-banner/)
expect(html).toMatch(/Copy all/)
expect(html).toMatch(/field-help/)
```

---

## Files to modify

| File | Changes |
|------|---------|
| `packages/router-worker/src/admin-ui.ts` | All changes (toast, banner, confirmation, meta, CSS, createElement, role="log", copy-all, field-help) |
| `packages/router-worker/src/router.test.ts` | Add test assertions for new features |

## Estimated effort

| Phase | Effort |
|-------|--------|
| Phase 1 (P0) | 2h |
| Phase 2 (P1) | 2h |
| Phase 3 (P2) | 1.5h |
| Phase 4 (Testing) | 1h |
| **Total** | **~6.5h** |

## Verification

After deploying:
1. **Desktop:** Toast stays 8s on errors, dismiss button works, setup-locked banner visible
2. **Mobile (≤760px):** Rail is vertical, status strip scrollable with gradient fade
3. **Revoke node:** Two-click confirmation works
4. **Accessibility:** `role="log"` on output areas, focus ring correct on all screens
5. **Copy-all:** Button appears for setup output with multiple tokens
6. **Inline help:** Help text visible under rollout percent and Zone ID fields

# Appendix: Impeccable Analysis

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Loading states on buttons don't disable; error toast auto-dismisses in 3.6s with no way to retry |
| 2 | Match System / Real World | 3 | Admin terminology is domain-appropriate; "mesh", "profiles", "rollout" are standard infra terms |
| 3 | User Control and Freedom | 1 | No undo on "Revoke node"; no "Forget token" confirmation; "Setup is locked" error offers no way back |
| 4 | Consistency and Standards | 3 | Action rows use consistent `[data-state]` pattern; status badges uniform; but `<pre>` for some outputs vs `<div>` for others is inconsistent |
| 5 | Error Prevention | 3 | "Revoke node" has no confirmation modal; profile rollout has 0–100 range but no input guard against typos beyond `min`/`max` |
| 6 | Recognition Rather Than Recall | 3 | API endpoints visible per action row; but token values generated in setup are only shown once with no copy-to-clipboard until user clicks a button in the output area |
| 7 | Flexibility and Efficiency of Use | 1 | No keyboard shortcuts; no "remember token" persistence via localStorage (relies on sessionStorage by default); no bulk operations |
| 8 | Aesthetic and Minimalist Design | 4 | Clean dark palette, good hierarchy, purposeful use of accent, no decorative clutter |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 2 | Error toast dismisses too fast (3.6s); `friendlyError` handles setup-locked and 401 cases but other errors show generic "Request failed" |
| 10 | Help and Documentation | 2 | No inline help on any field; no tooltips on "rollout percent" or "Zone ID"; API method badges help but no explanations of what each action does |
| **Total** | | **24/40** | **Acceptable. Significant improvements needed before users are happy.** |

## Anti-Patterns Verdict

**LLM assessment:** This does not look AI-generated. It has a deliberate, opinionated design with a cohesive dark palette, strong typographic hierarchy, and purposeful use of the orange accent (`#ff6a45`). The command-center layout with a sticky left rail and right-side action cards is a real design decision, not a template reflex. The inline JSON config (`admin-ui-config`) powering the JS is a smart server-rendered approach.

**Deterministic scan:** The bundled detector returned empty (AST-only source, no CSS framework files to scan). This is expected since the entire UI is inline CSS + JS in a single HTML string.

**Visual overlays:** Not available — the page is self-contained HTML with inline scripts.

## Overall Impression

This is genuinely solid admin UI for an infra tool. The dark theme is well-calibrated, the action-row pattern is consistent, and the inline JSON config driving the JS is a clever zero-dependency architecture. The biggest opportunity: the error handling and user guidance are too thin for a tool that deals with credentials, tokens, and live infrastructure. An admin who just locked themselves out of first-run setup needs better guidance than a 3.6-second toast.

## What's Working

### 1. `[data-state]` state machine
The `idle` → `loading` → `ready`/`error` state machine with `aria-busy`, button disabling, and color-coded row backgrounds (`[data-state=loading]`, `[data-state=ready]`, `[data-state=error]`) is a real production-quality pattern. It's visible, testable, and consistent.

### 2. Inline config-driven JS
The `<script type="application/json" id="admin-ui-config">` approach means the Go server can inject runtime config (origin, actions, responsive breakpoints) without touching the JavaScript. The JS is dependency-free, self-contained, and works in any browser. No framework, no build step, no CSP injection issues.

### 3. CSS custom properties
The token system (`--bg`, `--surface`, `--surface-2`, `--surface-3`, `--line`, `--accent`, `--focus`) is well-structured. The `--focus` box-shadow for focus-visible states is correct. The `color-scheme: dark` hint is a good browser behavior signal.

## Priority Issues

### P0: Setup error guidance is broken (blocking)
**What:** The screenshot shows the admin just tried first-run setup on a live instance that already has setup complete. The error message "Setup is already complete for this Worker. Paste the existing admin token..." appears in the output area but is buried below the action row. There's no banner, no visual emphasis, and no direct link to the Auth section.

**Why it matters:** An admin who can't set up the mesh can't use the tool at all. The error is the most critical one — and it's the least visible.

**Fix:** Move the locked-setup error to a prominent banner above the workflow rail. Auto-scroll to the auth section. Add a clear "Go to Auth" button.

### P1: Error toast dismisses in 3.6 seconds
**What:** `setTimeout(() => el.classList.remove('show'), 3600)` — every error toast (including auth failures, 500s, validation errors) vanishes in 3.6 seconds with no retry or expand option.

**Why it matters:** If a node revocation fails or a gateway sync errors out, the admin has to catch the toast mid-dismiss. That's not recoverable.

**Fix:** Increase to 8–10 seconds for errors. Add a "Dismiss" button or make the toast clickable to expand with full error details.

### P1: No confirmation on destructive "Revoke node"
**What:** The "Revoke node" button fires `POST /admin/nodes/{nodeId}/revoke` immediately on click, with no intermediate state.

**Why it matters:** A typo in the Node ID field that matches a live node could silently revoke the wrong one. There's no confirmation dialog, no second-step verification.

**Fix:** Add a confirmation dialog before revocation, or require the button to be clicked twice. At minimum, show an inline confirmation prompt.

### P2: Mobile workflow rail items are silently cut off
**What:** On the mobile screenshot (393px width), the workflow rail shows "Setup | Auth | Enroll" — "Route" and "Operate" are not visible. The CSS uses `display: flex; overflow-x: auto` but there's no scroll indicator or visual cue that more items exist.

**Why it matters:** Mobile admins can't see all five sections of the mesh. They might miss the "Operate" section entirely.

**Fix:** Add a "scroll to see more" chevron or reduce the rail to a vertical list on mobile. The current `@media (max-width:760px)` collapses it to a flex row — consider collapsing to a vertical accordion or a bottom nav instead.

### P2: Status strip shows only partial data on mobile
**What:** On mobile, the 5-column status strip ("Setup", "Auth", "Nodes", "Profiles", "Audit") collapses to `overflow-x: auto` but only shows 3 columns at a time with no visual indication of the remaining two.

**Why it matters:** An admin scanning mobile can't see "Profiles" or "Audit" counts without scrolling the status strip.

**Fix:** Make the status strip scrollable with a subtle gradient edge indicator, or collapse to a vertical stack on mobile.

## Persona Red Flags

**Alex (Power User):** No keyboard shortcuts. No `Ctrl+Shift+S` for status refresh. No `Escape` to dismiss toasts. Token values in setup output require manual select-and-copy (the `data-copy` buttons exist but only render after a successful request — the copy button isn't visible for the initial credential display).

**Jordan (First-Timer):** No inline help on any field. What does "rollout percent" mean to someone who's never managed model profiles? What's a "Zone ID"? No tooltips, no explanations, no contextual documentation.

**Sam (Accessibility-Dependent User):** The `.result:empty::before { content: attr(data-empty) }` pattern is good for screen readers. The `code` element for the origin URL has no `label` association. Contrast: `#b0b0ba` on `#09090b` is ~8.2:1 (good). Body text `#b0b0ba` on `#101014` is ~6.8:1 (passes AA).

## Minor Observations

- The `codeflare-headline` uses `!important` on `font-size`, `font-weight`, `letter-spacing`, and `line-height` — this is fragile but intentional to override the `.overview h1` default. It works but should be a single class.
- The `toast` function uses `textContent` (safe from XSS) and `setTimeout` with a hardcoded 3600ms — if you later add user-facing errors with stack traces, 3.6s will feel even shorter.
- `renderTokens` uses `innerHTML` with escaped values from `esc()`. This is safe because `esc()` HTML-escapes the values. But `copyButton(value)` generates HTML via string concatenation — consider using `document.createElement` to avoid the mental tax of "is this safe?".
- The `<pre>` elements for output areas have `tabindex="0"` — good for keyboard focus, but they're not inside a `<form>` and don't have `role="log"`. Screen readers might not announce their content changes.
- No `<meta name="color-scheme" content="dark">` — the CSS has `color-scheme: dark` on `body` but the meta tag helps the browser render native UI elements (scrollbars, selection) consistently.
- The `@media (prefers-reduced-motion: reduce)` block is correct but too broad — it disables `scroll-behavior: smooth` which might be intentional.

## Code Quality Assessment

### Strengths (verified in source)

1. **Zero dependencies** — The entire UI is vanilla JS/CSS/HTML. No framework, no build step, no CSP injection issues. The inline `<script type="application/json" id="admin-ui-config">` pattern is architecturally sound.

2. **XSS safety** — `escapeHtml()` covers `& < > "` consistently. `scriptJson()` escapes `<` to `\u003c`. The `esc()` function in the client-side JS is correct. `renderTokens` uses `innerHTML` but values are escaped — safe but mentally taxing.

3. **State machine** — The `[data-state]` pattern on action rows (`idle` → `loading` → `ready`/`error`) is production-quality. `aria-busy` updates correctly. Button disable/restore in `finally` block prevents double-submits.

4. **Token storage** — Tokens go to sessionStorage (default) or localStorage (if "Remember" checked). Never sent as bearer unless an admin action requires it. Correct.

5. **CSP headers** — `frame-ancestors 'none'` and `X-Frame-Options: DENY` prevent framing attacks.

6. **Setup-locked feedback** — The JS has a `friendlyError()` function that detects the `setup-locked` scenario and shows human-readable text instead of raw JSON. Verified by test.

### Weaknesses (verified in source)

1. **Toast dismisses too fast** — `setTimeout(() => el.classList.remove('show'), 3600)` in `adminUiScript()`. Every error toast vanishes in 3.6 seconds with no way to retry.

2. **Setup-locked error is buried** — Error appears in action row's output area (a `<div class="result" id="setup-output">`). The user has to scroll to find it, and there's no visual emphasis.

3. **No confirmation on destructive "Revoke node"** — Clicking "Revoke node" immediately fires `POST /admin/nodes/{nodeId}/revoke` with no intermediate state.

4. **Missing `<meta name="color-scheme" content="dark">`** — The CSS has `color-scheme: dark` on `body` but no meta tag in the HTML head. Browser-native UI elements may not match the dark theme on some browsers.

5. **Mobile layout issues** — On mobile (≤760px): the workflow rail shows items horizontally but cuts off "Route" and "Operate" silently. The status strip shows only 3 of 5 columns at a time with no gradient fade.

6. **No inline help for domain-specific fields** — Fields like "rollout percent", "Zone ID", "Sync Gateway" have no explanation. First-time admins won't know what they mean.

7. **`renderTokens` uses innerHTML** — Safe via `esc()` but mentally taxing for future maintainers to verify XSS safety.

8. **`role="log"` missing from result `<pre>`** — Result output areas have `aria-live="polite"` but not `role="log"`. Screen readers may not announce dynamic content changes properly.

9. **Focus-visible outline too large on small screens** — The 3px focus ring is correct for desktop but can feel large on small screens (≤480px).

10. **No "Copy All" button for setup output** — Generated credentials appear as multiple token divs. The user must click each "Copy" button individually.

## Spec Compliance

### REQ-ADM-006 (Admin configuration UI) — ✅ Compliant
- HTML served without bearer token ✅
- All 11 admin functions exposed ✅
- Tokens stored in browser-controlled storage ✅
- Generated tokens only from creation responses ✅
- Responsive on desktop and mobile ✅
- CSP headers present ✅

### REQ-ADM-007 (Admin command center) — ✅ Compliant
- Status strip at top ✅
- Persistent navigation order ✅
- All rail links resolve to sections ✅
- Action row layout consistent ✅
- Setup-locked feedback instead of raw JSON ✅

### REQ-SEC-002 (CSP / framing prevention) — ✅ Compliant
- `frame-ancestors 'none'` ✅
- `X-Frame-Options: DENY` ✅

## Test Coverage (verified in `router.test.ts`)

The tests cover structural contracts but not visual/UX quality:

| Test | What's verified | What's NOT verified |
|------|----------------|---------------------|
| REQ-ADM-006 | HTML served, config integrity, CSP headers | Toast duration, error visibility, mobile layout |
| REQ-ADM-007 | Command center layout, action row consistency | Confirmation dialogs, inline help, accessibility |
| Setup-locked | Error message rendered, state set to `error` | Banner visibility, scroll-to-auth, "Go to Auth" button |

---

## What NOT to change

- `admin-ui-config` JSON structure (contract between server and JS)
- `[data-state]` pattern (already correct)
- `escapeHtml()` function (correct)
- Token storage logic (correct)
- CSP headers (correct)
- `ADMIN_UI_COMMAND_CENTER` / `ADMIN_UI_ACTION_ROW_ANCHOR` constants (correct)
- Test anchors (`REQ-ADM-006`, `REQ-ADM-007`) — existing tests pass, new assertions added
