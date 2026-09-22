#!/usr/bin/env node

import { registerTempCleanup } from "../temp-lifecycle.mjs";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fail,
  flagBool,
  flagString,
  parseFlags,
  runCommand,
} from "./utils.mjs";

const packageName =
  process.env.NPM_PACKAGE?.trim() ||
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).name;

/** Describe the registry acceptance command and supported install modes. */
function usage() {
  console.log(`Usage:
  node scripts/release/verify-installed-agent-session.mjs --version <YYYY.M.D[-N]>
    [--manager npm|bun|both] [--previous-version <YYYY.M.D[-N]>] [--global]
    [--json]

Installs the exact public package into unrelated roots and drives the cold-start
agent loop through the resolved installed executable. The report records every
step and the bounded output cost so install-shaped failures are actionable.
`);
}

/** Resolve symlinks and refuse execution outside the disposable installation. */
function assertContainedExecutable(installRoot, executable) {
  const resolvedRoot = realpathSync(installRoot);
  const resolvedExecutable = realpathSync(executable);
  const relative = path.relative(resolvedRoot, resolvedExecutable);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(
      `Installed executable escaped its package root: ${resolvedExecutable} is not within ${resolvedRoot}.`,
    );
  }
  return resolvedExecutable;
}

/** Fail unless an installed SDK proved an exact full-corpus read. */
function assertCompleteSdkRead(manager, sdkRead) {
  if (
    sdkRead?.item_count !== 1 ||
    sdkRead?.source_complete !== true ||
    sdkRead?.full_projection !== true
  ) {
    fail(
      `Installed-agent acceptance SDK read was not complete for ${manager}.`,
    );
  }
}

