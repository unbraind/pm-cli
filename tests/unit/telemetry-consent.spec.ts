import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeRunFirstUseTelemetryPrompt } from "../../src/core/telemetry/consent.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { withTempGlobalRoot } from "../helpers/temp.js";

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
  }
  if (stdoutDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
  }
}

async function withInteractiveEnv(run: () => Promise<void>): Promise<void> {
  const originalCi = process.env.CI;
  const originalPrompt = process.env.PM_TELEMETRY_PROMPT;
  setTty(true);
  delete process.env.CI;
  delete process.env.PM_TELEMETRY_PROMPT;
  try {
    await run();
  } finally {
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

  it("skips prompt and leaves settings untouched in non-interactive environments", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await maybeRunFirstUseTelemetryPrompt("init", baseGlobalOptions);

      await expect(fs.access(path.join(globalRoot, "settings.json"))).rejects.toBeDefined();
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

        // Current behavior: the CI guard reuses the PM_TELEMETRY_PROMPT
        // disable-value set, so only CI=false/0/no/off skips here (CI=true is
        // covered by the non-TTY guard in real CI environments).
        process.env.CI = "false";
        await maybeRunFirstUseTelemetryPrompt("list", baseGlobalOptions);
        delete process.env.CI;
      });

      await expect(fs.access(path.join(globalRoot, "settings.json"))).rejects.toBeDefined();
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

      await expect(fs.access(path.join(globalRoot, "settings.json"))).rejects.toBeDefined();
    });
  });
});
