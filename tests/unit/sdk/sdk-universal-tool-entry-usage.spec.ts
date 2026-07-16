import { afterAll, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = ["node", "entry.ts"];
  process.exitCode = undefined;
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  return { argv, exitCode, stderr };
});

import "../../../docs/examples/sdk-custom-tool/src/entry.js";

afterAll(() => {
  state.stderr.mockRestore();
  process.argv = state.argv;
  process.exitCode = state.exitCode;
});

it("runs the SDK exemplar executable usage path", () => {
  expect(process.exitCode).toBe(2);
  expect(state.stderr).toHaveBeenCalledWith("Usage: pm-custom <workspace>\n");
});
