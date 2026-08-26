import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PM_MCP_SKILLS_DRAFT_REVISION,
  PM_MCP_SKILLS_EXTENSION,
  PM_MCP_SKILLS_SERVER_CAPABILITY,
  PmMcpProtocolError,
  PmMcpSkillRegistry,
  assertPmMcpSkillsCapability,
  resolveMcpRequestContext,
} from "../../../../src/sdk/index.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-mcp-skills-"));
  roots.push(root);
  return root;
}

async function writeSkill(
  root: string,
  name: string,
  description = `${name} workflow`,
): Promise<void> {
  const directory = path.join(root, ".agents", "skills", name);
  await mkdir(path.join(directory, "references"), { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  owner: unbrained\n---\n\n# ${name}\n`,
    "utf8",
  );
  await writeFile(
    path.join(directory, "references", "DETAIL.md"),
    "# Detail\n",
    "utf8",
  );
}

function context(declaration: unknown) {
  return resolveMcpRequestContext({
    _meta: {
      [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
      [PM_MCP_META_KEYS.clientCapabilities]: {
        extensions: { [PM_MCP_SKILLS_EXTENSION]: declaration },
      },
    },
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Skills over MCP SDK registry", () => {
  it("requires the exact draft revision and optional directory-read capability", () => {
    expect(PM_MCP_SKILLS_DRAFT_REVISION).toContain("SEP-2640@");
    expect(PM_MCP_SKILLS_SERVER_CAPABILITY).toMatchObject({
      status: "draft",
      directoryRead: true,
    });
    expect(() =>
      assertPmMcpSkillsCapability(context(PM_MCP_SKILLS_SERVER_CAPABILITY)),
    ).not.toThrow();
    expect(() =>
      assertPmMcpSkillsCapability(
        context(PM_MCP_SKILLS_SERVER_CAPABILITY),
        true,
      ),
    ).not.toThrow();
    for (const declaration of [undefined, null, {}, { revision: "latest" }]) {
      expect(() => assertPmMcpSkillsCapability(context(declaration))).toThrow(
        PmMcpProtocolError,
      );
    }
    expect(() =>
      assertPmMcpSkillsCapability(
        context({ revision: PM_MCP_SKILLS_DRAFT_REVISION }),
        true,
      ),
    ).toThrow(PmMcpProtocolError);
  });

  it("lists deterministic descriptors, paginates opaquely, and binds exact digests", async () => {
    const root = await tempRoot();
    await writeSkill(root, "pm-user");
    await writeSkill(root, "pm-developer");
    await writeFile(
      path.join(root, ".agents", "skills", "pm-developer", "asset.bin"),
      Buffer.from([0xff, 0x00, 0xfe]),
    );
    await writeFile(
      path.join(root, ".agents", "skills", "pm-developer", "plain.txt"),
      "plain text\n",
      "utf8",
    );
    const registry = await PmMcpSkillRegistry.load({
      packageRoot: root,
      packageVersion: "2026.8.26",
    });
    const first = registry.list({ limit: 1 });
    expect(first).toMatchObject({
      hasMore: true,
      skills: [{ uri: "skill://pm-developer/SKILL.md" }],
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = registry.list({ cursor: first.nextCursor, limit: 1 });
    expect(second).toMatchObject({
      hasMore: false,
      skills: [{ uri: "skill://pm-user/SKILL.md" }],
    });
    expect(second).not.toHaveProperty("nextCursor");
    const descriptor = registry.get("skill://pm-developer/SKILL.md");
    expect(descriptor).toMatchObject({
      frontmatter: { name: "pm-developer", metadata: { owner: "unbrained" } },
      _meta: {
        origin: "package",
        packageVersion: "2026.8.26",
        protocolVersion: "2026-07-28",
        trust: "untrusted",
      },
    });
    expect(descriptor.resources).toHaveLength(4);
    const read = registry.read("skill://pm-developer/SKILL.md");
    const bytes = Buffer.from(read.contents[0].text);
    expect(read.contents[0]._meta.digest).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
    expect(read.contents[0]._meta.origin).toBe("package");
    expect(registry.read("skill://pm-developer/asset.bin")).toMatchObject({
      contents: [
        {
          mimeType: "application/octet-stream",
          blob: Buffer.from([0xff, 0x00, 0xfe]).toString("base64"),
        },
      ],
    });
    expect(registry.read("skill://pm-developer/plain.txt")).toMatchObject({
      contents: [{ mimeType: "text/plain", text: "plain text\n" }],
    });
    expect(registry.readDirectory("skill://pm-developer").resources).toEqual([
      {
        uri: "skill://pm-developer/asset.bin",
        name: "asset.bin",
        mimeType: "application/octet-stream",
      },
      {
        uri: "skill://pm-developer/plain.txt",
        name: "plain.txt",
        mimeType: "text/plain",
      },
      {
        uri: "skill://pm-developer/references",
        name: "references",
        mimeType: "inode/directory",
      },
      {
        uri: "skill://pm-developer/SKILL.md",
        name: "SKILL.md",
        mimeType: "text/markdown",
      },
    ]);
    expect(
      registry
        .readDirectory("skill://pm-developer/references")
        .resources.map(({ uri }) => uri),
    ).toEqual(["skill://pm-developer/references/DETAIL.md"]);
    expect(
      registry
        .readDirectory("skill://pm-developer/references/")
        .resources.map(({ uri }) => uri),
    ).toEqual(["skill://pm-developer/references/DETAIL.md"]);
    const directoryFirst = registry.readDirectory("skill://pm-developer", {
      limit: 1,
    });
    expect(directoryFirst).toMatchObject({ hasMore: true });
    expect(directoryFirst.nextCursor).toEqual(expect.any(String));
    const directoryFinal = registry.readDirectory("skill://pm-developer", {
      cursor: directoryFirst.nextCursor,
      limit: 3,
    });
    expect(directoryFinal).toMatchObject({ hasMore: false });
    expect(directoryFinal.resources).toHaveLength(3);
    expect(directoryFinal).not.toHaveProperty("nextCursor");
    expect(() =>
      registry.readDirectory("skill://pm-developer", {
        cursor: first.nextCursor,
      }),
    ).toThrow(/cursor is invalid or stale/u);
    expect(() =>
      registry.readDirectory("skill://pm-developer/SKILL.md"),
    ).toThrow(/Unknown pm MCP skill directory/u);
    for (const limit of [0, 101, 1.5]) {
      expect(() =>
        registry.readDirectory("skill://pm-developer", { limit }),
      ).toThrow(/directory limit/u);
    }

    const cursorPayload = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    for (const invalid of [
      null,
      {},
      { ...cursorPayload, fingerprint: "stale" },
      { ...cursorPayload, scope: "wrong" },
      { ...cursorPayload, offset: undefined },
      { ...cursorPayload, offset: 1.5 },
      { ...cursorPayload, offset: -1 },
    ]) {
      const cursor = Buffer.from(JSON.stringify(invalid)).toString("base64url");
      expect(() => registry.list({ cursor })).toThrow(
        /cursor is invalid or stale/u,
      );
    }
  });

  it("applies workspace overrides with explicit untrusted provenance", async () => {
    const packageRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    await writeSkill(packageRoot, "pm-user", "package workflow");
    await writeSkill(workspaceRoot, "pm-user", "workspace workflow");
    const registry = await PmMcpSkillRegistry.load({
      packageRoot,
      workspaceRoot,
      packageVersion: "1.0.0",
    });
    expect(registry.get("skill://pm-user/SKILL.md")).toMatchObject({
      frontmatter: { description: "workspace workflow" },
      _meta: { origin: "workspace", trust: "untrusted" },
    });
    expect(
      registry.read("skill://pm-user/SKILL.md").contents[0]._meta.origin,
    ).toBe("workspace");
    const sameOrigin = await PmMcpSkillRegistry.load({
      packageRoot,
      workspaceRoot: packageRoot,
      packageVersion: "1.0.0",
    });
    expect(sameOrigin.get("skill://pm-user/SKILL.md")._meta.origin).toBe(
      "package",
    );
  });

  it("returns an empty registry for absent roots and rejects stale or invalid reads", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, ".agents", "skills", "INVALID"), {
      recursive: true,
    });
    await mkdir(path.join(root, ".agents", "skills", "no-main"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, ".agents", "skills", "README.txt"),
      "ignored",
      "utf8",
    );
    const registry = await PmMcpSkillRegistry.load({
      packageRoot: root,
      packageVersion: "1",
    });
    expect(registry.list()).toEqual({ skills: [], hasMore: false });
    const fileRoot = path.join(root, "package-file");
    await writeFile(fileRoot, "not a directory", "utf8");
    const nestedBelowFile = await PmMcpSkillRegistry.load({
      packageRoot: fileRoot,
      packageVersion: "1",
    });
    expect(nestedBelowFile.list()).toEqual({ skills: [], hasMore: false });
    for (const operation of [
      () => registry.list({ limit: 0 }),
      () => registry.list({ limit: 101 }),
      () => registry.list({ limit: 1.5 }),
      () => registry.list({ cursor: "not-a-cursor" }),
      () => registry.get("skill://missing/SKILL.md"),
      () => registry.get("https://example.test/SKILL.md"),
      () => registry.read("skill://missing/SKILL.md"),
      () => registry.read("https://example.test/SKILL.md"),
      () => registry.readDirectory("skill://missing"),
      () => registry.readDirectory("https://example.test"),
    ]) {
      expect(operation).toThrow(PmMcpProtocolError);
    }
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: "\0", packageVersion: "1" }),
    ).rejects.toThrow();
  });

  it("rejects malformed frontmatter, mismatched names, links, and resource limits", async () => {
    const malformed = await tempRoot();
    const malformedDirectory = path.join(
      malformed,
      ".agents",
      "skills",
      "bad-skill",
    );
    await mkdir(malformedDirectory, { recursive: true });
    await writeFile(
      path.join(malformedDirectory, "SKILL.md"),
      "# no frontmatter\n",
      "utf8",
    );
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: malformed, packageVersion: "1" }),
    ).rejects.toThrow(/frontmatter/u);

    const invalidYaml = await tempRoot();
    const invalidYamlDirectory = path.join(
      invalidYaml,
      ".agents",
      "skills",
      "bad-yaml",
    );
    await mkdir(invalidYamlDirectory, { recursive: true });
    await writeFile(
      path.join(invalidYamlDirectory, "SKILL.md"),
      "---\nname: [\n---\n",
      "utf8",
    );
    await expect(
      PmMcpSkillRegistry.load({
        packageRoot: invalidYaml,
        packageVersion: "1",
      }),
    ).rejects.toThrow(/invalid YAML/u);

    const alias = await tempRoot();
    const aliasDirectory = path.join(alias, ".agents", "skills", "alias-skill");
    await mkdir(aliasDirectory, { recursive: true });
    await writeFile(
      path.join(aliasDirectory, "SKILL.md"),
      "---\nname: alias-skill\ndescription: &description aliased\nmetadata:\n  copy: *description\n---\n",
      "utf8",
    );
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: alias, packageVersion: "1" }),
    ).rejects.toThrow(/aliases/u);

    const mismatch = await tempRoot();
    await writeSkill(mismatch, "actual-name");
    await writeFile(
      path.join(mismatch, ".agents", "skills", "actual-name", "SKILL.md"),
      "---\nname: different-name\ndescription: mismatch\n---\n",
      "utf8",
    );
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: mismatch, packageVersion: "1" }),
    ).rejects.toThrow(/must match/u);

    const missingDescription = await tempRoot();
    const missingDescriptionDirectory = path.join(
      missingDescription,
      ".agents",
      "skills",
      "missing-description",
    );
    await mkdir(missingDescriptionDirectory, { recursive: true });
    await writeFile(
      path.join(missingDescriptionDirectory, "SKILL.md"),
      "---\nname: missing-description\n---\n",
      "utf8",
    );
    await expect(
      PmMcpSkillRegistry.load({
        packageRoot: missingDescription,
        packageVersion: "1",
      }),
    ).rejects.toThrow(/requires/u);

    for (const [name, frontmatter] of [
      ["scalar-frontmatter", "plain"],
      ["null-frontmatter", "null"],
      ["array-frontmatter", "[]"],
      ["null-name", "name: null\ndescription: missing name"],
      ["empty-description", "name: empty-description\ndescription: '   '"],
    ] as const) {
      const invalidRoot = await tempRoot();
      const invalidDirectory = path.join(
        invalidRoot,
        ".agents",
        "skills",
        name,
      );
      await mkdir(invalidDirectory, { recursive: true });
      await writeFile(
        path.join(invalidDirectory, "SKILL.md"),
        `---\n${frontmatter}\n---\n`,
        "utf8",
      );
      await expect(
        PmMcpSkillRegistry.load({
          packageRoot: invalidRoot,
          packageVersion: "1",
        }),
      ).rejects.toThrow(PmMcpProtocolError);
    }

    const linked = await tempRoot();
    await writeSkill(linked, "linked-skill");
    await symlink(
      path.join(linked, ".agents", "skills", "linked-skill", "SKILL.md"),
      path.join(linked, ".agents", "skills", "linked-skill", "LINK.md"),
    );
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: linked, packageVersion: "1" }),
    ).rejects.toThrow(/symbolic link/u);

    if (process.platform !== "win32") {
      const special = await tempRoot();
      await writeSkill(special, "special-file");
      const socketPath = path.join(
        special,
        ".agents",
        "skills",
        "special-file",
        "resource.sock",
      );
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      try {
        await expect(
          PmMcpSkillRegistry.load({
            packageRoot: special,
            packageVersion: "1",
          }),
        ).rejects.toThrow(/regular file or directory/u);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }

    const oversized = await tempRoot();
    await writeSkill(oversized, "large-skill");
    await writeFile(
      path.join(oversized, ".agents", "skills", "large-skill", "large.md"),
      "x".repeat(16 * 1024 * 1024 + 1),
      "utf8",
    );
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: oversized, packageVersion: "1" }),
    ).rejects.toThrow(/per-file limit/u);

    const tooMany = await tempRoot();
    await writeSkill(tooMany, "many-files");
    const tooManyDirectory = path.join(
      tooMany,
      ".agents",
      "skills",
      "many-files",
    );
    await Promise.all(
      Array.from({ length: 511 }, (_, index) =>
        writeFile(
          path.join(tooManyDirectory, `resource-${index}.txt`),
          "x",
          "utf8",
        ),
      ),
    );
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: tooMany, packageVersion: "1" }),
    ).rejects.toThrow(/exceeds 512 files/u);

    const aggregate = await tempRoot();
    await writeSkill(aggregate, "aggregate-limit");
    const aggregateDirectory = path.join(
      aggregate,
      ".agents",
      "skills",
      "aggregate-limit",
    );
    const halfPlus = Buffer.alloc(8 * 1024 * 1024 + 1);
    await writeFile(path.join(aggregateDirectory, "first.bin"), halfPlus);
    await writeFile(path.join(aggregateDirectory, "second.bin"), halfPlus);
    await expect(
      PmMcpSkillRegistry.load({ packageRoot: aggregate, packageVersion: "1" }),
    ).rejects.toThrow(/aggregate byte limit/u);

    const tooManySkills = await tempRoot();
    const tooManySkillsRoot = path.join(tooManySkills, ".agents", "skills");
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        mkdir(path.join(tooManySkillsRoot, `skill-${index}`), {
          recursive: true,
        }),
      ),
    );
    await expect(
      PmMcpSkillRegistry.load({
        packageRoot: tooManySkills,
        packageVersion: "1",
      }),
    ).rejects.toThrow(/exceeds 100 directories/u);

    const oversizedOrigin = await tempRoot();
    for (const name of ["origin-one", "origin-two", "origin-three"]) {
      await writeSkill(oversizedOrigin, name);
      await writeFile(
        path.join(oversizedOrigin, ".agents", "skills", name, "large.bin"),
        Buffer.alloc(11 * 1024 * 1024),
      );
    }
    await expect(
      PmMcpSkillRegistry.load({
        packageRoot: oversizedOrigin,
        packageVersion: "1",
      }),
    ).rejects.toThrow(/origin exceeds the aggregate byte limit/u);
  });
});
