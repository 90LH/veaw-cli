import path from 'node:path';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { execa } from 'execa';
import fs from 'fs-extra';
import {
  ResourceResolver,
  createResourceLockfile,
  discoverWorkspace,
  materializeResource,
  readResourceLockfile,
  readWorkspaceRegistry,
  writeResourceLockfile,
} from '../resource-loader/index.js';
import type {
  LoadedWorkspaceRegistry,
  ResourceLockEntry,
  ResourceLockfile,
  WorkspaceResource,
} from '../resource-loader/index.js';
import { logger } from '../utils/logger.js';

/**
 * JSON 值。
 */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * JSON 对象。
 */
type JsonObject = Record<string, JsonValue>;

/**
 * 包管理器类型。
 */
type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

/**
 * 包文件摘要。
 */
interface PackageJsonSummary {
  /**
   * package.json 是否存在。
   */
  readonly exists: boolean;
  /**
   * package.json 相对路径。
   */
  readonly path?: string;
  /**
   * 包名称。
   */
  readonly name?: string;
  /**
   * 包版本。
   */
  readonly version?: string;
  /**
   * 模块类型。
   */
  readonly type?: string;
  /**
   * packageManager 字段。
   */
  readonly packageManager?: string;
  /**
   * scripts 字段。
   */
  readonly scripts?: Readonly<Record<string, string>>;
  /**
   * dependencies 字段。
   */
  readonly dependencies?: Readonly<Record<string, string>>;
  /**
   * devDependencies 字段。
   */
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/**
 * TypeScript 配置摘要。
 */
interface TypeScriptSummary {
  /**
   * 是否启用 TypeScript。
   */
  readonly enabled: boolean;
  /**
   * tsconfig 相对路径。
   */
  readonly configPath?: string;
  /**
   * TypeScript 版本。
   */
  readonly version?: string;
  /**
   * compilerOptions 配置。
   */
  readonly compilerOptions?: JsonValue;
}

/**
 * Vite 配置摘要。
 */
interface ViteSummary {
  /**
   * 是否检测到 Vite。
   */
  readonly detected: boolean;
  /**
   * Vite 配置文件相对路径。
   */
  readonly configPath?: string;
  /**
   * Vite 依赖版本。
   */
  readonly version?: string;
}

/**
 * pnpm workspace 摘要。
 */
interface PnpmWorkspaceSummary {
  /**
   * pnpm workspace 是否存在。
   */
  readonly exists: boolean;
  /**
   * pnpm workspace 相对路径。
   */
  readonly path?: string;
  /**
   * pnpm workspace 原始内容。
   */
  readonly content?: string;
}

/**
 * Git 信息摘要。
 */
interface GitSummary {
  /**
   * 是否是 Git 仓库。
   */
  readonly isRepository: boolean;
  /**
   * 当前分支。
   */
  readonly branch?: string;
  /**
   * 当前提交。
   */
  readonly commit?: string;
  /**
   * 远程地址。
   */
  readonly remote?: string;
  /**
   * 工作区是否有未提交修改。
   */
  readonly dirty?: boolean;
}

/**
 * project.json 内容。
 */
interface ProjectJson {
  /**
   * Veaw project.json 版本。
   */
  readonly version: string;
  /**
   * 生成时间。
   */
  readonly generatedAt: string;
  /**
   * 最近同步时间。
   */
  readonly syncedAt: string;
  /**
   * 项目根目录。
   */
  readonly root: string;
  /**
   * 项目名称。
   */
  readonly name: string;
  /**
   * 框架列表。
   */
  readonly frameworks: readonly string[];
  /**
   * 包管理器。
   */
  readonly packageManager: PackageManager;
  /**
   * Node.js 版本。
   */
  readonly nodeVersion: string;
  /**
   * package.json 摘要。
   */
  readonly packageJson: PackageJsonSummary;
  /**
   * TypeScript 摘要。
   */
  readonly typescript: TypeScriptSummary;
  /**
   * Vite 摘要。
   */
  readonly vite: ViteSummary;
  /**
   * pnpm workspace 摘要。
   */
  readonly pnpmWorkspace: PnpmWorkspaceSummary;
  /**
   * Git 摘要。
   */
  readonly git: GitSummary;
}

/**
 * sync 命令选项。
 */
interface SyncCommandOptions {
  /**
   * VEAW Workspace 路径。
   */
  readonly workspace?: string;
}

/**
 * 同步上下文。
 */
interface SyncContext {
  /**
   * 目标项目目录。
   */
  readonly targetDirectory: string;
  /**
   * .veaw 工作区目录。
   */
  readonly veawDirectory: string;
  /**
   * project.json 文件路径。
   */
  readonly projectJsonPath: string;
  /**
   * config.json 文件路径。
   */
  readonly configJsonPath: string;
}

/**
 * Workspace 配置写入输入。
 */
interface WorkspaceConfigInput {
  /**
   * 资源模式。
   */
  readonly resourceMode: 'workspace';
  /**
   * Workspace 路径。
   */
  readonly workspacePath: string;
  /**
   * Workspace 版本。
   */
  readonly workspaceVersion: string;
  /**
   * Registry schema 版本。
   */
  readonly registryVersion: string;
}

/**
 * 资源同步状态。
 */
type ResourceSyncStatus = 'new' | 'changed' | 'missing' | 'conflict';

/**
 * 资源同步摘要。
 */
interface ResourceSyncSummary {
  /**
   * 新增资源数量。
   */
  readonly newCount: number;
  /**
   * 变更资源数量。
   */
  readonly changedCount: number;
  /**
   * Registry 中缺失的旧资源数量。
   */
  readonly missingCount: number;
  /**
   * 冲突资源数量。
   */
  readonly conflictCount: number;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * project.json 版本。
 */
const PROJECT_JSON_VERSION = '0.1.0';

/**
 * Vite 配置文件候选。
 */
const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
] as const;

/**
 * pnpm workspace 文件候选。
 */
const PNPM_WORKSPACE_FILES = ['pnpm-workspace.yaml', 'pnpm-workspace.yml'] as const;

/**
 * 注册 sync 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Sync project metadata into .veaw/project.json.')
    .option('--workspace <path>', 'Use a VEAW Workspace directory.')
    .action(async (options: SyncCommandOptions): Promise<void> => {
      await runSyncCommand(options);
    });
}

/**
 * 执行 sync 命令。
 *
 * @param options sync 命令选项。
 */
export async function runSyncCommand(options: SyncCommandOptions = {}): Promise<void> {
  try {
    const context = await createSyncContext(process.cwd());
    const currentProjectJson = await readExistingProjectJson(context.projectJsonPath);
    const nextProjectJson = await createProjectJson(context);
    const mergedProjectJson = mergeProjectJson(currentProjectJson, nextProjectJson);

    await fs.outputJson(context.projectJsonPath, mergedProjectJson, {
      spaces: 2,
    });

    await syncWorkspaceResources(context, options);

    logger.success('项目信息同步完成');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`同步失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建同步上下文。
 *
 * @param targetDirectory 目标项目目录。
 * @returns 同步上下文。
 */
async function createSyncContext(targetDirectory: string): Promise<SyncContext> {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);

  if (!(await fs.pathExists(veawDirectory))) {
    throw new Error('未检测到 .veaw 工作区，请先执行 veaw init');
  }

  return {
    targetDirectory,
    veawDirectory,
    projectJsonPath: path.join(veawDirectory, 'project.json'),
    configJsonPath: path.join(veawDirectory, 'config.json'),
  };
}

/**
 * 同步 Workspace Registry 资源。
 *
 * @param context 同步上下文。
 * @param options sync 命令选项。
 */
async function syncWorkspaceResources(context: SyncContext, options: SyncCommandOptions): Promise<void> {
  const workspaceLocation = await discoverWorkspace({
    projectDirectory: context.targetDirectory,
    explicitWorkspacePath: options.workspace,
    environment: process.env,
  });

  if (workspaceLocation.kind !== 'workspace') {
    const currentConfig = await readOptionalJsonObject(context.configJsonPath);
    const configuredWorkspacePath = readString(currentConfig, 'workspacePath');
    const hint =
      configuredWorkspacePath === undefined
        ? '未发现可用的 Workspace Registry，已跳过资源同步。'
        : `配置的 Workspace 不可用：${configuredWorkspacePath}，已跳过资源同步。`;

    logger.warn(hint);
    return;
  }

  const registry = await readWorkspaceRegistry(workspaceLocation);
  const desiredResources = resolveEnabledResources(registry);
  const currentLockfile = await readResourceLockfile(context.targetDirectory);
  const summary = await materializeChangedResources(context, registry, desiredResources, currentLockfile);

  await writeWorkspaceConfig(context, {
    resourceMode: 'workspace',
    workspacePath: workspaceLocation.rootDirectory,
    workspaceVersion: registry.registry.workspaceVersion,
    registryVersion: registry.registry.schemaVersion,
  });

  logger.success(
    `资源同步完成：新增 ${summary.newCount}，变更 ${summary.changedCount}，缺失 ${summary.missingCount}，冲突 ${summary.conflictCount}`,
  );
}

/**
 * 解析默认启用资源及其依赖。
 *
 * @param registry 已加载 Registry。
 * @returns 默认启用资源闭包。
 */
function resolveEnabledResources(registry: LoadedWorkspaceRegistry): readonly WorkspaceResource[] {
  const resolver = new ResourceResolver(registry.resources);
  const enabledResourceIds = registry.resources
    .filter((resource) => resource.enabledByDefault)
    .map((resource) => resource.id);

  return resolver.resolveDependencies(enabledResourceIds);
}

/**
 * 物化新增或变更资源，并更新 lockfile。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param desiredResources Registry 期望资源。
 * @param currentLockfile 当前 lockfile。
 * @returns 资源同步摘要。
 */
async function materializeChangedResources(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  desiredResources: readonly WorkspaceResource[],
  currentLockfile: ResourceLockfile | undefined,
): Promise<ResourceSyncSummary> {
  const currentEntries = new Map(currentLockfile?.resources.map((entry) => [entry.id, entry]) ?? []);
  const desiredIds = new Set(desiredResources.map((resource) => resource.id));
  const nextEntries: ResourceLockEntry[] = [];
  const statuses: ResourceSyncStatus[] = [];

  for (const currentEntry of currentEntries.values()) {
    if (!desiredIds.has(currentEntry.id)) {
      statuses.push('missing');
    }
  }

  for (const resource of desiredResources) {
    const currentEntry = currentEntries.get(resource.id);
    const status = getResourceStatus(resource, currentEntry);

    if (status !== undefined) {
      statuses.push(status);
    }

    if (await hasResourceConflict(context.targetDirectory, resource, currentEntry, status)) {
      statuses.push('conflict');

      if (currentEntry !== undefined) {
        nextEntries.push(currentEntry);
      }

      continue;
    }

    const nextEntry = await materializeResourceIfNeeded(context, registry, resource, currentEntry, status);

    if (nextEntry !== undefined) {
      nextEntries.push(nextEntry);
    }
  }

  await writeResourceLockfileIfChanged(
    context.targetDirectory,
    createLockfileWithEntries(registry.registry.workspaceVersion, currentLockfile, nextEntries),
    currentLockfile,
  );

  return countResourceStatuses(statuses);
}

/**
 * 判断资源状态。
 *
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @returns 资源状态。
 */
function getResourceStatus(
  resource: WorkspaceResource,
  currentEntry: ResourceLockEntry | undefined,
): Exclude<ResourceSyncStatus, 'missing' | 'conflict'> | undefined {
  if (currentEntry === undefined) {
    return 'new';
  }

  return isLockEntryChanged(resource, currentEntry) ? 'changed' : undefined;
}

/**
 * 判断 lockfile 条目是否和 Registry 资源不一致。
 *
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @returns 是否变化。
 */
function isLockEntryChanged(resource: WorkspaceResource, currentEntry: ResourceLockEntry): boolean {
  return (
    currentEntry.type !== resource.type ||
    currentEntry.version !== resource.version ||
    currentEntry.sourcePath !== resource.sourcePath ||
    currentEntry.targetPath !== resource.targetPath ||
    currentEntry.hash !== resource.hash
  );
}

/**
 * 判断资源是否存在用户内容冲突。
 *
 * @param projectDirectory 项目根目录。
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @param status 资源状态。
 * @returns 是否冲突。
 */
async function hasResourceConflict(
  projectDirectory: string,
  resource: WorkspaceResource,
  currentEntry: ResourceLockEntry | undefined,
  status: Exclude<ResourceSyncStatus, 'missing' | 'conflict'> | undefined,
): Promise<boolean> {
  if (status === undefined || resource.copyPolicy === 'reference' || resource.copyPolicy === 'none') {
    return false;
  }

  if (resource.overwritePolicy === 'always' || resource.overwritePolicy === 'managed-block') {
    return false;
  }

  const targetPath = path.join(projectDirectory, resource.targetPath);

  if (!(await fs.pathExists(targetPath))) {
    return false;
  }

  if (currentEntry === undefined) {
    return true;
  }

  const targetHash = await hashFile(targetPath);

  return targetHash !== currentEntry.hash;
}

/**
 * 按需物化资源。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @param status 资源状态。
 * @returns 下一个 lockfile 条目。
 */
async function materializeResourceIfNeeded(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  resource: WorkspaceResource,
  currentEntry: ResourceLockEntry | undefined,
  status: Exclude<ResourceSyncStatus, 'missing' | 'conflict'> | undefined,
): Promise<ResourceLockEntry | undefined> {
  if (status === undefined) {
    return createResourceLockEntry(resource);
  }

  if (resource.copyPolicy === 'reference' || resource.copyPolicy === 'none') {
    return createResourceLockEntry(resource);
  }

  const result = await materializeResource({
    workspaceDirectory: registry.location.rootDirectory,
    projectDirectory: context.targetDirectory,
    resource,
  });

  if (result.action === 'copied' || result.action === 'rendered') {
    logger.success(`${result.action === 'copied' ? '创建' : '生成'} ${toDisplayPath(result.targetPath)}`);
    return createResourceLockEntry(resource);
  }

  if (currentEntry !== undefined) {
    logger.warn(`保留 ${resource.id}：Registry 已变化，但 overwritePolicy=${resource.overwritePolicy} 未允许覆盖`);
    return currentEntry;
  }

  logger.warn(`跳过 ${resource.id}：目标文件已存在且 overwritePolicy=${resource.overwritePolicy}`);
  return undefined;
}

/**
 * 创建资源 lockfile 条目。
 *
 * @param resource Workspace 资源。
 * @returns lockfile 条目。
 */
function createResourceLockEntry(resource: WorkspaceResource): ResourceLockEntry {
  return {
    id: resource.id,
    type: resource.type,
    version: resource.version,
    sourcePath: resource.sourcePath,
    targetPath: resource.targetPath,
    hash: resource.hash,
  };
}

/**
 * 创建带指定条目的 lockfile。
 *
 * @param workspaceVersion Workspace 版本。
 * @param currentLockfile 当前 lockfile。
 * @param entries lockfile 条目。
 * @returns lockfile。
 */
function createLockfileWithEntries(
  workspaceVersion: string,
  currentLockfile: ResourceLockfile | undefined,
  entries: readonly ResourceLockEntry[],
): ResourceLockfile {
  const nextLockfile = createResourceLockfile(workspaceVersion, []);

  return {
    ...nextLockfile,
    generatedAt: shouldKeepLockfileTimestamp(currentLockfile, workspaceVersion, entries)
      ? currentLockfile.generatedAt
      : nextLockfile.generatedAt,
    resources: entries,
  };
}

/**
 * 判断是否保留 lockfile 时间戳。
 *
 * @param currentLockfile 当前 lockfile。
 * @param workspaceVersion Workspace 版本。
 * @param entries 下一个资源条目。
 * @returns 是否保留。
 */
function shouldKeepLockfileTimestamp(
  currentLockfile: ResourceLockfile | undefined,
  workspaceVersion: string,
  entries: readonly ResourceLockEntry[],
): currentLockfile is ResourceLockfile {
  return (
    currentLockfile !== undefined &&
    currentLockfile.workspaceVersion === workspaceVersion &&
    JSON.stringify(currentLockfile.resources) === JSON.stringify(entries)
  );
}

/**
 * lockfile 变化时写入。
 *
 * @param projectDirectory 项目根目录。
 * @param nextLockfile 下一个 lockfile。
 * @param currentLockfile 当前 lockfile。
 */
async function writeResourceLockfileIfChanged(
  projectDirectory: string,
  nextLockfile: ResourceLockfile,
  currentLockfile: ResourceLockfile | undefined,
): Promise<void> {
  if (
    currentLockfile !== undefined &&
    currentLockfile.schemaVersion === nextLockfile.schemaVersion &&
    currentLockfile.workspaceVersion === nextLockfile.workspaceVersion &&
    currentLockfile.generatedAt === nextLockfile.generatedAt &&
    JSON.stringify(currentLockfile.resources) === JSON.stringify(nextLockfile.resources)
  ) {
    logger.success(`保留 ${toDisplayPath(path.join(projectDirectory, VEAW_DIRECTORY_NAME, 'resources.lock.json'))}`);
    return;
  }

  await writeResourceLockfile(projectDirectory, nextLockfile);
  logger.success(`更新 ${toDisplayPath(path.join(projectDirectory, VEAW_DIRECTORY_NAME, 'resources.lock.json'))}`);
}

/**
 * 统计资源状态。
 *
 * @param statuses 资源状态列表。
 * @returns 资源同步摘要。
 */
function countResourceStatuses(statuses: readonly ResourceSyncStatus[]): ResourceSyncSummary {
  return {
    newCount: countStatus(statuses, 'new'),
    changedCount: countStatus(statuses, 'changed'),
    missingCount: countStatus(statuses, 'missing'),
    conflictCount: countStatus(statuses, 'conflict'),
  };
}

/**
 * 统计指定状态数量。
 *
 * @param statuses 资源状态列表。
 * @param status 目标状态。
 * @returns 状态数量。
 */
function countStatus(statuses: readonly ResourceSyncStatus[], status: ResourceSyncStatus): number {
  return statuses.filter((item) => item === status).length;
}

/**
 * 写入 Workspace 配置。
 *
 * @param context 同步上下文。
 * @param input Workspace 配置输入。
 */
async function writeWorkspaceConfig(context: SyncContext, input: WorkspaceConfigInput): Promise<void> {
  const currentConfig = await readOptionalJsonObject(context.configJsonPath);
  const nextConfig = mergeJsonObjects(currentConfig, createWorkspaceConfigJson(input));

  await writeJsonIfChanged(context.configJsonPath, nextConfig);
}

/**
 * 创建 Workspace 配置 JSON。
 *
 * @param input Workspace 配置输入。
 * @returns Workspace 配置 JSON。
 */
function createWorkspaceConfigJson(input: WorkspaceConfigInput): JsonObject {
  return {
    version: PROJECT_JSON_VERSION,
    resourceMode: input.resourceMode,
    workspacePath: input.workspacePath,
    workspaceVersion: input.workspaceVersion,
    registryVersion: input.registryVersion,
  };
}

/**
 * 读取已有 project.json。
 *
 * @param projectJsonPath project.json 路径。
 * @returns 已有 project.json 对象。
 */
async function readExistingProjectJson(projectJsonPath: string): Promise<JsonObject> {
  if (!(await fs.pathExists(projectJsonPath))) {
    return {};
  }

  const content = await readJsonFile(projectJsonPath);

  if (!isRecord(content)) {
    throw new Error('.veaw/project.json 不是有效的 JSON 对象');
  }

  return sanitizeJsonObject(content);
}

/**
 * 合并 project.json，保留用户自定义字段。
 *
 * @param currentProjectJson 当前 project.json。
 * @param nextProjectJson 最新项目画像。
 * @returns 合并后的 project.json。
 */
function mergeProjectJson(currentProjectJson: JsonObject, nextProjectJson: ProjectJson): JsonObject {
  const nextJson = toJsonObject(nextProjectJson);

  return mergeJsonObjects(currentProjectJson, nextJson);
}

/**
 * 深度合并 JSON 对象。
 *
 * @param current 当前对象。
 * @param next 最新对象。
 * @returns 合并后的对象。
 */
function mergeJsonObjects(current: Readonly<Record<string, JsonValue>>, next: Readonly<Record<string, JsonValue>>): JsonObject {
  const result: JsonObject = {
    ...current,
  };

  for (const [key, nextValue] of Object.entries(next)) {
    const currentValue = result[key];

    if (isJsonObject(currentValue) && isJsonObject(nextValue)) {
      result[key] = mergeJsonObjects(currentValue, nextValue);
      continue;
    }

    result[key] = nextValue;
  }

  return result;
}

/**
 * 创建 project.json 内容。
 *
 * @param context 同步上下文。
 * @returns project.json 内容。
 */
async function createProjectJson(context: SyncContext): Promise<ProjectJson> {
  const packageJson = await readPackageJsonSummary(context.targetDirectory);
  const dependencies = mergeDependencyRecords(packageJson.dependencies, packageJson.devDependencies);
  const typescript = await readTypeScriptSummary(context.targetDirectory, dependencies);
  const vite = await readViteSummary(context.targetDirectory, dependencies);
  const pnpmWorkspace = await readPnpmWorkspaceSummary(context.targetDirectory);
  const now = new Date().toISOString();

  return {
    version: PROJECT_JSON_VERSION,
    generatedAt: now,
    syncedAt: now,
    root: context.targetDirectory,
    name: packageJson.name ?? path.basename(context.targetDirectory),
    frameworks: detectFrameworks(dependencies, vite),
    packageManager: await detectPackageManager(context.targetDirectory, packageJson.packageManager),
    nodeVersion: process.version,
    packageJson,
    typescript,
    vite,
    pnpmWorkspace,
    git: await readGitSummary(context.targetDirectory),
  };
}

/**
 * 读取 package.json 摘要。
 *
 * @param targetDirectory 目标项目目录。
 * @returns package.json 摘要。
 */
async function readPackageJsonSummary(targetDirectory: string): Promise<PackageJsonSummary> {
  const packageJsonPath = path.join(targetDirectory, 'package.json');

  if (!(await fs.pathExists(packageJsonPath))) {
    return {
      exists: false,
    };
  }

  const content = await readJsonFile(packageJsonPath);

  if (!isRecord(content)) {
    return {
      exists: true,
      path: 'package.json',
    };
  }

  return {
    exists: true,
    path: 'package.json',
    name: readString(content, 'name'),
    version: readString(content, 'version'),
    type: readString(content, 'type'),
    packageManager: readString(content, 'packageManager'),
    scripts: readStringRecord(content, 'scripts'),
    dependencies: readStringRecord(content, 'dependencies'),
    devDependencies: readStringRecord(content, 'devDependencies'),
  };
}

/**
 * 读取 TypeScript 摘要。
 *
 * @param targetDirectory 目标项目目录。
 * @param dependencies 依赖集合。
 * @returns TypeScript 摘要。
 */
async function readTypeScriptSummary(
  targetDirectory: string,
  dependencies: Readonly<Record<string, string>>,
): Promise<TypeScriptSummary> {
  const tsconfigPath = path.join(targetDirectory, 'tsconfig.json');
  const typescriptVersion = dependencies.typescript;

  if (!(await fs.pathExists(tsconfigPath))) {
    return {
      enabled: typescriptVersion !== undefined,
      version: typescriptVersion,
    };
  }

  const content = await readJsonFile(tsconfigPath);
  const compilerOptions = isRecord(content) ? sanitizeJsonValue(content.compilerOptions) : undefined;

  return {
    enabled: true,
    configPath: 'tsconfig.json',
    version: typescriptVersion,
    compilerOptions,
  };
}

/**
 * 读取 Vite 摘要。
 *
 * @param targetDirectory 目标项目目录。
 * @param dependencies 依赖集合。
 * @returns Vite 摘要。
 */
async function readViteSummary(
  targetDirectory: string,
  dependencies: Readonly<Record<string, string>>,
): Promise<ViteSummary> {
  const configPath = await findFirstExistingFile(targetDirectory, VITE_CONFIG_FILES);
  const viteVersion = dependencies.vite;

  return {
    detected: configPath !== undefined || viteVersion !== undefined,
    configPath,
    version: viteVersion,
  };
}

/**
 * 读取 pnpm workspace 摘要。
 *
 * @param targetDirectory 目标项目目录。
 * @returns pnpm workspace 摘要。
 */
async function readPnpmWorkspaceSummary(targetDirectory: string): Promise<PnpmWorkspaceSummary> {
  const workspacePath = await findFirstExistingFile(targetDirectory, PNPM_WORKSPACE_FILES);

  if (workspacePath === undefined) {
    return {
      exists: false,
    };
  }

  return {
    exists: true,
    path: workspacePath,
    content: await fs.readFile(path.join(targetDirectory, workspacePath), 'utf8'),
  };
}

/**
 * 读取 Git 摘要。
 *
 * @param targetDirectory 目标项目目录。
 * @returns Git 摘要。
 */
async function readGitSummary(targetDirectory: string): Promise<GitSummary> {
  const isRepository = await runGitCommand(targetDirectory, ['rev-parse', '--is-inside-work-tree']);

  if (isRepository !== 'true') {
    return {
      isRepository: false,
    };
  }

  const status = await runGitCommand(targetDirectory, ['status', '--short']);

  return {
    isRepository: true,
    branch: await runGitCommand(targetDirectory, ['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: await runGitCommand(targetDirectory, ['rev-parse', 'HEAD']),
    remote: await runGitCommand(targetDirectory, ['config', '--get', 'remote.origin.url']),
    dirty: status !== undefined && status.length > 0,
  };
}

/**
 * 执行 Git 命令。
 *
 * @param cwd 工作目录。
 * @param args Git 参数。
 * @returns 命令输出。
 */
async function runGitCommand(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execa('git', args, {
      cwd,
    });

    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * 检测包管理器。
 *
 * @param targetDirectory 目标项目目录。
 * @param packageManagerField package.json 中的 packageManager 字段。
 * @returns 包管理器。
 */
async function detectPackageManager(
  targetDirectory: string,
  packageManagerField: string | undefined,
): Promise<PackageManager> {
  if (packageManagerField?.startsWith('pnpm@') === true) {
    return 'pnpm';
  }

  if (packageManagerField?.startsWith('npm@') === true) {
    return 'npm';
  }

  if (packageManagerField?.startsWith('yarn@') === true) {
    return 'yarn';
  }

  if (packageManagerField?.startsWith('bun@') === true) {
    return 'bun';
  }

  if (await fs.pathExists(path.join(targetDirectory, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (await fs.pathExists(path.join(targetDirectory, 'package-lock.json'))) {
    return 'npm';
  }

  if (await fs.pathExists(path.join(targetDirectory, 'yarn.lock'))) {
    return 'yarn';
  }

  if (
    (await fs.pathExists(path.join(targetDirectory, 'bun.lock'))) ||
    (await fs.pathExists(path.join(targetDirectory, 'bun.lockb')))
  ) {
    return 'bun';
  }

  return 'unknown';
}

/**
 * 检测框架。
 *
 * @param dependencies 依赖集合。
 * @param vite Vite 摘要。
 * @returns 框架列表。
 */
function detectFrameworks(dependencies: Readonly<Record<string, string>>, vite: ViteSummary): readonly string[] {
  const frameworks: string[] = [];

  addFrameworkIfDependencyExists(frameworks, dependencies, 'next', 'Next.js');
  addFrameworkIfDependencyExists(frameworks, dependencies, 'vue', 'Vue');
  addFrameworkIfDependencyExists(frameworks, dependencies, 'react', 'React');

  if (vite.detected) {
    frameworks.push('Vite');
  }

  if (hasAnyDependency(dependencies, ['express', 'fastify', 'koa', '@nestjs/core'])) {
    frameworks.push('Node');
  }

  return frameworks.length > 0 ? frameworks : ['Unknown'];
}

/**
 * 依赖存在时添加框架。
 *
 * @param frameworks 框架列表。
 * @param dependencies 依赖集合。
 * @param dependencyName 依赖名称。
 * @param frameworkName 框架名称。
 */
function addFrameworkIfDependencyExists(
  frameworks: string[],
  dependencies: Readonly<Record<string, string>>,
  dependencyName: string,
  frameworkName: string,
): void {
  if (dependencies[dependencyName] !== undefined) {
    frameworks.push(frameworkName);
  }
}

/**
 * 判断是否存在任一依赖。
 *
 * @param dependencies 依赖集合。
 * @param dependencyNames 依赖名称列表。
 * @returns 是否存在任一依赖。
 */
function hasAnyDependency(dependencies: Readonly<Record<string, string>>, dependencyNames: readonly string[]): boolean {
  return dependencyNames.some((dependencyName) => dependencies[dependencyName] !== undefined);
}

/**
 * 合并依赖集合。
 *
 * @param dependencies dependencies 字段。
 * @param devDependencies devDependencies 字段。
 * @returns 合并后的依赖集合。
 */
function mergeDependencyRecords(
  dependencies: Readonly<Record<string, string>> | undefined,
  devDependencies: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return {
    ...(dependencies ?? {}),
    ...(devDependencies ?? {}),
  };
}

/**
 * 查找第一个存在的文件。
 *
 * @param targetDirectory 目标项目目录。
 * @param fileNames 文件名列表。
 * @returns 已存在文件的相对路径。
 */
async function findFirstExistingFile(
  targetDirectory: string,
  fileNames: readonly string[],
): Promise<string | undefined> {
  for (const fileName of fileNames) {
    if (await fs.pathExists(path.join(targetDirectory, fileName))) {
      return fileName;
    }
  }

  return undefined;
}

/**
 * 读取 JSON 文件。
 *
 * @param filePath 文件路径。
 * @returns JSON 内容。
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
}

/**
 * 读取可选 JSON 对象。
 *
 * @param filePath 文件路径。
 * @returns JSON 对象。
 */
async function readOptionalJsonObject(filePath: string): Promise<JsonObject> {
  if (!(await fs.pathExists(filePath))) {
    return {};
  }

  const content = await readJsonFile(filePath);

  if (!isRecord(content)) {
    return {};
  }

  return sanitizeJsonObject(content);
}

/**
 * JSON 内容变化时写入。
 *
 * @param filePath 文件路径。
 * @param data JSON 数据。
 */
async function writeJsonIfChanged(filePath: string, data: JsonObject): Promise<void> {
  if (await fs.pathExists(filePath)) {
    const currentContent = await readJsonFile(filePath);
    const currentJson = isRecord(currentContent) ? sanitizeJsonObject(currentContent) : {};

    if (JSON.stringify(currentJson) === JSON.stringify(data)) {
      logger.success(`保留 ${toDisplayPath(filePath)}`);
      return;
    }
  }

  await fs.outputJson(filePath, data, {
    spaces: 2,
  });
  logger.success(`更新 ${toDisplayPath(filePath)}`);
}

/**
 * 计算文件 SHA-256。
 *
 * @param filePath 文件路径。
 * @returns hash 字符串。
 */
async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);

  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * 将对象转成 JSON 对象。
 *
 * @param value 待转换值。
 * @returns JSON 对象。
 */
function toJsonObject(value: unknown): JsonObject {
  const sanitizedValue = sanitizeJsonValue(value);

  if (!isJsonObject(sanitizedValue)) {
    return {};
  }

  return sanitizedValue;
}

/**
 * 清洗 JSON 对象。
 *
 * @param record 对象记录。
 * @returns JSON 对象。
 */
function sanitizeJsonObject(record: Readonly<Record<string, unknown>>): JsonObject {
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(record)) {
    const sanitizedValue = sanitizeJsonValue(value);

    if (sanitizedValue !== undefined) {
      result[key] = sanitizedValue;
    }
  }

  return result;
}

/**
 * 将 unknown 转成可序列化 JSON 值。
 *
 * @param value 待转换值。
 * @returns JSON 值。
 */
function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item) ?? null);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return sanitizeJsonObject(value);
}

/**
 * 判断值是否是对象记录。
 *
 * @param value 待判断值。
 * @returns 是否是对象记录。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断值是否是 JSON 对象。
 *
 * @param value 待判断值。
 * @returns 是否是 JSON 对象。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

/**
 * 读取字符串属性。
 *
 * @param record 对象记录。
 * @param key 属性名。
 * @returns 字符串属性值。
 */
function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * 读取字符串记录属性。
 *
 * @param record 对象记录。
 * @param key 属性名。
 * @returns 字符串记录属性值。
 */
function readStringRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> | undefined {
  const value = record[key];

  if (!isRecord(value)) {
    return undefined;
  }

  const result: Record<string, string> = {};

  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === 'string') {
      result[entryKey] = entryValue;
    }
  }

  return result;
}

/**
 * 转为便于展示的路径。
 *
 * @param targetPath 目标路径。
 * @returns 展示路径。
 */
function toDisplayPath(targetPath: string): string {
  return path.relative(process.cwd(), targetPath) || '.';
}
