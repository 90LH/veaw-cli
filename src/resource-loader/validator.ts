import path from 'node:path';
import fs from 'fs-extra';
import {
  isCopyPolicy,
  isOverwritePolicy,
  isRecord,
  readBoolean,
  readConflictCondition,
  readProfileCondition,
  readString,
  readStringArray,
} from './guards.js';
import { hashFile, readResourceLockfile } from './lockfile.js';
import type { ResourceLockEntry, WorkspaceResource } from './types.js';

/**
 * 当前支持的 Registry schema 版本。
 */
const SUPPORTED_SCHEMA_VERSION = '1.0.0';

/**
 * 校验问题严重级别。
 */
export type ValidationSeverity = 'error' | 'warning';

/**
 * 校验问题错误码。
 */
export type ValidationIssueCode =
  | 'VEAW_REGISTRY_SCHEMA_UNSUPPORTED'
  | 'VEAW_REGISTRY_INVALID_JSON'
  | 'VEAW_REGISTRY_MISSING_FILE'
  | 'VEAW_REGISTRY_DUPLICATE_ID'
  | 'VEAW_REGISTRY_TYPE_MISMATCH'
  | 'VEAW_REGISTRY_SOURCE_MISSING'
  | 'VEAW_REGISTRY_SOURCE_OUTSIDE'
  | 'VEAW_REGISTRY_TARGET_INVALID'
  | 'VEAW_REGISTRY_HASH_MISMATCH'
  | 'VEAW_REGISTRY_DEP_MISSING'
  | 'VEAW_REGISTRY_DEP_CYCLE'
  | 'VEAW_REGISTRY_POLICY_INVALID'
  | 'VEAW_REGISTRY_FIELD_INVALID'
  | 'VEAW_PROJECT_WORKSPACE_UNAVAILABLE'
  | 'VEAW_PROJECT_LOCK_INVALID'
  | 'VEAW_PROJECT_LOCK_TARGET_INVALID'
  | 'VEAW_PROJECT_LOCK_TARGET_MISSING'
  | 'VEAW_PROJECT_LOCK_TARGET_MISMATCH';

/**
 * 校验问题。
 */
export interface ValidationIssue {
  /**
   * 错误码。
   */
  readonly code: ValidationIssueCode;
  /**
   * 严重级别。
   */
  readonly severity: ValidationSeverity;
  /**
   * 问题位置。
   */
  readonly path: string;
  /**
   * 人类可读信息。
   */
  readonly message: string;
  /**
   * 关联资源 id。
   */
  readonly resourceId?: string;
}

/**
 * 校验摘要。
 */
export interface ValidationSummary {
  /**
   * 错误数量。
   */
  readonly errorCount: number;
  /**
   * 警告数量。
   */
  readonly warningCount: number;
}

/**
 * 校验结果。
 */
export interface ValidationResult {
  /**
   * 是否通过。
   */
  readonly ok: boolean;
  /**
   * 建议退出码。
   */
  readonly exitCode: number;
  /**
   * 校验摘要。
   */
  readonly summary: ValidationSummary;
  /**
   * 问题列表。
   */
  readonly issues: readonly ValidationIssue[];
}

/**
 * VEAW 校验输入。
 */
export interface ValidateVeawInput {
  /**
   * 项目目录。
   */
  readonly projectDirectory: string;
  /**
   * 显式 Workspace 目录。
   */
  readonly workspaceDirectory?: string;
}

/**
 * 顶层 Registry JSON。
 */
interface TopLevelRegistryRecord {
  /**
   * Workspace 版本。
   */
  readonly workspaceVersion: string;
  /**
   * 子 Registry 入口。
   */
  readonly registries: readonly RegistryEntryRecord[];
}

/**
 * 子 Registry 入口。
 */
interface RegistryEntryRecord {
  /**
   * Registry id。
   */
  readonly id: string;
  /**
   * Registry 类型。
   */
  readonly type: string;
  /**
   * Registry 文件路径。
   */
  readonly path: string;
  /**
   * 是否必需。
   */
  readonly required: boolean;
}

/**
 * 子 Registry JSON。
 */
interface ChildRegistryRecord {
  /**
   * 子 Registry 资源类型。
   */
  readonly resourceType: string;
  /**
   * 资源列表。
   */
  readonly resources: readonly WorkspaceResource[];
}

/**
 * 校验 VEAW Workspace 与项目。
 *
 * @param input 校验输入。
 * @returns 校验结果。
 */
