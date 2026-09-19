/**
 * @module sdk/completion
 * Selects shell completion output and installation hints.
 */
import { generateBashScript } from "./completion/bash.js";
import { generateFishScript } from "./completion/fish.js";
import type { CompletionResult,CompletionRuntimeConfig,CompletionShell } from "./completion/shared.js";
import { generateZshScript } from "./completion/zsh.js";
import { EXIT_CODE,PmCliError } from "./runtime-primitives.js";

const VALID_SHELLS: CompletionShell[] = ["bash", "zsh", "fish"];

const SETUP_HINTS: Record<CompletionShell, string> = {
  bash: 'Add to ~/.bashrc or ~/.bash_profile: eval "$(pm completion bash)"',
  zsh: 'Add to ~/.zshrc: eval "$(pm completion zsh)"',
  fish: "Run: pm completion fish > ~/.config/fish/completions/pm.fish",
};

/** Implements run completion for the public runtime surface of this module. */
export function runCompletion(
  shell: string,
  itemTypes: string[] = [],
  tags: string[] = [],
  eagerTagExpansion = false,
  runtime: CompletionRuntimeConfig = {},
): CompletionResult {
  const normalized = shell.trim().toLowerCase();
  if (!VALID_SHELLS.includes(normalized as CompletionShell)) {
    throw new PmCliError(
      `Unknown shell: "${shell}". Supported shells: ${VALID_SHELLS.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  const validShell = normalized as CompletionShell;
  let script: string;
  if (validShell === "bash") {
    script = generateBashScript(itemTypes, tags, eagerTagExpansion, runtime);
  } else if (validShell === "zsh") {
    script = generateZshScript(itemTypes, tags, eagerTagExpansion, runtime);
  } else {
    script = generateFishScript(itemTypes, tags, eagerTagExpansion, runtime);
  }
  return {
    shell: validShell,
    script,
    setup_hint: SETUP_HINTS[validShell],
  };
}
export { generateBashScript } from "./completion/bash.js";
export { generateFishScript } from "./completion/fish.js";
export type { CompletionResult,CompletionRuntimeConfig,CompletionShell } from "./completion/shared.js";
export { generateZshScript } from "./completion/zsh.js";
