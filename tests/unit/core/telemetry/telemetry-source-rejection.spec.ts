import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { _testOnly } from "../../../../src/core/telemetry/runtime.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("honors explicit quiet output for a rejected override", () => {
  vi.stubEnv("PM_TELEMETRY_SOURCE_CONTEXT", "private-project-value");
  const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(_testOnly.resolveTelemetrySourceContext({ quiet: true }).source_context_source).toBe("env_override_rejected");
  expect(warning).not.toHaveBeenCalled();
});

it("warns on stderr while preserving a real CLI JSON result", async () => {
  const cli = path.resolve("dist/cli.js");
  await withTempGlobalRoot("pm-source-json-", async (root) => {
    const env = {
      ...process.env, PM_PATH: path.join(root, ".agents", "pm"), PM_GLOBAL_PATH: root,
      PM_SENTRY_DISABLED: "1", PM_AGENT_PROBES: "0", DO_NOT_TRACK: "0", PM_NO_TELEMETRY: "0",
      PM_TELEMETRY_SEND_TEST_EVENTS: "1", PM_TELEMETRY_OTEL_DISABLED: "1",
      PM_TELEMETRY_INLINE_FLUSH: "1", PM_TELEMETRY_INGEST_KEY: "",
      PM_TELEMETRY_SOURCE_CONTEXT: "private-project-value",
    };
    const settings = await readSettings(root);
    settings.telemetry.enabled = true;
    settings.telemetry.endpoint = "";
    await writeSettings(root, settings, "test:local-capture");
    await promisify(execFile)(process.execPath, [cli, "init", "source-warning", "--yes", "--no-merge-fence", "--json", "--no-extensions"], { cwd: root, env: { ...env, PM_TELEMETRY_DISABLED: "1" } });
    const result = await promisify(execFile)(process.execPath, [cli, "list", "--json", "--no-extensions"], { cwd: root, env: { ...env, PM_TELEMETRY_DISABLED: "0" } });
    expect(JSON.parse(result.stdout)).toMatchObject({ count: 0 });
    expect(result.stderr.trim().split("\n")).toEqual(["[pm] warning: PM_TELEMETRY_SOURCE_CONTEXT is not one of user|automation|test|dogfood; ignoring override."]);
    expect(result.stderr).not.toContain("private-project-value");
  });
});

it("distinguishes rejected source attribution without disclosing the attempted value", () => {
  vi.stubEnv("PM_TELEMETRY_SOURCE_CONTEXT", "private-project-value");
  const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(_testOnly.resolveTelemetrySourceContext({}).source_context_source).toBe("env_override_rejected");
  expect(_testOnly.resolveTelemetrySourceContext({}).source_context_source).toBe("env_override_rejected");
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0]?.[0]).toContain("user|automation|test|dogfood");
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private-project-value");
});
