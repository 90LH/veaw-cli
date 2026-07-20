import path from 'node:path';
import { Command } from 'commander';
import { execa } from 'execa';
import fs from 'fs-extra';
import {
  ResourceResolver,
  createProjectProfileFromProjectJson,
  createResourceLockfile,
  discoverWorkspace,
  hashFile,
  hashText,
  materializeResource,
  readResourceLockfile,
  readWorkspaceRegistry,
  renderTemplate,
  writeResourceLockfile,
} from '../resource-loader/index.js';
import type {
  LoadedWorkspaceRegistry,
  ResourceLockEntry,
  ResourceLockStatus,
  ResourceLockfile,
  ResourceOverwritePolicy,
  WorkspaceResource,
} from '../resource-loader/index.js';
import { logger } from '../utils/logger.js';
import { inspectProjectInsights } from '../utils/project-inspector.js';
import type { ProjectInsightSummary } from '../utils/project-inspector.js';

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
   * 项目关键结构洞察。
   */
  readonly projectInsights: ProjectInsightSummary;
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
  /**
   * 首次资源同步时写入 resources.lock.json 并应用安全变更。
   */
  readonly writeLockfile?: boolean;
  /**
   * 仅扫描和报告，不写入资源或 lockfile。
   */
  readonly dryRun?: boolean;
}

/**
 * 资源同步执行结果。
 */
interface ResourceSyncResult {
  /**
   * 是否允许写入 project.json。
   */
  readonly shouldWriteProjectJson: boolean;
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
 * 资源同步摘要。
 */
interface ResourceSyncSummary {
  /**
   * 已安装资源数量。
   */
  readonly installedCount: number;
  /**
   * 用户修改资源数量。
   */
  readonly modifiedCount: number;
  /**
   * 缺失资源数量。
   */
  readonly missingCount: number;
  /**
   * 冲突资源数量。
   */
  readonly conflictCount: number;
  /**
   * 跳过资源数量。
   */
  readonly skippedCount: number;
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
    .option('--write-lockfile', 'Deprecated: resources.lock.json is written by default unless --dry-run is used.')
    .option('--dry-run', 'Scan resources and report without writing resource files or lockfile.')
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
    const resourceSyncResult = await syncWorkspaceResources(context, options);

    if (resourceSyncResult.shouldWriteProjectJson && options.dryRun !== true) {
      const currentProjectJson = await readExistingProjectJson(context.projectJsonPath);
      const nextProjectJson = await createProjectJson(context);
      const mergedProjectJson = mergeProjectJson(currentProjectJson, nextProjectJson);

      await fs.outputJson(context.projectJsonPath, mergedProjectJson, {
        spaces: 2,
      });
    }

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
async function syncWorkspaceResources(context: SyncContext, options: SyncCommandOptions): Promise<ResourceSyncResult> {
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
    return {
      shouldWriteProjectJson: true,
    };
  }

  const registry = await readWorkspaceRegistry(workspaceLocation);
  const desiredResources = await resolveEnabledResources(context, registry);
  const currentLockfile = await readResourceLockfile(context.targetDirectory);

  if (currentLockfile === undefined) {
    return syncFirstWorkspaceResources(context, registry, desiredResources, options);
  }

  if (options.dryRun === true) {
    const summary = await inspectChangedResources(context, desiredResources, currentLockfile);

    logger.warn('--dry-run 已启用，跳过写入资源、config.json、resources.lock.json 和 project.json。');
    logger.success(
      `资源同步预览：将安装 ${summary.installedCount}，已修改 ${summary.modifiedCount}，缺失 ${summary.missingCount}，冲突 ${summary.conflictCount}，跳过 ${summary.skippedCount}`,
    );

    return {
      shouldWriteProjectJson: false,
    };
  }

  const summary = await materializeChangedResources(context, registry, desiredResources, currentLockfile);

  await writeWorkspaceConfig(context, {
    resourceMode: 'workspace',
    workspacePath: workspaceLocation.rootDirectory,
    workspaceVersion: registry.registry.workspaceVersion,
    registryVersion: registry.registry.schemaVersion,
  });

