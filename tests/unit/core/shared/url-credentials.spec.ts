import { describe, expect, it } from "vitest";
import { quoteCommandArg } from "../../../../src/core/shared/command-line.js";
import {
  URL_CREDENTIAL_PLACEHOLDER,
  invocationCarriesUrlCredentials,
  redactUrlCredentialsInText,
  redactUrlCredentialsInToken,
  runWithUrlCredentialInvocation,
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
    ["backslashes as non-special userinfo", `git+ssh://${"\\".repeat(8)}@localhost/x`, "git+ssh://[redacted]@localhost/x"],
    ["slashes beyond the two authority delimiters", "file:///@x", "file://[redacted]@x"],
  ])("removes every possible userinfo span: %s", (_label, token, expected) => {
    expect(redactUrlCredentialsInToken(token)).toBe(expected);
    expect(redactUrlCredentialsInToken(expected)).toBe(expected);
  });

  it.each([
    ["no at sign", "https://example.invalid/x.tgz"],
    ["no colon", "@scope/package@1.2.3"],
    ["colon after the last at sign", "git@github.com:org/repo.git"],
    ["empty userinfo", "https://@host/x"],
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

  it("removes a registered whitespace-bearing span in any case, layout, shell or JSON escaping", () => {
    const token = 'https://U:my "pass\\$x\tmore@localhost/x';
    runWithUrlCredentialInvocation(["package", "install", token, "https://user@host/x"], () => {
      expect(invocationCarriesUrlCredentials()).toBe(true);
      for (const echo of [
        `unknown command '${token}'`,
        `unknown command '${token.toLowerCase()}'`,
        `pm package install ${quoteCommandArg(token, "linux")}`,
        `pm package install ${quoteCommandArg(token, "win32")}`,
        `Invalid --expect-hash ${JSON.stringify(token)}`,
        'truncated: U:MY "PASS\\$X\tMORE',
      ]) {
        expect(redactUrlCredentialsInText(echo)).not.toMatch(/my |pass/iu);
      }
      expect(redactUrlCredentialsInText("ordinary users and user names")).toBe("ordinary users and user names");
    });
    expect(invocationCarriesUrlCredentials()).toBe(false);
  });

  it("protects a short whitespace-bearing span and keeps dollar sequences literal", () => {
    runWithUrlCredentialInvocation(["https://x y@localhost/x", "https://u:my pass$&@localhost/x"], () => {
      expect(redactUrlCredentialsInText("unknown command 'https://x y@localhost/x'")).toBe("unknown command 'https://[redacted]@localhost/x'");
      expect(redactUrlCredentialsInText("refused https://u:my pass$&@localhost/x")).toBe("refused https://[redacted]@localhost/x");
    });
  });

  it("keeps overlapping invocations' registrations apart", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runWithUrlCredentialInvocation(["https://u:my pass@localhost/x"], async () => {
      await gate;
      return redactUrlCredentialsInText("echo https://U:my pass@localhost/x");
    });
    const second = runWithUrlCredentialInvocation(["--version"], async () => {
      release();
      return invocationCarriesUrlCredentials();
    });
    expect(await second).toBe(false);
    expect(await first).toBe("echo https://[redacted]@localhost/x");
  });

  it("removes split, truncated and re-cased echoes of a registered secret, leaving at most five characters", () => {
    runWithUrlCredentialInvocation(["--expect-hash", "https://git:Tok3nSecretValue,rest@localhost/x"], () => {
      for (const echo of [
        'Invalid expected revision "https://git:Tok3nSecretValue"',
        "rest@localhost/x is not a revision",
        "truncated TOK3NSECR",
        "split tok3n secretvalue",
      ]) {
        expect(redactUrlCredentialsInText(echo)).not.toMatch(/tok3nse|secretv|cretva/iu);
      }
      // The username is not the secret, and ordinary words stay readable.
      expect(redactUrlCredentialsInText("git restores the token")).toBe("git restores the token");
    });
  });

  it("keeps fragment offsets aligned when lower-casing changes a character's length", () => {
    runWithUrlCredentialInvocation(["https://u:\u0130stanbulSecret9@h/x"], () => {
      expect(redactUrlCredentialsInText("echo \u0130STANBULSECRET9 done")).toBe("echo [redacted] done");
    });
  });

  it("keeps bounded protection for a secret longer than the fragment budget", () => {
    let state = 1;
    const secret = Array.from({ length: 70_000 }, () => {
      state = (state * 48_271) % 2_147_483_647;
      return "abcdefghijklmnopqrstuvwxyz0123456789"[state % 36];
    }).join("");
    runWithUrlCredentialInvocation([`https://u:Synthetic,${secret}@h/x`], () => {
      const echo = secret.slice(30_000, 30_040);
      const redacted = redactUrlCredentialsInText(`revision ${echo} refused`);
      for (let index = 0; index + 7 <= echo.length; index += 1) expect(redacted).not.toContain(echo.slice(index, index + 7));
      expect(redactUrlCredentialsInText("no userinfo here")).toBe("no userinfo here");
    });
  });

  it("records carried credentials without registering spans the word rule already removes", () => {
    runWithUrlCredentialInvocation(["https://tok3n@localhost/x"], () => {
      expect(invocationCarriesUrlCredentials()).toBe(true);
      expect(redactUrlCredentialsInText("tok3n")).toBe("tok3n");
    });
    runWithUrlCredentialInvocation(["list", "--limit", "2"], () => expect(invocationCarriesUrlCredentials()).toBe(false));
  });
});
