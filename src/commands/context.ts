import path from 'node:path';
import { Command } from 'commander';
import fs from 'fs-extra';
import {
  createProjectProfileFromProjectJson,
  discoverWorkspace,
  readResourceContents,
  readWorkspaceRegistry,
} from '../resource-loader/index.js';
import type { ProjectProfile, ResourceContent } from '../resource-loader/index.js';
import { logger } from '../utils/logger.js';
import { inspectProjectInsights } from '../utils/project-inspector.js';
import type {
  ProjectDependencyMap,
  ProjectDirectorySummary,
  ProjectFeatureSummary,
  ProjectInsightSummary,
} from '../utils/project-inspector.js';

/**
 * JSON 值。
 */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * JSON 对象。
 */
type JsonObject = Record<string, JsonValue>;

/**
 * 组件目录项。
 */
interface CatalogComponent {
  /**
   * 组件名称。
   */
  readonly name: string;
  /**
   * 组件类型。
   */
  readonly kind: string;
  /**
   * 组件文件路径。
   */
  readonly filePath: string;
  /**
   * Props 列表。
   */
  readonly props: readonly JsonObject[];
  /**
   * Emits 列表。
   */
  readonly emits: readonly JsonObject[];
  /**
   * Slots 列表。
   */
  readonly slots: readonly JsonObject[];
  /**
   * 依赖列表。
   */
  readonly dependencies: readonly JsonObject[];
}

/**
 * 组件统计。
 */
interface ComponentStats {
  /**
   * 组件总数。
   */
  readonly total: number;
  /**
   * Vue SFC 数量。
   */
  readonly vue: number;
  /**
   * TSX 数量。
   */
  readonly tsx: number;
  /**
   * JSX 数量。
   */
  readonly jsx: number;
  /**
   * Props 总数。
   */
  readonly props: number;
  /**
   * Emits 总数。
   */
  readonly emits: number;
  /**
   * Slots 总数。
   */
  readonly slots: number;
}

/**
 * 组件分类。
 */
interface ComponentCategories {
  /**
   * 通用组件。
   */
  readonly components: readonly CatalogComponent[];
  /**
   * 页面组件。
   */
  readonly views: readonly CatalogComponent[];
  /**
   * 布局组件。
   */
  readonly layouts: readonly CatalogComponent[];
  /**
   * 其它组件。
   */
  readonly others: readonly CatalogComponent[];
}

/**
 * context 命令上下文。
 */
interface ContextCommandContext {
  /**
   * 项目根目录。
   */
  readonly targetDirectory: string;
  /**
   * .veaw 工作区目录。
   */
  readonly veawDirectory: string;
  /**
   * project.json 路径。
   */
  readonly projectJsonPath: string;
  /**
   * catalog.json 路径。
   */
  readonly catalogJsonPath: string;
  /**
   * context.md 路径。
   */
  readonly contextPath: string;
}

/**
 * Workspace context 资源集合。
 */
