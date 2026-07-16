import path from 'node:path';
import { Command } from 'commander';
import inquirer from 'inquirer';
import {
  ensureDirectory,
  pathExists,
  readDirectory,
  removeDirectory,
  writeJsonFile,
  writeTextFileIfNotExists,
} from '../utils/file.js';
import { logger } from '../utils/logger.js';
import { copyAssetsToWorkspace } from '../utils/template.js';

/**
 * 初始化命令选项。
 */
interface InitOptions {
  /**
   * 跳过交互式提问。
   */
  readonly yes?: boolean;
}

/**
 * 项目类型。
 */
type ProjectType = 'Vue3' | 'React' | 'Next.js' | 'Node' | 'Empty';

/**
 * 项目类型选项列表。
 */
const PROJECT_TYPE_CHOICES: readonly ProjectType[] = ['Vue3', 'React', 'Next.js', 'Node', 'Empty'];

/**
 * Veaw 配置版本号。
 */
const VEAW_CONFIG_VERSION = '0.1.0';

/**
 * Veaw 根目录名称。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * Veaw 配置文件名称。
 */
const VEAW_CONFIG_FILE_NAME = 'config.json';

/**
 * README 文件名称。
 */
const README_FILE_NAME = 'README.md';

/**
 * 默认项目类型。
 */
const DEFAULT_PROJECT_TYPE: ProjectType = 'Vue3';

/**
 * 已存在工作区的初始化动作。
 */
type ExistingWorkspaceAction = 'initMissing' | 'overwriteDefaults' | 'rebuild' | 'exit';

/**
 * 需要保留的分析数据路径。
 */
const PRESERVED_WORKSPACE_ITEMS = [
  'component-catalog',
  'context.md',
  'project.json',
  'session-log.md',
  VEAW_CONFIG_FILE_NAME,
] as const;

/**
 * 覆盖默认配置时仍需保留的分析数据路径。
 */
const PRESERVED_ANALYSIS_ITEMS = ['component-catalog', 'context.md', 'project.json', 'session-log.md'] as const;

/**
 * 默认目录名称列表。
 */
const DEFAULT_WORKSPACE_DIRECTORIES = ['prompts', 'templates', 'commands'] as const;

/**
 * 继续初始化提问结果。
 */
interface ContinueAnswers {
  /**
   * 是否继续初始化。
   */
  readonly shouldContinue: boolean;
}

/**
 * 已存在工作区动作提问结果。
 */
interface ExistingWorkspaceAnswers {
  /**
   * 工作区初始化动作。
   */
  readonly action: ExistingWorkspaceAction;
}

/**
 * 重建确认提问结果。
 */
interface RebuildConfirmAnswers {
  /**
   * 用户输入的确认文本。
   */
  readonly confirmation: string;
}

/**
 * 初始化提问结果。
 */
interface InitAnswers {
  /**
   * 项目名称。
   */
  readonly name: string;
  /**
   * 项目类型。
   */
  readonly projectType: ProjectType;
}

/**
 * Veaw 配置文件内容。
 */
interface VeawConfig {
  /**
   * 配置版本号。
   */
  readonly version: string;
  /**
   * 项目类型。
   */
  readonly projectType: ProjectType;
  /**
   * 创建时间。
   */
  readonly createdAt: string;
  /**
   * 已启用功能列表。
   */
  readonly features: readonly string[];
}

/**
 * 初始化上下文。
 */
interface InitContext {
  /**
   * 目标目录。
   */
  readonly targetDirectory: string;
  /**
   * 当前文件夹名称。
   */
  readonly defaultProjectName: string;
  /**
   * Veaw 根目录路径。
   */
  readonly veawDirectory: string;
  /**
   * Veaw 配置文件路径。
   */
  readonly configPath: string;
  /**
   * README 文件路径。
   */
  readonly readmePath: string;
}

/**
 * 注册 init 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Veaw in the current project.')
    .option('-y, --yes', 'Skip prompts and use default options.')
    .action(async (options: InitOptions): Promise<void> => {
      await runInitCommand(options);
    });
}

/**
 * 执行 init 命令。
 *
 * @param options 初始化命令选项。
 */
async function runInitCommand(options: InitOptions): Promise<void> {
  try {
    const context = createInitContext(process.cwd());

    if (await pathExists(context.veawDirectory)) {
      await runExistingWorkspaceInit(context, options);
      return;
    }

    await runFullInit(context, options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`Failed to initialize project: ${message}`);
    process.exitCode = 1;
  }
}

/**
 * 执行完整初始化。
 *
 * @param context 初始化上下文。
 * @param options 初始化命令选项。
 */
async function runFullInit(context: InitContext, options: InitOptions): Promise<void> {
  const canContinue = await resolveCanContinue(context, options);

  if (!canContinue) {
    logger.warn('Initialization cancelled.');
    return;
  }

  const answers = await resolveInitAnswers(context, options);

  await createVeawProjectFiles(context, answers);
  logger.success('初始化完成');
}

/**
 * 执行已存在工作区的增量初始化。
 *
 * @param context 初始化上下文。
 * @param options 初始化命令选项。
 */