  logger.success(
    `资源同步完成：已安装 ${summary.installedCount}，已修改 ${summary.modifiedCount}，缺失 ${summary.missingCount}，冲突 ${summary.conflictCount}，跳过 ${summary.skippedCount}`,
  );

  return {
    shouldWriteProjectJson: true,
  };
}

/**
 * 解析默认启用资源及其依赖。
 *
 * @param registry 已加载 Registry。
 * @returns 默认启用资源闭包。
 */
async function resolveEnabledResources(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
): Promise<readonly WorkspaceResource[]> {
  const resolver = new ResourceResolver(registry.resources);
  const projectJson = await readExistingProjectJson(context.projectJsonPath);
  const profile = createProjectProfileFromProjectJson(projectJson);

  return resolver.resolveSelection({
    profile,
  }).resources;
}

/**
 * 首次资源同步分类。
 */
type FirstSyncClassification = 'safe-install' | 'needs-adoption' | 'conflict' | 'unknown';

/**
 * 首次资源同步候选。
 */
interface FirstSyncCandidate {
  /**
   * Workspace 资源。
   */
  readonly resource: WorkspaceResource;
  /**
   * 资源分类。
   */
  readonly classification: FirstSyncClassification;
  /**
   * 目标文件路径。
   */
  readonly targetPath?: string;
  /**
   * 当前目标 hash。
   */
  readonly targetHash?: string;
  /**
   * 预期物化内容 hash。
   */
  readonly expectedTargetHash?: string;
  /**
   * 无法判断原因。
   */
  readonly reason?: string;
}

/**
 * 首次资源同步摘要。
 */
interface FirstSyncSummary {
  /**
   * 可安全安装数量。
   */
  readonly safeInstallCount: number;
  /**
   * 需要认领数量。
   */
  readonly needsAdoptionCount: number;
  /**
   * 用户文件冲突数量。
   */
  readonly conflictCount: number;
  /**
   * 无法判断数量。
   */
  readonly unknownCount: number;
}

/**
 * 首次同步 Workspace 资源。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param desiredResources Registry 期望资源。
 * @param options sync 命令选项。
 * @returns 资源同步结果。
 */
async function syncFirstWorkspaceResources(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  desiredResources: readonly WorkspaceResource[],
  options: SyncCommandOptions,
): Promise<ResourceSyncResult> {
  const candidates = await scanFirstSyncCandidates(context, registry, desiredResources);
  const summary = countFirstSyncCandidates(candidates);
  const shouldApply = options.dryRun !== true;

  logger.warn(
    `首次资源同步扫描：可安全安装 ${summary.safeInstallCount}，需要认领 ${summary.needsAdoptionCount}，冲突 ${summary.conflictCount}，无法判断 ${summary.unknownCount}`,
  );

  if (!shouldApply) {
    logger.warn('--dry-run 已启用，跳过写入资源、config.json、resources.lock.json 和 project.json。');

    return {
      shouldWriteProjectJson: false,
    };
  }

  await applyFirstSyncCandidates(context, registry, candidates);
  await writeWorkspaceConfig(context, {
    resourceMode: 'workspace',
    workspacePath: registry.location.rootDirectory,
    workspaceVersion: registry.registry.workspaceVersion,
    registryVersion: registry.registry.schemaVersion,
  });

  return {
    shouldWriteProjectJson: true,
  };
}

/**
 * 扫描首次同步候选资源。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param desiredResources Registry 期望资源。
 * @returns 首次同步候选列表。
 */
async function scanFirstSyncCandidates(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  desiredResources: readonly WorkspaceResource[],
): Promise<readonly FirstSyncCandidate[]> {
  const candidates: FirstSyncCandidate[] = [];

  for (const resource of desiredResources) {
    candidates.push(await scanFirstSyncCandidate(context, registry, resource));
  }

  return candidates;
}

/**
 * 扫描单个首次同步候选资源。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param resource Workspace 资源。
 * @returns 首次同步候选。
 */
async function scanFirstSyncCandidate(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  resource: WorkspaceResource,
): Promise<FirstSyncCandidate> {
  const targetPath = resolveContainedPath(context.targetDirectory, resource.targetPath);
  const sourcePath = resolveContainedPath(registry.location.rootDirectory, resource.sourcePath);

  if (targetPath === undefined) {
    return createUnknownFirstSyncCandidate(resource, 'targetPath is outside the project directory');
  }

  if (sourcePath === undefined) {
    return createUnknownFirstSyncCandidate(resource, 'sourcePath is outside the Workspace directory');
  }

  if (resource.copyPolicy !== 'copy' && resource.copyPolicy !== 'render') {
    return createUnknownFirstSyncCandidate(resource, `copyPolicy=${resource.copyPolicy} cannot be compared`);
  }

  const expectedTargetHash = await readExpectedTargetHash(sourcePath, resource);

  if (!(await fs.pathExists(targetPath))) {
    return {
      resource,
      classification: 'safe-install',
      targetPath,
      expectedTargetHash,
    };
  }

  const targetHash = await hashFile(targetPath);

  return {
    resource,
    classification: targetHash === expectedTargetHash ? 'needs-adoption' : 'conflict',
    targetPath,
    targetHash,
    expectedTargetHash,
  };
}

/**
 * 创建无法判断候选。
 *
 * @param resource Workspace 资源。
 * @param reason 原因。
 * @returns 首次同步候选。
 */
function createUnknownFirstSyncCandidate(resource: WorkspaceResource, reason: string): FirstSyncCandidate {
  return {
    resource,
    classification: 'unknown',
    reason,
  };
}

/**
 * 读取资源预期目标 hash。
 *
 * @param sourcePath 源文件路径。
 * @param resource Workspace 资源。
 * @returns 预期目标 hash。
 */
async function readExpectedTargetHash(sourcePath: string, resource: WorkspaceResource): Promise<string> {
  if (resource.copyPolicy === 'copy') {
    return resource.hash;
  }

  const content = await fs.readFile(sourcePath, 'utf8');

  return hashText(renderTemplate(content, {}));
}

/**
 * 解析并限制路径在根目录内。
 *
 * @param rootDirectory 根目录。
 * @param relativePath 相对路径。
 * @returns 安全路径。
 */
function resolveContainedPath(rootDirectory: string, relativePath: string): string | undefined {
  const rootPath = path.resolve(rootDirectory);
  const targetPath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, targetPath);

