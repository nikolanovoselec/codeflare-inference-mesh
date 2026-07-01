# Changes

## 2026-07-01

- Added [REQ-OBS-005](observability.md#req-obs-005-node-self-unregistration) so node self-unregistration has a Node Agent actor scope separate from admin failure reporting.
- Workflow safety rejects floating runner refs, floating action refs, and unsafe workflow-run checkouts.
- Custom-domain selection is stored and reused when Gateway sync chooses the Worker origin.
- Node revocation removes nodes from scheduling while setup-token staging keeps existing setup credentials active.
- Setup tokens expire after 24 hours, and stored custom domains continue driving Gateway sync.
- The Admin UI presents setup, enrollment, routing, and operations as a guided responsive workflow.
- Node revocation now makes revoked nodes unable to restore scheduling through later heartbeat or unregister calls.
- Admin UI HTML responses now reject framing, dashboard runtime controls report unavailable managed runtimes safely, and workflow safety validates each workflow job/step structurally.

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
