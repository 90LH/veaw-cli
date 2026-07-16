import path from 'node:path';
import { Command } from 'commander';
import { pathExists, readTextFile, writeTextFile } from '../utils/file.js';
import { logger } from '../utils/logger.js';

/**
 * ask 命令选项。
 */
interface AskCommandOptions {
  /**
   * 输出文件路径。
   */
  readonly output?: string;
}

/**
 * 项目上下文文件。
 */
interface PromptSourceFile {
  /**
   * 文件显示名称。
   */
  readonly displayName: string;
  /**
   * 文件绝对路径。
   */
  readonly filePath: string;
  /**
   * 文件内容。
   */
  readonly content?: string;
}

/**
 * prompt 生成输入。
 */
interface GeneratePromptInput {
  /**
   * 用户问题。
   */
  readonly question: string;
  /**
   * context.md 内容。
   */
  readonly contextContent?: string;
  /**
   * project.json 内容。
   */
  readonly projectContent?: string;
  /**
   * component-catalog/catalog.json 内容。
   */
  readonly catalogContent?: string;
  /**
   * session-log.md 内容。
   */
  readonly sessionLogContent?: string;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * 缺失内容占位文本。
 */
const MISSING_SECTION_TEXT = '未提供对应上下文文件，请根据已有信息谨慎回答。';

/**
 * 注册 ask 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerAskCommand(program: Command): void {
  program
    .command('ask')
    .description('Generate an AI-ready project prompt from the .veaw workspace.')
    .argument('<question...>', 'Question to ask with project context.')
    .option('-o, --output <file>', 'Write the generated prompt to a file.')
    .action(async (questionParts: readonly string[], options: AskCommandOptions): Promise<void> => {
      await runAskCommand(questionParts, options);
    });
}

/**
 * 执行 ask 命令。
 *
 * @param questionParts 用户问题片段。
 * @param options 命令选项。
 */
export async function runAskCommand(
  questionParts: readonly string[],
  options: AskCommandOptions = {},
): Promise<void> {
  try {
    const question = normalizeQuestion(questionParts);
    const prompt = await createAskPrompt(process.cwd(), question);

    console.log(prompt);

    if (options.output !== undefined) {
      await writeTextFile(path.resolve(process.cwd(), options.output), prompt);
      logger.success(`已写入 ${options.output}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`生成提示词失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建 ask prompt。
 *
 * @param targetDirectory 目标项目目录。
 * @param question 用户问题。
 * @returns AI-ready prompt。
 */
export async function createAskPrompt(targetDirectory: string, question: string): Promise<string> {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);

  if (!(await pathExists(veawDirectory))) {
    throw new Error('未检测到 .veaw 工作区，请先执行 veaw init');
  }

  const sourceFiles = await readPromptSourceFiles(veawDirectory);
  const missingFiles = sourceFiles
    .filter((sourceFile) => sourceFile.content === undefined)
    .map((sourceFile) => sourceFile.displayName);

  if (missingFiles.length > 0) {
    logger.warn(`已跳过缺失上下文文件：${missingFiles.join('、')}`);
  }

  return generateAskPrompt({
    question,
    contextContent: findSourceContent(sourceFiles, 'context.md'),
    projectContent: findSourceContent(sourceFiles, 'project.json'),
    catalogContent: findSourceContent(sourceFiles, 'component-catalog/catalog.json'),
    sessionLogContent: findSourceContent(sourceFiles, 'session-log.md'),
  });
}

/**
 * 生成 AI-ready prompt。
 *
 * @param input prompt 生成输入。
 * @returns prompt 文本。
 */
export function generateAskPrompt(input: GeneratePromptInput): string {
  return [
    '# AI 项目上下文提示词',
    '',
    '你是一名资深前端工程师。请基于以下项目上下文回答用户问题，并优先给出可直接执行的方案或代码。',
    '',
    '## 项目背景',
    '',
    createFencedSection(input.contextContent, 'markdown'),
    '',
    '## 技术栈',
    '',
    createFencedSection(input.projectContent, 'json'),
    '',
    '## 组件目录',
    '',
    createFencedSection(input.catalogContent, 'json'),
    '',
    '## 历史会话摘要',
    '',
    createFencedSection(input.sessionLogContent, 'markdown'),
    '',
    '## 用户问题',
    '',
    input.question,
    '',
    '## 执行约束',
    '',
    '- 不调用第三方 AI API，仅基于提供的项目上下文进行分析。',
    '- 默认技术栈为 Vue 3、TypeScript strict、Vite、Pinia、Vue Router 4、VueUse、pnpm。',
    '- 优先使用 `<script setup lang="ts">`、Composition API 与 ES2023。',
    '- 禁止使用 any，优先使用 unknown；所有函数声明显式返回类型。',
    '- 组件负责 UI，Composable 负责业务逻辑；保持函数职责单一，避免重复代码。',
    '- 修改代码时保持最小化变更，不修改无关代码，并与现有代码风格一致。',
    '- 如果上下文不足，请先说明缺口，再给出保守建议。',
    '',
  ].join('\n');
}

/**
 * 读取 prompt 来源文件。
 *
 * @param veawDirectory .veaw 工作区目录。
 * @returns prompt 来源文件列表。
 */
async function readPromptSourceFiles(veawDirectory: string): Promise<readonly PromptSourceFile[]> {
  const sourceFiles = createPromptSourceFileList(veawDirectory);
  const result: PromptSourceFile[] = [];

  for (const sourceFile of sourceFiles) {
    if (!(await pathExists(sourceFile.filePath))) {
      result.push(sourceFile);
      continue;
    }

    result.push({
      ...sourceFile,
      content: await readTextFile(sourceFile.filePath),
    });
  }

  return result;
}

/**
 * 创建 prompt 来源文件列表。
 *
 * @param veawDirectory .veaw 工作区目录。
 * @returns prompt 来源文件列表。
 */
function createPromptSourceFileList(veawDirectory: string): readonly PromptSourceFile[] {
  return [
    {
      displayName: 'context.md',
      filePath: path.join(veawDirectory, 'context.md'),
    },
    {
      displayName: 'project.json',
      filePath: path.join(veawDirectory, 'project.json'),
    },
    {
      displayName: 'component-catalog/catalog.json',
      filePath: path.join(veawDirectory, 'component-catalog', 'catalog.json'),
    },
    {
      displayName: 'session-log.md',
      filePath: path.join(veawDirectory, 'session-log.md'),
    },
  ];
}

/**
 * 查找来源文件内容。
 *
 * @param sourceFiles 来源文件列表。
 * @param displayName 文件显示名称。
 * @returns 文件内容。
 */
function findSourceContent(sourceFiles: readonly PromptSourceFile[], displayName: string): string | undefined {
  return sourceFiles.find((sourceFile) => sourceFile.displayName === displayName)?.content;
}

/**
 * 创建代码块章节。
 *
 * @param content 原始内容。
 * @param language 代码块语言。
 * @returns Markdown 代码块。
 */
function createFencedSection(content: string | undefined, language: string): string {
  if (content === undefined || content.trim().length === 0) {
    return MISSING_SECTION_TEXT;
  }

  return [`\`\`\`${language}`, content.trim(), '```'].join('\n');
}

/**
 * 规范化用户问题。
 *
 * @param questionParts 用户问题片段。
 * @returns 用户问题。
 */
function normalizeQuestion(questionParts: readonly string[]): string {
  return questionParts.join(' ').trim();
}