async function runExistingWorkspaceInit(context: InitContext, options: InitOptions): Promise<void> {
  const action = await resolveExistingWorkspaceAction(options);

  if (action === 'exit') {
    logger.warn('Initialization cancelled.');
    return;
  }

  if (action === 'initMissing') {
    await logPreservedWorkspaceItems(context);
    await initializeMissingWorkspaceFiles(context);
    logger.success('初始化完成');
    return;
  }

  if (action === 'overwriteDefaults') {
    await logPreservedAnalysisItems(context);
    await overwriteDefaultWorkspaceFiles(context);
    logger.success('初始化完成');
    return;
  }

  await rebuildWorkspace(context, options);
}

/**
 * 创建初始化上下文。
 *
 * @param targetDirectory 目标目录。
 * @returns 初始化上下文。
 */
function createInitContext(targetDirectory: string): InitContext {
  const defaultProjectName = path.basename(targetDirectory);
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);

  return {
    targetDirectory,
    defaultProjectName,
    veawDirectory,
    configPath: path.join(veawDirectory, VEAW_CONFIG_FILE_NAME),
    readmePath: path.join(targetDirectory, README_FILE_NAME),
  };
}

/**
 * 获取已存在工作区的处理动作。
 *
 * @param options 初始化命令选项。
 * @returns 工作区处理动作。
 */
async function resolveExistingWorkspaceAction(options: InitOptions): Promise<ExistingWorkspaceAction> {
  if (options.yes === true) {
    return 'initMissing';
  }

  const answers = await inquirer.prompt<ExistingWorkspaceAnswers>([
    {
      type: 'list',
      name: 'action',
      message: '检测到已有 VEAW 工作区。请选择：',
      choices: [
        {
          name: '初始化缺失文件（推荐）',
          value: 'initMissing',
        },
        {
          name: '覆盖默认配置',
          value: 'overwriteDefaults',
        },
        {
          name: '完全重建 .veaw（危险）',
          value: 'rebuild',
        },
        {
          name: '退出',
          value: 'exit',
        },
      ],
      default: 'initMissing',
    },
  ]);

  return answers.action;
}

/**
 * 判断是否可以继续初始化。
 *
 * @param context 初始化上下文。
 * @param options 初始化命令选项。
 * @returns 是否继续初始化。
 */
async function resolveCanContinue(context: InitContext, options: InitOptions): Promise<boolean> {
  if (await isDirectoryEmpty(context.targetDirectory)) {
    return true;
  }

  const packageJsonPath = path.join(context.targetDirectory, 'package.json');

  if (!(await pathExists(packageJsonPath))) {
    return true;
  }

  if (options.yes === true) {
    return true;
  }

  const answers = await inquirer.prompt<ContinueAnswers>([
    {
      type: 'confirm',
      name: 'shouldContinue',
      message: 'package.json already exists. Continue initialization?',
      default: false,
    },
  ]);

  return answers.shouldContinue;
}

/**
 * 判断目录是否为空。
 *
 * @param directoryPath 目录路径。
 * @returns 目录是否为空。
 */
async function isDirectoryEmpty(directoryPath: string): Promise<boolean> {
  const entries = await readDirectory(directoryPath);

  return entries.length === 0;
}

/**
 * 获取 init 命令所需答案。
 *
 * @param context 初始化上下文。
 * @param options 初始化命令选项。
 * @returns 初始化答案。
 */
async function resolveInitAnswers(context: InitContext, options: InitOptions): Promise<InitAnswers> {
  if (options.yes === true) {
    return {
      name: context.defaultProjectName,
      projectType: DEFAULT_PROJECT_TYPE,
    };
  }

  return inquirer.prompt<InitAnswers>([
    {
      type: 'input',
      name: 'name',
      message: 'Project name:',
      default: context.defaultProjectName,
      validate(value: string): true | string {
        return value.trim().length > 0 ? true : 'Project name is required.';
      },
      filter(value: string): string {
        return value.trim();
      },
    },
    {
      type: 'list',
      name: 'projectType',
      message: 'Project Type:',
      choices: PROJECT_TYPE_CHOICES,
      default: DEFAULT_PROJECT_TYPE,
    },
  ]);
}

/**
 * 创建 Veaw 项目文件。
 *
 * @param context 初始化上下文。
 * @param answers 初始化答案。
 */
async function createVeawProjectFiles(context: InitContext, answers: InitAnswers): Promise<void> {
  await ensureDirectory(context.veawDirectory);
  await writeJsonFile(context.configPath, createVeawConfig(answers.projectType));
  await createReadmeIfNeeded(context.readmePath, answers.name);
  await ensureDefaultWorkspaceDirectories(context);
  await copyDefaultAssets(context);
}

/**
 * 初始化缺失的工作区文件。
 *
 * @param context 初始化上下文。
 */
async function initializeMissingWorkspaceFiles(context: InitContext): Promise<void> {
  await ensureDefaultWorkspaceDirectories(context);
  await createConfigIfMissing(context);
  await copyDefaultAssets(context);
}

/**
 * 覆盖默认工作区文件。
 *
 * @param context 初始化上下文。
 */
