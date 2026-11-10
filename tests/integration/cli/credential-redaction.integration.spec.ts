import path from "node:path";
import { expect, it } from "vitest";
import { scanMutationSecrets } from "../../../src/sdk/mutation-guard.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

// Built at runtime so this file stays clean under the repository secret scan.
const VALUE = ["Synthetic", "Only123!"].join("");
const SECRET = ["fake", "secret"].join("-");
const SOURCE = `https://u:${SECRET}@example.invalid/x.tgz`;

function guardRules(stderr: string): string[] {
  const warning = stderr.match(/secret_guard_detected:\d+:rules=([a-z_,]+)/u);
  return warning ? warning[1]!.split(",") : [];
}

it("applies the structured secret guard through a real create with the SDK scanner's verdicts (GH-1699)", async () => {
  await withTempPmPath(async (context) => {
    const refuse = [`{"password":"${VALUE}"}`, `'password':'${VALUE}'`, `Config: {"password":["${VALUE}"]}`, `<password>${VALUE}</password>`];
    const allow = ['"password": ""', '"password": "${BUILD_PASSWORD}"', '"password_policy": "rotate monthly"', "the password field"];
    for (const [corpus, detected] of [[refuse, true], [allow, false]] as const) {
      for (const description of corpus) {
        const created = context.runCli(["create", "--type", "Task", "--title", "probe", "--description", description, "--json"]);
        expect(created.code, created.stderr).toBe(0);
        const expected = scanMutationSecrets({ description }).map(({ rule }) => rule);
        expect(expected.includes("password_assignment"), description).toBe(detected);
        expect(guardRules(created.stderr), description).toEqual(expected);
      }
    }
  });
}, 120_000);

it("never prints URL credentials in unknown_option or read_output_mutation_conflict refusals (pm-nhauur)", async () => {
  await withTempPmPath(async (context) => {
    const invocations = [
      ["package", "install", SOURCE, "--project", "--dry-run", "--bogus-flag"],
      ["package", "--catalog", "--install", SOURCE, "--output-limit", "2"],
    ];
    for (const args of invocations) {
      for (const format of [[], ["--json"]]) {
        const refused = context.runCli([...args, ...format]);
        expect(refused.code).toBe(2);
        const output = `${refused.stdout}${refused.stderr}`;
        expect(output).not.toContain(SECRET);
        expect(output).toContain("https://[redacted]@example.invalid/x.tgz");
        expect(output).toMatch(/restore them before replaying/u);
        if (format.length > 0) {
          const recovery = (JSON.parse(refused.stderr) as { recovery?: Record<string, unknown> }).recovery ?? {};
          expect(recovery).not.toHaveProperty("suggested_retry");
          expect(recovery).not.toHaveProperty("suggested_retry_args");
        }
      }
    }
  });
}, 120_000);

it("covers the spellings and paths the first review round reproduced (pm-nhauur)", async () => {
  await withTempPmPath(async (context) => {
    const spaced = `https://U:${SECRET} pass@localhost/x`;
    const invocations: Array<{ args: string[]; code: number }> = [
      // A retained `$&` must stay literal instead of re-inserting the credential-bearing match.
      { args: ["package", "install", `https://u:${SECRET} pass@localhost/$&`, "--bogus-flag", "--json"], code: 2 },
      // Recovery command-name resolution lower-cases an unknown command.
      { args: ["--no-extensions", spaced, "--json"], code: 2 },
      { args: ["--no-extensions", spaced], code: 2 },
      // Bootstrap JSON help renders its own unknown-command envelope.
      { args: ["--no-extensions", "help", `https://u:${SECRET}@localhost/x`, "--json"], code: 2 },
    ];
    for (const { args, code } of invocations) {
      const refused = context.runCli(args);
      expect(refused.code, args.join(" ")).toBe(code);
      const output = `${refused.stdout}${refused.stderr}`;
      expect(output, args.join(" ")).not.toMatch(new RegExp(SECRET, "iu"));
      expect(output, args.join(" ")).toMatch(/restore them before replaying/u);
    }
  });
}, 120_000);


