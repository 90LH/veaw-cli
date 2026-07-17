export { discoverWorkspace, readProjectConfig } from './discovery.js';
export { readResourceContents, selectResources } from './content.js';
export type { ResourceContent, ResourceContentQuery } from './content.js';
export { createResourceLockfile, readResourceLockfile, resolveResourceLockfilePath, writeResourceLockfile } from './lockfile.js';
export { materializeResource, renderTemplate } from './materializer.js';
export { readWorkspaceRegistry } from './registry.js';
export { ResourceResolver } from './resolver.js';
export {
  executeWorkspaceCommand,
  findWorkspaceCommand,
  parseWorkspaceCommandArguments,
  readWorkspaceCommandRegistry,
} from './workspace-commands.js';
export type {
  WorkspaceCommandDefinition,
  WorkspaceCommandExecution,
  WorkspaceCommandExecutionResult,
  WorkspaceCommandExecutionType,
  WorkspaceCommandParameterDefinition,
  WorkspaceCommandParameterSchema,
  WorkspaceCommandParameterValue,
  WorkspaceCommandParameterValues,
  WorkspaceCommandRegistry,
} from './workspace-commands.js';
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
