/**
 * Types for the pi-lazy-extensions package.
 */

/** Lifecycle mode for a lazy extension. */
export type ExtensionLifecycle = "lazy" | "eager" | "keep-alive";

/** A single extension entry in the lazy manifest. */
export interface LazyExtensionConfig {
  /** Human-readable name for the extension. */
  name: string;

  /**
   * Path to the extension's entry point (relative to manifest or absolute).
   * Supports .ts, .js files, or directories with index.ts.
   */
  path: string;

  /**
   * Lifecycle mode:
   * - "lazy" (default): only loaded when explicitly activated or when a tool calls it
   * - "eager": loaded immediately at session_start
   * - "keep-alive": loaded eagerly and never shut down
   */
  lifecycle?: ExtensionLifecycle;

  /** Optional description exposed in the proxy tool for search/discovery. */
  description?: string;

  /**
   * Optional summary of what tools this extension registers.
   * Used for the proxy tool description when the extension is not yet loaded.
   */
  toolSummary?: string[];

  /**
   * Optional tags for search/filter.
   */
  tags?: string[];
}

/** The full manifest structure. */
export interface LazyExtensionsManifest {
  /** Version of the manifest format. Currently 1. */
  version: 1;

  /** Extension entries. */
  extensions: LazyExtensionConfig[];

  /**
   * Optional settings.
   */
  settings?: {
    /** Whether to disable the proxy tool entirely (only use direct registration). Default: false. */
    disableProxyTool?: boolean;

    /** Idle timeout in minutes before unloading "lazy" extensions. Default: 10. 0 = never. */
    idleTimeout?: number;

    /** Comma-separated string of extension names to always load eagerly, overriding their lifecycle. */
    eagerOverrides?: string;
  };
}

/** Runtime state for a loaded extension. */
export interface LoadedExtensionState {
  /** The config entry from the manifest. */
  config: LazyExtensionConfig;

  /** Whether the extension has been loaded into the runtime. */
  loaded: boolean;

  /** Whether the factory has been called at least once (prevents double event handlers). */
  factoryCalled: boolean;

  /** Timestamp when the extension was last activated. */
  lastActivated?: number;

  /** Timestamp when the extension was last used (tool call, command, etc.). */
  lastUsed?: number;

  /** Error message if loading failed. */
  error?: string;

  /** Names of tools registered by this extension (populated after load). */
  registeredTools: string[];

  /** Names of commands registered by this extension (populated after load). */
  registeredCommands: string[];

  /** Timer for idle unloading, if applicable. */
  idleTimer?: ReturnType<typeof setTimeout>;

  /** In-flight activation promise to deduplicate concurrent activations. */
  activationPromise?: Promise<ActivationResult>;
}

/** The overall runtime state for the lazy extensions proxy. */
export interface LazyExtensionsState {
  /** Map of extension name -> runtime state. */
  extensions: Map<string, LoadedExtensionState>;

  /** The parsed manifest. */
  manifest: LazyExtensionsManifest;

  /** Absolute path to the manifest file. */
  manifestPath: string;

  /** Base directory for resolving relative paths. */
  baseDir: string;

  /** Tracks recent activation failures to enforce backoff. */
  failureTracker: Map<string, number>;
}

/** Result of activating an extension. */
export interface ActivationResult {
  success: boolean;
  name: string;
  tools?: string[];
  commands?: string[];
  error?: string;
}
