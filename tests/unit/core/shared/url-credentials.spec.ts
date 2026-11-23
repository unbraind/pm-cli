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
    ["slash-backslash credential URL in a query", String.raw`https://public.example/?next=/\Zq8vN3kLmP0wXy7Ab@host.invalid/repo`, "https://[redacted]@host.invalid/repo"],
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
    // pm-ziv9yb: a runtime array field mapped onto a collection carries nested authors.
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ comments: [{ author: "https://u:p@h", text: "x" }] })).toThrow(/author must not/u);
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ comments: [{ author: "agent-a", text: "https://u:p@h" }] })).not.toThrow();
    for (const [collection, path] of [
      ["notes", ["author"]],
      ["learnings", ["author"]],
      ["dependencies", ["author"]],
      ["plan_decisions", ["author"]],
      ["plan_discoveries", ["author"]],
      ["plan_steps", ["owner"]],
      ["tests", ["provenance", "author"]],
      // pm-7ivxas: the last-edit author of a linked test.
      ["tests", ["updated_by"]],
    ] as const) {
      const entry = path.reduceRight<unknown>((leaf, key) => ({ [key]: leaf }), "https://u:p@h");
      expect(() => assertIdentityFieldsWithoutUrlCredentials({ [collection]: [{ id: "x" }, entry] })).toThrow(
        new RegExp(`^${collection}\\[1\\]\\.${path.join("\\.")} must not`, "u"),
      );
    }
    // Codex on PR 1714: an `author` key in a linked test's assertion map is test data, not an identity.
    const assertionMap = { tests: [{ command: "node t.mjs", assert_json_field_equals: { author: "https://example.com:8443/profile/@alice" } }] };
    expect(() => assertIdentityFieldsWithoutUrlCredentials(assertionMap)).not.toThrow();
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ audit_details: { author: "https://u:p@h" } })).not.toThrow();
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ tests: [{ provenance: "x" }, null], comments: {} })).not.toThrow();
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ note: null, count: 3, tags: ["a"] })).not.toThrow();
    // A container stored at an identity location is identity data throughout, to a bounded depth.
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ author: { author: "https://u:p@h" } })).toThrow(/^author must not/u);
    expect(() => assertIdentityFieldsWithoutUrlCredentials({ assignee: [["https://u:p@h"]] })).toThrow(/^assignee must not/u);
    const deep = { author: { a: { b: { c: { d: { e: "https://u:p@h" } } } } } };
    expect(() => assertIdentityFieldsWithoutUrlCredentials(deep)).not.toThrow();
  });

  it("redacts each whitespace-delimited word of free text and skips text without an at sign", () => {
    expect(redactUrlCredentialsInText("fetch https://u:p@registry:8080/x failed; mail me@example.com"))
      .toBe("fetch https://[redacted]@registry:8080/x failed; mail me@example.com");
    expect(redactUrlCredentialsInText("Error: nothing to see\n")).toBe("Error: nothing to see\n");
    expect(redactUrlCredentialsInText("cloning ssh://secret123%40host/repo failed")).toBe("cloning ssh://[redacted]%40host/repo failed");
    expect(redactUrlCredentialsInText("one\thttps://t@h/x\ntwo")).toBe("one\thttps://[redacted]@h/x\ntwo");
  });

  it.each([
    ["an encoded at sign (GH-1773)", "blocked by https://fixture:fake words%40example.invalid/path today", "blocked by https://[redacted]%40example.invalid/path today"],
    ["a plain at sign", "https://fixture:fake words@example.invalid/path", "https://[redacted]@example.invalid/path"],
    ["several blanks and words", "https://user:pa ss wo rd@host/x", "https://[redacted]@host/x"],
    ["a blank right after the separator", "https://user: pass@host", "https://[redacted]@host"],
    ["a tab", "a https://user:p\tq@host b", "a https://[redacted]@host b"],
    ["a line break, which URL parsers drop", "https://user:pass\nword@host", "https://[redacted]@host"],
    ["a non-special scheme", "git+ssh://u:p w%40h:repo", "git+ssh://[redacted]%40h:repo"],
    ["two URLs in one text", "https://u:p w%40h/x https://a:b c@d", "https://[redacted]%40h/x https://[redacted]@d"],
    // Codex review round 1 on the GH-1773 change.
    ["an encoded at sign inside the password", "https://ci:pa%40ss words@example.invalid", "https://[redacted]@example.invalid"],
    ["an at sign inside a later word of the password", "https://ci:pa word@ss rest@example.invalid", "https://[redacted]@example.invalid"],
    ["a long query after the host", `https://ci:some words@example.invalid/download?state=${"a".repeat(600)}`, `https://[redacted]@example.invalid/download?state=${"a".repeat(600)}`],
    ["a password holding a colon and digits", "https://ci:pincode:1234 suffix@example.invalid", "https://[redacted]@example.invalid"],
    ["a spaced username", "https://service account:pass phrase@example.invalid", "https://[redacted]@example.invalid"],
    ["a spaced username whose password word holds the at sign", "https://service account:pass@example.invalid", "https://[redacted]@example.invalid"],
    ["extra authority slashes", "https:///ci:pass words@example.invalid", "https://[redacted]@example.invalid"],
    // Codex review round 2.
    ["a redirect URL in the query", "https://ci:fake words@example.invalid/download?next=https://docs.example.invalid", "https://[redacted]@example.invalid/download?next=https://docs.example.invalid"],
    ["a redirect URL after an encoded at sign", "https://ci:fake words%40example.invalid/a?next=https://docs.example.invalid", "https://[redacted]%40example.invalid/a?next=https://docs.example.invalid"],
    ["a dotted spaced username", "https://jane.doe account:fake words@example.invalid/private", "https://[redacted]@example.invalid/private"],
    ["a password that starts with digits", "https://ci:123456 words@example.invalid/private", "https://[redacted]@example.invalid/private"],
    ["a quoted URL", '"https://ci:pa ss@host"', '"https://[redacted]@host"'],
    // Greptile review round 1: URL parsers drop a tab after the authority slashes.
    ["a tab before the username", "https://\tu:pass words@host/x", "https://[redacted]@host/x"],
    ["a line break before a spaced username", "https://\nservice account:pass@host/x", "https://[redacted]@host/x"],
    // Codex review round 3.
    ["a compact JSON field before the URL", '{"url":"https://ci:demo pass@example.invalid"}', '{"url":[redacted]@example.invalid"}'],
    ["an apostrophe inside the password", "https://ci:O'Brian Pass@example.invalid", "https://[redacted]@example.invalid"],
    ["an apostrophe in a later password word", "https://ci:old pass'word@example.invalid", "https://[redacted]@example.invalid"],
    ["a percent escape in the first username word", "https://build%2Dteam\taccount:demo pass@example.invalid", "https://[redacted]@example.invalid"],
    ["a password colon before a tab", "https://service\taccount:\tDemoPass7@example.invalid", "https://[redacted]@example.invalid"],
    ["an encoded at sign that starts inside the bound", `https://x:demo ${"a".repeat(510)}%40host`, "https://[redacted]%40host"],
    // Codex review round 4.
    ["a redirect query without a path", "https://ci:demo words@registry.example.invalid?next=https://docs.example.invalid", "https://[redacted]@registry.example.invalid?next=https://docs.example.invalid"],
    ["a quoted pathless URL with a spaced password colon", '"https://Build Team: demo-pass@registry.example.invalid"', '"https://[redacted]@registry.example.invalid"'],
    // Codex review round 5.
    ["a credential URL nested in a public URL's query", "https://public.invalid/login?next=https://build:demo pass@private.invalid/repo", "https://[redacted]@private.invalid/repo"],
    ["a URL in parentheses", "See (https://ci:demo pass@host.invalid/x) now", "See (https://[redacted]@host.invalid/x) now"],
    // CodeRabbit: the escape at offsets 510 and 511 after the opening word starts inside the bound.
    ["an encoded at sign at offset 510", `https://x:demo ${"a".repeat(509)}%40host`, "https://[redacted]%40host"],
    // Greptile review round 2.
    ["an apostrophe in the first password word", "https://u:pa'ss words@host/x", "https://[redacted]@host/x"],
    ["a spaced colon before a host with a path", "https://service account: secret@host/x", "https://[redacted]@host/x"],
  ])("removes URL userinfo that holds whitespace across words: %s", (_case, text, expected) => {
    expect(redactUrlCredentialsInText(text)).toBe(expected);
    expect(redactUrlCredentialsInText(expected)).toBe(expected);
  });

  it.each([
    ["a host and port before prose", "https://example.com:8080 ping @bob"],
    ["a plain host before prose", "see https://example.com and ping @bob"],
    ["a bracketed IPv6 host", "https://[::1] x@y"],
    ["an authority with a path", "https://user:pass/x more@words"],
    ["another URL before the at sign", "https://user:pass w https://x/ y@z"],
    ["no at sign after the opening word", "x https://user:pass word"],
    ["more words than the bound", `https://u:p ${"a ".repeat(16)}r@h`],
    ["a span longer than the bound", `https://u:p ${"a".repeat(600)}@h`],
    ["a blank run longer than the bound", `https://u:p ${" ".repeat(600)}x@h`],
    ["slashes not at the scheme separator", "user:pass words@host"],
    ["a colon only in a public URL's query", "See https://example.com?time=12:30Z or email ops@example.org"],
    ["a later public URL holding an at sign", "Compare https://ci:1234-beta with https://example.org/package/@scope/name"],
    ["a single-label host before prose", "https://localhost and ping @bob"],
    ["a single-label host before prose with a colon after the at sign", "https://intranet ping @bob: now"],
    ["a quoted URL before prose with a colon", 'See "https://intranet" and email support: ops@example.org.'],
    ["a dotted host before prose with a colon", "Visit https://example.com and email support: ops@example.org"],
    ["a localhost port before prose", "https://localhost:3000 ping @bob"],
    ["a bare scheme before prose", "See https:// for details, email me@example.org"],
    ["a bare scheme ending the text", "x https://"],
    ["a bare scheme before more slashes", "https:// // x@y"],
    ["a bare scheme ending text that holds an earlier at sign", "mail me@example.org at https://"],
    ["an authority that starts with a query", "https://?q=1 user x:y me@example.org"],
    ["a path word before the at sign", "https://ci:pa ss /x@y"],
    ["a bare scheme before a host and port", "https://\texample.com:8080 ping @bob"],
    ["a clock time in prose", "See https://example.com at 09:30 and ping @oncall"],
    ["a Windows drive path before an error code and a mention", "Log output C:/Temp (code:ENOENT), fix and notify @admin"],
    ["a Markdown link before prose with a colon and a mention", "See [docs](https://example.invalid) status:404 then ping @oncall."],
    ["a later public URL in parentheses", "Compare https://ci:1234-beta with (https://example.org/package/@scope/name)"],
    ["a colon that a space follows", "https://service account: ping @oncall"],
    ["a trailing colon ending the text", "https://service account:"],
    ["a spaced colon before an email address", "https://service and email support: ops@example.org"],
    ["an encoded at sign at offset 512, past the bound", `https://x:demo ${"a".repeat(511)}%40host`],
    ["an encoded at sign that starts past the bound", `https://x:demo ${"a".repeat(512)}%40host`],
  ])("leaves text alone when no whitespace-bearing userinfo opens: %s", (_case, text) => {
    expect(redactUrlCredentialsInText(text)).toBe(text);
  });

  it("leaves a username at sign in the opening word to the word rule", () => {
    // A first word with an at sign but no colon opens no join; the word rule masks its bare userinfo.
    expect(redactUrlCredentialsInText("https://user@host and email x:y me@example.org")).toBe("https://[redacted]@host and email x:y me@example.org");
  });

  it("redacts a joined URL exactly as the same URL without blanks", () => {
    // The token rule masks through the last at sign by design (GH-1707: a base64 password may hold `/`).
    const joined = redactUrlCredentialsInText("https://ci:fake words@example.invalid/npm/@scope/pkg");
    expect(joined).toBe(redactUrlCredentialsInToken("https://ci:fakewords@example.invalid/npm/@scope/pkg"));
    expect(joined).not.toContain("fake");
  });

  it("judges a huge dotted host without exhausting the regex stack", () => {
    const text = `https://${"a.".repeat(4_000_000)}a:443 note @alice`;
    expect(() => redactUrlCredentialsInText(text)).not.toThrow();
  });

  it("stays linear over many opening words before a later at sign", () => {
    const text = `${`See https://intranet ${"A".repeat(500)}\n`.repeat(4_000)}Contact ops@example.org`;
    const started = performance.now();
    expect(redactUrlCredentialsInText(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(2_000);
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
