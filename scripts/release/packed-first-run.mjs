/** Execute the README cold start against an installed package, then its MCP server. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { on, once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { addAbortSignal } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startPluginMcpSmoke } from "../plugin-mcp-smoke-harness.mjs";

const execute = promisify(execFile);

/** Acknowledge split worker batches until completion arrives, under one deadline with listener cleanup. */
export async function collectTelemetryCompletion(collector, timeoutMs = 30_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  let eventCount = 0;
  for await (const [request, response] of on(collector, "request", {
    signal,
  })) {
    let body = "";
    for await (const chunk of addAbortSignal(signal, request)) body += chunk.toString();
    response.writeHead(202).end();
    const events = JSON.parse(body).events;
    eventCount += events.length;
    if (events.some((event) => event.event_type === "command_finish")) return eventCount;
  }
}

/** Parse the documented init/create/list sequence without executing shell syntax. */
export function readQuickstartCommands(markdown) {
  const section = markdown.split("## 60 Second Example\n")[1];
  assert(section, "README is missing its 60 Second Example");
  const block = section.split("```bash\n")[1]?.split("```")[0];
  assert(block, "README quickstart is missing its bash block");
  const commands = block
    .replaceAll(/\\\r?\n\s*/gu, " ")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => {
      assert(
        !/[`$;|&<>]/u.test(line),
        "README cold start contains unsupported shell syntax",
      );
      const tokens = [...line.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/gu)].map(
        (match) => match[1] ?? match[2] ?? match[3],
      );
      assert(
        !line.replaceAll(/"[^"]*"|'[^']*'|[^\s"']+/gu, "").trim(),
        "README cold start has unbalanced quotes",
      );
      assert.equal(tokens.shift(), "pm", "README cold start must invoke pm");
      return tokens;
    });
  assert.deepEqual(
    commands.map((args) => args[0]),
    ["init", "create", "list"],
  );
  return commands;
}

/** Exercise documented commands in a foreign workspace using only installed files. */
export async function runPackedFirstRun(packageRoot) {
  const root = path.resolve(packageRoot);
  const commands = readQuickstartCommands(
    await readFile(path.join(root, "README.md"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const workspace = await mkdtemp(path.join(tmpdir(), "pm-packed-first-run-"));
  const env = {
    ...process.env,
    HOME: path.join(workspace, "home"),
    USERPROFILE: path.join(workspace, "home"),
    PM_PATH: path.join(workspace, ".agents", "pm"),
    PM_GLOBAL_PATH: path.join(workspace, "global"),
    PM_TELEMETRY_DISABLED: "1",
    PM_TELEMETRY_OTEL_DISABLED: "1",
    PM_AGENT_PROBES: "0",
  };
  try {
    await mkdir(env.HOME);
    /** Run Git only inside the disposable workspace, with a bounded deadline. */
    const git = (args) =>
      execute("git", args, { cwd: workspace, env, timeout: 30_000 });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.name", "Packed Acceptance"]);
    await git(["config", "user.email", "packed@example.invalid"]);
    const steps = [];
    for (const args of commands) {
      const { stdout } = await execute(
        process.execPath,
        [path.join(root, "dist", "cli.js"), ...args],
        {
          cwd: workspace,
          env,
          timeout: 30_000,
          maxBuffer: 64 * 1024,
        },
      );
      assert(
        stdout.length > 0 && stdout.length <= 4096,
        `${args[0]} exceeded its nonempty 4096-character budget`,
      );
      steps.push({ command: args[0], output_characters: stdout.length });
    }
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, "dist", "cli.js"), "list", "--json"],
      {
        cwd: workspace,
        env,
        timeout: 30_000,
      },
    );
    const listed = JSON.parse(stdout);
    assert.equal(
      listed.total,
      1,
      "README create must persist exactly one item",
    );
    assert.equal(listed.items[0].title, "Fix stale lock restore failure");
    const itemId = listed.items[0].id;
    /** Execute the installed CLI against sandbox state and decode its JSON receipt. */
    const pm = async (args) => {
      const result = await execute(
        process.execPath,
        [path.join(root, "dist", "cli.js"), ...args, "--json"],
        {
          cwd: workspace,
          env,
          timeout: 30_000,
          maxBuffer: 128 * 1024,
        },
      );
      return JSON.parse(result.stdout);
    };
    await git(["add", ".gitattributes", ".gitignore", ".agents/pm"]);
    await git(["commit", "-qm", "Initialize packed workspace"]);
    await git(["branch", "peer"]);
    await pm(["comments", itemId, "Main branch evidence"]);
    await git(["add", ".agents/pm"]);
    await git(["commit", "-qm", "Record main evidence"]);
    await git(["checkout", "-q", "peer"]);
    await pm(["comments", itemId, "Peer branch evidence"]);
    await git(["add", ".agents/pm"]);
    await git(["commit", "-qm", "Record peer evidence"]);
    await git(["merge", "--no-edit", "main"]);
    await pm(["merge", "reconcile"]);
    await pm(["history", itemId, "--verify", "--strict-exit"]);
    const merged = await pm(["get", itemId, "--full"]);
    assert.deepEqual(
      merged.item.comments.map((comment) => comment.text).sort(),
      ["Main branch evidence", "Peer branch evidence"],
    );
    const collector = createServer();
    collector.listen(0, "127.0.0.1");
    await once(collector, "listening");
    try {
      const endpoint = `http://127.0.0.1:${collector.address().port}/v1/events`;
      await pm(["config", "global", "set", "telemetry-tracking", "on"]);
      const settingsPath = path.join(env.PM_GLOBAL_PATH, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.telemetry.endpoint = endpoint;
      await writeFile(settingsPath, JSON.stringify(settings));
      const delivery = collectTelemetryCompletion(collector);
      const telemetryEnv = {
        ...env,
        PM_TELEMETRY_DISABLED: "0",
        PM_TELEMETRY_SOURCE_CONTEXT: "test",
      };
      for (const name of [
        "VITEST",
        "VITEST_WORKER_ID",
        "NODE_ENV",
        "PM_TELEMETRY_INLINE_FLUSH",
        "PM_TELEMETRY_FLUSH_CHILD",
        "DO_NOT_TRACK",
        "PM_NO_TELEMETRY",
        "PM_TELEMETRY_INGEST_KEY",
      ])
        delete telemetryEnv[name];
      await Promise.all([
        delivery,
        execute(
          process.execPath,
          [
            path.join(root, "dist", "cli.js"),
            "comments",
            itemId,
            "Detached telemetry acceptance",
            "--json",
          ],
          { cwd: workspace, env: telemetryEnv, timeout: 30_000 },
        ),
      ]);
      const status = await pm(["telemetry", "status"]);
      assert.equal(
        status.status.queue_entries,
        0,
        "Detached worker must drain the physical queue",
      );
      assert(
        status.status.last_successful_flush_at,
        "Detached worker must record successful delivery",
      );
    } finally {
      collector.closeAllConnections();
      await new Promise((resolve) => collector.close(resolve));
    }
    const smoke = await startPluginMcpSmoke({
      serverPath: path.join(root, "dist", "mcp", "server.js"),
      author: "packed-first-run",
      tmpPrefix: "pm-packed-mcp-",
      environment: {
        HOME: env.HOME,
        USERPROFILE: env.USERPROFILE,
        PM_TELEMETRY_DISABLED: "1",
        PM_TELEMETRY_OTEL_DISABLED: "1",
        PM_AGENT_PROBES: "0",
      },
    });
    try {
      const initialized = await smoke.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "packed-first-run", version: "1.0.0" },
      });
      assert.equal(initialized.protocolVersion, "2025-11-25");
      assert.equal(initialized.serverInfo.version, manifest.version);
    } finally {
      await smoke.dispose();
    }
    return {
      ok: true,
      version: manifest.version,
      steps,
      mcp: true,
      merge_history: true,
      detached_telemetry: true,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert(
    process.argv[2],
    "Pass the installed @unbrained/pm-cli package directory",
  );
  console.log(JSON.stringify(await runPackedFirstRun(process.argv[2])));
}
