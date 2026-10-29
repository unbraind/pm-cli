import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";

const execute = promisify(execFile);

it.each(["node", "bun"])("keeps declared refusals separate from unexpected extension faults and attributes %s errors without tracing", async (runtime) => {
  const events: Array<Record<string, unknown>> = [];
  const telemetry: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = (request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).toString();
    if (request.url === "/events") telemetry.push(...JSON.parse(body).events);
    else {
      const lines = body.trim().split("\n");
      for (let index = 1; index + 1 < lines.length; index += 2) {
        if (JSON.parse(lines[index]!).type === "event") events.push(JSON.parse(lines[index + 1]!));
      }
    }
    response.writeHead(200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withTempPmPath(async (context) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing collector address");
      const globalPath = context.env.PM_GLOBAL_PATH;
      if (!globalPath) throw new Error("Missing isolated global tracker");
      const settings = await readSettings(globalPath);
      await writeSettings(globalPath, { ...settings, telemetry: { ...settings.telemetry, enabled: true,
        installation_id: randomUUID(), endpoint: `http://127.0.0.1:${address.port}/events` } });
      await writeTestExtension({
        root: context.pmPath, placement: "projectRoot", directory: "error-probe", entryFilename: "index.mjs",
        manifest: { name: "error-probe", version: "1.2.3", capabilities: ["commands"] },
        entrySource: `export function activate(api) { api.registerCommand({ name: "error probe", arguments: [{ name: "mode", required: true }], run: ({ args }) => {
          if (args[0] === "untyped") throw new Error("unexpected untyped handler fault");
          if (args[0] === "misnamed") throw Object.assign(new Error("invalid refusal shape"), { name: "PmCliError", code: "not_a_contract" });
          throw Object.assign(new Error("producer refusal"), args[0] === "expected"
            ? { name: "PmCliError", exitCode: 1, code: "probe_expected", context: { code: "probe_expected", nextSteps: ["Use a supported input."] } }
            : { name: "SimulationRefusal", exitCode: 1, code: "sdk_unavailable", remediation: "Install the SDK." });
        } }); }`,
      });
      const env: NodeJS.ProcessEnv = { ...context.env, CI: "true", PM_SENTRY_DISABLED: "0", PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0", DO_NOT_TRACK: "0",
        PM_TELEMETRY_INLINE_FLUSH: "1", PM_TELEMETRY_PROMPT: "0",
        SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`, SENTRY_TRACES_SAMPLE_RATE: "0" };
      for (const key of ["VITEST", "VITEST_WORKER_ID", "NODE_TEST_CONTEXT", "NODE_ENV", "PM_SENTRY_TRACE_COMMANDS", "SENTRY_ENVIRONMENT"]) delete env[key];
      for (const source of ["automation", "test", "dogfood", "user"]) {
        const before = events.length;
        const result = await execute(runtime === "node" ? process.execPath : "bun", [path.resolve("dist/cli.js"), "error", "probe", "unexpected", "--json"], {
          cwd: context.tempRoot, env: { ...env, PM_TELEMETRY_SOURCE_CONTEXT: source }, timeout: 15_000,
        }).catch((error) => error);
        expect(result.code, result.stderr).toBe(1);
        const faults = events.slice(before).filter((event) => event.exception);
        expect(faults).toHaveLength(1);
        expect(faults[0]).toMatchObject({ environment: source === "user" ? "production" : source, tags: {
          "pm.source_context": source, "pm.source_context_source": "env_override", "pm.extension.name": "error-probe",
          "pm.extension.version": "1.2.3", "pm.error_code": "sdk_unavailable", "pm.version": expect.any(String),
        } });
        expect(telemetry.filter((event) => event.event_type === "command_finish").at(-1)).toMatchObject({ payload: { source_context: source } });
      }
      for (const mode of ["untyped", "misnamed"]) {
        const before = events.length;
        const result = await execute(runtime === "node" ? process.execPath : "bun", [path.resolve("dist/cli.js"), "error", "probe", mode, "--json"], {
          cwd: context.tempRoot, env: { ...env, PM_TELEMETRY_SOURCE_CONTEXT: "test" }, timeout: 15_000,
        }).catch((error) => error);
        expect(result.code, result.stderr).toBe(1);
        expect(events.slice(before).filter((event) => event.exception)).toHaveLength(1);
      }
      const before = events.length;
      const expected = await execute(runtime === "node" ? process.execPath : "bun", [path.resolve("dist/cli.js"), "error", "probe", "expected", "--json"], {
        cwd: context.tempRoot, env: { ...env, PM_TELEMETRY_SOURCE_CONTEXT: "test" }, timeout: 15_000,
      }).catch((error) => error);
      expect(expected.code).toBe(1);
      expect(JSON.parse(expected.stderr).code).toBe("probe_expected");
      expect(JSON.parse(expected.stderr).next_steps).toContain("Use a supported input.");
      expect(events.slice(before).filter((event) => event.exception)).toEqual([]);
      expect(JSON.stringify(events)).not.toContain(context.tempRoot);
      expect(telemetry.length).toBeGreaterThan(0);
      await writeSettings(globalPath, { ...settings, telemetry: { ...settings.telemetry, enabled: false } });
      const beforeDisabled = events.length;
      const telemetryBefore = telemetry.length;
      const disabled = await execute(runtime === "node" ? process.execPath : "bun", [path.resolve("dist/cli.js"), "error", "probe", "unexpected", "--json"], {
        cwd: context.tempRoot, env: { ...env, PM_TELEMETRY_SOURCE_CONTEXT: "automation" }, timeout: 15_000,
      }).catch((error) => error);
      expect(disabled.code).toBe(1);
      expect(events.slice(beforeDisabled).filter((event) => event.exception)).toEqual([expect.objectContaining({ tags: expect.objectContaining({
        "pm.command": "error probe", "pm.extension.name": "error-probe", "pm.extension.version": "1.2.3", "pm.source_context": "automation",
      }) })]);
      expect(telemetry).toHaveLength(telemetryBefore);
      expect((await readSettings(globalPath)).telemetry.installation_id).toBe(settings.telemetry.installation_id);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 60_000);
