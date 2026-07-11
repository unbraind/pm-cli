# Native ChatGPT and Codex Plugin Implementation Plan

Tracked research: [pm-n28t](../.agents/pm/tasks/pm-n28t.toon). Future implementation:
[pm-95d7](../.agents/pm/features/pm-95d7.toon).

Research date: **2026-07-11**. This page is a research and implementation plan. It does not record a completed
plugin remediation, ChatGPT app deployment, or public plugin submission.

## Executive Conclusion

The current `plugins/pm-codex` package is an actual native Codex plugin, but it is not yet a complete,
self-contained, validation-clean ChatGPT/Codex distribution.

- It has the required `.codex-plugin/plugin.json`, a repo marketplace entry, skills, and bundled MCP
  configuration. An isolated Codex CLI 0.144.1 install accepted it, enabled it, and registered `pm-mcp`.
- It is not self-contained after marketplace installation. The installed cache does not contain `dist/` or
  dependencies, so the launcher falls through to `npx -y --package=@unbrained/pm-cli@latest pm-mcp`.
- It currently fails the built-in `@plugin-creator` validator because every bundled skill points at icon files
  that do not exist relative to that skill.
- Its `commands/` directory is not a documented Codex plugin component and is not referenced from the manifest.
  Those files must be treated as unverified payload, not advertised functionality.
- It is not a ChatGPT app. It has no `.app.json`, developer-mode app mapping, reachable HTTPS or tunnel-backed
  MCP endpoint, Apps SDK tool metadata, or app submission evidence.
- Its MCP descriptors expose input schemas, but not the output schemas or required safety annotations expected
  for a submitted MCP-backed plugin.

The correct strategy is therefore two explicit tracks:

1. Make the local Codex and ChatGPT desktop-hosted plugin self-contained, validation-clean, and truthful.
2. Decide separately whether to build an MCP-backed ChatGPT app. If that track is selected, choose how a web
   client will reach the git-native repository before writing app code.

Do not describe these tracks as one interchangeable artifact. A native plugin package and a ChatGPT app are
related, but they are not the same thing.

## Verdict Matrix

| Question | Verified answer on 2026-07-11 | Consequence |
|---|---|---|
| Is `pm-codex` a native Codex plugin? | Yes. Codex installs the marketplace entry and registers its skills/MCP server. | Keep the plugin lineage; do not replace it with an unrelated format. |
| Is the installed plugin self-contained? | No. Its cached launcher uses `npx ...@latest` when no repo `dist/` is reachable. | Bundle or package a version-matched runtime inside the installed artifact. |
| Does the official validator pass? | No. Six skill icon checks fail. | Fix per-skill assets or remove invalid skill icon declarations. |
| Is it a ChatGPT app? | No. There is no app mapping or ChatGPT-reachable MCP endpoint. | Build and test an app only after choosing a repository-access architecture. |
| Is it ready for public plugin submission? | No. App transport, annotations, schemas, legal metadata, tests, and review materials are incomplete. | Treat submission as a later gated phase. |
| Is the current `mcpServers` wrapper proven invalid? | No. Codex 0.144.1, OpenAI-curated plugins, and the current `@plugin-creator` scaffold accept it. | Do not make a speculative casing-only edit. Add compatibility validation instead. |
| Are files under `commands/` proven Codex plugin commands? | No. Current plugin docs list skills, apps, MCP config, hooks, and assets, not a `commands/` component. | Migrate useful prompts into skills or remove the unsupported claim. |

## Source Currency and Research Method

The sources below were opened live on 2026-07-11. The Codex documentation URLs on
`developers.openai.com` currently redirect to official pages on `learn.chatgpt.com`; both are OpenAI-owned
documentation surfaces. The current pages, not older remembered terminology, are the source of truth for this
plan.

Primary official sources:

