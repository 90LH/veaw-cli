import { Command } from 'commander';
import inquirer from 'inquirer';
import { ensureDirectory, pathExists, writeJsonFile } from '../utils/file.js';
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
 * 初始化提问结果。
 */
interface InitAnswers {
  /**
   * 项目名称。
   */
  readonly name: string;
  /**
   * 是否创建模板目录。
   */
  readonly createTemplateDirectory: boolean;
}

/**
 * 项目元数据文件内容。
 */
interface ProjectMetadata {
  /**
   * 项目名称。
   */
  readonly name: string;
  /**
   * 创建工具名称。
   */
  readonly createdBy: string;
}

/**
 * 默认项目名称。
 */
const DEFAULT_PROJECT_NAME = 'veaw-app';

/**
 * 注册 init 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new Veaw project.')
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
  const answers = await resolveInitAnswers(options);
  const targetDirectory = process.cwd();
  const metadataPath = `${targetDirectory}/veaw.config.json`;

  if (await pathExists(metadataPath)) {
    logger.warn('veaw.config.json already exists. Initialization skipped.');
    return;
  }

  if (answers.createTemplateDirectory) {
    await ensureDirectory(`${targetDirectory}/templates`);
  }

  const metadata: ProjectMetadata = {
    name: answers.name,
    createdBy: 'veaw-cli',
  };

  await writeJsonFile(metadataPath, metadata);
  logger.success(`Initialized ${answers.name}.`);
}

/**
 * 获取 init 命令所需答案。
 *
 * @param options 初始化命令选项。
 * @returns 初始化答案。
 */
async function resolveInitAnswers(options: InitOptions): Promise<InitAnswers> {
  if (options.yes === true) {
    return {
      name: DEFAULT_PROJECT_NAME,
      createTemplateDirectory: true,
    };
  }

  return inquirer.prompt<InitAnswers>([
    {
      type: 'input',
      name: 'name',
      message: 'Project name:',
      default: DEFAULT_PROJECT_NAME,
    },
    {
      type: 'confirm',
      name: 'createTemplateDirectory',
      message: 'Create templates directory?',
      default: true,
    },
  ]);
}
