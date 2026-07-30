import { describe, expect, it } from "vitest";
import {
  enrichCliFlagInvocationContract,
  enrichCliFlagInvocationContracts,
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
      input_sources: ["argv", "file"],
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
});
