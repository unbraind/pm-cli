import { describe, expect, it } from "vitest";
import {
  URL_CREDENTIAL_PLACEHOLDER,
  redactUrlCredentialsInText,
  redactUrlCredentialsInToken,
} from "../../../../src/core/shared/url-credentials.js";

describe("conservative URL credential redaction (pm-nhauur, pm-5htunt)", () => {
  it.each([
    ["password userinfo", "https://u:fake-secret@example.invalid/x.tgz", "https://[redacted]@example.invalid/x.tgz"],
    ["token-only userinfo", "https://tok3n@localhost/x.tgz", "https://[redacted]@localhost/x.tgz"],
    ["host and port", "https://u:p!ss@registry:8080/x", "https://[redacted]@registry:8080/x"],
    ["backslash authority", String.raw`https:\\u:s3cr3t@host/x`, String.raw`https:\\[redacted]@host/x`],
    ["slashless special scheme", "https:u:s3cr3t@host/x", "https:[redacted]@host/x"],
    ["tab inside the scheme", "ht\ttps://u:s3cr3t@host/x", "ht\ttps://[redacted]@host/x"],
    ["wrapper chain", "npm:git+https://u:s3cr3t@host/x.git", "npm:[redacted]@host/x.git"],
    ["inline option value", "--install=https://u:s3cr3t@host/x", "--install=https://[redacted]@host/x"],
    ["whitespace inside userinfo", "https://u:my pass@host/x", "https://[redacted]@host/x"],
    ["several at signs", "https://u:a@b@host/x", "https://[redacted]@host/x"],
  ])("removes every possible userinfo span: %s", (_label, token, expected) => {
    expect(redactUrlCredentialsInToken(token)).toBe(expected);
    expect(redactUrlCredentialsInToken(expected)).toBe(expected);
  });

  it.each([
    ["no at sign", "https://example.invalid/x.tgz"],
    ["no colon", "@scope/package@1.2.3"],
    ["colon after the last at sign", "git@github.com:org/repo.git"],
    ["empty userinfo", "https://@host/x"],
    ["empty userinfo after slashes only", "file:///@x"],
  ])("leaves a token without a userinfo span unchanged: %s", (_label, token) => {
    expect(redactUrlCredentialsInToken(token)).toBe(token);
  });

  it("documents the conservative cost: a scoped package after a colon is hidden too", () => {
    expect(redactUrlCredentialsInToken("alias@npm:@scope/pkg@1.0.0")).toBe(`alias@npm:${URL_CREDENTIAL_PLACEHOLDER}@1.0.0`);
  });

  it("redacts each whitespace-delimited word of free text and skips text without an at sign", () => {
    expect(redactUrlCredentialsInText("fetch https://u:p@registry:8080/x failed; mail me@example.com"))
      .toBe("fetch https://[redacted]@registry:8080/x failed; mail me@example.com");
    expect(redactUrlCredentialsInText("Error: nothing to see\n")).toBe("Error: nothing to see\n");
    expect(redactUrlCredentialsInText("one\thttps://t@h/x\ntwo")).toBe("one\thttps://[redacted]@h/x\ntwo");
  });
});
