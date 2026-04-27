/**
 * Configuration loading for pi-lazy-extensions.
 *
 * Reads a manifest file (lazy-extensions.json) that describes which
 * extensions to lazy-load and their metadata.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LazyExtensionConfig, LazyExtensionsManifest, LazyExtensionsState, LoadedExtensionState } from "./types.js";

/**
 * Find and load the manifest file.
 *
 * Resolution order:
 * 1. LAZY_EXTENSIONS_CONFIG env var (explicit path)
 * 2. Project .pi/lazy-extensions.json
 * 3. Global ~/.pi/agent/lazy-extensions.json
 * 4. Project lazy-extensions.json
 */
export function loadManifest(cwd: string, agentDir: string): { manifest: LazyExtensionsManifest; path: string } | null {
  const envPath = process.env.LAZY_EXTENSIONS_CONFIG;
  if (envPath && existsSync(envPath)) {
    const manifest = parseManifest(envPath);
    if (manifest) return { manifest, path: resolve(envPath) };
  }

  // Project .pi dir
  const projectPi = join(cwd, ".pi", "lazy-extensions.json");
  if (existsSync(projectPi)) {
    const manifest = parseManifest(projectPi);
    if (manifest) return { manifest, path: projectPi };
  }

  // Global agent dir
  const globalPath = join(agentDir, "lazy-extensions.json");
  if (existsSync(globalPath)) {
    const manifest = parseManifest(globalPath);
    if (manifest) return { manifest, path: globalPath };
  }

  // Project root
  const projectRoot = join(cwd, "lazy-extensions.json");
  if (existsSync(projectRoot)) {
    const manifest = parseManifest(projectRoot);
    if (manifest) return { manifest, path: projectRoot };
  }

  return null;
}

function parseManifest(filePath: string): LazyExtensionsManifest | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 1) {
      console.error(`pi-lazy-extensions: unsupported manifest version ${parsed.version}`);
      return null;
    }
    if (!Array.isArray(parsed.extensions)) {
      console.error("pi-lazy-extensions: manifest missing 'extensions' array");
      return null;
    }

    // Validate entries
    for (const ext of parsed.extensions as LazyExtensionConfig[]) {
      if (!ext.name || typeof ext.name !== "string") {
        console.error("pi-lazy-extensions: extension entry missing 'name'");
        return null;
      }
      if (!ext.path || typeof ext.path !== "string") {
        console.error(`pi-lazy-extensions: extension "${ext.name}" missing 'path'`);
        return null;
      }
    }

    return parsed as LazyExtensionsManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`pi-lazy-extensions: failed to parse ${filePath}: ${message}`);
    return null;
  }
}

/**
 * Expand leading ~ to the user's home directory.
 * Mirrors the pi SDK's own expandPath() in its extension loader.
 */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  if (p === "~") {
    return homedir();
  }
  return p;
}

/**
 * Resolve an extension path relative to the manifest's base directory.
 * Supports ~ expansion (e.g. "~/.pi/agent/extensions/todo.ts").
 */
export function resolveExtensionPath(extPath: string, baseDir: string): string {
  const expanded = expandTilde(extPath);
  if (isAbsolute(expanded)) return expanded;
  return resolve(baseDir, expanded);
}

/**
 * Build initial state from a loaded manifest.
 */
export function buildState(
  manifest: LazyExtensionsManifest,
  manifestPath: string,
): LazyExtensionsState {
  const baseDir = dirname(manifestPath);
  const extensions = new Map<string, LoadedExtensionState>();

  for (const config of manifest.extensions) {
    extensions.set(config.name, {
      config,
      loaded: false,
      factoryCalled: false,
      registeredTools: [],
      registeredCommands: [],
    });
  }

  return { extensions, manifest, manifestPath, baseDir, failureTracker: new Map() };
}

/**
 * Determine which extensions should be loaded eagerly at startup.
 */
export function getEagerExtensions(state: LazyExtensionsState): LazyExtensionConfig[] {
  const rawOverrides = state.manifest.settings?.eagerOverrides ?? "";
  const eagerOverrides = new Set(
    rawOverrides.split(",").map(s => s.trim()).filter(Boolean)
  );

  return state.manifest.extensions.filter(ext => {
    if (eagerOverrides.has(ext.name)) return true;
    const lifecycle = ext.lifecycle ?? "lazy";
    return lifecycle === "eager" || lifecycle === "keep-alive";
  });
}