async function overwriteDefaultWorkspaceFiles(context: InitContext): Promise<void> {
  await ensureDefaultWorkspaceDirectories(context);
  await writeJsonFile(context.configPath, createVeawConfig(DEFAULT_PROJECT_TYPE));
  logger.success('覆盖 config.json');
  await copyDefaultAssets(context);
}

/**
 * 复制默认 assets 资源到工作区。
 *
 * @param context 初始化上下文。
 */
async function copyDefaultAssets(context: InitContext): Promise<void> {
  const result = await copyAssetsToWorkspace(context.veawDirectory);

  logger.success(
    `同步 assets：复制 ${result.copiedFiles} 个文件，跳过 ${result.skippedFiles} 个文件，创建 ${result.createdDirectories} 个目录`,
  );
}

/**
 * 重建工作区。
 *
 * @param context 初始化上下文。
 * @param options 初始化命令选项。
 */
async function rebuildWorkspace(context: InitContext, options: InitOptions): Promise<void> {
  const confirmed = await confirmWorkspaceRebuild(options);

  if (!confirmed) {
    logger.warn('Rebuild cancelled.');
    return;
  }

  await removeDirectory(context.veawDirectory);
  logger.warn('已删除 .veaw');

  const answers = await resolveInitAnswers(context, options);

  await createVeawProjectFiles(context, answers);
  logger.success('初始化完成');
}

/**
 * 确认是否重建工作区。
 *
 * @param options 初始化命令选项。
 * @returns 是否确认重建。
 */
async function confirmWorkspaceRebuild(options: InitOptions): Promise<boolean> {
  if (options.yes === true) {
    return false;
  }

  const answers = await inquirer.prompt<RebuildConfirmAnswers>([
    {
      type: 'input',
      name: 'confirmation',
      message: '确定删除整个 .veaw 吗？请输入 yes 确认：',
      default: '',
      filter(value: string): string {
        return value.trim();
      },
    },
  ]);

  return answers.confirmation === 'yes';
}

/**
 * 确保默认工作区目录存在。
 *
 * @param context 初始化上下文。
 */
async function ensureDefaultWorkspaceDirectories(context: InitContext): Promise<void> {
  for (const directoryName of DEFAULT_WORKSPACE_DIRECTORIES) {
    await ensureWorkspaceDirectory(context, directoryName);
  }
}

/**
 * 确保工作区目录存在。
 *
 * @param context 初始化上下文。
 * @param directoryName 目录名称。
 */
async function ensureWorkspaceDirectory(
  context: InitContext,
  directoryName: (typeof DEFAULT_WORKSPACE_DIRECTORIES)[number],
): Promise<void> {
  const directoryPath = path.join(context.veawDirectory, directoryName);

  if (await pathExists(directoryPath)) {
    logger.success(`保留 ${directoryName}`);
    return;
  }

  await ensureDirectory(directoryPath);
  logger.success(`创建 ${directoryName}`);
}

/**
 * 在配置文件缺失时创建默认配置。
 *
 * @param context 初始化上下文。
 */
async function createConfigIfMissing(context: InitContext): Promise<void> {
  if (await pathExists(context.configPath)) {
    return;
  }

  await writeJsonFile(context.configPath, createVeawConfig(DEFAULT_PROJECT_TYPE));
  logger.success('创建 config.json');
}

/**
 * 创建 Veaw 配置内容。
 *
 * @param projectType 项目类型。
 * @returns Veaw 配置内容。
 */
function createVeawConfig(projectType: ProjectType): VeawConfig {
  return {
    version: VEAW_CONFIG_VERSION,
    projectType,
    createdAt: new Date().toISOString(),
    features: [],
  };
}

/**
 * 在 README 不存在时创建 README。
 *
 * @param readmePath README 文件路径。
 * @param projectName 项目名称。
 */
async function createReadmeIfNeeded(readmePath: string, projectName: string): Promise<void> {
  const content = `# ${projectName}

Initialized with Veaw.
`;

  await writeTextFileIfNotExists(readmePath, content);
}

/**
 * 输出工作区保留项日志。
 *
 * @param context 初始化上下文。
 */
async function logPreservedWorkspaceItems(context: InitContext): Promise<void> {
  for (const itemName of PRESERVED_WORKSPACE_ITEMS) {
    const itemPath = path.join(context.veawDirectory, itemName);

    await logPreservedItemIfExists(itemPath, itemName);
  }
}

/**
 * 输出分析数据保留项日志。
 *
 * @param context 初始化上下文。
 */
async function logPreservedAnalysisItems(context: InitContext): Promise<void> {
  for (const itemName of PRESERVED_ANALYSIS_ITEMS) {
    const itemPath = path.join(context.veawDirectory, itemName);

    await logPreservedItemIfExists(itemPath, itemName);
  }
}

/**
 * 在路径存在时输出保留日志。
 *
 * @param itemPath 保留项路径。
 * @param itemName 保留项名称。
 */
async function logPreservedItemIfExists(itemPath: string, itemName: string): Promise<void> {
  if (await pathExists(itemPath)) {
    logger.success(`保留 ${itemName}`);
  }
}