  if (relativeToRoot.length === 0 || (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot))) {
    return targetPath;
  }

  return undefined;
}

/**
 * 应用首次同步候选。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param candidates 首次同步候选。
 */
async function applyFirstSyncCandidates(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  candidates: readonly FirstSyncCandidate[],
): Promise<void> {
  const entries: ResourceLockEntry[] = [];

  for (const candidate of candidates) {
    const entry = await applyFirstSyncCandidate(context, registry, candidate);

    if (entry !== undefined) {
      entries.push(entry);
    }
  }

  await writeResourceLockfile(
    context.targetDirectory,
    createLockfileWithEntries(registry.registry.workspaceVersion, undefined, entries),
  );
  logger.success(`创建 ${toDisplayPath(path.join(context.veawDirectory, 'resources.lock.json'))}`);
}

/**
 * 应用单个首次同步候选。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param candidate 首次同步候选。
 * @returns lockfile 条目。
 */
async function applyFirstSyncCandidate(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  candidate: FirstSyncCandidate,
): Promise<ResourceLockEntry | undefined> {
  if (candidate.classification === 'safe-install') {
    return installFirstSyncCandidate(context, registry, candidate);
  }

  if (candidate.classification === 'needs-adoption') {
    logger.success(`认领 ${candidate.resource.id}`);
    return createResourceLockEntry(candidate.resource, undefined, candidate.targetHash, 'installed');
  }

  if (candidate.classification === 'conflict') {
    return applyFirstSyncConflict(context, registry, candidate);
  }

  logger.warn(`跳过 ${candidate.resource.id}：${candidate.reason ?? '无法判断'}`);
  return createResourceLockEntry(candidate.resource, undefined, candidate.targetHash, 'skipped');
}

