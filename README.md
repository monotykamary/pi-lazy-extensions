# pi-lazy-extensions

Lazy-load [pi coding agent](https://pi.dev) extensions on demand via a ToolSearch-style proxy tool.

**Problem:** Every extension in `~/.pi/agent/extensions/` loads at startup. If you have many extensions, they all register their tools, commands, and event handlers immediately — even if you rarely use them. This clutters the tool list and wastes resources.

**Solution:** `pi-lazy-extensions` registers a single `ext` proxy tool. The LLM discovers and activates extensions on demand, just like Anthropic's ToolSearch for MCP tools. Extensions stay unloaded until needed.

## Install

```bash
pi install npm:pi-lazy-extensions
```

## Setup

Create a `lazy-extensions.json` manifest in your project root or `.pi/` directory:

```json
{
  "version": 1,
  "extensions": [
    {
      "name": "todo",
      "path": "~/.pi/agent/extensions/todo.ts",
      "lifecycle": "lazy",
      "description": "Task management - create, list, and track todos",
      "toolSummary": ["todo_list", "todo_add", "todo_complete"],
      "tags": ["productivity", "tasks"]
    },
    {
      "name": "snake",
      "path": "~/.pi/agent/extensions/snake.ts",
      "lifecycle": "lazy",
      "description": "Snake game while you wait",
      "tags": ["fun"]
    },
    {
      "name": "git-checkpoint",
      "path": "~/.pi/agent/extensions/git-checkpoint.ts",
      "lifecycle": "eager",
      "description": "Auto git stash/restore on each turn"
    }
  ],
  "settings": {
    "idleTimeout": 10,
    "eagerOverrides": ""
  }
}
```

### Manifest Location

The manifest is searched in this order:

1. `LAZY_EXTENSIONS_CONFIG` environment variable (explicit path)
2. `<cwd>/.pi/lazy-extensions.json` (project `.pi` dir)
3. `~/.pi/agent/lazy-extensions.json` (global)
4. `<cwd>/lazy-extensions.json` (project root)

### Extension Config

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier for the extension |
| `path` | string | Path to the extension's entry point (`.ts` or `.js`) |
| `lifecycle` | `"lazy"` \| `"eager"` \| `"keep-alive"` | Default: `"lazy"`. Eager loads at startup, keep-alive never unloads |
| `description` | string? | What the extension does (shown in search results) |
| `toolSummary` | string[]? | Names of tools this extension registers (for discovery before load) |
| `tags` | string[]? | Search/filter tags |

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `disableProxyTool` | boolean | false | If true, don't register the `ext` proxy tool |
| `idleTimeout` | number | 10 | Minutes before unloading idle lazy extensions (0 = never) |
| `eagerOverrides` | string | "" | Comma-separated extension names to force eager loading |

## Usage

### Via the `ext` tool (LLM calls)

```
ext({})                                    → Status: list all extensions
ext({ search: "todo" })                   → Search extensions matching "todo"
ext({ activate: "todo" })                 → Load and activate the "todo" extension
ext({ tools: "todo" })                    → List tools registered by "todo"
```

After `ext({ activate: "todo" })`, the `todo` extension's tools become directly available to the LLM.

### Via the `/ext` command (user calls)

```
/ext                           → Show status
/ext activate todo             → Activate an extension
/ext search productivity       → Search extensions
/ext tools todo                → List extension tools
```

## How It Works

1. At startup, `pi-lazy-extensions` reads the manifest and registers the `ext` proxy tool
2. **Eager** and **keep-alive** extensions are loaded immediately during `session_start`
3. **Lazy** extensions stay unloaded — their metadata is available for search/discovery
4. When the LLM (or user) calls `ext({ activate: "name" })`, the extension is dynamically loaded via jiti (with the same module alias map that pi's own loader uses, so `import { Type } from "typebox"` and `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"` work correctly), and its factory function is called with the shared `ExtensionAPI`
5. New tools registered by the activated extension appear immediately — no `/reload` needed
6. After an idle timeout, lazy extensions are "soft unloaded" (their tools are deactivated)

### Limitations

- **No full unloading:** Once an extension's factory runs, its event handlers are permanent. Idle unloading only removes tools from the active set.
- **Shortcuts, flags, and message renderers persist:** These registrations have no deactivate/remove API in the current ExtensionAPI. They remain active even after idle-unload. The `ext` status display shows counts of these for awareness.
- **`sourceInfo` attribution:** Tools registered by lazy-loaded extensions will show the proxy extension's source info, not the original extension's. This is an SDK limitation — `pi.registerTool()` always tags tools with the caller extension's `sourceInfo`.
- **`/ext` command vs `ext` tool:** The `/ext` command uses `ctx.ui.notify()` for output, which may truncate large results. For rich output (search results, detailed status), prefer the `ext` tool interface which renders properly in the TUI.

## Example: Converting an Existing Extension

Before (always loaded):
```
~/.pi/agent/extensions/my-heavy-ext.ts
```

After (lazy loaded):

1. Move or keep the extension in its existing path
2. Add to `lazy-extensions.json`:
```json
{
  "version": 1,
  "extensions": [
    {
      "name": "my-heavy-ext",
      "path": "~/.pi/agent/extensions/my-heavy-ext.ts",
      "lifecycle": "lazy",
      "description": "My heavy extension with 5 tools",
      "toolSummary": ["heavy_tool_1", "heavy_tool_2", "heavy_tool_3", "heavy_tool_4", "heavy_tool_5"]
    }
  ]
}
```
3. Rename or remove the original from auto-discovery (add a `.bak` suffix or move it out of `~/.pi/agent/extensions/`) so it isn't loaded eagerly by pi itself

## Motivation

This is an experiment. If the pattern proves useful, the goal is to propose a `pi.loadExtension(path)` method to the pi SDK that handles proper `sourceInfo` attribution, deduplication, and full lifecycle management. This package serves as a working prototype to validate the approach.

### Module Resolution

Lazy extensions are loaded via `@mariozechner/jiti` — the same TypeScript/ESM transpiler that pi uses for its own extension loader. The jiti instance is configured with the same alias map that pi builds internally, which resolves:

- `typebox` (and `typebox/compile`, `typebox/value`)
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-tui`
- `@mariozechner/pi-ai` (and `@mariozechner/pi-ai/oauth`)
- `@sinclair/typebox` (legacy alias)

This ensures lazy extensions can use the same imports as normally-loaded extensions. If jiti is unavailable (e.g. stripped from the runtime), the loader falls back to raw `import()`, which only works for `.js` files without SDK imports.

## License

MIT