export async function validateVeaw(input: ValidateVeawInput): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const workspaceDirectory = await resolveWorkspaceDirectory(input, issues);

  if (workspaceDirectory !== undefined) {
    issues.push(...(await validateWorkspaceRegistry(workspaceDirectory)));
  }

  issues.push(...(await validateProject(input.projectDirectory)));

  return createValidationResult(issues);
}

/**
 * 校验 Workspace Registry。
 *
 * @param workspaceDirectory Workspace 根目录。
 * @returns 校验问题列表。
 */
export async function validateWorkspaceRegistry(workspaceDirectory: string): Promise<readonly ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const registriesDirectory = path.join(workspaceDirectory, 'registries');
  const topLevelPath = path.join(registriesDirectory, 'registry.json');
  const topLevel = await readTopLevelRegistry(topLevelPath, issues);

  if (topLevel === undefined) {
    return issues;
  }

  const resources: WorkspaceResource[] = [];
  const registryIds = new Set<string>();

  for (const entry of topLevel.registries) {
    addDuplicateIssueIfNeeded(issues, registryIds, entry.id, path.join('registries', 'registry.json'), undefined);

    const registryPath = resolveContainedPath(registriesDirectory, entry.path);

    if (registryPath === undefined) {
      addIssue(issues, 'VEAW_REGISTRY_TARGET_INVALID', path.join('registries', 'registry.json'), `Registry path is outside registries/: ${entry.path}`);
      continue;
    }

    if (!(await fs.pathExists(registryPath))) {
      if (entry.required) {
        addIssue(issues, 'VEAW_REGISTRY_MISSING_FILE', toWorkspacePath(workspaceDirectory, registryPath), `Missing registry: ${entry.path}`);
      }

      continue;
    }

    const childRegistry = await readChildRegistry(registryPath, topLevel.workspaceVersion, issues);

    if (childRegistry === undefined) {
      continue;
    }

    if (childRegistry.resourceType !== entry.type) {
      addIssue(
        issues,
        'VEAW_REGISTRY_TYPE_MISMATCH',
        toWorkspacePath(workspaceDirectory, registryPath),
        `Registry type ${entry.type} does not match child resourceType ${childRegistry.resourceType}.`,
      );
    }

    for (const resource of childRegistry.resources) {
      if (resource.type !== childRegistry.resourceType) {
        addIssue(
          issues,
          'VEAW_REGISTRY_TYPE_MISMATCH',
          toWorkspacePath(workspaceDirectory, registryPath),
          `Resource ${resource.id} type ${resource.type} does not match child resourceType ${childRegistry.resourceType}.`,
          resource.id,
        );
      }

      resources.push(resource);
      await validateWorkspaceResource(workspaceDirectory, registryPath, resource, issues);
    }
  }

  validateResourceIds(resources, issues);
  validateDependencies(resources, issues);

  return issues;
}

/**
 * 校验项目配置与 lockfile。
 *
 * @param projectDirectory 项目目录。
 * @returns 校验问题列表。
 */
export async function validateProject(projectDirectory: string): Promise<readonly ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const configPath = path.join(projectDirectory, '.veaw', 'config.json');

  if (await fs.pathExists(configPath)) {
    const config = await readJsonObject(configPath, issues);
    const workspacePath = config === undefined ? undefined : readString(config, 'workspacePath');

    if (workspacePath !== undefined && !(await fs.pathExists(workspacePath))) {
      addIssue(
        issues,
        'VEAW_PROJECT_WORKSPACE_UNAVAILABLE',
        '.veaw/config.json',
        `Configured Workspace is not accessible: ${workspacePath}`,
      );
    }
  }

  await validateProjectLockfile(projectDirectory, issues);

  return issues;
}

/**
 * 解析 Workspace 目录。
 *
 * @param input 校验输入。
 * @param issues 问题列表。
 * @returns Workspace 目录。
 */
async function resolveWorkspaceDirectory(
  input: ValidateVeawInput,
  issues: ValidationIssue[],
): Promise<string | undefined> {
  if (input.workspaceDirectory !== undefined) {
    return input.workspaceDirectory;
  }

  if (await isWorkspaceRoot(input.projectDirectory)) {
    return input.projectDirectory;
  }

  const configPath = path.join(input.projectDirectory, '.veaw', 'config.json');

  if (!(await fs.pathExists(configPath))) {
    return undefined;
  }

  const config = await readJsonObject(configPath, issues);

  return config === undefined ? undefined : readString(config, 'workspacePath');
}

