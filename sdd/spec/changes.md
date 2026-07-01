# Changes

## 2026-07-01

- Added [REQ-OBS-005](observability.md#req-obs-005-node-self-unregistration) so node self-unregistration has a Node Agent actor scope separate from admin failure reporting.
- Updated [REQ-REL-004](release-ci.md#req-rel-004-security-workflows) so workflow safety rejects floating runner refs, floating action refs, reusable-workflow refs, and unsafe workflow-run checkouts.
- Updated [REQ-ADM-005](setup-admin.md#req-adm-005-optional-custom-domain) so custom-domain selection is stored and reused when Gateway sync chooses the Worker origin.
- Updated [REQ-SEC-002](security.md#req-sec-002-secret-storage-and-rotation-readiness) so node revocation removes nodes from scheduling while setup-token staging keeps existing setup credentials active.
- Updated [REQ-ADM-003](setup-admin.md#req-adm-003-setup-token-lifecycle) and [REQ-ADM-005](setup-admin.md#req-adm-005-optional-custom-domain) so setup tokens expire after 24 hours and stored custom domains continue driving Gateway sync.
- Added [REQ-ADM-006](setup-admin.md#req-adm-006-admin-configuration-ui) so the Admin UI presents setup, enrollment, routing, and operations as a guided responsive workflow.
- Updated [REQ-SEC-002](security.md#req-sec-002-secret-storage-and-rotation-readiness) so node revocation cannot be undone by later heartbeat or unregister calls.
- Updated [REQ-ADM-006](setup-admin.md#req-adm-006-admin-configuration-ui), [REQ-NODE-004](node-agent.md#req-node-004-local-dashboard), and [REQ-REL-004](release-ci.md#req-rel-004-security-workflows) so Admin UI HTML rejects framing, dashboard runtime controls report unavailable managed runtimes safely, and workflow safety validates each workflow job/step structurally.
- Updated [REQ-SCH-003](state-scheduling.md#req-sch-003-node-eligibility-and-scheduler-miss-responses) so busy responses identify busy/no-node outcomes with request IDs instead of promising Retry-After.

## 2026-06-30

- Added [REQ-ADM-006](setup-admin.md#req-adm-006-admin-configuration-ui) for a responsive browser Admin configuration UI covering first-run setup, login, status, setup tokens, installers, Gateway sync, custom-domain validation, node revocation, and profile rollout.
- Updated [REQ-REL-003](release-ci.md#req-rel-003-node-agent-release-artifacts) so deploy-published installers use the exact release tag selected for the node-agent artifacts.
- Production deploys require green main checks, manual integration deploys can run from any branch, and Fuzz participates in required gates.
- Workflow safety fails closed for unsafe workflow checks, and custom-domain persistence keeps Gateway routing stable.
- Dashboard-token controls, node failure reporting, and workflow safety are covered by automated verification.
- Legacy node-agent configs receive a dashboard token before dashboard controls are served, and dashboard Origin checks protect browser control requests.
- Bootstrapped the implementation-ready SDD scaffold for the private inference mesh from the accepted plan.
- Resolved the prior open decisions into binding requirements and architecture decisions.
- Implemented the router Worker, scheduler, node agent, CI/deploy workflows, behavioral tests, and source anchors for all drafted requirements.
- Removed stale e2e test scope, clarified CI-vs-targeted-local verification wording, and promoted dynamic route automation to P0 for v1 setup completeness.
