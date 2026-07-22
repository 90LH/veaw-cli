import path from 'node:path';
import { Command } from 'commander';
import { execa } from 'execa';
import fs from 'fs-extra';
import { refreshCatalogGeneratedEntries } from './catalog.js';
import { runContextCommand } from './context.js';
import type { CatalogGeneratedRefreshResult } from './catalog.js';
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
 * 变更来源。
 */
type RefreshChangeSource = 'changed-option' | 'git-auto';

/**
 * 变更来源明细。
 */
type RefreshChangeSourceDetail = 'changed-option' | 'working-tree' | 'staged' | 'untracked' | 'git-today';

/**
 * 文件排除原因。
 */
type ExclusionReason =
  | 'environment-file'
  | 'secret-or-certificate'
  | 'git-directory'
  | 'dependency-directory'
  | 'build-output'
  | 'generated-directory'
  | 'outside-project';

/**
 * 跳过原因。
 */
type RefreshSkippedReason = 'no-changes' | 'no-routed-targets';

/**
 * refresh 命令选项。
 */
interface RefreshCommandOptions {
  /**
   * 显式传入的变更文件。
   */
  readonly changed?: string | readonly string[];
  /**
   * 是否写入生成区。
   */
  readonly writeGenerated?: boolean;
  /**
   * 仅预览，不写入。
   */
  readonly dryRun?: boolean;
}

/**
 * 标准化后的变更集合。
 */
interface NormalizedChanges {
  /**
   * 保留的变更文件。
   */
  readonly files: readonly string[];
  /**
   * 被排除的文件。
   */
  readonly excludedFiles: readonly ExcludedFile[];
}

/**
 * Git 自动检测结果。
 */
interface GitAutoChanges {
  /**
   * Git 变更文件。
   */
  readonly files: readonly string[];
  /**
   * Git 变更来源。
   */
  readonly sources: readonly RefreshChangeSourceDetail[];
}

/**
 * 被排除文件摘要。
 */
interface ExcludedFile {
  /**
   * 项目相对路径或原始路径。
   */
  readonly path: string;
  /**
   * 排除原因。
   */
  readonly reason: ExclusionReason;
}

/**
 * 待刷新目标集合。
 */
interface RefreshTargets {
  /**
   * 需要刷新 catalog 的文件。
   */
  readonly catalog: readonly string[];
  /**
   * 需要刷新 context 的文件。
   */
  readonly context: readonly string[];
}

/**
 * refresh/status JSON 摘要。
 */
interface RefreshSummary {
  /**
   * 命令名。
   */
  readonly command: 'refresh' | 'status';
  /**
   * 变更来源。
   */
  readonly source: RefreshChangeSource;
  /**
   * 变更来源明细。
   */
  readonly sources: readonly RefreshChangeSourceDetail[];
  /**
   * 是否写入生成区。
   */
  readonly writeGenerated: boolean;
  /**
   * 参与路由的变更文件。
   */
  readonly changedFiles: readonly string[];
  /**
   * 被排除的文件。
   */
  readonly excludedFiles: readonly ExcludedFile[];
  /**
   * 待刷新目标。
   */
  readonly targets: RefreshTargets;
  /**
   * 执行动作。
   */
  readonly actions: readonly JsonObject[];
  /**
   * 写入的文件。
   */
  readonly writes: readonly string[];
  /**
   * 跳过原因。
   */
  readonly skippedReason: RefreshSkippedReason | null;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * catalog 输入根目录。
 */
const CATALOG_INPUT_ROOTS = ['src/components', 'src/views', 'src/layouts'] as const;

/**
 * context 输入根目录。
 */
const CONTEXT_INPUT_ROOTS = [
  'src/router',
  'src/routes',
  'src/api',
  'src/apis',
  'src/http',
  'src/request',
  'src/service',
  'src/services',
  'src/store',
  'src/stores',
] as const;

/**
 * 依赖与项目结构输入文件。
 */
const CONTEXT_INPUT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
] as const;