/**
 * 判断目录是否是 Workspace 根目录。
 *
 * @param directoryPath 目录路径。
 * @returns 是否是 Workspace 根目录。
 */
async function isWorkspaceRoot(directoryPath: string): Promise<boolean> {
  return (
    (await fs.pathExists(path.join(directoryPath, 'workspace.json'))) &&
    (await fs.pathExists(path.join(directoryPath, 'registries', 'registry.json')))
  );
}

/**
 * 读取顶层 Registry。
 *
 * @param filePath 文件路径。
 * @param issues 问题列表。
 * @returns 顶层 Registry。
 */
async function readTopLevelRegistry(
  filePath: string,
  issues: ValidationIssue[],
): Promise<TopLevelRegistryRecord | undefined> {
  if (!(await fs.pathExists(filePath))) {
    addIssue(issues, 'VEAW_REGISTRY_MISSING_FILE', 'registries/registry.json', 'Missing top-level registry.json.');
    return undefined;
  }

  const content = await readJsonObject(filePath, issues);

  if (content === undefined) {
    return undefined;
  }

  const schemaVersion = readString(content, 'schemaVersion');
  const workspaceVersion = readString(content, 'workspaceVersion');
  const registries = readRegistryEntries(content.registries);

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    addIssue(issues, 'VEAW_REGISTRY_SCHEMA_UNSUPPORTED', 'registries/registry.json', `Unsupported schemaVersion: ${schemaVersion ?? 'unknown'}`);
  }

  if (workspaceVersion === undefined || workspaceVersion.trim().length === 0 || registries === undefined) {
    addIssue(issues, 'VEAW_REGISTRY_FIELD_INVALID', 'registries/registry.json', 'Invalid top-level registry fields.');
    return undefined;
  }

  return {
    workspaceVersion,
    registries,
  };
}

/**
 * 读取子 Registry。
 *
 * @param filePath 文件路径。
 * @param workspaceVersion Workspace 版本。
 * @param issues 问题列表。
 * @returns 子 Registry。
 */
async function readChildRegistry(
  filePath: string,
  workspaceVersion: string,
  issues: ValidationIssue[],
): Promise<ChildRegistryRecord | undefined> {
  const content = await readJsonObject(filePath, issues);

  if (content === undefined) {
    return undefined;
  }

  const schemaVersion = readString(content, 'schemaVersion');
  const registryWorkspaceVersion = readString(content, 'workspaceVersion');
  const resourceType = readString(content, 'resourceType');
  const resources = Array.isArray(content.resources) ? content.resources.map(readWorkspaceResource) : undefined;
  const registryPath = normalizeDisplayPath(filePath);

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    addIssue(issues, 'VEAW_REGISTRY_SCHEMA_UNSUPPORTED', registryPath, `Unsupported schemaVersion: ${schemaVersion ?? 'unknown'}`);
  }

  if (registryWorkspaceVersion !== workspaceVersion || resourceType === undefined || resources === undefined) {
    addIssue(issues, 'VEAW_REGISTRY_FIELD_INVALID', registryPath, 'Invalid child registry fields.');
    return undefined;
  }

  if (resources.some((resource) => resource === undefined)) {
    addIssue(issues, 'VEAW_REGISTRY_FIELD_INVALID', registryPath, 'Invalid resource fields.');
    reportInvalidPolicies(content.resources, registryPath, issues);
  }

  return {
    resourceType,
    resources: resources.filter((resource): resource is WorkspaceResource => resource !== undefined),
  };
}

/**
 * 校验 Workspace 资源。
 *
 * @param workspaceDirectory Workspace 根目录。
 * @param registryPath Registry 文件路径。
 * @param resource Workspace 资源。
 * @param issues 问题列表。
 */
