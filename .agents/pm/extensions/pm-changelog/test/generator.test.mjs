import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createChangelog, mergeChangelog, readPmItems, writeChangelog } from "../dist/index.js";

const items = [
  {
    id: "pm-2",
    title: "Fix runner status export",
    status: "closed",
    type: "bug",
    release: "1.2.0",
    updated_at: "2026-05-17T09:00:00Z",
  },
  {
    id: "pm-1",
    title: "Add GitHub Actions changelog command",
    status: "closed",
    type: "feature",
    metadata: {
      release: "1.2.0",
    },
    updated_at: "2026-05-16T09:00:00Z",
  },
  {
    id: "pm-3",
    title: "Draft release notes",
    status: "open",
    type: "task",
    updated_at: "2026-05-17T11:00:00Z",
  },
];

test("createChangelog groups closed items by category", () => {
  const result = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  assert.equal(result.itemCount, 2);
  assert.match(result.markdown, /^# Changelog\n\n## 1\.2\.0 - 2026-05-17/m);
  assert.match(result.markdown, /### Added\n\n- Add GitHub Actions changelog command \(pm-1\)/);
  assert.match(result.markdown, /### Fixed\n\n- Fix runner status export \(pm-2\)/);
  assert.doesNotMatch(result.markdown, /Draft release notes/);
});

test("createChangelog can group items by release metadata", () => {
  const result = createChangelog({
    items: [
      ...items,
      {
        id: "pm-4",
        title: "Improve release note rendering",
        status: "closed",
        type: "task",
        release: "1.1.0",
        updated_at: "2026-05-15T09:00:00Z",
      },
    ],
    date: "2026-05-17",
    groupBy: "release",
  });

  assert.equal(result.itemCount, 3);
  assert.match(result.markdown, /## 1\.2\.0\n\n### Added[\s\S]*## 1\.1\.0\n\n### Changed/);
  assert.match(result.markdown, /- Improve release note rendering \(pm-4\)/);
});

test("createChangelog omits item links unless explicitly enabled", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-5",
        title: "Fix multiline\nrelease title",
        status: "closed",
        type: "bug",
        url: "https://user@example.com/unbraind/pm-changelog/issues/5",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
  });

  assert.match(result.markdown, /- Fix multiline release title \(pm-5\)$/m);
  assert.doesNotMatch(result.markdown, /example\.com|user/);

  const linked = createChangelog({
    items: [
      {
        id: "pm-5",
        title: "Fix multiline\nrelease title",
        status: "closed",
        type: "bug",
        url: "https://user@example.com/unbraind/pm-changelog/issues/5",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    includeLinks: true,
  });

  assert.match(linked.markdown, /- Fix multiline release title \(pm-5\) \[link\]\(https:\/\/example\.com\/unbraind\/pm-changelog\/issues\/5\)/);
  assert.doesNotMatch(linked.markdown, /user|token|secret/);
});

test("createChangelog strips query and hash data from item links", () => {
  const result = createChangelog({
    items: [
      {
        id: "pm-6",
        title: "Add runner changelog output",
        status: "closed",
        type: "feature",
        url: "https://example.com/issues/6?token=secret#private-note",
        updated_at: "2026-05-17T10:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-17",
    includeLinks: true,
  });

  assert.match(result.markdown, /\[link\]\(https:\/\/example\.com\/issues\/6\)/);
  assert.doesNotMatch(result.markdown, /token|secret|private-note/);
});

test("mergeChangelog creates a missing changelog", () => {
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(undefined, generated.markdown);

  assert.equal(result.action, "created");
  assert.equal(result.changed, true);
  assert.equal(result.markdown, generated.markdown);
});

test("mergeChangelog prepends a new release and preserves older releases", () => {
  const existing = `# Changelog

## 1.1.0 - 2026-05-01

### Fixed

- Existing fix
`;
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  assert.equal(result.action, "inserted");
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*## 1\.1\.0 - 2026-05-01/);
  assert.match(result.markdown, /- Existing fix/);
});

test("mergeChangelog replaces an existing generated release", () => {
  const existing = `# Changelog

## 1.2.0 - 2026-05-17

### Fixed

- Old line

## 1.1.0 - 2026-05-01

### Fixed

- Existing fix
`;
  const generated = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-17",
  });

  const result = mergeChangelog(existing, generated.markdown);

  assert.equal(result.action, "replaced");
  assert.doesNotMatch(result.markdown, /Old line/);
  assert.match(result.markdown, /## 1\.2\.0 - 2026-05-17[\s\S]*## 1\.1\.0 - 2026-05-01/);
});

test("writeChangelog writes and reports unchanged check runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const output = join(dir, "CHANGELOG.md");

  const written = writeChangelog({
    items,
    output,
    version: "1.2.0",
    date: "2026-05-17",
  });

  assert.equal(written.action, "created");
  assert.equal(written.changed, true);
  assert.equal(readFileSync(output, "utf-8"), written.markdown);

  const checked = writeChangelog({
    items,
    output,
    version: "1.2.0",
    date: "2026-05-17",
    check: true,
  });

  assert.equal(checked.action, "unchanged");
  assert.equal(checked.changed, false);
  assert.equal(readFileSync(output, "utf-8"), written.markdown);
});

test("writeChangelog check mode does not overwrite stale files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const output = join(dir, "CHANGELOG.md");
  writeFileSync(output, "# Changelog\n\nOld content\n", "utf-8");

  const result = writeChangelog({
    items,
    output,
    version: "1.2.0",
    date: "2026-05-17",
    check: true,
  });

  assert.equal(result.action, "replaced");
  assert.equal(result.changed, true);
  assert.equal(readFileSync(output, "utf-8"), "# Changelog\n\nOld content\n");
});

test("CLI writes GitHub Actions outputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const input = join(dir, "items.json");
  const output = join(dir, "CHANGELOG.md");
  const githubOutput = join(dir, "github-output.txt");
  writeFileSync(input, JSON.stringify(items), "utf-8");

  const stdout = execFileSync(
    process.execPath,
    [
      "dist/cli.js",
      "--input",
      input,
      "--output",
      output,
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
      "--json",
      "--github-output",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_OUTPUT: githubOutput },
      encoding: "utf-8",
    }
  );

  const summary = JSON.parse(stdout);
  assert.equal(summary.changed, true);
  assert.equal(summary.itemCount, 2);
  assert.match(readFileSync(githubOutput, "utf-8"), /changed=true/);
  assert.match(readFileSync(output, "utf-8"), /## 1\.2\.0 - 2026-05-17/);
});

test("CLI can append generated markdown to GitHub step summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const input = join(dir, "items.json");
  const output = join(dir, "CHANGELOG.md");
  const stepSummary = join(dir, "step-summary.md");
  writeFileSync(input, JSON.stringify(items), "utf-8");

  execFileSync(
    process.execPath,
    [
      "dist/cli.js",
      "--input",
      input,
      "--output",
      output,
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
      "--github-step-summary",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummary },
      encoding: "utf-8",
    }
  );

  const summary = readFileSync(stepSummary, "utf-8");
  assert.match(summary, /^# Changelog\n\n## 1\.2\.0 - 2026-05-17/m);
  assert.match(summary, /- Add GitHub Actions changelog command \(pm-1\)/);
});

