import path from "node:path";
import { describe, expect, it } from "vitest";
import { runExtension } from "../../src/cli/commands/extension.js";
import { writeTestExtension } from "../helpers/extensions.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function installOutputPackage(
  pmPath: string,
  sourceDir: string,
  name: string,
  registration: string,
): Promise<Awaited<ReturnType<typeof runExtension>>> {
  await writeTestExtension({
    root: sourceDir,
    name,
    manifestOverrides: { capabilities: ["services"] },
    entrySource: [
      "export function activate(api) {",
      `  ${registration}`,
      "}",
      "",
    ].join("\n"),
  });
  return await runExtension(
    sourceDir,
    { install: true, project: true },
    { path: pmPath },
  );
}

describe("package service pass-through integration", () => {
  it("keeps an inert third-party service package clean under strict isolated doctor", async () => {
    await withTempPmPath(async (context) => {
      const install = await installOutputPackage(
        context.pmPath,
        path.join(context.tempRoot, "safe-service-source"),
        "safe-service",
        "api.registerService('output_format', () => ({ handled: false }), { passThrough: true });",
      );
      expect(install).toMatchObject({
        ok: true,
        details: {
          activated: true,
          runtime_activation_status: "ok",
          verification: { status: "ok", activated: true },
        },
      });

      const doctor = context.runCli(
        [
          "package",
          "doctor",
          "--project",
          "--isolated",
          "--strict-exit",
          "--json",
        ],
        { expectJson: true },
      );

      expect(doctor.code).toBe(0);
      expect(
        (
          doctor.json as {
            details: { summary: { warning_codes: string[] } };
          }
        ).details.summary.warning_codes,
      ).not.toContain("extension_output_service_override_global");
    });
  });

  it("retains strict diagnostics for an undeclared global interceptor", async () => {
    await withTempPmPath(async (context) => {
      const install = await installOutputPackage(
        context.pmPath,
        path.join(context.tempRoot, "interceptor-source"),
        "interceptor-service",
        "api.registerService('output_format', () => ({ handled: true, result: 'intercepted' }));",
      );
      expect(install).toMatchObject({
        ok: true,
        details: {
          activated: true,
          runtime_activation_status: "ok",
          verification: { status: "ok", activated: true },
        },
      });

      const doctor = context.runCli(
        [
          "package",
          "doctor",
          "--project",
          "--isolated",
          "--strict-exit",
          "--json",
        ],
        { expectJson: true },
      );

      expect(doctor.code).toBe(1);
      expect(
        (
          doctor.json as {
            details: { summary: { warning_codes: string[] } };
          }
        ).details.summary.warning_codes,
      ).toContain("extension_output_service_override_global");
    });
  });
});
