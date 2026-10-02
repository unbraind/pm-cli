import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPmCli } from "../../../../src/cli/main.js";
import { maybeRunFirstUseTelemetryPrompt } from "../../../../src/core/telemetry/consent.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { getSettingsPath } from "../../../../src/core/store/paths.js";
import { runInProcessDistCli } from "../../../helpers/cliRunner.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

// Replace the interactive readline prompt so consent flows can be driven
// non-interactively; each test sets questionImpl to the desired answer.
const promptState = vi.hoisted(() => ({
  questionImpl: async (): Promise<string> => "",
  closed: 0,
}));

vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: () => ({
      question: () => promptState.questionImpl(),
      close: () => {
        promptState.closed += 1;
      },
    }),
  },
}));

const originalGlobalPath = process.env.PM_GLOBAL_PATH;
const baseGlobalOptions = {
  json: false,
  quiet: false,
  noExtensions: false,
  noPager: false,
  profile: false,
};

const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function restoreTty(): void {
  if (stdinDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (stdoutDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

/** Isolate deliberate prompt tests from host consent and restore all environment and TTY overrides. */
async function withInteractiveEnv(run: () => Promise<void>): Promise<void> {
  const originalCi = process.env.CI;
  const originalPrompt = process.env.PM_TELEMETRY_PROMPT;
  const originalTestEvents = process.env.PM_TELEMETRY_SEND_TEST_EVENTS;
  const originalDoNotTrack = process.env.DO_NOT_TRACK;
  process.env.PM_TELEMETRY_SEND_TEST_EVENTS = "1";
  process.env.DO_NOT_TRACK = "0";
  setTty(true);
  delete process.env.CI;
  delete process.env.PM_TELEMETRY_PROMPT;
  try {
    await run();
  } finally {
    if (originalDoNotTrack === undefined) {
      delete process.env.DO_NOT_TRACK;
    } else {
      process.env.DO_NOT_TRACK = originalDoNotTrack;
    }
    if (originalTestEvents === undefined) {
      delete process.env.PM_TELEMETRY_SEND_TEST_EVENTS;
    } else {
      process.env.PM_TELEMETRY_SEND_TEST_EVENTS = originalTestEvents;
    }
    restoreTty();
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    if (originalPrompt === undefined) {
      delete process.env.PM_TELEMETRY_PROMPT;
    } else {
      process.env.PM_TELEMETRY_PROMPT = originalPrompt;
    }
  }
}

describe("core/telemetry/consent", () => {
  afterEach(() => {
    if (originalGlobalPath === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = originalGlobalPath;
    }
    promptState.questionImpl = async () => "";
  });

  it.each(["action", "namespace"])("skips eligible interactive consent for %s preview flags and persists it during ordinary apply", async (flagOwner) => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["create", "task", "Consent boundary", "--id", "consent-preview", "--json"]).code).toBe(0);
      if (flagOwner === "namespace") {
        await writeTestExtension({
          root: context.pmPath,
          placement: "projectRoot",
          directory: "consent-preview-flags",
          entryFilename: "index.mjs",
          manifestOverrides: { capabilities: ["schema"], activation: { commands: ["item"] } },
          entrySource: 'export default { activate(api) { api.registerFlags("item", [{ long: "--dry-run" }]); } };',
        });
      }
      const globalRoot = context.env.PM_GLOBAL_PATH!;
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = false;
      settings.telemetry.first_run_prompt_completed = false;
      await writeSettings(globalRoot, settings, "test:eligible-consent");
      const before = await fs.readFile(getSettingsPath(globalRoot), "utf8");
      let prompts = 0;
      promptState.questionImpl = async () => { prompts += 1; return "n"; };
      await withInteractiveEnv(async () => {
        const env = {
          ...context.env,
          PM_TELEMETRY_DISABLED: "0",
          PM_NO_TELEMETRY: "0",
          PM_TELEMETRY_SEND_TEST_EVENTS: "1",
          DO_NOT_TRACK: "0",
          PM_TELEMETRY_PROMPT: undefined,
          CI: undefined,
        };
        const args = ["item", "complete", "pm-consent-preview", "Delivered", "--transaction-id", "consent-boundary", "--validate-close", "off", ...(flagOwner === "action" ? ["--no-extensions"] : [])];
        const previewArgs = flagOwner === "namespace" ? [args[0]!, "--dry-run", ...args.slice(1)] : [...args, "--dry-run"];
        const preview = await runInProcessDistCli(previewArgs, { env }, runPmCli);
        expect(preview.code).toBe(0);
        expect(prompts).toBe(0);
        expect(await fs.readFile(getSettingsPath(globalRoot), "utf8")).toBe(before);
        const applied = await runInProcessDistCli(args, { env }, runPmCli);
        expect(applied.code).toBe(0);
        expect(prompts).toBe(1);
        expect(await readSettings(globalRoot)).toMatchObject({ telemetry: { enabled: false, first_run_prompt_completed: true } });
      });
    });
  });

  it("skips prompt and leaves settings untouched in non-interactive environments", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await withInteractiveEnv(async () => {
        setTty(false);
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
      });

      await expect(fs.access(path.join(globalRoot, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("skips the prompt for json/quiet output, env opt-out, CI, and skipped commands", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await withInteractiveEnv(async () => {
        await maybeRunFirstUseTelemetryPrompt("list", { ...baseGlobalOptions, json: true });
        await maybeRunFirstUseTelemetryPrompt("list", { ...baseGlobalOptions, quiet: true });
        await maybeRunFirstUseTelemetryPrompt("", baseGlobalOptions);
        await maybeRunFirstUseTelemetryPrompt("completion", baseGlobalOptions);

        process.env.PM_TELEMETRY_PROMPT = "off";
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
        delete process.env.PM_TELEMETRY_PROMPT;

        // pm-0hx2: the CI guard skips the prompt when CI is set to a truthy
        // value (CI=true, CI=1, ...), matching common CI conventions.
        process.env.CI = "true";
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
        process.env.CI = "1";
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
        delete process.env.CI;
      });

      await expect(fs.access(path.join(globalRoot, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("still prompts when CI is explicitly falsy or empty (treated as not-CI)", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      promptState.questionImpl = async () => "n";
      await withInteractiveEnv(async () => {
        // pm-0hx2: CI=false/0/no/off and CI="" behave like an unset CI — the
        // first interactive invocation runs the prompt and persists the answer.
        process.env.CI = "false";
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
        delete process.env.CI;
      });
      let settings = await readSettings(globalRoot);
      expect(settings.telemetry.enabled).toBe(false);
      expect(settings.telemetry.first_run_prompt_completed).toBe(true);

      settings.telemetry.first_run_prompt_completed = false;
      await writeSettings(globalRoot, settings, "test:reset-consent");
      promptState.questionImpl = async () => "y";
      await withInteractiveEnv(async () => {
        process.env.CI = "";
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
        delete process.env.CI;
      });
      settings = await readSettings(globalRoot);
      expect(settings.telemetry.enabled).toBe(true);
      expect(settings.telemetry.first_run_prompt_completed).toBe(true);
    });
  });

  it("persists an explicit opt-out answer on first interactive use", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      promptState.questionImpl = async () => "n";
      await withInteractiveEnv(async () => {
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
      });

      const settings = await readSettings(globalRoot);
      expect(settings.telemetry.enabled).toBe(false);
      expect(settings.telemetry.first_run_prompt_completed).toBe(true);
      expect(promptState.closed).toBeGreaterThan(0);
    });
  });

  it("keeps the default enablement for empty answers and accepts affirmative input", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      promptState.questionImpl = async () => "   ";
      await withInteractiveEnv(async () => {
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
      });
      let settings = await readSettings(globalRoot);
      expect(settings.telemetry.first_run_prompt_completed).toBe(true);
      const defaultEnabled = settings.telemetry.enabled;

      // Reset completion and answer affirmatively this time.
      settings.telemetry.first_run_prompt_completed = false;
      settings.telemetry.enabled = false;
      await writeSettings(globalRoot, settings, "test:reset-consent");
      promptState.questionImpl = async () => "yes";
      await withInteractiveEnv(async () => {
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
      });
      settings = await readSettings(globalRoot);
      expect(settings.telemetry.enabled).toBe(true);
      expect(typeof defaultEnabled).toBe("boolean");
    });
  });

  it("returns without prompting again once the first-run prompt completed", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      promptState.questionImpl = async () => "n";
      await withInteractiveEnv(async () => {
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
      });
      promptState.questionImpl = async () => {
        throw new Error("prompt must not run twice");
      };
      await withInteractiveEnv(async () => {
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
      });
      const settings = await readSettings(globalRoot);
      expect(settings.telemetry.enabled).toBe(false);
    });
  });

  it("never blocks command execution when the prompt itself fails", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      promptState.questionImpl = async () => {
        throw new Error("stdin closed");
      };
      await withInteractiveEnv(async () => {
        await expect(maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions)).resolves.toBeUndefined();
      });

      await expect(fs.access(path.join(globalRoot, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
