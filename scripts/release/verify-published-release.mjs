#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  commandFor,
  fail,
  flagBool,
  flagString,
  parseFlags,
  runCommand,
} from "./utils.mjs";

const NPM_PACKAGE =
  process.env.NPM_PACKAGE?.trim() ||
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).name;
const PACKAGE_BINS = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).bin;
const MCP_SKILLS_DRAFT_REVISION =
  "SEP-2640@a3e147ca2710f68214247aecc729731ee1ae8d03";
const MCP_SKILL_RESOURCE_URI = "skill://pm-sdk/SKILL.md";
const MCP_EXTENSION_CLIENT_CAPABILITIES = {
  extensions: {
    "io.modelcontextprotocol/skills": {
      revision: MCP_SKILLS_DRAFT_REVISION,
      directoryRead: true,
    },
    "io.modelcontextprotocol/ui": {
      specVersion: "2026-01-26",
      mimeTypes: ["text/html;profile=mcp-app"],
    },
  },
};
const MCP_DISCOVER_REQUEST = `${[
  [1, "server/discover", {}],
  [2, "skills/list", {}],
  [3, "tools/list", {}],
  [4, "resources/read", { uri: "ui://pm/context.html" }],
  [5, "resources/read", { uri: MCP_SKILL_RESOURCE_URI }],
]
  .map(([id, method, params]) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities":
            MCP_EXTENSION_CLIENT_CAPABILITIES,
          "io.modelcontextprotocol/clientInfo": {
            name: "published-artifact-verifier",
            version: "1.0.0",
          },
        },
      },
    }),
  )
  .join("\n")}\n`;
