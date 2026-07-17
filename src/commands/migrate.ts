import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import fs from 'fs-extra';
import {
  ResourceResolver,
  createProjectProfileFromProjectJson,
  createResourceLockfile,
  discoverWorkspace,
  hashFile,
  readResourceLockfile,
  readWorkspaceRegistry,
  writeResourceLockfile,
} from '../resource-loader/index.js';
import type {
  LoadedWorkspaceRegistry,
  ResourceLockEntry,
  ResourceLockStatus,
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
 * 迁移资源来源。
 */
type MigrationResourceMode = 'workspace' | 'fallback';

/**
 * 迁移动作。
 */
type MigrationChangeAction = 'create' | 'update' | 'keep';

/**
 * migrate 命令选项。
 */
interface MigrateCommandOptions {
  /**
   * 显式 Workspace 路径。
   */
  readonly workspace?: string;
  /**
   * 是否实际写入迁移结果。
   */
  readonly apply?: boolean;
}

/**
 * 迁移上下文。
 */
interface MigrationContext {
  /**
   * 项目目录。
   */
  readonly projectDirectory: string;
  /**
   * .veaw 目录。
   */
  readonly veawDirectory: string;
  /**
   * CLI 内置 assets 目录。
   */
  readonly assetsDirectory: string;
}

/**
 * 迁移候选资源。
 */
interface MigrationResource {
  /**
   * 资源 id。
   */
  readonly id: string;
  /**
   * 资源类型。
   */
  readonly type: string;
  /**
   * 资源版本。
   */
  readonly version: string;
  /**
   * 源文件路径。
   */
  readonly sourcePath: string;
  /**
   * 目标文件路径。
   */
  readonly targetPath: string;
  /**
   * 源 hash。
   */
  readonly sourceHash: string;
}

/**
 * 迁移资源计划。
 */
interface MigrationResourcePlan {
  /**
   * 迁移资源。
   */
  readonly resource: MigrationResource;
  /**
   * 迁移状态。
   */
  readonly status: ResourceLockStatus;
  /**
   * 项目目标 hash。
   */
  readonly targetHash?: string;
}

/**
 * 迁移计划。
 */
interface MigrationPlan {
  /**
   * 资源模式。
   */
  readonly resourceMode: MigrationResourceMode;
  /**
   * Workspace 路径。
   */
  readonly workspacePath?: string;
  /**
   * Workspace 版本。
   */
  readonly workspaceVersion: string;
  /**
   * Registry schema 版本。
   */
  readonly registryVersion?: string;
  /**
   * CLI assets 路径。
   */
  readonly assetsPath?: string;
  /**
   * config.json 变更。
   */
  readonly configAction: MigrationChangeAction;
  /**
   * resources.lock.json 变更。
   */
  readonly lockfileAction: MigrationChangeAction;
  /**
   * migration 记录变更。
   */
  readonly recordAction: MigrationChangeAction;
  /**
   * 资源计划。
   */
  readonly resources: readonly MigrationResourcePlan[];
}

/**
 * migration 记录。
 */
interface MigrationRecord {
  /**
   * 记录 schema 版本。
   */
  readonly schemaVersion: string;
  /**
   * 生成时间。
   */
  readonly generatedAt: string;
  /**
   * 迁移资源模式。
   */
  readonly resourceMode: MigrationResourceMode;
  /**
   * Workspace 路径。
   */
  readonly workspacePath?: string;
  /**
   * CLI assets 路径。
   */
  readonly assetsPath?: string;
  /**
   * 资源状态摘要。
   */
  readonly summary: Readonly<Record<ResourceLockStatus, number>>;
  /**
   * 迁移资源条目。
   */
  readonly resources: readonly MigrationRecordResource[];
}

/**
 * migration 资源记录。
 */
interface MigrationRecordResource {
  /**
   * 资源 id。
   */
  readonly id: string;
  /**
   * 目标路径。
   */
  readonly targetPath: string;
  /**
   * 状态。
   */
  readonly status: ResourceLockStatus;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * project.json/config.json 版本。
 */
const PROJECT_JSON_VERSION = '0.1.0';

/**
 * migration 记录相对路径。
 */
const MIGRATION_RECORD_PATH = path.join(VEAW_DIRECTORY_NAME, 'migrations', 'legacy-migration.json');

/**
 * 注册 migrate 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate legacy .veaw projects explicitly. Defaults to dry-run.')
    .option('--workspace <path>', 'Use a VEAW Workspace directory.')
    .option('--apply', 'Apply the migration plan. Without this flag migrate only reports changes.')
    .action(async (options: MigrateCommandOptions): Promise<void> => {
      await runMigrateCommand(options);
    });
}

/**
 * 执行 migrate 命令。
 *
 * @param options migrate 命令选项。
 */
export async function runMigrateCommand(options: MigrateCommandOptions = {}): Promise<void> {
  try {
    const context = await createMigrationContext(process.cwd());
    const plan = await createMigrationPlan(context, options);

    printMigrationPlan(plan, options.apply === true);

    if (options.apply === true) {
      await applyMigrationPlan(context, plan);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`迁移失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建迁移上下文。
 *
 * @param projectDirectory 项目目录。
 * @returns 迁移上下文。
 */
async function createMigrationContext(projectDirectory: string): Promise<MigrationContext> {
  const veawDirectory = path.join(projectDirectory, VEAW_DIRECTORY_NAME);

  if (!(await fs.pathExists(veawDirectory))) {
    throw new Error('未检测到 .veaw 工作区，无法迁移');
  }

  return {
    projectDirectory,
    veawDirectory,
    assetsDirectory: await resolveAssetsDirectory(),
  };
}

/**
 * 解析内置 assets 目录。
 *
 * @returns 内置 assets 目录。
 */
async function resolveAssetsDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '..', '..', 'assets'),
    path.resolve(moduleDirectory, '..', 'assets'),
  ];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('未找到内置 assets 目录');
}

/**
 * 创建迁移计划。
 *
 * @param context 迁移上下文。
 * @param options migrate 命令选项。
 * @returns 迁移计划。
 */
async function createMigrationPlan(
  context: MigrationContext,
  options: MigrateCommandOptions,
): Promise<MigrationPlan> {
  const workspaceLocation = await discoverWorkspace({
    projectDirectory: context.projectDirectory,
    explicitWorkspacePath: options.workspace,
    environment: process.env,
    fallbackAssetsDirectory: context.assetsDirectory,
  });

  if (workspaceLocation.kind === 'workspace') {
    const registry = await readWorkspaceRegistry(workspaceLocation);
    const resources = await createWorkspaceMigrationResources(context, registry);

    return createPlanFromResources(context, {
      resourceMode: 'workspace',
      workspacePath: workspaceLocation.rootDirectory,
      workspaceVersion: registry.registry.workspaceVersion,
      registryVersion: registry.registry.schemaVersion,
      resources,
    });
  }

  const resources = await createFallbackMigrationResources(context, workspaceLocation.assetsDirectory ?? context.assetsDirectory);

  return createPlanFromResources(context, {
    resourceMode: 'fallback',
    workspaceVersion: PROJECT_JSON_VERSION,
    assetsPath: workspaceLocation.assetsDirectory ?? context.assetsDirectory,
    resources,
  });
}

/**
 * 从 Workspace Registry 创建迁移资源。
 *
 * @param context 迁移上下文。
 * @param registry 已加载 Registry。
 * @returns 迁移资源计划。
 */
async function createWorkspaceMigrationResources(
  context: MigrationContext,
  registry: LoadedWorkspaceRegistry,
): Promise<readonly MigrationResourcePlan[]> {
  const resolver = new ResourceResolver(registry.resources);
  const projectJson = await readOptionalJsonObject(path.join(context.veawDirectory, 'project.json'));
  const resources = resolver.resolveSelection({
    profile: createProjectProfileFromProjectJson(projectJson),
  }).resources;
  const plans: MigrationResourcePlan[] = [];

  for (const resource of resources) {
    plans.push(await createResourcePlan(context.projectDirectory, createMigrationResourceFromWorkspace(resource)));
  }

  return plans;
}

/**
 * 从 WorkspaceResource 创建迁移资源。
 *
 * @param resource Workspace 资源。
 * @returns 迁移资源。
 */
function createMigrationResourceFromWorkspace(resource: WorkspaceResource): MigrationResource {
  return {
    id: resource.id,
    type: resource.type,
    version: resource.version,
    sourcePath: resource.sourcePath,
    targetPath: resource.targetPath,
    sourceHash: resource.hash,
  };
}

/**
 * 从 CLI fallback assets 创建迁移资源。
 *
 * @param context 迁移上下文。
 * @param assetsDirectory assets 目录。
 * @returns 迁移资源计划。
 */
async function createFallbackMigrationResources(
  context: MigrationContext,
  assetsDirectory: string,
): Promise<readonly MigrationResourcePlan[]> {
  const sourceFiles = await collectFiles(assetsDirectory);
  const plans: MigrationResourcePlan[] = [];

  for (const sourceFile of sourceFiles) {
    const relativePath = path.relative(assetsDirectory, sourceFile).replaceAll(path.sep, '/');
    const resource: MigrationResource = {
      id: `fallback:${relativePath}`,
      type: 'fallback-asset',
      version: PROJECT_JSON_VERSION,
      sourcePath: relativePath,
      targetPath: `.veaw/assets/${relativePath}`,
      sourceHash: await hashFile(sourceFile),
    };

    plans.push(await createResourcePlan(context.projectDirectory, resource));
  }

  return plans;
}

/**
 * 创建单个资源迁移计划。
 *
 * @param projectDirectory 项目目录。
 * @param resource 迁移资源。
 * @returns 资源迁移计划。
 */
async function createResourcePlan(
  projectDirectory: string,
  resource: MigrationResource,
): Promise<MigrationResourcePlan> {
  const targetPath = path.join(projectDirectory, resource.targetPath);

  if (!(await fs.pathExists(targetPath))) {
    return {
      resource,
      status: 'missing',
    };
  }

  const targetHash = await hashFile(targetPath);

  return {
    resource,
    status: targetHash === resource.sourceHash ? 'installed' : resource.type === 'fallback-asset' ? 'modified' : 'conflict',
    targetHash,
  };
}

/**
 * 从资源计划创建迁移计划。
 *
 * @param context 迁移上下文。
 * @param input 迁移输入。
 * @returns 迁移计划。
 */
async function createPlanFromResources(
  context: MigrationContext,
  input: {
    readonly resourceMode: MigrationResourceMode;
    readonly workspaceVersion: string;
    readonly resources: readonly MigrationResourcePlan[];
    readonly workspacePath?: string;
    readonly registryVersion?: string;
    readonly assetsPath?: string;
  },
): Promise<MigrationPlan> {
  const nextConfig = await createMergedWorkspaceConfig(context, input);
  const nextLockfile = createLockfileFromPlan(input.workspaceVersion, input.resources, await readResourceLockfile(context.projectDirectory));
  const nextRecord = await createMigrationRecord(context, input);

  return {
    resourceMode: input.resourceMode,
    workspacePath: input.workspacePath,
    workspaceVersion: input.workspaceVersion,
    registryVersion: input.registryVersion,
    assetsPath: input.assetsPath,
    configAction: await getJsonAction(path.join(context.veawDirectory, 'config.json'), nextConfig),
    lockfileAction: await getJsonAction(path.join(context.veawDirectory, 'resources.lock.json'), nextLockfile),
    recordAction: await getJsonAction(path.join(context.projectDirectory, MIGRATION_RECORD_PATH), nextRecord),
    resources: input.resources,
  };
}

/**
 * 应用迁移计划。
 *
 * @param context 迁移上下文。
 * @param plan 迁移计划。
 */
async function applyMigrationPlan(context: MigrationContext, plan: MigrationPlan): Promise<void> {
  const currentLockfile = await readResourceLockfile(context.projectDirectory);
  const config = await createMergedWorkspaceConfig(context, plan);
  const lockfile = createLockfileFromPlan(plan.workspaceVersion, plan.resources, currentLockfile);
  const record = await createMigrationRecord(context, plan);

  await writeJsonIfChanged(path.join(context.veawDirectory, 'config.json'), config);
  await writeResourceLockfile(context.projectDirectory, lockfile);
  await writeJsonIfChanged(path.join(context.projectDirectory, MIGRATION_RECORD_PATH), record);

  logger.success('迁移已应用');
}

/**
 * 创建合并后的 Workspace 配置。
 *
 * @param context 迁移上下文。
 * @param input 迁移输入。
 * @returns JSON 对象。
 */
async function createMergedWorkspaceConfig(
  context: MigrationContext,
  input: {
    readonly resourceMode: MigrationResourceMode;
    readonly workspacePath?: string;
    readonly workspaceVersion?: string;
    readonly registryVersion?: string;
    readonly assetsPath?: string;
  },
): Promise<JsonObject> {
  const currentConfig = await readOptionalJsonObject(path.join(context.veawDirectory, 'config.json'));
  const nextConfig = createWorkspaceConfigJson(input);

  return mergeJsonObjects(currentConfig, nextConfig);
}

/**
 * 创建 Workspace 配置 JSON。
 *
 * @param input 迁移输入。
 * @returns JSON 对象。
 */
function createWorkspaceConfigJson(input: {
  readonly resourceMode: MigrationResourceMode;
  readonly workspacePath?: string;
  readonly workspaceVersion?: string;
  readonly registryVersion?: string;
  readonly assetsPath?: string;
}): JsonObject {
  return removeUndefinedJsonValues({
    version: PROJECT_JSON_VERSION,
    resourceMode: input.resourceMode,
    workspacePath: input.workspacePath,
    workspaceVersion: input.workspaceVersion,
    registryVersion: input.registryVersion,
    assetsPath: input.assetsPath,
  });
}

/**
 * 从迁移计划创建 lockfile。
 *
 * @param workspaceVersion Workspace 版本。
 * @param resources 资源计划。
 * @param currentLockfile 当前 lockfile。
 * @returns lockfile。
 */
function createLockfileFromPlan(
  workspaceVersion: string,
  resources: readonly MigrationResourcePlan[],
  currentLockfile: ResourceLockfile | undefined,
): ResourceLockfile {
  const now = new Date().toISOString();
  const currentEntries = new Map(currentLockfile?.resources.map((entry) => [entry.id, entry]) ?? []);
  const entries = resources.map((resource) => {
    const currentEntry = currentEntries.get(resource.resource.id);
    const nextEntry = createLockEntry(resource, currentEntry?.installedAt ?? now, now);

    if (currentEntry !== undefined && isSameEntryState(nextEntry, currentEntry)) {
      return {
        ...nextEntry,
        installedAt: currentEntry.installedAt,
        updatedAt: currentEntry.updatedAt,
      };
    }

    return nextEntry;
  });
  const nextLockfile = createResourceLockfile(workspaceVersion, []);
  const keepGeneratedAt =
    currentLockfile !== undefined &&
    currentLockfile.workspaceVersion === workspaceVersion &&
    JSON.stringify(currentLockfile.resources) === JSON.stringify(entries);

  return {
    ...nextLockfile,
    generatedAt: keepGeneratedAt ? currentLockfile.generatedAt : currentLockfile?.generatedAt ?? nextLockfile.generatedAt,
    resources: entries,
  };
}

/**
 * 创建 lockfile 条目。
 *
 * @param plan 资源计划。
 * @param installedAt 首次安装时间。
 * @param updatedAt 更新时间。
 * @returns lockfile 条目。
 */
function createLockEntry(plan: MigrationResourcePlan, installedAt: string, updatedAt: string): ResourceLockEntry {
  return {
    id: plan.resource.id,
    type: plan.resource.type,
    version: plan.resource.version,
    sourcePath: plan.resource.sourcePath,
    targetPath: plan.resource.targetPath,
    sourceHash: plan.resource.sourceHash,
    targetHash: plan.targetHash,
    installedAt,
    updatedAt,
    status: plan.status,
    lastAction: 'migrate',
  };
}

/**
 * 创建 migration 记录。
 *
 * @param context 迁移上下文。
 * @param input 迁移输入。
 * @returns migration 记录。
 */
async function createMigrationRecord(
  context: MigrationContext,
  input: {
    readonly resourceMode: MigrationResourceMode;
    readonly resources: readonly MigrationResourcePlan[];
    readonly workspacePath?: string;
    readonly assetsPath?: string;
  },
): Promise<MigrationRecord> {
  const currentRecord = await readMigrationRecord(path.join(context.projectDirectory, MIGRATION_RECORD_PATH));
  const generatedAt = currentRecord?.generatedAt ?? new Date().toISOString();

  return {
    schemaVersion: '1.0.0',
    generatedAt,
    resourceMode: input.resourceMode,
    workspacePath: input.workspacePath,
    assetsPath: input.assetsPath,
    summary: countResourceStatuses(input.resources),
    resources: input.resources.map((resource) => ({
      id: resource.resource.id,
      targetPath: resource.resource.targetPath,
      status: resource.status,
    })),
  };
}

/**
 * 读取 migration 记录。
 *
 * @param filePath 文件路径。
 * @returns migration 记录。
 */
async function readMigrationRecord(filePath: string): Promise<MigrationRecord | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  const content = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

  if (!isJsonObject(content)) {
    return undefined;
  }

  const generatedAt = readString(content, 'generatedAt');

  if (generatedAt === undefined) {
    return undefined;
  }

  return {
    schemaVersion: readString(content, 'schemaVersion') ?? '1.0.0',
    generatedAt,
    resourceMode: readString(content, 'resourceMode') === 'workspace' ? 'workspace' : 'fallback',
    workspacePath: readString(content, 'workspacePath'),
    assetsPath: readString(content, 'assetsPath'),
    summary: createEmptyStatusCount(),
    resources: [],
  };
}

/**
 * 获取 JSON 文件变更动作。
 *
 * @param filePath 文件路径。
 * @param data JSON 数据。
 * @returns 变更动作。
 */
async function getJsonAction(filePath: string, data: JsonObject | ResourceLockfile | MigrationRecord): Promise<MigrationChangeAction> {
  if (!(await fs.pathExists(filePath))) {
    return 'create';
  }

  const current = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

  return JSON.stringify(current) === JSON.stringify(data) ? 'keep' : 'update';
}

/**
 * 内容变化时写 JSON。
 *
 * @param filePath 文件路径。
 * @param data JSON 数据。
 */
async function writeJsonIfChanged(filePath: string, data: JsonObject | MigrationRecord): Promise<void> {
  if ((await fs.pathExists(filePath)) && (await getJsonAction(filePath, data)) === 'keep') {
    logger.success(`保留 ${toDisplayPath(filePath)}`);
    return;
  }

  await fs.outputJson(filePath, data, {
    spaces: 2,
  });
  logger.success(`更新 ${toDisplayPath(filePath)}`);
}

/**
 * 判断 lock 条目状态是否相同。
 *
 * @param left 左侧条目。
 * @param right 右侧条目。
 * @returns 是否相同。
 */
function isSameEntryState(left: ResourceLockEntry, right: ResourceLockEntry): boolean {
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
 * 递归收集文件。
 *
 * @param directoryPath 目录路径。
 * @returns 文件路径列表。
 */
async function collectFiles(directoryPath: string): Promise<readonly string[]> {
  const entries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      filePaths.push(...(await collectFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(entryPath);
    }
  }

  return filePaths.sort((left, right) => left.localeCompare(right));
}

/**
 * 输出迁移计划。
 *
 * @param plan 迁移计划。
 * @param apply 是否应用。
 */
function printMigrationPlan(plan: MigrationPlan, apply: boolean): void {
  const prefix = apply ? '将应用迁移' : '迁移预览';

  logger.success(
    `${prefix}：config=${plan.configAction}，lockfile=${plan.lockfileAction}，record=${plan.recordAction}`,
  );
  logger.success(
    `资源状态：installed ${countStatus(plan.resources, 'installed')}，modified ${countStatus(plan.resources, 'modified')}，missing ${countStatus(plan.resources, 'missing')}，conflict ${countStatus(plan.resources, 'conflict')}，skipped ${countStatus(plan.resources, 'skipped')}`,
  );
}

/**
 * 统计资源状态。
 *
 * @param resources 资源计划。
 * @returns 状态统计。
 */
function countResourceStatuses(resources: readonly MigrationResourcePlan[]): Readonly<Record<ResourceLockStatus, number>> {
  return {
    installed: countStatus(resources, 'installed'),
    modified: countStatus(resources, 'modified'),
    missing: countStatus(resources, 'missing'),
    conflict: countStatus(resources, 'conflict'),
    skipped: countStatus(resources, 'skipped'),
  };
}

/**
 * 创建空状态统计。
 *
 * @returns 空状态统计。
 */
function createEmptyStatusCount(): Readonly<Record<ResourceLockStatus, number>> {
  return {
    installed: 0,
    modified: 0,
    missing: 0,
    conflict: 0,
    skipped: 0,
  };
}

/**
 * 统计指定状态。
 *
 * @param resources 资源计划。
 * @param status 资源状态。
 * @returns 数量。
 */
function countStatus(resources: readonly MigrationResourcePlan[], status: ResourceLockStatus): number {
  return resources.filter((resource) => resource.status === status).length;
}

/**
 * 读取字符串属性。
 *
 * @param record 对象记录。
 * @param key 属性名。
 * @returns 字符串属性。
 */
function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * 移除 undefined JSON 字段。
 *
 * @param record 对象记录。
 * @returns JSON 对象。
 */
function removeUndefinedJsonValues(record: Readonly<Record<string, JsonValue | undefined>>): JsonObject {
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
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

  const content = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

  return isJsonObject(content) ? sanitizeJsonObject(content) : {};
}

/**
 * 深度合并 JSON 对象。
 *
 * @param current 当前对象。
 * @param next 下一个对象。
 * @returns 合并后的对象。
 */
function mergeJsonObjects(
  current: Readonly<Record<string, JsonValue>>,
  next: Readonly<Record<string, JsonValue>>,
): JsonObject {
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
 * 清洗 JSON 值。
 *
 * @param value 原始值。
 * @returns JSON 值。
 */
function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item) ?? null);
  }

  if (!isJsonObject(value)) {
    return undefined;
  }

  return sanitizeJsonObject(value);
}

/**
 * 判断值是否是 JSON 对象。
 *
 * @param value 待判断值。
 * @returns 是否是 JSON 对象。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
