/**
 * @module tests/unit/sdk/history-author-completion
 *
 * Verifies that every shell advertises the source-bound preview/apply options.
 */
import { describe, expect, it } from "vitest";
import {
  generateBashScript,
  generateFishScript,
  generateZshScript,
} from "../../../src/sdk/completion.js";

describe("history author acknowledgment completion", () => {
  it.each([
    ["bash", generateBashScript, "--plan-fingerprint"],
    ["zsh", generateZshScript, "--plan-fingerprint"],
    ["fish", generateFishScript, "-l plan-fingerprint"],
  ] as const)("publishes the plan handshake in %s", (shell, generate, fingerprint) => {
    const script = generate();
    const commandBlock =
      shell === "fish"
        ? script
            .split("\n")
            .filter((line) =>
              line.includes("__fish_seen_subcommand_from history-author-acknowledge"),
            )
            .join("\n")
        : (script.match(/history-author-acknowledge\)[\s\S]*?\n\s*;;/u)?.[0] ?? "");
    expect(commandBlock).toContain(fingerprint);
  });
});