const MCP_DISCOVER_TIMEOUT_MS = 60_000;
const MCP_HTTP_READY_TIMEOUT_MS = 15_000;
const MCP_HTTP_EXECUTOR_TIMEOUT_MS = 20_000;
const MCP_HTTP_EXECUTOR_MAX_ATTEMPTS = 2;
const MCP_HTTP_SHUTDOWN_GRACE_MS = 2_000;
const MCP_HTTP_EXECUTOR_SCRIPT = String.raw`
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const runner = process.env.PM_VERIFY_HTTP_RUNNER;
const runnerCommand = process.env.PM_VERIFY_HTTP_RUNNER_COMMAND;
const packageSpec = process.env.PM_VERIFY_HTTP_PACKAGE_SPEC;
if (!runner || !runnerCommand || !packageSpec) {
  throw new Error("Missing published HTTP verifier environment");
}

const requestedPort = Number(process.env.PM_VERIFY_HTTP_PORT);
const port = Number.isInteger(requestedPort) && requestedPort > 0
  ? requestedPort
  : await new Promise((resolve, reject) => {
  const reservation = createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    if (!address || typeof address === "string") {
      reservation.close();
      reject(new Error("Could not reserve a loopback port"));
      return;
    }
    reservation.close((error) => error ? reject(error) : resolve(address.port));
  });
  });

const overrideArgs = process.env.PM_VERIFY_HTTP_RUNNER_ARGS_JSON;
const args = overrideArgs
  ? JSON.parse(overrideArgs)
  : runner === "npx"
    ? ["--yes", "--package", packageSpec, "--", "pm-mcp-http"]
    : ["--silent", "--bun", "--package", packageSpec, "pm-mcp-http"];
const windowsRunnerScript = [
  "$ErrorActionPreference = 'Stop'",
  "$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PM_VERIFY_HTTP_CHILD_COMMAND_B64))",
  "$childArgs = [string[]]@(ConvertFrom-Json -InputObject $env:PM_VERIFY_HTTP_CHILD_ARGS_JSON)",
  "$process = Start-Process -FilePath $command -ArgumentList $childArgs -NoNewWindow -PassThru -Wait",
  "exit $process.ExitCode",
].join("; ");
const child = spawn(
  process.platform === "win32" ? "powershell.exe" : runnerCommand,
  process.platform === "win32"
    ? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsRunnerScript, "utf16le").toString("base64"),
      ]
    : args,
  {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      PM_MCP_HTTP_HOST: "127.0.0.1",
      PM_MCP_HTTP_PORT: String(port),
      PM_VERIFY_HTTP_CHILD_COMMAND_B64: Buffer.from(runnerCommand).toString(
        "base64",
      ),
      PM_VERIFY_HTTP_CHILD_ARGS_JSON: JSON.stringify(args),
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let childExit;
let stderr = "";
child.once("exit", (code, signal) => {
  childExit = { code, signal };
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-4_096);
});

const childTreeIsAlive = () => {
  if (!child.pid) return false;
  if (process.platform === "win32") return !childExit;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

const signalChildTree = (signal) => {
  if (!child.pid || !childTreeIsAlive()) return;
  if (process.platform === "win32") child.kill(signal);
  else process.kill(-child.pid, signal);
};

const waitForChildTreeExit = async () => {
  const deadline = Date.now() + ${MCP_HTTP_SHUTDOWN_GRACE_MS};
  while (childTreeIsAlive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

let stopPromise;
const stopChild = () => {
  if (!child.pid) return Promise.resolve();
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    if (process.platform === "win32") {
      if (!childTreeIsAlive()) return;
      await new Promise((resolve, reject) => {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.once("error", reject);
        killer.once("close", (code) => {
          if (code === 0 || !childTreeIsAlive()) resolve();
          else reject(new Error("taskkill.exe exited with code " + code));
        });
      });
      await waitForChildTreeExit();
      if (childTreeIsAlive()) {
        throw new Error(
          "Published HTTP process tree remained alive after taskkill.exe",
        );
      }
      return;
    }
    if (!childTreeIsAlive()) return;
    signalChildTree("SIGTERM");
    await waitForChildTreeExit();
    if (childTreeIsAlive()) {
      signalChildTree("SIGKILL");
      await waitForChildTreeExit();
    }
  })();
  return stopPromise;
};

const signalHandlers = new Map();
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  const handler = () => {
    void stopChild().finally(() => process.exit(exitCode));
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

try {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":
          ${JSON.stringify(MCP_EXTENSION_CLIENT_CAPABILITIES)},
        "io.modelcontextprotocol/clientInfo": {
          name: "published-http-artifact-verifier",
          version: "1.0.0",
        },
      },
    },
  };
  const configuredReadyTimeout = Number(
    process.env.PM_VERIFY_HTTP_READY_TIMEOUT_MS,
  );
  const readyTimeout =
    Number.isFinite(configuredReadyTimeout) &&
    configuredReadyTimeout >= 0 &&
    configuredReadyTimeout <= ${MCP_HTTP_READY_TIMEOUT_MS}
      ? configuredReadyTimeout
      : ${MCP_HTTP_READY_TIMEOUT_MS};
  const deadline = Date.now() + readyTimeout;
  let response;
  let payload;
  while (Date.now() < deadline) {
    if (childExit) {
      throw new Error(
        "Published HTTP bin exited before discovery: " +
          JSON.stringify({ ...childExit, stderr: stderr.trim() }),
      );
    }
    try {
      response = await fetch("http://127.0.0.1:" + port + "/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "server/discover",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      payload = await response.json();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!response || !payload) {
    throw new Error("Published HTTP bin did not become reachable before timeout");
  }
  const serverName = payload?.result?._meta?.[
    "io.modelcontextprotocol/serverInfo"
  ]?.name;
  const skillsCapability = payload?.result?.capabilities?.extensions?.[
    "io.modelcontextprotocol/skills"
  ];
  if (
    response.status !== 200 ||
    payload?.id !== 1 ||
    payload?.result?.resultType !== "complete" ||
    serverName !== "pm-mcp" ||
    !Array.isArray(payload?.result?.supportedVersions) ||
    !payload.result.supportedVersions.includes("2026-07-28") ||
    skillsCapability?.status !== "draft" ||
    skillsCapability?.revision !== ${JSON.stringify(MCP_SKILLS_DRAFT_REVISION)} ||
    !payload?.result?.capabilities?.extensions?.["io.modelcontextprotocol/ui"]
  ) {
    throw new Error(
      "Published HTTP discovery response was invalid: " +
        JSON.stringify({ status: response.status, payload }),
    );
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    runner,
    http_status: response.status,
    server_name: serverName,
    protocol_version: "2026-07-28",
    extensions: ["io.modelcontextprotocol/skills", "io.modelcontextprotocol/ui"],
  }));
} finally {
  await stopChild();
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
}
`;

