# Design

The admin console's visual and interaction system. Register: **product** (see
[PRODUCT.md](PRODUCT.md)). The design language derives from codeflare.ch's
product surfaces: all-mono typography, zinc near-black surfaces, hairline
borders instead of boxes, one locked coral accent with dark ink on it, real
semantic status colors, and state rendered from truth rather than prose.

## View state machine

The Worker owns the state the page shows, so the shell is server-rendered into
one of two entry views and never guesses:

| Server state | `<body data-view>` | What renders |
|---|---|---|
| No active admin token (setup open) | `setup` | Guided setup wizard |
| Setup locked, no verified session | `login` | Sign-in card only |
| Client verifies a token | `dashboard` | Sectioned operator dashboard |

Rules: the shell loads with no bearer token (REQ-ADM-006). The login view
reveals nothing about deployment state beyond "setup is complete". Tokens are
stored in browser storage only after `POST /admin/login` verifies them.
Dashboard data (status, versions) is fetched only after verification.

## Information architecture

Six noun sections, each a dashboard panel; one landing page (Overview):

1. **Overview** — health rollup, node/profile/audit counts, gateway target,
   recent activity feed. Auto-loaded on dashboard entry.
2. **Nodes** — node table (status dot + label, runtime state, reported vs
   desired agent version), per-row revoke (two-step confirm), enroll block
   (setup token + platform install command).
3. **Models** — profile table (aliases, active, rollout %, readiness),
   activation control, rollout control.
4. **Routing** — AI Gateway sync form, custom domain form. Labeled fields,
   resolved defaults shown from status.
5. **Mesh** — per-profile mesh health (coordinator, peers, ready models,
   failed nodes, rotation, secret presence/age — never values), one-click
   rotate behind a two-step confirm.
6. **Settings** — session (sign out), fleet agent version pinning, audit log,
   recovery guidance, compact API reference.

Wizard steps (setup view): 1 Create credentials (one-time token reveal with
copy + "shown once" warning, auto-session) → 2 Connect AI Gateway (skippable)
→ 3 Enroll first node (skippable) → 4 Review & finish → dashboard. Numbered
stepper, Back preserves inputs, every step redoable from its dashboard section.

## Navigation

- **Desktop (≥761px)**: fixed left rail, 6 items, `aria-current="page"` on the
  active section.
- **Mobile (≤760px)**: bottom tab bar with Overview, Nodes, Mesh, More; More
  opens a sheet listing Models, Routing, Settings. Labeled icons, 44px+
  targets, thumb-zone primary actions.

## Color tokens

Dark only (`color-scheme: dark`, dark first paint on `<html>`).

| Token | Value | Role |
|---|---|---|
| `--bg` | `#09090b` | page |
| `--surface` | `#18181b` | panels |
| `--surface-2` | `#1f1f23` | inputs, nested chrome |
| `--surface-3` | `#27272a` | hover, elevated |
| `--line` | `#27272a` | hairlines |
| `--line-strong` | `#3f3f46` | interactive borders |
| `--text` | `#fafafa` | primary ink |
| `--text-2` | `#a1a1aa` | body/secondary |
| `--muted` | `#8a8a94` | labels/meta (AA ≥4.5:1 on all surfaces; nothing dimmer carries text) |
| `--accent` | `#ff5c3c` | primary actions, selection, focus — never danger |
| `--accent-hover` | `#ff734f` | |
| `--accent-ink` | `#160a06` | ink on accent fills |
| `--ok` / `--warn` / `--danger` / `--info` | `#22c55e` / `#f59e0b` / `#ef4444` / `#3b82f6` | semantic status; danger is distinct from accent |

Status is always shape/glyph + color + text label, never color alone.

## Typography

All JetBrains Mono (codeflare product idiom), loaded 400/600 via Google Fonts
with `ui-monospace` stack fallback. Fixed rem scale, no fluid display type:
12px (uppercase tracked labels only), 13px body, 14px controls, 16px section
titles, 18px page title. No text below 12px. Sentence case everywhere; terse
lowercase state words in pills ("online", "stale", "absent").

## Shape, depth, motion

Radii 6/8/12px. 1px hairlines, flat surfaces, no decorative shadows or glows;
elevation only on overlays (toast, mobile More sheet). Focus =
`0 0 0 2px rgb(255 92 60 / .45)` ring. Press = `scale(0.98)`. Transitions
100–150ms ease-out, state-conveying only; full `prefers-reduced-motion`
fallback. Content never gated on JS reveals.

## Components

One vocabulary shared by wizard and dashboard: panel, field (visible label +
input + inline hint), button (primary/secondary/ghost/danger + loading),
status dot+label, chip, one-time token reveal (mono box, copy, warning),
stepper, nav item, table row, empty state (teaches the next action), toast +
inline per-action result with request id on errors. Destructive buttons arm on
first press ("Confirm …?", danger fill) and auto-disarm after 5s.

## Client architecture

The behavior script is a single pure template literal
(`admin-ui-client.ts`) with zero interpolation — nothing is serialized from
bundled code, so bundler helpers (`__name`) can never leak into the page
(the production-breaking bug this design replaces). Config crosses via one
JSON `<script type="application/json">` blob. Rendering uses `textContent` /
`createElement`; behavioral tests execute the full served script against a
stub DOM.

## Success criteria & verification

1. **No overengineering** — no framework, no build step for the UI, no new
   endpoints; one client script, one CSS block, string components.
2. **Behavioral tests only** — tests execute the served script (login order:
   verify before store; confirm arming; renderers fed fake status) and assert
   structure/contract values (data-view modes, labels for every input, no
   `__name`, script parses, section/nav wiring), never copy.
3. **Composable components** — every repeated structure (field, panel, nav
   item, token card, table row) is one function; all values flow from the
   token block; retuning is a one-line edit.
4. **SDD+TDD closed loop** — REQ-ADM-006/007 rewritten + REQ-ADM-011 (guided
   setup) added, all `Implemented` with `@impl`/`@test` anchors; docs lanes
   updated in the same change; CI green and review clean before deploy;
   post-deploy live verification on 1440px and 390px viewports.
