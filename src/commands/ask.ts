import path from 'node:path';
import { Command } from 'commander';
import {
  createProjectProfileFromProjectJson,
  discoverWorkspace,
  readResourceContents,
  readWorkspaceRegistry,
} from '../resource-loader/index.js';
import type { ProjectProfile, ResourceContent } from '../resource-loader/index.js';
import { pathExists, readTextFile, writeTextFile } from '../utils/file.js';
import { logger } from '../utils/logger.js';

/**
 * ask 命令选项。
 */
interface AskCommandOptions {
  /**
   * 输出 AI 上下文包。
   */
  readonly prompt?: boolean;
  /**
   * 输出确定性回答任务。
   */
  readonly answer?: boolean;
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
  /**
   * Workspace prompt 资源内容。
   */
  readonly promptResources?: readonly ResourceContent[];
  /**
   * Workspace rule 资源内容。
   */
  readonly ruleResources?: readonly ResourceContent[];
  /**
   * Workspace skill 资源内容。
   */
  readonly skillResources?: readonly ResourceContent[];
}

/**
 * ask 直接回答输入。
 */
interface GenerateAnswerInput {
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
   * Workspace prompt 资源内容。
   */
  readonly promptResources?: readonly ResourceContent[];
  /**
   * Workspace rule 资源内容。
   */
  readonly ruleResources?: readonly ResourceContent[];
  /**
   * Workspace skill 资源内容。
   */
  readonly skillResources?: readonly ResourceContent[];
}

/**
 * JSON 对象。
 */
type JsonRecord = Readonly<Record<string, unknown>>;

/**
 * 项目能力摘要。
 */
interface ProjectAnswerSummary {
  /**
   * UI 库。
   */
  readonly uiLibraries: readonly string[];
  /**
   * 路由依赖包。
   */
  readonly routerPackages: readonly string[];
  /**
   * 路由目录。
   */
  readonly routerDirectories: readonly string[];
  /**
   * 状态管理依赖包。
   */
  readonly statePackages: readonly string[];
  /**
   * 状态管理目录。
   */
  readonly stateDirectories: readonly string[];
  /**
   * API 目录。
   */
  readonly apiDirectories: readonly string[];
  /**
   * service 目录。
   */
  readonly serviceDirectories: readonly string[];
  /**
   * 组件数量。
   */
  readonly componentCount?: number;
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
    .description('Generate an AI-ready context package or deterministic answer task from the .veaw workspace.')
    .argument('<question...>', 'Question to ask with project context.')
    .option('--prompt', 'Print the AI context package explicitly.')
    .option('--answer', 'Print a deterministic structured answer task without calling external AI.')
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
    const content = options.answer === true
      ? await createAskAnswer(process.cwd(), question)
      : await createAskPrompt(process.cwd(), question);

    console.log(content);

