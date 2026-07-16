import { afterAll, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const workspace = `/tmp/pm-sdk-custom-entry-${process.pid}-${Date.now()}`;
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    `${workspace}/README.md`,
    "# Executable workspace\n",
    "utf8",
  );
  const argv = process.argv;
  const exitCode = process.exitCode;
  const author = process.env.PM_AUTHOR;
  process.argv = ["node", "entry.ts", workspace];
  process.exitCode = undefined;
  process.env.PM_AUTHOR = "sdk-entry-test";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  return { workspace, argv, exitCode, author, stdout };
});

import "../../../docs/examples/sdk-custom-tool/src/entry.js";

afterAll(() => {
  state.stdout.mockRestore();
  process.argv = state.argv;
  process.exitCode = state.exitCode;
  if (state.author === undefined) delete process.env.PM_AUTHOR;
  else process.env.PM_AUTHOR = state.author;
  process
    .getBuiltinModule("node:fs")
    .rmSync(state.workspace, { recursive: true, force: true });
});

it("runs the SDK exemplar executable success path", () => {
  expect(process.exitCode).toBe(0);
  expect(JSON.parse(String(state.stdout.mock.calls[0]?.[0]))).toMatchObject({
    customType: "Deliverable",
    customStatus: "reviewing",
    projectStatus: "closed",
    claimedBy: "sdk-entry-test",
    healthOk: true,
    historyDriftOk: true,
  });
});