test("CLI stdout JSON includes markdown for runners without writing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const input = join(dir, "items.json");
  const output = join(dir, "CHANGELOG.md");
  writeFileSync(input, JSON.stringify(items), "utf-8");

  const stdout = execFileSync(
    process.execPath,
    [
      "dist/cli.js",
      "--input",
      input,
      "--output",
      output,
      "--stdout",
      "--json",
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
    }
  );

  const summary = JSON.parse(stdout);
  assert.equal(summary.changed, true);
  assert.equal(summary.itemCount, 2);
  assert.match(summary.markdown, /## 1\.2\.0 - 2026-05-17/);
  assert.throws(() => readFileSync(output, "utf-8"));
});

test("readPmItems supports runner wrappers with custom binaries, args, cwd, and env", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const fixture = join(dir, "fixture.json");
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(fixture, JSON.stringify(items), "utf-8");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.slice(2).join(" ") !== "--profile ci list-all --json") process.exit(2);
if (process.env.PM_CHANGELOG_TEST !== "1") process.exit(3);
process.stdout.write(readFileSync(resolve(process.cwd(), "fixture.json"), "utf-8"));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const result = readPmItems({
    pmBin: wrapper,
    pmArgs: ["--profile", "ci"],
    cwd: dir,
    env: { ...process.env, PM_CHANGELOG_TEST: "1" },
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].id, "pm-2");
});

test("readPmItems supports pm JSON larger than Node's default spawnSync buffer", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const wrapper = join(dir, "pm-wrapper.mjs");
  const largeBody = "x".repeat(1_200_000);
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "list-all --json") process.exit(2);
process.stdout.write(JSON.stringify({ items: [{ id: "pm-large", title: "Large tracker", status: "closed", body: ${JSON.stringify(largeBody)} }] }));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const result = readPmItems({ pmBin: wrapper });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "pm-large");
});

