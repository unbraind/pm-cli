import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("native assurance policy contract", () => {
  it("keeps telemetry health findings advisory under the accepted health ADR", async () => {
    const assurance = JSON.parse(
      await readFile(path.join(repoRoot, ".agents/pm/assurance.json"), "utf8"),
    ) as {
      assertions: Array<{
        id?: unknown;
        enforcement?: unknown;
        authorization_decision?: unknown;
      }>;
    };
    const telemetryHealth = assurance.assertions.find(
      (assertion) => assertion.id === "health-telemetry-zero",
    );

    expect(telemetryHealth).toMatchObject({
      enforcement: "warn",
      authorization_decision: "pm-jezo",
    });
  });
});
