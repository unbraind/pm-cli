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

