/**
 * Extension registry - loads and tracks lazy extensions.
 *
 * This is the core of pi-lazy-extensions. It handles:
 * - Dynamic loading of extensions via jiti (or import()) + factory(pi)
 * - Tracking registered tools/commands per extension
 * - Idle timeout unloading
 * - Deduplication guards
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ActivationResult, LazyExtensionsState } from "./types.js";
import { resolveExtensionPath } from "./config.js";
import { fileURLToPath } from "node:url";

const FAILURE_BACKOFF_MS = 60 * 1000;

/**
 * Deduplicated entry point for activating an extension.
 * Guards against concurrent activation of the same extension.
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
    touchExtension(name, state);
    return {
      success: true,
      name,
      tools: extState.registeredTools,
      commands: extState.registeredCommands,
    };
  }

  // --- Reactivation path (previously loaded, idle-unloaded) ---
  // Calling factory(pi) again would double-register event handlers (bug).
  // Instead, restore the already-registered tools to the active set.
  // Use factoryCalled (not registeredTools.length) as the gate so that
  // extensions registering zero tools don't fall through to a double
  // factory(pi) call.
  if (extState.factoryCalled) {
    const currentActive = new Set(pi.getActiveTools());
    const restored: string[] = [];
    for (const toolName of extState.registeredTools) {
      if (!currentActive.has(toolName)) {
        restored.push(toolName);
      }
    }
    if (restored.length > 0) {
      pi.setActiveTools([...currentActive, ...restored]);
    }

    extState.loaded = true;
    extState.lastActivated = Date.now();
    extState.lastUsed = Date.now();
    extState.error = undefined;
    scheduleIdleTimeout(name, state, pi);

    return {
      success: true,
      name,
      tools: extState.registeredTools,
      commands: extState.registeredCommands,
    };
  }

  // Check failure backoff
  const failedAgo = getFailureAgeSeconds(state, name);
  if (failedAgo !== null) {
    return {
      success: false,
      name,
      error: `Extension "${name}" recently failed (${failedAgo}s ago). Retry later.`,
    };
  }

  // Deduplicate concurrent activations
  if (extState.activationPromise) {
    return extState.activationPromise;
  }

  extState.activationPromise = performActivation(name, state, pi);
  try {
    const result = await extState.activationPromise;
    return result;
  } finally {
    extState.activationPromise = undefined;
  }
}

/**
 * Core first-time activation logic (wrapped by activateExtension for deduplication).
 */
async function performActivation(
  name: string,
  state: LazyExtensionsState,
  pi: ExtensionAPI,
): Promise<ActivationResult> {
  const extState = state.extensions.get(name)!;

  // Snapshot current registries to diff after load
  const toolsBefore = new Set(pi.getAllTools().map((t: any) => t.name as string));
  const commandsBefore = new Set(pi.getCommands().map((c: any) => c.name as string));

  // Wrap pi to intercept shortcuts, flags, and renderers registered
  // during factory(pi) — the ExtensionAPI doesn't expose getters for these.
  const registeredShortcuts: string[] = [];
  const registeredFlags: string[] = [];
  const registeredRenderers: string[] = [];
  const origRegisterShortcut = (pi as any).registerShortcut?.bind(pi);
  const origRegisterFlag = (pi as any).registerFlag?.bind(pi);
  const origRegisterMessageRenderer = (pi as any).registerMessageRenderer?.bind(pi);
  (pi as any).registerShortcut = (shortcut: string, options: any) => {
    registeredShortcuts.push(shortcut);
    origRegisterShortcut?.(shortcut, options);
  };
  (pi as any).registerFlag = (name: string, options: any) => {
    registeredFlags.push(name);
    origRegisterFlag?.(name, options);
  };
  (pi as any).registerMessageRenderer = (customType: string, renderer: any) => {
    registeredRenderers.push(customType);
    origRegisterMessageRenderer?.(customType, renderer);
  };

  const extPath = resolveExtensionPath(extState.config.path, state.baseDir);

  try {
    const factory = await loadExtensionFactory(extPath);

    if (!factory) {
      const message = `Extension "${name}" does not export a default factory function`;
      extState.error = message;
      state.failureTracker.set(name, Date.now());
      return { success: false, name, error: message };
    }

    // Invoke the extension factory with the shared ExtensionAPI.
    // This registers tools, events, commands, etc. into the same runtime.
    await factory(pi);

    // Diff to find what this extension registered
    const toolsAfter = pi.getAllTools().map((t: any) => t.name as string);
    const newTools = toolsAfter.filter(t => !toolsBefore.has(t));
    extState.registeredTools = newTools;

    // Diff commands the same way
    const commandsAfter = pi.getCommands().map((c: any) => c.name as string);
    const newCommands = commandsAfter.filter(c => !commandsBefore.has(c));
    extState.registeredCommands = newCommands;

    // Track shortcuts, flags, and renderers (informational — cannot be deactivated)
    // Track shortcuts, flags, and renderers (informational — cannot be deactivated)
    // These were captured by our wrapped pi methods during factory(pi).
    extState.registeredShortcuts = registeredShortcuts;
    extState.registeredFlags = registeredFlags;
    extState.registeredRenderers = registeredRenderers;

    extState.loaded = true;
    extState.factoryCalled = true;
    extState.lastActivated = Date.now();
    extState.lastUsed = Date.now();
    extState.error = undefined;
    state.failureTracker.delete(name);

    // Restore original pi methods
    (pi as any).registerShortcut = origRegisterShortcut;
    (pi as any).registerFlag = origRegisterFlag;
    (pi as any).registerMessageRenderer = origRegisterMessageRenderer;

    // Start idle timer if configured
    scheduleIdleTimeout(name, state, pi);

    return {
      success: true,
      name,
      tools: newTools,
      commands: extState.registeredCommands,
      shortcuts: registeredShortcuts,
      flags: registeredFlags,
      renderers: registeredRenderers,
    };
  } catch (error) {
    // Restore original pi methods on error too
    (pi as any).registerShortcut = origRegisterShortcut;
    (pi as any).registerFlag = origRegisterFlag;
    (pi as any).registerMessageRenderer = origRegisterMessageRenderer;

    const message = error instanceof Error ? error.message : String(error);
    extState.error = message;
    state.failureTracker.set(name, Date.now());
    return { success: false, name, error: message };
  }
}

