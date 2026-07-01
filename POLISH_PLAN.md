# Admin UI Polish — Execution Plan

**Surface:** `packages/router-worker/src/admin-ui.ts`
**Tests:** `packages/router-worker/src/router.test.ts`
**Spec trace:** `REQ-ADM-006`, `REQ-ADM-007`, and the node-revoke UX for `REQ-SEC-002`
**Scope:** UI polish only. No API shape, storage, credential, or route changes.

## Execution tasks

1. **Safer operator feedback**
   - Keep toast content text-only through DOM APIs; never interpolate server/user text through `innerHTML`.
   - Give error toasts an 8s timeout, normal toasts the existing 3.6s timeout, and clear the previous timer before showing a new toast.
   - Add a dismiss button and re-enable pointer events only while the toast is visible.
   - Style error toasts with the existing accent/error tokens.

2. **Setup-locked recovery path**
   - Render a hidden setup-locked banner in the page, outside the command grid so it cannot disturb the rail/work-area grid.
   - When first-run setup returns the setup-locked status, show the banner, mark the setup output with the existing `setup-locked` feedback dataset value, and move the operator to the Auth section.
   - The banner link reuses the same Auth-section focus/scroll behavior.

3. **Destructive action guard**
   - Require a second click before `node-revoke` posts.
   - Track confirmation with button dataset state, not button copy.
   - Keep the row out of `loading` on the first click; only enter `loading` for the confirmed request.
   - Reset confirmation state after success or failure.

4. **Responsive and accessibility polish**
   - Add `<meta name="color-scheme" content="dark">` to match the dark product UI.
   - Add `::selection` styling from existing accent tokens.
   - Change the mobile workflow rail from hidden horizontal overflow to a vertical stack.
   - Keep the mobile status strip scrollable but add a right-edge gradient cue.
   - Add `role="log"` to dynamic result surfaces that already use `aria-live="polite"`.
   - Add a smaller mobile focus ring and 48px touch targets at very small widths.

5. **Token output handling**
   - Replace setup-token rendering with `createElement`/`textContent`.
   - Keep individual copy controls and add a copy-all control when multiple token values are returned.
   - Store raw token values in `dataset.copy` and copy them directly; do not use URI encode/decode for clipboard payloads.

6. **Inline help**
   - Extend `actionRow` with an optional help slot.
   - Add help for profile rollout percentage and Cloudflare zone ID because those are domain-specific fields.

## Behavioral verification plan

- Existing route/admin UI contract tests stay in place.
- Add script-level behavior tests that execute the real inline admin script against DOM stubs:
  - setup-locked errors show the recovery banner, move focus to Auth, mark output feedback, show an error toast for 8s, and allow dismissing the toast;
  - node revoke does not call `fetch` on the first click and posts only after confirmation;
  - generated setup tokens render copy-all behavior and write all token values to the clipboard.
- Add structural contract checks only for stable machine-readable UI affordances: dark color-scheme meta, `role="log"` output surfaces, field-help count, and setup-banner presence.

## Success criteria & verification

1. **No overengineering:** only `POLISH_PLAN.md`, `admin-ui.ts`, and `router.test.ts` change; no new dependencies, files, or API/config surfaces.
2. **Behavioral tests only:** new tests exercise the real inline script behavior and observable DOM/clipboard/fetch effects. Structural checks are limited to stable contract attributes, not prose copy.
3. **Reusable/composable UI:** repeated action-row structure remains centralized in `actionRow`; help text is an option on that existing component; styles use existing tokens.
4. **SDD + TDD:** changes trace to implemented `REQ-ADM-006`, `REQ-ADM-007`, and `REQ-SEC-002`; failing behavioral tests were authored before implementation; no REQ is left `Partial`.
5. **Release gates:** do not push while the current PR-boundary review monitor is incomplete unless explicitly overridden. After push, start CI and review monitoring for the new head and iterate until both are green before integration deployment.
