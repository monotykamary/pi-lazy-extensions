/**
 * Extension registry - loads and tracks lazy extensions.
 *
 * This is the core of pi-lazy-extensions. It handles:
 * - Dynamic loading of extensions via import() + factory(pi)
 * - Tracking registered tools/commands per extension
 * - Idle timeout unloading
 * - Deduplication guards
 */

import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { ActivationResult, LazyExtensionsState, LoadedExtensionState } from "./types.js";
import { resolveExtensionPath } from "./config.js";

const FAILURE_BACKOFF_MS = 60 * 1000;
const failureTracker = new Map<string, number>();

/**
 * Dynamically load an extension by importing its module and invoking the factory.
 *
 * The extension's default export (factory function) receives the shared
 * ExtensionAPI (pi) — the same object that all extensions share. This means
 * pi.registerTool(), pi.on(), etc. all work as expected.
 */
export async function activateExtension(
  name: string,
  state: LazyExtensionsState,
  pi: ExtensionAPI,
): Promise<ActivationResult> {
  const extState = state.extensions.get(name);
  if (!extState) {
    return { success: false, name, error: `Extension "${name}" not found in manifest` };
  }

  if (extState.loaded) {
    return {
      success: true,
      name,
      tools: extState.registeredTools,
      commands: extState.registeredCommands,
    };
  }

  // Check failure backoff
  const failedAgo = getFailureAgeSeconds(name);
  if (failedAgo !== null) {
    return {
      success: false,
      name,
      error: `Extension "${name}" recently failed (${failedAgo}s ago). Retry later.`,
    };
  }

  // Snapshot current tools/commands to diff after load
  const toolsBefore = new Set(pi.getAllTools().map((t: any) => t.name as string));

  const extPath = resolveExtensionPath(extState.config.path, state.baseDir);

  try {
    // Use jiti-compatible dynamic import.
    // jiti handles .ts transpilation at runtime, but when pi runs as a Bun binary
    // the extension modules need virtualModules resolution. Using the same
    // import() path that jiti would use is the safest approach.
    //
    // For extensions that are already in pi's auto-discovery paths,
    // jiti has already loaded them. For extensions outside those paths,
    // we rely on Node/Bun's native module resolution plus jiti's .ts support.
    const mod = await import(extPath);

    if (typeof mod.default !== "function") {
      const message = `Extension "${name}" does not export a default factory function`;
      extState.error = message;
      failureTracker.set(name, Date.now());
      return { success: false, name, error: message };
    }

    const factory = mod.default as (pi: ExtensionAPI) => void | Promise<void>;

    // Invoke the extension factory with the shared ExtensionAPI.
    // This registers tools, events, commands, etc. into the same runtime.
    await factory(pi);

    // Diff to find what this extension registered
    const toolsAfter = pi.getAllTools().map((t: any) => t.name as string);
    const newTools = toolsAfter.filter(t => !toolsBefore.has(t));
    extState.registeredTools = newTools;

    extState.loaded = true;
    extState.lastActivated = Date.now();
    extState.lastUsed = Date.now();
    extState.error = undefined;
    failureTracker.delete(name);

    // Start idle timer if configured
    scheduleIdleTimeout(name, state, pi);

    return {
      success: true,
      name,
      tools: newTools,
      commands: extState.registeredCommands,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    extState.error = message;
    failureTracker.set(name, Date.now());
    return { success: false, name, error: message };
  }
}

/**
 * Touch an extension's last-used timestamp (resets idle timer).
 */
export function touchExtension(name: string, state: LazyExtensionsState): void {
  const extState = state.extensions.get(name);
  if (extState && extState.loaded) {
    extState.lastUsed = Date.now();
  }
}

/**
 * Get the age of a recent failure in seconds, or null if no recent failure.
 */
export function getFailureAgeSeconds(name: string): number | null {
  const failedAt = failureTracker.get(name);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) {
    failureTracker.delete(name);
    return null;
  }
  return Math.round(ageMs / 1000);
}

/**
 * Schedule an idle timeout for a lazy extension.
 * When the timeout fires, the extension is "soft unloaded" — its tools
 * are removed from the active set and the extension is marked as idle.
 *
 * Note: Full unloading (removing event handlers) is not possible with the
 * current ExtensionAPI. We can only deactivate the tools.
 */
function scheduleIdleTimeout(name: string, state: LazyExtensionsState, pi: ExtensionAPI): void {
  const extState = state.extensions.get(name);
  if (!extState) return;

  // Clear any existing timer
  if (extState.idleTimer) {
    clearTimeout(extState.idleTimer);
  }

  const lifecycle = extState.config.lifecycle ?? "lazy";
  if (lifecycle === "keep-alive") return; // Never idle-unload keep-alive extensions

  const idleMinutes = state.manifest.settings?.idleTimeout ?? 10;
  if (idleMinutes === 0) return; // 0 = never idle-unload

  extState.idleTimer = setTimeout(() => {
    if (!extState.loaded) return;

    // Check if recently used
    if (extState.lastUsed) {
      const idleMs = Date.now() - extState.lastUsed;
      if (idleMs < idleMinutes * 60 * 1000) {
        // Not idle yet, reschedule
        scheduleIdleTimeout(name, state, pi);
        return;
      }
    }

    // "Soft unload" — deactivate this extension's tools
    idleUnloadExtension(name, state, pi);
  }, idleMinutes * 60 * 1000);
}

/**
 * Soft-unload an extension by deactivating its tools.
 *
 * Full unloading (removing event handlers) isn't possible with the current
 * ExtensionAPI. We remove the extension's tools from the active set and
 * mark it as unloaded. A subsequent activation will re-register them.
 */
function idleUnloadExtension(name: string, state: LazyExtensionsState, pi: ExtensionAPI): void {
  const extState = state.extensions.get(name);
  if (!extState || !extState.loaded) return;

  // Remove this extension's tools from the active set
  const activeTools = (pi.getActiveTools() as any[]).map(t => t.name as string);
  const remaining = activeTools.filter(t => !extState.registeredTools.includes(t));
  pi.setActiveTools(remaining);

  extState.loaded = false;
  extState.lastActivated = undefined;
  extState.registeredTools = [];
  extState.registeredCommands = [];
}

/**
 * Clear all idle timers (for shutdown).
 */
export function clearAllTimers(state: LazyExtensionsState): void {
  for (const [, extState] of state.extensions) {
    if (extState.idleTimer) {
      clearTimeout(extState.idleTimer);
      extState.idleTimer = undefined;
    }
  }
}

/**
 * Build a description string for the proxy tool that lists available
 * lazy extensions and their tool summaries.
 */
export function buildProxyDescription(state: LazyExtensionsState): string {
  const lines: string[] = [
    "Extension gateway - discover, search, and activate extensions on demand.",
    "",
    "Available extensions:",
  ];

  for (const [name, extState] of state.extensions) {
    const lifecycle = extState.config.lifecycle ?? "lazy";
    const status = extState.loaded ? "✓ active" : "○ lazy";
    const desc = extState.config.description ?? extState.config.toolSummary?.join(", ") ?? "";
    const tagStr = extState.config.tags?.length ? ` [${extState.config.tags.join(", ")}]` : "";

    lines.push(`  ${status} ${name} (${lifecycle})${tagStr}`);
    if (desc) lines.push(`    ${desc}`);

    if (extState.config.toolSummary?.length) {
      lines.push(`    Tools: ${extState.config.toolSummary.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Use ext({ search: \"query\" }) to find extensions, ext({ activate: \"name\" }) to load one.");

  return lines.join("\n");
}