/**
 * Build the jiti alias map that mirrors pi's own extension loader.
 *
 * Pi bundles core packages (typebox, @mariozechner/pi-ai, etc.) and resolves
 * them via aliases when loading extensions with jiti. Without these aliases,
 * extensions that `import { Type } from "typebox"` or import from
 * `@mariozechner/pi-coding-agent` will fail with module-not-found errors.
 *
 * We resolve the same packages via import.meta.resolve() which works
 * because pi-lazy-extensions itself depends on @mariozechner/pi-coding-agent
 * (the peer dependency is installed), and typebox is bundled by pi.
 */
let _jitiAliases: Record<string, string> | undefined;

function buildJitiAliases(): Record<string, string> {
  if (_jitiAliases) return _jitiAliases;

  const aliases: Record<string, string> = {};

  // Core pi packages that extensions commonly import
  const piPackages = [
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-tui",
    "@mariozechner/pi-ai",
    "@mariozechner/pi-ai/oauth",
  ] as const;

  for (const pkg of piPackages) {
    try {
      aliases[pkg] = fileURLToPath(import.meta.resolve(pkg));
    } catch {
      // Package not available in this environment — skip
    }
  }

  // typebox and its subpath exports (most extensions use `import { Type } from "typebox"`)
  const typeboxSpecs = ["typebox", "typebox/compile", "typebox/value"] as const;
  for (const spec of typeboxSpecs) {
    try {
      aliases[spec] = fileURLToPath(import.meta.resolve(spec));
    } catch {
      // typebox not available — skip
    }
  }

  // Alias legacy @sinclair/typebox to the same entries (some extensions still use it)
  if (aliases["typebox"]) {
    aliases["@sinclair/typebox"] = aliases["typebox"];
  }
  if (aliases["typebox/compile"]) {
    aliases["@sinclair/typebox/compile"] = aliases["typebox/compile"];
  }
  if (aliases["typebox/value"]) {
    aliases["@sinclair/typebox/value"] = aliases["typebox/value"];
  }

  _jitiAliases = aliases;
  return aliases;
}

/**
 * Reset cached jiti aliases (for testing or after module changes).
 */
export function resetJitiAliases(): void {
  _jitiAliases = undefined;
}

/**
 * Load an extension module and extract its default factory function.
 *
 * Tries jiti first (for TypeScript support and module alias resolution),
 * then falls back to raw import() for .js files or when jiti is unavailable.
 *
 * Jiti is configured with the same alias map that pi's own extension loader
 * uses, so extensions can import from `typebox`, `@mariozechner/pi-coding-agent`,
 * etc. just like they would in a normally-loaded extension.
 */
async function loadExtensionFactory(
  extPath: string,
): Promise<((pi: ExtensionAPI) => void | Promise<void>) | undefined> {
  // Attempt 1: jiti — handles .ts and provides SDK-compatible module aliases
  try {
    const { createJiti } = await import("@mariozechner/jiti");
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: buildJitiAliases(),
    });
    const mod = await jiti.import(extPath, { default: true });
    if (typeof mod === "function") {
      return mod as (pi: ExtensionAPI) => void | Promise<void>;
    }
    if (typeof (mod as any)?.default === "function") {
      return (mod as any).default as (pi: ExtensionAPI) => void | Promise<void>;
    }
    return undefined;
  } catch {
    // jiti unavailable or failed — fall through to raw import
  }

  // Attempt 2: raw import() — works for .js files, no TypeScript support
  const mod = await import(extPath);
  if (typeof mod.default === "function") {
    return mod.default as (pi: ExtensionAPI) => void | Promise<void>;
  }
  return undefined;
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
export function getFailureAgeSeconds(state: LazyExtensionsState, name: string): number | null {
  const failedAt = state.failureTracker.get(name);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) {
    state.failureTracker.delete(name);
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
 * mark it as unloaded. A subsequent activation restores tools to the
 * active set without re-calling factory(pi) (avoiding double handlers).
 */
function idleUnloadExtension(name: string, state: LazyExtensionsState, pi: ExtensionAPI): void {
  const extState = state.extensions.get(name);
  if (!extState || !extState.loaded) return;

  // Remove tools from the active set so the LLM can no longer call them.
  // Keep extState.registeredTools intact so reactivation can restore them
  // without re-calling factory(pi) (which would double-register event handlers).
  const activeTools = pi.getActiveTools();
  const remaining = activeTools.filter(t => !extState.registeredTools.includes(t));
  pi.setActiveTools(remaining);

  extState.loaded = false;
  extState.lastActivated = undefined;
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

