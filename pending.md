# Pending Work

This file tracks implementation work that is not itself a requirement.

## Current state

- Source implementation has not started.
- Every product REQ is `Planned`.
- The next action after this scaffold is formal Plan Mode, then RED/GREEN/VERIFY implementation one REQ at a time.
- Source `@impl` anchors are intentionally absent until code exists; they must be added in the same change that moves a REQ to `Partial` or `Implemented`.

## Verification policy

- Write failing behavioral tests before implementation.
- Test names include the relevant REQ ID.
- Do not run local test suites in this container; push and verify through CI when implementation begins.
