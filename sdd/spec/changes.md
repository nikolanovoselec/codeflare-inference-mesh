# Changes

## 2026-06-30

- Added [REQ-ADM-006](setup-admin.md#req-adm-006-admin-configuration-ui) for a responsive browser Admin configuration UI covering first-run setup, login, status, setup tokens, installers, Gateway sync, custom-domain validation, node revocation, and profile rollout.
- Updated [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts) so deploy-published installers use the exact release tag selected for the node-agent artifacts.
- Updated [REQ-REL-002](release-ci.md#req-rel-002-deploy-workflow-gating) and [REQ-REL-004](release-ci.md#req-rel-004-security-workflows) so production deploys follow green main checks, manual integration deploys can run from any branch, and Fuzz participates in required gates.
- Updated [REQ-SEC-004](security.md#req-sec-004-runtime-api-exposure), [REQ-OBS-004](observability.md#req-obs-004-failure-reporting), and [REQ-REL-004](release-ci.md#req-rel-004-security-workflows) for dashboard-token controls, node self-unregistration, and workflow safety coverage.
- Clarified [REQ-SEC-005](security.md#req-sec-005-dashboard-token-lifecycle) dashboard-token backfill lifecycle, dashboard Origin handling, and admin API Origin-contract shape.
- Bootstrapped the implementation-ready SDD scaffold for the private inference mesh from the accepted plan.
- Resolved the prior open decisions into binding requirements and architecture decisions.
- Implemented the router Worker, scheduler, node agent, CI/deploy workflows, behavioral tests, and source anchors for all drafted requirements.
- Removed stale e2e test scope, clarified CI-vs-targeted-local verification wording, and promoted dynamic route automation to P0 for v1 setup completeness.
