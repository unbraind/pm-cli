import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const marker = "<synthetic-quoted-private-marker>";
/** Independent diagnostic inputs shared by hook and real transport assertions. */
export const DIAGNOSTIC_PRIVACY_CASES = [
  { id: "json-key", input: JSON.stringify({ password: marker }) },
  { id: "single-key", input: `{'token':'${marker}'}` },
  { id: "whitespace", input: `prefix { "PASSWORD" \n : "${marker}" } suffix` },
  { id: "compound-key", input: JSON.stringify({ client_secret: marker, label: "ordinary" }) },
  { id: "unicode-key", input: `{ "\\u0070ass\\u0077ord": "${marker}" }` },
  { id: "unicode-api-key", input: `{ "api\\u005fkey": "${marker}" }` },
  { id: "serialized-json", input: JSON.stringify(JSON.stringify({ password: marker })) },
  { id: "twice-serialized-json", input: JSON.stringify(JSON.stringify(JSON.stringify({ token: marker }))) },
  { id: "unicode-delimiters", input: JSON.stringify(JSON.stringify({ password: marker })).replaceAll(String.raw`\"`, String.raw`\u0022`) },
  { id: "nested-unicode-delimiters", input: JSON.stringify(JSON.stringify(JSON.stringify({ token: marker })).replaceAll(String.raw`\"`, String.raw`\u0022`)) },
  { id: "unicode-single-delimiters", input: `prefix \\u0027secret\\u0027: \\u0027${marker}\\u0027 suffix` },
  { id: "escaped-value", input: JSON.stringify({ password: `${marker} "quoted" tail` }) },
  { id: "escaped-key-suffix", input: JSON.stringify({ "password\\": marker }) },
  { id: "serialized-value-suffix", input: JSON.stringify(JSON.stringify({ password: `${marker}\\`, label: "ordinary" })) },
  { id: "nested-object", input: JSON.stringify({ secret: { first: marker, second: "private tail", children: [marker, [marker]] }, label: "ordinary" }) },
  { id: "nested-array", input: JSON.stringify({ token: [marker, { extra: "private tail" }], count: 7 }) },
  { id: "incomplete-value", input: `diagnostic {"password":"${marker} unfinished` },
  { id: "incomplete-container", input: `diagnostic {"secret": {"first": "${marker}", "tail": "private tail"` },
  { id: "mismatched-container", input: `diagnostic {"secret": ["${marker}"} suffix` },
  { id: "unicode-separator", input: JSON.stringify(JSON.stringify({ password: marker })).replaceAll(":", String.raw`\u003a`) },
  { id: "unicode-whitespace", input: String.raw`{"password"\u0020:\u0020"${marker}"}` },
  { id: "unicode-container", input: String.raw`{"secret": \u007b"first": "${marker}", "tail":"private tail"\u007d}` },
  { id: "unicode-array", input: String.raw`{"secret": \u005b"${marker}", {"tail":"private tail"}\u005d}` },
  { id: "nested-key-escape", input: String.raw`{"pass\u005cu0077ord":"${marker}"}` },
  { id: "opaque-separator", input: String.raw`{"password"\u005cu003a"${marker}"}` },
  { id: "ordinary-assignment", input: `password=${marker} outcome=ok` },
  { id: "quoted-assignment", input: `access_token='${marker} with spaces' outcome=ok` },
  { id: "safe-json", input: '{"count":7,"enabled":false,"label":"ordinary fixture"}', safe: true },
  { id: "safe-text", input: "ordinary fixture count=7 enabled=false relative/file.txt", safe: true },
  { id: "safe-quoted-text", input: JSON.stringify({ label: 'ordinary "quoted" text' }), safe: true },
  { id: "empty-value", input: '{"password": ', safe: true },
  { id: "safe-unicode-text", input: '{"u0070assword":"ordinary"} u0022 label={u0022: 7}', safe: true },
  { id: "safe-backslashes", input: `ordinary ${"\\".repeat(100_000)}`, safe: true, resource_control: true },
];
/** Required case identities checked by installed-consumer and exact-tarball acceptance. */
export const DIAGNOSTIC_PRIVACY_REQUIRED_CASE_IDS = DIAGNOSTIC_PRIVACY_CASES.map(({ id }) => id);

/** Resolve the installed public export, rather than reaching into an internal source module. */
function resolveSdk(root) {
  return createRequire(path.join(root, "package.json")).resolve("@unbrained/pm-cli/sdk");
}

