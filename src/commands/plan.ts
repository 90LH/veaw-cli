import path from 'node:path';
import { Command } from 'commander';
import {
  createProjectProfileFromProjectJson,
  discoverWorkspace,
  readResourceContents,
  readWorkspaceRegistry,
} from '../resource-loader/index.js';
import type { ProjectProfile, ResourceContent } from '../resource-loader/index.js';
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
 * JSON 对象。
 */
type JsonRecord = Readonly<Record<string, unknown>>;

/**
 * 项目计划摘要。
 */
interface ProjectPlanSummary {
  /**
   * UI 库。
   */
  readonly uiLibraries: readonly string[];
  /**
   * 路由目录。
   */
  readonly routerDirectories: readonly string[];
  /**
   * 状态目录。
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
   * 组件目录。
   */
  readonly componentDirectories: readonly string[];
  /**
   * 布局目录。
   */
  readonly layoutDirectories: readonly string[];
}

/**
 * 计划组件摘要。
 */
interface PlanComponentSummary {
  /**
   * 组件名称。
   */
  readonly name: string;
  /**
   * 组件路径。
   */
  readonly filePath: string;
  /**
   * Props 数量。
   */
  readonly propsCount: number;
  /**
   * Emits 数量。
   */
  readonly emitsCount: number;
  /**
   * Slots 数量。
   */
  readonly slotsCount: number;
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
  readonly output: string;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * 注册 plan 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description('Generate an executable implementation plan from the .veaw workspace.')
    .argument('<requirement...>', 'Development requirement to plan.')
    .option('-o, --output <file>', 'Write the generated plan to a Markdown file.')
    .option('--dry-run', 'Print the generated plan without writing a file.')
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

    console.log(content);

    if (options.output === undefined) {
      logger.info(options.dryRun === true ? '--dry-run 已启用，未写入计划文件' : '默认 stdout-only，未写入计划文件');
      return;
    }

    const outputPath = await writePlanFile({
      targetDirectory: process.cwd(),
      content,
      output: options.output,
    });

