import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_PRIVACY_CASES } from "../../../fixtures/telemetry/diagnostic-privacy.mjs";

// Covers the residual branches in src/core/sentry/instrument.ts that the broad
// sentry-helpers suite leaves uncovered:
//  - isSentryDisabled via PM_TELEMETRY_DISABLED (line 7)
//  - the non-VITEST early-return path of isSentryDisabled (line 8 / 9)
//  - scrubStackFrame post_context entries that are NOT strings (line 111)
//  - resolveCliVersion falling back to "0.0.0" when version resolution is null (line 188)

const sentryNodeMock = vi.hoisted(() => {
  const on = vi.fn();
  return {
  init: vi.fn(),
  setTags: vi.fn(),
  setAttribute: vi.fn(),
  on,
  getClient: vi.fn<() => { on: typeof on } | undefined>(() => ({ on })),
  withStreamedSpan: vi.fn((callback: unknown) => callback),
  extraErrorDataIntegration: vi.fn((options: unknown) => ({ name: "extraErrorDataIntegration", options })),
  captureConsoleIntegration: vi.fn((options: unknown) => ({ name: "captureConsoleIntegration", options })),
}; });

const rootMock = vi.hoisted(() => ({
  resolvePmCliVersion: vi.fn<() => string | null>(() => null),
}));

vi.mock("../../../../src/core/packages/root.js", () => rootMock);

import { _testOnly, ensureSentryInit, ensureSentryCommandTracing, getSentry } from "../../../../src/core/sentry/instrument.js";

const {
  scrubEventData,
  resetSentryStateForTests,
  setSentryLoaderForTests,
} = _testOnly;
let sentryLoaderMock: ReturnType<typeof vi.fn>;

function requireSentryInitOptions<T>(): T {
  const options = sentryNodeMock.init.mock.calls[0]?.[0];
  if (options === undefined) {
    throw new Error("Expected Sentry.init to receive options");
  }
  return options as T;
}