function usage() {
  console.log(`Usage:
  node scripts/release/verify-published-release.mjs --version <YYYY.M.D[-N]> [--json]
    [--skip-package]
    [--skip-github-release]
    [--npm-attempts 20]
    [--executor-attempts 10]

Verifies the public release surfaces after publish:
- npm registry metadata
- npx and bunx real CLI command dispatch
- npx and bunx pm-mcp stateless discovery, Skills, and Apps journeys
- package bin-to-entrypoint coverage and missing-bin negative controls
- GitHub Release metadata
`);
}

function sleep(milliseconds) {
  // Test seam: PM_VERIFY_SLEEP_MS lets the unit suite cap the synchronous
  // retry backoff so it can exercise the multi-attempt path without blocking
  // the worker thread for the production 10–15s propagation delays.
  const override = Number(process.env.PM_VERIFY_SLEEP_MS);
  /* c8 ignore next -- the fallback uses the real 10-15s production backoff; the unit suite always sets PM_VERIFY_SLEEP_MS so exercising it would block the worker thread */
  const effective =
    Number.isFinite(override) && override >= 0 ? override : milliseconds;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, effective);
}

function parseVersionFromFlags(flags) {
  const explicitVersion = flagString(flags, "version", null);
  const tag = flagString(flags, "tag", null);
  const version = explicitVersion ?? (tag ? tag.replace(/^v/u, "") : null);
  if (!version) {
    fail("Missing --version <YYYY.M.D[-N]> or --tag v<YYYY.M.D[-N]>.");
  }
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(version)) {
    fail(`Invalid release version "${version}".`);
  }
  return version;
}

function parsePositiveInteger(flags, key, fallback) {
  const raw = flagString(flags, key, String(fallback));
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`Invalid --${key} value "${raw}".`);
  }
  return parsed;
}

function runWithRetries(label, attempts, delayMs, action) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = action(attempt);
    if (result.ok) {
      return { ...result, attempts: attempt };
    }
    /* c8 ignore next -- every action returns an explicit reason on failure; the "unknown_failure" fallback is defensive */
    failures.push(result.reason ?? "unknown_failure");
    if (attempt < attempts) {
      console.error(
        `Waiting for ${label} propagation (attempt ${attempt}/${attempts})...`,
      );
      sleep(delayMs);
    }
  }
  return {
    ok: false,
    attempts,
    /* c8 ignore next -- the loop runs at least once and always pushes a failure before this return, so failures.at(-1) is defined */
    reason: failures.at(-1) ?? `${label}_verification_failed`,
  };
}

function verifyNpmMetadata(version, attempts, publicRegistryEnv) {
  const npm = commandFor("npm");
  return runWithRetries("npm metadata", attempts, 15000, () => {
    const result = runCommand(
      npm,
      [
        "view",
        `${NPM_PACKAGE}@${version}`,
        "version",
        "dist.integrity",
        "dist.unpackedSize",
        "--json",
      ],
      { capture: true, allowFailure: true, env: publicRegistryEnv },
    );
    if (result.status !== 0) {
      return { ok: false, reason: result.stderr.trim() || "npm_view_failed" };
    }
    try {
      const metadata = JSON.parse(result.stdout);
      if (metadata.version !== version) {
        return {
          ok: false,
          reason: `npm_version_mismatch:${metadata.version ?? "missing"}`,
        };
      }
      return { ok: true, metadata };
    } catch (error) {
      /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(error) fallback is unreachable */
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `npm_json_parse_failed:${message}` };
    }
  });
}

function verifyExecutor(
  name,
  args,
  attempts,
  tempRoot,
  publicRegistryEnv,
  assertion,
  input,
  timeout,
) {
  return runWithRetries(name, attempts, 10000, () => {
    const result = runCommand(args[0], args.slice(1), {
      cwd: tempRoot,
      capture: true,
      allowFailure: true,
      env: publicRegistryEnv,
      input,
      timeout,
    });
    if (result.status !== 0) {
      return {
        ok: false,
        reason: `${name}_execution_failed:${result.stderr.trim() || "no_output"}`,
      };
    }
    try {
      return assertion(result.stdout);
    } catch (error) {
      /* c8 ignore next -- native JSON parsing/assertions throw Error instances; the String(error) fallback is defensive */
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `${name}_invalid_output:${message}` };
    }
  });
}

function verifyRequiredExecutor(
  label,
  args,
  attempts,
  tempRoot,
  publicRegistryEnv,
  assertion,
  input,
  timeout,
) {
  const result = verifyExecutor(
    label,
    args,
    attempts,
    tempRoot,
    publicRegistryEnv,
    assertion,
    input,
    timeout,
  );
  if (!result.ok) {
    fail(`${label} verification failed: ${result.reason}`);
  }
  return result;
}

