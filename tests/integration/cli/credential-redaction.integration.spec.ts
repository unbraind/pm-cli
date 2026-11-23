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

it("classifies Commander's message before any secret fragment can rewrite it (pm-nhauur)", async () => {
  await withTempPmPath(async (context) => {
    const refused = context.runCli(["package", "install", "https://u:unknownOption1@localhost/x", "--bogus-flag", "--json"]);
    expect(refused.code).toBe(2);
    const envelope = JSON.parse(refused.stderr) as { code?: string; recovery?: { option_scope?: string } };
    expect(envelope.code).toBe("unknown_option");
    expect(envelope.recovery?.option_scope).toBe("declared_nowhere");
    expect(refused.stderr).not.toContain("unknownOption1");
  });
}, 120_000);


it("steers an identity refusal to a replay that succeeds instead of restoring the rejected credentials (GH-1757)", async () => {
  await withTempPmPath(async (context) => {
    const credential = `https://fixture:${SECRET}@example.invalid`;
    const created = context.runCli(["create", "--type", "Task", "--title", "probe", "--description", "d", "--acceptance-criteria", "a", "--json"]);
    expect(created.code, created.stderr).toBe(0);
    const createdJson = JSON.parse(created.stdout) as { id?: string; item?: { id: string } };
    const id = createdJson.item?.id ?? createdJson.id!;
    type Refusal = { code: string; required: string; next_steps: string[]; recovery: { attempted_command: string } };
    const refuse = (args: string[]): { refusal: Refusal; stderr: string } => {
      const refused = context.runCli(args, { cwd: context.tempRoot });
      expect(refused.code, refused.stderr).toBe(2);
      expect(`${refused.stdout}${refused.stderr}`).not.toContain(SECRET);
      return { refusal: JSON.parse(refused.stderr) as Refusal, stderr: refused.stderr };
    };

    const flag = refuse(["claim", id, "--author", credential, "--json"]);
    expect(flag.refusal.code).toBe("invalid_argument_value");
    expect(flag.refusal.recovery.attempted_command).toContain("https://[redacted]@example.invalid");
    expect(flag.refusal.next_steps).toEqual([
      "URL credentials in this invocation were replaced with [redacted]. Those in --author caused this refusal, so do not restore them: give --author a value without URL credentials, and restore any other redacted credentials before replaying.",
      "Rerun with --author set to a plain name.",
    ]);
    // The text rendering carries the same advice.
    const text = context.runCli(["claim", id, "--author", credential]);
    expect(text.code).toBe(2);
    expect(text.stderr).not.toMatch(/restore them before replaying/u);
    expect(text.stderr).toMatch(/do not restore them/u);

    // PM_AUTHOR leaves no credential in the command line, so no credential step appears at all, and
    // the requirement text is not rewritten by redaction.
    const previousAuthor = context.env.PM_AUTHOR;
    context.env.PM_AUTHOR = credential;
    const env = refuse(["claim", id, "--json"]);
    // An unrelated credential elsewhere in the command is still to be restored; only PM_AUTHOR's are not.
    const mixed = refuse(["create", "--type", "Task", "--title", "mixed", "--description", `see https://u:${SECRET}@other.invalid/x`, "--json"]);
    context.env.PM_AUTHOR = previousAuthor;
    expect(mixed.refusal.next_steps[0]).toBe(
      "URL credentials in this invocation were replaced with [redacted]. Those in PM_AUTHOR caused this refusal, so do not restore them: give PM_AUTHOR a value without URL credentials, and restore any other redacted credentials before replaying.",
    );
    expect(env.refusal.next_steps).toEqual(["Rerun with PM_AUTHOR set to a plain name."]);
    expect(env.refusal.required).not.toContain("[redacted]");
    expect(env.refusal.recovery.attempted_command).toMatch(new RegExp(`claim ${id} --json$`, "u"));
    expect(env.refusal.recovery.attempted_command).not.toContain("[redacted]");

    // Following the advice succeeds.
    const plain = context.runCli(["claim", id, "--author", "fixture-author", "--json"]);
    expect(plain.code, plain.stderr).toBe(0);
  });
}, 120_000);

