import { expect, it } from "vitest";
import { resolveExtensionFlagValueContract } from "../../../src/sdk/contracts.js";
import type { FlagDefinition } from "../../../src/sdk/runtime-primitives.js";

it("retains declared argv grammar independently of scalar normalization", () => {
  const cases: Array<[FlagDefinition, string | null, string, string | null]> = [
    [{ long: "--truth <ignored>", value_type: "boolean", value_name: "ignored", required: true }, "boolean", "none", null],
    [{ long: "--truth", type: " BOOL " }, "boolean", "optional", "value"],
    [{ long: "--truth [choice]", value_type: "bool" }, "boolean", "optional", "choice"],
    [{ long: "--maybe [label]", required: true }, null, "optional", "label"],
    [{ long: "--amount=<old>", value_name: "count", value_type: "number", type: "bool" }, "number", "required", "count"],
    [{ long: "--amount", value_type: " ", type: "integer", value_name: " " }, "number", "required", "value"],
    [{ short: "-l", list: true }, null, "required", "value"],
    [{ long: "--repeat", repeatable: true }, null, "required", "value"],
    [{ long: "--switch" }, null, "none", null],
    [{ long: "--name", value_name: "name" }, null, "required", "name"],
    [{ long: "--legacy-required", required: true }, null, "required", "value"],
  ];
  for (const [declaration, type, arity, name] of cases) {
    expect(resolveExtensionFlagValueContract(declaration)).toEqual({ value_type: type, value_arity: arity, value_name: name });
  }
});
