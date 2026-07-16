import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { execa } from 'execa';
import fs from 'fs-extra';
import { logger } from '../utils/logger.js';

/**
 * JSON 值。
 */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

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
 * 初始化上下文。
 */
interface InitContext {
  /**
   * 目标项目目录。
   */
  readonly targetDirectory: string;
  /**
   * .veaw 工作区目录。
   */
  readonly veawDirectory: string;
  /**
   * 内置 assets 目录。
   */
  readonly assetsDirectory: string;
}

/**
 * 文件写入结果。
 */
interface WriteResult {
  /**
   * 是否写入了文件。
   */
  readonly written: boolean;
  /**
   * 文件相对路径。
   */
  readonly relativePath: string;
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
 * 需要创建的工作区目录。
 */
const WORKSPACE_DIRECTORIES = ['assets', 'prompts', 'templates', 'config', 'component-catalog'] as const;

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
 * 注册 init 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize the .veaw workspace in the current project.')
    .action(async (): Promise<void> => {
      await runInitCommand();
    });
}

/**
 * 执行 init 命令。
 */
async function runInitCommand(): Promise<void> {
  try {
    const context = await createInitContext(process.cwd());

    await ensureWorkspaceDirectories(context);
    await copyAssetsToWorkspace(context);
    await writeProjectJsonIfMissing(context);
    await writeTemplateIfMissing(context, 'context.md', 'context.md');
    await writeTemplateIfMissing(context, 'session-log.md', 'session-log.md');

    logger.success('初始化完成');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`初始化失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建初始化上下文。
 *
 * @param targetDirectory 目标项目目录。
 * @returns 初始化上下文。
 */
async function createInitContext(targetDirectory: string): Promise<InitContext> {
  return {
    targetDirectory,
    veawDirectory: path.join(targetDirectory, VEAW_DIRECTORY_NAME),
    assetsDirectory: await resolveAssetsDirectory(),
  };
}

/**
 * 解析内置 assets 目录。
 *
 * @returns 内置 assets 目录路径。
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
 * 确保工作区目录存在。
 *
 * @param context 初始化上下文。
 */
async function ensureWorkspaceDirectories(context: InitContext): Promise<void> {
  await ensureDirectory(context.veawDirectory);

  for (const directoryName of WORKSPACE_DIRECTORIES) {
    await ensureDirectory(path.join(context.veawDirectory, directoryName));
  }
}

/**
 * 确保目录存在。
 *
 * @param directoryPath 目录路径。
 */
async function ensureDirectory(directoryPath: string): Promise<void> {
  const exists = await fs.pathExists(directoryPath);

  await fs.ensureDir(directoryPath);

  logger.success(`${exists ? '保留' : '创建'} ${toDisplayPath(directoryPath)}`);
}

/**
 * 复制内置 assets 到 .veaw/assets。
 *
 * @param context 初始化上下文。
 */
async function copyAssetsToWorkspace(context: InitContext): Promise<void> {
  await copyDirectoryContents(context.assetsDirectory, path.join(context.veawDirectory, 'assets'));
}

/**
 * 复制目录内容，已存在文件不覆盖。
 *
 * @param sourceDirectory 源目录。
 * @param targetDirectory 目标目录。
 */
async function copyDirectoryContents(sourceDirectory: string, targetDirectory: string): Promise<void> {
  await fs.ensureDir(targetDirectory);

  const entries = await fs.readdir(sourceDirectory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    await copyFileIfMissing(sourcePath, targetPath);
  }
}

/**
 * 在目标文件缺失时复制文件。
 *
 * @param sourcePath 源文件路径。
 * @param targetPath 目标文件路径。
 */
async function copyFileIfMissing(sourcePath: string, targetPath: string): Promise<void> {
  if (await fs.pathExists(targetPath)) {
    logger.success(`保留 ${toDisplayPath(targetPath)}`);
    return;
  }

  await fs.copy(sourcePath, targetPath, {
    overwrite: false,
    errorOnExist: false,
  });
  logger.success(`创建 ${toDisplayPath(targetPath)}`);
}

/**
 * 在 project.json 缺失时写入项目画像。
 *
 * @param context 初始化上下文。
 */
async function writeProjectJsonIfMissing(context: InitContext): Promise<void> {
  const targetPath = path.join(context.veawDirectory, 'project.json');
  const result = await writeJsonIfMissing(targetPath, await createProjectJson(context));

  logger.success(`${result.written ? '创建' : '保留'} ${result.relativePath}`);
}

/**
 * 在目标模板文件缺失时写入模板。
 *
 * @param context 初始化上下文。
 * @param templateFileName 模板文件名称。
 * @param targetFileName 目标文件名称。
 */
async function writeTemplateIfMissing(
  context: InitContext,
  templateFileName: string,
  targetFileName: string,
): Promise<void> {
  const templatePath = path.join(context.assetsDirectory, templateFileName);
  const targetPath = path.join(context.veawDirectory, targetFileName);
  const templateContent = await fs.readFile(templatePath, 'utf8');
  const result = await writeTextIfMissing(targetPath, templateContent);

  logger.success(`${result.written ? '创建' : '保留'} ${result.relativePath}`);
}

/**
 * 在 JSON 文件缺失时写入。
 *
 * @param filePath 文件路径。
 * @param data JSON 数据。
 * @returns 文件写入结果。
 */
async function writeJsonIfMissing(filePath: string, data: unknown): Promise<WriteResult> {
  if (await fs.pathExists(filePath)) {
    return {
      written: false,
      relativePath: toDisplayPath(filePath),
    };
  }

  await fs.outputJson(filePath, data, {
    spaces: 2,
  });

  return {
    written: true,
    relativePath: toDisplayPath(filePath),
  };
}

/**
 * 在文本文件缺失时写入。
 *
 * @param filePath 文件路径。
 * @param content 文本内容。
 * @returns 文件写入结果。
 */
async function writeTextIfMissing(filePath: string, content: string): Promise<WriteResult> {
  if (await fs.pathExists(filePath)) {
    return {
      written: false,
      relativePath: toDisplayPath(filePath),
    };
  }

  await fs.outputFile(filePath, content);

  return {
    written: true,
    relativePath: toDisplayPath(filePath),
  };
}

/**
 * 创建 project.json 内容。
 *
 * @param context 初始化上下文。
 * @returns project.json 内容。
 */
async function createProjectJson(context: InitContext): Promise<ProjectJson> {
  const packageJson = await readPackageJsonSummary(context.targetDirectory);
  const dependencies = mergeDependencyRecords(packageJson.dependencies, packageJson.devDependencies);
  const typescript = await readTypeScriptSummary(context.targetDirectory, dependencies);
  const vite = await readViteSummary(context.targetDirectory, dependencies);
  const pnpmWorkspace = await readPnpmWorkspaceSummary(context.targetDirectory);

  return {
    version: PROJECT_JSON_VERSION,
    generatedAt: new Date().toISOString(),
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
 * 判断值是否是对象记录。
 *
 * @param value 待判断值。
 * @returns 是否是对象记录。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  const result: Record<string, JsonValue> = {};

  for (const [entryKey, entryValue] of Object.entries(value)) {
    const sanitizedValue = sanitizeJsonValue(entryValue);

    if (sanitizedValue !== undefined) {
      result[entryKey] = sanitizedValue;
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
