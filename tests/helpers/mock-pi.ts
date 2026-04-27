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
} from "../../types.js";
import { buildState } from "../../config.js";

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
  _eventHandlers: Map<string, Array<(...args: any[]) => void>>;
  _commandHandlers: Array<{ name: string; config: any }>;
  _shortcuts: Array<{ shortcut: string; options: any }>;
  _flags: Map<string, { options: any; value?: boolean | string }>;
  _messageRenderers: Map<string, any>;
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

export function createMockPi(opts: MockPiOptions = {}): MockPi {
  const toolRegistry: ToolInfo[] = [...(opts.tools ?? DEFAULT_BUILTIN_TOOLS)];
  const activeTools = new Set<string>(opts.activeTools ?? toolRegistry.map((t) => t.name));

  // Event handler storage — tests can retrieve and fire handlers
  const eventHandlers = new Map<string, Array<(...args: any[]) => void>>();
  const commandHandlers: Array<{ name: string; config: any }> = [];
  const shortcuts: Array<{ shortcut: string; options: any }> = [];
  const flags = new Map<string, { options: any; value?: boolean | string }>();
  const messageRenderers = new Map<string, any>();

  const mock: MockPi = {
    _toolRegistry: toolRegistry,
    _activeTools: activeTools,
    _setActiveToolsCalls: [],
    _registeredTools: [],

    // Exposed for tests to introspect
    _eventHandlers: eventHandlers,
    _commandHandlers: commandHandlers,
    _shortcuts: shortcuts,
    _flags: flags,
    _messageRenderers: messageRenderers,

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

    // --- Event subscriptions — capture handlers by event name ---
    on(event: string, handler: any) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    },

    // --- Command registration — capture name and config ---
    registerCommand(name: string, config: any) {
      commandHandlers.push({ name, config });
    },

    getCommands(): any[] {
      return commandHandlers.map(c => ({ name: c.name, ...c.config }));
    },

    // --- Shortcuts, flags, renderers ---
    registerShortcut(shortcut: string, options: any) {
      shortcuts.push({ shortcut, options });
    },
    registerFlag(name: string, options: any) {
      flags.set(name, { options });
      if (options.default !== undefined && !flags.get(name)?.value) {
        flags.get(name)!.value = options.default;
      }
    },
    getFlag(name: string): boolean | string | undefined {
      if (!flags.has(name)) return undefined;
      return flags.get(name)!.value;
    },
    registerMessageRenderer(customType: string, renderer: any) {
      messageRenderers.set(customType, renderer);
    },
    sendMessage: noop as any,
    sendUserMessage: noop as any,
    appendEntry: noop as any,
    setSessionName: noop as any,
    getSessionName: noop as any,
    setLabel: noop as any,
    exec: noop as any,
    setModel: noop as any,
    getThinkingLevel: noop as any,
    setThinkingLevel: noop as any,
    registerProvider: noop as any,
    unregisterProvider: noop as any,
    events: {} as any,
  } as MockPi;

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