test("CLI can run a custom pm binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "list-all --json") process.exit(2);
process.stdout.write(${JSON.stringify(JSON.stringify(items))});
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const stdout = execFileSync(
    process.execPath,
    [
      "dist/cli.js",
      "--pm-bin",
      wrapper,
      "--stdout",
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /## 1\.2\.0 - 2026-05-17/);
  assert.match(stdout, /- Add GitHub Actions changelog command \(pm-1\)/);
});

test("CLI passes extra pm arguments and cwd to runner wrappers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-"));
  const fixture = join(dir, "fixture.json");
  const wrapper = join(dir, "pm-wrapper.mjs");
  writeFileSync(fixture, JSON.stringify(items), "utf-8");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (process.argv.slice(2).join(" ") !== "--profile ci --workspace release list-all --json") process.exit(2);
if (!existsSync(resolve(process.cwd(), "fixture.json"))) process.exit(3);
process.stdout.write(readFileSync(resolve(process.cwd(), "fixture.json"), "utf-8"));
`,
    "utf-8"
  );
  chmodSync(wrapper, 0o755);

  const stdout = execFileSync(
    process.execPath,
    [
      "dist/cli.js",
      "--pm-bin",
      wrapper,
      "--pm-arg",
      "--profile",
      "--pm-arg",
      "ci",
      "--pm-arg",
      "--workspace",
      "--pm-arg",
      "release",
      "--pm-cwd",
      dir,
      "--stdout",
      "--version",
      "1.2.0",
      "--date",
      "2026-05-17",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
    }
  );

  assert.match(stdout, /## 1\.2\.0 - 2026-05-17/);
  assert.match(stdout, /- Fix runner status export \(pm-2\)/);
});

test("pm package install activates changelog command", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-install-"));
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");

  execFileSync(pmBin, ["init", "--json"], {
    cwd: dir,
    encoding: "utf-8",
  });
  execFileSync(pmBin, ["install", process.cwd(), "--project", "--json"], {
    cwd: dir,
    encoding: "utf-8",
  });

  const doctor = JSON.parse(execFileSync(pmBin, ["package", "doctor", "--project", "--json", "--detail", "deep"], {
    cwd: dir,
    encoding: "utf-8",
  }));
  assert.deepEqual(doctor.warnings, []);
  assert.equal(doctor.details.summary.activation_status_totals.ok, 1);

  execFileSync(
    pmBin,
    [
      "create",
      "--type",
      "task",
      "--title",
      "Add changelog install smoke",
      "--description",
      "Verify pm-changelog package install",
      "--status",
      "closed",
      "--json",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
    }
  );

  const generated = JSON.parse(execFileSync(
    pmBin,
    [
      "changelog",
      "generate",
      "--output",
      "CHANGELOG.md",
      "--release-version",
      "smoke",
      "--date",
      "2026-05-17",
      "--mode",
      "prepend",
      "--json",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
    }
  ));

  assert.equal(generated.changed, true);
  assert.equal(generated.item_count, 1);
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf-8"), /## smoke - 2026-05-17/);

  const unchanged = JSON.parse(execFileSync(
    pmBin,
    [
      "changelog",
      "generate",
      "--output",
      "CHANGELOG.md",
      "--release-version",
      "smoke",
      "--date",
      "2026-05-17",
      "--mode",
      "prepend",
      "--check",
      "--json",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
    }
  ));
  assert.equal(unchanged.changed, false);

  writeFileSync(join(dir, "CHANGELOG.md"), "# stale\n", "utf-8");
  assert.throws(
    () => execFileSync(
      pmBin,
      [
        "changelog",
        "generate",
        "--output",
        "CHANGELOG.md",
        "--release-version",
        "smoke",
        "--date",
        "2026-05-17",
        "--mode",
        "prepend",
        "--check",
        "--json",
      ],
      {
        cwd: dir,
        encoding: "utf-8",
      }
    ),
    /Command \\"changelog generate\\" failed/
  );
});

test("pm extension command works when only node cli entrypoint is available", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-node-cli-"));
  const pmCli = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const pmBin = join(process.cwd(), "node_modules", ".bin", "pm");

  execFileSync(pmBin, ["init", "--json"], {
    cwd: dir,
    encoding: "utf-8",
  });
  execFileSync(pmBin, ["install", process.cwd(), "--project", "--json"], {
    cwd: dir,
    encoding: "utf-8",
  });
  execFileSync(
    pmBin,
    [
      "create",
      "--type",
      "task",
      "--title",
      "Generate changelog without global pm",
      "--description",
      "Verify extension can use the current node cli entrypoint",
      "--status",
      "closed",
      "--json",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
    }
  );

  const generated = JSON.parse(execFileSync(
    process.execPath,
    [
      pmCli,
      "changelog",
      "generate",
      "--output",
      "CHANGELOG.md",
      "--release-version",
      "node-cli",
      "--date",
      "2026-05-17",
      "--json",
    ],
    {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, PATH: dirname(process.execPath) },
    }
  ));

  assert.equal(generated.changed, true);
  assert.equal(generated.item_count, 1);
  assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf-8"), /## node-cli - 2026-05-17/);
});