- [Plugins](https://developers.openai.com/codex/plugins) — supported clients, install behavior, plugin parts,
  and permission boundaries.
- [Build plugins](https://developers.openai.com/codex/plugins/build) — scaffold, marketplace, manifest,
  distribution, MCP configuration, hooks, and packaging.
- [Build an app](https://learn.chatgpt.com/docs/build-app) — distinction between the plugin package and its
  optional MCP-backed app.
- [Submit plugins](https://learn.chatgpt.com/docs/submit-plugins) — portal fields, review, tool annotations,
  tests, identity, verification, and publishing.
- [Apps SDK overview](https://developers.openai.com/apps-sdk) and
  [MCP server guide](https://developers.openai.com/apps-sdk/build/mcp-server) — ChatGPT app runtime model.
- [Define tools](https://developers.openai.com/apps-sdk/plan/tools) and
  [Apps SDK reference](https://developers.openai.com/apps-sdk/reference) — focused tools, schemas,
  `structuredContent`, and annotations.
- [Deploy your app](https://developers.openai.com/apps-sdk/deploy) and
  [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt) — stable HTTPS `/mcp`,
  developer mode, refresh, and client testing.
- [Authentication](https://developers.openai.com/apps-sdk/build/auth) and
  [Security and privacy](https://developers.openai.com/apps-sdk/guides/security-privacy) — OAuth 2.1,
  authorization, scopes, consent, prompt injection, logging, and data handling.
- [Test your integration](https://developers.openai.com/apps-sdk/deploy/testing) — handler tests, MCP
  Inspector, developer mode, API Playground, golden prompts, and regression checks.
- [MCP Apps compatibility](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt) — portable iframe UI
  bridge and ChatGPT extensions.
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) — outbound-only access
  from ChatGPT/Codex to a private or local MCP server.
- [Apps SDK changelog](https://developers.openai.com/apps-sdk/changelog) and
  [Codex changelog](https://developers.openai.com/codex/changelog) — recent behavior and plugin rollout
  changes.

Live implementation evidence was also collected from:

- Codex CLI 0.144.1 contracts and an isolated temporary `CODEX_HOME`.
- The current OpenAI-curated plugin cache installed with Codex.
- The built-in `@plugin-creator` scaffold and validator.
- The repository manifest, marketplace, launcher, tool definitions, smokes, and docs.

The official build page currently describes a companion `.mcp.json` as a direct server map or a wrapped
`mcp_servers` object. In contrast, the current OpenAI-curated plugins, `@plugin-creator` scaffold, validator,
and Codex 0.144.1 use or accept a wrapped `mcpServers` object. This is a documentation/runtime discrepancy.
The working runtime contract wins for this checkout, and a future change must be driven by executable
validation across supported Codex versions rather than by casing speculation.

## The Current OpenAI Product Model

### Plugin

A plugin is the package a user discovers, installs, shares, submits, and publishes. It may contain:

- one or more skills;
- an MCP-backed app;
- bundled MCP server configuration for a Codex host;
- lifecycle hooks;
- visual assets; or
- a combination of those parts.

Every plugin has a `.codex-plugin/plugin.json` entry point. Skills, `.app.json`, `.mcp.json`, hooks, and assets
belong at the plugin root, not inside `.codex-plugin/`.

### App

An app is an MCP-backed capability inside a plugin. Its server defines tools, authentication, data handling,
and real behavior. A custom UI is optional. When UI is useful, the app registers MCP UI resources and uses the
MCP Apps bridge; ChatGPT-specific `window.openai` APIs are extensions, not the default portable foundation.

An app is needed when a plugin must expose live tools to ChatGPT, connect to a service, authenticate a user, or
perform actions through MCP. A skill-only plugin remains valid, but it does not turn a local CLI into a remotely
reachable ChatGPT tool service.

### Marketplace

A marketplace is an ordered catalog, not the plugin itself. The current documented locations are:

- repo: `$REPO_ROOT/.agents/plugins/marketplace.json`;
- personal: `~/.agents/plugins/marketplace.json`; and
- legacy repo compatibility: `$REPO_ROOT/.claude-plugin/marketplace.json`.

Marketplace sources may be local, Git-backed, or npm-backed. Codex copies an installed plugin into
`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` and loads the cached copy. A relative path that only
works because the source repository has files above the plugin directory is therefore not a portable runtime
dependency.

### Supported surfaces are not identical execution environments

Plugins can be browsed from ChatGPT Work, the ChatGPT desktop app, Codex CLI, and the Codex IDE extension.
That shared directory does not make a local stdio process reachable from a web conversation. ChatGPT app tools
need a reachable HTTPS `/mcp` endpoint or a supported tunnel to a private MCP server. Local Codex MCP servers
continue to execute under the Codex host sandbox and approval policy.

## Current Repository Audit

### Shipped layout

```text
plugins/pm-codex/
├── .codex-plugin/plugin.json
├── .mcp.json
├── README.md
├── assets/pm-cli-small.svg
├── commands/
│   ├── pm-audit.md
│   ├── pm-close-task.md
│   └── pm-start-task.md
├── scripts/pm-mcp-server.mjs
└── skills/
    ├── pm-auditor/
    ├── pm-native/
    └── pm-release/
```

The manifest declares `skills` and `mcpServers`. It does not declare `apps` or `hooks`. That is a valid
plugin class: a plugin does not need an app or hook merely to be a plugin.

### Isolated install proof

The repository install instructions were replayed with a new temporary Codex home:

```bash
CODEX_HOME=<temporary-directory> codex plugin marketplace add .
CODEX_HOME=<temporary-directory> codex plugin add pm-codex@pm-local --json
CODEX_HOME=<temporary-directory> codex plugin list
CODEX_HOME=<temporary-directory> codex mcp list
```

Observed results:

- marketplace `pm-local` resolved from the repository;
- `pm-codex@pm-local` version `2026.7.11` installed and became enabled;
- Codex copied the plugin to its versioned cache;
- `pm-mcp` appeared as an enabled stdio MCP server; and
- the current camel-case `.mcp.json` wrapper was accepted.

This disproves the broad claim that the repository has no real native Codex plugin.

### Installed runtime defect

The cached archive contains the plugin files listed above, but no repository `dist/`, dependency tree, or
plugin-local package runtime. The generated launcher tries, in order:

1. `PM_CLI_MCP_SERVER`;
2. a readable `dist/mcp/server.js` found by walking ancestors of the launcher; then
3. `npx -y --package=@unbrained/pm-cli@latest pm-mcp`.

The versioned cache is outside the source checkout, so normal external installs cannot find the repository
`dist/mcp/server.js`. They therefore use the third branch. This has four consequences:

- startup requires network and npm availability;
- the running server version can differ from the installed plugin version;
- `@latest` makes behavior change independently of installed skills and documentation; and
- the current “native” description implies a more self-contained artifact than users receive.

The current Codex smoke starts the repository `dist/mcp/server.js` directly. It proves the MCP implementation,
but it does not exercise the installed cache, launcher fallback, offline startup, or plugin/runtime version
coherence.

### Validator defect

The official built-in validation path was run as follows:

```bash
uv run --with pyyaml python \
  /path/to/plugin-creator/scripts/validate_plugin.py \
  plugins/pm-codex
```

It fails six checks. Each of `pm-auditor`, `pm-native`, and `pm-release` declares both `icon_small` and
`icon_large` as `./assets/pm-cli-small.svg` in its own `agents/openai.yaml`, but none of those skill directories
contains `assets/pm-cli-small.svg`. The one existing asset is at the plugin root. Skill metadata paths are
resolved relative to the skill, so install tolerance does not make those references valid.

### Unsupported or unproven command payload

The official plugin structure documents skills, hooks, app mappings, MCP configuration, and assets. It does not
document a Codex plugin `commands/` loader or a manifest `commands` field. The current manifest does not point at
the directory, and the built-in validator ignores it.

The three command Markdown files may be useful prompt content, but the repository has no current-head proof
that Codex exposes them as slash commands. They should be migrated into supported skills when they add unique
value, or removed. Until then, docs must not count them as a working native capability.

### MCP descriptor gap for a ChatGPT app

`src/mcp/tool-definitions.ts` currently defines each tool with:

- `name`;
- `description`; and
- `inputSchema`.

The `tools/list` response returns those definitions directly. It does not provide `outputSchema` or Apps SDK
annotations such as `readOnlyHint`, `openWorldHint`, and `destructiveHint`.

That is sufficient for the current local MCP smoke, but not for a review-ready ChatGPT app. OpenAI requires the
three safety hints for every submitted MCP tool, recommends output schemas for structured results, and expects
tool names, descriptions, schemas, output structure, and actual behavior to agree.

The broad `pm_run` tool and combined list/add/remove/run tools also conflict with the Apps SDK recommendation of
one focused job per tool and separate read/write actions. A public app surface must not simply expose the entire
local escape hatch.

### Public listing and legal gap

The manifest currently uses `SECURITY.md` as its privacy policy and `LICENSE` as its terms of service. Those are
useful project documents, but they are not a privacy policy or service terms describing an MCP app, user data,
retention, authentication, support, or hosted processing. Public submission also requires matching publisher
identity, support information, production branding, a public MCP URL, domain verification, and policy
attestations.

### Identity and authorization gap

The local `.mcp.json` sets `PM_AUTHOR=codex-agent`. That gives local history a stable fallback author, but it is
not end-user identity or authorization. A hosted multi-user app must derive the actor from authenticated server
context, authorize the selected repository and operation on every request, and prevent callers from spoofing
another history author through tool arguments.

## Target Architecture

```text
Local Codex or desktop-hosted workflow

repo/Git/npm marketplace
        │
        ▼
versioned cached plugin
        │
        ├── bundled skills
        └── bundled stdio pm MCP runtime
                    │
                    ▼
             selected local repo
                    │
                    ▼
               .agents/pm

ChatGPT web or public plugin workflow

published/shared plugin
        │
        ▼
app/connector mapping
        │
        ▼
HTTPS /mcp or Secure MCP Tunnel
        │
        ▼
authorized backend or customer-controlled host
        │
        ▼
explicitly selected repository and .agents/pm
```

These flows may share action handlers, schemas, and tests. They should not share assumptions about filesystem
access, process lifetime, authentication, or network reachability.

## Track A: Correct Local Codex Plugin

### Target package layout

```text
plugins/pm-codex/
├── .codex-plugin/plugin.json
├── .mcp.json
├── README.md
├── assets/
│   ├── composer-icon.svg
│   ├── logo.png
│   └── logo-dark.png
├── runtime/
│   └── pm-mcp-server.mjs
└── skills/
    ├── pm-auditor/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   └── assets/...
    ├── pm-native/...
    └── pm-release/...
```

The exact runtime filename is not important. The invariant is: every file needed after installation exists
inside the copied plugin archive, uses an archive-relative path, and is versioned with the plugin.

### Runtime packaging requirements

Preferred implementation:

1. Produce a single bundled Node entry point for the stdio MCP server during the normal build/release pipeline.
2. Put that bundle and every required runtime dependency inside `plugins/pm-codex` before packaging.
3. Point `.mcp.json` directly at the bundled entry point.
4. Remove the `@latest` startup fallback from the installed path. An explicit development override may remain,
   but production startup must not silently change versions.
5. Stamp plugin, marketplace, and runtime metadata from the same package-owned version source.
6. Make the release gate install the copied plugin in an isolated Codex home with no ancestor repo `dist/`.
7. Prove the server starts with npm network access unavailable and with `npx` absent from `PATH`.

An alternative is a dedicated npm plugin package. The marketplace supports `source: "npm"`, but Codex downloads
that package without running lifecycle scripts. The published tarball must therefore already contain the plugin
manifest and runnable bundled server; a post-install build is not a valid design.

Pinning the fallback to the plugin version is an acceptable short-term risk reduction, but it is not the target:
it remains network-dependent and does not provide an offline, self-contained plugin.

### Manifest and MCP rules

- Keep the stable kebab-case plugin name.
- Keep paths relative to the plugin root and `./`-prefixed.
- Include only component fields whose target files exist.
- Keep real publisher, repository, homepage, license, and install-surface metadata.
- Use production-ready logo assets for distribution; keep per-skill icons inside each skill archive when declared.
- Keep `mcpServers: "./.mcp.json"` while the supported runtime and canonical scaffold require it.
- Do not add `apps` until a real `.app.json` has been generated for a real developer-mode app or connector.
- Do not add hooks merely to appear more native. Hooks are optional and require separate trust review.
- Treat `commands/` as unsupported until an official contract and executable test prove otherwise.

The current canonical scaffold emits:

```json
{
  "mcpServers": "./.mcp.json"
}
```

with a companion:

```json
{
  "mcpServers": {
    "pm-mcp": {
      "command": "node",
      "args": ["./runtime/pm-mcp-server.mjs"],
      "env": {
        "PM_AUTHOR": "codex-agent"
      }
    }
  }
}
```

Before changing this shape, generate a fresh temporary scaffold with the then-installed `@plugin-creator`, run
its validator, install the result with the minimum supported Codex version and current Codex version, and record
the compatibility result.

### Marketplace rules

The existing repo marketplace location and source path are correct. Preserve:

```json
{
  "name": "pm-local",
  "interface": {
    "displayName": "pm CLI Local"
  },
  "plugins": [
    {
      "name": "pm-codex",
      "source": {
        "source": "local",
        "path": "./plugins/pm-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

For external distribution, choose one explicit source:

- `git-subdir` with a pinned tag or commit for the plugin subdirectory; or
- `npm` with a dedicated, already-built plugin package.

Do not use a moving branch plus a frozen plugin version, and do not rely on files outside the source archive.
Use `codex plugin marketplace add`, `list`, and `upgrade`; do not tell users to hand-edit `config.toml`.

### Skill and prompt migration

For each current command Markdown file:

1. Compare it with the existing `pm-native`, `pm-auditor`, and `pm-release` skills.
2. Delete it when it duplicates a skill.
3. Otherwise create a properly named skill directory with a complete `SKILL.md`, trigger conditions, and any
   referenced assets/scripts.
4. Keep instructions scoped. Do not claim unavailable tools or bypass repository `AGENTS.md` rules.
5. Validate every skill and start a new Codex session before testing discovery.

## Track B: Decide the ChatGPT Repository-Access Model

The current pm value proposition is local, git-native project management. A ChatGPT web app cannot infer or
mount a user laptop repository. Before building an Apps SDK server, accept one of these architectures in an ADR.

### Option 1: Secure MCP Tunnel to a customer-controlled host

Best fit for private development, teams, and enterprise workspaces that want ChatGPT to act on an existing local
or private repository without publishing the pm server.

- Run the pm MCP server on the host that can access the repository.
- Run OpenAI `tunnel-client` in the same trust boundary.
- Use an outbound-only OpenAI-hosted tunnel endpoint.
- Associate the correct Platform organization and ChatGPT workspace.
- Create a developer-mode app with the Tunnel connection option.
- Keep the customer-controlled host online while tools are in use.

This preserves local filesystem semantics and avoids a new pm storage service. It adds host operations,
workspace/tunnel permissions, availability, and identity-mapping requirements. It is a strong first ChatGPT
proof, but it is not by itself a universal public plugin architecture.

### Option 2: Hosted multi-tenant MCP service

Required if the intended outcome is a universal public plugin whose tools work without a customer-run host.

The service needs an explicit repository substrate, for example a GitHub App plus isolated server-side
workspaces. That is a new product surface, not a packaging tweak. It must define:

- repository selection and authorization;
- checkout, branch, commit, push, and conflict behavior;
- tenant isolation and path containment;
- concurrent mutation and locking semantics;
- storage lifetime and deletion;
- secret management and OAuth scopes;
- audit identity and mapping to `PM_AUTHOR`;
- job limits, process execution, sandboxing, and egress;
- reconciliation when remote Git changes during a session; and
- observability, incident response, support, privacy, and data residency.

Do not host arbitrary `pm test --run` or package installation in the first public version. Those operations can
spawn processes or load third-party code and require a substantially stronger sandbox.

### Option 3: Skills-only public plugin

This can publish pm planning and workflow guidance without a hosted tool backend. It is the smallest public
artifact, but users would not receive live pm tools in ChatGPT web. The listing must state that limitation
plainly.

### Recommendation

1. Finish Track A.
2. Prove a private ChatGPT developer-mode app through Secure MCP Tunnel.
3. Use that proof to decide whether a hosted public service creates enough value to justify its security and
   operations scope.
4. Submit publicly only after the chosen architecture is production-ready.

## Track C: Build the MCP-Backed ChatGPT App

This track starts only after the ADR above is accepted.

### Transport and deployment

- Expose MCP on a stable HTTPS `/mcp` endpoint, or through an approved Secure MCP Tunnel.
- Support low-latency streaming responses, dependable TLS, timeouts, structured logs, metrics, and request IDs.
- Separate the reusable pm action layer from stdio and HTTP transport adapters.
- Keep the HTTP adapter stateless where possible; bind repository/user context explicitly per request.
- Return MCP protocol errors without leaking stack traces, filesystem paths, tokens, or private data.
- Provide a health/readiness probe outside the MCP tool surface.

### Developer-mode app wiring

For local app development:

1. Enable Developer mode in ChatGPT under Settings → Security and login.
2. Create a developer-mode app under Settings → Plugins using the reachable `/mcp` endpoint or Tunnel.
3. Copy the generated ID beginning with `plugin_asdk_app`.
4. Use the built-in `@plugin-creator` to add `.app.json` and the `apps: "./.app.json"` manifest field.
5. Install the local marketplace plugin, start a new task, and test both skills and tools.

Do not invent an app ID or commit a personal placeholder. For public submission, the portal takes the production
MCP server URL and scans it directly; it does not accept an existing published ChatGPT app ID as a substitute.

### App tool contract

Do not expose `pm_run` as the primary public app tool. Start with a small, focused surface.

| Tool class | Examples | Required annotation posture |
|---|---|---|
| Read-only | context, next, search, list, get, contracts, check-only health/validate | `readOnlyHint: true`, `openWorldHint: false`, `destructiveHint: false` |
| Reversible private writes | create item, update metadata, add comment, claim, release | `readOnlyHint: false`, normally `openWorldHint: false`, `destructiveHint: false` |
| Consequential lifecycle writes | close, cancel, dependency changes, bulk changes | write annotations plus explicit confirmation; set `destructiveHint` from the actual reversibility contract |
| Dangerous or code-executing operations | delete, history redaction, linked-test execution, package install, arbitrary config/schema mutation | exclude from v1 or isolate behind dedicated tools, strict auth, approval, and sandboxing |

For every exposed tool:

- one user-visible job per tool;
- precise name and description;
- closed, typed `inputSchema` where possible;
- exact `outputSchema` for `structuredContent`;
- stable machine identifiers in outputs;
- `readOnlyHint`, `openWorldHint`, and `destructiveHint` that match every possible invocation;
- `idempotentHint` where true;
- server-side authorization regardless of hints;
- compact model-visible content with sensitive/private data kept out; and
- deterministic errors for missing repositories, stale item versions, ownership conflicts, and invalid state.

Split mixed tools. For example, one tool that lists, adds, removes, and runs tests cannot honestly have one set of
safety annotations. Use separate read and mutation tools or keep that operation out of the app.

### UI decision

Start tool-only unless a UI materially improves review, comparison, editing, confirmation, or navigation. If a UI
is justified:

- use the MCP Apps standard `_meta.ui.resourceUri` and `ui/*` JSON-RPC bridge by default;
- serve the component through an MCP resource;
- return data as `structuredContent` independently of rendering;
- use `window.openai` only for ChatGPT-specific extensions;
- declare a minimal CSP and dedicated component origin; and
- test inline, fullscreen/modal where used, mobile, dark mode, keyboard, and accessibility behavior.

## Authentication, Authorization, and Data Protection

Anything that exposes customer-specific repository data or write actions should authenticate the user. The
official Apps SDK flow expects OAuth 2.1 conforming to the MCP authorization specification.

Required controls for a hosted app:

- publish protected-resource and authorization-server discovery metadata;
- support authorization-code flow with PKCE `S256`;
- use Client ID Metadata Documents where supported, with DCR only when needed;
- include the MCP resource/audience in issued tokens;
- validate signature, issuer, audience/resource, time bounds, scopes, and app policy on every request;
- return standards-compliant `401` and `WWW-Authenticate` challenges;
- request least-privilege scopes and separate read from write scopes;
- bind repository access to authenticated identity and tenant;
- reject user-supplied author spoofing;
- redact tokens, secrets, PII, raw prompts, internal IDs, and debug payloads from responses and logs; and
- document retention, deletion, support, subprocess, Git, and third-party data behavior.

Treat prompt injection as expected input. Validate all paths and arguments server-side, contain repository roots,
enforce state transitions in pm, and require confirmation for consequential actions. Tool annotations influence
ChatGPT confirmation UX; they do not replace server authorization.

For a tunnel-backed internal app, document the separate Platform tunnel permissions, ChatGPT developer-mode
permissions, workspace association, host availability, and customer responsibility for the repository host.

## Listing, Legal, and Submission Requirements

Before public submission, prepare:

- verified developer or business identity in the submitting Platform organization;
- Apps Management write access for the submitter;
- customer-facing plugin name and descriptions;
- production logo, category, website, and support URL;
- an actual privacy policy and terms of service for the shipped service;
- public production MCP URL and exact authentication details;
- domain verification at `/.well-known/openai-apps-challenge` when requested;
- exact content security policy for any UI/network domains;
- reviewer credentials that do not require MFA, email, SMS, or private-network access;
- starter prompts;
- exactly five positive and three negative review test cases;
- country/region availability; and
- release notes and accurate policy attestations.

The portal scans the production MCP server and tool metadata. Fix every scan result and rescan before submission.
Approval does not publish automatically; after review, the publisher chooses when to publish. Published
skills-only, app-only, and app-plus-skills packages appear in the same universal plugin directory.

## Verification Matrix

### Track A: local plugin gates

| Gate | Evidence required |
|---|---|
| Manifest/skills | Current built-in `@plugin-creator` validator passes with no missing asset or placeholder errors. |
| Marketplace | Repo, Git, and/or npm source resolves to the intended plugin root with version and policy metadata. |
| Cache install | Fresh isolated `CODEX_HOME`; marketplace add; plugin add; installed/enabled status. |
| Runtime | `codex mcp list` shows the plugin-scoped server; initialize and `tools/list` pass from the cached copy. |
| Offline | Cached server starts with no repo ancestor, no npm network, and no `npx` fallback. |
| Version | Manifest, marketplace, bundled runtime, server info, and package release identify the same version. |
| Skills | Fresh session discovers each skill; explicit and implicit triggers behave as documented. |
| Unsupported payload | No advertised command or agent asset lacks an ingestion contract and runtime proof. |
| Platforms | Linux, macOS, and Windows path/process behavior is covered proportionally to supported Codex clients. |
| Regression | Existing pm MCP calls mutate only a sandbox tracker during automated tests. |

### Track C: ChatGPT app gates

| Gate | Evidence required |
|---|---|
| Handler unit tests | Representative inputs, schema failures, empty results, conflicts, auth failures, and edge cases. |
| MCP Inspector | List and call every tool; inspect raw requests, responses, components, and errors. |
| HTTPS/tunnel | Reachable `/mcp`, TLS, streaming, timeouts, health, logs, metrics, and reconnect behavior. |
| Developer mode | New ChatGPT task selects correct tools for direct, indirect, and negative golden prompts. |
| API Playground | Raw MCP exchanges and auth challenges match declared schemas. |
| Permissions | Read/write/destructive confirmations match annotations and workspace policy. |
| Security | Cross-tenant, path traversal, prompt injection, token, scope, replay, secret, and PII tests. |
| Output | Every structured result matches `outputSchema`; no private-only payload leaks to model-visible content. |
| UI, if any | MCP Apps bridge, CSP, origin, accessibility, themes, resizing, state restore, and mobile layouts. |
| Submission | Portal scan clean; five positive and three negative cases reproducible with reviewer credentials. |

### Repository checks for each implementation item

At minimum, link and run the checks appropriate to the changed files:

```bash
pnpm build
node scripts/run-tests.mjs test -- <focused-tests>
pnpm quality:docs-skills
pnpm quality:static
pm validate --check-resolution --check-history-drift
pm health --check-only
```

Broader runtime, packaging, security, coverage, and release gates are required before distribution or submission.

## File-by-File Implementation Sequence

No files in this section were changed by the research task.

### Phase 0 — architecture decision

- Add a `Decision` child under [pm-95d7](../.agents/pm/features/pm-95d7.toon).
- Select local-only, tunnel-backed private app, hosted public app, or an ordered combination.
- Define repository identity, storage, authorization, subprocess, Git, and data-retention boundaries.
- Record explicit non-goals and public-surface claims.

### Phase 1 — self-contained Codex runtime

Likely files:

- `scripts/gen-plugin-mcp-wrappers.mjs` or a replacement bundle generator;
- build/release scripts that create the plugin runtime;
- `plugins/pm-codex/.mcp.json`;
- `plugins/pm-codex/scripts/pm-mcp-server.mjs`;
- a new plugin-local runtime artifact;
- cache-layout smoke tests; and
- package/version synchronization tests.

Coordinate shared launcher work with the existing Claude plugin distribution issue rather than duplicating
fallback logic.

### Phase 2 — plugin contract cleanup

Likely files:

- each `plugins/pm-codex/skills/*/agents/openai.yaml` and its assets;
- `plugins/pm-codex/commands/*` migrated or removed;
- `.codex-plugin/plugin.json` metadata and production assets;
- `plugins/pm-codex/README.md` and `docs/CODEX_PLUGIN.md`; and
- a dedicated Codex plugin contract test using the built-in validator.

### Phase 3 — app-safe tool contract

Likely files:

- `src/mcp/tool-definitions.ts` or a separate app descriptor projection;
- shared tool result schemas;
- a transport-neutral handler layer;
- focused app-only tools that exclude `pm_run` and unsafe mixed operations; and
- descriptor/output/annotation contract snapshots.

Preserve local MCP compatibility. Do not force the public app surface to expose every local operator command.

### Phase 4 — ChatGPT app transport

Only after Phase 0 approval:

- add an HTTP/tunnel adapter around the shared handler layer;
- add authenticated repository context resolution;
- add OAuth/resource metadata when required;
- add developer-mode app wiring through `@plugin-creator`;
- add optional MCP UI resources only when justified; and
- add deploy, observability, security, and incident runbooks appropriate to the chosen architecture.

### Phase 5 — distribution and submission

- choose pinned Git or prebuilt npm plugin distribution;
- verify cache installation on supported clients;
- finalize listing, support, privacy, terms, branding, prompts, and regions;
- prepare reviewer accounts and eight required cases;
- scan, remediate, and submit through the Platform portal; and
- publish only after approval and a final production-head verification.

## pm Execution Model

The research task created only the parent feature and this documentation child. Create future children only when
implementation is approved; search all statuses before each creation.

Recommended future child types:

1. `Decision` — choose local, tunnel, hosted, and public-distribution scope.
2. `Issue` — make cached Codex installs self-contained and version-coherent.
3. `Chore` — repair skill assets and migrate unsupported command payload.
4. `Feature` — add app-safe schemas, annotations, and focused tools.
5. `Feature` — add the approved ChatGPT MCP transport and authentication model.
6. `Task` — developer-mode, security, cross-client, and submission verification.

For every child:

```bash
pm context --limit 10
pm search "<exact scope>" --status all --limit 20
pm create --create-mode progressive --parent pm-95d7 ...
pm claim <id>
pm update <id> --status in_progress --message "Start approved implementation"
pm files <id> --add path=<path>,scope=project,note="<why>"
pm docs <id> --add path=<path>,scope=project,note="<why>"
pm test <id> --add command="<sandbox-safe command>",scope=project,timeout_seconds=<n>
pm comments <id> "Evidence: <exact current-head proof>"
pm close <id> "<acceptance and verification summary>" --validate-close warn
pm release <id>
```

Only claim the children actively being edited. Keep the parent open until every accepted track is complete or an
ADR explicitly removes it from scope.

## Definition of Done

Do not call the work “fully native ChatGPT/Codex” until all selected claims have matching proof:

- **Native Codex plugin:** official validator passes; cached plugin starts its own version-matched server without
  `@latest`; skills and tools load in a fresh session; cross-platform cache tests pass.
- **ChatGPT-compatible app:** ChatGPT reaches the selected repository through approved HTTPS/tunnel transport;
  auth, schemas, annotations, outputs, permissions, security, and golden prompts pass.
- **Public plugin:** identity, legal/listing metadata, domain, reviewer tests, portal scan, review, and publication
  are complete on the production artifact.
- **Documentation:** every supported surface, prerequisite, limitation, install/update path, data boundary, and
  version is described without conflating plugin, app, MCP server, skill, or marketplace.

Until then, the accurate short description is:

> pm-cli ships a working repo-marketplace Codex plugin whose installed runtime and optional ChatGPT app/public
> distribution tracks still require the remediation planned in pm-95d7.
