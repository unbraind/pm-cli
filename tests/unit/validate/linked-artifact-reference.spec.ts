import { describe, expect, it } from "vitest";

import { isRemoteLinkedArtifactReference } from "../../../src/core/validate/linked-artifact-reference.js";

describe("isRemoteLinkedArtifactReference", () => {
  it("recognizes https/http URLs as remote references", () => {
    expect(isRemoteLinkedArtifactReference("https://github.com/unbraind/pm-cli/pull/362")).toBe(true);
    expect(isRemoteLinkedArtifactReference("http://example.com/design.md")).toBe(true);
  });

  it("recognizes other scheme:// references as remote", () => {
    expect(isRemoteLinkedArtifactReference("ftp://files.example.com/spec.pdf")).toBe(true);
    expect(isRemoteLinkedArtifactReference("ssh://git@example.com/repo.git")).toBe(true);
    expect(isRemoteLinkedArtifactReference("file://server/share/doc.md")).toBe(true);
  });

  it("trims leading/trailing whitespace before matching", () => {
    expect(isRemoteLinkedArtifactReference("  https://example.com/x  ")).toBe(true);
  });

  it("treats relative and absolute local paths as not remote", () => {
    expect(isRemoteLinkedArtifactReference("src/cli/commands/validate.ts")).toBe(false);
    expect(isRemoteLinkedArtifactReference("./README.md")).toBe(false);
    expect(isRemoteLinkedArtifactReference("/dev/null")).toBe(false);
    expect(isRemoteLinkedArtifactReference("docs/design/spec.md")).toBe(false);
  });

  it("does not mistake a Windows drive path or UNC path for a remote reference", () => {
    expect(isRemoteLinkedArtifactReference("C:/Users/dev/repo/file.ts")).toBe(false);
    expect(isRemoteLinkedArtifactReference("C:\\Users\\dev\\repo\\file.ts")).toBe(false);
    expect(isRemoteLinkedArtifactReference("//server/share/file.ts")).toBe(false);
  });

  it("does not treat a single-letter scheme or a scheme without authority as remote", () => {
    expect(isRemoteLinkedArtifactReference("x://no")).toBe(false);
    expect(isRemoteLinkedArtifactReference("mailto:dev@example.com")).toBe(false);
    expect(isRemoteLinkedArtifactReference("")).toBe(false);
  });
});
