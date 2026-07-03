# Security Policy

Codeflare Inference Mesh connects a public Cloudflare AI Gateway route to private inference nodes. Security reports are taken seriously, especially anything affecting credential separation, node reachability, Cloudflare API permissions, install scripts, or Worker-to-node traffic.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for suspected vulnerabilities.

Use GitHub private vulnerability reporting:

<https://github.com/nikolanovoselec/codeflare-inference-mesh/security/advisories/new>

If GitHub private reporting is unavailable for you, open a minimal public issue that says only that you need a private security contact. Do not include exploit details, tokens, logs, URLs, or proof-of-concept payloads in public.

## What to Include

A useful report includes:

- affected component: router Worker, node agent, install script, workflow, or documentation;
- affected route, command, workflow, or file path;
- impact and who can exploit it;
- reproduction steps with safe placeholder values;
- expected behavior and actual behavior;
- any relevant Cloudflare or GitHub permission context.

Please redact secrets before sharing logs. Never send live provider, admin, setup, node, upstream, GitHub, or Cloudflare API tokens.

## Supported Versions

Security fixes target the active development line until the first stable release is cut.

| Version | Supported |
| --- | --- |
| `develop` branch | Yes |
| `main` branch | Yes, once changes are merged from `develop` |
| GitHub prereleases | Best effort |
| Unreleased forks | No |

After tagged releases begin, this table will be updated with supported release ranges.

## Security Boundaries

The project intentionally separates these credentials and trust boundaries:

- client to Cloudflare AI Gateway;
- AI Gateway to the Worker provider API;
- admin to Worker setup/admin routes;
- installer setup token to node claim;
- node token to heartbeat/unregister;
- Worker upstream token to node inference proxy;
- GitHub Actions deploy token to Cloudflare deployment;
- Worker runtime token to Cloudflare AI Gateway automation.

Reports that cross one credential class into another are high priority.

## In Scope

The following are in scope:

- authentication or authorization bypass in Worker routes;
- credential leakage through logs, responses, headers, dashboard APIs, workflows, or install scripts;
- SSRF or unsafe node destination registration outside allowed Mesh/private ranges;
- Worker-to-node request forwarding that leaks provider/admin/setup/node credentials;
- node-agent proxy bypasses that expose the local runtime without the upstream token;
- installer or updater checksum/signature bypasses;
- GitHub Actions patterns that expose secrets to untrusted code;
- Cloudflare API automation using broader permissions than documented;
- denial-of-service issues that permanently corrupt scheduler or node state.

## Out of Scope

The following are generally out of scope unless they demonstrate impact on this project:

- issues in Cloudflare, GitHub, Go, Node.js, or operating systems without a project-specific exploit path;
- vulnerabilities in the `mesh-llm` inference engine itself, which belong upstream at <https://github.com/Mesh-LLM/mesh-llm> — nodes run a pinned release verified against per-asset SHA-256 checksums, and fixes reach nodes through a re-pin;
- attacks requiring control of the operator's Cloudflare account, GitHub repository, or local machine;
- social engineering, phishing, or physical attacks;
- public availability of a first-run setup route before setup is completed. This is an intentional bootstrap decision documented in `documentation/decisions/README.md`; setup must be completed in a controlled deployment flow and is protected by admin auth after completion.

## Disclosure Process

1. Submit a private report with enough detail to reproduce and assess impact.
2. The maintainer will acknowledge the report and may ask for clarification.
3. Confirmed vulnerabilities will be fixed on a private or minimally disclosed branch when practical.
4. A public advisory or changelog entry may be published after a fix is available.
5. Credit will be given if requested and appropriate.

## Secure Configuration Notes

- Do not commit Cloudflare, GitHub, provider, admin, setup, node, or upstream tokens.
- Use scoped Cloudflare API tokens, not global API keys.
- Keep node machines behind Cloudflare One Client / WARP and advertise only Cloudflare One interface `IP:PORT` values.
- Use the generated setup tokens only for node enrollment.
- Treat generated admin, provider, node, and upstream tokens as sensitive credentials.
- Enable Cloudflare Access for the admin surface after attaching a custom domain if your deployment requires an additional identity layer.

## Security Documentation

Related project documentation:

- [documentation/lanes/security.md](documentation/lanes/security.md)
- [documentation/lanes/configuration.md](documentation/lanes/configuration.md)
- [documentation/decisions/README.md](documentation/decisions/README.md)
- [sdd/spec/security.md](sdd/spec/security.md)
