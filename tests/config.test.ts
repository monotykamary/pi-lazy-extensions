import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import {
  loadManifest,
  resolveExtensionPath,
  buildState,
  getEagerExtensions,
} from "../config.js";

import { makeManifest, makeManifestWithSettings, makeState } from "./helpers/mock-pi.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-lazy-config-"));
  tmpDirs.push(d);
  return d;
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

describe("loadManifest", () => {
  it("loads from LAZY_EXTENSIONS_CONFIG env var", () => {
    const d = tmpDir();
    const path = join(d, "env-manifest.json");
    writeJson(path, {
      version: 1,
      extensions: [{ name: "env-ext", path: "/tmp/env.ts" }],
    });

    vi.stubEnv("LAZY_EXTENSIONS_CONFIG", path);
    const result = loadManifest("/some/cwd", "/tmp/agent");
    expect(result).toBeTruthy();
    expect(result!.manifest.extensions).toHaveLength(1);
    expect(result!.manifest.extensions[0].name).toBe("env-ext");
  });

  it("loads from project .pi/lazy-extensions.json", () => {
    const d = tmpDir();
    const piDir = join(d, ".pi");
    mkdirSync(piDir);
    writeJson(join(piDir, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "project-ext", path: "./ext.ts" }],
    });

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeTruthy();
    expect(result!.manifest.extensions[0].name).toBe("project-ext");
  });

  it("loads from global agent dir", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "global-ext", path: "/tmp/global.ts" }],
    });

    const result = loadManifest("/nonexistent/cwd", d);
    expect(result).toBeTruthy();
    expect(result!.manifest.extensions[0].name).toBe("global-ext");
  });

  it("loads from project root lazy-extensions.json", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "root-ext", path: "./ext.ts" }],
    });

    // No .pi/ dir, no global — should fall back to project root
    const result = loadManifest(d, "/tmp/agent-nonexistent");
    expect(result).toBeTruthy();
    expect(result!.manifest.extensions[0].name).toBe("root-ext");
  });

  it("returns null when no manifest found anywhere", () => {
    const result = loadManifest(tmpDir(), tmpDir());
    expect(result).toBeNull();
  });

  it("rejects invalid manifest (wrong version)", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), {
      version: 99,
      extensions: [],
    });

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeNull();
  });

  it("rejects manifest missing extensions array", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), { version: 1 });

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeNull();
  });

  it("rejects manifest with extension missing name", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ path: "/tmp/no-name.ts" }],
    });

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeNull();
  });

  it("rejects manifest with extension missing path", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "no-path" }],
    });

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeNull();
  });

  it("rejects malformed JSON manifest", () => {
    const d = tmpDir();
    writeFileSync(join(d, "lazy-extensions.json"), "{ not valid json }", "utf-8");

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeNull();
  });

  it("rejects non-object JSON manifest (array)", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), ["not", "an", "object"]);

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeNull();
  });

  it("rejects null JSON manifest", () => {
    const d = tmpDir();
    writeJson(join(d, "lazy-extensions.json"), null);

    const result = loadManifest(d, "/tmp/agent");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveExtensionPath
// ---------------------------------------------------------------------------

describe("resolveExtensionPath", () => {
  it("passes through absolute paths", () => {
    expect(resolveExtensionPath("/abs/path.ts", "/base")).toBe("/abs/path.ts");
  });

  it("resolves relative paths against baseDir", () => {
    const resolved = resolveExtensionPath("./ext.ts", "/base/project");
    expect(resolved).toMatch(/^\/base\/project/);
    expect(resolved).toMatch(/ext\.ts$/);
    expect(resolved).toContain("/base/project");
  });

  it("resolves relative paths without ./ prefix", () => {
    const resolved = resolveExtensionPath("extensions/my-ext.ts", "/base/project");
    expect(resolved).toContain("/base/project/extensions/my-ext");
  });

  it("resolves parent directory paths", () => {
    const resolved = resolveExtensionPath("../shared/ext.ts", "/base/project");
    expect(resolved).toContain("/base/shared/ext");
    expect(resolved).not.toContain("/base/project");
  });

  it("expands ~/ to home directory", () => {
    const resolved = resolveExtensionPath("~/.pi/agent/extensions/todo.ts", "/base");
    // Must NOT start with /base/~ — should start with the actual home dir
    expect(resolved).not.toContain("~");
    expect(resolved).toMatch(/\.pi\/agent\/extensions\/todo\.ts$/);
    // Should be absolute
    expect(resolved.startsWith("/")).toBe(true);
  });

  it("expands bare ~ to home directory", () => {
    const resolved = resolveExtensionPath("~", "/base");
    expect(resolved).not.toContain("~");
    expect(resolved.startsWith("/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildState
// ---------------------------------------------------------------------------

describe("buildState", () => {
  it("creates state with all extensions marked unloaded", () => {
    const manifest = makeManifest([
      { name: "a", path: "/tmp/a.ts" },
      { name: "b", path: "/tmp/b.ts" },
    ]);
    const s = buildState(manifest, "/tmp/manifest.json");

    expect(s.extensions.size).toBe(2);
    for (const [, extState] of s.extensions) {
      expect(extState.loaded).toBe(false);
      expect(extState.factoryCalled).toBe(false);
      expect(extState.registeredTools).toEqual([]);
      expect(extState.registeredCommands).toEqual([]);
      expect(extState.lastActivated).toBeUndefined();
      expect(extState.lastUsed).toBeUndefined();
      expect(extState.error).toBeUndefined();
    }
  });

  it("records manifestPath and baseDir correctly", () => {
    const manifest = makeManifest([{ name: "x", path: "./ext.ts" }]);
    const s = buildState(manifest, "/home/user/.pi/agent/lazy-extensions.json");

    expect(s.manifestPath).toBe("/home/user/.pi/agent/lazy-extensions.json");
    expect(s.baseDir).toBe("/home/user/.pi/agent");
  });

  it("handles empty manifest", () => {
    const manifest = makeManifest([]);
    const s = buildState(manifest, "/tmp/empty.json");

    expect(s.extensions.size).toBe(0);
  });

  it("preserves config reference in each extension state", () => {
    const manifest = makeManifest([
      {
        name: "ext-with-config",
        path: "/tmp/ext.ts",
        lifecycle: "eager",
        description: "A test extension",
        toolSummary: ["tool_a", "tool_b"],
        tags: ["test"],
      },
    ]);
    const s = buildState(manifest, "/tmp/manifest.json");

    const extState = s.extensions.get("ext-with-config")!;
    expect(extState.config).toBe(manifest.extensions[0]);
    expect(extState.config.lifecycle).toBe("eager");
    expect(extState.config.description).toBe("A test extension");
    expect(extState.config.toolSummary).toEqual(["tool_a", "tool_b"]);
    expect(extState.config.tags).toEqual(["test"]);
  });
});

// ---------------------------------------------------------------------------
// getEagerExtensions
// ---------------------------------------------------------------------------

describe("getEagerExtensions", () => {
  it("returns extensions with lifecycle=eager or keep-alive", () => {
    const manifest = makeManifest([
      { name: "lazy1", path: "/tmp/lazy1.ts" },
      { name: "eager1", path: "/tmp/eager1.ts", lifecycle: "eager" },
      { name: "ka", path: "/tmp/ka.ts", lifecycle: "keep-alive" },
      { name: "lazy2", path: "/tmp/lazy2.ts", lifecycle: "lazy" },
    ]);
    const s = makeState(manifest);
    const eager = getEagerExtensions(s);

    expect(eager).toHaveLength(2);
    expect(eager.map(e => e.name)).toContain("eager1");
    expect(eager.map(e => e.name)).toContain("ka");
    expect(eager.map(e => e.name)).not.toContain("lazy1");
    expect(eager.map(e => e.name)).not.toContain("lazy2");
  });

  it("defaults to lazy lifecycle when not specified", () => {
    const manifest = makeManifest([
      { name: "implicit-lazy", path: "/tmp/impl.ts" },
    ]);
    const s = makeState(manifest);
    const eager = getEagerExtensions(s);

    expect(eager).toHaveLength(0);
  });

  it("honours eagerOverrides setting", () => {
    const manifest = makeManifestWithSettings(
      [
        { name: "lazy1", path: "/tmp/lazy1.ts" },
        { name: "lazy2", path: "/tmp/lazy2.ts" },
      ],
      { eagerOverrides: "lazy2" },
    );
    const s = makeState(manifest);
    const eager = getEagerExtensions(s);

    expect(eager).toHaveLength(1);
    expect(eager[0].name).toBe("lazy2");
  });

  it("handles multiple eagerOverrides with spaces", () => {
    const manifest = makeManifestWithSettings(
      [
        { name: "a", path: "/tmp/a.ts" },
        { name: "b", path: "/tmp/b.ts" },
        { name: "c", path: "/tmp/c.ts" },
      ],
      { eagerOverrides: "  a , c , nonexistent " },
    );
    const s = makeState(manifest);
    const eager = getEagerExtensions(s);

    expect(eager).toHaveLength(2);
    expect(eager.map(e => e.name)).toEqual(["a", "c"]);
  });

  it("deduplicates eagerOverrides that also match lifecycle", () => {
    const manifest = makeManifestWithSettings(
      [
        { name: "eager1", path: "/tmp/eager1.ts", lifecycle: "eager" },
        { name: "lazy1", path: "/tmp/lazy1.ts" },
      ],
      { eagerOverrides: "eager1,lazy1" },
    );
    const s = makeState(manifest);
    const eager = getEagerExtensions(s);

    // eager1 is already eager, lazy1 is overridden — both appear, no dupe
    expect(eager).toHaveLength(2);
    expect(new Set(eager.map(e => e.name)).size).toBe(2);
  });

  it("returns empty array when no eager extensions", () => {
    const manifest = makeManifest([
      { name: "lazy1", path: "/tmp/lazy1.ts", lifecycle: "lazy" },
      { name: "lazy2", path: "/tmp/lazy2.ts" },
    ]);
    const s = makeState(manifest);
    const eager = getEagerExtensions(s);

    expect(eager).toEqual([]);
  });

  it("handles empty eagerOverrides string", () => {
    const manifest = makeManifestWithSettings(
      [{ name: "lazy1", path: "/tmp/lazy1.ts" }],
      { eagerOverrides: "" },
    );
    const s = makeState(manifest);
    const eager = getEagerExtensions(s);

    expect(eager).toEqual([]);
  });
});
