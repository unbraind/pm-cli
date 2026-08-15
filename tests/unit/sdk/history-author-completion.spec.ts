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
  ])("publishes the plan handshake in %s", (_shell, generate, fingerprint) => {
    const script = generate();
    expect(script).toContain("history-author-acknowledge");
    expect(script).toContain(fingerprint);
  });
});
