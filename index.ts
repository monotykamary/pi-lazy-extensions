/**
 * pi-lazy-extensions
 *
 * A pi extension that lazy-loads other extensions on demand,
 * analogous to Anthropic's ToolSearch but for entire pi extensions.
 *
 * Usage:
 *   1. Create a lazy-extensions.json manifest
 *   2. Install this package: pi install npm:pi-lazy-extensions
 *   3. The `ext` proxy tool lets the LLM discover and activate extensions
 */

import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadManifest, buildState, getEagerExtensions } from "./config.js";
import { activateExtension, buildProxyDescription, clearAllTimers } from "./registry.js";
import { executeStatus, executeSearch, executeActivate, executeListTools } from "./proxy-modes.js";
import type { LazyExtensionsState } from "./types.js";

export default function lazyExtensions(pi: ExtensionAPI) {
  let state: LazyExtensionsState | null = null;
  let initPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;

  const getPiTools = (): ToolInfo[] => pi.getAllTools() as any;

  // Pre-load manifest at extension load time (before session_start)
  // so the proxy tool description can include the extension list.
  const agentDir = process.env.PI_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;
  const earlyResult = loadManifest(process.cwd(), agentDir);
  const earlyDescription = earlyResult
    ? buildProxyDescription(buildState(earlyResult.manifest, earlyResult.path))
    : "Extension gateway - discover, search, and activate extensions on demand. Create a lazy-extensions.json to configure.";

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;

    // Clear previous state
    if (state) {
      clearAllTimers(state);
      state = null;
    }

    const result = loadManifest(ctx.cwd, agentDir);

    if (!result) {
      // No manifest found — this is fine, just no lazy extensions configured
      return;
    }

    state = buildState(result.manifest, result.path);

    if (generation !== lifecycleGeneration) return;

    if (ctx.hasUI) {
      const total = state.extensions.size;
      if (total > 0) {
        ctx.ui.notify(`Lazy Extensions: ${total} extension${total === 1 ? "" : "s"} configured`, "info");
      }
    }

    // Load eager extensions immediately
    const eager = getEagerExtensions(state);
    if (eager.length > 0 && ctx.hasUI) {
      ctx.ui.setStatus("lazy-ext", `Lazy Extensions: loading ${eager.length} eager extensions...`);
    }

    const init = (async () => {
      for (const extConfig of eager) {
        if (generation !== lifecycleGeneration) return;
        const result = await activateExtension(extConfig.name, state!, pi);
        if (!result.success && ctx.hasUI) {
          ctx.ui.notify(`Lazy Extensions: failed to load "${extConfig.name}": ${result.error}`, "warning");
        }
      }
    })();

    initPromise = init;
    await init;
    initPromise = null;

    if (generation !== lifecycleGeneration) return;

    if (eager.length > 0 && ctx.hasUI) {
      const loaded = eager.filter(e => state!.extensions.get(e.name)?.loaded).length;
      ctx.ui.setStatus("lazy-ext", `Lazy Extensions: ${loaded}/${eager.length} eager loaded`);
      // Clear status after a few seconds
      setTimeout(() => {
        if (state && generation === lifecycleGeneration) {
          const active = Array.from(state.extensions.values()).filter(e => e.loaded).length;
          const total = state.extensions.size;
          if (active > 0) {
            ctx.ui.setStatus("lazy-ext", ctx.ui.theme.fg("accent", `Ext: ${active}/${total} active`));
          } else {
            ctx.ui.setStatus("lazy-ext", undefined);
          }
        }
      }, 3000);
    }
  });

  pi.on("session_shutdown", () => {
    ++lifecycleGeneration;
    if (state) {
      clearAllTimers(state);
      state = null;
    }
    initPromise = null;
  });

  pi.registerCommand("ext", {
    description: "Show lazy extensions status",
    handler: async (args, ctx) => {
      // Wait for init if still running
      if (initPromise) await initPromise;

      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("No lazy extensions configured", "info");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const target = parts[1];

      switch (subcommand) {
        case "activate": {
          if (!target) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /ext activate <name>", "warning");
            return;
          }
          const result = await activateExtension(target, state, pi);
          if (result.success) {
            if (ctx.hasUI) ctx.ui.notify(`✓ Activated "${target}"${result.tools?.length ? ` (${result.tools.length} tools)` : ""}`, "info");
          } else {
            if (ctx.hasUI) ctx.ui.notify(`Failed to activate "${target}": ${result.error}`, "error");
          }
          break;
        }
        case "search": {
          const query = parts.slice(1).join(" ");
          if (!query) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /ext search <query>", "warning");
            return;
          }
          const result = executeSearch(state, query);
          if (ctx.hasUI) ctx.ui.notify((result.content[0] as any)?.text ?? "No results", "info");
          break;
        }
        case "tools": {
          const result = executeListTools(state, target, getPiTools);
          if (ctx.hasUI) ctx.ui.notify((result.content[0] as any)?.text ?? "No tools", "info");
          break;
        }
        case "status":
        case "":
        default: {
          const result = executeStatus(state);
          if (ctx.hasUI) ctx.ui.notify((result.content[0] as any)?.text ?? "No status", "info");
          break;
        }
      }
    },
  });

  // Register the proxy tool — the LLM's entry point for discovering and activating extensions
  // @ts-ignore - Type.Object causes excessive type instantiation with typebox
  pi.registerTool({
    name: "ext",
    label: "Extension Gateway",
    description: earlyDescription,
    promptSnippet: "Discover and activate lazy-loaded extensions",
    promptGuidelines: [
      "Use ext to discover and activate extensions before using their tools.",
      "If a tool you need is not available, search ext({ search: \"...\" }) for an extension that provides it.",
      "After activating an extension with ext({ activate: \"name\" }), its tools become immediately available.",
    ],
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: "Search extensions by name, description, tags, or tool names" })),
      activate: Type.Optional(Type.String({ description: "Activate (load) an extension by name" })),
      tools: Type.Optional(Type.String({ description: "List tools for a specific extension (or omit for all active)" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
    }),
    async execute(_toolCallId: string, params: { search?: string; activate?: string; tools?: string; regex?: boolean }, _signal: any, _onUpdate: any, _ctx: any) {
      // Wait for init if still running
      if (initPromise) await initPromise;

      if (!state) {
        return {
          content: [{ type: "text" as const, text: "No lazy extensions configured. Create a lazy-extensions.json manifest." }],
          details: { error: "not_configured" },
        };
      }

      if (params.activate) {
        return executeActivate(state, params.activate, pi) as any;
      }
      if (params.search) {
        return executeSearch(state, params.search, params.regex) as any;
      }
      if (params.tools !== undefined) {
        return executeListTools(state, params.tools || undefined, getPiTools) as any;
      }
      return executeStatus(state) as any;
    },
  });
}