function assertCliDispatch(stdout) {
  const parsed = JSON.parse(stdout.trim());
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "cli_dispatch_not_an_object" };
  }
  return { ok: true, command: "contracts", output: "json" };
}

function verifyListedSkillResource(responses, skills) {
  const skillContents = Object(responses.get(5)?.result).contents;
  const skillContent = Object(
    Array.isArray(skillContents) ? skillContents[0] : null,
  );
  const listedSkill = Array.isArray(skills)
    ? skills.find((skill) => skill.uri === MCP_SKILL_RESOURCE_URI)
    : undefined;
  const listedResource = Array.isArray(listedSkill?.resources)
    ? listedSkill.resources.find(
        (resource) => resource.uri === MCP_SKILL_RESOURCE_URI,
      )
    : undefined;
  const skillBytes =
    typeof skillContent.text === "string"
      ? Buffer.from(skillContent.text, "utf8")
      : typeof skillContent.blob === "string"
        ? Buffer.from(skillContent.blob, "base64")
        : undefined;
  const computedDigest = skillBytes
    ? `sha256:${createHash("sha256").update(skillBytes).digest("hex")}`
    : undefined;
  return {
    descriptorsValid:
      Array.isArray(skills) &&
      skills.length > 0 &&
      skills.every(
        (skill) =>
          Array.isArray(skill.resources) &&
          skill.resources.every((resource) =>
            /^sha256:[a-f0-9]{64}$/u.test(resource.digest),
          ),
      ),
    resourceValid:
      listedResource?.digest === computedDigest &&
      Object(skillContent._meta).digest === computedDigest &&
      skillContent.uri === MCP_SKILL_RESOURCE_URI,
  };
}

function assertMcpDiscovery(stdout) {
  const responses = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .reduce((byId, entry) => byId.set(entry.id, entry), new Map());
  const response = responses.get(1);
  const discovery = Object(response?.result);
  const serverInfo = Object(
    Object(discovery._meta)["io.modelcontextprotocol/serverInfo"],
  );
  const extensions = Object(Object(discovery.capabilities).extensions);
  const skillsCapability = Object(
    extensions["io.modelcontextprotocol/skills"],
  );
  const skills = Object(responses.get(2)?.result).skills;
  const toolsValue = Object(responses.get(3)?.result).tools;
  const tools = Array.isArray(toolsValue) ? toolsValue : [];
  const contextTool = Object(
    tools.find((tool) => tool.name === "pm_context"),
  );
  const contextToolUi = Object(Object(contextTool._meta).ui);
  const appContents = Object(responses.get(4)?.result).contents;
  const appContent = Object(Array.isArray(appContents) ? appContents[0] : null);
  const skillVerification = verifyListedSkillResource(responses, skills);
  const validity = [
    serverInfo.name === "pm-mcp",
    discovery.resultType === "complete",
    Array.isArray(discovery.supportedVersions),
    Array.isArray(discovery.supportedVersions) &&
      discovery.supportedVersions.includes("2026-07-28"),
    skillsCapability.status === "draft",
    skillsCapability.revision === MCP_SKILLS_DRAFT_REVISION,
    extensions["io.modelcontextprotocol/ui"] !== undefined,
    Array.isArray(skills),
    skillVerification.descriptorsValid,
    skillVerification.resourceValid,
    contextToolUi.resourceUri === "ui://pm/context.html",
    Array.isArray(appContents),
    appContent.mimeType === "text/html;profile=mcp-app",
    typeof appContent.text === "string" &&
      appContent.text.includes("ui/initialize"),
  ];
  if (validity.includes(false)) {
    return { ok: false, reason: "mcp_discovery_response_invalid" };
  }
  return {
    ok: true,
    server_name:
      response.result._meta["io.modelcontextprotocol/serverInfo"].name,
    protocol_version: "2026-07-28",
    skill_count: skills.length,
    apps: true,
  };
}

