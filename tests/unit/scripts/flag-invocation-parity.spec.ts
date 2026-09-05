import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  buildCoreCommandProgram,
  main,
  observeCommandOptions,
  observeCommanderOption,
  runIfMain,
  verifyCoreFlagInvocationParity,
} from "../../../scripts/release/flag-invocation-parity.mjs";

describe("flag invocation parity gate", () => {
  it("constructs the complete core command surface", () => {
    const program = buildCoreCommandProgram();
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["context", "create", "init", "test"]),
    );
    expect(program.commands.length).toBeGreaterThan(60);
  });

  it("observes required, optional, boolean, and variadic Commander arity", () => {
    expect(
      observeCommanderOption("sample", {
        long: "--value",
        required: true,
        optional: false,
        variadic: false,
      }),
    ).toEqual({
      command: "sample",
      flag: "--value",
      takes_value: true,
      value_required: true,
      repeatable: false,
    });
    expect(
      observeCommandOptions(
        { options: [{ long: undefined }] },
        {
          name: () => "sample",
          options: [
            {
              long: "--optional",
              required: false,
              optional: true,
              variadic: true,
            },
          ],
        },
      ),
    ).toEqual([
      {
        command: "sample",
        flag: "--optional",
        takes_value: true,
        value_required: false,
        repeatable: true,
      },
    ]);
  });

  it("preserves conflicting root and command registrations for parity validation", () => {
    expect(
      observeCommandOptions(
        {
          options: [
            {
              long: "--shared",
              required: true,
              optional: false,
              variadic: false,
            },
          ],
        },
        {
          name: () => "sample",
          options: [
            {
              long: "--shared",
              required: false,
              optional: false,
              variadic: false,
            },
          ],
        },
      ),
    ).toEqual([
      {
        command: "sample",
        flag: "--shared",
        takes_value: true,
        value_required: true,
        repeatable: false,
      },
      {
        command: "sample",
        flag: "--shared",
        takes_value: false,
        value_required: false,
        repeatable: false,
      },
    ]);
  });

  it("passes the live corpus and blocks a seeded arity mismatch", () => {
    expect(verifyCoreFlagInvocationParity()).toMatchObject({
      ok: true,
      command_count: expect.any(Number),
    });
    expect(verifyCoreFlagInvocationParity({ injectMismatch: true })).toEqual(
      expect.objectContaining({
        ok: false,
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: "takes_value_mismatch",
            command: "init",
            flag: "--defaults",
          }),
        ]),
      }),
    );
  });

  it("rejects undeclared executable options and commands instead of dropping them", () => {
    const program = buildCoreCommandProgram();
    program.commands.find((command) => command.name() === "init")
      .option("--undeclared-probe <value>");
    program.command("undeclared-command");
    expect(verifyCoreFlagInvocationParity({ program })).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "undeclared_observation", command: "init", flag: "--undeclared-probe" }),
        expect.objectContaining({ code: "missing_command_contract", command: "undeclared-command" }),
      ]),
    });
  });

  it("reports standalone success and negative-control exit status", () => {
    const originalExitCode = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      process.exitCode = undefined;
      runIfMain("");
      runIfMain(
        fileURLToPath(
          new URL(
            "../../../scripts/release/flag-invocation-parity.mjs",
            import.meta.url,
          ),
        ),
      );
      expect(process.exitCode).toBeUndefined();
      expect(main(["--inject-mismatch"])).toMatchObject({ ok: false });
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});
