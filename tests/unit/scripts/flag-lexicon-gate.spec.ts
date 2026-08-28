import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  main,
  measureCoreFlagHelpInventory,
  readFlagSpellingBaseline,
  runIfMain,
  verifyFlagLexiconGate,
} from "../../../scripts/release/flag-lexicon-gate.mjs";

describe("flag lexicon gate", () => {
  it("passes the generated corpus and blocks seeded command growth", () => {
    expect(verifyFlagLexiconGate()).toMatchObject({
      ok: true,
      baseline_entry_count: 3_053,
      findings: [],
    });
    expect(verifyFlagLexiconGate({ injectMismatch: true })).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ code: "budget_exceeded" })],
    });
  });

  it("blocks removal from the persisted compatibility inventory", () => {
    expect(
      verifyFlagLexiconGate({
        baseline: {
          version: 1,
          entries: [
            {
              command: "context",
              canonical_flag: "--removed",
              accepted_spellings: ["--removed"],
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: false,
      findings: [
        expect.objectContaining({ code: "removed_canonical_spelling" }),
      ],
    });
  });

  it("fails closed for missing and over-budget generated help surfaces", () => {
    const report = verifyFlagLexiconGate({
      helpBaseline: {
        version: 7,
        entries: [
          {
            command: "removed",
            estimated_tokens: 4,
            maximum_tokens: 4,
          },
          {
            command: "removed",
            estimated_tokens: 2,
            maximum_tokens: 2,
          },
          { command: "list", estimated_tokens: 1, maximum_tokens: 1 },
        ],
      },
      helpInventory: [
        {
          command: "list",
          help_bytes: 8,
          estimated_tokens: 2,
          maximum_tokens: 2,
        },
        {
          command: "new-command",
          help_bytes: 4,
          estimated_tokens: 1,
          maximum_tokens: 1,
        },
      ],
    });
    expect(report).toMatchObject({
      ok: false,
      help_baseline_version: 7,
      help_token_delta_total: -5,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "missing_help_command" }),
        expect.objectContaining({ code: "help_token_budget_exceeded" }),
        expect.objectContaining({ code: "missing_help_token_baseline" }),
      ]),
    });
    expect(
      measureCoreFlagHelpInventory({
        budgets: [{ command: "not-registered" }],
      }),
    ).toEqual([]);
  });

  it("supports explicit baseline reads and writes for reproducible updates", () => {
    const write = vi.fn();
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      expect(readFlagSpellingBaseline()).toMatchObject({ version: 1 });
      expect(
        main(["--update-inventory"], {
          write,
          spellingBaselinePath: "/tmp/spellings.json",
          helpBaselinePath: "/tmp/help.json",
        }),
      ).toMatchObject({ ok: true });
    } finally {
      output.mockRestore();
    }
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(
      1,
      "/tmp/spellings.json",
      expect.stringContaining('"version": 1'),
      "utf8",
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      "/tmp/help.json",
      expect.stringContaining('"version": 1'),
      "utf8",
    );
  });

  it("verifies configured baseline paths instead of repository defaults", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-flag-baselines-"));
    const spellingBaselinePath = path.join(root, "spellings.json");
    const helpBaselinePath = path.join(root, "help.json");
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      writeFileSync(
        spellingBaselinePath,
        JSON.stringify({
          version: 1,
          entries: [
            {
              command: "context",
              canonical_flag: "--removed",
              accepted_spellings: ["--removed"],
            },
          ],
        }),
      );
      writeFileSync(
        helpBaselinePath,
        JSON.stringify({ version: 1, entries: [] }),
      );
      expect(
        main([], { spellingBaselinePath, helpBaselinePath }),
      ).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "removed_canonical_spelling" }),
          expect.objectContaining({ code: "missing_help_token_baseline" }),
        ]),
      });
    } finally {
      output.mockRestore();
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports standalone success and negative-control exit status", () => {
    const originalExitCode = process.exitCode;
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      process.exitCode = undefined;
      runIfMain("");
      runIfMain(
        fileURLToPath(
          new URL(
            "../../../scripts/release/flag-lexicon-gate.mjs",
            import.meta.url,
          ),
        ),
        [],
      );
      expect(process.exitCode).toBeUndefined();
      expect(main(["--inject-mismatch"])).toMatchObject({ ok: false });
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it("forwards standalone inventory-update arguments", () => {
    const write = vi.fn();
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      runIfMain(
        fileURLToPath(
          new URL(
            "../../../scripts/release/flag-lexicon-gate.mjs",
            import.meta.url,
          ),
        ),
        ["--update-inventory"],
        {
          write,
          spellingBaselinePath: "/tmp/standalone-spellings.json",
          helpBaselinePath: "/tmp/standalone-help.json",
        },
      );
    } finally {
      output.mockRestore();
    }
    expect(write).toHaveBeenCalledTimes(2);
  });
});
