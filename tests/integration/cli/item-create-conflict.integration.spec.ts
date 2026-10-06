import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "../../../src/sdk/index.js";
import * as core from "../../../src/sdk/core.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("deterministic item creation conflicts (GH-1400)", () => {
  it("allows one concurrent winner and exposes the preserved item without message parsing", async () => {
    await withTempPmPath(async (context) => {
      const client = new sdk.PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const attempts = await Promise.allSettled(["First candidate", "Second candidate"].map((title) =>
        client.create({ id: "deterministic", title, type: "Task", createMode: "progressive" }),
      ));
      const winners = attempts.filter((result) => result.status === "fulfilled");
      const losers = attempts.filter((result) => result.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const error: unknown = losers[0]?.reason;
      expect(error).toMatchObject({ code: "item_already_exists", exitCode: sdk.EXIT_CODE.CONFLICT,
        context: { code: "item_already_exists", id: "pm-deterministic" } });
      expect(sdk.isItemAlreadyExistsError(error)).toBe(true);
      expect(core.isItemAlreadyExistsError(error)).toBe(true);
      if (!sdk.isItemAlreadyExistsError(error)) throw new Error("Missing typed conflict");
      const itemBytes = await readFile(error.context.path, "utf8");
      const historyPath = path.join(context.pmPath, "history", "pm-deterministic.jsonl");
      const historyBytes = await readFile(historyPath, "utf8");
      expect((await client.get(error.context.id)).item.title).toBe(winners[0]?.value.item.title);
      await expect(client.create({ id: "pm-deterministic", title: "Overwrite attempt", type: "Issue", createMode: "progressive" }))
        .rejects.toMatchObject({ code: "item_already_exists", context: error.context });
      expect(await readFile(error.context.path, "utf8")).toBe(itemBytes);
      expect(await readFile(historyPath, "utf8")).toBe(historyBytes);
      expect(historyBytes.trim().split("\n")).toHaveLength(1);
      const cli = await context.runCliInProcess(["create", "task", "CLI retry", "--id", error.context.id, "--json"]);
      expect(cli.code).toBe(sdk.EXIT_CODE.CONFLICT);
      expect(JSON.parse(cli.stderr)).toMatchObject({ code: "item_already_exists" });
      expect(await readFile(historyPath, "utf8")).toBe(historyBytes);
    });
  });
});
