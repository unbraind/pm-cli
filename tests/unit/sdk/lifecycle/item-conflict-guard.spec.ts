import { describe, expect, expectTypeOf, it } from "vitest";
import { EXIT_CODE, PM_ERROR_CODE_CATALOG, createPmCliExpectedError, isItemAlreadyExistsError, type PmItemAlreadyExistsError } from "../../../../src/sdk/index.js";

describe("existing-item conflict guard", () => {
  it("accepts public structural errors with a localized message and narrows identity", () => {
    expect(PM_ERROR_CODE_CATALOG.find(({ code }) => code === "item_already_exists")).toMatchObject({ stability: "stable", exit_code: EXIT_CODE.CONFLICT, class: "conflict" });
    const context = { code: "item_already_exists", id: "pm-existing", path: "/workspace/tasks/pm-existing.toon" };
    for (const error of [
      createPmCliExpectedError("Localized refusal", { exitCode: EXIT_CODE.CONFLICT, context }),
      Object.assign(new Error("Different bundle"), { name: "PmCliError", exitCode: EXIT_CODE.CONFLICT, code: "item_already_exists", context }),
    ]) {
      expect(isItemAlreadyExistsError(error)).toBe(true);
      if (isItemAlreadyExistsError(error)) expectTypeOf(error).toEqualTypeOf<PmItemAlreadyExistsError>();
    }
  });

  it("rejects other conflicts and incomplete or forged coordinates without throwing", () => {
    const valid = { code: "item_already_exists", id: "pm-existing", path: "/workspace/tasks/pm-existing.toon" };
    for (const error of [null, "already exists", new Error("already exists"),
      createPmCliExpectedError("Different conflict", { exitCode: EXIT_CODE.CONFLICT, context: { code: "already_claimed" } }),
      createPmCliExpectedError("Wrong exit class", { context: valid }),
      ...[undefined, null, {}, { ...valid, code: "already_claimed" }, { ...valid, id: 1 }, { ...valid, id: " " }, { ...valid, path: 1 }, { ...valid, path: " " }].map((context) =>
        Object.assign(new Error("Lookalike"), { name: "PmCliError", code: "item_already_exists", exitCode: EXIT_CODE.CONFLICT, context }),
      ),
    ]) expect(isItemAlreadyExistsError(error)).toBe(false);
  });
});
