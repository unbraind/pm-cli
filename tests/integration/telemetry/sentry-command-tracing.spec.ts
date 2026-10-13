import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));
const sdk = new URL("../../../dist/sdk/index.js", import.meta.url).href;
const embeddedCli = new URL("../../../dist/cli/public.js", import.meta.url).href;

it.each([
  ["default", {}, true, false, false, false],
  ["explicit", { PM_SENTRY_TRACE_COMMANDS: "1" }, true, true, false, false],
  ["configured opt-out", { PM_SENTRY_TRACE_COMMANDS: "1" }, false, false, false, false],
  ["zero rate", { PM_SENTRY_TRACE_COMMANDS: "1", SENTRY_TRACES_SAMPLE_RATE: "0" }, true, false, false, false],
  ["consent opt-out", { PM_SENTRY_TRACE_COMMANDS: "1", DO_NOT_TRACK: "1" }, true, false, false, false],
  ["test isolation", { PM_SENTRY_TRACE_COMMANDS: "1", VITEST: "1" }, true, false, false, false],
  ["preinitialized opt-out", { PM_SENTRY_TRACE_COMMANDS: "1" }, false, false, true, false],
  ["preinitialized allowed", { PM_SENTRY_TRACE_COMMANDS: "1" }, true, true, true, false],
  ["preinitialized default", { PM_SENTRY_TRACE_COMMANDS: "1" }, true, false, true, true],
  ["scope and parameter privacy", { PM_SENTRY_TRACE_COMMANDS: "1" }, true, true, true, false],
  ["command opt-out", { PM_SENTRY_TRACE_COMMANDS: "1" }, true, false, false, false],
  ["embedded command opt-out", { PM_SENTRY_TRACE_COMMANDS: "1" }, true, false, true, false],
] as const)("exports successful CLI spans only with %s tracing", async (_name, overrides, enabled, expected, preinitialized, removeOptIn) => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-sentry-command-"));
  const envelopes: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    envelopes.push((request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString());
    response.writeHead(200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing collector address");
    const globalPath = path.join(root, "global");
    const settings = await readSettings(globalPath);
    await writeSettings(globalPath, { ...settings, telemetry: { ...settings.telemetry, enabled, installation_id: randomUUID(), endpoint: `http://127.0.0.1:${address.port}/events` } });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["VITEST", "VITEST_WORKER_ID", "NODE_ENV", "PM_SENTRY_DISABLED", "PM_TELEMETRY_DISABLED", "PM_NO_TELEMETRY", "DO_NOT_TRACK", "PM_SENTRY_TRACE_COMMANDS"]) delete env[key];
    Object.assign(env, {
      PM_PATH: path.join(root, "project"), PM_GLOBAL_PATH: globalPath,
      PM_TELEMETRY_PROMPT: "0", SENTRY_TRACES_SAMPLE_RATE: "1",
      SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
    }, overrides);
    const commandArgs = _name.includes("command opt-out")
      ? ["--no-extensions", "config", "global", "set", "telemetry-tracking", "--policy", "disabled", "--json"]
      : ["--no-extensions", "contracts", "--summary", "--json"];
    const args = preinitialized
      ? ["--input-type=module", "-e", `const { ensureSentryCommandTracing, ensureSentryInit } = await import(${JSON.stringify(sdk)}); const { runPmCli } = await import(${JSON.stringify(embeddedCli)}); const hostArgv = JSON.stringify(process.argv); const hostExit = process.exitCode; await ensureSentryCommandTracing(true); if (${_name === "scope and parameter privacy"}) { const sentry = await ensureSentryInit(); sentry.getCurrentScope().setAttributes({token:"private-scope-value", counter:7, ready:true}); sentry.getIsolationScope().setAttribute("client_secret", "private-isolation-value"); sentry.logger.info(sentry.logger.fmt\`password=\${"private-parameter-value"}\`); if (sentry.getCurrentScope().getScopeData().attributes.token !== "private-scope-value") throw new Error("Log scrubbing changed the shared scope"); } if (${removeOptIn}) delete process.env.PM_SENTRY_TRACE_COMMANDS; await runPmCli(${JSON.stringify(commandArgs)}); if (JSON.stringify(process.argv) !== hostArgv || process.exitCode !== hostExit) throw new Error("Embedded invocation changed host state");`]
      : [cli, ...commandArgs];
    const result = await execute(process.execPath, args, { cwd: root, env, timeout: 15_000 });
    if (_name.includes("command opt-out")) expect((await readSettings(globalPath)).telemetry.enabled).toBe(false);
    else expect(JSON.parse(result.stdout)).toHaveProperty("commands");
    const sentryEnvelopes = envelopes.filter((envelope) => envelope.includes('"sdk":{"name":"sentry.'));
    const exported = sentryEnvelopes.join("\n");
    if (_name === "scope and parameter privacy") {
      expect(exported).not.toContain("private-scope-value");
      expect(exported).not.toContain("private-isolation-value");
      expect(exported).not.toContain("private-parameter-value");
      const logs = sentryEnvelopes.filter((envelope) => envelope.includes('"type":"log"')).flatMap((envelope) => envelope.split("\n").map((line) => JSON.parse(line))).filter((payload) => payload.version === 2).flatMap((payload) => payload.items);
      expect(logs).toEqual([expect.objectContaining({ body: "password=[scrubbed]", attributes: expect.objectContaining({
        token: { type: "string", value: "[scrubbed]" },
        client_secret: { type: "string", value: "[scrubbed]" },
        "sentry.message.parameter.0": { type: "string", value: "[scrubbed]" },
        counter: { type: "integer", value: 7 },
        ready: { type: "boolean", value: true },
      }) })]);
    }
    if (expected) {
      const spans = sentryEnvelopes.filter((envelope) => envelope.includes('"type":"span"')).flatMap((envelope) => envelope.split("\n").map((line) => JSON.parse(line))).filter((payload) => payload.version === 2).flatMap((payload) => payload.items);
      expect(spans).toEqual([expect.objectContaining({
        name: "pm contracts", status: "ok",
        attributes: expect.objectContaining({
          "pm.command_ok": { value: "true", type: "string" },
          "pm.command_root": { value: "contracts", type: "string" },
        }),
      })]);
      expect(exported).not.toContain(root);
    } else {
      expect(sentryEnvelopes.filter((envelope) => envelope.includes('"type":"span"'))).toEqual([]);
      if (!preinitialized && !_name.includes("command opt-out")) expect(sentryEnvelopes).toEqual([]);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
