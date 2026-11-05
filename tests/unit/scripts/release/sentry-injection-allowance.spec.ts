import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Binds the committed per-file injection allowance to the installed sentry-cli.
 *
 * The release workflow injects debug IDs only after the immutable tag exists, so
 * a sentry-cli upgrade that grows the injected snippet past the allowance would
 * otherwise first fail on a tag that can no longer change (pm-998juj). Running
 * the real binary here moves that failure to the pull request that upgrades it.
 */
const require = createRequire(import.meta.url);
const budget = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "scripts/release/package-artifact-budget.json"),
    "utf8",
  ),
) as {
  injection_profiles: Record<
    string,
    {
      injected_prefix: string;
      injected_suffix: string;
      max_bytes_per_injected_file: number;
    }
  >;
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Write one emitted module and its source map the way tsc and esbuild emit them. */
function writeModule(dist: string, name: string, body: string) {
  writeFileSync(
    path.join(dist, name),
    `${body}\n//# sourceMappingURL=${name}.map\n`,
  );
  writeFileSync(
    path.join(dist, `${name}.map`),
    JSON.stringify({
      version: 3,
      file: name,
      sources: [`../src/${name.replace(/\.js$/u, ".ts")}`],
      names: [],
      mappings: "AAAA",
    }),
  );
}

describe("Sentry debug-ID injection allowance", () => {
  it("covers what the installed sentry-cli adds to every emitted module shape", () => {
    const profile = budget.injection_profiles["sentry-injected"];
    expect(profile).toBeDefined();
    const root = mkdtempSync(path.join(tmpdir(), "pm-sentry-injection-"));
    roots.push(root);
    const dist = path.join(root, "dist");
    mkdirSync(dist);
    const modules = {
      "module.js": "export const value = 1;",
      "cli.js": "#!/usr/bin/env node\nconsole.log(1);",
      "chunk.js": `export const large = ${JSON.stringify("x".repeat(4096))};`,
    };
    for (const [name, body] of Object.entries(modules)) writeModule(dist, name, body);
    const before = Object.fromEntries(
      Object.keys(modules).map((name) => [name, statSync(path.join(dist, name)).size]),
    );

    const { SentryCli } = require("@sentry/cli") as {
      SentryCli: { getPath(): string };
    };
    execFileSync(SentryCli.getPath(), ["sourcemaps", "inject", dist], {
      cwd: root,
      env: {
        ...process.env,
        SENTRY_AUTH_TOKEN: "",
        SENTRY_DISABLE_UPDATE_CHECK: "1",
      },
      stdio: "pipe",
      timeout: 60_000,
    });

    for (const name of Object.keys(modules)) {
      expect(name.endsWith(profile.injected_suffix)).toBe(true);
      const added = statSync(path.join(dist, name)).size - before[name];
      // A zero delta would mean nothing was injected and the bound proves nothing.
      expect(added, name).toBeGreaterThan(0);
      expect(added, name).toBeLessThanOrEqual(profile.max_bytes_per_injected_file);
      expect(readFileSync(path.join(dist, name), "utf8")).toMatch(
        /\/\/# debugId=[0-9a-f-]{36}/u,
      );
    }
  });

  it("declares the transform scope the release workflow injects", () => {
    const profile = budget.injection_profiles["sentry-injected"];
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts["sentry:inject"]).toBe(
      `sentry-cli sourcemaps inject ${profile.injected_prefix}`,
    );
  });
});
