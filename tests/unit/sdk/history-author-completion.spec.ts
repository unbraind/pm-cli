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

  it("lists every Bash completion flag once", () => {
    const commandBlock =
      generateBashScript().match(
        /history-author-acknowledge\)[\s\S]*?\n\s*;;/u,
      )?.[0] ?? "";
    const completionWords =
      commandBlock
        .match(/compgen -W "([^"]*)"/u)?.[1]
        ?.split(/\s+/u)
        .filter((value) => value.length > 0) ?? [];
    expect(completionWords).toContain("--plan-fingerprint");
    expect(completionWords).toContain("--json");
    expect(completionWords).toHaveLength(new Set(completionWords).size);
  });
});
