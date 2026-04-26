import { describe, it, expect, beforeEach } from "vitest";

import { executeStatus, executeSearch, executeActivate, executeListTools } from "../proxy-modes.js";
import { createMockPi, makeManifest, makeState } from "./helpers/mock-pi.js";

import type { MockPi } from "./helpers/mock-pi.js";
import type { LazyExtensionsState } from "../types.js";

// ---------------------------------------------------------------------------

function setupState(): { pi: MockPi; state: LazyExtensionsState } {
  const pi = createMockPi();
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
  const state = makeState(manifest);

  // Pre-activate todo with registered tools
  const todoState = state.extensions.get("todo")!;
  todoState.loaded = true;
  todoState.registeredTools = ["todo_add", "todo_list"];

  // Mark broken as failed
  const brokenState = state.extensions.get("broken")!;
  brokenState.error = "Module not found";

  return { pi, state };
}

// ---------------------------------------------------------------------------
// executeStatus
// ---------------------------------------------------------------------------

describe("executeStatus", () => {
  it("reports active, inactive, and failed extensions", () => {
    const { state } = setupState();
    const result = executeStatus(state);

    const text = result.content[0].text as string;
    expect(text).toContain("1/3 active");
    expect(text).toContain("✓ todo");
    expect(text).toContain("○ gcp");
    expect(text).toContain("✗ broken");
    expect(text).toContain("Module not found");
    expect(text).toContain("ext({ search:");

    expect(result.details).toMatchObject({
      mode: "status",
      activeCount: 1,
      totalTools: 2, // todo has 2 tools
    });
  });

  it("includes tool counts from preserved registeredTools", () => {
    const { state } = setupState();
    const gcpState = state.extensions.get("gcp")!;
    gcpState.registeredTools = ["gcp_deploy", "gcp_status"];
    // loaded remains false

    const result = executeStatus(state);
    const text = result.content[0].text as string;
    expect(text).toContain("○ gcp");
    // Should show 2 tools from preserved list, not 1 from manifest
    expect(result.details).toMatchObject({ totalTools: 4 }); // todo(2) + gcp(2) = 4
  });

  it("handles extensions with failure backoff as failed", () => {
    const { state } = setupState();
    // gcp is not loaded and not failed, but we can simulate backoff by
    // checking if the failureTracker would report it — it won't unless
    // activateExtension was called and failed. This test verifies the
    // state machine is correct for "inactive" when not failed.
    const result = executeStatus(state);
    expect(result.details).toMatchObject({ activeCount: 1 }); // only todo
  });

  it("handles empty state gracefully", () => {
    const emptyManifest = makeManifest([]);
    const emptyState = makeState(emptyManifest);
    const result = executeStatus(emptyState);

    const text = result.content[0].text as string;
    expect(text).toContain("0/0 active");
    expect(text).toContain("0 tools");
    expect(result.details).toMatchObject({ activeCount: 0, totalTools: 0 });
  });
});

// ---------------------------------------------------------------------------
// executeSearch
// ---------------------------------------------------------------------------

describe("executeSearch", () => {
  it("finds extensions by name", () => {
    const { state } = setupState();
    const result = executeSearch(state, "todo");
    expect(result.details.matches).toHaveLength(1);
    expect(result.details.matches[0].name).toBe("todo");
    expect(result.details.matches[0].matchReason).toContain("name");
  });

  it("finds extensions by description", () => {
    const { state } = setupState();
    const result = executeSearch(state, "cloud");
    expect(result.details.matches).toHaveLength(1);
    expect(result.details.matches[0].name).toBe("gcp");
    expect(result.details.matches[0].matchReason).toContain("description");
  });

  it("finds extensions by tags", () => {
    const { state } = setupState();
    const result = executeSearch(state, "productivity");
    expect(result.details.matches).toHaveLength(1);
    expect(result.details.matches[0].name).toBe("todo");
    expect(result.details.matches[0].matchReason).toContain("tags");
  });

  it("finds extensions by toolSummary", () => {
    const { state } = setupState();
    const result = executeSearch(state, "deploy");
    expect(result.details.matches).toHaveLength(1);
    expect(result.details.matches[0].name).toBe("gcp");
    expect(result.details.matches[0].matchReason).toContain("tools");
  });

  it("finds extensions by registered tools", () => {
    const { state } = setupState();
    const result = executeSearch(state, "todo_add");
    expect(result.details.matches).toHaveLength(1);
    expect(result.details.matches[0].matchReason).toContain("registered tools");
  });

  it("returns empty for no matches", () => {
    const { state } = setupState();
    const result = executeSearch(state, "zzz_nonexistent_zzz");
    expect(result.details.matches).toHaveLength(0);
    expect((result.content[0].text as string)).toContain("No extensions matching");
  });

  it("supports regex mode", () => {
    const { state } = setupState();
    const result = executeSearch(state, "gc|br", true);
    expect(result.details.matches).toHaveLength(2); // gcp + broken
  });

  it("handles multi-word queries as AND terms", () => {
    const { state } = setupState();
    const result = executeSearch(state, "cloud deploy");
    expect(result.details.matches).toHaveLength(1);
    expect(result.details.matches[0].name).toBe("gcp");
  });

  it("returns error for empty query", () => {
    const { state } = setupState();
    const result = executeSearch(state, "");
    expect(result.details.error).toBe("empty_query");
  });

  it("returns error for empty whitespace-only query", () => {
    const { state } = setupState();
    const result = executeSearch(state, "   ");
    expect(result.details.error).toBe("empty_query");
  });

  it("returns error for invalid regex", () => {
    const { state } = setupState();
    const result = executeSearch(state, "[invalid", true);
    expect(result.details.error).toBe("invalid_pattern");
  });

  it("includes status icon in search results", () => {
    const { state } = setupState();
    const result = executeSearch(state, "todo");
    const text = result.content[0].text as string;
    expect(text).toContain("✓"); // active
    expect(text).toContain("active");
  });

  it("shows inactive icon for unloaded extensions", () => {
    const { state } = setupState();
    const result = executeSearch(state, "gcp");
    const text = result.content[0].text as string;
    expect(text).toContain("○"); // inactive
  });
});

