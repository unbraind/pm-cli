import { afterAll, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = ["node", "entry.ts"];
  process.exitCode = undefined;
  // The entry writes while it is imported; Vitest 5 clears mock calls before each test, so keep the writes in a plain array.
  const writes: string[] = [];
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((value) => {
      writes.push(String(value));
      return true;
    });
  return { argv, exitCode, stderr, writes };
});

import "../../../docs/examples/sdk-custom-tool/src/entry.js";

afterAll(() => {
  state.stderr.mockRestore();
  process.argv = state.argv;
  process.exitCode = state.exitCode;
});

it("runs the SDK exemplar executable usage path", () => {
  expect(process.exitCode).toBe(2);
  expect(state.writes).toEqual(["Usage: pm-custom <workspace>\n"]);
});
