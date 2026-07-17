export { discoverWorkspace, readProjectConfig } from './discovery.js';
export { readResourceContents, selectResources } from './content.js';
export type { ResourceContent, ResourceContentQuery } from './content.js';
export {
  createResourceLockfile,
  hashFile,
  hashText,
  readResourceLockfile,
  resolveResourceLockfilePath,
  writeResourceLockfile,
} from './lockfile.js';
export { materializeResource, renderTemplate } from './materializer.js';
export { readWorkspaceRegistry } from './registry.js';
export { ResourceResolver, createProjectProfileFromProjectJson } from './resolver.js';
export { validateProject, validateVeaw, validateWorkspaceRegistry } from './validator.js';
export type {
  ValidateVeawInput,
  ValidationIssue,
  ValidationIssueCode,
  ValidationResult,
  ValidationSeverity,
  ValidationSummary,
} from './validator.js';
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
  MaterializeAction,
  MaterializeResourceInput,
  MaterializeResourceResult,
  ProjectProfile,
  ProjectProfileValue,
  ResourceCopyPolicy,
  ResourceConflictCondition,
  ResourceLockEntry,
  ResourceLockLastAction,
  ResourceLockStatus,
  ResourceLockfile,
  ResourceOverwritePolicy,
  ResourceProfileCondition,
  ResourceQuery,
  ResourceRegistry,
  ResourceSelectionDecision,
  ResourceSelectionDecisionStatus,
  ResourceSelectionInput,
  ResourceSelectionResult,
  VeawProjectConfig,
  WorkspaceDiscoveryOptions,
  WorkspaceDiscoverySource,
  WorkspaceLocation,
  WorkspaceRegistry,
  WorkspaceRegistryEntry,
  WorkspaceRegistryMetadata,
  WorkspaceResource,
} from './types.js';