/** Execute a cold SDK and CLI lifecycle with per-command output and time bounds. */
function runAgentSession(manager, executable, installRoot, publicRegistryEnv) {
  const workspace = path.join(installRoot, "agent-workspace");
  const pmRoot = path.join(workspace, ".agents", "pm");
  const evidencePath = path.join(workspace, "acceptance-evidence.txt");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(evidencePath, "published artifact acceptance\n", "utf8");
  const env = {
    ...publicRegistryEnv,
    PM_PATH: pmRoot,
    PM_GLOBAL_PATH: path.join(installRoot, "global-pm"),
  };
  const steps = [];
  let outputCharacters = 0;
  const runStep = (label, args, command = executable, cwd = workspace) => {
    const result = runCommand(command === executable ? (manager === "bun" ? "bun" : process.execPath) : command, command === executable ? [executable, ...args] : args, {
      cwd,
      capture: true,
      allowFailure: true,
      env,
      inheritEnvironment: false,
      timeout: 120_000,
    });
    if (result.status !== 0) {
      fail(
        `Installed-agent acceptance failed at ${manager}:${label}: ${result.stderr.trim() || "command exited non-zero"}`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(error) fallback is defensive for non-native replacements */
      const message = error instanceof Error ? error.message : String(error);
      fail(
        `Installed-agent acceptance emitted invalid JSON at ${manager}:${label}: ${message}`,
      );
    }
    const maximumCharacters = label === "init" ? 12_000 : 4_096;
    if (result.stdout.length > maximumCharacters) {
      fail(
        `Installed-agent acceptance exceeded the ${label} output budget for ${manager}: ${result.stdout.length} > ${maximumCharacters} characters.`,
      );
    }
    outputCharacters += result.stdout.length;
    steps.push({
      label,
      ok: true,
      output_characters: result.stdout.length,
      maximum_output_characters: maximumCharacters,
    });
    return parsed;
  };

  runStep("init", [
    "--json",
    "--no-extensions",
    "init",
    "--yes",
    "--prefix",
    "accept",
    "--no-merge-fence",
  ]);
  runStep("orient", [
    "--json",
    "--no-extensions",
    "context",
    "--limit",
    "1",
    "--token-budget",
    "512",
  ]);
  const created = runStep("create", [
    "--json",
    "--no-extensions",
    "create",
    "--title",
    "Installed artifact acceptance",
    "--description",
    "Drive the published package through a complete context-managed agent loop",
    "--type",
    "Task",
    "--status",
    "open",
  ]);
  const itemId = created?.id ?? created?.item?.id;
  if (typeof itemId !== "string" || itemId.length === 0) {
    fail(
      `Installed-agent acceptance create step did not return an item id for ${manager}.`,
    );
  }
  runStep("claim", ["--json", "--no-extensions", "claim", itemId]);
  runStep("annotate", [
    "--json",
    "--no-extensions",
    "comments",
    itemId,
    "Acceptance annotation from the installed package",
  ]);
  runStep("link-evidence", [
    "--json",
    "--no-extensions",
    "files",
    itemId,
    "--add",
    "path=acceptance-evidence.txt,scope=project,note=installed package proof",
  ]);
  runStep("close", [
    "--json",
    "--no-extensions",
    "close",
    itemId,
    "Installed package completed the full agent loop",
    "--resolution",
    "All installed-artifact acceptance steps passed",
    "--expected-result",
    "The exact package can manage a project from cold start to closure",
    "--actual-result",
    "The installed executable initialized, oriented, mutated, linked, closed, and read the workspace",
    "--validate-close",
    "warn",
  ]);
  runStep("validate", [
    "--json",
    "--no-extensions",
    "validate",
    "--check-resolution",
    "--check-history-drift",
  ]);
  const readBack = runStep("read-back", [
    "--json",
    "--no-extensions",
    "get",
    itemId,
    "--full",
  ]);
  if (readBack?.item?.status !== "closed") {
    fail(
      `Installed-agent acceptance read-back did not observe closed state for ${manager}.`,
    );
  }
  runStep("context-read-back", [
    "--json",
    "--no-extensions",
    "context",
    "--limit",
    "1",
    "--token-budget",
    "512",
  ]);
  const sdkProgram = `import { PmClient } from ${JSON.stringify(packageName)}; const result = await new PmClient({ pmRoot: ${JSON.stringify(pmRoot)}, noExtensions: true }).listAllComplete(); console.log(JSON.stringify({ item_count: result.complete_list.item_count, source_complete: result.complete_list.source_complete, full_projection: result.complete_list.full_projection }));`;
  const sdkRead = runStep(
    "sdk-complete-list",
    manager === "bun"
      ? ["--eval", sdkProgram]
      : ["--input-type=module", "--eval", sdkProgram],
    manager === "bun" ? "bun" : process.execPath,
    path.dirname(path.dirname(executable)),
  );
  assertCompleteSdkRead(manager, sdkRead);

  return {
    manager,
    executable,
    item_id: itemId,
    step_count: steps.length,
    steps,
    output_characters: outputCharacters,
    estimated_output_tokens: Math.ceil(outputCharacters / 4),
  };
}

/** Execute one exact-package installation with a bounded subprocess deadline. */
function installPackage(manager, packageSpec, installRoot, publicRegistryEnv, globalInstall) {
  return manager === "npm"
    ? runCommand(
        process.platform === "win32" ? process.execPath : "npm",
        [
          ...(process.platform === "win32" ? [process.env.npm_execpath] : []),
          "install",
          ...(globalInstall ? ["--global"] : []),
          "--prefix",
          installRoot,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          packageSpec,
        ],
        { capture: true, allowFailure: true, env: publicRegistryEnv, inheritEnvironment: false, timeout: 120_000 },
      )
    : runCommand(
        "bun",
        ["add", "--silent", "--ignore-scripts", packageSpec],
        {
          cwd: installRoot,
          capture: true,
          allowFailure: true,
          env: publicRegistryEnv,
          inheritEnvironment: false,
          timeout: 120_000,
        },
      );
}

/** Retry registry propagation, then exercise the installed package in its own workspace. */
function installAndRun(manager, packageSpec, root, publicRegistryEnv, globalInstall) {
  const installRoot = path.join(root, `${manager}-install`);
  mkdirSync(installRoot, { recursive: true });
  if (manager === "bun") {
    writeFileSync(
      path.join(installRoot, "package.json"),
      JSON.stringify({ private: true }),
      "utf8",
    );
  }
  let installResult;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    installResult = installPackage(manager, packageSpec, installRoot, publicRegistryEnv, globalInstall);
    if (installResult.status === 0) {
      break;
    }
    if (attempt < 3) {
      console.error(
        `Waiting for ${manager} registry availability (attempt ${attempt}/3)...`,
      );
      const override = Number(process.env.PM_VERIFY_SLEEP_MS);
      /* c8 ignore next -- production uses the real 10s registry backoff; tests set PM_VERIFY_SLEEP_MS=0 to avoid blocking the worker */
      const delay =
        Number.isFinite(override) && override >= 0 ? override : 10_000;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  if (installResult.status !== 0) {
    fail(
      `${manager} exact-package installation failed: ${installResult.stderr.trim() || "installer exited non-zero"}`,
    );
  }
  const moduleRoot = globalInstall
    ? path.join(installRoot, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules")
    : path.join(installRoot, "node_modules");
  const executable = path.join(
    moduleRoot,
    packageName,
    "dist",
    "cli.js",
  );
  return runAgentSession(
    manager,
    assertContainedExecutable(installRoot, executable),
    installRoot,
    publicRegistryEnv,
  );
}

/** Validate exact versions and platform-specific installer requirements before any writes. */
function acceptanceOptions(flags) {
  const version = flagString(flags, "version", null);
  if (!version || !/^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(version)) {
    fail("Missing or invalid --version <YYYY.M.D[-N]>.");
  }
  const manager = flagString(flags, "manager", "both");
  if (!["npm", "bun", "both"].includes(manager)) {
    fail(`Invalid --manager value "${manager}"; expected npm, bun, or both.`);
  }
  const previousVersion = flagString(flags, "previous-version", null);
  if (previousVersion !== null && (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(previousVersion) || previousVersion === version)) {
    fail("Invalid --previous-version; provide a distinct exact release version.");
  }
  if (process.platform === "win32" && manager !== "bun" && !process.env.npm_execpath) {
    fail("Run this verifier through npm run release:verify-installed-agent on Windows so npm_execpath identifies the installed npm CLI.");
  }
  const globalInstall = flagBool(flags, "global", false);
  if (globalInstall && manager !== "npm") fail("--global requires --manager npm.");
  return { version, manager, previousVersion, globalInstall };
}

/** Install control and candidate into independent roots and report bounded agent sessions. */
function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }
  const { version, manager, previousVersion, globalInstall } = acceptanceOptions(flags);
  const root = mkdtempSync(path.join(tmpdir(), "pm-cli-installed-acceptance-"));
  const releaseCleanup = registerTempCleanup(root);
  try {
    const npmUserConfig = path.join(root, "npmrc-public");
    writeFileSync(npmUserConfig, "", "utf8");
    const publicRegistryEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== "npm_config_allow_scripts",
      )),
      NPM_CONFIG_ALLOW_SCRIPTS: "",
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_userconfig: npmUserConfig,
      BUN_INSTALL_CACHE_DIR: path.join(root, "bun-cache"),
      PM_TELEMETRY_DISABLED: "1",
      PM_TELEMETRY_OTEL_DISABLED: "1",
      PM_SENTRY_DISABLED: "1",
    };
    const managers = manager === "both" ? ["npm", "bun"] : [manager];
    const versions = previousVersion === null ? [version] : [previousVersion, version];
    const sessions = versions.flatMap((selectedVersion) => managers.map((selected) => ({
      version: selectedVersion,
      role: selectedVersion === version ? "candidate" : "control",
      install_mode: globalInstall ? "global" : "local",
      ...installAndRun(
        selected,
        `${packageName}@${selectedVersion}`,
        path.join(root, selectedVersion),
        publicRegistryEnv,
        globalInstall,
      ),
    })));
    const result = { ok: true, version, package: packageName, sessions };
    if (flagBool(flags, "json", false)) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(
        `Installed-agent acceptance passed for ${packageName}@${version}.`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    releaseCleanup();
  }
}

main();
