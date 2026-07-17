import path from 'node:path';
import { Command } from 'commander';
import {
  discoverWorkspace,
  readResourceContents,
  readWorkspaceRegistry,
} from '../resource-loader/index.js';
import type { ResourceContent } from '../resource-loader/index.js';
import { ensureDirectory, pathExists, readTextFile, writeTextFile } from '../utils/file.js';
import { logger } from '../utils/logger.js';

/**
 * plan 命令选项。
 */
interface PlanCommandOptions {
  /**
   * 输出文件路径。
   */
  readonly output?: string;
  /**
   * 是否仅输出到终端。
   */
  readonly dryRun?: boolean;
}

/**
 * 计划上下文文件。
 */
interface PlanSourceFile {
  /**
   * 文件显示名称。
   */
  readonly displayName: string;
  /**
   * 文件绝对路径。
   */
  readonly filePath: string;
  /**
   * 缺失时建议执行的补救命令。
   */
  readonly remedyCommand: string;
  /**
   * 文件内容。
   */
  readonly content?: string;
}

/**
 * 计划上下文内容。
 */
interface PlanContext {
  /**
   * context.md 内容。
   */
  readonly contextContent: string;
  /**
   * project.json 内容。
   */
  readonly projectContent: string;
  /**
   * component-catalog/catalog.json 内容。
   */
  readonly catalogContent: string;
}

/**
 * 计划模板输入。
 */
interface GeneratePlanTemplateInput extends PlanContext {
  /**
   * 需求原文。
   */
  readonly requirement: string;
  /**
   * Workspace workflow 资源内容。
   */
  readonly workflowResources?: readonly ResourceContent[];
  /**
   * Workspace template 资源内容。
   */
  readonly templateResources?: readonly ResourceContent[];
  /**
   * Workspace skill 资源内容。
   */
  readonly skillResources?: readonly ResourceContent[];
}

/**
 * 写入计划文件输入。
 */
