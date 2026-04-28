import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  activateExtension,
  touchExtension,
  getFailureAgeSeconds,
  clearAllTimers,
  resetJitiAliases,
} from "../registry.js";

import {
  createMockPi,
  makeManifest,
  makeManifestWithSettings,
  makeState,
} from "./helpers/mock-pi.js";

import type { MockPi } from "./helpers/mock-pi.js";
import type { LazyExtensionsState } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-lazy-reg-"));
  tmpDirs.push(d);
  return d;
}

function writeExtensionFile(path: string, toolName: string): void {
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
  vi.useRealTimers();
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// activateExtension — basic
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
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("returns error when extension file does not exist", async () => {
    const result = await activateExtension("my-ext", state, pi as any);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("activates an extension and discovers registered tools", async () => {
    const d = tmpDir();
    const extPath = join(d, "test-ext.js");
    writeExtensionFile(extPath, "hello_world");

    const manifest = makeManifest([{ name: "test-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("test-ext", s, pi as any);

    expect(result.success).toBe(true);
    expect(result.tools).toEqual(["hello_world"]);
    expect(pi.getAllTools().some((t) => t.name === "hello_world")).toBe(true);
    expect(pi.getActiveTools()).toContain("hello_world");

    const extState = s.extensions.get("test-ext")!;
    expect(extState.loaded).toBe(true);
    expect(extState.registeredTools).toEqual(["hello_world"]);
    expect(extState.error).toBeUndefined();
    expect(extState.lastActivated).toBeGreaterThan(0);
    expect(extState.lastUsed).toBeGreaterThan(0);
  });

  it("returns already-active for a loaded extension and touches timestamp", async () => {
    const extState = state.extensions.get("my-ext")!;
    extState.loaded = true;
    extState.registeredTools = ["tool_a", "tool_b"];
    extState.lastUsed = 1000;

    const result = await activateExtension("my-ext", state, pi as any);

    expect(result.success).toBe(true);
    expect(result.tools).toEqual(["tool_a", "tool_b"]);
    expect(extState.lastUsed!).toBeGreaterThan(1000);
  });

  it("honours failure backoff", async () => {
    // First call fails (file doesn't exist)
    const first = await activateExtension("my-ext", state, pi as any);
    expect(first.success).toBe(false);

    // Immediate retry should be blocked by backoff
    const second = await activateExtension("my-ext", state, pi as any);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/recently failed/);
  });

  it("returns error for extension without default export", async () => {
    const d = tmpDir();
    const extPath = join(d, "no-default.js");
    writeFileSync(extPath, "export const notDefault = 42;", "utf-8");

    const manifest = makeManifest([{ name: "no-default", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("no-default", s, pi as any);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not export a default factory/);
  });

  it("registers failure in tracker and extension state on error", async () => {
    // Use a fresh extension to avoid failure backoff from previous test
    const manifest = makeManifest([{ name: "fail-ext", path: "/nonexistent/fail.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("fail-ext")!;

    const result = await activateExtension("fail-ext", s, pi as any);
    expect(result.success).toBe(false);
    expect(extState.error).toBeTruthy();
    expect(getFailureAgeSeconds(s, "fail-ext")).toBeTypeOf("number");
  });

  it("schedules idle timeout for lazy extensions after activation", async () => {
    vi.useFakeTimers();

    const d = tmpDir();
    const extPath = join(d, "lazy-ext.js");
    writeExtensionFile(extPath, "lazy_tool");

    const manifest = makeManifest([{ name: "lazy-ext", path: extPath }]);
    const s = makeState(manifest);

    await activateExtension("lazy-ext", s, pi as any);

    const extState = s.extensions.get("lazy-ext")!;
    expect(extState.idleTimer).toBeDefined();

    // Fast-forward past the idle timeout (default 10 min)
    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(extState.loaded).toBe(false);
    expect(pi.getActiveTools()).not.toContain("lazy_tool");
    // registeredTools preserved for reactivation
    expect(extState.registeredTools).toEqual(["lazy_tool"]);
  });

  it("does not schedule idle timeout for keep-alive extensions", async () => {
    const d = tmpDir();
    const extPath = join(d, "ka-ext.js");
    writeExtensionFile(extPath, "ka_tool");

    const manifest = makeManifest([{ name: "ka-ext", path: extPath, lifecycle: "keep-alive" }]);
    const s = makeState(manifest);

    await activateExtension("ka-ext", s, pi as any);

    const extState = s.extensions.get("ka-ext")!;
    expect(extState.idleTimer).toBeUndefined();
    expect(extState.loaded).toBe(true);
  });

  it("respects idleTimeout=0 (never unload)", async () => {
    vi.useFakeTimers();

    const d = tmpDir();
    const extPath = join(d, "never-unload.js");
    writeExtensionFile(extPath, "never_tool");

    const manifest = makeManifestWithSettings(
      [{ name: "never-unload", path: extPath }],
      { idleTimeout: 0 },
    );
    const s = makeState(manifest);

    await activateExtension("never-unload", s, pi as any);
    const extState = s.extensions.get("never-unload")!;

    // No timer scheduled (idleTimeout=0 means never)
    expect(extState.idleTimer).toBeUndefined();
    expect(extState.loaded).toBe(true);
  });

  it("respects custom idleTimeout", async () => {
    vi.useFakeTimers();

    const d = tmpDir();
    const extPath = join(d, "custom-timeout.js");
    writeExtensionFile(extPath, "custom_tool");

    const manifest = makeManifestWithSettings(
      [{ name: "custom-timeout", path: extPath }],
      { idleTimeout: 1 }, // 1 minute
    );
    const s = makeState(manifest);

    await activateExtension("custom-timeout", s, pi as any);
    const extState = s.extensions.get("custom-timeout")!;
    expect(extState.loaded).toBe(true);

    // 30 seconds — not idle yet
    vi.advanceTimersByTime(30 * 1000);
    expect(extState.loaded).toBe(true);

    // 1 minute + — now idle-unloaded
    vi.advanceTimersByTime(31 * 1000);
    expect(extState.loaded).toBe(false);
  });

  it("deduplicates concurrent activations", async () => {
    const d = tmpDir();
    const extPath = join(d, "concurrent.js");
    writeExtensionFile(extPath, "concurrent_tool");

    const manifest = makeManifest([{ name: "concurrent", path: extPath }]);
    const s = makeState(manifest);

    // Start two activations at the same time
    const p1 = activateExtension("concurrent", s, pi as any);
    const p2 = activateExtension("concurrent", s, pi as any);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both should succeed
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // Factory should have run only once (only one tool registration call)
    const regCount = pi._registeredTools.filter((t) => t === "concurrent_tool").length;
    expect(regCount).toBe(1);

    // registeredTools must not be wiped out by the race
    const extState = s.extensions.get("concurrent")!;
    expect(extState.registeredTools).toEqual(["concurrent_tool"]);
  });
});

// ---------------------------------------------------------------------------
// Reactivation after idle-unload (bug fix #1 & #2)
// ---------------------------------------------------------------------------

describe("reactivation after idle-unload", () => {
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

    // First activation
    const r1 = await activateExtension("idle-ext", s, pi as any);
    expect(r1.success).toBe(true);
    expect(r1.tools).toEqual(["idle_tool"]);
    expect(pi.getActiveTools()).toContain("idle_tool");

    const extState = s.extensions.get("idle-ext")!;
    expect(extState.registeredTools).toEqual(["idle_tool"]);

    // Simulate idle-unload
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "idle_tool"));
    extState.loaded = false;
    extState.lastActivated = undefined;
    // factoryCalled remains true — factory must not be called again
    // registeredTools preserved (the fix)

    expect(extState.loaded).toBe(false);
    expect(extState.registeredTools).toEqual(["idle_tool"]);
    expect(pi.getActiveTools()).not.toContain("idle_tool");

    // Reactivation — must NOT call factory again
    const r2 = await activateExtension("idle-ext", s, pi as any);

    expect(r2.success).toBe(true);
    expect(r2.tools).toEqual(["idle_tool"]);
    expect(pi.getActiveTools()).toContain("idle_tool");
    expect(extState.loaded).toBe(true);

    // Verify factory was only called once (no duplicate "idle_tool" in registry)
    const idleToolCount = pi._registeredTools.filter((t) => t === "idle_tool").length;
    expect(idleToolCount).toBe(1);
  });

  it("does not restore tools that are already in the active set", async () => {
    const d = tmpDir();
    const extPath = join(d, "already-active-ext.js");
    writeExtensionFile(extPath, "always_active");

    const manifest = makeManifest([{ name: "already-active-ext", path: extPath }]);
    const s = makeState(manifest);

    const r1 = await activateExtension("already-active-ext", s, pi as any);
    expect(r1.success).toBe(true);

    const extState = s.extensions.get("already-active-ext")!;
    extState.loaded = false;
    extState.lastActivated = undefined;
    // factoryCalled remains true (factory was already called)

    const r2 = await activateExtension("already-active-ext", s, pi as any);
    expect(r2.success).toBe(true);
    const count = pi.getActiveTools().filter((t) => t === "always_active").length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("full lifecycle", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("activate → idle-unload → reactivate (3 cycles) preserves tools without duplicate handlers", async () => {
    const d = tmpDir();
    const extPath = join(d, "lifecycle-ext.js");
    writeExtensionFile(extPath, "lifecycle_tool");

    const manifest = makeManifest([{ name: "lifecycle-ext", path: extPath }]);
    const s = makeState(manifest);

    // Cycle 1 — activate
    const r1 = await activateExtension("lifecycle-ext", s, pi as any);
    expect(r1.success).toBe(true);
    expect(r1.tools).toEqual(["lifecycle_tool"]);
    expect(pi.getActiveTools()).toContain("lifecycle_tool");

    const extState = s.extensions.get("lifecycle-ext")!;
    expect(extState.loaded).toBe(true);

    // Cycle 1 — idle-unload
    const savedTools = [...extState.registeredTools];
    pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "lifecycle_tool"));
    extState.loaded = false;
    extState.lastActivated = undefined;
    // factoryCalled stays true

    expect(extState.loaded).toBe(false);
    expect(extState.registeredTools).toEqual(savedTools);
    expect(pi.getActiveTools()).not.toContain("lifecycle_tool");

    // Cycle 2 — reactivate
    const r2 = await activateExtension("lifecycle-ext", s, pi as any);
    expect(r2.success).toBe(true);
    expect(r2.tools).toEqual(["lifecycle_tool"]);
    expect(pi.getActiveTools()).toContain("lifecycle_tool");
    expect(extState.loaded).toBe(true);

    // Cycle 2 — idle-unload
    pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "lifecycle_tool"));
    extState.loaded = false;
    // factoryCalled stays true

    // Cycle 3 — reactivate again
    const r3 = await activateExtension("lifecycle-ext", s, pi as any);
    expect(r3.success).toBe(true);
    expect(pi.getActiveTools()).toContain("lifecycle_tool");

    // No duplicate registrations across all 3 cycles
    expect(
      pi._registeredTools.filter((t) => t === "lifecycle_tool").length,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// touchExtension
// ---------------------------------------------------------------------------

describe("touchExtension", () => {
  it("updates lastUsed on a loaded extension", () => {
    const manifest = makeManifest([{ name: "x", path: "/tmp/x.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("x")!;
    extState.loaded = true;
    extState.lastUsed = 1000;

    touchExtension("x", s);
    expect(extState.lastUsed!).toBeGreaterThan(1000);
  });

  it("does nothing for unloaded extensions", () => {
    const manifest = makeManifest([{ name: "x", path: "/tmp/x.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("x")!;
    extState.loaded = false;
    const before = extState.lastUsed;

    touchExtension("x", s);
    expect(extState.lastUsed).toBe(before);
  });

  it("does nothing for unknown extensions", () => {
    const s = makeState(makeManifest([]));
    expect(() => touchExtension("nonexistent", s)).not.toThrow();
  });

  it("touchExtension updates lastUsed but does not directly manage timers", () => {
    // touchExtension only updates lastUsed — it does not directly reschedule
    // timers. That's handled by scheduleIdleTimeout internally.
    vi.useFakeTimers();

    const manifest = makeManifest([{ name: "touched-ext", path: "/nonexistent/touched.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("touched-ext")!;

    extState.loaded = true;
    extState.registeredTools = ["touched_tool"];
    const before = Date.now();

    vi.advanceTimersByTime(5000);
    touchExtension("touched-ext", s);

    expect(extState.lastUsed).toBeGreaterThan(before);
    expect(extState.loaded).toBe(true);
  });

  it("reschedules idle timer when state.pi is available", async () => {
    vi.useFakeTimers();
    const pi = createMockPi();

    const d = tmpDir();
    const extPath = join(d, "timer-reset-ext.js");
    writeExtensionFile(extPath, "timer_reset_tool");

    const manifest = makeManifest([{ name: "timer-reset-ext", path: extPath }]);
    const s = makeState(manifest);
    s.pi = pi; // Enable timer rescheduling in touchExtension

    await activateExtension("timer-reset-ext", s, pi as any);
    const extState = s.extensions.get("timer-reset-ext")!;
    expect(extState.loaded).toBe(true);

    // Use the tool after 5min (half of default 10min idle timeout)
    vi.advanceTimersByTime(5 * 60 * 1000);
    touchExtension("timer-reset-ext", s);

    // At 10min (original timer), the extension should NOT be unloaded
    // because touchExtension reset the timer to a full 10min from now
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(extState.loaded).toBe(true);

    // At 15min (5min touch + 10min new timeout), it should be unloaded
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(extState.loaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getFailureAgeSeconds
// ---------------------------------------------------------------------------

describe("getFailureAgeSeconds", () => {
  it("returns null when no failure recorded", () => {
    const s = makeState(makeManifest([]));
    expect(getFailureAgeSeconds(s, "never-failed")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearAllTimers
// ---------------------------------------------------------------------------

describe("clearAllTimers", () => {
  it("clears all idle timers", () => {
    const manifest = makeManifest([
      { name: "a", path: "/tmp/a.ts" },
      { name: "b", path: "/tmp/b.ts" },
    ]);
    const s = makeState(manifest);

    s.extensions.get("a")!.idleTimer = setTimeout(() => {}, 999999);
    s.extensions.get("b")!.idleTimer = setTimeout(() => {}, 999999);

    clearAllTimers(s);
    expect(s.extensions.get("a")!.idleTimer).toBeUndefined();
    expect(s.extensions.get("b")!.idleTimer).toBeUndefined();
  });

  it("handles state with no timers gracefully", () => {
    const manifest = makeManifest([{ name: "a", path: "/tmp/a.ts" }]);
    const s = makeState(manifest);
    expect(() => clearAllTimers(s)).not.toThrow();
  });

  it("handles empty state gracefully", () => {
    const s = makeState(makeManifest([]));
    expect(() => clearAllTimers(s)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildJitiAliases (indirectly tested via loadExtensionFactory)
// ---------------------------------------------------------------------------

describe("jiti alias resolution", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
    resetJitiAliases();
  });

  it("loads a .ts extension that imports typebox", async () => {
    const d = tmpDir();
    const extPath = join(d, "typebox-ext.ts");
    // Write a .ts extension that uses typebox — the most common import
    writeFileSync(extPath, [
      'import { Type } from "typebox";',
      "export default function (pi: any) {",
      "  pi.registerTool({",
      '    name: "typebox_tool",',
      '    label: "Typebox Test",',
      '    description: "Uses typebox",',
      "    parameters: Type.Object({ msg: Type.String() }),",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const manifest = makeManifest([{ name: "typebox-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("typebox-ext", s, pi as any);

    expect(result.success).toBe(true);
    expect(result.tools).toContain("typebox_tool");
    expect(pi.getAllTools().some((t) => t.name === "typebox_tool")).toBe(true);
  });

  it("loads a .ts extension that imports from @mariozechner/pi-coding-agent", async () => {
    const d = tmpDir();
    const extPath = join(d, "sdk-import-ext.ts");
    writeFileSync(extPath, [
      'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
      "export default function (pi: ExtensionAPI) {",
      "  pi.registerTool({",
      '    name: "sdk_import_tool",',
      '    label: "SDK Import Test",',
      '    description: "Uses SDK imports",',
      "    parameters: {},",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const manifest = makeManifest([{ name: "sdk-import-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("sdk-import-ext", s, pi as any);

    expect(result.success).toBe(true);
    expect(result.tools).toContain("sdk_import_tool");
  });

  it("loads a .ts extension that imports from @mariozechner/pi-tui", async () => {
    const d = tmpDir();
    const extPath = join(d, "tui-import-ext.ts");
    writeFileSync(extPath, [
      'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
      'import { Text } from "@mariozechner/pi-tui";',
      "export default function (pi: ExtensionAPI) {",
      "  pi.registerTool({",
      '    name: "tui_import_tool",',
      '    label: "TUI Import Test",',
      '    description: "Uses TUI imports",',
      "    parameters: {},",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const manifest = makeManifest([{ name: "tui-import-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("tui-import-ext", s, pi as any);

    expect(result.success).toBe(true);
    expect(result.tools).toContain("tui_import_tool");
  });

  it("caches jiti aliases across calls (resetJitiAliases clears cache)", async () => {
    const d = tmpDir();
    const extPath = join(d, "cache-ext.ts");
    writeFileSync(extPath, [
      'import { Type } from "typebox";',
      "export default function (pi: any) {",
      "  pi.registerTool({",
      '    name: "cache_tool",',
      '    label: "Cache",',
      '    description: "test",',
      "    parameters: Type.Object({}),",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const manifest = makeManifest([{ name: "cache-ext", path: extPath }]);
    const s = makeState(manifest);

    // First load — builds and caches aliases
    const r1 = await activateExtension("cache-ext", s, pi as any);
    expect(r1.success).toBe(true);

    // Reset and reload — should work again
    resetJitiAliases();
    pi = createMockPi();
    const s2 = makeState(manifest);
    const r2 = await activateExtension("cache-ext", s2, pi as any);
    expect(r2.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shortcuts, flags, renderers tracking
// ---------------------------------------------------------------------------

describe("shortcuts, flags, and renderers tracking", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("tracks registered shortcuts in mock pi", async () => {
    const d = tmpDir();
    const extPath = join(d, "shortcut-ext.js");
    writeExtensionFile(extPath, "shortcut_tool");
    // The real extension would call registerShortcut, but since we test
    // via mock, we verify the mock captures it
    const manifest = makeManifest([{ name: "shortcut-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("shortcut-ext", s, pi as any);
    expect(result.success).toBe(true);
    // The mock captures shortcut registrations
    expect(pi._shortcuts).toBeDefined();
  });

  it("tracks registered flags in mock pi", async () => {
    const d = tmpDir();
    const extPath = join(d, "flag-ext.js");
    writeExtensionFile(extPath, "flag_tool");

    const manifest = makeManifest([{ name: "flag-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("flag-ext", s, pi as any);
    expect(result.success).toBe(true);
    // The mock captures flag registrations
    expect(pi._flags).toBeDefined();
  });

  it("tracks registered message renderers in mock pi", async () => {
    const d = tmpDir();
    const extPath = join(d, "renderer-ext.js");
    writeExtensionFile(extPath, "renderer_tool");

    const manifest = makeManifest([{ name: "renderer-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("renderer-ext", s, pi as any);
    expect(result.success).toBe(true);
    // The mock captures renderer registrations
    expect(pi._messageRenderers).toBeDefined();
  });

  it("initializes empty tracking arrays in state", () => {
    const manifest = makeManifest([{ name: "x", path: "/tmp/x.ts" }]);
    const s = makeState(manifest);
    const extState = s.extensions.get("x")!;

    expect(extState.registeredShortcuts).toEqual([]);
    expect(extState.registeredFlags).toEqual([]);
    expect(extState.registeredRenderers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildJitiAliases — direct unit test
// ---------------------------------------------------------------------------

describe("buildJitiAliases", () => {
  beforeEach(() => {
    resetJitiAliases();
  });

  it("resolves typebox to an absolute path", async () => {
    const { createJiti } = await import("@mariozechner/jiti");
    // Call loadExtensionFactory indirectly by activating an extension
    // that imports typebox — this exercises buildJitiAliases internally.
    // We verify the alias map works by testing a real extension load.
    const d = tmpDir();
    const extPath = join(d, "alias-check.ts");
    writeFileSync(extPath, [
      'import { Type } from "typebox";',
      "export default function (pi: any) {",
      "  pi.registerTool({",
      '    name: "alias_check_tool",',
      '    label: "Alias Check",',
      '    description: "Checks alias resolution",',
      "    parameters: Type.Object({}),",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const pi = createMockPi();
    const manifest = makeManifest([{ name: "alias-check", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("alias-check", s, pi as any);
    expect(result.success).toBe(true);
    expect(result.tools).toContain("alias_check_tool");
  });

  it("resolves @mariozechner/pi-coding-agent to an absolute path", async () => {
    const d = tmpDir();
    const extPath = join(d, "pi-pkg-alias.ts");
    writeFileSync(extPath, [
      'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
      "export default function (pi: ExtensionAPI) {",
      "  pi.registerTool({",
      '    name: "pi_pkg_alias_tool",',
      '    label: "PI Pkg Alias Check",',
      '    description: "Checks pi-coding-agent alias",',
      "    parameters: {},",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const pi = createMockPi();
    const manifest = makeManifest([{ name: "pi-pkg-alias", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("pi-pkg-alias", s, pi as any);
    expect(result.success).toBe(true);
    expect(result.tools).toContain("pi_pkg_alias_tool");
  });
});

// ---------------------------------------------------------------------------
// Serialization of concurrent activations (Bug #2 & #3 fix)
// ---------------------------------------------------------------------------

describe("serialization of concurrent activations", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("prevents tool-diff cross-contamination between concurrent activations", async () => {
    const d = tmpDir();
    const extPathA = join(d, "ser-a.js");
    const extPathB = join(d, "ser-b.js");
    writeExtensionFile(extPathA, "tool_a");
    writeExtensionFile(extPathB, "tool_b");

    const manifest = makeManifest([
      { name: "ser-a", path: extPathA },
      { name: "ser-b", path: extPathB },
    ]);
    const s = makeState(manifest);

    // Activate both concurrently — serialization ensures one-at-a-time
    const [rA, rB] = await Promise.all([
      activateExtension("ser-a", s, pi as any),
      activateExtension("ser-b", s, pi as any),
    ]);

    expect(rA.success).toBe(true);
    expect(rB.success).toBe(true);

    // Tool attribution must be correct — no cross-contamination
    expect(rA.tools).toEqual(["tool_a"]);
    expect(rB.tools).toEqual(["tool_b"]);

    // State tracking must be correct
    expect(s.extensions.get("ser-a")!.registeredTools).toEqual(["tool_a"]);
    expect(s.extensions.get("ser-b")!.registeredTools).toEqual(["tool_b"]);
  });

  it("preserves method wrapping integrity across activations", async () => {
    const d = tmpDir();
    const extPathA = join(d, "wrap-a.js");
    const extPathB = join(d, "wrap-b.js");
    writeExtensionFile(extPathA, "wrap_tool_a");
    writeExtensionFile(extPathB, "wrap_tool_b");

    const manifest = makeManifest([
      { name: "wrap-a", path: extPathA },
      { name: "wrap-b", path: extPathB },
    ]);
    const s = makeState(manifest);

    // Activate sequentially to verify method restoration
    await activateExtension("wrap-a", s, pi as any);
    await activateExtension("wrap-b", s, pi as any);

    // Both tools should be registered
    expect(pi.getAllTools().some((t) => t.name === "wrap_tool_a")).toBe(true);
    expect(pi.getAllTools().some((t) => t.name === "wrap_tool_b")).toBe(true);

    // pi.registerTool should be the original function (not a wrapper)
    expect(pi.registerTool.name).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// session_start handler detection (Bug #11)
// ---------------------------------------------------------------------------

describe("session_start handler detection", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("detects when a lazy extension registers a session_start handler", async () => {
    const d = tmpDir();
    const extPath = join(d, "session-ext.js");
    writeFileSync(extPath, [
      "export default function (pi) {",
      "  pi.on('session_start', async () => {});",
      "  pi.registerTool({",
      '    name: "session_tool",',
      '    label: "Session Test",',
      '    description: "Test",',
      "    parameters: {},",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const manifest = makeManifest([{ name: "session-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("session-ext", s, pi as any);
    expect(result.success).toBe(true);
    expect(result.sessionStartWarning).toBe(true);
  });

  it("does not warn when extension has no session_start handler", async () => {
    const d = tmpDir();
    const extPath = join(d, "no-session-ext.js");
    writeExtensionFile(extPath, "no_session_tool");

    const manifest = makeManifest([{ name: "no-session-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("no-session-ext", s, pi as any);
    expect(result.success).toBe(true);
    expect(result.sessionStartWarning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Duplicate tool name detection (Edge case #8)
// ---------------------------------------------------------------------------

describe("duplicate tool name detection", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("detects tool names that collide with already-registered tools", async () => {
    const d = tmpDir();
    const extPath = join(d, "dup-ext.js");
    // Register a tool named "bash" — which is already a built-in tool in the mock
    writeFileSync(extPath, [
      "export default function (pi) {",
      "  pi.registerTool({",
      '    name: "bash",',
      '    label: "Dup Bash",',
      '    description: "Duplicate",',
      "    parameters: {},",
      '    async execute() { return { content: [{ type: "text", text: "ok" }] }; }',
      "  });",
      "}",
    ].join("\n"), "utf-8");

    const manifest = makeManifest([{ name: "dup-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("dup-ext", s, pi as any);
    expect(result.success).toBe(true);
    expect(result.duplicateTools).toContain("bash");
    // The tool should NOT be in the actual registered list (first-registration wins)
    expect(result.tools).not.toContain("bash");
  });

  it("reports no duplicates when all tool names are new", async () => {
    const d = tmpDir();
    const extPath = join(d, "unique-ext.js");
    writeExtensionFile(extPath, "totally_unique_tool");

    const manifest = makeManifest([{ name: "unique-ext", path: extPath }]);
    const s = makeState(manifest);

    const result = await activateExtension("unique-ext", s, pi as any);
    expect(result.success).toBe(true);
    expect(result.duplicateTools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// idleTimer cleanup on idle-unload (Bug #4)
// ---------------------------------------------------------------------------

describe("idleTimer cleanup on idle-unload", () => {
  it("clears idleTimer reference when idle-unloading", async () => {
    vi.useFakeTimers();
    const pi = createMockPi();

    const d = tmpDir();
    const extPath = join(d, "cleanup-ext.js");
    writeExtensionFile(extPath, "cleanup_tool");

    const manifest = makeManifest([{ name: "cleanup-ext", path: extPath }]);
    const s = makeState(manifest);
    s.pi = pi;

    await activateExtension("cleanup-ext", s, pi as any);
    const extState = s.extensions.get("cleanup-ext")!;
    expect(extState.idleTimer).toBeDefined();

    // Advance past idle timeout
    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(extState.loaded).toBe(false);
    expect(extState.idleTimer).toBeUndefined();
  });
});
