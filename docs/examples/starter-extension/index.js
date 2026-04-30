import { defineExtension } from "@unbrained/pm-cli/sdk";

const runtimeState = {
  beforeCommandCount: 0,
  afterCommandCount: 0,
  onWriteCount: 0,
  onReadCount: 0,
  onIndexCount: 0,
};

function asRecord(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function stableJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: "non_serializable_payload" }, null, 2);
  }
}

export default defineExtension({
  activate(api) {
    // commands
    api.registerCommand({
      name: "starter ping",
      description: "Return a deterministic starter-extension response.",
      intent: "Verify extension activation and show SDK registration patterns.",
      examples: ["pm starter ping --name agent --uppercase"],
      run: async (context) => {
        const options = asRecord(context.options);
        const rawName = asString(options.name, "agent").trim();
        return {
          ok: true,
          source: "starter-extension",
          command: context.command,
          hello: rawName.length > 0 ? rawName : "agent",
          hook_counts: {
            before: runtimeState.beforeCommandCount,
            after: runtimeState.afterCommandCount,
            write: runtimeState.onWriteCount,
            read: runtimeState.onReadCount,
            index: runtimeState.onIndexCount,
          },
        };
      },
    });

    // schema (registerFlags currently routes through schema capability)
    api.registerFlags("starter ping", [
      { long: "--name", value_name: "text", description: "Name to include in the response." },
      { long: "--uppercase", description: "Render hello in uppercase via output_format service override." },
    ]);

    // parser
    api.registerParser("starter ping", async (context) => {
      const options = { ...asRecord(context.options) };
      if (typeof options.name === "string") {
        options.name = options.name.trim();
      }
      return { options };
    });

    // preflight
    api.registerPreflight((context) => {
      if (context.command !== "starter ping") {
        return {};
      }
      return {
        run_extension_migrations: false,
      };
    });

    // services
    api.registerService("output_format", (context) => {
      if (context.command !== "starter ping") {
        return context.payload;
      }
      const payload = asRecord(context.payload);
      const result = asRecord(payload.result);
      const options = asRecord(context.options);
      const uppercase = options.uppercase === true;
      const helloRaw = asString(result.hello, "agent");
      const hello = uppercase ? helloRaw.toUpperCase() : helloRaw;
      return `starter_service_output hello=${hello} command=${asString(context.command, "")}`;
    });

    // renderers
    api.registerRenderer("json", (context) => stableJson(context.result));
    api.registerRenderer("toon", (context) => {
      const result = asRecord(context.result);
      const hooks = asRecord(result.hook_counts);
      return [
        "starter_ping",
        `hello: ${asString(result.hello, "agent")}`,
        `command: ${asString(result.command, "")}`,
        `hooks.before: ${String(hooks.before ?? 0)}`,
        `hooks.after: ${String(hooks.after ?? 0)}`,
      ].join("\n");
    });

    // hooks
    api.hooks.beforeCommand(() => {
      runtimeState.beforeCommandCount += 1;
    });
    api.hooks.afterCommand(() => {
      runtimeState.afterCommandCount += 1;
    });
    api.hooks.onWrite(() => {
      runtimeState.onWriteCount += 1;
    });
    api.hooks.onRead(() => {
      runtimeState.onReadCount += 1;
    });
    api.hooks.onIndex(() => {
      runtimeState.onIndexCount += 1;
    });

    // schema
    api.registerItemFields([
      {
        name: "starter_context",
        type: "string",
        optional: true,
      },
    ]);
    api.registerItemTypes([
      {
        name: "Experiment",
        folder: "experiments",
        aliases: ["exp"],
        required_create_fields: ["description"],
      },
    ]);
    api.registerMigration({
      id: "starter-extension-noop-migration",
      description: "No-op migration to demonstrate schema migration registration.",
      status: "applied",
      mandatory: false,
      run: async () => ({ applied: true }),
    });

    // importers
    api.registerImporter("starter-json", async (context) => ({
      imported: true,
      source: "starter-extension",
      input: asRecord(context),
    }));
    api.registerExporter("starter-json", async (context) => ({
      exported: true,
      source: "starter-extension",
      output: asRecord(context),
    }));

    // search
    api.registerSearchProvider({
      name: "starter-search",
      kind: "example",
      query: async (context) => {
        const query = asString(asRecord(context).query, "").trim();
        if (!query) {
          return [];
        }
        return [
          {
            id: "starter-result-1",
            score: 1,
            title: "Starter Search Result",
            snippet: `Echo match for: ${query}`,
            source: "starter-extension",
          },
        ];
      },
    });
    api.registerVectorStoreAdapter({
      name: "starter-vector-adapter",
      kind: "example",
      upsert: async () => ({ upserted: 0 }),
      query: async () => [],
      delete: async () => ({ deleted: 0 }),
    });
  },
});