interface WritePlanFileInput {
  /**
   * 项目根目录。
   */
  readonly targetDirectory: string;
  /**
   * 计划模板内容。
   */
  readonly content: string;
  /**
   * 输出文件路径。
   */
  readonly output?: string;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * 默认计划目录名。
 */
const PLAN_DIRECTORY_NAME = 'plans';

/**
 * 注册 plan 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description('Generate an AI implementation plan prompt template from the .veaw workspace.')
    .argument('<requirement...>', 'Development requirement to plan.')
    .option('-o, --output <file>', 'Write the generated plan template to a Markdown file.')
    .option('--dry-run', 'Print the generated plan template without writing a file.')
    .action(async (requirementParts: readonly string[], options: PlanCommandOptions): Promise<void> => {
      await runPlanCommand(requirementParts, options);
    });
}

/**
 * 执行 plan 命令。
 *
 * @param requirementParts 需求片段。
 * @param options 命令选项。
 */
export async function runPlanCommand(
  requirementParts: readonly string[],
  options: PlanCommandOptions = {},
): Promise<void> {
  try {
    const requirement = normalizeRequirement(requirementParts);
    const content = await createPlanTemplate(process.cwd(), requirement);

    if (options.dryRun === true) {
      console.log(content);
      logger.info('--dry-run 已启用，跳过写入计划文件');
      return;
    }

    const outputPath = await writePlanFile({
      targetDirectory: process.cwd(),
      content,
      output: options.output,
    });

    logger.success(`计划模板已写入 ${toDisplayPath(outputPath)}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`生成实施计划失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建计划模板。
 *
 * @param targetDirectory 目标项目目录。
 * @param requirement 需求原文。
 * @returns Markdown 计划模板。
 */
export async function createPlanTemplate(targetDirectory: string, requirement: string): Promise<string> {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);

  await ensureVeawWorkspace(veawDirectory);

  const planContext = await readPlanContext(veawDirectory);
  const workspaceResources = await readPlanWorkspaceResources(targetDirectory);

  return generatePlanTemplate({
    requirement,
    ...planContext,
    workflowResources: workspaceResources.workflows,
    templateResources: workspaceResources.templates,
    skillResources: workspaceResources.skills,
  });
}

/**
 * 生成计划模板。
 *
 * @param input 计划模板输入。
 * @returns Markdown 计划模板。
 */
export function generatePlanTemplate(input: GeneratePlanTemplateInput): string {
  return [
    '# AI 实施计划提示词模板',
    '',
    '你是一名资深前端工程师。当前版本不调用第三方 AI API，仅基于以下项目上下文，为需求生成结构化实施计划。',
    '',
    '## 1. 需求原文',
    '',
    input.requirement,
    '',
    '## 2. 项目背景和技术栈',
    '',
    '### .veaw/context.md',
    '',
    createFencedSection(input.contextContent, 'markdown'),
    '',
    '### .veaw/project.json',
    '',
    createFencedSection(input.projectContent, 'json'),
    '',
    '## 3. 相关现有组件与依赖关系',
    '',
    '请从组件目录中筛选与需求相关的组件、Props、Emits、Slots、依赖关系和潜在调用方。',
    '',
    createFencedSection(input.catalogContent, 'json'),
    '',
    '## 4. Workspace 工作流、模板与技能',
    '',
    '### Workflows',
    '',
    createResourceSections(input.workflowResources),
    '',
    '### Templates',
    '',
    createResourceSections(input.templateResources),
    '',
    '### Skills',
    '',
    createResourceSections(input.skillResources),
    '',
    '## 5. 推荐修改/新增文件',
    '',
    '请输出建议修改或新增的文件清单，并说明每个文件的职责：',
    '',
    '- 修改文件：',
    '- 新增文件：',
    '- 测试文件：',
    '- 文档或配置文件：',
    '',
    '## 6. 实施步骤',
    '',
    '请按可执行顺序拆分步骤，每一步说明目标、关键改动、涉及文件和验证方式。',
    '',
    '1. 上下文确认：',
    '2. 类型与数据结构设计：',
    '3. UI/组件调整：',
    '4. 业务逻辑或 composable 调整：',
    '5. 测试与验证：',
    '',
    '## 7. 风险、兼容性影响与验收标准',
    '',
    '请补全以下内容：',
    '',
    '- 风险点：',
    '- 兼容性影响：',
    '- 回归范围：',
    '- 验收标准：',
    '- 必跑命令：`pnpm run typecheck`、`pnpm run lint`、`pnpm run build`',
    '',
    '## 输出要求',
    '',
    '- 使用中文输出实施计划。',
    '- TypeScript 保持 strict，不使用 any，所有函数声明显式返回类型。',
    '- Vue 组件优先使用 `<script setup lang="ts">` 与 Composition API。',
    '- 修改代码时保持 Git Diff 最小，不修改无关代码。',
    '- 如果上下文不足，请明确列出缺口和需要用户补充的信息。',
    '',
  ].join('\n');
}

/**
 * plan 需要的 Workspace 资源。
 */
interface PlanWorkspaceResources {
  /**
   * workflows Registry 内容。
   */
  readonly workflows: readonly ResourceContent[];
  /**
   * templates Registry 内容。
   */
  readonly templates: readonly ResourceContent[];
  /**
   * skills Registry 内容。
   */
  readonly skills: readonly ResourceContent[];
}

/**
 * 读取 plan 需要的 Workspace Registry 资源。
 *
 * @param targetDirectory 目标项目目录。
 * @returns Workspace 资源。
 */
async function readPlanWorkspaceResources(targetDirectory: string): Promise<PlanWorkspaceResources> {
  const location = await discoverWorkspace({
    projectDirectory: targetDirectory,
    environment: process.env,
  });

  if (location.kind !== 'workspace') {
    return {
      workflows: [],
      templates: [],
      skills: [],
    };
  }

  const registry = await readWorkspaceRegistry(location);

  return {
    workflows: await readResourceContents(registry, {
      types: ['workflow'],
      enabledOnly: true,
    }),
    templates: await readResourceContents(registry, {
      types: ['template'],
      enabledOnly: true,
    }),
    skills: await readResourceContents(registry, {
      types: ['skill'],
      enabledOnly: true,
    }),
  };
}

/**
 * 创建 Registry 资源内容章节。
 *
 * @param resources Registry 资源内容。
 * @returns Markdown 内容。
 */
function createResourceSections(resources: readonly ResourceContent[] | undefined): string {
  if (resources === undefined || resources.length === 0) {
    return '未发现可用 Workspace Registry 资源，继续使用 CLI fallback 计划模板。';
  }

  return resources
    .map((resource) =>
      [
        `#### ${resource.resource.id}`,
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
 * 写入计划文件。
 *
 * @param input 写入计划文件输入。
 * @returns 写入文件绝对路径。
 */
export async function writePlanFile(input: WritePlanFileInput): Promise<string> {
  const outputPath = resolvePlanOutputPath(input.targetDirectory, input.output);

  if (await pathExists(outputPath)) {
    throw new Error(`计划文件已存在，已拒绝覆盖：${toDisplayPath(outputPath)}`);
  }

  await ensureDirectory(path.dirname(outputPath));
  await writeTextFile(outputPath, input.content);

  return outputPath;
}

/**
 * 确保 .veaw 工作区存在。
 *
 * @param veawDirectory .veaw 工作区目录。
 */
async function ensureVeawWorkspace(veawDirectory: string): Promise<void> {
  if (await pathExists(veawDirectory)) {
    return;
  }

  throw new Error(['未检测到 .veaw 工作区。', '请先执行补救命令：', 'veaw init'].join('\n'));
}

/**
 * 读取计划上下文。
 *
 * @param veawDirectory .veaw 工作区目录。
 * @returns 计划上下文内容。
 */
async function readPlanContext(veawDirectory: string): Promise<PlanContext> {
  const sourceFiles = await readPlanSourceFiles(veawDirectory);
  const missingFiles = sourceFiles.filter((sourceFile) => sourceFile.content === undefined);

  if (missingFiles.length > 0) {
    throw new Error(createMissingContextMessage(missingFiles));
  }

  return {
    contextContent: findRequiredSourceContent(sourceFiles, 'context.md'),
    projectContent: findRequiredSourceContent(sourceFiles, 'project.json'),
    catalogContent: findRequiredSourceContent(sourceFiles, 'component-catalog/catalog.json'),
  };
}

/**
 * 读取计划来源文件。
 *
 * @param veawDirectory .veaw 工作区目录。
 * @returns 计划来源文件列表。
 */
async function readPlanSourceFiles(veawDirectory: string): Promise<readonly PlanSourceFile[]> {
  const sourceFiles = createPlanSourceFileList(veawDirectory);
  const result: PlanSourceFile[] = [];

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
 * 创建计划来源文件列表。
 *
 * @param veawDirectory .veaw 工作区目录。
 * @returns 计划来源文件列表。
 */
function createPlanSourceFileList(veawDirectory: string): readonly PlanSourceFile[] {
  return [
    {
      displayName: 'context.md',
      filePath: path.join(veawDirectory, 'context.md'),
      remedyCommand: 'veaw context',
    },
    {
      displayName: 'project.json',
      filePath: path.join(veawDirectory, 'project.json'),
      remedyCommand: 'veaw sync',
    },
    {
      displayName: 'component-catalog/catalog.json',
      filePath: path.join(veawDirectory, 'component-catalog', 'catalog.json'),
      remedyCommand: 'veaw catalog',
    },
  ];
}

/**
 * 创建缺失上下文提示。
 *
 * @param missingFiles 缺失文件列表。
 * @returns 错误提示。
 */
function createMissingContextMessage(missingFiles: readonly PlanSourceFile[]): string {
  const displayNames = missingFiles.map((sourceFile) => sourceFile.displayName).join('、');
  const remedyCommands = uniqueStrings(missingFiles.map((sourceFile) => sourceFile.remedyCommand));

  return [
    `缺少必要上下文文件：${displayNames}`,
    '请先执行补救命令：',
    ...remedyCommands,
    '如果仍缺少工作区，请先执行 veaw init。',
  ].join('\n');
}

/**
 * 查找必要来源文件内容。
 *
 * @param sourceFiles 来源文件列表。
 * @param displayName 文件显示名称。
 * @returns 文件内容。
 */
function findRequiredSourceContent(sourceFiles: readonly PlanSourceFile[], displayName: string): string {
  const content = sourceFiles.find((sourceFile) => sourceFile.displayName === displayName)?.content;

  if (content === undefined) {
    throw new Error(`内部错误：未读取到 ${displayName}`);
  }

  return content;
}

/**
 * 解析计划输出路径。
 *
 * @param targetDirectory 目标项目目录。
 * @param output 用户指定输出路径。
 * @returns 输出文件绝对路径。
 */
function resolvePlanOutputPath(targetDirectory: string, output: string | undefined): string {
  if (output !== undefined) {
    return path.resolve(targetDirectory, output);
  }

  return path.join(targetDirectory, VEAW_DIRECTORY_NAME, PLAN_DIRECTORY_NAME, `${createTimestamp()}-plan.md`);
}

/**
 * 创建代码块章节。
 *
 * @param content 原始内容。
 * @param language 代码块语言。
 * @returns Markdown 代码块。
 */
function createFencedSection(content: string, language: string): string {
  return [`\`\`\`${language}`, content.trim(), '```'].join('\n');
}

/**
 * 规范化需求原文。
 *
 * @param requirementParts 需求片段。
 * @returns 需求原文。
 */
function normalizeRequirement(requirementParts: readonly string[]): string {
  const requirement = requirementParts.join(' ').trim();

  if (requirement.length === 0) {
    throw new Error('需求不能为空');
  }

  return requirement;
}

/**
 * 创建时间戳。
 *
 * @returns 文件名安全的时间戳。
 */
function createTimestamp(): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    padNumber(now.getMonth() + 1),
    padNumber(now.getDate()),
  ].join('');
  const time = [
    padNumber(now.getHours()),
    padNumber(now.getMinutes()),
    padNumber(now.getSeconds()),
    padNumber(now.getMilliseconds(), 3),
  ].join('');

  return `${date}-${time}`;
}

/**
 * 补齐数字。
 *
 * @param value 数字。
 * @param length 目标长度。
 * @returns 补齐后的字符串。
 */
function padNumber(value: number, length = 2): string {
  return value.toString().padStart(length, '0');
}

/**
 * 字符串去重。
 *
 * @param values 字符串列表。
 * @returns 去重后的字符串列表。
 */
function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
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
