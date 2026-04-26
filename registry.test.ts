/**
 * Tests for pi-lazy-extensions core modules.
 *
 * Covers:
 *  - registry.ts   (activate, touch, idle-unload, reactivation, failure backoff)
 *  - config.ts     (manifest loading, path resolution, buildState, getEagerExtensions)
 *  - proxy-modes.ts (status, search, activate, list-tools)
 *
 * Run: node --import tsx --test registry.test.ts
 *   or: npx tsx --test registry.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import {
  activateExtension,
  touchExtension,
  getFailureAgeSeconds,
  clearAllTimers,
  buildProxyDescription,
} from "./registry.js";

import {
  loadManifest,
  resolveExtensionPath,
  buildState,
  getEagerExtensions,
} from "./config.js";

import {
  executeStatus,
  executeSearch,
  executeActivate,
  executeListTools,
} from "./proxy-modes.js";

import {
  createMockPi,
  makeManifest,
  makeManifestWithSettings,
  makeState,
} from "./test-helpers.js";

import type { MockPi } from "./test-helpers.js";
import type { LazyExtensionsState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-lazy-ext-"));
  tmpDirs.push(d);
  return d;
}

function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
}

function writeExtensionFile(path: string, toolName: string): void {
  // Write a valid ESM extension module that registers one tool
  writeFileSync(
    path,
    `// test-extension
export default function (pi) {
  pi.registerTool({
    name: "${toolName}",
    label: "Test ${toolName}",
    description: "A test tool",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
}
`,
    "utf-8",
  );
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// registry.ts — activateExtension
// ---------------------------------------------------------------------------

describe("activateExtension", () => {
  let pi: MockPi;
  let state: LazyExtensionsState;

  beforeEach(() => {
    pi = createMockPi();
    const manifest = makeManifest([
      { name: "my-ext", path: "/nonexistent/my-ext.ts" },
      { name: "ext-with-tools", path: "/nonexistent/ext-with-tools.ts" },
    ]);
    state = makeState(manifest);
  });

  it("returns error for unknown extension name", async () => {
    const result = await activateExtension("nope", state, pi as any);
    assert.equal(result.success, false);
    assert.match(result.error!, /not found/);
  });

  it("returns error when extension file does not exist", async () => {
    const result = await activateExtension("my-ext", state, pi as any);
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it("activates an extension and discovers registered tools", async () => {
    const d = tmpDir();
    const extPath = join(d, "test-ext.js");
    writeExtensionFile(extPath, "hello_world");

    const manifest = makeManifest([{ name: "test-ext", path: extPath }]);
    const s = makeState(manifest);

    const beforeCount = pi.getAllTools().length;
    const result = await activateExtension("test-ext", s, pi as any);

    assert.equal(result.success, true);
    assert.deepEqual(result.tools, ["hello_world"]);
    // Tool should be in the full registry
    assert.ok(pi.getAllTools().some((t) => t.name === "hello_world"));
    // Tool should be active
    assert.ok(pi.getActiveTools().includes("hello_world"));
    // The extension state should be marked loaded
    const extState = s.extensions.get("test-ext")!;
    assert.equal(extState.loaded, true);
    assert.deepEqual(extState.registeredTools, ["hello_world"]);
    assert.equal(extState.error, undefined);
  });

  it("returns already-active for a loaded extension", async () => {
    // Pre-mark as loaded with known tools
    const extState = state.extensions.get("my-ext")!;
    extState.loaded = true;
    extState.registeredTools = ["tool_a", "tool_b"];
    extState.lastUsed = 0;

    const result = await activateExtension("my-ext", state, pi as any);

    assert.equal(result.success, true);
    assert.deepEqual(result.tools, ["tool_a", "tool_b"]);
    // lastUsed should have been touched
    assert.ok(extState.lastUsed! > 0);
  });

  it("honours failure backoff", async () => {
    const extState = state.extensions.get("my-ext")!;
    extState.error = "previous failure";
    // Simulate a recent failure by setting it in the failure tracker
    // (activateExtension sets it, but we need a fresh one)
    // We'll cause a real failure then retry immediately
    const first = await activateExtension("my-ext", state, pi as any);
    assert.equal(first.success, false);

    // Immediate retry should be blocked by backoff
    const second = await activateExtension("my-ext", state, pi as any);
    assert.equal(second.success, false);
    assert.match(second.error!, /recently failed/);
  });
});

// ---------------------------------------------------------------------------
// Critical bug fix: reactivation after idle-unload
// ---------------------------------------------------------------------------

describe("reactivation after idle-unload (bug fix #1 & #2)", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("restores tools to active set without re-calling factory(pi)", async () => {
    const d = tmpDir();
    const extPath = join(d, "idle-ext.js");
    writeExtensionFile(extPath, "idle_tool");

    const manifest = makeManifest([{ name: "idle-ext", path: extPath }]);
    const s = makeState(manifest);

    // --- First activation ---
    const r1 = await activateExtension("idle-ext", s, pi as any);
    assert.equal(r1.success, true);
    assert.deepEqual(r1.tools, ["idle_tool"]);
    assert.ok(pi.getActiveTools().includes("idle_tool"));

    const extState = s.extensions.get("idle-ext")!;
    const savedTools = [...extState.registeredTools];
    assert.deepEqual(savedTools, ["idle_tool"]);

    // --- Simulate idle-unload (remove from active, mark unloaded, keep tools) ---
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "idle_tool"));
    extState.loaded = false;
    extState.lastActivated = undefined;
    // registeredTools is preserved (the fix!)

    assert.equal(extState.loaded, false);
    assert.deepEqual(extState.registeredTools, ["idle_tool"]);
    assert.ok(!pi.getActiveTools().includes("idle_tool"));

    // --- Reactivation (the now-fixed path) ---
    // factory(pi) must NOT be called again; tools restored from preserved list
    const r2 = await activateExtension("idle-ext", s, pi as any);

    assert.equal(r2.success, true);
    assert.deepEqual(r2.tools, ["idle_tool"]);
    assert.ok(pi.getActiveTools().includes("idle_tool"));
    assert.equal(extState.loaded, true);

    // Ensure factory was NOT called twice:
    // _registeredTools should still have exactly one "idle_tool" (no duplicates)
    const idleToolCount = pi._registeredTools.filter((t) => t === "idle_tool").length;
    assert.equal(idleToolCount, 1, "factory(pi) should only be called once — no double registration");
  });

  it("does not restore tools that are already in the active set", async () => {
    // Edge case: if the tool somehow stayed active, reactivation is a no-op on tools
    const d = tmpDir();
    const extPath = join(d, "already-active-ext.js");
    writeExtensionFile(extPath, "always_active");

    const manifest = makeManifest([{ name: "already-active-ext", path: extPath }]);
    const s = makeState(manifest);

    const r1 = await activateExtension("already-active-ext", s, pi as any);
    assert.equal(r1.success, true);

    const extState = s.extensions.get("already-active-ext")!;
    extState.loaded = false; // simulate idle-unload BUT tool stays active (edge case)
    extState.lastActivated = undefined;

    const r2 = await activateExtension("already-active-ext", s, pi as any);
    assert.equal(r2.success, true);
    // Tool should still be in active set exactly once
    const count = pi.getActiveTools().filter((t) => t === "always_active").length;
    assert.equal(count, 1);
  });
});

// ---------------------------------------------------------------------------
// registry.ts — touch / failure / timers
// ---------------------------------------------------------------------------

describe("touchExtension", () => {
  it("updates lastUsed on a loaded extension", () => {
    const pi = createMockPi();
    const manifest = makeManifest([{ name: "x", path: "/tmp/x.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("x")!;
    extState.loaded = true;
    extState.lastUsed = 1000;

    touchExtension("x", s);

    assert.ok(extState.lastUsed! > 1000);
  });

  it("does nothing for unloaded extensions", () => {
    const pi = createMockPi();
    const manifest = makeManifest([{ name: "x", path: "/tmp/x.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("x")!;
    extState.loaded = false;
    const before = extState.lastUsed;

    touchExtension("x", s);

    assert.equal(extState.lastUsed, before);
  });

  it("does nothing for unknown extensions", () => {
    const s = makeState(makeManifest([]));
    // Should not throw
    touchExtension("nonexistent", s);
  });
});

describe("getFailureAgeSeconds", () => {
  it("returns null when no failure recorded", () => {
    assert.equal(getFailureAgeSeconds("never-failed"), null);
  });
});

describe("clearAllTimers", () => {
  it("clears all idle timers", () => {
    const pi = createMockPi();
    const manifest = makeManifest([{ name: "a", path: "/tmp/a.ts" }]);
    const s = makeState(manifest);

    const extState = s.extensions.get("a")!;
    extState.idleTimer = setTimeout(() => {}, 999999);

    clearAllTimers(s);
    assert.equal(extState.idleTimer, undefined);
  });
});

// ---------------------------------------------------------------------------
// registry.ts — buildProxyDescription
// ---------------------------------------------------------------------------

describe("buildProxyDescription", () => {
  it("lists all extensions with lifecycle and tools", () => {
    const manifest = makeManifest([
      {
        name: "todo",
        path: "/tmp/todo.ts",
        lifecycle: "lazy",
        description: "Task manager",
        toolSummary: ["todo_add", "todo_list"],
      },
      {
        name: "gcp",
        path: "/tmp/gcp.ts",
        lifecycle: "keep-alive",
        tags: ["cloud"],
      },
    ]);
    const s = makeState(manifest);
    // Mark gcp as loaded
    s.extensions.get("gcp")!.loaded = true;

    const desc = buildProxyDescription(s);

    assert.ok(desc.includes("todo"));
    assert.ok(desc.includes("lazy"));
    assert.ok(desc.includes("Task manager"));
    assert.ok(desc.includes("todo_add"));
    assert.ok(desc.includes("todo_list"));
    assert.ok(desc.includes("gcp"));
    assert.ok(desc.includes("keep-alive"));
    assert.ok(desc.includes("✓ active"));
    assert.ok(desc.includes("cloud"));
    assert.ok(desc.includes("ext({ search:"));
  });
});

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

describe("config", () => {
  describe("loadManifest", () => {
    it("loads from LAZY_EXTENSIONS_CONFIG env var", () => {
      const d = tmpDir();
      const path = join(d, "manifest.json");
      writeJson(path, {
        version: 1,
        extensions: [{ name: "env-ext", path: "/tmp/env.ts" }],
      });

      process.env.LAZY_EXTENSIONS_CONFIG = path;
      try {
        const result = loadManifest("/some/cwd", "/tmp/agent");
        assert.ok(result);
        assert.equal(result!.manifest.extensions.length, 1);
        assert.equal(result!.manifest.extensions[0].name, "env-ext");
      } finally {
        delete process.env.LAZY_EXTENSIONS_CONFIG;
      }
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
      assert.ok(result);
      assert.equal(result!.manifest.extensions[0].name, "project-ext");
    });

    it("loads from global agent dir", () => {
      const d = tmpDir();
      writeJson(join(d, "lazy-extensions.json"), {
        version: 1,
        extensions: [{ name: "global-ext", path: "/tmp/global.ts" }],
      });

      const result = loadManifest("/nonexistent/cwd", d);
      assert.ok(result);
      assert.equal(result!.manifest.extensions[0].name, "global-ext");
    });

    it("returns null when no manifest found", () => {
      const result = loadManifest(tmpDir(), tmpDir());
      assert.equal(result, null);
    });

    it("rejects invalid manifest (wrong version)", () => {
      const d = tmpDir();
      writeJson(join(d, "lazy-extensions.json"), {
        version: 99,
        extensions: [],
      });

      const result = loadManifest(d, "/tmp/agent");
      assert.equal(result, null);
    });

    it("rejects manifest missing extensions array", () => {
      const d = tmpDir();
      writeJson(join(d, "lazy-extensions.json"), { version: 1 });

      const result = loadManifest(d, "/tmp/agent");
      assert.equal(result, null);
    });

    it("rejects manifest with extension missing name", () => {
      const d = tmpDir();
      writeJson(join(d, "lazy-extensions.json"), {
        version: 1,
        extensions: [{ path: "/tmp/no-name.ts" }],
      });

      const result = loadManifest(d, "/tmp/agent");
      assert.equal(result, null);
    });
  });

  describe("resolveExtensionPath", () => {
    it("passes through absolute paths", () => {
      assert.equal(resolveExtensionPath("/abs/path.ts", "/base"), "/abs/path.ts");
    });

    it("resolves relative paths against baseDir", () => {
      const resolved = resolveExtensionPath("./ext.ts", "/base/project");
      assert.ok(resolved.startsWith("/base/project"));
      assert.ok(resolved.endsWith("ext.ts"));
    });
  });

  describe("buildState", () => {
    it("creates state with all extensions marked unloaded", () => {
      const manifest = makeManifest([
        { name: "a", path: "/tmp/a.ts" },
        { name: "b", path: "/tmp/b.ts" },
      ]);
      const s = buildState(manifest, "/tmp/manifest.json");

      assert.equal(s.extensions.size, 2);
      for (const [, extState] of s.extensions) {
        assert.equal(extState.loaded, false);
        assert.deepEqual(extState.registeredTools, []);
      }
    });
  });

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

      assert.equal(eager.length, 2);
      assert.ok(eager.some((e) => e.name === "eager1"));
      assert.ok(eager.some((e) => e.name === "ka"));
      assert.ok(!eager.some((e) => e.name === "lazy1"));
      assert.ok(!eager.some((e) => e.name === "lazy2"));
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

      assert.equal(eager.length, 1);
      assert.equal(eager[0].name, "lazy2");
    });
  });
});

// ---------------------------------------------------------------------------
// proxy-modes.ts
// ---------------------------------------------------------------------------

describe("proxy-modes", () => {
  let pi: MockPi;
  let state: LazyExtensionsState;

  beforeEach(() => {
    pi = createMockPi();
    const manifest = makeManifest([
      {
        name: "todo",
        path: "/tmp/todo.js",
        description: "Task management",
        toolSummary: ["todo_add", "todo_list"],
        tags: ["productivity"],
      },
      {
        name: "gcp",
        path: "/tmp/gcp.js",
        description: "Cloud operations",
        toolSummary: ["gcp_deploy"],
        tags: ["cloud", "infra"],
      },
      {
        name: "broken",
        path: "/tmp/broken.js",
      },
    ]);
    state = makeState(manifest);

    // Pre-activate todo with registered tools
    const todoState = state.extensions.get("todo")!;
    todoState.loaded = true;
    todoState.registeredTools = ["todo_add", "todo_list"];

    // Mark broken as failed
    const brokenState = state.extensions.get("broken")!;
    brokenState.error = "Module not found";
  });

  // ------------------------------------------------------------------
  // executeStatus
  // ------------------------------------------------------------------

  describe("executeStatus", () => {
    it("reports active, inactive, and failed extensions", () => {
      const result = executeStatus(state);

      const text = result.content[0].text as string;
      assert.ok(text.includes("1/3 active"));
      assert.ok(text.includes("todo"));       // active ✓
      assert.ok(text.includes("gcp"));        // inactive ○
      assert.ok(text.includes("broken"));     // failed ✗
      assert.ok(text.includes("Module not found"));
      assert.ok(text.includes("ext({ search:"));
    });

    it("includes tool counts from preserved registeredTools", () => {
      // Simulate: gcp was previously loaded, idle-unloaded, registeredTools preserved
      const gcpState = state.extensions.get("gcp")!;
      gcpState.registeredTools = ["gcp_deploy", "gcp_status"];
      // loaded remains false

      const result = executeStatus(state);
      const text = result.content[0].text as string;
      assert.ok(text.includes("gcp"));     // shown as inactive
      assert.ok(text.includes("2 tools")); // from preserved list, not manifest toolSummary
    });
  });

  // ------------------------------------------------------------------
  // executeSearch
  // ------------------------------------------------------------------

  describe("executeSearch", () => {
    it("finds extensions by name", () => {
      const result = executeSearch(state, "todo");
      assert.equal(result.details.matches.length, 1);
      assert.equal(result.details.matches[0].name, "todo");
      assert.ok(result.details.matches[0].matchReason.includes("name"));
    });

    it("finds extensions by description", () => {
      const result = executeSearch(state, "cloud");
      assert.equal(result.details.matches.length, 1);
      assert.equal(result.details.matches[0].name, "gcp");
      assert.ok(result.details.matches[0].matchReason.includes("description"));
    });

    it("finds extensions by tags", () => {
      const result = executeSearch(state, "productivity");
      assert.equal(result.details.matches.length, 1);
      assert.equal(result.details.matches[0].name, "todo");
      assert.ok(result.details.matches[0].matchReason.includes("tags"));
    });

    it("finds extensions by toolSummary", () => {
      const result = executeSearch(state, "deploy");
      assert.equal(result.details.matches.length, 1);
      assert.equal(result.details.matches[0].name, "gcp");
      assert.ok(result.details.matches[0].matchReason.includes("tools"));
    });

    it("finds extensions by registered tools", () => {
      const result = executeSearch(state, "todo_add");
      assert.equal(result.details.matches.length, 1);
      assert.ok(result.details.matches[0].matchReason.includes("registered tools"));
    });

    it("returns empty for no matches", () => {
      const result = executeSearch(state, "zzz_nonexistent_zzz");
      assert.equal(result.details.matches.length, 0);
      assert.ok((result.content[0].text as string).includes("No extensions matching"));
    });

    it("supports regex mode", () => {
      const result = executeSearch(state, "gc|br", true);
      assert.equal(result.details.matches.length, 2); // gcp + broken
    });

    it("handles multi-word queries as AND terms", () => {
      const result = executeSearch(state, "cloud deploy");
      // "cloud" matches gcp description, "deploy" matches gcp toolSummary
      assert.equal(result.details.matches.length, 1);
      assert.equal(result.details.matches[0].name, "gcp");
    });

    it("returns error for empty query", () => {
      const result = executeSearch(state, "");
      assert.equal(result.details.error, "empty_query");
    });
  });

  // ------------------------------------------------------------------
  // executeActivate
  // ------------------------------------------------------------------

  describe("executeActivate", () => {
    it("returns not-found for unknown extension", async () => {
      const result = await executeActivate(state, "nope", pi as any);
      assert.equal(result.details.error, "not_found");
    });

    it("returns already-active for loaded extension", async () => {
      const result = await executeActivate(state, "todo", pi as any);
      assert.equal(result.details.alreadyActive, true);
      assert.deepEqual(result.details.tools, ["todo_add", "todo_list"]);
    });

    it("delegates to activateExtension for unloaded extensions", async () => {
      // gcp is not loaded; will fail because the file doesn't exist
      const result = await executeActivate(state, "gcp", pi as any);
      assert.equal(result.details.error, "activation_failed");
    });
  });

  // ------------------------------------------------------------------
  // executeListTools
  // ------------------------------------------------------------------

  describe("executeListTools", () => {
    it("shows tools for a specific active extension", () => {
      const result = executeListTools(state, "todo", () => pi.getAllTools());
      const text = result.content[0].text as string;
      assert.ok(text.includes("todo_add"));
      assert.ok(text.includes("todo_list"));
    });

    it("shows preserved tools for idle-unloaded extension (bug fix follow-on)", () => {
      // Simulate: gcp was previously loaded, idle-unloaded
      const gcpState = state.extensions.get("gcp")!;
      gcpState.registeredTools = ["gcp_deploy", "gcp_status"];
      // loaded remains false

      const result = executeListTools(state, "gcp");
      const text = result.content[0].text as string;
      assert.ok(text.includes("not active"));
      assert.ok(text.includes("gcp_deploy")); // from preserved registeredTools
      assert.ok(text.includes("gcp_status"));
    });

    it("falls back to toolSummary when never loaded", () => {
      // gcp has toolSummary in config, registeredTools empty
      const gcpState = state.extensions.get("gcp")!;
      gcpState.registeredTools = [];

      const result = executeListTools(state, "gcp");
      const text = result.content[0].text as string;
      assert.ok(text.includes("not active"));
      assert.ok(text.includes("gcp_deploy")); // from manifest toolSummary
    });

    it("lists all active extension tools when no name given", () => {
      const result = executeListTools(state, undefined, () => pi.getAllTools());
      const text = result.content[0].text as string;
      // Only todo is active, with 2 tools (todo_add, todo_list)
      assert.ok(text.includes("Active extension tools (2):"));
      assert.ok(text.includes("todo_add"));
      assert.ok(text.includes("todo_list"));
    });

    it("returns not-found for unknown extension", () => {
      const result = executeListTools(state, "nonexistent");
      assert.equal(result.details.error, "not_found");
    });

    it("returns empty message when no tools are active", () => {
      const emptyManifest = makeManifest([]);
      const emptyState = makeState(emptyManifest);
      const result = executeListTools(emptyState);
      assert.ok((result.content[0].text as string).includes("No extension tools currently active"));
    });
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle integration: activate → idle-unload → reactivate
// ---------------------------------------------------------------------------

describe("full lifecycle", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("activate → idle-unload → reactivate preserves tools without duplicate handlers", async () => {
    const d = tmpDir();
    const extPath = join(d, "lifecycle-ext.js");
    writeExtensionFile(extPath, "lifecycle_tool");

    const manifest = makeManifest([{ name: "lifecycle-ext", path: extPath }]);
    const s = makeState(manifest);

    // 1. Activate (first time — calls factory)
    const r1 = await activateExtension("lifecycle-ext", s, pi as any);
    assert.equal(r1.success, true);
    assert.deepEqual(r1.tools, ["lifecycle_tool"]);
    assert.ok(pi.getActiveTools().includes("lifecycle_tool"));
    assert.equal(s.extensions.get("lifecycle-ext")!.loaded, true);

    // 2. Idle-unload (tools removed from active, loaded=false, registeredTools preserved)
    const extState = s.extensions.get("lifecycle-ext")!;
    const savedTools = [...extState.registeredTools];
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "lifecycle_tool"));
    extState.loaded = false;
    extState.lastActivated = undefined;

    assert.equal(extState.loaded, false);
    assert.deepEqual(extState.registeredTools, savedTools);
    assert.ok(!pi.getActiveTools().includes("lifecycle_tool"));

    // 3. Reactivate (should NOT call factory — uses preserved tools)
    const r2 = await activateExtension("lifecycle-ext", s, pi as any);
    assert.equal(r2.success, true);
    assert.deepEqual(r2.tools, ["lifecycle_tool"]);
    assert.ok(pi.getActiveTools().includes("lifecycle_tool"));
    assert.equal(extState.loaded, true);

    // 4. Verify factory was only called once
    assert.equal(
      pi._registeredTools.filter((t) => t === "lifecycle_tool").length,
      1,
      "factory(pi) should be called exactly once",
    );

    // 5. Idle-unload again, reactivate again — still no duplicates
    pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "lifecycle_tool"));
    extState.loaded = false;

    const r3 = await activateExtension("lifecycle-ext", s, pi as any);
    assert.equal(r3.success, true);
    assert.ok(pi.getActiveTools().includes("lifecycle_tool"));
    assert.equal(
      pi._registeredTools.filter((t) => t === "lifecycle_tool").length,
      1,
      "no duplicate registrations across multiple reactivation cycles",
    );
  });

  it("tool_execution_end touch resets idle timer (touchExtension)", () => {
    const manifest = makeManifest([{ name: "timer-ext", path: "/tmp/timer-ext.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("timer-ext")!;
    extState.loaded = true;
    extState.registeredTools = ["timer_tool"];
    extState.lastUsed = 1000;

    // Simulate tool_execution_end event for this extension's tool
    touchExtension("timer-ext", s);

    assert.ok(extState.lastUsed! > 1000);
  });

  it("clearAllTimers during session_shutdown cleans up", () => {
    const manifest = makeManifest([
      { name: "a", path: "/tmp/a.ts" },
      { name: "b", path: "/tmp/b.ts" },
    ]);
    const s = makeState(manifest);

    s.extensions.get("a")!.idleTimer = setTimeout(() => {}, 999999);
    s.extensions.get("b")!.idleTimer = setTimeout(() => {}, 999999);

    clearAllTimers(s);

    assert.equal(s.extensions.get("a")!.idleTimer, undefined);
    assert.equal(s.extensions.get("b")!.idleTimer, undefined);
  });
});