it("covers the second review round's reproductions (pm-nhauur)", async () => {
  await withTempPmPath(async (context) => {
    const created = context.runCli(["create", "--type", "Task", "--title", "probe", "--json"], { expectJson: true });
    const id = (created.json as { id?: string; item?: { id?: string } }).id ?? (created.json as { item: { id: string } }).item.id;
    const echoes = [
      // The value is JSON-stringified into the title and detail.
      ["--no-extensions", "update", id, "--title", "ok", "--message", "ok", "--expect-hash", `https://u:${SECRET} pass\tmore@localhost/x`, "--json"],
      // A three-character whitespace-bearing username.
      ["--no-extensions", `https://${SECRET.slice(0, 1)} ${SECRET.slice(1, 2)}@localhost/x`, "--json"],
    ];
    for (const args of echoes) {
      const refused = context.runCli(args);
      expect(refused.code, args.join(" ")).not.toBe(0);
      const output = `${refused.stdout}${refused.stderr}`;
      expect(output, args.join(" ")).not.toContain(`${SECRET} pass`);
      expect(output, args.join(" ")).not.toContain(`${SECRET.slice(0, 1)} ${SECRET.slice(1, 2)}@`);
      expect(output, args.join(" ")).toMatch(/restore them before replaying/u);
    }
    // Redaction happens before the diagnostic budget, so its receipt measures the delivered envelope.
    const long = context.runCli(["--no-extensions", `https://u:p@localhost/${"x".repeat(1382)}`, "--json"]);
    const envelope = JSON.parse(long.stderr) as { diagnostic_output?: { budget: number; estimated_tokens: number } };
    expect(envelope.diagnostic_output?.estimated_tokens).toBeLessThanOrEqual(envelope.diagnostic_output?.budget ?? 0);
  });
}, 120_000);

it("covers the third review round's reproductions (pm-nhauur)", async () => {
  await withTempPmPath(async (context) => {
    const secret = `${SECRET} pass`;
    const invocations = [
      // The revision parser splits the value at its comma before echoing a fragment.
      ["--no-extensions", "package", "--catalog", "--expect-hash", `https://u:${secret},rest@localhost/x`, "--json"],
      ["--no-extensions", "package", "--catalog", "--expect-hash", `https://u:${secret},rest@localhost/x`],
      // A short credential piece cut before its comma carries no `@` and no full fragment.
      ["--no-extensions", "package", "--catalog", "--expect-hash", `https://u:${SECRET.slice(0, 3)},rest@localhost/x`, "--json"],
      // The concise tracker-initialization text renders its retry directly.
      ["--no-extensions", "--pm-path", path.join(context.tempRoot, "absent", `https://u:${secret}@localhost/x`), "list"],
    ];
    for (const args of invocations) {
      const refused = context.runCli(args);
      expect(refused.code, args.join(" ")).not.toBe(0);
      const output = `${refused.stdout}${refused.stderr}`;
      expect(output, args.join(" ")).not.toMatch(new RegExp(SECRET, "iu"));
      expect(output, args.join(" ")).not.toContain(`u:${SECRET.slice(0, 3)}`);
      expect(output, args.join(" ")).toMatch(/restore them before replaying/u);
      expect(output.match(/restore them before replaying/gu)?.length, args.join(" ")).toBe(1);
    }
  });
}, 120_000);

it("keeps the restore warning in bounded text output (pm-nhauur)", async () => {
  await withTempPmPath(async (context) => {
    const refused = context.runCli(["--no-extensions", "package", "install", `https://u:${SECRET}@localhost/${"x".repeat(800)}`, "--bogus-flag"]);
    expect(refused.code).toBe(2);
    const output = `${refused.stdout}${refused.stderr}`;
    expect(output).not.toContain(SECRET);
    expect(output).toMatch(/restore them before replaying/u);
  });
}, 120_000);

it("redacts extension-recovery failures appended after the guidance (pm-nhauur)", async () => {
  await withTempPmPath(async (context) => {
    const tracker = path.join(context.tempRoot, `https://u:${SECRET}@localhost`, "tracker");
    for (const format of [["--json"], []]) {
      const refused = context.runCli(["--no-extensions", "--pm-path", tracker, "listt", ...format]);
      expect(refused.code).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).not.toContain(SECRET);
    }
  });
}, 120_000);

