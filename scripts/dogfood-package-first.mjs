#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");
const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-dogfood-"));
const pmPath = path.join(tempRoot, "project", ".agents", "pm");
const globalPath = path.join(tempRoot, "global");
const markerFile = path.join(tempRoot, "project", "README.md");

const env = {
  ...process.env,
  PM_PATH: pmPath,
  PM_GLOBAL_PATH: globalPath,
  PM_AUTHOR: "dogfood-agent",
  PM_TELEMETRY_SOURCE_CONTEXT: process.env.PM_TELEMETRY_SOURCE_CONTEXT || "dogfood",
};
const semanticDogfoodEnabled = process.env.PM_DOGFOOD_SEMANTIC === "1";

const timings = [];

function cleanupTempRoot() {
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: failed to remove dogfood temp root ${tempRoot}: ${message}`);
  }
}

function runProcess(label, args, options = {}) {
  const startedAt = Date.now();
  const completed = spawnSync(process.execPath, [cliPath, ...(options.json === false ? [] : ["--json"]), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const tookMs = Date.now() - startedAt;
  timings.push({ label, took_ms: tookMs, code: completed.status ?? 1 });
  if (completed.status !== 0) {
    throw new Error(
      [
        `${label} failed with exit ${completed.status ?? "unknown"}`,
        `command: pm ${options.json === false ? "" : "--json "}${args.join(" ")}`,
        completed.stdout.trim() ? `stdout:\n${completed.stdout.trim()}` : "",
        completed.stderr.trim() ? `stderr:\n${completed.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (options.parseJson === false || options.json === false) {
    return completed.stdout;
  }
  try {
    return JSON.parse(completed.stdout);
  } catch (error) {
    // JSON.parse only ever throws a SyntaxError, so `error.message` is always defined here.
    throw new Error(`${label} did not emit valid JSON: ${(error).message}`);
  }
}

function run(label, args, options = {}) {
  return runProcess(label, args, options);
}

function runText(label, args) {
  return runProcess(label, args, { json: false });
}

function idFrom(result, label) {
  const id = result?.item?.id ?? result?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} did not return an item id`);
  }
  return id;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertCalendarMarkdown(label, markdown) {
  assert(markdown.includes("# pm calendar"), `${label} did not render calendar markdown heading`);
  assert(markdown.includes("Dogfood calendar event"), `${label} did not render dogfood calendar event`);
}

function runSemanticDogfoodProbe() {
  if (!semanticDogfoodEnabled) {
    timings.push({ label: "semantic dogfood skipped", took_ms: 0, code: 0 });
    return { attempted: false, skipped_reason: "PM_DOGFOOD_SEMANTIC not set" };
  }
  const semanticEnv = {
    ...env,
    PM_OLLAMA_MODEL: process.env.PM_OLLAMA_MODEL || "qwen3-embedding:0.6b",
  };
  const startedAt = Date.now();
  const reindex = spawnSync(process.execPath, [cliPath, "--json", "reindex", "--mode", "hybrid", "--progress"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: semanticEnv,
    maxBuffer: 20 * 1024 * 1024,
  });
  const tookMs = Date.now() - startedAt;
  timings.push({ label: "semantic hybrid reindex", took_ms: tookMs, code: reindex.status ?? 1 });
  if (reindex.status !== 0) {
    throw new Error(
      [
        `semantic hybrid reindex failed with exit ${reindex.status ?? "unknown"}`,
        reindex.stdout.trim() ? `stdout:\n${reindex.stdout.trim()}` : "",
        reindex.stderr.trim() ? `stderr:\n${reindex.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const reindexPayload = JSON.parse(reindex.stdout);
  assert(reindexPayload?.semantic?.enabled === true, "semantic hybrid reindex did not report semantic.enabled=true");
  assert((reindexPayload?.semantic?.batches_completed ?? 0) >= 1, "semantic hybrid reindex completed no batches");
  assert((reindexPayload?.semantic?.embedded_items ?? 0) >= 1, "semantic hybrid reindex embedded no items");
  assert((reindexPayload?.semantic?.vector_upserted ?? 0) >= 1, "semantic hybrid reindex upserted no vectors");

  const search = spawnSync(process.execPath, [cliPath, "--json", "search", "package workflow", "--mode", "hybrid", "--limit", "5"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: semanticEnv,
    maxBuffer: 20 * 1024 * 1024,
  });
  timings.push({ label: "semantic hybrid search", took_ms: 0, code: search.status ?? 1 });
  if (search.status !== 0) {
    throw new Error(`semantic hybrid search failed: ${search.stderr.trim() || search.stdout.trim()}`);
  }
  const searchPayload = JSON.parse(search.stdout);
  assert(searchPayload?.mode === "hybrid", "semantic hybrid search did not report mode=hybrid");
  assert((searchPayload?.items ?? []).length >= 1, "semantic hybrid search returned no items");

  const searchAdvanced = spawnSync(
    process.execPath,
    [cliPath, "--json", "search-advanced", "--hybrid", "package workflow", "--limit", "5"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: semanticEnv,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  timings.push({ label: "semantic search-advanced hybrid alias", took_ms: 0, code: searchAdvanced.status ?? 1 });
  if (searchAdvanced.status !== 0) {
    throw new Error(`semantic search-advanced --hybrid failed: ${searchAdvanced.stderr.trim() || searchAdvanced.stdout.trim()}`);
  }
  const searchAdvancedPayload = JSON.parse(searchAdvanced.stdout);
  assert(searchAdvancedPayload?.mode === "hybrid", "search-advanced --hybrid alias did not select hybrid mode");
  assert(
    searchAdvancedPayload?.query === "package workflow",
    "search-advanced --hybrid should not leak into query text",
  );
  return { attempted: true, model: semanticEnv.PM_OLLAMA_MODEL };
}

try {
  mkdirSync(path.dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, "# Temporary pm dogfood project\n", "utf8");

  const initResult = run("init", ["init", "--defaults", "--author", "dogfood-agent", "--with-packages"]);
  assert(initResult?.installed_packages?.installed_all === true, "init --with-packages did not report installed_all=true");
  assert(initResult?.installed_packages?.installed_count >= 8, "init --with-packages installed too few bundled packages");
  assert(initResult?.agent_guidance?.mode === "ask", "init did not return default agent guidance mode");
  assert(initResult?.agent_guidance?.present === false, "fresh temp project unexpectedly reported agent guidance present");
  const guidanceStatusBefore = run("init guidance status before add", ["init", "--agent-guidance", "status"]);
  assert(guidanceStatusBefore?.agent_guidance?.present === false, "init --agent-guidance status should report missing guidance before add");
  const guidanceAdd = run("init guidance add", ["init", "--agent-guidance", "add"]);
  assert(guidanceAdd?.agent_guidance?.present === true, "init --agent-guidance add did not report guidance present");
  assert(guidanceAdd?.agent_guidance?.applied === true, "init --agent-guidance add did not apply guidance on first run");
  const guidanceStatusAfter = run("init guidance status after add", ["init", "--agent-guidance", "status"]);
  assert(guidanceStatusAfter?.agent_guidance?.present === true, "init --agent-guidance status should report guidance present after add");
  run("config", ["config", "project", "set", "test-result-tracking", "--policy", "enabled"]);

  const created = run("create task", [
    "create",
    "--title",
    "Dogfood package-first workflow",
    "--description",
    "Exercise the current pm CLI in an isolated temporary project.",
    "--type",
    "Task",
    "--status",
    "open",
    "--priority",
    "1",
    "--tags",
    "dogfood,packages,agent-ux",
    "--acceptance-criteria",
    "Core lifecycle, package, search, calendar, SDK, and linked-test paths pass.",
    "--create-mode",
    "progressive",
    "--comment",
    "Temporary dogfood item created by scripts/dogfood-package-first.mjs.",
  ]);
  const id = idFrom(created, "create task");

  run("claim", ["claim", id]);
  run("update", ["update", id, "--status", "in_progress", "--estimate", "15"]);
  run("files", ["files", id, "--add", "path=README.md,note=dogfood marker"]);
  run("docs", ["docs", id, "--add", "path=README.md,note=dogfood docs marker"]);
  run("comments", ["comments", id, "Dogfood comment shorthand remains accepted."]);
  run("notes", ["notes", id, "--add", "Dogfood note shorthand remains accepted."]);
  run("learnings", ["learnings", id, "--add", "Dogfood learning shorthand remains accepted."]);
  run("calendar event", [
    "create",
    "--title",
    "Dogfood calendar event",
    "--description",
    "Exercise calendar event creation in the temporary dogfood project.",
    "--type",
    "Event",
    "--status",
    "open",
    "--priority",
    "2",
    "--event",
    "date=+1d,duration=30m,timezone=UTC",
    "--create-mode",
    "progressive",
  ]);
  run("context", ["context", "--limit", "5", "--depth", "standard"]);
  run("search keyword", ["search", "Dogfood package-first workflow", "--limit", "5"]);
  const getBrief = run("get brief", ["get", id, "--depth", "brief"]);
  assert(getBrief?.item?.id === id, "get --depth brief did not return the requested item");
  assert(getBrief?.body === undefined, "get --depth brief should omit body text for low-token inspection");
  assert(getBrief?.linked === undefined, "get --depth brief should omit linked containers");
  assert(getBrief?.claim_state === undefined, "get --depth brief should omit claim state history");
  const listOpenBrief = run("list-open default brief", ["list-open", "--limit", "1"]);
  assert(listOpenBrief?.projection?.mode === "compact", "list-open default should use compact brief projection");
  assert(
    listOpenBrief?.projection?.fields?.join(",") === "id,status,type,title",
    "list-open default brief fields drifted",
  );
  const getFields = run("get fields", ["get", id, "--fields", "id,title,status,parent,type"]);
  assert(getFields?.item?.id === id, "get --fields did not return the requested item id");
  assert(getFields?.item?.title === "Dogfood package-first workflow", "get --fields did not return selected title");
  assert(getFields?.item?.description === undefined, "get --fields should omit unselected metadata");
  assert(getFields?.body === undefined, "get --fields should omit body unless requested");
  assert(getFields?.linked === undefined, "get --fields should omit linked containers unless requested");

  const listOpenContracts = run("contracts list-open flags", ["contracts", "--command", "list-open", "--flags-only"]);
  assert(listOpenContracts?.runtime_schema === undefined, "contracts list-open flags should omit runtime_schema");
  assert(listOpenContracts?.extension_contracts === undefined, "contracts list-open flags should omit extension_contracts");
  const listOpenFlags = listOpenContracts?.command_flags?.[0]?.flags?.map((entry) => entry.flag) ?? [];
  for (const flag of ["--compact", "--brief", "--full", "--fields", "--include-body"]) {
    assert(listOpenFlags.includes(flag), `contracts list-open flags missing ${flag}`);
  }
  const searchContracts = run("contracts search flags", ["contracts", "--command", "search", "--flags-only"]);
  const searchFlags = searchContracts?.command_flags?.[0]?.flags?.map((entry) => entry.flag) ?? [];
  for (const flag of ["--mode", "--semantic", "--hybrid", "--include-linked"]) {
    assert(searchFlags.includes(flag), `contracts search flags missing ${flag}`);
  }
  const searchAdvancedContracts = run("contracts search-advanced flags", [
    "contracts",
    "--command",
    "search-advanced",
    "--runtime-only",
    "--flags-only",
  ]);
  const searchAdvancedFlags = searchAdvancedContracts?.command_flags?.[0]?.flags?.map((entry) => entry.flag) ?? [];
  for (const flag of ["--mode", "--semantic", "--hybrid", "--fields", "--limit"]) {
    assert(searchAdvancedFlags.includes(flag), `contracts search-advanced flags missing ${flag}`);
  }
  const searchAdvancedKeyword = run("package command search-advanced keyword", [
    "search-advanced",
    "Dogfood package-first workflow",
    "--fields",
    "id,title,score",
    "--limit",
    "5",
  ]);
  assert(searchAdvancedKeyword?.mode === "keyword", "search-advanced should default to keyword mode");
  assert(searchAdvancedKeyword?.query === "Dogfood package-first workflow", "search-advanced query parsing drifted");
  const allFlagContracts = run("contracts all flags", ["contracts", "--flags-only"]);
  const flagsByCommand = new Map(
    (allFlagContracts?.command_flags ?? []).map((entry) => [
      entry.command,
      new Set((entry.flags ?? []).flatMap((flag) => [flag.flag, ...(flag.aliases ?? [])])),
    ]),
  );
  const requireContractFlag = (command, flag) => {
    assert(flagsByCommand.get(command)?.has(flag), `contracts --flags-only missing ${command} ${flag}`);
  };
  requireContractFlag("package", "--catalog");
  requireContractFlag("package", "--explore");
  requireContractFlag("package", "--doctor");
  requireContractFlag("package", "--install");
  requireContractFlag("package", "--project");
  requireContractFlag("package", "--global");
  requireContractFlag("upgrade", "--packages-only");
  requireContractFlag("upgrade", "--dry-run");
  requireContractFlag("init", "--agent-guidance");
  requireContractFlag("init", "--with-packages");
  requireContractFlag("get", "--fields");
  const packageAliasesFromContracts =
    allFlagContracts?.command_aliases?.find((entry) => entry.canonical === "package")?.aliases ?? [];
  assert(packageAliasesFromContracts.includes("install"), "contracts --flags-only missing install command alias");

  run("calendar after init packages", [
    "calendar",
    "--view",
    "week",
    "--date",
    "today",
    "--format",
    "json",
  ]);
  assertCalendarMarkdown(
    "calendar markdown after init packages",
    runText("calendar markdown after init packages", ["calendar", "--view", "week", "--date", "+1d", "--full-period"]),
  );
  run("reindex after init packages", ["reindex", "--mode", "keyword"]);

  run("package install beads alias", ["install", "beads", "--project"]);
  run("package install templates alias", ["install", "templates", "--project"]);
  run("package install todos alias", ["install", "todos", "--project"]);
  run("package install quoted wildcard", ["install", "*", "--project"]);
  const shellExpandedWildcardTargets = readdirSync(repoRoot)
    .filter((entry) => !entry.startsWith("."))
    .sort((left, right) => left.localeCompare(right));
  run("package install shell-expanded wildcard", ["install", ...shellExpandedWildcardTargets, "--project"]);
  run("package install local package root", ["install", path.join("packages", "pm-todos"), "--project"]);
  run("package install npm local package root", ["install", `npm:${path.join(repoRoot, "packages", "pm-beads")}`, "--project"]);
  const installAll = run("package install all", ["install", "all", "--project"]);
  assert(installAll?.details?.installed_all === true, "install all did not report installed_all=true");
  const packageCatalog = run("package catalog", ["package", "catalog", "--project"]);
  assert(packageCatalog?.details?.total >= 8, "package catalog did not list all bundled first-party packages");
  const packageAliases = new Set((packageCatalog?.details?.packages ?? []).map((entry) => entry.alias));
  for (const alias of [
    "beads",
    "calendar",
    "governance-audit",
    "guide-shell",
    "lifecycle-hooks",
    "linked-test-adapters",
    "search-advanced",
    "templates",
    "todos",
  ]) {
    assert(packageAliases.has(alias), `package catalog missing bundled alias ${alias}`);
  }
  const packageList = run("package list", ["package", "list", "--project"]);
  assert(packageList?.action === "catalog", "package list compatibility path did not resolve to catalog action");
  assert(packageList?.details?.total >= 8, "package list did not list all bundled first-party packages");
  run("package explore", ["package", "explore", "--project"]);
  const packageDoctor = run("package doctor", ["package", "doctor", "--project", "--detail", "deep", "--trace"]);
  const packageDoctorSummary = packageDoctor?.details?.summary ?? {};
  const packageDoctorWarningCodes = new Set(packageDoctor?.details?.triage?.warning_codes ?? []);
  assert(packageDoctorSummary.activation_failure_count === 0, "package doctor reported activation failures");
  assert(packageDoctorSummary.blocking_failure_count === 0, "package doctor reported blocking failures");
  assert(!packageDoctorWarningCodes.has("extension_capability_missing"), "package doctor reported missing manifest capabilities");
  const scaffoldPackagePath = path.join(tempRoot, "scaffold-package");
  const packageScaffold = run("package init scaffold", ["package", "init", scaffoldPackagePath, "--project"]);
  assert(packageScaffold?.details?.extension?.command === "scaffold-package ping", "package init scaffold did not report starter command");
  run("package install scaffold", ["install", scaffoldPackagePath, "--project"]);
  const scaffoldInvoke = run("package scaffold command", ["scaffold-package", "ping"]);
  assert(scaffoldInvoke?.ok === true, "scaffolded package command did not execute");
  assert(scaffoldInvoke?.command === "scaffold-package ping", "scaffolded package command reported unexpected command");
  const guideList = run("package command guide list", ["guide", "--list"]);
  assert(Array.isArray(guideList?.topics) && guideList.topics.length >= 1, "guide --list package command returned no topics");
  const completionBash = runText("package command completion bash", ["completion", "bash"]);
  assert(completionBash.includes("_pm_completion"), "completion bash package command did not render completion script");
  const dedupeAudit = run("package command dedupe-audit", ["dedupe-audit", "--limit", "5"]);
  assert(Array.isArray(dedupeAudit?.clusters), "dedupe-audit package command did not return clusters array");
  const commentsAudit = run("package command comments-audit", ["comments-audit", "--limit", "5"]);
  assert(Array.isArray(commentsAudit?.items), "comments-audit package command did not return items array");
  const normalizeDryRun = run("package command normalize dry-run", ["normalize", "--dry-run"]);
  assert(normalizeDryRun?.dry_run === true, "normalize --dry-run package command did not report dry_run=true");
  const testRunsList = run("package command test-runs list", ["test-runs", "list", "--limit", "5"]);
  assert(Array.isArray(testRunsList?.runs), "test-runs list package command did not return runs array");
  run("calendar after package reinstall", ["calendar", "--view", "week", "--date", "today", "--format", "json"]);
  assertCalendarMarkdown(
    "calendar markdown after package reinstall",
    runText("calendar markdown after package reinstall", ["calendar", "--view", "week", "--date", "+1d", "--full-period"]),
  );
  run("reindex after package reinstall", ["reindex", "--mode", "keyword"]);
  const templatesSave = run("package command templates save", [
    "templates",
    "save",
    "dogfood-defaults",
    "--type",
    "Task",
    "--priority",
    "1",
    "--tags",
    "dogfood,templates",
  ]);
  assert(templatesSave?.name === "dogfood-defaults", "templates save package command did not persist template");
  const templatesShow = run("package command templates show", ["templates", "show", "dogfood-defaults"]);
  assert(templatesShow?.options?.tags === "dogfood,templates", "templates show package command did not return saved defaults");
  const beadsFixture = path.join(tempRoot, "beads-import.jsonl");
  writeFileSync(
    beadsFixture,
    `${JSON.stringify({
      id: "dogfood-beads-imported",
      title: "Dogfood package beads import",
      description: "Imported by the installed first-party Beads package.",
      type: "task",
      status: "open",
      priority: 2,
      tags: ["dogfood", "package-command"],
    })}\n`,
    "utf8",
  );
  const beadsImport = run("package command beads import", [
    "beads",
    "import",
    "--file",
    beadsFixture,
    "--preserve-source-ids",
  ]);
  assert(beadsImport?.imported === 1, "beads import package command did not import one item");
  const todosExportFolder = path.join(tempRoot, "todos-export");
  const todosExport = run("package command todos export", ["todos", "export", "--folder", todosExportFolder]);
  assert(todosExport?.exported >= 1, "todos export package command did not export any items");
  const upgradePackages = run("upgrade packages", ["upgrade", "--packages-only"]);
  assert(upgradePackages?.summary?.requested_packages === true, "upgrade --packages-only did not request packages");
  assert(upgradePackages?.summary?.failed === 0, "upgrade --packages-only reported failed package upgrades");
  const upgradeDryRun = run("upgrade dry-run", ["upgrade", "--dry-run"]);
  assert(upgradeDryRun?.dry_run === true, "upgrade --dry-run did not report dry_run=true");
  assert(upgradeDryRun?.summary?.requested_cli === true, "upgrade --dry-run did not include CLI planning");
  assert(upgradeDryRun?.summary?.requested_packages === true, "upgrade --dry-run did not include package planning");

  const runtimeContracts = run("sdk import", ["contracts", "--availability-only", "--runtime-only"]);
  const availableRuntimeActions = new Set(
    (runtimeContracts?.action_availability ?? [])
      .filter((entry) => entry.available === true && entry.invocable === true)
      .map((entry) => entry.action),
  );
  for (const action of [
    "beads-import",
    "completion",
    "comments-audit",
    "dedupe-audit",
    "guide",
    "search-advanced",
    "templates-save",
    "templates-show",
    "test-runs-list",
    "todos-export",
  ]) {
    assert(availableRuntimeActions.has(action), `runtime contracts missing installed package action ${action}`);
  }
  const sdkSmoke = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import('./dist/sdk/index.js').then((sdk) => { if (!sdk.PM_PROVIDER_TOOL_PARAMETERS_SCHEMA) process.exit(2); })"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    },
  );
  timings.push({ label: "sdk import direct", took_ms: 0, code: sdkSmoke.status ?? 1 });
  if (sdkSmoke.status !== 0) {
    throw new Error(`SDK direct import failed: ${sdkSmoke.stderr.trim() || sdkSmoke.stdout.trim()}`);
  }
  const semanticDogfood = runSemanticDogfoodProbe();

  const planCreate = run("plan create", [
    "plan",
    "create",
    "--title",
    "Dogfood plan workflow",
    "--scope",
    "End-to-end Plan lifecycle dogfood",
    "--harness",
    "claude-code",
    "--parent",
    id,
  ]);
  const planId = planCreate?.plan?.id;
  assert(typeof planId === "string" && planId.length > 0, "plan create did not return a plan id");
  const planAddStep1 = run("plan add-step 1", [
    "plan",
    "add-step",
    planId,
    "--step-title",
    "Investigate dogfood path",
    "--step-body",
    "Walk the dogfood lifecycle",
  ]);
  assert(planAddStep1?.step?.id === "plan-step-001", "plan add-step 1 did not assign plan-step-001");
  const planAddStep2 = run("plan add-step 2", [
    "plan",
    "add-step",
    planId,
    "--step-title",
    "Materialize follow-up Task",
    "--depends-on",
    id,
  ]);
  assert(planAddStep2?.step?.id === "plan-step-002", "plan add-step 2 did not assign plan-step-002");
  const planUpdateStep = run("plan update-step", [
    "plan",
    "update-step",
    planId,
    "plan-step-001",
    "--step-status",
    "in_progress",
    "--step-evidence",
    "starting investigation",
  ]);
  assert(planUpdateStep?.step?.status === "in_progress", "plan update-step did not move plan-step-001 to in_progress");
  const planCompleteStep = run("plan complete-step", [
    "plan",
    "complete-step",
    planId,
    "plan-step-001",
    "--step-evidence",
    "investigation complete",
  ]);
  assert(planCompleteStep?.step?.status === "completed", "plan complete-step did not mark plan-step-001 completed");
  const planDecision = run("plan decision", [
    "plan",
    "decision",
    planId,
    "--decision-text",
    "Promote plan-step-002 into a real Task",
    "--decision-rationale",
    "Dogfood requires materialization",
  ]);
  assert(Array.isArray(planDecision?.plan?.decisions) && planDecision.plan.decisions.length >= 1, "plan decision did not append decision entry");
  const planDiscovery = run("plan discovery", [
    "plan",
    "discovery",
    planId,
    "--discovery-text",
    "Existing dogfood helper covers Plan smoke",
  ]);
  assert(Array.isArray(planDiscovery?.plan?.discoveries) && planDiscovery.plan.discoveries.length >= 1, "plan discovery did not append discovery entry");
  const planValidation = run("plan validation", [
    "plan",
    "validation",
    planId,
    "--validation-text",
    "history --verify must remain ok",
    "--validation-command",
    "pm history <plan-id> --verify",
  ]);
  assert(Array.isArray(planValidation?.plan?.validation) && planValidation.plan.validation.length >= 1, "plan validation did not append validation entry");
  const planResume = run("plan resume", [
    "plan",
    "resume",
    planId,
    "--resume-context",
    "step 2 pending; materialize next",
  ]);
  assert(planResume?.plan?.resume_context?.includes("step 2 pending"), "plan resume did not store resume_context");
  const planApprove = run("plan approve", ["plan", "approve", planId]);
  assert(planApprove?.plan?.mode === "approved", "plan approve did not flip plan_mode to approved");
  const planMaterialize = run("plan materialize", [
    "plan",
    "materialize",
    planId,
    "--steps",
    "plan-step-002",
    "--materialize-type",
    "Task",
    "--materialize-parent",
    id,
  ]);
  assert(Array.isArray(planMaterialize?.materialized) && planMaterialize.materialized.length === 1, "plan materialize did not create one item");
  const planShow = run("plan show deep", ["plan", "show", planId, "--depth", "deep"]);
  assert(planShow?.plan?.steps?.length === 2, "plan show deep did not include steps array");
  const planFields = run("plan show fields", ["plan", "show", planId, "--fields", "id,title,steps_summary"]);
  assert(planFields?.plan?.id === planId, "plan show --fields did not return selected id");
  assert(planFields?.plan?.title === "Dogfood plan workflow", "plan show --fields did not return selected title");
  assert(planFields?.plan?.steps_summary?.total === 2, "plan show --fields did not return selected steps_summary");
  assert(planFields?.plan?.mode === undefined, "plan show --fields returned unselected mode");
  const planHistory = run("plan history verify", ["history", planId, "--verify"]);
  assert(planHistory?.verification?.ok === true, "plan history hash chain failed to verify after lifecycle");
  const planSearch = run("plan search corpus", ["search", "exponential dogfood", "--limit", "5"]);
  assert(Array.isArray(planSearch?.items), "plan search did not return items array");
  run("plan close", ["close", planId, "plan dogfood lifecycle complete", "--validate-close", "warn"]);

  const redactionSentinel = "dogfood-private-sentinel";
  const redactionReplacement = "[dogfood-redacted]";
  run("history-redact sentinel append", [
    "append",
    id,
    "--body",
    `body contains ${redactionSentinel}`,
    "--message",
    `append ${redactionSentinel}`,
  ]);
  const redactionDryRun = run("history-redact dry-run", [
    "history-redact",
    id,
    "--literal",
    redactionSentinel,
    "--replacement",
    redactionReplacement,
    "--dry-run",
  ]);
  assert(redactionDryRun?.changed === true, "history-redact dry-run did not find sentinel");
  assert(redactionDryRun?.history?.audit_entry_added === false, "history-redact dry-run unexpectedly added audit entry");
  const redactionApplied = run("history-redact apply", [
    "history-redact",
    id,
    "--literal",
    redactionSentinel,
    "--replacement",
    redactionReplacement,
  ]);
  assert(redactionApplied?.changed === true, "history-redact apply did not change history");
  assert(redactionApplied?.history?.audit_entry_added === true, "history-redact apply did not add audit marker");
  assert(redactionApplied?.history?.verify_ok === true, "history-redact apply produced invalid history chain");
  const redactionHistory = run("history-redact history verify", ["history", id, "--verify"]);
  assert(redactionHistory?.verification?.ok === true, "history-redact item history failed verification");

  run("linked test add", [
    "test",
    id,
    "--add",
    "command=node scripts/run-tests.mjs test -- tests/unit/parse-utils.spec.ts,timeout_seconds=240",
  ]);
  run("linked test run", ["test", id, "--run", "--fail-on-skipped"]);
  run("validate", ["validate", "--check-resolution", "--check-history-drift"]);
  const healthBrief = run("health brief", ["health", "--check-only", "--no-refresh", "--brief"]);
  assert(healthBrief?.projection?.mode === "brief", "health --brief did not report projection.mode=brief");
  run("health", ["health", "--check-only", "--no-refresh"]);
  run("close", ["close", id, "temporary dogfood workflow passed", "--validate-close", "warn"]);
  run("release", ["release", id]);

  const slowest = [...timings].sort((left, right) => right.took_ms - left.took_ms).slice(0, 8);
  console.log(
    JSON.stringify(
      {
        ok: true,
        temp_root: tempRoot,
        pm_path: pmPath,
        semantic_dogfood: semanticDogfood,
        commands: timings.length,
        slowest,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (process.env.PM_DOGFOOD_KEEP_TEMP !== "1") {
    cleanupTempRoot();
  }
}
