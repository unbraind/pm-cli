import { describe, expect, it } from "vitest";
import {
  listCoreClosedDomainContracts,
  renderPmClosedDomainHelp,
} from "../../../../src/sdk/agent/closed-domain-contracts.js";

describe("closed-domain contracts", () => {
  it("publishes every core intent and list-family field refusal once", () => {
    const contracts = listCoreClosedDomainContracts();
    expect(contracts).toHaveLength(19);
    expect(new Set(contracts.map(({ probe_id: probeId }) => probeId)).size).toBe(
      contracts.length,
    );
    expect(contracts.map(({ probe_id: probeId }) => probeId)).toEqual(
      contracts.map(({ probe_id: probeId }) => probeId).toSorted(),
    );
    expect(contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          probe_id: "list-canceled-invalid-field",
          error_code: "unknown_field_projection",
        }),
        expect.objectContaining({
          probe_id: "search-invalid-intent",
          allowed_values: ["discover"],
        }),
        expect.objectContaining({
          probe_id: "package-upgrade-mutually-exclusive-modes",
          flag: "--cli-only/--packages-only",
          error_code: "projection_options_mutually_exclusive",
        }),
      ]),
    );
    expect(
      contracts
        .filter(({ probe_id: probeId }) => probeId.endsWith("-invalid-field"))
        .filter(({ command }) => command.startsWith("list"))
        .every(
          ({ command, suggested_retry_args: suggestedRetryArgs }) =>
            suggestedRetryArgs[0] === command,
        ),
    ).toBe(true);
    expect(
      contracts.find(
        ({ probe_id: probeId }) =>
          probeId === "search-mutually-exclusive-projection",
      )?.suggested_retry_args,
    ).toEqual(["search", "Domain query", "--full"]);
  });

  it("renders compact complete-domain help and handles undeclared pairs", () => {
    expect(renderPmClosedDomainHelp("context", "--for")).toContain(
      "Allowed core values: handoff|orient",
    );
    expect(renderPmClosedDomainHelp("get", "--fields")).toContain(
      "item.<field> aliases",
    );
    expect(renderPmClosedDomainHelp("unknown", "--for")).toBe(
      "No stable core values are declared.",
    );
  });
});