/** Exercise real Sentry hooks and serialization using only synthetic, isolated input. */
async function emitDiagnostics(root) {
  const { ensureSentryCommandTracing, ensureSentryInit } = await import(pathToFileURL(resolveSdk(root)).href);
  assert.equal(await ensureSentryCommandTracing(true), true);
  const sentry = await ensureSentryInit();
  const scope = sentry.getCurrentScope();
  scope.setAttributes({ counter: 7, enabled: false });
  for (const entry of DIAGNOSTIC_PRIVACY_CASES) {
    sentry.withScope((local) => {
      local.setTag("privacy_case", entry.id);
      local.setAttribute("scope_detail", entry.input);
      sentry.captureMessage(entry.input);
      sentry.logger.info(entry.input, { privacy_case: entry.id, detail: entry.input });
      sentry.startSpan({ name: entry.input, attributes: { privacy_case: entry.id, detail: entry.input } }, () => undefined);
      assert.equal(local.getScopeData().attributes.scope_detail, entry.input, "Scrubbing changed caller scope");
    });
    assert.equal(await sentry.flush(5000), true, `Diagnostic case did not flush: ${entry.id}`);
  }
  assert.deepEqual(scope.getScopeData().attributes, { counter: 7, enabled: false });
  assert.equal(await sentry.flush(5000), true, "Sentry did not flush the isolated collector");
}

/** Decode actual envelope payloads, including the production transport's gzip encoding. */
function collectPayloads(envelopes) {
  const result = { events: [], logs: [], spans: [] };
  for (const envelope of envelopes) {
    const lines = envelope.split("\n");
    for (let index = 1; index + 1 < lines.length; index += 2) {
      const header = JSON.parse(lines[index]);
      const payload = JSON.parse(lines[index + 1]);
      if (header.type === "event") result.events.push(payload);
      if (header.type === "log") result.logs.push(...payload.items);
      if (header.type === "span") result.spans.push(...payload.items);
    }
  }
  return result;
}

/** Fail on missing cases or leaked markers at the real serialized transport boundary. */
export async function runDiagnosticPrivacyConsumer(root) {
  const envelopes = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    envelopes.push((request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
    response.writeHead(200).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${server.address().port}/1`, SENTRY_TRACES_SAMPLE_RATE: "1", PM_SENTRY_TRACE_COMMANDS: "1" };
    for (const key of ["VITEST", "VITEST_WORKER_ID", "NODE_ENV", "PM_SENTRY_DISABLED", "PM_TELEMETRY_DISABLED", "PM_NO_TELEMETRY", "DO_NOT_TRACK"]) delete env[key];
    await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--emit", root], { env, timeout: 20_000 });
    const { events, logs, spans } = collectPayloads(envelopes);
    for (const entry of DIAGNOSTIC_PRIVACY_CASES) {
      const event = events.filter((row) => row.tags?.privacy_case === entry.id);
      const log = logs.filter((row) => row.attributes?.privacy_case?.value === entry.id);
      const span = spans.filter((row) => row.attributes?.privacy_case?.value === entry.id);
      assert.equal(event.length, 1, `Missing event: ${entry.id}`);
      assert.equal(log.length, 1, `Missing log: ${entry.id}`);
      assert.equal(span.length, 1, `Missing span: ${entry.id}`);
      const serialized = JSON.stringify({ event, log, span });
      if (entry.resource_control) {
        // Sentry retains its own event/string size caps after our privacy hooks.
        for (const text of [event[0].message, log[0].body, span[0].name]) assert(text.startsWith("ordinary "));
      } else if (entry.safe) {
        assert.equal(event[0].message, entry.input);
        assert.equal(log[0].body, entry.input);
        assert.equal(span[0].name, entry.input);
      } else {
        assert(!serialized.includes(marker), `Sensitive marker exported: ${entry.id}`);
        assert(!serialized.includes("private tail"), `Sensitive container suffix exported: ${entry.id}`);
        assert(serialized.includes("[scrubbed]"), `Missing redaction: ${entry.id}`);
      }
      assert.deepEqual(log[0].attributes.counter, { type: "integer", value: 7 });
      assert.deepEqual(log[0].attributes.enabled, { type: "boolean", value: false });
    }
    return { ok: true, case_count: DIAGNOSTIC_PRIVACY_CASES.length, executed_cases: DIAGNOSTIC_PRIVACY_REQUIRED_CASE_IDS, sdk_export: path.relative(root, resolveSdk(root)), fixture_sha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex") };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--emit") await emitDiagnostics(path.resolve(process.argv[3]));
  else process.stdout.write(`${JSON.stringify(await runDiagnosticPrivacyConsumer(path.resolve(process.argv[2])))}\n`);
}
