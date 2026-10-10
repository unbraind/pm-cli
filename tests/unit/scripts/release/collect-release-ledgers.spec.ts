/** Prove complete provider parsing and anonymous registry isolation with native Git inventory. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectReleaseLedgers, releaseLedgerSnapshots, main } from "../../../../scripts/release/collect-release-ledgers.mjs";

afterEach(() => vi.unstubAllEnvs());
const metadata = { name: "fixture", versions: ["2026.10.1"] };
const changelog = "## [2026.10.1] - 2026-10-01\n- Change\n";
const tag = `${"a".repeat(40)}\trefs/tags/v2026.10.1\n`;
const captured = JSON.parse(readFileSync(new URL("../../../fixtures/release-ledgers/npm-view-12.json", import.meta.url), "utf8"));

describe("release ledger collection", () => {
  it("parses unbracketed and bracketed historical ordinal releases without counting unrelated tags", () => {
    const snapshots = releaseLedgerSnapshots(`${changelog}## 2026.5.3-2 - historical\n## [Unreleased]\n`, `${tag}${"b".repeat(40)}\trefs/tags/other\n`, metadata, "fixture");
    expect(snapshots.map((row) => row.identities)).toEqual([["2026.10.1", "2026.5.3-2"], ["2026.10.1"], ["2026.10.1"]]);
  });

  it.each(["## [2026.10.1 - Broken", "## 2026.10.1] - Broken"])("does not certify a documented release from mismatched heading brackets: %s", (heading) => {
    expect(releaseLedgerSnapshots(`${heading}\n- Change\n`, tag, metadata, "fixture").map((row) => row.identities)).toEqual([[], ["2026.10.1"], ["2026.10.1"]]);
  });

  it("accepts the captured npm12 one-result response without accepting ambiguous packages", () => {
    const rows = releaseLedgerSnapshots(changelog, tag, captured.response, "@unbrained/pm-cli");
    expect(rows[2]?.identities).toEqual(captured.response[0].versions);
    expect(rows[2]?.identities).toContain("2026.10.9");
    for (const value of [[], [metadata, metadata]]) expect(() => releaseLedgerSnapshots(changelog, tag, value, "fixture")).toThrow("one public");
  });

  it.each([null, { ...metadata, name: "other" }, { ...metadata, versions: [] }, { ...metadata, versions: "partial" }, { ...metadata, versions: [1] }])("refuses invalid public registry evidence %j", (value) => {
    expect(() => releaseLedgerSnapshots(changelog, tag, value, "fixture")).toThrow("registry");
  });

  it("refuses a malformed remote inventory instead of dropping an unreadable row", () => {
    expect(() => releaseLedgerSnapshots(changelog, `${tag}broken\n`, metadata, "fixture")).toThrow("tag inventory");
  });

  it.each(["linux", "win32"])("preserves the validated metadata request through the native %s launch vector", (platform) => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-ledgers-launch-"));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
      writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const execute = ((command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
        if (command === "git") return tag;
        const request = ["view", "fixture", "name", "versions", "--json", "--registry=https://registry.npmjs.org"];
        expect(command).toBe(platform === "win32" ? "cmd.exe" : "npm");
        expect(args).toEqual(platform === "win32" ? ["/d", "/s", "/c", `npm.cmd ${request.join(" ")}`] : request);
        expect(options.shell).toBeUndefined();
        expect(options.timeout).toBe(120_000);
        return JSON.stringify(metadata);
      }) as typeof execFileSync;
      expect(collectReleaseLedgers(root, [], execute)).toMatchObject({ ok: true, census_complete: true });
    } finally {
      Object.defineProperty(process, "platform", originalPlatform!);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses real remote refs, excludes ambient registry credentials and preserves replayable drift", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-ledgers-native-"));
    const remote = path.join(root, "remote.git");
    const workspace = path.join(root, "workspace");
    let npmRoot = "";
    try {
      mkdirSync(workspace);
      const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/u.test(key)));
      execFileSync("git", ["init", "--bare", remote], { env: gitEnv, stdio: "ignore" });
      execFileSync("git", ["init", "--initial-branch=main", workspace], { env: gitEnv, stdio: "ignore" });
      const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, env: { ...gitEnv, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, stdio: "ignore" });
      git(["commit", "--allow-empty", "-m", "Fixture"]);
      git(["tag", "v2026.10.1"]);
      git(["remote", "add", "origin", remote]);
      git(["push", "origin", "--tags"]);
      writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture" }));
      writeFileSync(path.join(workspace, "CHANGELOG.md"), changelog);
      vi.stubEnv("npm_config_registry", "https://invalid.example");
      vi.stubEnv("NPM_TOKEN", "host-fixture-credential");
      const execute: typeof execFileSync = ((command, args, options) => {
        if (command === "git") return execFileSync(command, args, options);
        expect(command).toBe(process.platform === "win32" ? "cmd.exe" : "npm");
        expect(args.join(" ")).toContain("--registry=https://registry.npmjs.org");
        expect(options?.env?.NPM_TOKEN).toBeUndefined();
        expect(options?.env?.npm_config_registry).toBeUndefined();
        npmRoot = String(options?.cwd);
        expect(npmRoot).not.toBe(workspace);
        expect(readFileSync(String(options?.env?.NPM_CONFIG_USERCONFIG), "utf8")).toBe("");
        expect(readFileSync(String(options?.env?.NPM_CONFIG_GLOBALCONFIG), "utf8")).toBe("");
        return JSON.stringify(metadata);
      }) as typeof execFileSync;
      expect(collectReleaseLedgers(workspace, [], execute)).toMatchObject({ ok: true, census_complete: true });
      expect(existsSync(npmRoot)).toBe(false);
      writeFileSync(path.join(workspace, "CHANGELOG.md"), `${changelog}## 2026.10.2\n- Undelivered\n`);
      mkdirSync(path.join(workspace, "config"));
      writeFileSync(path.join(workspace, "config/release-ledger-exceptions.json"), JSON.stringify({ schema: "release-ledger-exceptions/1", exceptions: [] }));
      const output = path.join(root, "report.json");
      const report = main({ RELEASE_LEDGERS_OUTPUT: output }, workspace, execute);
      expect(report).toMatchObject({ ok: false, findings: [{ identity: "2026.10.2", missing_from: ["delivered", "tagged"] }], classes: { declared_but_never_delivered: ["2026.10.2"], delivered_but_undocumented: [], tagged_but_unsectioned: [] } });
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
      git(["tag", "v2026.10.3"]);
      git(["push", "origin", "--tags"]);
      const overlap = collectReleaseLedgers(workspace, [], ((command, args, options) => command === "git" ? execFileSync(command, args, options) : JSON.stringify({ ...metadata, versions: [...metadata.versions, "2026.10.3"] })) as typeof execFileSync);
      expect(overlap.classes).toEqual({ declared_but_never_delivered: ["2026.10.2"], delivered_but_undocumented: ["2026.10.3"], tagged_but_unsectioned: ["2026.10.3"] });
      writeFileSync(path.join(workspace, "config/release-ledger-exceptions.json"), "{}");
      expect(() => main({ RELEASE_LEDGERS_OUTPUT: output }, workspace, execute)).toThrow("policy");
      for (const name of ["--bad", "fixture&whoami", "fixture%PATH%", "fixture;whoami", "fixture|whoami"]) {
        writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name }));
        expect(() => collectReleaseLedgers(workspace, [], execute)).toThrow("identity");
      }
      writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture" }));
      expect(() => collectReleaseLedgers(workspace, [], (() => { throw new Error("Registry unavailable"); }) as typeof execFileSync)).toThrow("Registry unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