/**
 * 组件文件扩展名。
 */
const COMPONENT_EXTENSIONS = ['.vue', '.tsx', '.jsx'] as const;

/**
 * 敏感文件扩展名。
 */
const SECRET_EXTENSIONS = ['.pem', '.key', '.cert', '.crt', '.p12', '.pfx', '.der', '.keystore', '.jks'] as const;

/**
 * 注册 refresh/status 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerRefreshCommand(program: Command): void {
  program
    .command('refresh')
    .description('Incrementally refresh VEAW generated catalog/context from changed files.')
    .option('--changed <files...>', 'Changed files to route into catalog/context refresh.')
    .option('--dry-run', 'Print a JSON preview without writing generated files.')
    .option('--write-generated', 'Deprecated: refresh writes generated files by default unless --dry-run is used.')
    .action(async (options: RefreshCommandOptions): Promise<void> => {
      await runRefreshCommand(options);
    });

  program
    .command('status')
    .description('Report catalog/context items pending from today Git diff without writing files.')
    .action(async (): Promise<void> => {
      await runStatusCommand();
    });
}

/**
 * 执行 refresh 命令。
 *
 * @param options refresh 选项。
 */
export async function runRefreshCommand(options: RefreshCommandOptions = {}): Promise<void> {
  try {
    const changes = options.changed === undefined
      ? await readGitAutoChangedFiles(process.cwd())
      : createChangedOptionChanges(options.changed);
    const summary = await createRefreshSummary({
      command: 'refresh',
      source: options.changed === undefined ? 'git-auto' : 'changed-option',
      sources: changes.sources,
      changedFiles: changes.files,
      writeGenerated: options.dryRun !== true,
    });

    console.log(JSON.stringify(summary, undefined, 2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`refresh 失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 执行 status 命令。
 */
export async function runStatusCommand(): Promise<void> {
  try {
    const changes = await readGitAutoChangedFiles(process.cwd());
    const summary = await createRefreshSummary({
      command: 'status',
      source: 'git-auto',
      sources: changes.sources,
      changedFiles: changes.files,
      writeGenerated: false,
    });

    console.log(JSON.stringify(summary, undefined, 2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`status 失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建 refresh/status 摘要。
 *
 * @param input 摘要输入。
 * @returns refresh/status 摘要。
 */
async function createRefreshSummary(input: {
  readonly command: 'refresh' | 'status';
  readonly source: RefreshChangeSource;
  readonly sources: readonly RefreshChangeSourceDetail[];
  readonly changedFiles: readonly string[];
  readonly writeGenerated: boolean;
}): Promise<RefreshSummary> {
  const targetDirectory = process.cwd();
  const normalizedChanges = normalizeChangedFiles(targetDirectory, input.changedFiles);
  const targets = routeRefreshTargets(normalizedChanges.files);
  const skippedReason = resolveSkippedReason(input.changedFiles, normalizedChanges.files, targets);

  if (normalizedChanges.files.length === 0) {
    return {
      command: input.command,
      source: input.source,
      sources: input.sources,
      writeGenerated: input.writeGenerated,
      changedFiles: [],
      excludedFiles: normalizedChanges.excludedFiles,
      targets,
      actions: [],
      writes: [],
      skippedReason,
    };
  }

  const actions = input.writeGenerated ? [] : createDryRunActions(targets);
  const writes: string[] = [];

  if (input.writeGenerated && input.command === 'refresh') {
    await assertExistingVeawWorkspace(targetDirectory);

    if (targets.catalog.length > 0) {
      const catalogResult = await refreshCatalogGeneratedEntries({
        targetDirectory,
        changedFiles: targets.catalog,
        writeGenerated: true,
      });

      actions.push(createCatalogWriteAction(catalogResult));

      if (catalogResult.wrote) {
        writes.push(toProjectPath(targetDirectory, catalogResult.catalogPath));
      }
    }

    if (targets.context.length > 0) {
      await runContextGeneratedRefresh();
      actions.push({
        target: 'context',
        operation: 'refresh-generated-section',
        mode: 'write-generated',
        files: targets.context,
      });
      writes.push('.veaw/context.md');
    }
  }

  return {
    command: input.command,
    source: input.source,
    sources: input.sources,
    writeGenerated: input.writeGenerated && input.command === 'refresh',
    changedFiles: normalizedChanges.files,
    excludedFiles: normalizedChanges.excludedFiles,
    targets,
    actions,
    writes: [...new Set(writes)].sort((left, right) => left.localeCompare(right)),
    skippedReason,
  };
}

/**
 * 解析跳过原因。
 *
 * @param changedFiles 原始变更文件。
 * @param routedInputFiles 参与路由的文件。
 * @param targets 待刷新目标。
 * @returns 跳过原因或 null。
 */
function resolveSkippedReason(
  changedFiles: readonly string[],
  routedInputFiles: readonly string[],
  targets: RefreshTargets,
): RefreshSkippedReason | null {
  if (changedFiles.length === 0) {
    return 'no-changes';
  }

  if (routedInputFiles.length === 0 || (targets.catalog.length === 0 && targets.context.length === 0)) {
    return 'no-routed-targets';
  }

  return null;
}

/**
 * 创建 dry-run 动作摘要。
 *
 * @param targets 待刷新目标。
 * @returns 动作摘要。
 */
function createDryRunActions(targets: RefreshTargets): JsonObject[] {
  const actions: JsonObject[] = [];

  if (targets.catalog.length > 0) {
    actions.push({
      target: 'catalog',
      operation: 'refresh-component-entries',
      mode: 'dry-run',
      files: targets.catalog,
    });
  }

  if (targets.context.length > 0) {
    actions.push({
      target: 'context',
      operation: 'refresh-generated-section',
      mode: 'dry-run',
      files: targets.context,
    });
  }

  return actions;
}

/**
 * 创建 catalog 写入动作摘要。
 *
 * @param result catalog 增量刷新结果。
 * @returns 写入动作摘要。
 */
function createCatalogWriteAction(result: CatalogGeneratedRefreshResult): JsonObject {
  return {
    target: 'catalog',
    operation: 'refresh-component-entries',
    mode: 'write-generated',
    scannedFiles: result.scannedFiles,
    removedFiles: result.removedFiles,
    componentCount: result.componentCount,
    wrote: result.wrote,
  };
}

/**
 * 解析 --changed 选项。
 *
 * @param value changed 选项值。
 * @returns 变更文件。
 */
function parseChangedOption(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];

  return values.flatMap((item) => item.split(',')).map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * 创建 changed 选项变更集合。
 *
 * @param value changed 选项值。
 * @returns changed 选项变更集合。
 */
function createChangedOptionChanges(value: string | readonly string[] | undefined): GitAutoChanges {
  return {
    files: parseChangedOption(value),
    sources: ['changed-option'],
  };
}

/**
 * 读取 Git 自动检测变更文件。
 *
 * @param targetDirectory 项目根目录。
 * @returns Git 自动检测变更集合。
 */
async function readGitAutoChangedFiles(targetDirectory: string): Promise<GitAutoChanges> {
  const since = createTodayStartIsoString();
  const outputs = await Promise.all([
    readGitChangeSource(targetDirectory, 'working-tree', ['diff', '--name-only']),
    readGitChangeSource(targetDirectory, 'staged', ['diff', '--cached', '--name-only']),
    readGitChangeSource(targetDirectory, 'untracked', ['ls-files', '--others', '--exclude-standard']),
    readGitChangeSource(targetDirectory, 'git-today', ['log', `--since=${since}`, '--name-only', '--pretty=format:']),
  ]);

  return {
    files: uniqueSorted(outputs.flatMap((output) => output.files)),
    sources: outputs.map((output) => output.source),
  };
}

/**
 * 读取单个 Git 变更来源。
 *
 * @param targetDirectory 项目根目录。
 * @param source 变更来源。
 * @param args Git 参数。
 * @returns Git 来源变更文件。
 */
async function readGitChangeSource(
  targetDirectory: string,
  source: RefreshChangeSourceDetail,
  args: readonly string[],
): Promise<{ readonly source: RefreshChangeSourceDetail; readonly files: readonly string[] }> {
  return {
    source,
    files: splitOutputLines(await runGitCommand(targetDirectory, args)),
  };
}

/**
 * 执行 Git 命令。
 *
 * @param targetDirectory 项目根目录。
 * @param args Git 参数。
 * @returns Git 输出。
 */
async function runGitCommand(targetDirectory: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execa('git', args, {
      cwd: targetDirectory,
    });

    return result.stdout;
  } catch {
    return '';
  }
}

/**
 * 创建本地日期零点字符串。
 *
 * @returns ISO 日期时间字符串。
 */
function createTodayStartIsoString(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  return start.toISOString();
}

/**
 * 按行拆分输出。
 *
 * @param output 命令输出。
 * @returns 非空行。
 */
function splitOutputLines(output: string): readonly string[] {
  return output.split(/\r?\n/g).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * 标准化变更文件。
 *
 * @param targetDirectory 项目根目录。
 * @param changedFiles 原始变更文件。
 * @returns 标准化变更集合。
 */
function normalizeChangedFiles(targetDirectory: string, changedFiles: readonly string[]): NormalizedChanges {
  const files: string[] = [];
  const excludedFiles: ExcludedFile[] = [];

  for (const changedFile of changedFiles) {
    const normalizedFile = normalizeProjectPath(targetDirectory, changedFile);

    if (normalizedFile === undefined) {
      excludedFiles.push({
        path: changedFile,
        reason: 'outside-project',
      });
      continue;
    }

    const exclusionReason = getExclusionReason(normalizedFile);

    if (exclusionReason !== undefined) {
      excludedFiles.push({
        path: normalizedFile,
        reason: exclusionReason,
      });
      continue;
    }

    files.push(normalizedFile);
  }

  return {
    files: uniqueSorted(files),
    excludedFiles: uniqueExcludedFiles(excludedFiles),
  };
}

/**
 * 标准化项目路径。
 *
 * @param targetDirectory 项目根目录。
 * @param filePath 文件路径。
 * @returns 项目相对 POSIX 路径。
 */
function normalizeProjectPath(targetDirectory: string, filePath: string): string | undefined {
  const trimmedPath = filePath.trim().replace(/^['"]|['"]$/g, '');
  const normalizedInput = trimmedPath.replaceAll('\\', '/');
  const absolutePath = path.isAbsolute(trimmedPath) ? path.resolve(trimmedPath) : path.resolve(targetDirectory, normalizedInput);
  const relativePath = path.relative(targetDirectory, absolutePath);

  if (relativePath.length === 0 || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return normalizePath(relativePath);
}

/**
 * 获取路径排除原因。
 *
 * @param filePath 项目相对路径。
 * @returns 排除原因。
 */
function getExclusionReason(filePath: string): ExclusionReason | undefined {
  const lowerPath = filePath.toLowerCase();
  const segments = lowerPath.split('/');
  const fileName = segments.at(-1) ?? lowerPath;
  const extension = path.posix.extname(lowerPath);

  if (fileName === '.env' || fileName.startsWith('.env.')) {
    return 'environment-file';
  }

  if (SECRET_EXTENSIONS.includes(extension as (typeof SECRET_EXTENSIONS)[number]) || lowerPath.includes('secret')) {
    return 'secret-or-certificate';
  }

  if (segments.includes('.git')) {
    return 'git-directory';
  }

  if (segments.includes('node_modules')) {
    return 'dependency-directory';
  }

  if (segments.includes('dist') || segments.includes('build') || segments.includes('coverage')) {
    return 'build-output';
  }

  if (segments.includes(VEAW_DIRECTORY_NAME)) {
    return 'generated-directory';
  }

  return undefined;
}

/**
 * 路由刷新目标。
 *
 * @param changedFiles 标准化变更文件。
 * @returns 待刷新目标集合。
 */
function routeRefreshTargets(changedFiles: readonly string[]): RefreshTargets {
  return {
    catalog: changedFiles.filter(isCatalogInputPath),
    context: changedFiles.filter(isContextInputPath),
  };
}

/**
 * 判断是否为 catalog 输入路径。
 *
 * @param filePath 项目相对路径。
 * @returns 是否为 catalog 输入。
 */
function isCatalogInputPath(filePath: string): boolean {
  return (
    CATALOG_INPUT_ROOTS.some((root) => filePath.startsWith(`${root}/`)) &&
    COMPONENT_EXTENSIONS.some((extension) => filePath.endsWith(extension))
  );
}

/**
 * 判断是否为 context 输入路径。
 *
 * @param filePath 项目相对路径。
 * @returns 是否为 context 输入。
 */
function isContextInputPath(filePath: string): boolean {
  return CONTEXT_INPUT_FILES.includes(filePath as (typeof CONTEXT_INPUT_FILES)[number]) ||
    CONTEXT_INPUT_ROOTS.some((root) => filePath.startsWith(`${root}/`));
}

/**
 * 确认 .veaw 已存在，refresh 不执行 init。
 *
 * @param targetDirectory 项目根目录。
 */
async function assertExistingVeawWorkspace(targetDirectory: string): Promise<void> {
  if (!(await fs.pathExists(path.join(targetDirectory, VEAW_DIRECTORY_NAME)))) {
    throw new Error('未检测到 .veaw 工作区，refresh 不会执行 init、sync 或 migrate');
  }
}

/**
 * 运行现有 context 生成流程。
 */
async function runContextGeneratedRefresh(): Promise<void> {
  const previousExitCode = process.exitCode;

  try {
    process.exitCode = undefined;
    await withMutedConsole(runContextCommand);

    if (process.exitCode !== undefined && process.exitCode !== 0) {
      throw new Error('现有 context 生成流程执行失败');
    }
  } finally {
    process.exitCode = previousExitCode;
  }
}

/**
 * 静默执行回调。
 *
 * @param callback 回调。
 */
async function withMutedConsole(callback: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const mutedConsole = (...data: unknown[]): void => {
    void data;
  };

  console.log = mutedConsole;
  console.warn = mutedConsole;
  console.error = mutedConsole;

  try {
    await callback();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

/**
 * 转为项目相对路径。
 *
 * @param targetDirectory 项目根目录。
 * @param filePath 文件路径。
 * @returns 项目相对 POSIX 路径。
 */
function toProjectPath(targetDirectory: string, filePath: string): string {
  return normalizePath(path.relative(targetDirectory, filePath));
}

/**
 * 数组去重排序。
 *
 * @param values 原始数组。
 * @returns 去重排序数组。
 */
function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * 排除项去重。
 *
 * @param values 原始排除项。
 * @returns 去重排除项。
 */
function uniqueExcludedFiles(values: readonly ExcludedFile[]): readonly ExcludedFile[] {
  const seenKeys = new Set<string>();
  const results: ExcludedFile[] = [];

  for (const value of values) {
    const key = `${value.path}:${value.reason}`;

    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    results.push(value);
  }

  return results.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 标准化路径。
 *
 * @param filePath 文件路径。
 * @returns POSIX 路径。
 */
function normalizePath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/').replaceAll('\\', '/');
}
