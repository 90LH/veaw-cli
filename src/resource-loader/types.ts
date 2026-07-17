/**
 * Workspace discovery source.
 */
export type WorkspaceDiscoverySource = 'explicit' | 'environment' | 'project-config' | 'ancestor' | 'fallback';

/**
 * Resource copy strategy.
 */
export type ResourceCopyPolicy = 'copy' | 'reference' | 'render' | 'none';

/**
 * Resource overwrite strategy.
 */
export type ResourceOverwritePolicy = 'never' | 'if-missing' | 'managed-block' | 'always';

/**
 * Materializer action result.
 */
export type MaterializeAction = 'copied' | 'rendered' | 'referenced' | 'skipped';

/**
 * Resource lock status.
 */
export type ResourceLockStatus = 'installed' | 'modified' | 'missing' | 'conflict' | 'skipped';

/**
 * Resource lock last action.
 */
export type ResourceLockLastAction = 'init' | 'sync' | 'migrate';

/**
 * Workspace discovery options.
 */
export interface WorkspaceDiscoveryOptions {
  /**
   * Target project directory.
   */
  readonly projectDirectory: string;
  /**
   * Explicit workspace path, intended for --workspace.
   */
  readonly explicitWorkspacePath?: string;
  /**
   * Environment map. Defaults to process.env.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /**
   * CLI bundled assets fallback directory.
   */
  readonly fallbackAssetsDirectory?: string;
}

/**
 * Discovered workspace location.
 */
export interface WorkspaceLocation {
  /**
   * Discovery source.
   */
  readonly source: WorkspaceDiscoverySource;
  /**
   * Whether the result is a full Workspace or CLI assets fallback.
   */
  readonly kind: 'workspace' | 'fallback';
  /**
   * Root directory for the discovered location.
   */
  readonly rootDirectory: string;
  /**
   * Registries directory for a full Workspace.
   */
  readonly registriesDirectory?: string;
  /**
   * Assets directory for fallback mode.
   */
  readonly assetsDirectory?: string;
}

/**
 * Project .veaw/config.json model.
 */
export interface VeawProjectConfig {
  /**
   * Bound Workspace path.
   */
  readonly workspacePath?: string;
}

/**
 * Workspace registry entry.
 */
export interface WorkspaceRegistryEntry {
  /**
   * Registry id.
   */
  readonly id: string;
  /**
   * Registry resource type.
   */
  readonly type: string;
  /**
   * Registry file path relative to registries directory.
   */
  readonly path: string;
  /**
   * Whether this registry is required.
   */
  readonly required: boolean;
}

/**
 * Workspace registry metadata.
 */
export interface WorkspaceRegistryMetadata {
  /**
   * Workspace id.
   */
  readonly id: string;
  /**
   * Workspace name.
   */
  readonly name: string;
  /**
   * Root marker file.
   */
  readonly rootMarker: string;
  /**
   * Optional description.
   */
  readonly description?: string;
}

/**
 * Top-level registry.
 */
export interface WorkspaceRegistry {
  /**
   * Registry schema version.
   */
  readonly schemaVersion: string;
  /**
   * Workspace version.
   */
  readonly workspaceVersion: string;
  /**
   * Workspace metadata.
   */
  readonly workspace: WorkspaceRegistryMetadata;
  /**
   * Child registry entries.
   */
  readonly registries: readonly WorkspaceRegistryEntry[];
}

/**
 * Resource registry item.
 */
export interface WorkspaceResource {
  /**
   * Stable resource id.
   */
  readonly id: string;
  /**
   * Resource type.
   */
  readonly type: string;
  /**
   * Resource version.
   */
  readonly version: string;
  /**
   * Source path relative to Workspace root.
   */
  readonly sourcePath: string;
  /**
   * Target path relative to Project root.
   */
  readonly targetPath: string;
  /**
   * Resource tags.
   */
  readonly tags: readonly string[];
  /**
   * Resource dependency ids.
   */
  readonly dependencies: readonly string[];
  /**
   * Whether the resource is enabled by default.
   */
  readonly enabledByDefault: boolean;
  /**
   * Copy policy.
   */
  readonly copyPolicy: ResourceCopyPolicy;
  /**
   * Overwrite policy.
   */
  readonly overwritePolicy: ResourceOverwritePolicy;
  /**
   * Source hash.
   */
  readonly hash: string;
}