/**
 * 安装首次同步安全候选。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param candidate 首次同步候选。
 * @returns lockfile 条目。
 */
async function installFirstSyncCandidate(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  candidate: FirstSyncCandidate,
): Promise<ResourceLockEntry> {
  const result = await materializeResource({
    workspaceDirectory: registry.location.rootDirectory,
    projectDirectory: context.targetDirectory,
    resource: candidate.resource,
  });

  const targetHash =
    result.targetPath !== undefined && (await fs.pathExists(result.targetPath))
      ? await hashFile(result.targetPath)
      : candidate.targetHash;

  if (result.action === 'copied' || result.action === 'rendered') {
    logger.success(`${result.action === 'copied' ? '创建' : '生成'} ${toDisplayPath(result.targetPath)}`);
    return createResourceLockEntry(candidate.resource, undefined, targetHash, 'installed');
  }

  return createResourceLockEntry(candidate.resource, undefined, targetHash, 'skipped');
}

/**
 * 应用首次同步冲突候选。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param candidate 首次同步候选。
 * @returns lockfile 条目。
 */
async function applyFirstSyncConflict(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  candidate: FirstSyncCandidate,
): Promise<ResourceLockEntry> {
  if (candidate.resource.overwritePolicy !== 'always' && candidate.resource.overwritePolicy !== 'managed-block') {
    logger.warn(`保留 ${candidate.resource.id}：项目文件与 Workspace 内容不同`);
    return createResourceLockEntry(candidate.resource, undefined, candidate.targetHash, 'conflict');
  }

  const result = await materializeResource({
    workspaceDirectory: registry.location.rootDirectory,
    projectDirectory: context.targetDirectory,
    resource: candidate.resource,
  });
  const targetHash = (await fs.pathExists(result.targetPath)) ? await hashFile(result.targetPath) : candidate.targetHash;

  return createResourceLockEntry(candidate.resource, undefined, targetHash, targetHash === undefined ? 'missing' : 'installed');
}

/**
 * 统计首次同步候选。
 *
 * @param candidates 首次同步候选。
 * @returns 首次同步摘要。
 */
function countFirstSyncCandidates(candidates: readonly FirstSyncCandidate[]): FirstSyncSummary {
  return {
    safeInstallCount: countFirstSyncClassification(candidates, 'safe-install'),
    needsAdoptionCount: countFirstSyncClassification(candidates, 'needs-adoption'),
    conflictCount: countFirstSyncClassification(candidates, 'conflict'),
    unknownCount: countFirstSyncClassification(candidates, 'unknown'),
  };
}

/**
 * 统计指定首次同步分类数量。
 *
 * @param candidates 首次同步候选。
 * @param classification 目标分类。
 * @returns 数量。
 */
