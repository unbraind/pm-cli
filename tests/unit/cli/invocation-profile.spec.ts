import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { registerInvocationProfile } from "../../../src/cli/invocation-profile.js";

describe("process profile lifecycle", () => {
  it("emits once after drain, honors terminators, and disposes pending listeners", () => {
    const host = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      uptime: process.uptime,
    });
    let output = "";
    host.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const dispose = registerInvocationProfile(["--profile", "list"], host);
    expect(output).toBe("");
    host.emit("beforeExit");
    host.emit("beforeExit");
    expect(output.match(/profile:invocation/gu)).toHaveLength(1);
    expect(output).toMatch(
      /total_ms=\d+\.\d{3} scope=process_start_to_output_drain/,
    );
    dispose();
    const cancel = registerInvocationProfile(["--profile", "--", "list"], host);
    cancel();
    registerInvocationProfile(["list", "--", "--profile"], host)();
    registerInvocationProfile(["list"], host)();
    host.emit("beforeExit");
    expect(output.match(/profile:invocation/gu)).toHaveLength(1);
    registerInvocationProfile([])();
  });
});