async function validateWorkspaceResource(
  workspaceDirectory: string,
  registryPath: string,
  resource: WorkspaceResource,
  issues: ValidationIssue[],
): Promise<void> {
  const displayPath = toWorkspacePath(workspaceDirectory, registryPath);
  const sourcePath = resolveContainedPath(workspaceDirectory, resource.sourcePath);

  if (resource.version.trim().length === 0 || resource.hash.trim().length === 0) {
    addIssue(issues, 'VEAW_REGISTRY_FIELD_INVALID', displayPath, `Resource ${resource.id} has empty version or hash.`, resource.id);
  }

  if (!isValidRelativePath(resource.targetPath)) {
    addIssue(issues, 'VEAW_REGISTRY_TARGET_INVALID', displayPath, `Resource ${resource.id} has invalid targetPath: ${resource.targetPath}`, resource.id);
  }

  if (!isCopyPolicy(resource.copyPolicy) || !isOverwritePolicy(resource.overwritePolicy)) {
    addIssue(issues, 'VEAW_REGISTRY_POLICY_INVALID', displayPath, `Resource ${resource.id} has invalid policies.`, resource.id);
  }

  if (sourcePath === undefined) {
    addIssue(issues, 'VEAW_REGISTRY_SOURCE_OUTSIDE', displayPath, `Resource ${resource.id} sourcePath is outside Workspace.`, resource.id);
    return;
  }

  if (!(await fs.pathExists(sourcePath))) {
    addIssue(issues, 'VEAW_REGISTRY_SOURCE_MISSING', displayPath, `Resource ${resource.id} sourcePath is missing: ${resource.sourcePath}`, resource.id);
    return;
  }

  const actualHash = await hashFile(sourcePath);

  if (actualHash !== resource.hash) {
    addIssue(
      issues,
      'VEAW_REGISTRY_HASH_MISMATCH',
      displayPath,
      `Resource ${resource.id} hash mismatch: expected ${resource.hash}, actual ${actualHash}`,
      resource.id,
    );
  }
}

/**
 * 校验资源 id 唯一性。
 *
 * @param resources 资源列表。
 * @param issues 问题列表。
 */
function validateResourceIds(resources: readonly WorkspaceResource[], issues: ValidationIssue[]): void {
  const ids = new Set<string>();

  for (const resource of resources) {
    addDuplicateIssueIfNeeded(issues, ids, resource.id, resource.sourcePath, resource.id);
  }
}

/**
 * 校验依赖存在且无循环。
 *
 * @param resources 资源列表。
 * @param issues 问题列表。
 */
function validateDependencies(resources: readonly WorkspaceResource[], issues: ValidationIssue[]): void {
  const resourceMap = new Map(resources.map((resource) => [resource.id, resource]));

  for (const resource of resources) {
    for (const dependencyId of resource.dependencies) {
      if (!resourceMap.has(dependencyId)) {
        addIssue(issues, 'VEAW_REGISTRY_DEP_MISSING', resource.sourcePath, `Resource ${resource.id} depends on missing ${dependencyId}.`, resource.id);
      }
    }
  }

  validateDependencyCycles(resources, resourceMap, issues);
}

/**
 * 校验依赖循环。
 *
 * @param resources 资源列表。
 * @param resourceMap 资源映射。
 * @param issues 问题列表。
 */
function validateDependencyCycles(
  resources: readonly WorkspaceResource[],
  resourceMap: ReadonlyMap<string, WorkspaceResource>,
  issues: ValidationIssue[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const resource of resources) {
    visitDependency(resource, resourceMap, visiting, visited, issues, []);
  }
}

/**
 * 访问依赖节点。
 *
 * @param resource 当前资源。
 * @param resourceMap 资源映射。
 * @param visiting 正在访问集合。
 * @param visited 已访问集合。
 * @param issues 问题列表。
 * @param stack 访问栈。
 */
function visitDependency(
  resource: WorkspaceResource,
  resourceMap: ReadonlyMap<string, WorkspaceResource>,
  visiting: Set<string>,
  visited: Set<string>,
  issues: ValidationIssue[],
  stack: readonly string[],
): void {
  if (visited.has(resource.id)) {
    return;
  }

  if (visiting.has(resource.id)) {
    addIssue(issues, 'VEAW_REGISTRY_DEP_CYCLE', resource.sourcePath, `Dependency cycle detected: ${[...stack, resource.id].join(' -> ')}`, resource.id);
    return;
  }

  visiting.add(resource.id);

  for (const dependencyId of resource.dependencies) {
    const dependency = resourceMap.get(dependencyId);

    if (dependency !== undefined) {
      visitDependency(dependency, resourceMap, visiting, visited, issues, [...stack, resource.id]);
    }
  }

  visiting.delete(resource.id);
  visited.add(resource.id);
}

/**
 * 校验项目 lockfile。
 *
 * @param projectDirectory 项目目录。
 * @param issues 问题列表。
 */