describe("instrument residual branches", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PM_SENTRY_DISABLED;
    delete process.env.PM_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.CI;
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.NODE_ENV;
    delete process.env.PM_SENTRY_TRACE_COMMANDS;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    resetSentryStateForTests();
    sentryLoaderMock = vi.fn(() => sentryNodeMock as never);
    setSentryLoaderForTests(sentryLoaderMock as never);
    sentryNodeMock.init.mockClear();
    sentryNodeMock.on.mockClear();
    sentryNodeMock.getClient.mockReset().mockReturnValue({ on: sentryNodeMock.on });
    rootMock.resolvePmCliVersion.mockReset();
    rootMock.resolvePmCliVersion.mockReturnValue(null);
  });

  it("uses event source attribution after initialization and preserves explicit environments", async () => {
    process.env.PM_TELEMETRY_SOURCE_CONTEXT = "user";
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
      beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown>;
      beforeSendLog: (log: Record<string, unknown>) => { attributes: Record<string, unknown> };
    }>();
    const envelopeHook = sentryNodeMock.on.mock.calls[0]![1] as (envelope: unknown) => void;
    for (const source of ["automation", "test", "dogfood", "user"]) {
      for (const send of [options.beforeSend, options.beforeSendTransaction]) {
        expect(send({ environment: "ci", tags: { "pm.source_context": source } }).environment).toBe(source === "user" ? "production" : source);
      }
      const environment = source === "user" ? "production" : source;
      expect(options.beforeSendLog({ message: "safe", attributes: { "pm.source_context": source, "sentry.environment": "ci" } }).attributes["sentry.environment"]).toBe(environment);
      const log = { body: "safe", attributes: { "pm.source_context": { type: "string", value: source }, "sentry.environment": { type: "string", value: "ci" } } };
      envelopeHook([{}, [[{ type: "log" }, { items: [log] }]]]);
      expect(log.attributes["sentry.environment"].value).toBe(environment);
    }
    process.env.SENTRY_ENVIRONMENT = "preview";
    expect(options.beforeSend({ environment: "preview", tags: { "pm.source_context": "automation" } }).environment).toBe("preview");
    expect(options.beforeSendLog({ message: "safe", attributes: { "pm.source_context": "automation", "sentry.environment": "preview" } }).attributes["sentry.environment"]).toBe("preview");
    const log = { body: "safe", attributes: { "pm.source_context": { type: "string", value: "automation" }, "sentry.environment": { type: "string", value: "preview" } } };
    envelopeHook([{}, [[{ type: "log" }, { items: [log] }]]]);
    expect(log.attributes["sentry.environment"].value).toBe("preview");
  });

  it("validates original expected-error contracts instead of trusting a reported exception name", async () => {
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      beforeSend: (event: Record<string, unknown>, hint: Record<string, unknown>) => Record<string, unknown> | null;
    }>();
    const event = { exception: { values: [{ type: "PmCliError", value: "invalid refusal" }] } };
    expect(options.beforeSend(event, { originalException: Object.assign(new Error("invalid refusal"), { name: "PmCliError" }) })).not.toBeNull();
    expect(options.beforeSend(event, { originalException: Object.assign(new Error("undeclared fault"), { name: "PmCliError", exitCode: 1 }) })).not.toBeNull();
    expect(options.beforeSend(event, { originalException: Object.assign(new Error("expected"), { name: "PmCliError", exitCode: 2, context: { code: "invalid_argument_value" } }) })).toBeNull();
  });

  it("strips producer diagnostics from error-data contexts and extras before an event leaves", async () => {
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      beforeSend: (event: Record<string, unknown>, hint: Record<string, unknown>) => Record<string, unknown> | null;
      beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown>;
    }>();
    const marker = "producer-diagnostic-payload";
    const event = {
      exception: { values: [{ type: "Error", value: "unexpected fault" }] },
      contexts: {
        Error: { context: { code: "probe", details: { marker } } },
        runtime: { name: "node" },
        bare: null,
      },
      extra: {
        error_context: { code: "probe", details: { marker } },
        wrapped: { context: { details: { marker } } },
        // Console capture stores the error itself among the call arguments.
        arguments: [{ name: "Error", message: "unexpected fault", context: { code: "probe", details: { marker } } }],
      },
      breadcrumbs: [{ category: "console", data: { arguments: [{ context: { details: { marker } } }] } }],
    };
    const sent = options.beforeSend(event, { originalException: new Error("unexpected fault") });
    expect(sent).not.toBeNull();
    expect(JSON.stringify(sent)).not.toContain(marker);
    // Serialized copies whose original is unavailable are discarded; our own error_context projection is kept.
    expect(sent).toMatchObject({
      contexts: { Error: {}, runtime: { name: "node" } },
      extra: { error_context: { code: "probe" }, wrapped: { context: {} }, arguments: [] },
      breadcrumbs: [{ data: { arguments: [] } }],
    });
    // A console-captured error whose toJSON already flattened a diagnostic into a top-level primitive is discarded too.
    const consoleCopy = {
      extra: { arguments: [{ name: "Error", context: { report: marker } }] },
      breadcrumbs: [{ category: "console", data: { arguments: [{ context: { report: marker } }] } }],
    };
    expect(JSON.stringify(options.beforeSend(consoleCopy, { originalException: "console" }))).not.toContain(marker);
    // An error's own toJSON can move diagnostics out of every named context slot: complete serialized
    // console arguments are discarded, in extras and in breadcrumbs.
    const argumentCopy = {
      extra: { arguments: [{ report: marker }, "plain text"] },
      breadcrumbs: [{ category: "console", message: "logged", data: { arguments: [{ report: marker }] } }],
    };
    const argumentSent = options.beforeSend(argumentCopy, { originalException: "console" });
    expect(JSON.stringify(argumentSent)).not.toContain(marker);
    expect(argumentSent).toMatchObject({ extra: { arguments: [] }, breadcrumbs: [{ message: "logged", data: { arguments: [] } }] });
    // A toJSON can turn a whole context into a string: the slot is discarded whatever its serialized type.
    const stringCopy = { extra: { arguments: [{ name: "Error", context: marker }] }, breadcrumbs: [{ data: { arguments: [{ context: marker }] } }] };
    expect(JSON.stringify(options.beforeSend(stringCopy, { originalException: "console" }))).not.toContain(marker);
    expect(JSON.stringify(options.beforeSendTransaction({ contexts: { trace: { data: { context: marker } } } }))).not.toContain(marker);
    // Events without contexts or extras pass unchanged.
    expect(options.beforeSend({ message: "plain" }, {})).toMatchObject({ message: "plain" });
    // A context-level toJSON already ran inside the error-data integration and copied diagnostics under
    // another key; the entry is rebuilt from the original exception instead of trusting that copy.
    const original = Object.assign(new Error("serializer fault"), {
      context: { code: "probe", details: { marker }, toJSON() { return { report: { marker } }; } },
    });
    const serialized = {
      exception: { values: [{ type: "Error", value: "serializer fault" }] },
      contexts: { Error: { context: { report: { marker } } }, runtime: { name: "node" }, os: "linux", bare: null },
    };
    const rebuilt = options.beforeSend(serialized, { originalException: original });
    expect(JSON.stringify(rebuilt)).not.toContain(marker);
    expect(rebuilt).toMatchObject({ contexts: { Error: { context: { code: "probe" } }, runtime: { name: "node" }, os: "linux", bare: null } });
    // An error-level toJSON makes the integration emit siblings of context (report): the whole entry is
    // rebuilt from the original, keeping only its own primitive fields and a safe context.
    const errorLevel = Object.assign(new Error("error-level serializer"), {
      exitCode: 70,
      context: { code: "probe", details: { marker } },
      toJSON() { return { report: { marker } }; },
    });
    const sibling = { exception: { values: [{ type: "Error", value: "error-level serializer" }] }, contexts: { Error: { report: { marker } }, runtime: { name: "node" } } };
    const siblingSent = options.beforeSend(sibling, { originalException: errorLevel });
    expect(JSON.stringify(siblingSent)).not.toContain(marker);
    expect(siblingSent).toMatchObject({ contexts: { Error: { exitCode: 70, context: { code: "probe" } }, runtime: { name: "node" } } });
    // An original whose name cannot be read still has its context-carrying entries discarded.
    const namelessOriginal = Object.defineProperty(new Error("nameless"), "name", { get() { throw new Error("name trap"); } });
    expect(JSON.stringify(options.beforeSend({ contexts: { Error: { context: { marker } } } }, { originalException: namelessOriginal }))).not.toContain(marker);
    // Without a usable original, the serialized copy is still reduced to top-level primitives.
    // Each case gets a fresh event: the hook scrubs in place, so a reused event would already be clean.
    const flattened = () => ({ exception: { values: [{ type: "Error", value: "serializer fault" }] }, contexts: { Error: { context: { report: { marker }, code: "probe" } } } });
    expect(JSON.stringify(flattened())).toContain(marker);
    expect(JSON.stringify(options.beforeSend(flattened(), { originalException: "not an object" }))).not.toContain(marker);
    // An original without its own context leaves the entry to the generic scrub.
    expect(JSON.stringify(options.beforeSend(flattened(), { originalException: new Error("no context") }))).not.toContain(marker);
    // An original whose own properties cannot even be described is left to the generic scrub.
    const opaqueOriginal = new Proxy(new Error("opaque fault"), { getOwnPropertyDescriptor: () => { throw new Error("descriptor trap"); } });
    expect(JSON.stringify(options.beforeSend(flattened(), { originalException: opaqueOriginal }))).not.toContain(marker);
    const accessorOriginal = Object.defineProperty(new Error("accessor fault"), "context", { get: () => ({ details: { marker } }) });
    expect(JSON.stringify(options.beforeSend(flattened(), { originalException: accessorOriginal }))).not.toContain(marker);
    const transaction = {
      contexts: { trace: { data: { context: { details: { marker } } } } },
      breadcrumbs: [{ category: "console", message: "safe", data: { arguments: [{ context: { details: { marker } } }] } }],
    };
    expect(JSON.stringify(options.beforeSendTransaction(transaction))).not.toContain(marker);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSentryStateForTests();
    setSentryLoaderForTests();
  });

  it.each(["PM_TELEMETRY_DISABLED", "PM_NO_TELEMETRY", "DO_NOT_TRACK"])("treats %s as an opt-out without importing Sentry", async (key) => {
    process.env[key] = "On";

    await expect(ensureSentryInit()).resolves.toBeUndefined();
    expect(sentryNodeMock.init).not.toHaveBeenCalled();
    expect(sentryLoaderMock).not.toHaveBeenCalled();
  });

  it("loads the installed Sentry CommonJS export through the production loader", () => {
    const loaded = _testOnly.defaultSentryLoader();
    expect(loaded).toMatchObject({ init: expect.any(Function), flush: expect.any(Function) });
  });

  it.each([undefined, "", "0", "false", "invalid"])("keeps successful tracing lazy for opt-in %j", async (value) => {
    if (value !== undefined) process.env.PM_SENTRY_TRACE_COMMANDS = value;
    await ensureSentryCommandTracing(true);
    expect(sentryLoaderMock).not.toHaveBeenCalled();
  });

  it("initializes-successful-command-tracing only on explicit opt-in and honors a zero rate", async () => {
    process.env.PM_SENTRY_TRACE_COMMANDS = "On";
    process.env.SENTRY_TRACES_SAMPLE_RATE = "0";
    await ensureSentryCommandTracing(true);
    expect(sentryLoaderMock).not.toHaveBeenCalled();
    process.env.SENTRY_TRACES_SAMPLE_RATE = "1";
    await ensureSentryCommandTracing(true);
    expect(sentryLoaderMock).toHaveBeenCalledTimes(1);
    expect(requireSentryInitOptions<{ tracesSampleRate: number }>().tracesSampleRate).toBe(1);
  });

  it.each([false, "false", 1, {}, null, undefined])("requires explicit boolean consent instead of %j before successful tracing loads Sentry", async (consent) => {
    process.env.PM_SENTRY_TRACE_COMMANDS = "1";
    await expect(ensureSentryCommandTracing(consent as boolean)).resolves.toBe(false);
    expect(sentryLoaderMock).not.toHaveBeenCalled();
  });

  it.each(["loader", "initializer"])("keeps optional-tracing-initialization-failure from the %s unsuccessful without retries", async (stage) => {
    process.env.PM_SENTRY_TRACE_COMMANDS = "1";
    process.env.SENTRY_TRACES_SAMPLE_RATE = "1";
    const fail = () => { throw new Error("Diagnostic initialization unavailable"); };
    if (stage === "loader") sentryLoaderMock.mockImplementationOnce(fail);
    else sentryNodeMock.init.mockImplementationOnce(fail);

    await expect(ensureSentryCommandTracing(true)).resolves.toBe(false);
    expect(getSentry()).toBeUndefined();
    await expect(ensureSentryCommandTracing(true)).resolves.toBe(false);
    await expect(ensureSentryInit()).resolves.toBeUndefined();
    expect(sentryLoaderMock).toHaveBeenCalledOnce();
    expect(sentryNodeMock.init).toHaveBeenCalledTimes(stage === "loader" ? 0 : 1);
  });

  it("never grants concurrent tracing permission from a partially initialized client", async () => {
    process.env.PM_SENTRY_TRACE_COMMANDS = "1";
    process.env.SENTRY_TRACES_SAMPLE_RATE = "1";
    sentryNodeMock.init.mockImplementationOnce(() => { throw new Error("Diagnostic initialization unavailable"); });
    await expect(Promise.all([ensureSentryCommandTracing(true), ensureSentryCommandTracing(true)])).resolves.toEqual([false, false]);
    expect(getSentry()).toBeUndefined();
    expect(sentryLoaderMock).toHaveBeenCalledOnce();
    expect(sentryNodeMock.init).toHaveBeenCalledOnce();
  });

  it("denies tracing if initialization does not provide a client", async () => {
    process.env.PM_SENTRY_TRACE_COMMANDS = "1";
    sentryNodeMock.getClient.mockReturnValue(undefined);
    await expect(ensureSentryCommandTracing(true)).resolves.toBe(false);
    expect(getSentry()).toBeUndefined();
    await expect(ensureSentryCommandTracing(true)).resolves.toBe(false);
    expect(sentryNodeMock.init).toHaveBeenCalledOnce();
  });

  it("scrubs post-merge serialized log attributes without changing safe typed values", async () => {
    await ensureSentryInit();
    expect(sentryNodeMock.on).toHaveBeenCalledWith("beforeEnvelope", expect.any(Function));
    const hook = sentryNodeMock.on.mock.calls[0]![1] as (envelope: unknown) => void;
    const logs = [
      { body: "password=<private-log-value>", attributes: {
        token: { type: "integer", value: 12345 },
        "sentry.message.parameter.0": { type: "string", value: "private-parameter" },
        details: { type: "string", value: "password=<private-scope-value>" },
        counter: { type: "integer", value: 7 },
        ready: { type: "boolean", value: true },
      } },
      { body: "safe empty log" },
    ];
    const event = { message: "safe event" };
    hook([{}, [[{ type: "log" }, { items: logs }], [{ type: "event" }, event]]]);
    expect(logs[0]).toEqual({ body: "password=[scrubbed]", attributes: {
      token: { type: "string", value: "[scrubbed]" },
      "sentry.message.parameter.0": { type: "string", value: "[scrubbed]" },
      details: { type: "string", value: "password=[scrubbed]" },
      counter: { type: "integer", value: 7 },
      ready: { type: "boolean", value: true },
    } });
    expect(logs[1]).toEqual({ body: "safe empty log" });
    expect(event).toEqual({ message: "safe event" });
  });

  it("scrubs streamed spans and logs at their actual export hooks", async () => {
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      traceLifecycle: string;
      beforeSendSpan: (span: Record<string, unknown>) => Record<string, unknown>;
      beforeSendLog: (log: Record<string, unknown>) => Record<string, unknown>;
    }>();
    expect(options.traceLifecycle).toBe("stream");
    const attributes = { token: "<private-value>", "sentry.status.message": "password=<private-value>", "pm.command": "context", duration: 3 };
    const span = options.beforeSendSpan({ name: "read password=<private-value>", attributes, links: [{
      trace_id: "a".repeat(32), span_id: "b".repeat(16),
      attributes: { token: "<private-value>", label: "safe" },
    }] });
    expect(span).toMatchObject({ name: "read password=[scrubbed]", attributes: { token: "[scrubbed]", "pm.command": "context", duration: 3 } });
    expect(JSON.stringify(span)).not.toContain("private-value");
    expect(span.links).toEqual([{ trace_id: "a".repeat(32), span_id: "b".repeat(16), attributes: { token: "[scrubbed]", label: "safe" } }]);
    expect(options.beforeSendSpan({ name: "safe span" })).toEqual({ name: "safe span" });
    const log = options.beforeSendLog({ message: "error token=private-value", attributes });
    expect(JSON.stringify(log)).not.toContain("private-value");
    expect(options.beforeSendLog({ message: "safe log" })).toEqual({ message: "safe log" });
  });

  it.each([
    ["single", "token='<private value with spaces>' outcome=ok", "token=[scrubbed] outcome=ok"],
    ["double", 'token="<private value with spaces>" outcome=ok', "token=[scrubbed] outcome=ok"],
    ["escaped", String.raw`token="<private \"quote\" value>" outcome=ok`, "token=[scrubbed] outcome=ok"],
    ["escaped trailing slash", String.raw`token="<private value>\\" outcome=ok`, "token=[scrubbed] outcome=ok"],
    ["unicode-looking scalar", "token=u0022<private-value> outcome=ok", "token=[scrubbed] outcome=ok"],
    ["quoted unicode-looking scalar", 'token="u0022 <private value>" outcome=ok', "token=[scrubbed] outcome=ok"],
    ["unicode-looking container", 'token=[u0022, "<private value>"] outcome=ok', "token=[scrubbed] outcome=ok"],
    ["encoded container suffix", String.raw`token=\u007b"label":"<private value>"\u007d outcome=ok`, "token=[scrubbed] outcome=ok"],
    ["nested", "token='<private password=value with spaces>' outcome=ok", "token=[scrubbed] outcome=ok"],
    ["incomplete", 'token="<private value with spaces>', "token=[scrubbed]"],
    ["access token", "access_token=<private-value> outcome=ok", "access_token=[scrubbed] outcome=ok"],
    ["client secret", 'client_secret="<private value with spaces>" outcome=ok', "client_secret=[scrubbed] outcome=ok"],
    ["hyphenated token", "refresh-token='<private value>' outcome=ok", "refresh-token=[scrubbed] outcome=ok"],
  ])("scrubs-complete-quoted-values using %s at span and log export", async (_name, value, expected) => {
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      beforeSendSpan: (span: Record<string, unknown>) => Record<string, unknown>;
      beforeSendLog: (log: Record<string, unknown>) => Record<string, unknown>;
    }>();
    expect(options.beforeSendSpan({ name: value, attributes: { detail: value }, links: [{ attributes: { detail: value } }] })).toEqual({
      name: expected, attributes: { detail: expected }, links: [{ attributes: { detail: expected } }],
    });
    expect(options.beforeSendLog({ message: value, attributes: { detail: value } })).toEqual({ message: expected, attributes: { detail: expected } });
  });

  it.each(DIAGNOSTIC_PRIVACY_CASES)("redacts quoted-key diagnostic case $id at every active export hook", async ({ input, safe }) => {
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
      beforeSendSpan: (span: Record<string, unknown>) => Record<string, unknown>;
      beforeSendLog: (log: Record<string, unknown>) => Record<string, unknown>;
    }>();
    const logs = [{ body: input, attributes: { detail: { type: "string", value: input }, counter: { type: "integer", value: 7 }, enabled: { type: "boolean", value: false } } }];
    const envelopeHook = sentryNodeMock.on.mock.calls[0]![1] as (envelope: unknown) => void;
    envelopeHook([{}, [[{ type: "log" }, { items: logs }]]]);
    const outputs = [
      options.beforeSend({ message: input, extra: { detail: input }, breadcrumbs: [{ message: input }] }),
      options.beforeSendSpan({ name: input, attributes: { detail: input }, links: [{ attributes: { detail: input } }] }),
      options.beforeSendLog({ message: input, attributes: { detail: input } }),
      logs[0],
    ];
    if (safe) {
      expect(outputs[0]!.message).toBe(input);
      expect(outputs[1]!.name).toBe(input);
      expect(outputs[2]!.message).toBe(input);
      expect(logs[0]!.body).toBe(input);
    } else for (const output of outputs) {
      expect(JSON.stringify(output)).not.toContain("<synthetic-quoted-private-marker>");
      expect(JSON.stringify(output)).not.toContain("private tail");
      expect(JSON.stringify(output)).toContain("[scrubbed]");
    }
    expect(logs[0]!.attributes.counter).toEqual({ type: "integer", value: 7 });
    expect(logs[0]!.attributes.enabled).toEqual({ type: "boolean", value: false });
  });

  it.each([
    ["missing opt-in", "PM_SENTRY_TRACE_COMMANDS", "0"],
    ["zero rate", "SENTRY_TRACES_SAMPLE_RATE", "0"],
    ["hard opt-out", "DO_NOT_TRACK", "1"],
  ])("refuses tracing permission for %s even with an existing client", async (_name, key, value) => {
    process.env.PM_SENTRY_TRACE_COMMANDS = "1";
    await expect(ensureSentryCommandTracing(true)).resolves.toBe(true);
    process.env[key] = value;
    await expect(ensureSentryCommandTracing(true)).resolves.toBe(false);
    expect(sentryLoaderMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a prior process initialization refusal unsuccessful", async () => {
    process.env.PM_SENTRY_DISABLED = "1";
    await expect(ensureSentryInit()).resolves.toBeUndefined();
    delete process.env.PM_SENTRY_DISABLED;
    process.env.PM_SENTRY_TRACE_COMMANDS = "1";
    await expect(ensureSentryCommandTracing(true)).resolves.toBe(false);
    expect(sentryLoaderMock).not.toHaveBeenCalled();
  });

  it.each([
    ["VITEST", "7"],
    ["VITEST_WORKER_ID", "7"],
    ["VITEST", ""],
    ["VITEST_WORKER_ID", ""],
  ])("keeps Sentry disabled under %s=%j even when telemetry test events are allowed", async (key, value) => {
    process.env.PM_TELEMETRY_SEND_TEST_EVENTS = "1";
    process.env[key] = value;

    process.env.PM_SENTRY_TRACE_COMMANDS = "1";
    await ensureSentryCommandTracing(true);
    await expect(ensureSentryInit()).resolves.toBeUndefined();
    expect(sentryNodeMock.init).not.toHaveBeenCalled();
    expect(sentryLoaderMock).not.toHaveBeenCalled();
  });

  it("falls back to 0.0.0 release when the CLI version cannot be resolved", async () => {
    rootMock.resolvePmCliVersion.mockReturnValue(null);

    await ensureSentryInit();

    expect(rootMock.resolvePmCliVersion).toHaveBeenCalled();
    const options = requireSentryInitOptions<{
      release: string;
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
    }>();
    expect(options.release).toBe("pm-cli@0.0.0");

    // Drive scrubStackFrame with a post_context array that mixes strings and
    // non-strings so the non-string ternary branch (line 111) is exercised.
    const event = options.beforeSend({
      exception: {
        values: [
          {
            value: "boom",
            stacktrace: {
              frames: [
                {
                  filename: "/home/example/dist/index.js",
                  post_context: ["at /home/example/src/a.ts:1:2", 42, null],
                },
              ],
            },
          },
        ],
      },
    }) as { exception: { values: Array<{ stacktrace: { frames: Array<{ post_context: unknown[] }> } }> } };

    const frame = event.exception.values[0].stacktrace.frames[0];
    expect(frame.post_context).toEqual(["at [scrubbed_path]", 42, null]);
  });

  it("keeps scrubEventData stable for primitive leaf values", () => {
    expect(scrubEventData({ count: 3, flag: false, missing: null })).toEqual({
      count: 3,
      flag: false,
      missing: null,
    });
  });

  it("leaves message-less / data-less breadcrumbs and falsy contexts untouched in the transaction and breadcrumb hooks", async () => {
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      beforeSendTransaction: (event: Record<string, unknown>) => Record<string, unknown>;
      beforeBreadcrumb: (breadcrumb: Record<string, unknown>) => Record<string, unknown> | null;
    }>();

    // beforeSendTransaction: a surviving breadcrumb with neither message nor
    // data (skips both the message-scrub and data-scrub branches), plus a
    // contexts map carrying a falsy/non-object entry (skips the ctx scrub).
    const transaction = options.beforeSendTransaction({
      breadcrumbs: [{ category: "navigation" }],
      contexts: { empty: null },
    });
    expect(transaction.breadcrumbs).toEqual([{ category: "navigation" }]);
    expect(transaction.contexts).toEqual({ empty: null });

    // beforeBreadcrumb: a breadcrumb with no message and no data exercises the
    // else (fall-through) of both inner guards while still returning the crumb.
    const breadcrumb = options.beforeBreadcrumb({ category: "navigation" });
    expect(breadcrumb).toEqual({ category: "navigation" });

    // beforeSendTransaction / beforeBreadcrumb with NO breadcrumbs and NO
    // contexts skip those whole guarded blocks (the falsy-event branches).
    const emptyTransaction = options.beforeSendTransaction({ type: "transaction" });
    expect(emptyTransaction).toEqual({ type: "transaction" });
  });

  it("leaves message-less / data-less breadcrumbs and falsy contexts untouched in beforeSend", async () => {
    await ensureSentryInit();
    const options = requireSentryInitOptions<{
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
    }>();

    // beforeSend breadcrumb loop: a breadcrumb with neither message nor data
    // (skips both inner scrubs) plus an event.contexts map with a falsy entry
    // (skips the ctx scrub) and an exception value-less / frame-less shape.
    const event = options.beforeSend({
      breadcrumbs: [{ category: "navigation" }],
      contexts: { empty: null },
      exception: { values: [{ type: "Error", stacktrace: {} }] },
    });
    expect(event).toMatchObject({
      breadcrumbs: [{ category: "navigation" }],
      contexts: { empty: null },
    });

    // An event with no exception at all skips the exception-values loop (the
    // else of `if (event.exception?.values)`).
    const noException = options.beforeSend({ message: "plain message" });
    expect(noException).toMatchObject({ message: "plain message" });
  });

  it("short-circuits a repeated init call and returns the cached Sentry module", async () => {
    const first = await ensureSentryInit();
    sentryNodeMock.init.mockClear();
    // Second call hits the `_initDone` guard and returns the cached module
    // without re-importing or re-initializing.
    const second = await ensureSentryInit();
    expect(second).toBe(first);
    expect(sentryLoaderMock).toHaveBeenCalledTimes(1);
    expect(sentryNodeMock.init).not.toHaveBeenCalled();
  });
});
