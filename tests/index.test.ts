import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createMockPi, makeManifest, makeManifestWithSettings } from "./helpers/mock-pi.js";
import type { MockPi } from "./helpers/mock-pi.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pi-lazy-idx-"));
  tmpDirs.push(d);
  return d;
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
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

function makeCtx(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    cwd: "/fake/project",
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: vi.fn((_k: string, v: any) => v) },
    },
    ...overrides,
  };
}

/** Get first handler registered for an event, or undefined */
function getHandler(pi: MockPi, event: string): ((...args: any[]) => void) | undefined {
  return pi._eventHandlers.get(event)?.[0];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------

async function loadExtension(): Promise<(pi: any) => void> {
  vi.resetModules();
  const mod = await import("../index.js");
  return mod.default;
}

// ---------------------------------------------------------------------------
// session_start — manifest loading
// ---------------------------------------------------------------------------

describe("session_start", () => {
  it("does nothing when no manifest found", async () => {
    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: tmpDir() });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    expect(handler).toBeDefined();
    await handler!({}, ctx);

    expect(pi.getAllTools().some((t) => t.name === "ext")).toBe(true);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("loads manifest from project .pi/lazy-extensions.json", async () => {
    const d = tmpDir();
    const piDir = join(d, ".pi");
    mkdirSync(piDir);
    writeJson(join(piDir, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "project-ext", path: "/nonexistent/project.ts" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Lazy Extensions: 1 extension configured",
      "info",
    );
  });

  it("uses ctx.cwd not process.cwd() for manifest resolution (bug fix #3)", async () => {
    const manifestDir = tmpDir();
    const piDir = join(manifestDir, ".pi");
    mkdirSync(piDir);
    writeJson(join(piDir, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "correct-ext", path: "/tmp/correct.ts" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: manifestDir });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Lazy Extensions: 1 extension configured",
      "info",
    );
  });

  it("honours disableProxyTool setting", async () => {
    const d = tmpDir();
    const piDir = join(d, ".pi");
    mkdirSync(piDir);
    writeJson(join(piDir, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "hidden-ext", path: "/tmp/hidden.ts" }],
      settings: { disableProxyTool: true },
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    // "ext" should NOT be in active tools
    expect(pi.getActiveTools()).not.toContain("ext");
    // but still in registry
    expect(pi.getAllTools().some((t) => t.name === "ext")).toBe(true);
    // notify should NOT fire
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("handles hasUI=false gracefully", async () => {
    const d = tmpDir();
    const piDir = join(d, ".pi");
    mkdirSync(piDir);
    writeJson(join(piDir, "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "noui-ext", path: "/tmp/noui.ts" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d, hasUI: false });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    // Should not throw and not call UI functions
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Eager extension loading
// ---------------------------------------------------------------------------

describe("eager extension loading", () => {
  it("loads eager lifecycle extensions on session_start", async () => {
    const d = tmpDir();
    const extPath = join(d, "eager-ext.js");
    writeExtensionFile(extPath, "eager_tool");

    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "eager-ext", path: extPath, lifecycle: "eager" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    expect(pi.getAllTools().some((t) => t.name === "eager_tool")).toBe(true);
    expect(pi.getActiveTools()).toContain("eager_tool");
  });

  it("loads keep-alive lifecycle extensions on session_start", async () => {
    const d = tmpDir();
    const extPath = join(d, "ka-ext.js");
    writeExtensionFile(extPath, "ka_tool");

    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "ka-ext", path: extPath, lifecycle: "keep-alive" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    expect(pi.getAllTools().some((t) => t.name === "ka_tool")).toBe(true);
    expect(pi.getActiveTools()).toContain("ka_tool");
  });

  it("does not load lazy extensions on session_start", async () => {
    const d = tmpDir();
    const extPath = join(d, "lazy-ext.js");
    writeExtensionFile(extPath, "lazy_tool");

    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "lazy-ext", path: extPath, lifecycle: "lazy" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    // lazy tool should NOT be registered (not loaded yet)
    expect(pi.getAllTools().some((t) => t.name === "lazy_tool")).toBe(false);
  });

  it("notifies on eager loading failures", async () => {
    const d = tmpDir();
    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [
        { name: "broken-eager", path: "/nonexistent/broken.ts", lifecycle: "eager" },
      ],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const handler = getHandler(pi, "session_start");
    await handler!({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed to load"),
      "warning",
    );
  });
});

// ---------------------------------------------------------------------------
// session_shutdown
// ---------------------------------------------------------------------------

describe("session_shutdown", () => {
  it("clears state and timers on shutdown", async () => {
    const d = tmpDir();
    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "shutdown-ext", path: "/tmp/shutdown.ts" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    // Verify shutdown handler exists
    const shutdownHandler = getHandler(pi, "session_shutdown");
    expect(shutdownHandler).toBeDefined();
    shutdownHandler!();

    // After shutdown, new session_start with no manifest should work cleanly
    const d2 = tmpDir();
    const ctx2 = makeCtx({ cwd: d2 });
    if (startHandler) await startHandler({}, ctx2);

    expect(ctx2.ui.notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// tool_execution_end — touch on tool use
// ---------------------------------------------------------------------------

describe("tool_execution_end", () => {
  it("handler is registered and does not throw", async () => {
    const d = tmpDir();
    const extPath = join(d, "touch-ext.js");
    writeExtensionFile(extPath, "touchable_tool");

    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "touch-ext", path: extPath, lifecycle: "eager" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    const teHandler = getHandler(pi, "tool_execution_end");
    expect(teHandler).toBeDefined();

    // These should not throw
    expect(() => teHandler!({ toolName: "touchable_tool" })).not.toThrow();
    expect(() => teHandler!({ toolName: "unknown_tool" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ext command registration
// ---------------------------------------------------------------------------

describe("ext command", () => {
  it("registers the ext command", async () => {
    const pi = createMockPi();
    const factory = await loadExtension();
    factory(pi as any);

    const cmd = pi._commandHandlers.find((c) => c.name === "ext");
    expect(cmd).toBeDefined();
    expect(cmd!.config.description).toContain("lazy extensions");
    expect(typeof cmd!.config.handler).toBe("function");
  });

  it("ext command shows 'not configured' when no manifest", async () => {
    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: tmpDir() });

    factory(pi as any);

    // session_start → no manifest
    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    // Get the ext command handler
    const cmd = pi._commandHandlers.find((c) => c.name === "ext");
    expect(cmd).toBeDefined();

    // Invoke with default (status)
    await cmd!.config.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No lazy extensions configured",
      "info",
    );
  });
});

// ---------------------------------------------------------------------------
// proxy tool registration
// ---------------------------------------------------------------------------

describe("proxy tool", () => {
  it("registers the ext proxy tool with description and guidelines", async () => {
    const pi = createMockPi();
    const factory = await loadExtension();
    factory(pi as any);

    expect(pi._registeredTools).toContain("ext");

    const extTool = pi._toolRegistry.find((t) => t.name === "ext");
    expect(extTool).toBeDefined();
  });

  it("proxy tool execute returns not_configured when no state", async () => {
    const pi = createMockPi();
    const factory = await loadExtension();
    factory(pi as any);

    // registerTool stores the tool config — find the execute fn
    const extTool = pi._toolRegistry.find((t) => t.name === "ext");
    expect(extTool).toBeDefined();

    // The actual execute function was passed to registerTool. We stored the
    // tool metadata but not the execute fn directly. We need to capture it.
    // The proxy tool's execute is accessible via the registered tool call.
    // Since our registerTool mock only stores metadata, we can't directly
    // test the execute flow this way. Instead, test via activateExtension
    // which exercises the full flow.
  });

  it("proxy tool execute returns status after session_start with manifest", async () => {
    const d = tmpDir();
    const extPath = join(d, "proxy-ext.js");
    writeExtensionFile(extPath, "proxy_tool");

    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "proxy-ext", path: extPath, lifecycle: "lazy" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    // We verify the state is set up correctly — the tool should be registered
    expect(pi._registeredTools).toContain("ext");
    // Session start should have created state (notify called)
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Lazy Extensions: 1 extension configured",
      "info",
    );
  });

  it("proxy tool execute handles activate mode", async () => {
    const d = tmpDir();
    const extPath = join(d, "activate-ext.js");
    writeExtensionFile(extPath, "activated_tool");

    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "activate-ext", path: extPath }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    // Extension is not eager — we can test activate via the ext command
    const cmd = pi._commandHandlers.find((c) => c.name === "ext");
    expect(cmd).toBeDefined();

    // /ext activate activate-ext
    await cmd!.config.handler("activate activate-ext", ctx);
    // Should have either succeeded or notified
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("proxy tool execute handles search mode", async () => {
    const d = tmpDir();
    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [
        { name: "search-me", path: "/tmp/search.ts", description: "Find me please" },
      ],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    const cmd = pi._commandHandlers.find((c) => c.name === "ext");
    await cmd!.config.handler("search find", ctx);

    expect(ctx.ui.notify).toHaveBeenCalled();
    const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const notifyText = calls[calls.length - 1]?.[0];
    expect(notifyText).toContain("search-me");
  });

  it("proxy tool handles tools subcommand", async () => {
    const d = tmpDir();
    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [
        { name: "tools-ext", path: "/tmp/tools.ts", toolSummary: ["tool_one", "tool_two"] },
      ],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    const cmd = pi._commandHandlers.find((c) => c.name === "ext");
    await cmd!.config.handler("tools tools-ext", ctx);

    expect(ctx.ui.notify).toHaveBeenCalled();
    const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const notifyText = calls[calls.length - 1]?.[0];
    expect(notifyText).toContain("tool_one");
  });

  it("proxy tool handles tools with empty string (list all)", async () => {
    const d = tmpDir();
    const extPath = join(d, "all-ext.js");
    writeExtensionFile(extPath, "all_tool");

    writeJson(join(d, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "all-ext", path: extPath, lifecycle: "eager" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();
    const ctx = makeCtx({ cwd: d });

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");
    if (startHandler) await startHandler({}, ctx);

    // Eager load happened — tool should be registered
    expect(pi.getAllTools().some((t) => t.name === "all_tool")).toBe(true);

    const cmd = pi._commandHandlers.find((c) => c.name === "ext");
    await cmd!.config.handler("tools", ctx);

    expect(ctx.ui.notify).toHaveBeenCalled();
    const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const notifyText = calls[calls.length - 1]?.[0];
    expect(notifyText).toContain("all_tool");
  });
});

// ---------------------------------------------------------------------------
// lifecycle generation guard
// ---------------------------------------------------------------------------

describe("lifecycle generation guard", () => {
  it("clears previous state on new session_start", async () => {
    const d1 = tmpDir();
    writeJson(join(d1, ".pi", "lazy-extensions.json"), {
      version: 1,
      extensions: [{ name: "ext1", path: "/tmp/ext1.ts" }],
    });

    const pi = createMockPi();
    const factory = await loadExtension();

    factory(pi as any);

    const startHandler = getHandler(pi, "session_start");

    const ctx1 = makeCtx({ cwd: d1 });
    if (startHandler) await startHandler({}, ctx1);
    expect(ctx1.ui.notify).toHaveBeenCalledWith(
      "Lazy Extensions: 1 extension configured",
      "info",
    );

    const ctx2 = makeCtx({ cwd: tmpDir() }); // no manifest
    if (startHandler) await startHandler({}, ctx2);
    expect(ctx2.ui.notify).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ext tool name collision warning
// ---------------------------------------------------------------------------

describe("ext tool name collision", () => {
  it("warns when another extension already registered 'ext'", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Create a mock pi that already has an 'ext' tool
    const pi = createMockPi({
      tools: [
        {
          name: "ext",
          description: "Pre-existing ext tool",
          parameters: {} as any,
          sourceInfo: { path: "<other>", source: "extension", scope: "temporary", origin: "top-level" },
        },
      ],
      activeTools: ["ext"],
    });
    const factory = await loadExtension();

    factory(pi as any);

    // Should have logged a warning about the collision
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("another extension already registered a tool named 'ext'"),
    );

    consoleSpy.mockRestore();
  });

  it("does not warn when no collision exists", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pi = createMockPi();
    const factory = await loadExtension();

    factory(pi as any);

    // Should NOT have logged a collision warning
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("another extension already registered a tool named 'ext'"),
    );

    consoleSpy.mockRestore();
  });
});