async function validateProjectLockfile(projectDirectory: string, issues: ValidationIssue[]): Promise<void> {
  try {
    const lockfile = await readResourceLockfile(projectDirectory);

    if (lockfile === undefined) {
      return;
    }

    for (const entry of lockfile.resources) {
      await validateProjectLockEntry(projectDirectory, entry, issues);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    addIssue(issues, 'VEAW_PROJECT_LOCK_INVALID', '.veaw/resources.lock.json', message);
  }
}

/**
 * 校验项目 lockfile 条目。
 *
 * @param projectDirectory 项目目录。
 * @param entry lockfile 条目。
 * @param issues 问题列表。
 */
async function validateProjectLockEntry(
  projectDirectory: string,
  entry: ResourceLockEntry,
  issues: ValidationIssue[],
): Promise<void> {
  const targetPath = resolveContainedPath(projectDirectory, entry.targetPath);

  if (targetPath === undefined) {
    addIssue(issues, 'VEAW_PROJECT_LOCK_TARGET_INVALID', '.veaw/resources.lock.json', `Lock entry ${entry.id} targetPath is invalid.`, entry.id);
    return;
  }

  const exists = await fs.pathExists(targetPath);

  if (!exists) {
    if (entry.status !== 'missing') {
      addIssue(issues, 'VEAW_PROJECT_LOCK_TARGET_MISSING', '.veaw/resources.lock.json', `Lock entry ${entry.id} target file is missing.`, entry.id);
    }

    return;
  }

  if (entry.status === 'missing') {
    addIssue(issues, 'VEAW_PROJECT_LOCK_TARGET_MISMATCH', '.veaw/resources.lock.json', `Lock entry ${entry.id} is marked missing but target exists.`, entry.id);
    return;
  }

  if (entry.targetHash !== undefined) {
    const actualHash = await hashFile(targetPath);

    if (actualHash !== entry.targetHash) {
      addIssue(
        issues,
        'VEAW_PROJECT_LOCK_TARGET_MISMATCH',
        '.veaw/resources.lock.json',
        `Lock entry ${entry.id} target hash mismatch: expected ${entry.targetHash}, actual ${actualHash}`,
        entry.id,
      );
    }
  }
}

/**
 * 读取 JSON 对象。
 *
 * @param filePath 文件路径。
 * @param issues 问题列表。
 * @returns JSON 对象。
 */
async function readJsonObject(
  filePath: string,
  issues: ValidationIssue[],
): Promise<Record<string, unknown> | undefined> {
  try {
    const content = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

    if (!isRecord(content)) {
      addIssue(issues, 'VEAW_REGISTRY_INVALID_JSON', normalizeDisplayPath(filePath), 'JSON content is not an object.');
      return undefined;
    }

    return content;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    addIssue(issues, 'VEAW_REGISTRY_INVALID_JSON', normalizeDisplayPath(filePath), message);
    return undefined;
  }
}

/**
 * 读取 Registry 入口列表。
 *
 * @param value 原始值。
 * @returns Registry 入口列表。
 */
function readRegistryEntries(value: unknown): readonly RegistryEntryRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.map(readRegistryEntry);

  if (entries.some((entry) => entry === undefined)) {
    return undefined;
  }

  return entries.filter((entry): entry is RegistryEntryRecord => entry !== undefined);
}

/**
 * 读取 Registry 入口。
 *
 * @param value 原始值。
 * @returns Registry 入口。
 */
function readRegistryEntry(value: unknown): RegistryEntryRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, 'id');
  const type = readString(value, 'type');
  const registryPath = readString(value, 'path');
  const required = readBoolean(value, 'required');

  if (id === undefined || type === undefined || registryPath === undefined || required === undefined) {
    return undefined;
  }

  return {
    id,
    type,
    path: registryPath,
    required,
  };
}

/**
 * 读取 Workspace 资源。
 *
 * @param value 原始值。
 * @returns Workspace 资源。
 */