    if (options.output !== undefined) {
      await writeTextFile(path.resolve(process.cwd(), options.output), content);
      logger.success(`已写入 ${options.output}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`生成提示词失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建 ask 直接回答内容。
 *
 * @param targetDirectory 目标项目目录。
 * @param question 用户问题。
 * @returns 结构化回答任务。
 */
export async function createAskAnswer(targetDirectory: string, question: string): Promise<string> {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);

  if (!(await pathExists(veawDirectory))) {
    throw new Error('未检测到 .veaw 工作区，请先执行 veaw init');
  }

  const sourceFiles = await readPromptSourceFiles(veawDirectory);
  const workspaceResources = await readAskWorkspaceResources(
    targetDirectory,
    readProjectProfileFromContent(findSourceContent(sourceFiles, 'project.json')),
  );
  const missingFiles = sourceFiles
    .filter((sourceFile) => sourceFile.content === undefined)
    .map((sourceFile) => sourceFile.displayName);

  if (missingFiles.length > 0) {
    logger.warn(`已跳过缺失上下文文件：${missingFiles.join('、')}`);
  }

  return generateAskAnswer({
    question,
    contextContent: findSourceContent(sourceFiles, 'context.md'),
    projectContent: findSourceContent(sourceFiles, 'project.json'),
    catalogContent: findSourceContent(sourceFiles, 'component-catalog/catalog.json'),
    promptResources: workspaceResources.prompts,
    ruleResources: workspaceResources.rules,
    skillResources: workspaceResources.skills,
  });
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
  const workspaceResources = await readAskWorkspaceResources(
    targetDirectory,
    readProjectProfileFromContent(findSourceContent(sourceFiles, 'project.json')),
  );
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
    promptResources: workspaceResources.prompts,
    ruleResources: workspaceResources.rules,
    skillResources: workspaceResources.skills,
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
    '# AI 项目上下文包',
    '',
    '这是给 AI 使用的项目上下文包，不是模型已经回答后的最终答案。',
    '请将以下上下文交给 AI 后再回答用户问题，并优先给出可直接执行的方案或代码。',
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
    '## Workspace Prompts',
    '',
    createResourceSections(input.promptResources),
    '',
    '## Workspace Rules',
    '',
    createResourceSections(input.ruleResources),
    '',
    '## Workspace Skills',
    '',
    createResourceSections(input.skillResources),
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
 * 生成 ask 直接回答内容。
 *
 * @param input 直接回答输入。
 * @returns 结构化中文回答。
 */
export function generateAskAnswer(input: GenerateAnswerInput): string {
  const projectSummary = readProjectAnswerSummary(input.projectContent);
  const contextFacts = extractContextFactLines(input.contextContent);
  const componentCount = readCatalogComponentCount(input.catalogContent);
  const summary: ProjectAnswerSummary = {
    ...projectSummary,
    componentCount,
  };

  return [
    '# VEAW ask 回答任务',
    '',
    '说明：当前命令不调用第三方 AI API。以下内容基于已读取的 `.veaw/context.md`、`project.json`、组件 catalog 与可用 Workspace 资源生成；可确认事实会直接列出，不能确认的部分会标注为缺失上下文。',
    '',
    '## 用户问题',
    '',
    input.question,
    '',
    '## 结论',
    '',
    createAnswerConclusion(summary),
    '',
    '## 证据来源',
    '',
    createAnswerEvidence(summary, contextFacts, input),
    '',
    '## 缺失上下文',
    '',
    createAnswerMissingContext(summary, input),
    '',
    '## 保守建议',
    '',
    createAnswerSuggestions(summary),
    '',
  ].join('\n');
}

/**
 * 从 project.json 内容读取项目回答摘要。
 *
 * @param content project.json 内容。
 * @returns 项目回答摘要。
 */
function readProjectAnswerSummary(content: string | undefined): ProjectAnswerSummary {
  const projectJson = parseJsonRecord(content);
  const insights = readRecord(projectJson, 'projectInsights');

  return {
    uiLibraries: readStringArray(insights, 'uiLibraries'),
    routerPackages: readStringArray(readRecord(insights, 'router'), 'packages'),
    routerDirectories: readStringArray(readRecord(insights, 'router'), 'directories'),
    statePackages: readStringArray(readRecord(insights, 'stateManagement'), 'packages'),
    stateDirectories: readStringArray(readRecord(insights, 'stateManagement'), 'directories'),
    apiDirectories: readStringArray(readRecord(insights, 'apiDirectories'), 'paths'),
    serviceDirectories: readStringArray(readRecord(insights, 'serviceDirectories'), 'paths'),
  };
}

/**
 * 读取 catalog 中的组件数量。
 *
 * @param content catalog.json 内容。
 * @returns 组件数量。
 */
function readCatalogComponentCount(content: string | undefined): number | undefined {
  const catalog = parseJsonRecord(content);
  const components = catalog?.components;

  return Array.isArray(components) ? components.length : undefined;
}

/**
 * 从 context.md 提取核心事实行。
 *
 * @param content context.md 内容。
 * @returns 事实行。
 */
function extractContextFactLines(content: string | undefined): readonly string[] {
  if (content === undefined) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      [
        '- UI 库：',
        '- 依赖包：',
        '- 目录：',
        '- API 目录：',
        '- Service 目录：',
        '- 组件总数：',
      ].some((prefix) => line.startsWith(prefix)),
    );
}

/**
 * 创建回答结论。
 *
 * @param summary 项目回答摘要。
 * @returns Markdown 结论。
 */
function createAnswerConclusion(summary: ProjectAnswerSummary): string {
  return [
    `- UI 库：${formatList(summary.uiLibraries, '未检测到')}`,
    `- 路由：${formatList(summary.routerPackages, '未检测到')}；目录：${formatList(summary.routerDirectories, '未检测到')}`,
    `- 状态管理：${formatList(summary.statePackages, '未检测到')}；目录：${formatList(summary.stateDirectories, '未检测到')}`,
    `- API 目录：${formatList(summary.apiDirectories, '未检测到')}`,
    `- Service 目录：${formatList(summary.serviceDirectories, '未检测到')}`,
    `- 组件 catalog：${summary.componentCount === undefined ? '未检测到' : `${summary.componentCount} 个组件`}`,
  ].join('\n');
}

/**
 * 创建证据来源。
 *
 * @param summary 项目回答摘要。
 * @param contextFacts context.md 事实行。
 * @param input 直接回答输入。
 * @returns Markdown 证据。
 */
function createAnswerEvidence(
  summary: ProjectAnswerSummary,
  contextFacts: readonly string[],
  input: GenerateAnswerInput,
): string {
  const resourceLines = [
    createResourceEvidenceLine('Workspace Prompts', input.promptResources),
    createResourceEvidenceLine('Workspace Rules', input.ruleResources),
    createResourceEvidenceLine('Workspace Skills', input.skillResources),
  ];

  return [
    '- `.veaw/project.json`：读取 `projectInsights` 中的 UI、router、state、api/service 目录摘要。',
    `- \`.veaw/component-catalog/catalog.json\`：${
      summary.componentCount === undefined ? '未读取到组件列表。' : `读取到 ${summary.componentCount} 个组件条目。`
    }`,
    contextFacts.length > 0
      ? `- \`.veaw/context.md\`：包含 ${contextFacts.slice(0, 8).join('；')}。`
      : '- `.veaw/context.md`：未读取到可摘录的核心事实行。',
    ...resourceLines,
  ].join('\n');
}

/**
 * 创建缺失上下文说明。
 *
 * @param summary 项目回答摘要。
 * @param input 直接回答输入。
 * @returns Markdown 缺失项。
 */
function createAnswerMissingContext(summary: ProjectAnswerSummary, input: GenerateAnswerInput): string {
  const missing: string[] = [];

  if (input.contextContent === undefined) {
    missing.push('缺少 `.veaw/context.md`。');
  }

  if (input.projectContent === undefined) {
    missing.push('缺少 `.veaw/project.json`。');
  }

  if (input.catalogContent === undefined) {
    missing.push('缺少 `.veaw/component-catalog/catalog.json`。');
  }

  if (summary.apiDirectories.length === 0) {
    missing.push('未检测到 API 目录。');
  }

  if (summary.serviceDirectories.length === 0) {
    missing.push('未检测到 Service 目录。');
  }

  if (missing.length === 0) {
    return '- 暂无阻塞性缺失；仍建议结合源码确认具体路由、store、service 入口。';
  }

  return missing.map((item) => `- ${item}`).join('\n');
}

/**
 * 创建保守建议。
 *
 * @param summary 项目回答摘要。
 * @returns Markdown 建议。
 */
function createAnswerSuggestions(summary: ProjectAnswerSummary): string {
  const suggestions = [
    '实际开发前继续读取相关源码入口，避免只依据摘要修改代码。',
    '修改公共组件前先查看 catalog 中的 props、emits、slots 与依赖关系。',
  ];

  if (summary.serviceDirectories.length > 0) {
    suggestions.push(`接口调用优先从 ${summary.serviceDirectories.join('、')} 中查找既有封装。`);
  }

  if (summary.routerDirectories.length > 0) {
    suggestions.push(`路由注册优先从 ${summary.routerDirectories.join('、')} 中查找同类页面。`);
  }

  return suggestions.map((item) => `- ${item}`).join('\n');
}

/**
 * 创建 Workspace 资源证据行。
 *
 * @param label 资源标签。
 * @param resources 资源列表。
 * @returns Markdown 证据行。
 */
function createResourceEvidenceLine(label: string, resources: readonly ResourceContent[] | undefined): string {
  if (resources === undefined || resources.length === 0) {
    return `- ${label}：未发现可用资源。`;
  }

  return `- ${label}：${resources.map((resource) => resource.resource.id).join('、')}`;
}

/**
 * 格式化字符串列表。
 *
 * @param values 值列表。
 * @param fallback 空值兜底。
 * @returns 展示文本。
 */
function formatList(values: readonly string[], fallback: string): string {
  return values.length > 0 ? values.join(', ') : fallback;
}

/**
 * 解析 JSON 对象。
 *
 * @param content JSON 字符串。
 * @returns JSON 对象。
 */
function parseJsonRecord(content: string | undefined): JsonRecord | undefined {
  if (content === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as unknown;

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读取对象字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 对象字段。
 */
function readRecord(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];

  return isRecord(value) ? value : undefined;
}

/**
 * 读取字符串数组字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串数组。
 */
function readStringArray(record: JsonRecord | undefined, key: string): readonly string[] {
  const value = record?.[key];

  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 判断值是否为对象记录。
 *
 * @param value 待判断值。
 * @returns 是否为对象记录。
 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ask 需要的 Workspace 资源。
 */
interface AskWorkspaceResources {
  /**
   * prompts Registry 内容。
   */
  readonly prompts: readonly ResourceContent[];
  /**
   * rules Registry 内容。
   */
  readonly rules: readonly ResourceContent[];
  /**
   * skills Registry 内容。
   */
  readonly skills: readonly ResourceContent[];
}

/**
 * 读取 ask 需要的 Workspace Registry 资源。
 *
 * @param targetDirectory 目标项目目录。
 * @returns Workspace 资源。
 */
async function readAskWorkspaceResources(
  targetDirectory: string,
  profile: ProjectProfile | undefined,
): Promise<AskWorkspaceResources> {
  const location = await discoverWorkspace({
    projectDirectory: targetDirectory,
    environment: process.env,
  });

  if (location.kind !== 'workspace') {
    return {
      prompts: [],
      rules: [],
      skills: [],
    };
  }

  const registry = await readWorkspaceRegistry(location);

  return {
    prompts: await readResourceContents(registry, {
      types: ['prompt'],
      enabledOnly: true,
      profile,
    }),
    rules: await readResourceContents(registry, {
      types: ['rule'],
      enabledOnly: true,
      profile,
    }),
    skills: await readResourceContents(registry, {
      types: ['skill'],
      enabledOnly: true,
      profile,
    }),
  };
}

/**
 * 从 project.json 内容读取资源选择 profile。
 *
 * @param content project.json 内容。
 * @returns 项目 profile。
 */
function readProjectProfileFromContent(content: string | undefined): ProjectProfile | undefined {
  if (content === undefined) {
    return undefined;
  }

  try {
    return createProjectProfileFromProjectJson(JSON.parse(content) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * 创建 Registry 资源内容章节。
 *
 * @param resources Registry 资源内容。
 * @returns Markdown 内容。
 */
function createResourceSections(resources: readonly ResourceContent[] | undefined): string {
  if (resources === undefined || resources.length === 0) {
    return MISSING_SECTION_TEXT;
  }

  return resources
    .map((resource) =>
      [
        `### ${resource.resource.id}`,
        '',
        `- type：${resource.resource.type}`,
        `- version：${resource.resource.version}`,
        `- tags：${resource.resource.tags.join(', ')}`,
        '',
        '```markdown',
        resource.content.trim(),
        '```',
      ].join('\n'),
    )
    .join('\n\n');
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
