export { discoverWorkspace, readProjectConfig } from './discovery.js';
export { createResourceLockfile, readResourceLockfile, resolveResourceLockfilePath, writeResourceLockfile } from './lockfile.js';
export { materializeResource, renderTemplate } from './materializer.js';
export { readWorkspaceRegistry } from './registry.js';
export { ResourceResolver } from './resolver.js';
export type {
  LoadedWorkspaceRegistry,
  MaterializeResourceInput,
  MaterializeResourceResult,
  ResourceCopyPolicy,
  ResourceLockEntry,
  ResourceLockfile,
  ResourceOverwritePolicy,
  ResourceQuery,
  ResourceRegistry,
  VeawProjectConfig,
  WorkspaceDiscoveryOptions,
  WorkspaceDiscoverySource,
  WorkspaceLocation,
  WorkspaceRegistry,
  WorkspaceRegistryEntry,
  WorkspaceRegistryMetadata,
  WorkspaceResource,
} from './types.js';
