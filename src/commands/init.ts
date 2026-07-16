import path from 'node:path';
import { Command } from 'commander';
import inquirer from 'inquirer';
import {
  ensureDirectory,
  pathExists,
  readDirectory,
  writeJsonFile,
  writeTextFileIfNotExists,
} from '../utils/file.js';
import { logger } from '../utils/logger.js';

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
 * 继续初始化提问结果。
 */
interface ContinueAnswers {
  /**
   * 是否继续初始化。
   */
  readonly shouldContinue: boolean;
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
    const canContinue = await resolveCanContinue(context, options);

    if (!canContinue) {
      logger.warn('Initialization cancelled.');
      return;
    }

    const answers = await resolveInitAnswers(context, options);

    await createVeawProjectFiles(context, answers);

    logger.info('✅ Project initialized successfully');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`Failed to initialize project: ${message}`);
    process.exitCode = 1;
  }
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
  await ensureDirectory(path.join(context.veawDirectory, 'commands'));
  await ensureDirectory(path.join(context.veawDirectory, 'templates'));
  await ensureDirectory(path.join(context.veawDirectory, 'prompts'));
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
