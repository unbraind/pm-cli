import { describe, expect, it, vi } from "vitest";
import { checkNpmUpdate } from "../../../src/sdk/extension/update-check.js";
import type { ManagedExtensionSource } from "../../../src/sdk/extension/managed-state.js";

const source: ManagedExtensionSource = { kind: "npm", input: "npm:@scope/example@1.0.0", location: "@scope/example@1.0.0", package: "@scope/example", version: "1.0.0" };

describe("npm registry freshness evidence", () => {
  it.each([["1.0.0", false], ["2.0.0", true], ["0.9.0", true]] as const)("compares %s against the recorded installed package version", async (version, available) => {
    const runner = vi.fn(async () => JSON.stringify(version));
    expect(await checkNpmUpdate(source, runner)).toMatchObject({ available, remote_version: version });
    expect(runner).toHaveBeenCalledWith(["view", "@scope/example", "dist-tags.latest", "--json", "--ignore-scripts"], 10000);
  });
  it.each([
    [{ ...source, kind: "local" as const }, '"2.0.0"', "missing_or_invalid_npm_package_identity"],
    [{ ...source, package: undefined }, '"2.0.0"', "missing_or_invalid_npm_package_identity"],
    [{ ...source, package: "example; echo unsafe" }, '"2.0.0"', "missing_or_invalid_npm_package_identity"],
    [{ ...source, package: "--registry" }, '"2.0.0"', "missing_or_invalid_installed_npm_version"],
    [{ ...source, package: "." }, '"2.0.0"', "missing_or_invalid_installed_npm_version"],
    [{ ...source, version: undefined }, '"2.0.0"', "missing_or_invalid_installed_npm_version"],
    [{ ...source, version: "latest" }, '"2.0.0"', "missing_or_invalid_installed_npm_version"],
    [{ ...source, version: "private fixture value" }, '"2.0.0"', "missing_or_invalid_installed_npm_version"],
    [source, '"not-a-version"', "invalid_npm_registry_version"],
    [source, '"private fixture value"', "invalid_npm_registry_version"],
    [source, "{}", "invalid_npm_registry_version"],
    [source, "invalid-json private fixture value", "invalid_npm_registry_metadata"],
    [source, '[]', "invalid_npm_registry_version"],
    [source, '["1.0.0","2.0.0"]', "invalid_npm_registry_version"],
  ])("reports incomplete identity or registry metadata with stable private-data-free reasons", async (input, output, error) => {
    expect(await checkNpmUpdate(input, async () => output)).toMatchObject({ available: null, error });
  });
  it("preserves lookup failures as unknown availability", async () => {
    expect(await checkNpmUpdate(source, async () => { throw new Error("offline fixture"); })).toMatchObject({ available: null, error: "offline fixture" });
  });
  it("accepts npm's single-version array envelope and normalizes a non-Error refusal", async () => {
    expect(await checkNpmUpdate(source, async () => '["2.0.0"]')).toMatchObject({ available: true, remote_version: "2.0.0" });
    await expect(checkNpmUpdate(source, async () => { throw "transport refusal"; })).resolves.toMatchObject({ available: null, error: "transport refusal" });
  });
});
