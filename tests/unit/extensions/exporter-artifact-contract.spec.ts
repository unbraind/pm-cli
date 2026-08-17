import { describe, expect, it } from "vitest";
import {
  isHostOutputSuppressed,
  type ExporterRegistrationOptions,
  type ImportExportRegistrationOptions,
} from "../../../src/sdk/index.js";
import { runCommandHandler } from "../../../src/core/extensions/loader.js";
import { activateSyntheticExtensions } from "../../helpers/extensions.js";

const COMMAND_CONTEXT = {
  command: "report export",
  args: [],
  options: {},
  global: {
    json: false,
    quiet: false,
    noExtensions: false,
    profile: false,
  },
  pm_root: "/tmp/project/.agents/pm",
  source_workspace_root: "/tmp/project",
  repo_root: "/tmp/project",
  pm_root_rel: ".agents/pm",
};

describe("extension exporter artifact channels", () => {
  it("suppresses host rendering for declared stdout artifacts and inventories the contract", async () => {
    const activation = await activateSyntheticExtensions([
      {
        name: "stdout-exporter",
        capabilities: ["importers"],
        activate(api) {
          api.registerExporter("report", async () => ({ rows: 2 }), {
            output: {
              channel: "stdout",
              media_type: "application/x-ndjson",
            },
          });
        },
      },
    ]);

    expect(activation.registrations.exporters).toEqual([
      {
        layer: "project",
        name: "stdout-exporter",
        exporter: "report",
        output: {
          channel: "stdout",
          media_type: "application/x-ndjson",
          receipt: "suppress",
        },
      },
    ]);
    const handled = await runCommandHandler(activation.commands, COMMAND_CONTEXT);
    expect(handled.handled).toBe(true);
    expect(isHostOutputSuppressed(handled.result)).toBe(true);
    expect(handled.result).toMatchObject({ result: { rows: 2 } });
  });

  it("keeps file receipts renderable unless explicitly suppressed", async () => {
    const activation = await activateSyntheticExtensions([
      {
        name: "receipt-exporters",
        capabilities: ["importers"],
        activate(api) {
          api.registerExporter("file-report", async () => ({ path: "report.json" }), {
            output: { channel: "file" },
          });
          api.registerExporter("report", async () => ({ rows: 2 }), {
            output: { channel: "file", receipt: "suppress" },
          });
        },
      },
    ]);

    const stdoutReceipt = await runCommandHandler(
      activation.commands,
      COMMAND_CONTEXT,
    );
    const fileReceipt = await runCommandHandler(activation.commands, {
      ...COMMAND_CONTEXT,
      command: "file-report export",
    });
    expect(isHostOutputSuppressed(stdoutReceipt.result)).toBe(true);
    expect(fileReceipt.result).toEqual({ path: "report.json" });
  });

  it("rejects invalid or importer-only artifact output declarations atomically", async () => {
    const activation = await activateSyntheticExtensions([
      {
        name: "invalid-artifacts",
        capabilities: ["importers"],
        activate(api) {
          api.registerImporter(
            "source",
            async () => ({ rows: 0 }),
            { output: { channel: "stdout" } } as unknown as ImportExportRegistrationOptions,
          );
        },
      },
    ]);
    expect(activation.registrations.importers).toEqual([]);
    expect(activation.failed[0]?.error).toContain(
      "registerImporter options.output is exporter-only",
    );

    const invalidExporter = await activateSyntheticExtensions([
      {
        name: "invalid-exporter",
        capabilities: ["importers"],
        activate(api) {
          api.registerExporter(
            "report",
            async () => ({ rows: 0 }),
            { output: { channel: "pipe" } } as unknown as ExporterRegistrationOptions,
          );
        },
      },
    ]);
    expect(invalidExporter.registrations.exporters).toEqual([]);
    expect(invalidExporter.failed[0]?.error).toContain(
      "registerExporter options.output.channel must be stdout|file",
    );

    const invalidReceipt = await activateSyntheticExtensions([
      {
        name: "invalid-receipt",
        capabilities: ["importers"],
        activate(api) {
          api.registerExporter(
            "report",
            async () => ({ rows: 0 }),
            {
              output: { channel: "stdout", receipt: "inline" },
            } as unknown as ExporterRegistrationOptions,
          );
        },
      },
    ]);
    expect(invalidReceipt.registrations.exporters).toEqual([]);
    expect(invalidReceipt.failed[0]?.error).toContain(
      "registerExporter options.output.receipt must be suppress|render",
    );

    const incompatibleReceipt = await activateSyntheticExtensions([
      {
        name: "incompatible-receipt",
        capabilities: ["importers"],
        activate(api) {
          api.registerExporter(
            "report",
            async () => ({ rows: 0 }),
            {
              output: { channel: "stdout", receipt: "render" },
            } as unknown as ExporterRegistrationOptions,
          );
        },
      },
    ]);
    expect(incompatibleReceipt.registrations.exporters).toEqual([]);
    expect(incompatibleReceipt.failed[0]?.error).toContain(
      "stdout artifacts cannot render a host receipt",
    );

    const unknownField = await activateSyntheticExtensions([
      {
        name: "unknown-output-field",
        capabilities: ["importers"],
        activate(api) {
          api.registerExporter(
            "report",
            async () => ({ rows: 0 }),
            {
              output: { channel: "stdout", recepit: "suppress" },
            } as unknown as ExporterRegistrationOptions,
          );
        },
      },
    ]);
    expect(unknownField.registrations.exporters).toEqual([]);
    expect(unknownField.failed[0]?.error).toContain(
      "contains unsupported field recepit",
    );
  });
});