function assertMcpHttpDiscovery(stdout) {
  const parsed = JSON.parse(stdout.trim());
  if (
    parsed?.ok !== true ||
    parsed.http_status !== 200 ||
    parsed.server_name !== "pm-mcp" ||
    parsed.protocol_version !== "2026-07-28" ||
    !Array.isArray(parsed.extensions) ||
    !parsed.extensions.includes("io.modelcontextprotocol/skills") ||
    !parsed.extensions.includes("io.modelcontextprotocol/ui")
  ) {
    return { ok: false, reason: "mcp_http_discovery_response_invalid" };
  }
  return {
    ok: true,
    http_status: parsed.http_status,
    server_name: parsed.server_name,
    protocol_version: parsed.protocol_version,
    extensions: parsed.extensions,
  };
}

function verifyMcpHttpExecutor(
  runner,
  packageSpec,
  attempts,
  tempRoot,
  publicRegistryEnv,
) {
  const boundedAttempts = Math.min(attempts, MCP_HTTP_EXECUTOR_MAX_ATTEMPTS);
  return verifyRequiredExecutor(
    `${runner}-pm-mcp-http`,
    [
      commandFor("node"),
      "--input-type=module",
      "--eval",
      MCP_HTTP_EXECUTOR_SCRIPT,
    ],
    boundedAttempts,
    tempRoot,
    {
      ...publicRegistryEnv,
      PM_VERIFY_HTTP_RUNNER: runner,
      PM_VERIFY_HTTP_RUNNER_COMMAND: commandFor(runner),
      PM_VERIFY_HTTP_PACKAGE_SPEC: packageSpec,
    },
    assertMcpHttpDiscovery,
    undefined,
    MCP_HTTP_EXECUTOR_TIMEOUT_MS,
  );
}

function verifyMissingBinControl(label, args, tempRoot, publicRegistryEnv) {
  const result = runCommand(args[0], args.slice(1), {
    cwd: tempRoot,
    capture: true,
    allowFailure: true,
    env: publicRegistryEnv,
  });
  if (result.status === 0) {
    fail(`${label} negative control failed: a missing executable exited zero.`);
  }
  return { ok: true, observed_nonzero_status: result.status };
}