/**
 * Child resource registry.
 */
export interface ResourceRegistry {
  /**
   * Registry schema version.
   */
  readonly schemaVersion: string;
  /**
   * Workspace version.
   */
  readonly workspaceVersion: string;
  /**
   * Registry resource type.
   */
  readonly resourceType: string;
  /**
   * Resources.
   */
  readonly resources: readonly WorkspaceResource[];
}

/**
 * Loaded registry graph.
 */
export interface LoadedWorkspaceRegistry {
  /**
   * Workspace location.
   */
  readonly location: WorkspaceLocation;
  /**
   * Top-level registry.
   */
  readonly registry: WorkspaceRegistry;
  /**
   * Child registries.
   */
  readonly childRegistries: readonly ResourceRegistry[];
  /**
   * Flattened resource list.
   */
  readonly resources: readonly WorkspaceResource[];
}

/**
 * Resource query.
 */
export interface ResourceQuery {
  /**
   * Resource ids.
   */
  readonly ids?: readonly string[];
  /**
   * Resource type.
   */
  readonly type?: string;
  /**
   * Tag required on the resource.
   */
  readonly tag?: string;
}

/**
 * Materializer input.
 */
export interface MaterializeResourceInput {
  /**
   * Workspace root directory.
   */
  readonly workspaceDirectory: string;
  /**
   * Project root directory.
   */
  readonly projectDirectory: string;
  /**
   * Resource to materialize.
   */
  readonly resource: WorkspaceResource;
  /**
   * Override overwrite policy for a trusted materialization.
   */
  readonly overwritePolicy?: ResourceOverwritePolicy;
  /**
   * Render variables for render copy policy.
   */
  readonly variables?: Readonly<Record<string, string>>;
}

/**
 * Materializer result.
 */
export interface MaterializeResourceResult {
  /**
   * Materialized resource id.
   */
  readonly resourceId: string;
  /**
   * Performed action.
   */
  readonly action: MaterializeAction;
  /**
   * Source file path.
   */
  readonly sourcePath: string;
  /**
   * Target file path.
   */
  readonly targetPath: string;
}

/**
 * Resource lockfile entry.
 */
export interface ResourceLockEntry {
  /**
   * Resource id.
   */
  readonly id: string;
  /**
   * Resource type.
   */
  readonly type: string;
  /**
   * Resource version.
   */
  readonly version: string;
  /**
   * Source path.
   */
  readonly sourcePath: string;
  /**
   * Target path.
   */
  readonly targetPath: string;
  /**
   * Legacy source hash field.
   */
  readonly hash?: string;
  /**
   * Workspace source hash.
   */
  readonly sourceHash: string;
  /**
   * Project target file hash.
   */
  readonly targetHash?: string;
  /**
   * First install timestamp.
   */
  readonly installedAt: string;
  /**
   * Last update timestamp.
   */
  readonly updatedAt: string;
  /**
   * Current resource status.
   */
  readonly status: ResourceLockStatus;
  /**
   * Last action that changed this entry.
   */
  readonly lastAction: ResourceLockLastAction;
}

/**
 * .veaw/resources.lock.json model.
 */
export interface ResourceLockfile {
  /**
   * Lockfile schema version.
   */
  readonly schemaVersion: string;
  /**
   * Workspace version.
   */
  readonly workspaceVersion: string;
  /**
   * Generated timestamp.
   */
  readonly generatedAt: string;
  /**
   * Resource entries.
   */
  readonly resources: readonly ResourceLockEntry[];
}
