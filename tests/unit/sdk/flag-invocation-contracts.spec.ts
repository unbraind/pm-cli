import { describe, expect, it } from "vitest";
import {
  enrichCliFlagInvocationContract,
  enrichCliFlagInvocationContracts,
  verifyCliFlagInvocationParity,
} from "../../../src/sdk/flag-invocation-contracts.js";

describe("CLI flag invocation contracts", () => {
  it("makes arity, repeatability, requiredness, and input sources explicit", () => {
    expect(
      enrichCliFlagInvocationContract("create", {
        flag: "--description",
        short: "-d",
        value_name: "value",
      }),
    ).toEqual({
      flag: "--description",
      short: "-d",
      description: "Set the item description.",
      takes_value: true,
      value_required: true,
      value_name: "value",
      value_type: "string",
      required: false,
      repeatable: false,
      input_sources: ["argv", "stdin"],
      stdin_token: "-",
    });
    expect(
      enrichCliFlagInvocationContract("create", {
        flag: "--stdin-json",
      }),
    ).toMatchObject({
      takes_value: false,
      value_type: "boolean",
      input_sources: ["stdin"],
    });
    expect(
      enrichCliFlagInvocationContract("create", {
        flag: "--body-file",
        value_name: "path",
      }),
    ).toMatchObject({
      takes_value: true,
      description:
        "Read the item body from a file, or from stdin when set to -.",
      input_sources: ["argv", "file", "stdin"],
      stdin_token: "-",
    });
    expect(
      enrichCliFlagInvocationContract("update-many", {
        flag: "--ids",
        value_name: "value",
      }),
    ).toMatchObject({
      input_sources: ["argv", "file", "stdin"],
      stdin_token: "-",
      file_token_prefix: "@",
    });
    for (const flag of [
      "--body",
      "--description",
      "--dep-remove",
      "--comment",
      "--reminder",
      "--event",
    ]) {
      expect(
        enrichCliFlagInvocationContract("update-many", {
          flag,
          value_name: "value",
        }),
      ).toMatchObject({ input_sources: ["argv", "stdin"], stdin_token: "-" });
    }
    expect(
      enrichCliFlagInvocationContract("history-compact", {
        flag: "--ids",
        value_name: "value",
      }),
    ).toMatchObject({
      input_sources: ["argv", "file", "stdin"],
      stdin_token: "-",
      file_token_prefix: "@",
    });
    expect(
      enrichCliFlagInvocationContract("close-many", {
        flag: "--ids",
        value_name: "value",
      }),
    ).toMatchObject({
      input_sources: ["argv", "file", "stdin"],
      stdin_token: "-",
      file_token_prefix: "@",
    });
    expect(
      enrichCliFlagInvocationContract("comments", {
        flag: "--file",
        value_name: "path",
      }),
    ).toMatchObject({
      input_sources: ["argv", "file", "stdin"],
      stdin_token: "-",
    });
  });

  it("preserves package metadata and returns independent rows", () => {
    const source = [
      {
        flag: "--label",
        aliases: ["--labels"],
        description: "Attach a label.",
        value_name: "label",
        value_type: "string" as const,
        repeatable: true,
        required: true,
      },
    ];
    const enriched = enrichCliFlagInvocationContracts("package-report", source);
    expect(enriched).toEqual([
      expect.objectContaining({
        aliases: ["--labels"],
        description: "Attach a label.",
        takes_value: true,
        value_required: true,
        required: true,
        repeatable: true,
        input_sources: ["argv"],
      }),
    ]);
    expect(enriched[0]).not.toBe(source[0]);
    expect(
      enrichCliFlagInvocationContract("list", {
        flag: "--limit",
        value_type: "number",
      }),
    ).toMatchObject({ value_type: "number", takes_value: true });
    expect(
      enrichCliFlagInvocationContract("list", {
        flag: "--fields",
        list: true,
      }),
    ).toMatchObject({ repeatable: true, takes_value: true });
    expect(
      enrichCliFlagInvocationContract("list", {
        flag: "--summary",
      }),
    ).toMatchObject({
      description: "Enable summary.",
      takes_value: false,
      value_type: "boolean",
    });
    expect(
      enrichCliFlagInvocationContract("assurance", {
        flag: "--apply",
        value_type: "boolean",
      }),
    ).toMatchObject({ takes_value: false, value_required: false });
    expect(
      enrichCliFlagInvocationContract("init", { flag: "--defaults" }),
    ).toMatchObject({ takes_value: false, value_required: false });
    expect(
      enrichCliFlagInvocationContract("test", { flag: "--progress" }),
    ).toMatchObject({ takes_value: false, value_required: false });
    expect(
      enrichCliFlagInvocationContract("test", { flag: "--only-index" }),
    ).toMatchObject({ takes_value: true, value_required: true });
    expect(
      enrichCliFlagInvocationContract("test", { flag: "--only" }),
    ).toMatchObject({ takes_value: false, value_required: false });
    expect(
      enrichCliFlagInvocationContract("test", { flag: "--only-scope" }),
    ).toMatchObject({ takes_value: true, value_required: true });
    expect(
      enrichCliFlagInvocationContract("comments", {
        flag: "--stdin",
      }),
    ).toMatchObject({ input_sources: ["stdin"] });
    expect(
      enrichCliFlagInvocationContract("comments", {
        flag: "--add",
      }),
    ).toMatchObject({ input_sources: ["argv", "stdin"], stdin_token: "-" });
  });

  it("fails closed when generated and executable invocation arity diverge", () => {
    const declarations = enrichCliFlagInvocationContracts("test", [
      { flag: "--run" },
      { flag: "--timeout", value_type: "number" },
    ]);
    const passing = declarations.map((declaration) => ({
      command: "test",
      flag: declaration.flag,
      takes_value: declaration.takes_value,
      value_required: declaration.value_required,
      repeatable: declaration.repeatable,
    }));
    expect(
      verifyCliFlagInvocationParity("test", declarations, passing),
    ).toMatchObject({ ok: true, declared_count: 2, observed_count: 2 });

    const report = verifyCliFlagInvocationParity("test", declarations, [
      ...passing,
      { ...passing[0]!, takes_value: true },
      {
        command: "test",
        flag: "--undeclared",
        takes_value: false,
        value_required: false,
        repeatable: false,
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.observed_count).toBe(4);
    expect(report.findings.map(({ code }) => code)).toEqual([
      "duplicate_observation",
      "undeclared_observation",
    ]);

    const mismatched = verifyCliFlagInvocationParity(" TEST ", declarations, [
      {
        ...passing[0]!,
        command: "other",
      },
      {
        ...passing[1]!,
        takes_value: false,
        value_required: false,
        repeatable: true,
      },
    ]);
    expect(mismatched.findings.map(({ code }) => code)).toEqual([
      "missing_observation",
      "repeatable_mismatch",
      "takes_value_mismatch",
      "value_required_mismatch",
    ]);
  });
});