it("refuses URL userinfo in asserted identities and never echoes a stored one (GH-1707)", async () => {
  await withTempPmPath(async (context) => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const credentialIdentity = `https://bot:${SECRET} word@registry.example.invalid`;
    const created = context.runCli(["create", "--type", "Task", "--title", "probe", "--description", "d", "--acceptance-criteria", "a", "--json"]);
    expect(created.code, created.stderr).toBe(0);
    const createdJson = JSON.parse(created.stdout) as { id?: string; item?: { id: string } };
    const id = createdJson.item?.id ?? createdJson.id!;
    const itemFile = path.join(context.pmPath, "tasks", `${id}.toon`);
    const before = await readFile(itemFile, "utf8");
    // PM_AUTHOR reaches the CLI only through a real process, so this call spawns one.
    const previousAuthor = context.env.PM_AUTHOR;
    context.env.PM_AUTHOR = credentialIdentity;
    const envClaim = context.runCli(["claim", id, "--json"], { cwd: context.tempRoot });
    context.env.PM_AUTHOR = previousAuthor;
    const refusals = [
      envClaim,
      context.runCli(["claim", id, "--author", credentialIdentity, "--json"]),
      context.runCli(["update", id, "--assignee", `https://u:${SECRET}@host.invalid/x`, "--author", "other", "--json"]),
    ];
    for (const refused of refusals) {
      expect(refused.code, refused.stderr).toBe(2);
      expect(`${refused.stdout}${refused.stderr}`).not.toContain(SECRET);
      expect(refused.stderr).toMatch(/must not carry URL credentials/u);
    }
    expect(await readFile(itemFile, "utf8")).toBe(before);
    const plainClaim = context.runCli(["claim", id, "--author", "legacy-holder", "--json"]);
    expect(plainClaim.code, plainClaim.stderr).toBe(0);

    // A holder stored by an older version keeps reading, and refusals and claim envelopes, including
    // their item copies, redact it.
    await writeFile(itemFile, (await readFile(itemFile, "utf8"))
      .replace(/^assignee: .*$/mu, `assignee: ${JSON.stringify(credentialIdentity)}`)
      .replace(/^claim_principal: .*$/mu, `claim_principal: ${JSON.stringify(credentialIdentity)}`));
    for (const [args, preserve] of [
      [["claim", id], true], [["claim", id, "--json"], true], [["claim", id, "--if-available", "--json"], true],
      // The full changed-fields form also carries the item record, redacted the same way.
      [["claim", id, "--if-available", "--json"], false],
    ] as const) {
      const result = context.runCli([...args, "--author", "other"], { preserveDefaultMutationOutput: preserve });
      const output = `${result.stdout}${result.stderr}`;
      // Ownership holds: a plain claim is refused and --if-available skips.
      if (args.includes("--if-available")) {
        expect(result.code, output).toBe(0);
        expect(output).toMatch(/skipped/u);
      } else {
        expect(result.code, output).toBe(4);
      }
      expect(output, args.join(" ")).not.toContain(SECRET);
      expect(output, args.join(" ")).toContain("https://[redacted]@registry.example.invalid");
    }
    const stored = await readFile(itemFile, "utf8");
    expect(stored).toContain(`assignee: ${JSON.stringify(credentialIdentity)}`);
    expect(stored).toContain(`claim_principal: ${JSON.stringify(credentialIdentity)}`);

    // An author asserted inside a structured seed is refused too.
    const seeded = context.runCli(["create", "--type", "Task", "--title", "seed", "--description", "d", "--acceptance-criteria", "a",
      "--comment", `author=https://u:${SECRET}@host.invalid,text=note`, "--json"]);
    expect(seeded.code, seeded.stderr).toBe(2);
    expect(`${seeded.stdout}${seeded.stderr}`).not.toContain(SECRET);
  });
}, 120_000);

it("keeps public URLs with an at sign in the path intact in refusals and retries (GH-1707)", async () => {
  await withTempPmPath(async (context) => {
    const publicUrl = "https://www.npmjs.com/package/@unbrained/pm-cli";
    const refused = context.runCli(["create", "--type", "Task", "--title", `see ${publicUrl}`, "--description", "d", "--acceptance-criteria", "a", "--bogus-flag", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(publicUrl);
    const recovery = (JSON.parse(refused.stderr) as { recovery?: { suggested_retry?: string } }).recovery ?? {};
    expect(recovery.suggested_retry).toContain(publicUrl);
  });
}, 120_000);

it("masks whitespace-bearing userinfo with an encoded at sign in stored text a refusal echoes (GH-1773)", async () => {
  await withTempPmPath(async (context) => {
    const spaced = `https://fixture:${SECRET} words`;
    const idOf = (json: unknown) => (json as { id?: string; item?: { id?: string } }).id ?? (json as { item: { id: string } }).item.id;
    const blocker = context.runCli(["create", "--type", "Task", "--title", `${spaced}%40example.invalid/path`, "--json"], { expectJson: true });
    const blocked = context.runCli(["create", "--type", "Task", "--title", "sample one", "--dep", `id=${idOf(blocker.json)},kind=blocked_by`, "--json"], { expectJson: true });
    for (const format of [["--json"], []]) {
      const refused = context.runCli(["start-task", idOf(blocked.json), ...format]);
      expect(refused.code, refused.stderr).toBe(4);
      const output = `${refused.stdout}${refused.stderr}`;
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain("fixture:");
      expect(output).toContain("https://[redacted]%40example.invalid/path");
    }
    // A plain user:pass@host userinfo in stored text is masked as before.
    const plain = context.runCli(["create", "--type", "Task", "--title", `https://u:${SECRET}@example.invalid/x`, "--json"], { expectJson: true });
    const gated = context.runCli(["create", "--type", "Task", "--title", "sample two", "--dep", `id=${idOf(plain.json)},kind=blocked_by`, "--json"], { expectJson: true });
    const refused = context.runCli(["start-task", idOf(gated.json), "--json"]);
    expect(refused.stderr).not.toContain(SECRET);
    expect(refused.stderr).toContain("https://[redacted]@example.invalid/x");
  });
}, 120_000);