interface WorkspaceContextResources {
  /**
   * 模板资源。
   */
  readonly templates: readonly ResourceContent[];
  /**
   * 规则资源。
   */
  readonly rules: readonly ResourceContent[];
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * 自动生成区域开始标记。
 */
const AUTO_CONTEXT_START = '<!-- VEAW_CONTEXT_START -->';

/**
 * 自动生成区域结束标记。
 */
const AUTO_CONTEXT_END = '<!-- VEAW_CONTEXT_END -->';

/**
 * 注册 context 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerContextCommand(program: Command): void {
  program
    .command('context')
    .description('Generate .veaw/context.md from project metadata and component catalog.')
    .action(async (): Promise<void> => {
      await runContextCommand();
    });
}

/**
 * 执行 context 命令。
 */
export async function runContextCommand(): Promise<void> {
  try {
    const context = await createContextCommandContext(process.cwd());
    const projectJson = await readJsonObject(context.projectJsonPath, 'project.json');
    const catalogJson = await readOptionalJsonObject(context.catalogJsonPath);
    const components = readCatalogComponents(catalogJson);
    const projectInsights = await inspectProjectInsights(context.targetDirectory, readProjectDependencies(projectJson));
    const resources = await readWorkspaceContextResources(
      context.targetDirectory,
      createProjectProfileFromProjectJson(projectJson),
    );
    const generatedContent = generateContextMarkdown(projectJson, components, projectInsights, resources);
    const nextContent = await mergeContextContent(context.contextPath, generatedContent);

    await fs.outputFile(context.contextPath, nextContent);

    logger.success('上下文生成完成');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`上下文生成失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 创建 context 命令上下文。
 *
 * @param targetDirectory 项目根目录。
 * @returns context 命令上下文。
 */
async function createContextCommandContext(targetDirectory: string): Promise<ContextCommandContext> {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);

  if (!(await fs.pathExists(veawDirectory))) {
    throw new Error('未检测到 .veaw 工作区，请先执行 veaw init');
  }

  return {
    targetDirectory,
    veawDirectory,
    projectJsonPath: path.join(veawDirectory, 'project.json'),
    catalogJsonPath: path.join(veawDirectory, 'component-catalog', 'catalog.json'),
    contextPath: path.join(veawDirectory, 'context.md'),
  };
}

/**
 * 读取 JSON 对象。
 *
 * @param filePath 文件路径。
 * @param displayName 展示名称。
 * @returns JSON 对象。
 */
async function readJsonObject(filePath: string, displayName: string): Promise<JsonObject> {
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`未找到 ${displayName}，请先执行 veaw sync`);
  }

  const content = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    throw new Error(`${displayName} 不是有效 JSON 对象`);
  }

  return sanitizeJsonObject(content);
}

/**
 * 读取可选 JSON 对象。
 *
 * @param filePath 文件路径。
 * @returns JSON 对象。
 */
async function readOptionalJsonObject(filePath: string): Promise<JsonObject | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  const content = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    throw new Error('component-catalog/catalog.json 不是有效 JSON 对象');
  }

  return sanitizeJsonObject(content);
}

/**
 * 读取组件目录项。
 *
 * @param catalogJson 组件目录 JSON。
 * @returns 组件目录项列表。
 */
function readCatalogComponents(catalogJson: JsonObject | undefined): readonly CatalogComponent[] {
  const components = catalogJson?.components;

  if (!Array.isArray(components)) {
    return [];
  }

  return components.filter(isRecord).map(readCatalogComponent);
}

/**
 * 从 project.json 摘要读取依赖表。
 *
 * @param projectJson project.json 内容。
 * @returns 依赖表。
 */
function readProjectDependencies(projectJson: JsonObject): ProjectDependencyMap {
  const packageJson = readObject(projectJson, 'packageJson');

  return {
    ...readStringRecord(packageJson, 'dependencies'),
    ...readStringRecord(packageJson, 'devDependencies'),
  };
}

/**
 * 读取组件目录项。
 *
 * @param component 组件对象。
 * @returns 组件目录项。
 */
function readCatalogComponent(component: Readonly<Record<string, unknown>>): CatalogComponent {
  return {
    name: readString(component, 'name') ?? 'Unknown',
    kind: readString(component, 'kind') ?? 'unknown',
    filePath: readString(component, 'filePath') ?? '',
    props: readJsonObjectArray(component, 'props'),
    emits: readJsonObjectArray(component, 'emits'),
    slots: readJsonObjectArray(component, 'slots'),
    dependencies: readJsonObjectArray(component, 'dependencies'),
  };
}

/**
 * 生成 context.md 自动内容。
 *
 * @param projectJson project.json 内容。
 * @param components 组件目录项。
 * @returns 自动生成 Markdown 内容。
 */
function generateContextMarkdown(
  projectJson: JsonObject,
  components: readonly CatalogComponent[],
  projectInsights: ProjectInsightSummary,
  resources: WorkspaceContextResources,
): string {
  const stats = createComponentStats(components);
  const categories = categorizeComponents(components);
  const generatedAt = new Date().toISOString();

  return [
    AUTO_CONTEXT_START,
    '<!-- 此区域由 veaw context 自动生成，请勿手动修改。 -->',
    '',
    '# VEAW Project Context',
    '',
    `> Generated at: ${generatedAt}`,
    '',
    '## 自动检测事实',
    '',
    '以下内容来自 `.veaw/project.json`、`.veaw/component-catalog/catalog.json`、package.json 与项目目录扫描；未从源码或配置确认的信息不会写成事实。',
    '',
    '## 项目简介',
    '',
    createProjectSummary(projectJson),
    '',
    '## 技术栈',
    '',
    createTechStack(projectJson),
    '',
    '## UI 库',
    '',
    createUiLibraryMarkdown(projectInsights),
    '',
    '## Router',
    '',
    createFeatureMarkdown(projectInsights.router),
    '',
    '## 状态管理',
    '',
    createFeatureMarkdown(projectInsights.stateManagement),
    '',
    '## API / Service 目录',
    '',
    createApiServiceDirectoriesMarkdown(projectInsights),
    '',
    '## Components 目录',
    '',
    createDirectorySummaryMarkdown(projectInsights.componentDirectories),
    '',
    '## Layout 目录',
    '',
    createDirectorySummaryMarkdown(projectInsights.layoutDirectories),
    '',
    '## 目录结构',
    '',
    createDirectoryStructure(components),
    '',
    '## 开发规范',
    '',
    createDevelopmentConventions(projectJson),
    '',
    '## 人工维护约定模板',
    '',
    createManualConventionGuide(),
    '',
    '## Workspace 模板',
    '',
    createResourceContentMarkdown(resources.templates),
    '',
    '## Workspace 规则',
    '',
    createResourceContentMarkdown(resources.rules),
    '',
    '## 组件统计',
    '',
    createComponentStatsMarkdown(stats),
    '',
    '## 组件分类',
    '',
    createComponentCategoriesMarkdown(categories),
    '',
    '## AI使用说明',
    '',
    createAiUsageGuide(),
    '',
    AUTO_CONTEXT_END,
    '',
  ].join('\n');
}

/**
 * 读取 Workspace context 资源。
 *
 * @param targetDirectory 项目根目录。
 * @returns Workspace context 资源。
 */
async function readWorkspaceContextResources(
  targetDirectory: string,
  profile: ProjectProfile | undefined,
): Promise<WorkspaceContextResources> {
  const location = await discoverWorkspace({
    projectDirectory: targetDirectory,
    environment: process.env,
  });

  if (location.kind !== 'workspace') {
    return {
      templates: [],
      rules: [],
    };
  }

  const registry = await readWorkspaceRegistry(location);

  return {
    templates: await readResourceContents(registry, {
      types: ['template'],
      tags: ['context', 'project'],
      enabledOnly: true,
      profile,
    }),
    rules: await readResourceContents(registry, {
      types: ['rule'],
      enabledOnly: true,
      profile,
    }),
  };
}

/**
 * 创建资源内容 Markdown。
 *
 * @param resources 资源内容列表。
 * @returns Markdown 内容。
 */
function createResourceContentMarkdown(resources: readonly ResourceContent[]): string {
  if (resources.length === 0) {
    return '- 当前未发现 Workspace Registry 资源，已使用 CLI fallback 内容。';
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
 * 合并 context.md 内容。
 *
 * @param contextPath context.md 路径。
 * @param generatedContent 自动生成内容。
 * @returns 合并后的内容。
 */
async function mergeContextContent(contextPath: string, generatedContent: string): Promise<string> {
  if (!(await fs.pathExists(contextPath))) {
    return generatedContent;
  }

  const currentContent = await fs.readFile(contextPath, 'utf8');
  const startIndex = currentContent.indexOf(AUTO_CONTEXT_START);
  const endIndex = currentContent.indexOf(AUTO_CONTEXT_END);

  if (startIndex >= 0 && endIndex > startIndex) {
    const beforeContent = currentContent.slice(0, startIndex).trimEnd();
    const afterContent = currentContent.slice(endIndex + AUTO_CONTEXT_END.length).trimStart();

    return joinContentParts([beforeContent, generatedContent.trimEnd(), afterContent]);
  }

  return joinContentParts([currentContent.trimEnd(), generatedContent.trimEnd()]);
}

/**
 * 拼接内容片段。
 *
 * @param parts 内容片段。
 * @returns 拼接后的内容。
 */
function joinContentParts(parts: readonly string[]): string {
  return `${parts.filter((part) => part.length > 0).join('\n\n')}\n`;
}

/**
 * 创建项目简介。
 *
 * @param projectJson project.json 内容。
 * @returns Markdown 内容。
 */
function createProjectSummary(projectJson: JsonObject): string {
  const name = readString(projectJson, 'name') ?? 'Unknown';
  const root = readString(projectJson, 'root') ?? 'Unknown';
  const packageJson = readObject(projectJson, 'packageJson');
  const packageVersion = packageJson === undefined ? undefined : readString(packageJson, 'version');
  const frameworks = readStringArray(projectJson, 'frameworks');

  return [
    `- 项目名称：${name}`,
    `- 项目路径：${root}`,
    `- 项目版本：${packageVersion ?? 'Unknown'}`,
    `- 主要框架：${frameworks.length > 0 ? frameworks.join(', ') : 'Unknown'}`,
  ].join('\n');
}

/**
 * 创建技术栈内容。
 *
 * @param projectJson project.json 内容。
 * @returns Markdown 内容。
 */
function createTechStack(projectJson: JsonObject): string {
  const packageManager = readString(projectJson, 'packageManager') ?? 'Unknown';
  const nodeVersion = readString(projectJson, 'nodeVersion') ?? 'Unknown';
  const typescript = readObject(projectJson, 'typescript');
  const vite = readObject(projectJson, 'vite');
  const git = readObject(projectJson, 'git');

  return [
    `- 包管理器：${packageManager}`,
    `- Node.js：${nodeVersion}`,
    `- TypeScript：${formatBooleanText(readBoolean(typescript, 'enabled'))}`,
    `- TypeScript 配置：${readString(typescript, 'configPath') ?? '未检测到'}`,
    `- Vite：${formatBooleanText(readBoolean(vite, 'detected'))}`,
    `- Vite 配置：${readString(vite, 'configPath') ?? '未检测到'}`,
    `- Git 分支：${readString(git, 'branch') ?? 'Unknown'}`,
  ].join('\n');
}

/**
 * 创建 UI 库 Markdown。
 *
 * @param projectInsights 项目结构洞察。
 * @returns Markdown 内容。
 */
function createUiLibraryMarkdown(projectInsights: ProjectInsightSummary): string {
  return `- UI 库：${formatList(projectInsights.uiLibraries, '未检测到')}`;
}

/**
 * 创建能力摘要 Markdown。
 *
 * @param feature 能力摘要。
 * @returns Markdown 内容。
 */
function createFeatureMarkdown(feature: ProjectFeatureSummary): string {
  return [
    `- 是否检测到：${formatBooleanText(feature.detected)}`,
    `- 依赖包：${formatList(feature.packages, '未检测到')}`,
    `- 目录：${formatList(feature.directories, '未检测到')}`,
  ].join('\n');
}

/**
 * 创建 API 与 service 目录 Markdown。
 *
 * @param projectInsights 项目结构洞察。
 * @returns Markdown 内容。
 */
function createApiServiceDirectoriesMarkdown(projectInsights: ProjectInsightSummary): string {
  return [
    `- API 目录：${formatList(projectInsights.apiDirectories.paths, '未检测到')}`,
    `- Service 目录：${formatList(projectInsights.serviceDirectories.paths, '未检测到')}`,
  ].join('\n');
}

/**
 * 创建目录摘要 Markdown。
 *
 * @param summary 目录摘要。
 * @returns Markdown 内容。
 */
function createDirectorySummaryMarkdown(summary: ProjectDirectorySummary): string {
  return [
    `- 是否检测到：${formatBooleanText(summary.detected)}`,
    `- 目录：${formatList(summary.paths, '未检测到')}`,
  ].join('\n');
}

/**
 * 格式化列表。
 *
 * @param values 列表值。
 * @param fallback 空列表展示文本。
 * @returns 展示文本。
 */
function formatList(values: readonly string[], fallback: string): string {
  return values.length > 0 ? values.join(', ') : fallback;
}

/**
 * 创建目录结构内容。
 *
 * @param components 组件目录项。
 * @returns Markdown 内容。
 */
function createDirectoryStructure(components: readonly CatalogComponent[]): string {
  const directories = new Map<string, number>();

  for (const component of components) {
    const directory = component.filePath.length > 0 ? path.posix.dirname(component.filePath) : '.';

    directories.set(directory, (directories.get(directory) ?? 0) + 1);
  }

  if (directories.size === 0) {
    return '- 暂未检测到组件目录结构。';
  }

  return [...directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, count]) => `- ${directory}：${count} 个组件`)
    .join('\n');
}

/**
 * 创建开发规范内容。
 *
 * @param projectJson project.json 内容。
 * @returns Markdown 内容。
 */
function createDevelopmentConventions(projectJson: JsonObject): string {
  const frameworks = readStringArray(projectJson, 'frameworks');
  const hasVue = frameworks.some((framework) => framework.toLowerCase().includes('vue'));
  const hasTypeScript = readBoolean(readObject(projectJson, 'typescript'), 'enabled') === true;

  return [
    hasVue ? '- Vue 组件优先使用 `<script setup lang="ts">` 与 Composition API。' : undefined,
    hasTypeScript ? '- TypeScript 保持 strict 风格，避免使用 any，优先使用明确类型。' : undefined,
    '- 组件负责 UI 展示，业务逻辑优先沉淀到 composable、service 或独立模块。',
    '- 新增组件时保持 Props、Emits、Slots 明确，便于 catalog 和 AI 理解。',
    '- 修改公共组件前先检查 component-catalog 中的依赖关系。',
  ]
    .filter((item): item is string => item !== undefined)
    .join('\n');
}

/**
 * 创建人工维护约定模板。
 *
 * @returns Markdown 内容。
 */
function createManualConventionGuide(): string {
  return [
    '- 新页面路由、菜单与权限注册方式：待项目维护者确认；填写时请标注证据文件。',
    '- Service 请求封装入口与 API 文件组织：待项目维护者确认；填写时请标注证据文件。',
    '- Pinia/store 模块命名与职责边界：待项目维护者确认；填写时请标注证据文件。',
    '- Composable、组件和页面职责边界：待项目维护者确认；填写时请标注证据文件。',
    '- 国际化、权限、错误处理与测试约定：待项目维护者确认；填写时请标注证据文件。',
  ].join('\n');
}

/**
 * 创建组件统计。
 *
 * @param components 组件目录项。
 * @returns 组件统计。
 */
function createComponentStats(components: readonly CatalogComponent[]): ComponentStats {
  return {
    total: components.length,
    vue: components.filter((component) => component.kind === 'vue').length,
    tsx: components.filter((component) => component.kind === 'tsx').length,
    jsx: components.filter((component) => component.kind === 'jsx').length,
    props: components.reduce((total, component) => total + component.props.length, 0),
    emits: components.reduce((total, component) => total + component.emits.length, 0),
    slots: components.reduce((total, component) => total + component.slots.length, 0),
  };
}

/**
 * 创建组件统计 Markdown。
 *
 * @param stats 组件统计。
 * @returns Markdown 内容。
 */
function createComponentStatsMarkdown(stats: ComponentStats): string {
  return [
    `- 组件总数：${stats.total}`,
    `- Vue SFC：${stats.vue}`,
    `- TSX：${stats.tsx}`,
    `- JSX：${stats.jsx}`,
    `- Props 总数：${stats.props}`,
    `- Emits 总数：${stats.emits}`,
    `- Slots 总数：${stats.slots}`,
  ].join('\n');
}

/**
 * 组件分类。
 *
 * @param components 组件目录项。
 * @returns 组件分类。
 */
function categorizeComponents(components: readonly CatalogComponent[]): ComponentCategories {
  return {
    components: components.filter((component) => component.filePath.startsWith('src/components/')),
    views: components.filter((component) => component.filePath.startsWith('src/views/')),
    layouts: components.filter((component) => component.filePath.startsWith('src/layouts/')),
    others: components.filter(
      (component) =>
        !component.filePath.startsWith('src/components/') &&
        !component.filePath.startsWith('src/views/') &&
        !component.filePath.startsWith('src/layouts/'),
    ),
  };
}

/**
 * 创建组件分类 Markdown。
 *
 * @param categories 组件分类。
 * @returns Markdown 内容。
 */
function createComponentCategoriesMarkdown(categories: ComponentCategories): string {
  return [
    createComponentCategoryMarkdown('通用组件', categories.components),
    createComponentCategoryMarkdown('页面组件', categories.views),
    createComponentCategoryMarkdown('布局组件', categories.layouts),
    createComponentCategoryMarkdown('其它组件', categories.others),
  ].join('\n\n');
}

/**
 * 创建单个组件分类 Markdown。
 *
 * @param title 分类标题。
 * @param components 组件列表。
 * @returns Markdown 内容。
 */
function createComponentCategoryMarkdown(title: string, components: readonly CatalogComponent[]): string {
  const header = `### ${title}`;

  if (components.length === 0) {
    return `${header}\n\n- 暂无`;
  }

  return `${header}\n\n${components
    .slice(0, 30)
    .map((component) => {
      const details = [
        `${component.props.length} props`,
        `${component.emits.length} emits`,
        `${component.slots.length} slots`,
      ].join(', ');

      return `- ${component.name}：${component.filePath}（${details}）`;
    })
    .join('\n')}`;
}

/**
 * 创建 AI 使用说明。
 *
 * @returns Markdown 内容。
 */
function createAiUsageGuide(): string {
  return [
    '- 回答项目问题前优先读取 `.veaw/project.json`、`.veaw/component-catalog/catalog.json` 与本文件。',
    '- 修改组件前先确认 Props、Emits、Slots 和依赖关系，避免破坏公共组件调用方。',
    '- 用户手写内容在自动生成区域外，应视为长期上下文，不要覆盖。',
    '- 自动生成区域可通过 `veaw context` 刷新，项目元信息可通过 `veaw sync` 刷新。',
  ].join('\n');
}

/**
 * 格式化布尔文本。
 *
 * @param value 布尔值。
 * @returns 展示文本。
 */
function formatBooleanText(value: boolean | undefined): string {
  if (value === true) {
    return '是';
  }

  if (value === false) {
    return '否';
  }

  return 'Unknown';
}

/**
 * 读取字符串字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串字段。
 */
function readString(record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * 读取布尔字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 布尔字段。
 */
function readBoolean(record: Readonly<Record<string, unknown>> | undefined, key: string): boolean | undefined {
  const value = record?.[key];

  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 读取对象字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 对象字段。
 */
function readObject(record: Readonly<Record<string, unknown>>, key: string): JsonObject | undefined {
  const value = record[key];

  return isJsonObject(value) ? value : undefined;
}

/**
 * 读取字符串数组字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串数组。
 */
function readStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 读取字符串记录字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串记录。
 */
function readStringRecord(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, string>> {
  const value = record?.[key];

  if (!isRecord(value)) {
    return {};
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
 * 读取 JSON 对象数组字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns JSON 对象数组。
 */
function readJsonObjectArray(record: Readonly<Record<string, unknown>>, key: string): readonly JsonObject[] {
  const value = record[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isJsonObject);
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

  return sanitizeJsonObject(value);
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
 * 判断值是否是 JSON 对象。
 *
 * @param value 待判断值。
 * @returns 是否是 JSON 对象。
 */
function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}
