/**
 * Test helpers for pi-lazy-extensions.
 *
 * Provides a mock ExtensionAPI and factories for building test
 * LazyExtensionsManifest / LazyExtensionsState objects.
 */

import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";
import type {
  LazyExtensionConfig,
  LazyExtensionsManifest,
  LazyExtensionsState,
} from "./types.js";
import { buildState } from "./config.js";

// ---------------------------------------------------------------------------
// Mock ExtensionAPI
// ---------------------------------------------------------------------------

export interface MockPiOptions {
  /** Pre-populated tools returned by getAllTools(). */
  tools?: ToolInfo[];
  /** Pre-populated active tool names returned by getActiveTools(). */
  activeTools?: string[];
}

export interface MockPi extends ExtensionAPI {
  // Tracked state for assertions
  _toolRegistry: ToolInfo[];
  _activeTools: Set<string>;
  _setActiveToolsCalls: string[][];
  _registeredTools: string[];
}

const DEFAULT_BUILTIN_TOOLS: ToolInfo[] = [
  {
    name: "bash",
    description: "Execute a bash command",
    parameters: {} as any,
    sourceInfo: { path: "<builtin:bash>", source: "builtin", scope: "temporary", origin: "top-level" },
  },
  {
    name: "read",
    description: "Read file contents",
    parameters: {} as any,
    sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" },
  },
  {
    name: "edit",
    description: "Edit a file",
    parameters: {} as any,
    sourceInfo: { path: "<builtin:edit>", source: "builtin", scope: "temporary", origin: "top-level" },
  },
  {
    name: "write",
    description: "Write a file",
    parameters: {} as any,
    sourceInfo: { path: "<builtin:write>", source: "builtin", scope: "temporary", origin: "top-level" },
  },
];

const noop = () => {};
const noopAsync = async () => {};
const noopHandler = () => {};
const stub = () => {
  throw new Error("stub not implemented in mock");
};

export function createMockPi(opts: MockPiOptions = {}): MockPi {
  const toolRegistry: ToolInfo[] = [...(opts.tools ?? DEFAULT_BUILTIN_TOOLS)];
  const activeTools = new Set<string>(opts.activeTools ?? toolRegistry.map((t) => t.name));

  const mock: MockPi = {
    _toolRegistry: toolRegistry,
    _activeTools: activeTools,
    _setActiveToolsCalls: [],
    _registeredTools: [],

    // --- Tool management ---
    getAllTools(): ToolInfo[] {
      return [...toolRegistry];
    },
    getActiveTools(): string[] {
      return [...activeTools];
    },
    setActiveTools(toolNames: string[]): void {
      mock._setActiveToolsCalls.push(toolNames);
      activeTools.clear();
      for (const name of toolNames) activeTools.add(name);
    },
    registerTool(tool: any): void {
      mock._registeredTools.push(tool.name);
      // Simulate pi-sdk behavior: first registration wins
      if (!toolRegistry.some((t) => t.name === tool.name)) {
        toolRegistry.push({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? ({} as any),
          sourceInfo: {
            path: "<mock>",
            source: "extension",
            scope: "temporary",
            origin: "top-level",
          },
        });
        activeTools.add(tool.name);
      }
    },

    // --- Event subscriptions (no-op in mock) ---
    on: ((_event: string, _handler: any) => {}) as any,

    // --- Stubs for methods not exercised by these tests ---
    registerCommand: stub as any,
    registerShortcut: stub as any,
    registerFlag: stub as any,
    getFlag: stub as any,
    registerMessageRenderer: stub as any,
    sendMessage: stub as any,
    sendUserMessage: stub as any,
    appendEntry: stub as any,
    setSessionName: stub as any,
    getSessionName: stub as any,
    setLabel: stub as any,
    exec: stub as any,
    getCommands: stub as any,
    setModel: stub as any,
    getThinkingLevel: stub as any,
    setThinkingLevel: stub as any,
    registerProvider: stub as any,
    unregisterProvider: stub as any,
    events: {} as any,
  };

  return mock;
}

// ---------------------------------------------------------------------------
// Manifest / state builders
// ---------------------------------------------------------------------------

export function makeManifest(extensions: LazyExtensionConfig[]): LazyExtensionsManifest {
  return { version: 1, extensions };
}

export function makeManifestWithSettings(
  extensions: LazyExtensionConfig[],
  settings: LazyExtensionsManifest["settings"],
): LazyExtensionsManifest {
  return { version: 1, extensions, settings };
}

export function makeState(manifest: LazyExtensionsManifest): LazyExtensionsState {
  return buildState(manifest, "/tmp/test-lazy-extensions.json");
}
