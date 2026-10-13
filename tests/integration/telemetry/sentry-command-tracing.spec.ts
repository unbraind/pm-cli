import { execFile } from "node:child_process";
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

it.each([
  ["default", {}, true, false],
  ["explicit", { PM_SENTRY_TRACE_COMMANDS: "1" }, true, true],
  ["configured opt-out", { PM_SENTRY_TRACE_COMMANDS: "1" }, false, false],
  ["zero rate", { PM_SENTRY_TRACE_COMMANDS: "1", SENTRY_TRACES_SAMPLE_RATE: "0" }, true, false],
  ["consent opt-out", { PM_SENTRY_TRACE_COMMANDS: "1", DO_NOT_TRACK: "1" }, true, false],
  ["test isolation", { PM_SENTRY_TRACE_COMMANDS: "1", VITEST: "1" }, true, false],
] as const)("exports successful CLI spans only with %s tracing", async (_name, overrides, enabled, expected) => {
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
    await writeSettings(globalPath, { ...settings, telemetry: { ...settings.telemetry, enabled, endpoint: `http://127.0.0.1:${address.port}/events` } });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["VITEST", "VITEST_WORKER_ID", "NODE_ENV", "PM_SENTRY_DISABLED", "PM_TELEMETRY_DISABLED", "PM_NO_TELEMETRY", "DO_NOT_TRACK", "PM_SENTRY_TRACE_COMMANDS"]) delete env[key];
    Object.assign(env, {
      PM_PATH: path.join(root, "project"), PM_GLOBAL_PATH: globalPath,
      PM_TELEMETRY_PROMPT: "0", SENTRY_TRACES_SAMPLE_RATE: "1",
      SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
    }, overrides);
    const result = await execute(process.execPath, [cli, "--no-extensions", "contracts", "--summary", "--json"], { cwd: root, env, timeout: 15_000 });
    expect(JSON.parse(result.stdout)).toHaveProperty("commands");
    const sentryEnvelopes = envelopes.filter((envelope) => envelope.includes('"sdk":{"name":"sentry.'));
    const exported = sentryEnvelopes.join("\n");
    if (expected) {
      const spans = sentryEnvelopes.flatMap((envelope) => envelope.split("\n").map((line) => JSON.parse(line))).filter((payload) => payload.version === 2).flatMap((payload) => payload.items);
      expect(spans).toEqual([expect.objectContaining({
        name: "pm contracts", status: "ok",
        attributes: expect.objectContaining({
          "pm.command_ok": { value: "true", type: "string" },
          "pm.command_root": { value: "contracts", type: "string" },
        }),
      })]);
      expect(exported).not.toContain(root);
    } else {
      expect(sentryEnvelopes).toEqual([]);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
