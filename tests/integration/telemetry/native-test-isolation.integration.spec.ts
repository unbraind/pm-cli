import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempDir } from "../../helpers/temp.js";

const execute = promisify(execFile);
const sdk = new URL("../../../dist/sdk/index.js", import.meta.url).href;

it.each(["suppressed", "consented", "override", "hard-opt-out"])("isolates real node --test SDK children: %s", async (mode) => {
  await withTempDir("pm-native-test-", async (root) => {
    const received: Array<{ event_type: string; payload: { source_context: string } }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        received.push(...(JSON.parse(body) as { events: typeof received }).events);
        response.writeHead(202).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected a local collector");
      const globalRoot = path.join(root, "global");
      await mkdir(globalRoot);
      const configured = await readSettings(globalRoot);
      configured.telemetry.enabled = true;
      configured.telemetry.endpoint = `http://127.0.0.1:${address.port}/events`;
      await writeSettings(globalRoot, configured);
      const settings = await readFile(path.join(globalRoot, "settings.json"), "utf8");
      const allowed = mode === "consented" || mode === "override";
      const source = mode === "override" ? "dogfood" : "test";
      const fixture = path.join(root, "native.test.mjs");
      await writeFile(fixture, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { startTelemetryCommand, finishTelemetryCommand, ensureSentryInit } from ${JSON.stringify(sdk)};
test('native SDK telemetry lifecycle', async () => {
  assert.equal(typeof process.env.NODE_TEST_CONTEXT, 'string');
  const active = await startTelemetryCommand({ command: 'create', pm_version: 'fixture', args: [], options: {}, global: { noExtensions: true }, pm_root: process.cwd() });
  assert.equal(active !== null, ${allowed});
  ${allowed ? `assert.equal(active.source_context, ${JSON.stringify(source)});` : "assert.equal(await ensureSentryInit(), undefined);"}
  await finishTelemetryCommand(active, { ok: true });
  ${allowed ? `assert.equal(await readFile(${JSON.stringify(path.join(globalRoot, "runtime", "telemetry", "events.jsonl"))}, 'utf8'), '');` : `assert.equal(await readFile(${JSON.stringify(path.join(globalRoot, "settings.json"))}, 'utf8'), ${JSON.stringify(settings)});`}
  await rm(${JSON.stringify(globalRoot)}, { recursive: true });
});
`);
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of ["VITEST", "VITEST_WORKER_ID", "NODE_ENV", "NODE_TEST_CONTEXT", "PM_TELEMETRY_SOURCE_CONTEXT", "PM_TELEMETRY_SEND_TEST_EVENTS", "PM_TELEMETRY_INLINE_FLUSH", "PM_TELEMETRY_FLUSH_CHILD", "PM_SENTRY_DISABLED"]) delete env[key];
      Object.assign(env, { PM_PATH: path.join(root, "project"), PM_GLOBAL_PATH: globalRoot, PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0", DO_NOT_TRACK: mode === "hard-opt-out" ? "1" : "0", PM_TELEMETRY_OTEL_DISABLED: "1", PM_AGENT_PROBES: "0" });
      if (mode === "consented" || mode === "hard-opt-out") env.PM_TELEMETRY_SEND_TEST_EVENTS = "1";
      if (mode === "override") env.PM_TELEMETRY_SOURCE_CONTEXT = "dogfood";
      await execute(process.execPath, ["--test", fixture], { cwd: root, env, timeout: 30_000 }).catch((error: unknown) => {
        const result = error as { stdout?: string; stderr?: string };
        throw new Error(`Native test child failed:\n${result.stdout}\n${result.stderr}`, { cause: error });
      });
      expect(received.map((event) => event.event_type)).toEqual(allowed ? ["command_start", "command_finish"] : []);
      expect(received.every((event) => event.payload.source_context === source)).toBe(true);
      await expect(readFile(path.join(globalRoot, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}, 40_000);
