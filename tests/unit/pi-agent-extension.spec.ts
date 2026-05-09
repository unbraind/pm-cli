import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PM_TOOL_ACTIONS, PM_TOOL_PARAMETERS_SCHEMA } from "../../src/sdk/cli-contracts.js";
import { nativeCommandOptions, nativeGlobalOptions, runNativePmAction } from "../../src/pi/native.js";

describe("Pi native pm package integration", () => {
  it("publishes a Pi-compatible action schema", () => {
    expect(PM_TOOL_ACTIONS).toContain("context");
    expect(PM_TOOL_ACTIONS).toContain("start-task");
    expect(PM_TOOL_ACTIONS).toContain("close-task");
    expect(PM_TOOL_PARAMETERS_SCHEMA).toMatchObject({ oneOf: expect.any(Array) });
    expect(JSON.stringify(PM_TOOL_PARAMETERS_SCHEMA)).toContain('"const":"context"');
  });

  it("normalizes global and command options without CLI argv construction", () => {
    expect(nativeGlobalOptions({ path: "/tmp/pm", quiet: true, noPager: true })).toMatchObject({
      json: true,
      quiet: true,
      noPager: true,
      path: "/tmp/pm",
    });
    expect(nativeCommandOptions({ action: "context", limit: 5, author: "pi-agent", options: { depth: "standard" } })).toMatchObject({
      limit: 5,
      author: "pi-agent",
      depth: "standard",
    });
  });

  it("runs core pm operations natively against a sandbox", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pm-pi-native-"));
    try {
      const pmPath = path.join(tmp, "pm");
      const init = await runNativePmAction({ action: "init", path: pmPath, prefix: "pm" });
      expect(init).toMatchObject({ ok: true });

      const context = await runNativePmAction({ action: "context", path: pmPath, limit: 1 });
      expect(context).toMatchObject({ summary: expect.any(Object) });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