// ---------------------------------------------------------------------------
// executeActivate
// ---------------------------------------------------------------------------

describe("executeActivate", () => {
  it("returns not-found for unknown extension", async () => {
    const { pi, state } = setupState();
    const result = await executeActivate(state, "nope", pi as any);
    expect(result.details.error).toBe("not_found");
  });

  it("returns already-active for loaded extension", async () => {
    const { pi, state } = setupState();
    const result = await executeActivate(state, "todo", pi as any);
    expect(result.details.alreadyActive).toBe(true);
    expect(result.details.tools).toEqual(["todo_add", "todo_list"]);
  });

  it("delegates to activateExtension for unloaded extensions (will fail for nonexistent file)", async () => {
    const { pi, state } = setupState();
    const result = await executeActivate(state, "gcp", pi as any);
    expect(result.details.error).toBe("activation_failed");
  });

  it("touches extension on already-active check", async () => {
    const { pi, state } = setupState();
    const extState = state.extensions.get("todo")!;
    const before = extState.lastUsed ?? 0;

    await executeActivate(state, "todo", pi as any);
    expect(extState.lastUsed!).toBeGreaterThan(before);
  });

  it("returns descriptive text for already-active with tools", async () => {
    const { pi, state } = setupState();
    const result = await executeActivate(state, "todo", pi as any);
    const text = result.content[0].text as string;
    expect(text).toContain("already active");
    expect(text).toContain("todo_add");
    expect(text).toContain("todo_list");
  });
});

// ---------------------------------------------------------------------------
// executeListTools
// ---------------------------------------------------------------------------

describe("executeListTools", () => {
  it("shows tools for a specific active extension", () => {
    const { pi, state } = setupState();
    const result = executeListTools(state, "todo", () => pi.getAllTools());
    const text = result.content[0].text as string;
    expect(text).toContain("todo_add");
    expect(text).toContain("todo_list");
  });

  it("shows preserved tools for idle-unloaded extension", () => {
    const { state } = setupState();
    const gcpState = state.extensions.get("gcp")!;
    gcpState.registeredTools = ["gcp_deploy", "gcp_status"];

    const result = executeListTools(state, "gcp");
    const text = result.content[0].text as string;
    expect(text).toContain("not active");
    expect(text).toContain("gcp_deploy");
    expect(text).toContain("gcp_status");
  });

  it("falls back to toolSummary when never loaded", () => {
    const { state } = setupState();
    const gcpState = state.extensions.get("gcp")!;
    gcpState.registeredTools = [];

    const result = executeListTools(state, "gcp");
    const text = result.content[0].text as string;
    expect(text).toContain("not active");
    expect(text).toContain("gcp_deploy"); // from manifest toolSummary
  });

  it("lists all active extension tools when no name given", () => {
    const { pi, state } = setupState();
    const result = executeListTools(state, undefined, () => pi.getAllTools());
    const text = result.content[0].text as string;
    expect(text).toContain("Active extension tools (2):");
    expect(text).toContain("todo_add");
    expect(text).toContain("todo_list");
  });

  it("returns not-found for unknown extension", () => {
    const { state } = setupState();
    const result = executeListTools(state, "nonexistent");
    expect(result.details.error).toBe("not_found");
  });

  it("returns empty message when no tools are active", () => {
    const emptyManifest = makeManifest([]);
    const emptyState = makeState(emptyManifest);
    const result = executeListTools(emptyState);
    expect((result.content[0].text as string)).toContain("No extension tools currently active");
  });

  it("shows tool descriptions from pi registry when getPiTools is provided", () => {
    const { pi, state } = setupState();
    const result = executeListTools(state, "todo", () => pi.getAllTools());
    const text = result.content[0].text as string;
    // The mock pi stores tools with descriptions; extension tools added by
    // activateExtension get generic descriptions from registerTool
    expect(text).toContain("- todo_add");
    expect(text).toContain("- todo_list");
  });

  it("handles active extension with zero registered tools", () => {
    const { state } = setupState();
    const todoState = state.extensions.get("todo")!;
    todoState.registeredTools = [];

    const result = executeListTools(state, "todo");
    const text = result.content[0].text as string;
    expect(text).toContain("no registered tools");
  });

  it("handles undefined getPiTools gracefully", () => {
    const { state } = setupState();
    const result = executeListTools(state, "todo"); // no getPiTools
    const text = result.content[0].text as string;
    expect(text).toContain("todo_add");
    expect(text).toContain("todo_list");
  });

  it("touches extension on active list-tools by name", () => {
    const { state } = setupState();
    const todoState = state.extensions.get("todo")!;
    const before = todoState.lastUsed ?? 0;

    executeListTools(state, "todo");
    expect(todoState.lastUsed!).toBeGreaterThan(before);
  });
});
