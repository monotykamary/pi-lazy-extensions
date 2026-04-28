/**
 * Proxy tool execution modes.
 *
 * These are the actions the LLM can take through the `ext` proxy tool,
 * analogous to pi-mcp-adapter's proxy-modes.ts.
 */

import type { AgentToolResult, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { LazyExtensionsState } from "./types.js";
import { activateExtension, touchExtension, getFailureAgeSeconds } from "./registry.js";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;

/**
 * Show status of all registered extensions.
 */
export function executeStatus(state: LazyExtensionsState): ProxyToolResult {
  const entries: Array<{ name: string; status: string; lifecycle: string; toolCount: number; shortcutCount: number; flagCount: number; rendererCount: number; error?: string }> = [];

  for (const [name, extState] of state.extensions) {
    const lifecycle = extState.config.lifecycle ?? "lazy";
    const toolCount = extState.registeredTools.length;
    const shortcutCount = extState.registeredShortcuts.length;
    const flagCount = extState.registeredFlags.length;
    const rendererCount = extState.registeredRenderers.length;
    let status = "inactive";
    if (extState.loaded) {
      status = "active";
    } else if (extState.error) {
      status = "failed";
    } else if (getFailureAgeSeconds(state, name) !== null) {
      status = "failed";
    }
    entries.push({ name, status, lifecycle, toolCount, shortcutCount, flagCount, rendererCount, error: extState.error });
  }

  const activeCount = entries.filter(e => e.status === "active").length;
  const totalTools = entries.reduce((sum, e) => sum + e.toolCount, 0);

  let text = `Lazy Extensions: ${activeCount}/${entries.length} active, ${totalTools} tools\n\n`;
  for (const entry of entries) {
    if (entry.status === "active") {
      const extras: string[] = [];
      if (entry.shortcutCount > 0) extras.push(`${entry.shortcutCount} shortcuts`);
      if (entry.flagCount > 0) extras.push(`${entry.flagCount} flags`);
      if (entry.rendererCount > 0) extras.push(`${entry.rendererCount} renderers`);
      const extraStr = extras.length > 0 ? `, ${extras.join(", ")}` : "";
      text += `✓ ${entry.name} (${entry.toolCount} tools${extraStr}, ${entry.lifecycle})\n`;
    } else if (entry.status === "failed") {
      text += `✗ ${entry.name} (failed: ${entry.error ?? "unknown"})\n`;
    } else {
      const desc = state.extensions.get(entry.name)?.config.description ?? "";
      text += `○ ${entry.name} (${entry.lifecycle})${desc ? ` - ${desc}` : ""}\n`;
    }
  }

  text += `\next({ search: "..." }) to search, ext({ activate: "name" }) to load`;

  return {
    content: [{ type: "text", text: text.trim() }],
    details: { mode: "status", entries, totalTools, activeCount },
  };
}

/**
 * Search extensions by name, description, tags, or tool names.
 */
export function executeSearch(
  state: LazyExtensionsState,
  query: string,
  regex?: boolean,
): ProxyToolResult {
  let pattern: RegExp;
  try {
    if (regex) {
      pattern = new RegExp(query, "i");
    } else {
      const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
      if (terms.length === 0) {
        return {
          content: [{ type: "text", text: "Search query cannot be empty" }],
          details: { mode: "search", error: "empty_query" },
        };
      }
      const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern = new RegExp(escaped.join("|"), "i");
    }
  } catch {
    return {
      content: [{ type: "text", text: `Invalid regex: ${query}` }],
      details: { mode: "search", error: "invalid_pattern", query },
    };
  }

  const matches: Array<{ name: string; status: string; matchReason: string }> = [];

  for (const [name, extState] of state.extensions) {
    const matchReasons: string[] = [];

    // Check name
    if (pattern.test(name)) matchReasons.push("name");

    // Check description
    if (extState.config.description && pattern.test(extState.config.description)) {
      matchReasons.push("description");
    }

    // Check tags
    if (extState.config.tags?.some(tag => pattern.test(tag))) {
      matchReasons.push("tags");
    }

    // Check tool summary
    if (extState.config.toolSummary?.some(tool => pattern.test(tool))) {
      matchReasons.push("tools");
    }

    // Check registered tool names (for already-loaded extensions)
    if (extState.registeredTools.some(tool => pattern.test(tool))) {
      matchReasons.push("registered tools");
    }

    if (matchReasons.length > 0) {
      matches.push({
        name,
        status: extState.loaded ? "active" : "inactive",
        matchReason: matchReasons.join(", "),
      });
    }
  }

  if (matches.length === 0) {
    return {
      content: [{ type: "text", text: `No extensions matching "${query}"` }],
      details: { mode: "search", matches: [], count: 0, query },
    };
  }

  let text = `Found ${matches.length} extension${matches.length === 1 ? "" : "s"} matching "${query}":\n\n`;
  for (const match of matches) {
    const extState = state.extensions.get(match.name)!;
    const statusIcon = match.status === "active" ? "✓" : "○";
    const desc = extState.config.description ?? "";
    const tags = extState.config.tags?.length ? ` [${extState.config.tags.join(", ")}]` : "";
    const tools = extState.config.toolSummary?.length
      ? `\n    Tools: ${extState.config.toolSummary.join(", ")}`
      : "";

    text += `${statusIcon} ${match.name} (${match.status}, matched: ${match.matchReason})${tags}\n`;
    if (desc) text += `    ${desc}\n`;
    if (tools) text += `${tools}\n`;
    text += "\n";
  }

  return {
    content: [{ type: "text", text: text.trim() }],
    details: { mode: "search", matches, count: matches.length, query },
  };
}

/**
 * Activate (load) an extension by name.
 */
export async function executeActivate(
  state: LazyExtensionsState,
  name: string,
  pi: import("@mariozechner/pi-coding-agent").ExtensionAPI,
): Promise<ProxyToolResult> {
  const extState = state.extensions.get(name);
  if (!extState) {
    return {
      content: [{ type: "text", text: `Extension "${name}" not found. Use ext({}) to see available extensions.` }],
      details: { mode: "activate", error: "not_found", name },
    };
  }

  if (extState.loaded) {
    touchExtension(name, state);
    const toolList = extState.registeredTools.length > 0
      ? ` Tools: ${extState.registeredTools.join(", ")}`
      : "";
    return {
      content: [{ type: "text", text: `Extension "${name}" is already active.${toolList}` }],
      details: { mode: "activate", name, alreadyActive: true, tools: extState.registeredTools },
    };
  }

  const result = await activateExtension(name, state, pi);

  if (!result.success) {
    return {
      content: [{ type: "text", text: `Failed to activate "${name}": ${result.error}` }],
      details: { mode: "activate", error: "activation_failed", name, message: result.error },
    };
  }

  const toolList = result.tools?.length
    ? ` Registered tools: ${result.tools.join(", ")}`
    : "";
  const nonToolExtras: string[] = [];
  if (result.shortcuts?.length) nonToolExtras.push(`${result.shortcuts.length} shortcuts`);
  if (result.flags?.length) nonToolExtras.push(`${result.flags.length} flags`);
  if (result.renderers?.length) nonToolExtras.push(`${result.renderers.length} renderers`);
  const nonToolStr = nonToolExtras.length > 0 ? ` Also registered: ${nonToolExtras.join(", ")} (these persist after idle-unload).` : "";
  const desc = extState.config.description ?? "";

  const warnings: string[] = [];
  if (result.duplicateTools?.length) {
    warnings.push(`⚠ Tool name collision: "${result.duplicateTools.join(", ")}" already registered by another extension (skipped).`);
  }
  if (result.sessionStartWarning) {
    warnings.push(`⚠ This extension registered a session_start handler that won't fire until the next session/reload. If it depends on session_start for initialization, it may not work correctly when lazy-loaded.`);
  }
  const warningStr = warnings.length > 0 ? `\n\n${warnings.join("\n\n")}` : "";

  return {
    content: [{
      type: "text",
      text: `✓ Activated "${name}"${desc ? ` - ${desc}` : ""}.${toolList}${nonToolStr}${warningStr}\n\nThe extension's tools are now directly available.`,
    }],
    details: { mode: "activate", name, tools: result.tools, shortcuts: result.shortcuts, flags: result.flags, renderers: result.renderers, duplicateTools: result.duplicateTools, sessionStartWarning: result.sessionStartWarning },
  };
}

/**
 * List tools for a specific extension (or all active extensions).
 */
export function executeListTools(
  state: LazyExtensionsState,
  extensionName?: string,
  getPiTools?: () => ToolInfo[],
): ProxyToolResult {
  if (extensionName) {
    const extState = state.extensions.get(extensionName);
    if (extState?.loaded) {
      touchExtension(extensionName, state);
    }
    if (!extState) {
      return {
        content: [{ type: "text", text: `Extension "${extensionName}" not found.` }],
        details: { mode: "list", error: "not_found", extensionName },
      };
    }

    if (!extState.loaded) {
      // Show preserved tools if previously loaded, otherwise manifest toolSummary
      const knownTools = extState.registeredTools.length > 0
        ? extState.registeredTools
        : extState.config.toolSummary;
      const summary = knownTools?.length
        ? ` Known tools: ${knownTools.join(", ")}`
        : " Use ext({ activate: \"" + extensionName + "\" }) to load it first.";
      return {
        content: [{ type: "text", text: `Extension "${extensionName}" is not active.${summary}` }],
        details: { mode: "list", extensionName, loaded: false, toolSummary: knownTools ?? extState.config.toolSummary },
      };
    }

    if (extState.registeredTools.length === 0) {
      return {
        content: [{ type: "text", text: `Extension "${extensionName}" is active but has no registered tools.` }],
        details: { mode: "list", extensionName, tools: [], count: 0 },
      };
    }

    let text = `${extensionName} (${extState.registeredTools.length} tools):\n\n`;
    for (const toolName of extState.registeredTools) {
      // Try to get description from pi's tool registry
      let desc = "";
      if (getPiTools) {
        const piTool = getPiTools().find(t => t.name === toolName);
        if (piTool?.description) desc = piTool.description;
      }
      const truncated = desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
      text += `- ${toolName}`;
      if (truncated) text += ` - ${truncated}`;
      text += "\n";
    }

    return {
      content: [{ type: "text", text: text.trim() }],
      details: { mode: "list", extensionName, tools: extState.registeredTools, count: extState.registeredTools.length },
    };
  }

  // List tools across all active extensions
  const allTools: Array<{ extension: string; tool: string; description: string }> = [];
  for (const [name, extState] of state.extensions) {
    if (!extState.loaded) continue;
    for (const toolName of extState.registeredTools) {
      let desc = "";
      if (getPiTools) {
        const piTool = getPiTools().find(t => t.name === toolName);
        if (piTool?.description) desc = piTool.description;
      }
      allTools.push({ extension: name, tool: toolName, description: desc });
    }
  }

  if (allTools.length === 0) {
    return {
      content: [{ type: "text", text: "No extension tools currently active. Use ext({ activate: \"name\" }) to load an extension." }],
      details: { mode: "list", tools: [], count: 0 },
    };
  }

  let text = `Active extension tools (${allTools.length}):\n\n`;
  for (const entry of allTools) {
    const truncated = entry.description.length > 60 ? entry.description.slice(0, 57) + "..." : entry.description;
    text += `- ${entry.tool} [${entry.extension}]`;
    if (truncated) text += ` - ${truncated}`;
    text += "\n";
  }

  return {
    content: [{ type: "text", text: text.trim() }],
    details: { mode: "list", tools: allTools, count: allTools.length },
  };
}