function verifyPackageSurfaces(version, npmAttempts, executorAttempts) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-cli-published-verify-"));
  try {
    const npmUserConfig = path.join(tempRoot, "npmrc-public");
    writeFileSync(npmUserConfig, "", "utf8");
    const publicRegistryEnv = {
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
      npm_config_cache: path.join(tempRoot, "npm-cache"),
      npm_config_userconfig: npmUserConfig,
      BUN_INSTALL_CACHE_DIR: path.join(tempRoot, "bun-cache"),
    };
    const npmMetadata = verifyNpmMetadata(
      version,
      npmAttempts,
      publicRegistryEnv,
    );
    if (!npmMetadata.ok) {
      fail(`npm metadata verification failed: ${npmMetadata.reason}`);
    }

    const packageSpec = `${NPM_PACKAGE}@${version}`;
    const binEntries = Object.entries(PACKAGE_BINS);
    const coveredEntrypoints = new Set([
      PACKAGE_BINS.pm,
      PACKAGE_BINS["pm-mcp"],
      PACKAGE_BINS["pm-mcp-http"],
    ]);
    const uncoveredBins = binEntries
      .filter(([, entrypoint]) => !coveredEntrypoints.has(entrypoint))
      .map(([bin]) => bin);
    if (uncoveredBins.length > 0) {
      fail(
        `Published package bins lack executable coverage: ${uncoveredBins.join(", ")}`,
      );
    }
    const npxPm = verifyRequiredExecutor(
      "npx-pm",
      [
        commandFor("npx"),
        "--yes",
        "--package",
        packageSpec,
        "--",
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertCliDispatch,
    );
    const npxPackageDefaultPm = verifyRequiredExecutor(
      "npx-package-default-pm",
      [
        commandFor("npx"),
        "--yes",
        packageSpec,
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertCliDispatch,
    );
    const npxMcp = verifyRequiredExecutor(
      "npx-pm-mcp",
      [commandFor("npx"), "--yes", "--package", packageSpec, "--", "pm-mcp"],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertMcpDiscovery,
      MCP_DISCOVER_REQUEST,
      MCP_DISCOVER_TIMEOUT_MS,
    );
    const bunxPm = verifyRequiredExecutor(
      "bunx-pm",
      [
        commandFor("bunx"),
        "--silent",
        "--bun",
        "--package",
        packageSpec,
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertCliDispatch,
    );
    const bunxPackageDefaultPm = verifyRequiredExecutor(
      "bunx-package-default-pm",
      [
        commandFor("bunx"),
        "--silent",
        "--bun",
        packageSpec,
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertCliDispatch,
    );
    const bunxMcp = verifyRequiredExecutor(
      "bunx-pm-mcp",
      [
        commandFor("bunx"),
        "--silent",
        "--bun",
        "--package",
        packageSpec,
        "pm-mcp",
      ],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertMcpDiscovery,
      MCP_DISCOVER_REQUEST,
      MCP_DISCOVER_TIMEOUT_MS,
    );
    const npxMcpHttp = verifyMcpHttpExecutor(
      "npx",
      packageSpec,
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
    );
    const bunxMcpHttp = verifyMcpHttpExecutor(
      "bunx",
      packageSpec,
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
    );
    const negativeControls = {
      npx: verifyMissingBinControl(
        "npx-missing-bin",
        [
          commandFor("npx"),
          "--yes",
          "--package",
          packageSpec,
          "--",
          "pm-definitely-missing",
        ],
        tempRoot,
        publicRegistryEnv,
      ),
      npx_package_default: verifyMissingBinControl(
        "npx-package-default-missing-command",
        [commandFor("npx"), "--yes", packageSpec, "pm-definitely-missing"],
        tempRoot,
        publicRegistryEnv,
      ),
      bunx: verifyMissingBinControl(
        "bunx-missing-bin",
        [
          commandFor("bunx"),
          "--silent",
          "--bun",
          "--package",
          packageSpec,
          "pm-definitely-missing",
        ],
        tempRoot,
        publicRegistryEnv,
      ),
      bunx_package_default: verifyMissingBinControl(
        "bunx-package-default-missing-command",
        [
          commandFor("bunx"),
          "--silent",
          "--bun",
          packageSpec,
          "pm-definitely-missing",
        ],
        tempRoot,
        publicRegistryEnv,
      ),
    };
    return {
      npm: npmMetadata,
      executors: {
        npx: {
          pm: npxPm,
          "package-default-pm": npxPackageDefaultPm,
          "pm-mcp": npxMcp,
          "pm-mcp-http": npxMcpHttp,
        },
        bunx: {
          pm: bunxPm,
          "package-default-pm": bunxPackageDefaultPm,
          "pm-mcp": bunxMcp,
          "pm-mcp-http": bunxMcpHttp,
        },
      },
      negative_controls: negativeControls,
      bin_coverage: {
        covered_bins: binEntries.map(([bin]) => bin).sort(),
        distinct_entrypoints: [
          ...new Set(binEntries.map(([, entrypoint]) => entrypoint)),
        ].sort(),
        uncovered_bins: uncoveredBins,
      },
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function verifyGitHubRelease(version) {
  const tagName = `v${version}`;
  const result = runCommand(
    commandFor("gh"),
    [
      "release",
      "view",
      tagName,
      "--json",
      "tagName,name,isDraft,isPrerelease,url",
    ],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) {
    fail(
      `GitHub release verification failed: ${result.stderr.trim() || "gh_release_view_failed"}`,
    );
  }
  try {
    const metadata = JSON.parse(result.stdout);
    if (metadata.tagName !== tagName) {
      fail(
        `GitHub release tag mismatch: expected ${tagName}, received ${metadata.tagName ?? "missing"}.`,
      );
    }
    if (metadata.isDraft === true || metadata.isPrerelease === true) {
      fail(`GitHub release ${tagName} must not be draft/prerelease.`);
    }
    return metadata;
  } catch (error) {
    /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(error) fallback is unreachable */
    const message = error instanceof Error ? error.message : String(error);
    fail(`GitHub release JSON parse failed: ${message}`);
  }
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const skipPackage = flagBool(flags, "skip-package", false);
  const skipGithubRelease = flagBool(flags, "skip-github-release", false);
  const npmAttempts = parsePositiveInteger(flags, "npm-attempts", 20);
  const executorAttempts = parsePositiveInteger(flags, "executor-attempts", 10);
  const version = parseVersionFromFlags(flags);

  const result = {
    ok: true,
    version,
    package: skipPackage
      ? { skipped: true }
      : verifyPackageSurfaces(version, npmAttempts, executorAttempts),
    github_release: skipGithubRelease
      ? { skipped: true }
      : verifyGitHubRelease(version),
  };

  if (outputJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`Published release ${version} verified.`);
}

main();