function countFirstSyncClassification(
  candidates: readonly FirstSyncCandidate[],
  classification: FirstSyncClassification,
): number {
  return candidates.filter((candidate) => candidate.classification === classification).length;
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
  const statuses: ResourceLockStatus[] = [];

  for (const currentEntry of currentEntries.values()) {
    if (!desiredIds.has(currentEntry.id)) {
      statuses.push('missing');
    }
  }

  for (const resource of desiredResources) {
    const currentEntry = currentEntries.get(resource.id);
    const inspection = await inspectResource(context.targetDirectory, resource, currentEntry);
    const nextEntry = await materializeResourceIfNeeded(context, registry, resource, currentEntry, inspection);

    if (nextEntry !== undefined) {
      nextEntries.push(nextEntry);
      statuses.push(nextEntry.status);
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
 * 只检查新增或变更资源，不写入目标文件、config 或 lockfile。
 *
 * @param context 同步上下文。
 * @param desiredResources Registry 期望资源。
 * @param currentLockfile 当前 lockfile。
 * @returns 资源同步摘要。
 */
async function inspectChangedResources(
  context: SyncContext,
  desiredResources: readonly WorkspaceResource[],
  currentLockfile: ResourceLockfile,
): Promise<ResourceSyncSummary> {
  const currentEntries = new Map(currentLockfile.resources.map((entry) => [entry.id, entry]));
  const desiredIds = new Set(desiredResources.map((resource) => resource.id));
  const statuses: ResourceLockStatus[] = [];

  for (const currentEntry of currentEntries.values()) {
    if (!desiredIds.has(currentEntry.id)) {
      statuses.push('missing');
    }
  }

  for (const resource of desiredResources) {
    const currentEntry = currentEntries.get(resource.id);
    const inspection = await inspectResource(context.targetDirectory, resource, currentEntry);
    const decision = decideResourceSync(resource, currentEntry, inspection);

    logProtectedResource(resource, decision.status, inspection);
    statuses.push(decision.status);
  }

  return countResourceStatuses(statuses);
}

/**
 * 资源同步前检查结果。
 */
interface ResourceInspection {
  /**
   * 目标文件路径。
   */
  readonly targetPath: string;
  /**
   * 当前目标文件 hash。
   */
  readonly currentTargetHash?: string;
  /**
   * 目标文件是否存在。
   */
  readonly targetExists: boolean;
  /**
   * Workspace 资源是否变化。
   */
  readonly sourceChanged: boolean;
  /**
   * 项目目标是否被用户修改。
   */
  readonly targetModified: boolean;
}

/**
 * 检查资源当前状态。
 *
 * @param projectDirectory 项目根目录。
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @returns 检查结果。
 */
async function inspectResource(
  projectDirectory: string,
  resource: WorkspaceResource,
  currentEntry: ResourceLockEntry | undefined,
): Promise<ResourceInspection> {
  const targetPath = path.join(projectDirectory, resource.targetPath);
  const targetExists = await fs.pathExists(targetPath);
  const currentTargetHash = targetExists ? await hashFile(targetPath) : undefined;
  const sourceChanged = currentEntry === undefined ? true : isWorkspaceResourceChanged(resource, currentEntry);
  const targetModified = isTargetModified(currentEntry, currentTargetHash);

  return {
    targetPath,
    currentTargetHash,
    targetExists,
    sourceChanged,
    targetModified,
  };
}

/**
 * 判断 Workspace 资源是否相对 lockfile 变化。
 *
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @returns 是否变化。
 */
function isWorkspaceResourceChanged(resource: WorkspaceResource, currentEntry: ResourceLockEntry): boolean {
  return (
    currentEntry.type !== resource.type ||
    currentEntry.version !== resource.version ||
    currentEntry.sourcePath !== resource.sourcePath ||
    currentEntry.targetPath !== resource.targetPath ||
    currentEntry.sourceHash !== resource.hash
  );
}

/**
 * 判断目标文件是否被用户修改。
 *
 * @param currentEntry 当前 lockfile 条目。
 * @param currentTargetHash 当前目标 hash。
 * @returns 是否修改。
 */
function isTargetModified(
  currentEntry: ResourceLockEntry | undefined,
  currentTargetHash: string | undefined,
): boolean {
  if (currentEntry === undefined || currentTargetHash === undefined) {
    return false;
  }

  if (currentEntry.status === 'modified' || currentEntry.status === 'conflict') {
    return true;
  }

  return currentEntry.targetHash !== undefined && currentTargetHash !== currentEntry.targetHash;
}

/**
 * 资源同步决策。
 */
interface ResourceDecision {
  /**
   * 最终状态。
   */
  readonly status: ResourceLockStatus;
  /**
   * 是否需要物化。
   */
  readonly shouldMaterialize: boolean;
  /**
   * 物化时使用的覆盖策略。
   */
  readonly overwritePolicy?: ResourceOverwritePolicy;
}

/**
 * 按需物化资源。
 *
 * @param context 同步上下文。
 * @param registry 已加载 Registry。
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @param inspection 资源检查结果。
 * @returns 下一个 lockfile 条目。
 */
async function materializeResourceIfNeeded(
  context: SyncContext,
  registry: LoadedWorkspaceRegistry,
  resource: WorkspaceResource,
  currentEntry: ResourceLockEntry | undefined,
  inspection: ResourceInspection,
): Promise<ResourceLockEntry | undefined> {
  const decision = decideResourceSync(resource, currentEntry, inspection);

  if (!decision.shouldMaterialize) {
    logProtectedResource(resource, decision.status, inspection);
    return createResourceLockEntry(resource, currentEntry, inspection.currentTargetHash, decision.status);
  }

  if (resource.copyPolicy === 'reference' || resource.copyPolicy === 'none') {
    return createResourceLockEntry(resource, currentEntry, inspection.currentTargetHash, 'skipped');
  }

  const result = await materializeResource({
    workspaceDirectory: registry.location.rootDirectory,
    projectDirectory: context.targetDirectory,
    resource,
    overwritePolicy: decision.overwritePolicy,
  });

  if (result.action === 'copied' || result.action === 'rendered') {
    logger.success(`${result.action === 'copied' ? '创建' : '生成'} ${toDisplayPath(result.targetPath)}`);
    const targetHash = (await fs.pathExists(result.targetPath)) ? await hashFile(result.targetPath) : undefined;

    return createResourceLockEntry(resource, currentEntry, targetHash, targetHash === undefined ? 'missing' : 'installed');
  }

  logger.warn(`跳过 ${resource.id}：overwritePolicy=${resource.overwritePolicy} 未允许写入`);
  return createResourceLockEntry(resource, currentEntry, inspection.currentTargetHash, 'skipped');
}

/**
 * 决定资源同步动作。
 *
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @param inspection 资源检查结果。
 * @returns 同步决策。
 */
function decideResourceSync(
  resource: WorkspaceResource,
  currentEntry: ResourceLockEntry | undefined,
  inspection: ResourceInspection,
): ResourceDecision {
  if (resource.copyPolicy === 'reference' || resource.copyPolicy === 'none') {
    return {
      status: 'skipped',
      shouldMaterialize: false,
    };
  }

  if (currentEntry === undefined && inspection.targetExists) {
    if (resource.overwritePolicy === 'always' || resource.overwritePolicy === 'managed-block') {
      return {
        status: 'installed',
        shouldMaterialize: true,
        overwritePolicy: resource.overwritePolicy,
      };
    }

    return {
      status: 'skipped',
      shouldMaterialize: false,
    };
  }

  if (currentEntry?.status === 'skipped' && inspection.targetExists) {
    if (
      inspection.sourceChanged &&
      (resource.overwritePolicy === 'always' || resource.overwritePolicy === 'managed-block')
    ) {
      return {
        status: 'installed',
        shouldMaterialize: true,
        overwritePolicy: resource.overwritePolicy,
      };
    }

    return {
      status: 'skipped',
      shouldMaterialize: false,
    };
  }

  if (!inspection.targetExists && currentEntry !== undefined) {
    return {
      status: 'missing',
      shouldMaterialize: false,
    };
  }

  if (inspection.targetModified && inspection.sourceChanged) {
    return createModifiedTargetDecision(resource, 'conflict');
  }

  if (inspection.targetModified) {
    return createModifiedTargetDecision(resource, 'modified');
  }

  if (currentEntry === undefined || inspection.sourceChanged || !inspection.targetExists) {
    return {
      status: 'installed',
      shouldMaterialize: true,
      overwritePolicy: resolveTrustedOverwritePolicy(resource.overwritePolicy),
    };
  }

  return {
    status: 'installed',
    shouldMaterialize: false,
  };
}

/**
 * 创建用户修改目标文件后的决策。
 *
 * @param resource Workspace 资源。
 * @param protectedStatus 保护状态。
 * @returns 同步决策。
 */
function createModifiedTargetDecision(
  resource: WorkspaceResource,
  protectedStatus: Extract<ResourceLockStatus, 'modified' | 'conflict'>,
): ResourceDecision {
  if (resource.overwritePolicy === 'always' || resource.overwritePolicy === 'managed-block') {
    return {
      status: 'installed',
      shouldMaterialize: true,
      overwritePolicy: resource.overwritePolicy,
    };
  }

  return {
    status: protectedStatus,
    shouldMaterialize: false,
  };
}

/**
 * 解析可信覆盖策略。
 *
 * @param overwritePolicy Registry 覆盖策略。
 * @returns 物化覆盖策略。
 */
function resolveTrustedOverwritePolicy(overwritePolicy: ResourceOverwritePolicy): ResourceOverwritePolicy {
  if (overwritePolicy === 'never') {
    return overwritePolicy;
  }

  if (overwritePolicy === 'managed-block') {
    return overwritePolicy;
  }

  return 'always';
}

/**
 * 输出受保护资源日志。
 *
 * @param resource Workspace 资源。
 * @param status 资源状态。
 * @param inspection 资源检查结果。
 */
function logProtectedResource(
  resource: WorkspaceResource,
  status: ResourceLockStatus,
  inspection: ResourceInspection,
): void {
  if (status === 'modified') {
    logger.warn(`保留 ${resource.id}：项目文件已被用户修改`);
    return;
  }

  if (status === 'conflict') {
    logger.warn(`保留 ${resource.id}：Workspace 与项目文件均已变化`);
    return;
  }

  if (status === 'missing' && !inspection.targetExists) {
    logger.warn(`标记 ${resource.id}：项目文件已删除`);
  }
}

/**
 * 创建资源 lockfile 条目。
 *
 * @param resource Workspace 资源。
 * @param currentEntry 当前 lockfile 条目。
 * @param targetHash 项目目标文件 hash。
 * @param status 资源状态。
 * @returns lockfile 条目。
 */
function createResourceLockEntry(
  resource: WorkspaceResource,
  currentEntry: ResourceLockEntry | undefined,
  targetHash: string | undefined,
  status: ResourceLockStatus,
): ResourceLockEntry {
  const now = new Date().toISOString();
  const nextEntry: ResourceLockEntry = {
    id: resource.id,
    type: resource.type,
    version: resource.version,
    sourcePath: resource.sourcePath,
    targetPath: resource.targetPath,
    sourceHash: resource.hash,
    targetHash,
    installedAt: currentEntry?.installedAt ?? now,
    updatedAt: now,
    status,
    lastAction: 'sync',
  };

  if (currentEntry === undefined || !isSameLockEntryState(nextEntry, currentEntry)) {
    return nextEntry;
  }

  return {
    ...nextEntry,
    installedAt: currentEntry.installedAt,
    updatedAt: currentEntry.updatedAt,
  };
}

/**
 * 判断两个 lock 条目的非时间状态是否一致。
 *
 * @param left 左侧条目。
 * @param right 右侧条目。
 * @returns 是否一致。
 */
function isSameLockEntryState(left: ResourceLockEntry, right: ResourceLockEntry): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.version === right.version &&
    left.sourcePath === right.sourcePath &&
    left.targetPath === right.targetPath &&
    left.sourceHash === right.sourceHash &&
    left.targetHash === right.targetHash &&
    left.status === right.status &&
    left.lastAction === right.lastAction
  );
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
function countResourceStatuses(statuses: readonly ResourceLockStatus[]): ResourceSyncSummary {
  return {
    installedCount: countStatus(statuses, 'installed'),
    modifiedCount: countStatus(statuses, 'modified'),
    missingCount: countStatus(statuses, 'missing'),
    conflictCount: countStatus(statuses, 'conflict'),
    skippedCount: countStatus(statuses, 'skipped'),
  };
}

/**
 * 统计指定状态数量。
 *
 * @param statuses 资源状态列表。
 * @param status 目标状态。
 * @returns 状态数量。
 */
function countStatus(statuses: readonly ResourceLockStatus[], status: ResourceLockStatus): number {
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
    projectInsights: await inspectProjectInsights(context.targetDirectory, dependencies),
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
