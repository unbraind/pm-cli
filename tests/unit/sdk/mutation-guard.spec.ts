import { describe, expect, it } from "vitest";
import {
  evaluateMutationGuard,
  isMutationAction,
  listMutationActions,
  scanMutationSecrets,
} from "../../../src/sdk/index.js";
import { PmCliError } from "../../../src/core/shared/errors.js";

const settings = {
  require_attributed_author: false,
  secret_guard: "advise" as const,
  stale_in_progress_hours: 72,
};
const GITHUB_TOKEN_SAMPLE = ["gh", "p_", "123456789012345678901234567890"].join(
  "",
);
const AWS_ACCESS_KEY_SAMPLE = ["AK", "IA1234567890ABCDEF"].join("");
const PRIVATE_KEY_SAMPLE = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

describe("SDK mutation guard", () => {
  it("publishes a stable mutation inventory without read actions", () => {
    const actions = listMutationActions();
    expect(actions).toEqual([...actions].sort());
    expect(actions).toContain("create");
    expect(actions).toContain("history-redact");
    expect(actions.every(isMutationAction)).toBe(true);
    expect(isMutationAction(" search ")).toBe(false);
  });

  it("detects credential shapes with redacted object paths only", () => {
    expect(
      scanMutationSecrets({
        github: GITHUB_TOKEN_SAMPLE,
        aws: AWS_ACCESS_KEY_SAMPLE,
        key: PRIVATE_KEY_SAMPLE,
        nested: { value: "api_key=AbCdEfGhIjKlMnOpQrStUvWxYz012345" },
      }),
    ).toEqual([
      { rule: "github_token", path: "$.github" },
      { rule: "aws_access_key", path: "$.aws" },
      { rule: "private_key", path: "$.key" },
      { rule: "high_entropy_assignment", path: "$.nested.value" },
    ]);
    expect(
      scanMutationSecrets({
        repeated: "token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toEqual([]);
  });

  it("advises, blocks, overrides, and disables through one contract", () => {
    const payload = { token: GITHUB_TOKEN_SAMPLE };
    expect(
      evaluateMutationGuard({ author: "agent", payload, settings }),
    ).toMatchObject({
      warnings: ["secret_guard_detected:1:rules=github_token"],
      override_applied: false,
    });
    expect(() =>
      evaluateMutationGuard({
        author: "agent",
        payload,
        settings: { ...settings, secret_guard: "block" },
      }),
    ).toThrow(PmCliError);
    expect(
      evaluateMutationGuard({
        author: "agent",
        payload,
        force: true,
        settings: { ...settings, secret_guard: "block" },
      }),
    ).toMatchObject({
      warnings: [
        "secret_guard_detected:1:rules=github_token",
        "secret_guard_force_override",
      ],
      override_applied: true,
    });
    expect(
      evaluateMutationGuard({
        author: "agent",
        payload,
        settings: { ...settings, secret_guard: "off" },
      }),
    ).toMatchObject({ findings: [], warnings: [] });
  });

  it("enforces attributed authors and fails open on hostile payload getters", () => {
    expect(() =>
      evaluateMutationGuard({
        author: "unknown",
        payload: {},
        settings: { ...settings, require_attributed_author: true },
      }),
    ).toThrow("Mutation author is required");
    expect(
      evaluateMutationGuard({ author: " ", payload: {}, settings }),
    ).toMatchObject({ author: "unknown" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      evaluateMutationGuard({ author: "agent", payload: cyclic, settings }),
    ).toMatchObject({ findings: [], warnings: [] });
    const hostile = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });
    expect(
      evaluateMutationGuard({ author: "agent", payload: hostile, settings }),
    ).toMatchObject({ warnings: ["secret_guard_scan_failed_open"] });
  });
});