    logger.success(`计划已写入 ${toDisplayPath(outputPath)}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`生成实施计划失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建计划。
 *
 * @param targetDirectory 目标项目目录。
 * @param requirement 需求原文。
 * @returns Markdown 计划。
 */
export async function createPlanTemplate(targetDirectory: string, requirement: string): Promise<string> {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);

  await ensureVeawWorkspace(veawDirectory);

  const planContext = await readPlanContext(veawDirectory);
  const workspaceResources = await readPlanWorkspaceResources(
    targetDirectory,
    readProjectProfileFromContent(planContext.projectContent),
  );

  return generatePlanTemplate({
    requirement,
    ...planContext,
    workflowResources: workspaceResources.workflows,
    templateResources: workspaceResources.templates,
    skillResources: workspaceResources.skills,
  });
}

/**
 * 生成计划。
 *
 * @param input 计划模板输入。
 * @returns Markdown 计划。
 */
export function generatePlanTemplate(input: GeneratePlanTemplateInput): string {
  const projectSummary = readProjectPlanSummary(input.projectContent);
  const reusableComponents = readReusableComponents(input.catalogContent);
  const confirmedContext = extractConfirmedContext(input.contextContent);
  const missingContext = createMissingPlanContext(projectSummary, confirmedContext);

  return [
    '# VEAW 实施计划',
    '',
    '说明：当前命令不调用第三方 AI API。本计划仅基于 `.veaw/context.md`、`project.json`、组件 catalog 与可用 Workspace 资源生成；无法从上下文确认的内容已标为待项目维护者确认。',
    '',
    '## 1. 需求原文',
    '',
    input.requirement,
    '',
    '## 2. 上下文结论',
    '',
    createProjectPlanSummaryMarkdown(projectSummary, reusableComponents),
    '',
    '## 3. 推荐修改/新增文件及职责',
    '',
    createRecommendedFilesMarkdown(projectSummary),
    '',
    '## 4. 路由、状态、service 与组件复用路径',
    '',
    createImplementationPathMarkdown(projectSummary, reusableComponents),
    '',
    '## 5. 分步骤实施内容',
    '',
    createImplementationStepsMarkdown(projectSummary),
    '',
    '## 6. 验证命令',
    '',
    '- `pnpm run typecheck`',
    '- `pnpm run lint`（如项目当前 lint 可用）',
    '- `pnpm run build`（涉及路由或页面入口时建议执行）',
    '',
    '## 7. 风险、兼容性与验收标准',
    '',
    createRiskAndAcceptanceMarkdown(projectSummary, missingContext),
    '',
    '## 8. 已确认约定与待确认事项',
    '',
    createContextConfirmationMarkdown(confirmedContext, missingContext),
    '',
    '## 9. Workspace 资源证据',
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
    '## 10. 原始上下文索引',
    '',
    '- `.veaw/context.md`：已读取',
    '- `.veaw/project.json`：已读取',
    '- `.veaw/component-catalog/catalog.json`：已读取',
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
async function readPlanWorkspaceResources(
  targetDirectory: string,
  profile: ProjectProfile | undefined,
): Promise<PlanWorkspaceResources> {
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
      profile,
    }),
    templates: await readResourceContents(registry, {
      types: ['template'],
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
function readProjectProfileFromContent(content: string): ProjectProfile | undefined {
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
 * 从 project.json 内容读取计划摘要。
 *
 * @param content project.json 内容。
 * @returns 项目计划摘要。
 */
function readProjectPlanSummary(content: string): ProjectPlanSummary {
  const projectJson = parseJsonRecord(content);
  const insights = readRecord(projectJson, 'projectInsights');

  return {
    uiLibraries: readStringArray(insights, 'uiLibraries'),
    routerDirectories: readStringArray(readRecord(insights, 'router'), 'directories'),
    stateDirectories: readStringArray(readRecord(insights, 'stateManagement'), 'directories'),
    apiDirectories: readStringArray(readRecord(insights, 'apiDirectories'), 'paths'),
    serviceDirectories: readStringArray(readRecord(insights, 'serviceDirectories'), 'paths'),
    componentDirectories: readStringArray(readRecord(insights, 'componentDirectories'), 'paths'),
    layoutDirectories: readStringArray(readRecord(insights, 'layoutDirectories'), 'paths'),
  };
}

/**
 * 从 catalog 内容读取可复用组件。
 *
 * @param content catalog.json 内容。
 * @returns 可复用组件摘要。
 */
function readReusableComponents(content: string): readonly PlanComponentSummary[] {
  const catalog = parseJsonRecord(content);
  const components = catalog.components;

  if (!Array.isArray(components)) {
    return [];
  }

  return components
    .filter(isRecord)
    .filter((component) => readString(component, 'filePath')?.startsWith('src/components/') === true)
    .slice(0, 8)
    .map((component) => ({
      name: readString(component, 'name') ?? 'Unknown',
      filePath: readString(component, 'filePath') ?? 'Unknown',
      propsCount: readArrayLength(component, 'props'),
      emitsCount: readArrayLength(component, 'emits'),
      slotsCount: readArrayLength(component, 'slots'),
    }));
}

/**
 * 提取已确认 context 行。
 *
 * @param content context.md 内容。
 * @returns 已确认上下文行。
 */
function extractConfirmedContext(content: string): readonly string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      [
        '- Vue 组件优先使用',
        '- TypeScript 保持',
        '- 组件负责 UI',
        '- 新增组件时',
        '- 修改公共组件前',
      ].some((prefix) => line.startsWith(prefix)),
    );
}

/**
 * 创建项目摘要 Markdown。
 *
 * @param summary 项目计划摘要。
 * @param components 可复用组件。
 * @returns Markdown 内容。
 */
function createProjectPlanSummaryMarkdown(
  summary: ProjectPlanSummary,
  components: readonly PlanComponentSummary[],
): string {
  return [
    `- UI 库：${formatList(summary.uiLibraries, '未检测到')}`,
    `- 路由目录：${formatList(summary.routerDirectories, '未检测到')}`,
    `- 状态目录：${formatList(summary.stateDirectories, '未检测到')}`,
    `- API 目录：${formatList(summary.apiDirectories, '未检测到')}`,
    `- Service 目录：${formatList(summary.serviceDirectories, '未检测到')}`,
    `- 组件目录：${formatList(summary.componentDirectories, '未检测到')}`,
    `- Layout 目录：${formatList(summary.layoutDirectories, '未检测到')}`,
    `- 可复用组件样例：${components.length === 0 ? '未检测到' : components.map((component) => component.name).join('、')}`,
  ].join('\n');
}

/**
 * 创建推荐文件 Markdown。
 *
 * @param summary 项目计划摘要。
 * @returns Markdown 内容。
 */
function createRecommendedFilesMarkdown(summary: ProjectPlanSummary): string {
  const viewRoot = summary.componentDirectories.length > 0 ? 'src/views' : 'src/views';
  const routerRoot = firstOrFallback(summary.routerDirectories, 'src/router');
  const stateRoot = firstOrFallback(summary.stateDirectories, 'src/store');
  const serviceRoot = firstOrFallback(summary.serviceDirectories, firstOrFallback(summary.apiDirectories, 'src/service'));

  return [
    `- 新增页面：\`${viewRoot}/<feature>/index.vue\`，负责页面 UI 与组合现有组件；\`<feature>\` 待项目维护者确认。`,
    `- 路由注册：优先检查 \`${routerRoot}\` 中同类页面注册方式，再添加新页面路由或元信息。`,
    `- 状态模块：如存在跨组件状态，建议放在 \`${stateRoot}/modules/<feature>.ts\` 或项目既有同类模块位置。`,
    `- 接口调用：优先在 \`${serviceRoot}\` 下查找同类 service/API 文件，新增 \`<feature>\` 请求封装。`,
    '- 测试文件：如项目已有页面或 service 测试约定，按同目录模式补充；当前上下文未确认测试目录。',
    '- 文档或配置：默认不新增；仅在路由菜单/权限需要配置且源码确认入口后修改。',
  ].join('\n');
}

/**
 * 创建实现路径 Markdown。
 *
 * @param summary 项目计划摘要。
 * @param components 可复用组件。
 * @returns Markdown 内容。
 */
function createImplementationPathMarkdown(
  summary: ProjectPlanSummary,
  components: readonly PlanComponentSummary[],
): string {
  const componentLines =
    components.length === 0
      ? ['- 组件复用：catalog 未提供可复用组件，请先读取源码确认。']
      : components.map(
          (component) =>
            `- 组件复用：\`${component.filePath}\`（${component.name}，${component.propsCount} props / ${component.emitsCount} emits / ${component.slotsCount} slots）`,
        );

  return [
    `- 路由：从 ${formatList(summary.routerDirectories, '待确认路由目录')} 查找注册入口，不直接猜测菜单/权限字段。`,
    `- 状态：从 ${formatList(summary.stateDirectories, '待确认状态目录')} 查找 Pinia/store 模块命名方式。`,
    `- Service：从 ${formatList([...summary.serviceDirectories, ...summary.apiDirectories], '待确认 service/API 目录')} 查找请求封装入口。`,
    ...componentLines,
  ].join('\n');
}

/**
 * 创建实施步骤 Markdown。
 *
 * @param summary 项目计划摘要。
 * @returns Markdown 内容。
 */
function createImplementationStepsMarkdown(summary: ProjectPlanSummary): string {
  return [
    '1. 上下文确认：读取同类页面、路由入口、store 模块和 service 文件；确认 `<feature>`、路由路径、菜单/权限要求。',
    '2. 类型与接口：定义请求参数、响应结构和页面状态类型；TypeScript strict 下不使用 `any`。',
    `3. Service：在 ${formatList([...summary.serviceDirectories, ...summary.apiDirectories], '已确认 service/API 目录')} 中复用既有请求封装，新增最小接口函数。`,
    `4. 状态：如需要跨页面或跨组件共享状态，在 ${formatList(summary.stateDirectories, '已确认状态目录')} 中按同类模块模式新增 Pinia/store 逻辑。`,
    '5. 页面：新增 Vue SFC，使用 `<script setup lang="ts">` 与 Composition API，复用 catalog 中的公共组件。',
    `6. 路由：在 ${formatList(summary.routerDirectories, '已确认路由目录')} 中按既有约定注册页面；权限/菜单字段必须从源码确认后再填写。`,
    '7. 验证：执行类型检查、必要 lint/build，并手动检查空数据、加载失败、接口异常等状态。',
  ].join('\n');
}

/**
 * 创建风险与验收 Markdown。
 *
 * @param summary 项目计划摘要。
 * @param missingContext 缺失上下文。
 * @returns Markdown 内容。
 */
function createRiskAndAcceptanceMarkdown(
  summary: ProjectPlanSummary,
  missingContext: readonly string[],
): string {
  return [
    '- 风险点：路由菜单/权限字段、service 请求入口、store 模块命名若未从源码确认，可能与项目约定不一致。',
    '- 兼容性影响：应只新增业务页面相关文件；避免修改公共组件和全局配置。',
    '- 回归范围：新增页面路由、接口封装、状态模块、被复用公共组件展示。',
    '- 验收标准：页面可访问；加载/空数据/错误态可用；类型检查通过；无未授权写入或无关 diff。',
    `- 阻塞项：${missingContext.length === 0 ? '暂无阻塞性缺失。' : missingContext.join('；')}`,
    `- 已检测目录覆盖：router=${formatList(summary.routerDirectories, '无')}，store=${formatList(summary.stateDirectories, '无')}，service/api=${formatList([...summary.serviceDirectories, ...summary.apiDirectories], '无')}`,
  ].join('\n');
}

/**
 * 创建 context 确认 Markdown。
 *
 * @param confirmedContext 已确认上下文。
 * @param missingContext 缺失上下文。
 * @returns Markdown 内容。
 */
function createContextConfirmationMarkdown(
  confirmedContext: readonly string[],
  missingContext: readonly string[],
): string {
  const confirmedLines =
    confirmedContext.length === 0
      ? ['- 未从 context.md 提取到人工确认约定。']
      : confirmedContext.map((line) => `- 已确认：${line.replace(/^- /, '')}`);
  const missingLines =
    missingContext.length === 0
      ? ['- 暂无必须补充项。']
      : missingContext.map((item) => `- 待项目维护者确认：${item}`);

  return [...confirmedLines, ...missingLines].join('\n');
}

/**
 * 创建计划缺失上下文。
 *
 * @param summary 项目计划摘要。
 * @param confirmedContext 已确认上下文。
 * @returns 缺失上下文列表。
 */
function createMissingPlanContext(
  summary: ProjectPlanSummary,
  confirmedContext: readonly string[],
): readonly string[] {
  const missing: string[] = [];

  if (summary.routerDirectories.length === 0) {
    missing.push('路由注册目录未检测到');
  }

  if (summary.stateDirectories.length === 0) {
    missing.push('状态管理目录未检测到');
  }

  if (summary.serviceDirectories.length === 0 && summary.apiDirectories.length === 0) {
    missing.push('service/API 目录未检测到');
  }

  if (confirmedContext.length === 0) {
    missing.push('人工维护约定未填写或未确认');
  }

  missing.push('新页面名称、路由路径、菜单/权限字段需确认');

  return missing;
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

  throw new Error('未指定输出文件路径；默认模式仅输出到 stdout。');
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
/**
 * 解析 JSON 对象。
 *
 * @param content JSON 字符串。
 * @returns JSON 对象。
 */
function parseJsonRecord(content: string): JsonRecord {
  const parsed = JSON.parse(content) as unknown;

  if (!isRecord(parsed)) {
    throw new Error('JSON 内容不是对象');
  }

  return parsed;
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
 * 读取字符串字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串字段。
 */
function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
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
 * 获取首个值或兜底值。
 *
 * @param values 值列表。
 * @param fallback 兜底值。
 * @returns 首个值或兜底值。
 */
function firstOrFallback(values: readonly string[], fallback: string): string {
  return values[0] ?? fallback;
}

/**
 * 读取数组长度。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 数组长度。
 */
function readArrayLength(record: JsonRecord, key: string): number {
  const value = record[key];

  return Array.isArray(value) ? value.length : 0;
}

/**
 * 判断值是否是对象记录。
 *
 * @param value 待判断值。
 * @returns 是否是对象记录。
 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
