import { describe, expect, it } from "vitest";
import { quoteCommandArg } from "../../../../src/core/shared/command-line.js";
import {
  URL_CREDENTIAL_PLACEHOLDER,
  assertIdentityFieldsWithoutUrlCredentials,
  assertIdentityWithoutUrlCredentials,
  invocationCarriesUrlCredentials,
  redactIdentityCredentials,
  redactIdentityFields,
  redactOptionalIdentityCredentials,
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
    ["slash inside a base64 password (GH-1707)", "https://user:abc/def+gh==@host/x", "https://[redacted]@host/x"],
    ["bare token userinfo (GH-1707)", "https://ghp_xxx@github.com/o/r", "https://[redacted]@github.com/o/r"],
    ["several colons in the password (GH-1707)", "https://user:pa:ss@host", "https://[redacted]@host"],
    ["query delimiter inside a password", "https://user:pa?ss@host/x", "https://[redacted]@host/x"],
    ["tab before the authority slashes", "https:\t//secret123@localhost/x", "https:[redacted]@localhost/x"],
    ["credential URL nested in a public URL's query", "https://public.example/?next=https://u:secret123@localhost", "https://[redacted]@localhost"],
    ["password holding both an at sign and a slash", "https://u:ab@cd/efGHIJKL@localhost/x", "https://[redacted]@localhost/x"],
    ["SSH userinfo holding a question mark", "ssh://Zq8vN3k?LmP0wXy7Ab@github.com/repo", "ssh://[redacted]@github.com/repo"],
    ["SSH userinfo holding a hash", "ssh://Zq8vN3k#LmP0wXy7Ab@github.com/repo", "ssh://[redacted]@github.com/repo"],
    ["percent-encoded at sign in the authority", "ssh://Zq8vN3kLmP0wXy7Ab%40github.com/repo@v1", "ssh://[redacted]@v1"],
    ["only a percent-encoded at sign", "ssh://secret123%40host/repo", "ssh://[redacted]%40host/repo"],
    ["SSH userinfo holding a slash", "ssh://Zq8vN3k/LmP0wXy7Ab@host.invalid", "ssh://[redacted]@host.invalid"],
    ["scheme-relative credential URL in a query", "https://public.example/?next=//Zq8vN3kLmP0wXy7Ab@host.invalid/repo", "https://[redacted]@host.invalid/repo"],
  ])("removes every possible userinfo span: %s", (_label, token, expected) => {
    expect(redactUrlCredentialsInToken(token)).toBe(expected);
    expect(redactUrlCredentialsInToken(expected)).toBe(expected);
  });

  it.each([
    ["no at sign", "https://example.invalid/x.tgz"],
    ["no colon", "@scope/package@1.2.3"],
    ["colon after the last at sign", "git@github.com:org/repo.git"],
    ["empty userinfo", "https://@host/x"],
    ["scoped package path (GH-1707)", "https://www.npmjs.com/package/@unbrained/pm-cli"],
    ["at sign in a blob path (GH-1707)", "https://github.com/unbraind/pm-cli/blob/main/x@y.md"],
    ["at sign in a query", "https://example.com/search?q=a@b"],
    ["at sign in a fragment", "https://example.com/doc#@anchor"],
  ])("leaves a token without a userinfo span unchanged: %s", (_label, token) => {
    expect(redactUrlCredentialsInToken(token)).toBe(token);
  });

  it("documents the remaining conservative cost: anything not provably public is hidden", () => {
    expect(redactUrlCredentialsInToken("https://host:8080/a@b")).toBe(`https://${URL_CREDENTIAL_PLACEHOLDER}@b`);
    expect(redactUrlCredentialsInToken("Reminder: ping @bob")).toBe(`Reminder:${URL_CREDENTIAL_PLACEHOLDER}@bob`);
    expect(redactUrlCredentialsInToken("alias@npm:@scope/pkg@1.0.0")).toBe(`alias@npm:${URL_CREDENTIAL_PLACEHOLDER}@1.0.0`);
  });

  it("judges an identity as one value, so whitespace inside its userinfo cannot split it (GH-1707)", () => {
    expect(redactIdentityCredentials("https://bot:pass word@registry.example.invalid")).toBe("https://[redacted]@registry.example.invalid");
    expect(redactIdentityCredentials("harness:claude-code")).toBe("harness:claude-code");
    expect(redactIdentityCredentials("alice@example.com")).toBe("alice@example.com");
    expect(redactOptionalIdentityCredentials("https://u:p@h")).toBe("https://[redacted]@h");
    expect(redactOptionalIdentityCredentials(undefined)).toBeUndefined();
    expect(redactOptionalIdentityCredentials(null)).toBeNull();
  });

  it("redacts every string identity field a runtime or registered field value sets (GH-1707)", () => {
    const values = { author: "https://a:p@h", assignee: "https://b:q@h", claim_principal: "https://c:r@h", reviewer: "https://d:s@h", count: 3 };
    expect(redactIdentityFields(values)).toEqual({
      author: "https://[redacted]@h", assignee: "https://[redacted]@h", claim_principal: "https://[redacted]@h",
      reviewer: "https://d:s@h", count: 3,
    });
    expect(values.author).toBe("https://a:p@h");
    expect(redactIdentityFields({ assignee: 7 })).toEqual({ assignee: 7 });
  });

  it("refuses an identity carrying URL userinfo and names only its source (GH-1707)", () => {
    expect(() => assertIdentityWithoutUrlCredentials("https://u:hunter2@h", "--assignee")).toThrow(/--assignee must not carry URL credentials/u);
    expect(() => assertIdentityWithoutUrlCredentials("https://u:hunter2@h", "--assignee")).not.toThrow(/hunter2/u);
    expect(() => assertIdentityWithoutUrlCredentials("alice@example.com", "--assignee")).not.toThrow();
    expect(() => assertIdentityWithoutUrlCredentials("ssh://secret123%40host/repo", "--author")).toThrow(/--author must not/u);
    // A percent escape is never provably public, so an encoded at sign is refused conservatively.
    expect(() => assertIdentityWithoutUrlCredentials("https://example.com/a%40b", "--author")).toThrow(/--author must not/u);
    expect(() => assertIdentityWithoutUrlCredentials(undefined, "--assignee")).not.toThrow();
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ assignee: "https://t@h", note: "https://u:p@h" })).toThrow(/assignee must not/u);
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ note: "https://u:p@h" })).not.toThrow();
  });

  it("redacts each whitespace-delimited word of free text and skips text without an at sign", () => {
    expect(redactUrlCredentialsInText("fetch https://u:p@registry:8080/x failed; mail me@example.com"))
      .toBe("fetch https://[redacted]@registry:8080/x failed; mail me@example.com");
    expect(redactUrlCredentialsInText("Error: nothing to see\n")).toBe("Error: nothing to see\n");
    expect(redactUrlCredentialsInText("cloning ssh://secret123%40host/repo failed")).toBe("cloning ssh://[redacted]%40host/repo failed");
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

  it("still matches a short secret whole after a long one widened the fragments", () => {
    let state = 7;
    const long = Array.from({ length: 460_000 }, () => {
      state = (state * 48_271) % 2_147_483_647;
      return "abcdefghijklmnopqrstuvwxyz0123456789"[state % 36];
    }).join("");
    runWithUrlCredentialInvocation([`https://u:${long}@h/x`, "https://u:Sh0rtS@h/y"], () => {
      expect(redactUrlCredentialsInText("cut xSh0rtSx refused")).toBe("cut x[redacted]x refused");
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
