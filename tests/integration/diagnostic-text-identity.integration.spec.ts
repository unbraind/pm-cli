/** pm-m4uyyj: CLI diagnostics retain identity and remove terminal controls at every output size. */
import { expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

it("retains the specific unknown option and correction without echoing oversized input", async () => {
  await withTempPmPath(async (context) => {
    for (const [flag, identity] of [
      ["--label", "Error: Unknown option --label"],
      ["--priorityy", "Error: Refusing to auto-correct mutating option --priorityy to --priority"],
    ]) {
      const result = context.runCli(["create", "--title", "Diagnostic probe", "--description", "caller-input ".repeat(1200), flag, "security"]);
      expect(result.code).toBe(2);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(identity);
      expect(output).toContain("What is required:");
      expect(output).not.toContain("caller-input");
      expect(Math.ceil(Buffer.byteLength(output, "utf8") / 4)).toBeLessThanOrEqual(768);
    }
  });
});

it("sanitizes terminal controls in short CLI errors", async () => {
  await withTempPmPath(async (context) => {
    const result = context.runCli(["create", "--title", "Diagnostic probe", "--label\u001b[2J", "security"]);
    expect(result.code).toBe(2);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("Error: Unknown option --label");
    expect(output).not.toContain("Diagnostic output exceeded");
    expect(output.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
  });
});