function readWorkspaceResource(value: unknown): WorkspaceResource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, 'id');
  const type = readString(value, 'type');
  const version = readString(value, 'version');
  const sourcePath = readString(value, 'sourcePath');
  const targetPath = readString(value, 'targetPath');
  const tags = readStringArray(value, 'tags');
  const dependencies = readStringArray(value, 'dependencies');
  const enabledByDefault = readBoolean(value, 'enabledByDefault');
  const hash = readString(value, 'hash');

  if (
    id === undefined ||
    type === undefined ||
    version === undefined ||
    sourcePath === undefined ||
    targetPath === undefined ||
    tags === undefined ||
    dependencies === undefined ||
    enabledByDefault === undefined ||
    hash === undefined ||
    !isCopyPolicy(value.copyPolicy) ||
    !isOverwritePolicy(value.overwritePolicy)
  ) {
    return undefined;
  }

  return {
    id,
    type,
    version,
    sourcePath,
    targetPath,
    tags,
    dependencies,
    enabledByDefault,
    copyPolicy: value.copyPolicy,
    overwritePolicy: value.overwritePolicy,
    hash,
    appliesTo: readProfileCondition(value, 'appliesTo'),
    conflictsWith: readConflictCondition(value, 'conflictsWith'),
    defaultResources: readStringArray(value, 'defaultResources'),
  };
}

/**
 * 报告非法资源策略。
 *
 * @param value 原始资源数组。
 * @param registryPath Registry 路径。
 * @param issues 问题列表。
 */
function reportInvalidPolicies(value: unknown, registryPath: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const resource of value) {
    if (!isRecord(resource)) {
      continue;
    }

    const id = readString(resource, 'id');

    if (!isCopyPolicy(resource.copyPolicy) || !isOverwritePolicy(resource.overwritePolicy)) {
      addIssue(issues, 'VEAW_REGISTRY_POLICY_INVALID', registryPath, `Resource ${id ?? 'unknown'} has invalid policies.`, id);
    }
  }
}

/**
 * 判断相对路径是否合法。
 *
 * @param value 路径。
 * @returns 是否合法。
 */
function isValidRelativePath(value: string): boolean {
  if (value.trim().length === 0 || path.isAbsolute(value)) {
    return false;
  }

  const segments = value.split(/[\\/]+/);

  return segments.every((segment) => segment !== '..');
}

/**
 * 解析并限制路径在根目录内。
 *
 * @param rootDirectory 根目录。
 * @param relativePath 相对路径。
 * @returns 安全路径。
 */
function resolveContainedPath(rootDirectory: string, relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }

  const rootPath = path.resolve(rootDirectory);
  const targetPath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, targetPath);

  if (relativeToRoot.length === 0 || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot))) {
    return targetPath;
  }

  return undefined;
}

/**
 * 发现重复 id 并添加问题。
 *
 * @param issues 问题列表。
 * @param ids 已见 id。
 * @param id 当前 id。
 * @param issuePath 问题路径。
 * @param resourceId 资源 id。
 */
function addDuplicateIssueIfNeeded(
  issues: ValidationIssue[],
  ids: Set<string>,
  id: string,
  issuePath: string,
  resourceId: string | undefined,
): void {
  if (ids.has(id)) {
    addIssue(issues, 'VEAW_REGISTRY_DUPLICATE_ID', issuePath, `Duplicate id: ${id}`, resourceId);
    return;
  }

  ids.add(id);
}

/**
 * 添加错误问题。
 *
 * @param issues 问题列表。
 * @param code 错误码。
 * @param issuePath 问题路径。
 * @param message 问题信息。
 * @param resourceId 资源 id。
 */
function addIssue(
  issues: ValidationIssue[],
  code: ValidationIssueCode,
  issuePath: string,
  message: string,
  resourceId?: string,
): void {
  issues.push({
    code,
    severity: 'error',
    path: issuePath,
    message,
    resourceId,
  });
}

/**
 * 创建校验结果。
 *
 * @param issues 问题列表。
 * @returns 校验结果。
 */
function createValidationResult(issues: readonly ValidationIssue[]): ValidationResult {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    ok: errorCount === 0,
    exitCode: errorCount === 0 ? 0 : 2,
    summary: {
      errorCount,
      warningCount,
    },
    issues,
  };
}

/**
 * 转换为 Workspace 相对路径。
 *
 * @param workspaceDirectory Workspace 根目录。
 * @param filePath 文件路径。
 * @returns 相对路径。
 */
function toWorkspacePath(workspaceDirectory: string, filePath: string): string {
  return path.relative(workspaceDirectory, filePath).replaceAll(path.sep, '/') || '.';
}

/**
 * 规范化显示路径。
 *
 * @param filePath 文件路径。
 * @returns 显示路径。
 */
function normalizeDisplayPath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/');
}
