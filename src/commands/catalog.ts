import path from 'node:path';
import { Command } from 'commander';
import fs from 'fs-extra';
import {
  discoverWorkspace,
  readWorkspaceRegistry,
  selectResources,
} from '../resource-loader/index.js';
import type { WorkspaceResource } from '../resource-loader/index.js';
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
 * 支持的组件文件类型。
 */
type ComponentFileKind = 'vue' | 'tsx' | 'jsx';

/**
 * 组件分类。
 */
type ComponentCategory = 'shared' | 'page' | 'layout' | 'other';

/**
 * 依赖语义。
 */
type DependencyKind = 'internal-component' | 'internal-file' | 'external-package';

/**
 * 组件属性描述。
 */
interface ComponentProp {
  /**
   * 属性名称。
   */
  readonly name: string;
  /**
   * 属性类型。
   */
  readonly type?: string;
  /**
   * 是否必填。
   */
  readonly required: boolean;
  /**
   * 默认值。
   */
  readonly defaultValue?: string;
}

/**
 * 组件事件描述。
 */
interface ComponentEmit {
  /**
   * 事件名称。
   */
  readonly name: string;
  /**
   * 事件参数。
   */
  readonly payload?: string;
}

/**
 * 组件插槽描述。
 */
interface ComponentSlot {
  /**
   * 插槽名称。
   */
  readonly name: string;
  /**
   * 插槽属性。
   */
  readonly props?: string;
}

/**
 * 组件依赖描述。
 */
interface ComponentDependency {
  /**
   * 导入源。
   */
  readonly source: string;
  /**
   * 是否相对路径导入。
   */
  readonly relative: boolean;
  /**
   * 解析后的文件路径。
   */
  readonly resolvedPath?: string;
  /**
   * 是否指向已扫描组件。
   */
  readonly internal: boolean;
  /**
   * 依赖语义。
   */
  readonly dependencyKind?: DependencyKind;
}

/**
 * 组件目录项。
 */
interface CatalogComponent {
  /**
   * 稳定组件 ID。
   */
  readonly id: string;
  /**
   * 组件名称。
   */
  readonly name: string;
  /**
   * 组件文件类型。
   */
  readonly kind: ComponentFileKind;
  /**
   * 组件分类。
   */
  readonly category: ComponentCategory;
  /**
   * 组件运行语义。
   */
  readonly componentKind: ComponentCategory;
  /**
   * 文件路径。
   */
  readonly filePath: string;
  /**
   * Props 列表。
   */
  readonly props: readonly ComponentProp[];
  /**
   * Emits 列表。
   */
  readonly emits: readonly ComponentEmit[];
  /**
   * Slots 列表。
   */
  readonly slots: readonly ComponentSlot[];
  /**
   * 依赖关系列表。
   */
  readonly dependencies: readonly ComponentDependency[];
  /**
   * 是否为共享组件。
   */
  readonly isShared: boolean;
  /**
   * 组件使用提示。
   */
  readonly usageHints: readonly string[];
  /**
   * 引用当前组件的组件。
   */
  readonly usedBy?: readonly string[];
  /**
   * 更新时间。
   */
  readonly updatedAt: string;
}

/**
 * 组件目录文件。
 */
interface ComponentCatalog {
  /**
   * catalog 版本。
   */
  readonly version: string;
  /**
   * 创建时间。
   */
  readonly generatedAt: string;
  /**
   * 更新时间。
   */
  readonly updatedAt: string;
  /**
   * 扫描根目录。
   */
  readonly scanRoots: readonly string[];
  /**
   * Registry 中可用的 catalog 相关资源。
   */
  readonly availableResources: readonly CatalogResourceSummary[];
  /**
   * 组件列表。
   */
  readonly components: readonly CatalogComponent[];
}

/**
 * Catalog Registry 资源摘要。
 */
interface CatalogResourceSummary {
  /**
   * 资源 id。
   */
  readonly id: string;
  /**
   * 资源类型。
   */
  readonly type: string;
  /**
   * 资源版本。
   */
  readonly version: string;
  /**
   * 资源标签。
   */
  readonly tags: readonly string[];
  /**
   * 资源依赖。
   */
  readonly dependencies: readonly string[];
  /**
   * 是否默认启用。
   */
  readonly enabledByDefault: boolean;
  /**
   * 复制策略。
   */
  readonly copyPolicy: string;
  /**
   * 目标路径。
   */
  readonly targetPath: string;
}

/**
 * 目录上下文。
 */
interface CatalogContext {
  /**
   * 项目根目录。
   */
  readonly targetDirectory: string;
  /**
   * .veaw 目录。
   */
  readonly veawDirectory: string;
  /**
   * component-catalog 目录。
   */
  readonly componentCatalogDirectory: string;
  /**
   * catalog.json 路径。
   */
  readonly catalogPath: string;
}

/**
 * catalog 增量刷新输入。
 */
export interface CatalogGeneratedRefreshInput {
  /**
   * 项目根目录。
   */
  readonly targetDirectory: string;
  /**
   * 项目相对变更文件。
   */
  readonly changedFiles: readonly string[];
  /**
   * 是否写入 catalog 生成文件。
   */
  readonly writeGenerated: boolean;
}

/**
 * catalog 增量刷新结果。
 */
export interface CatalogGeneratedRefreshResult {
  /**
   * catalog.json 路径。
   */
  readonly catalogPath: string;
  /**
   * 实际分析的组件文件。
   */
  readonly scannedFiles: readonly string[];
  /**
   * 从 catalog 移除的组件文件。
   */
  readonly removedFiles: readonly string[];
  /**
   * catalog 中的组件数量。
   */
  readonly componentCount: number;
  /**
   * catalog 内容是否发生变化。
   */
  readonly changed: boolean;
  /**
   * 是否发生写入。
   */
  readonly wrote: boolean;
}

/**
 * 解析组件的上下文。
 */
interface AnalyzeContext {
  /**
   * 项目根目录。
   */
  readonly targetDirectory: string;
  /**
   * 已扫描组件路径集合。
   */
  readonly componentPathSet: ReadonlySet<string>;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * catalog 文件版本。
 */
const CATALOG_VERSION = '0.1.0';

/**
 * 扫描根目录。
 */
const SCAN_ROOTS = ['src/components', 'src/views', 'src/layouts'] as const;

/**
 * 支持的组件文件扩展名。
 */
const COMPONENT_EXTENSIONS = ['.vue', '.tsx', '.jsx'] as const;

/**
 * 已知可解析扩展名。
 */
const RESOLVABLE_EXTENSIONS = ['.vue', '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs'] as const;

/**
 * 注册 catalog 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerCatalogCommand(program: Command): void {
  program
    .command('catalog')
    .description('Scan Vue/TSX/JSX components into .veaw/component-catalog/catalog.json.')
    .action(async (): Promise<void> => {
      await runCatalogCommand();
    });
}

/**
 * 执行 catalog 命令。
 */
export async function runCatalogCommand(): Promise<void> {
  try {
    const context = createCatalogContext(process.cwd());
    const componentFiles = await scanComponentFiles(context.targetDirectory);
    const componentPathSet = new Set(
      componentFiles.map((filePath) => normalizePath(path.relative(context.targetDirectory, filePath))),
    );
    const analyzeContext: AnalyzeContext = {
      targetDirectory: context.targetDirectory,
      componentPathSet,
    };
    const components = await analyzeComponents(componentFiles, analyzeContext);
    const availableResources = await readCatalogRegistryResources(context.targetDirectory);
    const existingCatalog = await readExistingCatalog(context.catalogPath);
    const nextCatalog = mergeCatalog(existingCatalog, components, availableResources);
    const changed = !areJsonValuesEqual(existingCatalog, nextCatalog);

    if (changed) {
      await fs.ensureDir(context.componentCatalogDirectory);
      await fs.outputJson(context.catalogPath, nextCatalog, {
        spaces: 2,
      });
    }

    logger.success(`组件目录同步完成：${components.length} 个组件`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`组件目录生成失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 按变更文件增量刷新 catalog 生成项。
 *
 * @param input 增量刷新输入。
 * @returns 增量刷新结果。
 */
export async function refreshCatalogGeneratedEntries(
  input: CatalogGeneratedRefreshInput,
): Promise<CatalogGeneratedRefreshResult> {
  const context = createCatalogContext(input.targetDirectory);
  const existingCatalog = await readExistingCatalog(context.catalogPath);
  const changedComponentFiles = await resolveChangedComponentFiles(context.targetDirectory, input.changedFiles);
  const removedFiles = resolveRemovedComponentFiles(context.targetDirectory, input.changedFiles);
  const existingComponents = readExistingComponents(existingCatalog);
  const componentPathSet = new Set([
    ...readExistingComponentPaths(existingComponents),
    ...changedComponentFiles.map((filePath) => normalizePath(path.relative(context.targetDirectory, filePath))),
  ].filter((filePath) => !removedFiles.includes(filePath)));
  const analyzeContext: AnalyzeContext = {
    targetDirectory: context.targetDirectory,
    componentPathSet,
  };
  const changedComponents: CatalogComponent[] = [];

  for (const filePath of changedComponentFiles) {
    changedComponents.push(await analyzeComponent(filePath, analyzeContext));
  }

  const mergedComponents = stabilizeComponents(
    existingComponents,
    attachUsageMetadata(
      mergeIncrementalComponents(existingComponents, changedComponents, removedFiles).map((component) =>
        refreshDependencyMetadata(component, componentPathSet),
      ),
    ),
  );
  const nextCatalog = createCatalogObject(existingCatalog, mergedComponents, readExistingCatalogResources(existingCatalog));
  const changed = !areJsonValuesEqual(existingCatalog, nextCatalog);
  const wrote = input.writeGenerated && changed;

  if (wrote) {
    await fs.ensureDir(context.componentCatalogDirectory);
    await fs.outputJson(context.catalogPath, nextCatalog, {
      spaces: 2,
    });
  }

  return {
    catalogPath: context.catalogPath,
    scannedFiles: changedComponentFiles.map((filePath) => normalizePath(path.relative(context.targetDirectory, filePath))),
    removedFiles,
    componentCount: mergedComponents.length,
    changed,
    wrote,
  };
}

/**
 * 创建 catalog 上下文。
 *
 * @param targetDirectory 项目根目录。
 * @returns catalog 上下文。
 */
function createCatalogContext(targetDirectory: string): CatalogContext {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);
  const componentCatalogDirectory = path.join(veawDirectory, 'component-catalog');

  return {
    targetDirectory,
    veawDirectory,
    componentCatalogDirectory,
    catalogPath: path.join(componentCatalogDirectory, 'catalog.json'),
  };
}

/**
 * 读取 catalog 可用 Registry 资源。
 *
 * @param targetDirectory 项目根目录。
 * @returns catalog 资源摘要。
 */
async function readCatalogRegistryResources(targetDirectory: string): Promise<readonly CatalogResourceSummary[]> {
  const location = await discoverWorkspace({
    projectDirectory: targetDirectory,
    environment: process.env,
  });

  if (location.kind !== 'workspace') {
    return [];
  }

  const registry = await readWorkspaceRegistry(location);
  const resources = selectResources(registry.resources, {
    types: ['extension', 'extension-guide', 'extension-template', 'template'],
    tags: ['catalog'],
  });

  return resources.map(createCatalogResourceSummary);
}

/**
 * 创建 catalog 资源摘要。
 *
 * @param resource Workspace 资源。
 * @returns catalog 资源摘要。
 */
function createCatalogResourceSummary(resource: WorkspaceResource): CatalogResourceSummary {
  return {
    id: resource.id,
    type: resource.type,
    version: resource.version,
    tags: resource.tags,
    dependencies: resource.dependencies,
    enabledByDefault: resource.enabledByDefault,
    copyPolicy: resource.copyPolicy,
    targetPath: resource.targetPath,
  };
}

/**
 * 扫描组件文件。
 *
 * @param targetDirectory 项目根目录。
 * @returns 组件文件路径列表。
 */
async function scanComponentFiles(targetDirectory: string): Promise<readonly string[]> {
  const filePaths: string[] = [];

  for (const scanRoot of SCAN_ROOTS) {
    const rootPath = path.join(targetDirectory, scanRoot);

    if (!(await fs.pathExists(rootPath))) {
      continue;
    }

    filePaths.push(...(await walkComponentFiles(rootPath)));
  }

  return filePaths.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

/**
 * 递归遍历组件文件。
 *
 * @param directoryPath 目录路径。
 * @returns 组件文件路径列表。
 */
async function walkComponentFiles(directoryPath: string): Promise<readonly string[]> {
  const entries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      filePaths.push(...(await walkComponentFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && isComponentFile(entryPath)) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

/**
 * 判断是否是组件文件。
 *
 * @param filePath 文件路径。
 * @returns 是否是组件文件。
 */
function isComponentFile(filePath: string): boolean {
  return COMPONENT_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

/**
 * 分析组件列表。
 *
 * @param componentFiles 组件文件路径列表。
 * @param context 分析上下文。
 * @returns 组件目录项列表。
 */
async function analyzeComponents(
  componentFiles: readonly string[],
  context: AnalyzeContext,
): Promise<readonly CatalogComponent[]> {
  const components: CatalogComponent[] = [];

  for (const filePath of componentFiles) {
    components.push(await analyzeComponent(filePath, context));
  }

  return attachUsageMetadata(components);
}

/**
 * 分析单个组件。
 *
 * @param filePath 文件路径。
 * @param context 分析上下文。
 * @returns 组件目录项。
 */
async function analyzeComponent(filePath: string, context: AnalyzeContext): Promise<CatalogComponent> {
  const content = await fs.readFile(filePath, 'utf8');
  const kind = getComponentFileKind(filePath);
  const relativeFilePath = normalizePath(path.relative(context.targetDirectory, filePath));
  const scriptContent = kind === 'vue' ? stripComments(extractVueScriptContent(content)) : stripComments(content);
  const templateContent = kind === 'vue' ? extractVueTemplateContent(content) : '';
  const category = detectComponentCategory(relativeFilePath);
  const dependencies = detectDependencies(filePath, content, context);

  return {
    id: relativeFilePath,
    name: detectComponentName(filePath, scriptContent),
    kind,
    category,
    componentKind: category,
    filePath: relativeFilePath,
    props: detectProps(scriptContent, kind),
    emits: detectEmits(scriptContent),
    slots: detectSlots(scriptContent, templateContent, kind),
    dependencies,
    isShared: category === 'shared',
    usageHints: buildUsageHints(category, relativeFilePath, dependencies),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 添加组件使用方元数据。
 *
 * @param components 组件列表。
 * @returns 带使用方元数据的组件列表。
 */
function attachUsageMetadata(components: readonly CatalogComponent[]): readonly CatalogComponent[] {
  const usedByMap = new Map<string, string[]>();

  for (const component of components) {
    for (const dependency of component.dependencies) {
      if (dependency.internal !== true || dependency.resolvedPath === undefined) {
        continue;
      }

      const users = usedByMap.get(dependency.resolvedPath) ?? [];

      users.push(component.filePath);
      usedByMap.set(dependency.resolvedPath, users);
    }
  }

  return components.map((component) => {
    const usedBy = usedByMap.get(component.filePath);
    const componentWithoutUsedBy = removeUsedByMetadata(component);

    if (usedBy === undefined || usedBy.length === 0) {
      return componentWithoutUsedBy;
    }

    return {
      ...componentWithoutUsedBy,
      usedBy: [...new Set(usedBy)].sort((left, right) => left.localeCompare(right)),
    };
  });
}

/**
 * 移除旧 usedBy 元数据。
 *
 * @param component 组件目录项。
 * @returns 不含旧 usedBy 的组件目录项。
 */
function removeUsedByMetadata(component: CatalogComponent): CatalogComponent {
  const componentRecord = {
    ...toJsonObject(component),
  };

  delete componentRecord.usedBy;

  return componentRecord as unknown as CatalogComponent;
}

/**
 * 检测组件分类。
 *
 * @param relativeFilePath 项目相对路径。
 * @returns 组件分类。
 */
function detectComponentCategory(relativeFilePath: string): ComponentCategory {
  if (relativeFilePath.startsWith('src/components/')) {
    return 'shared';
  }

  if (relativeFilePath.startsWith('src/views/')) {
    return 'page';
  }

  if (relativeFilePath.startsWith('src/layouts/')) {
    return 'layout';
  }

  return 'other';
}

/**
 * 创建组件使用提示。
 *
 * @param category 组件分类。
 * @param relativeFilePath 项目相对路径。
 * @param dependencies 依赖列表。
 * @returns 使用提示。
 */
function buildUsageHints(
  category: ComponentCategory,
  relativeFilePath: string,
  dependencies: readonly ComponentDependency[],
): readonly string[] {
  const hints: string[] = [];

  if (category === 'shared') {
    hints.push('共享组件：复用前确认 props、emits、slots。');
  } else if (category === 'page') {
    hints.push('页面组件：优先作为同类业务页面参考。');
  } else if (category === 'layout') {
    hints.push('布局组件：修改前确认全局影响范围。');
  }

  if (dependencies.some((dependency) => dependency.dependencyKind === 'external-package')) {
    hints.push('包含外部包依赖：复用时确认依赖已在项目中安装。');
  }

  hints.push(`来源路径：${relativeFilePath}`);

  return hints;
}

/**
 * 获取组件文件类型。
 *
 * @param filePath 文件路径。
 * @returns 组件文件类型。
 */
function getComponentFileKind(filePath: string): ComponentFileKind {
  if (filePath.endsWith('.vue')) {
    return 'vue';
  }

  if (filePath.endsWith('.tsx')) {
    return 'tsx';
  }

  return 'jsx';
}

/**
 * 提取 Vue SFC script 内容。
 *
 * @param content 文件内容。
 * @returns script 内容。
 */
function extractVueScriptContent(content: string): string {
  const scripts: string[] = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of content.matchAll(scriptRegex)) {
    scripts.push(match[1] ?? '');
  }

  return scripts.join('\n');
}

/**
 * 提取 Vue SFC template 内容。
 *
 * @param content 文件内容。
 * @returns template 内容。
 */
function extractVueTemplateContent(content: string): string {
  const match = /<template\b[^>]*>([\s\S]*?)<\/template>/i.exec(content);

  return match?.[1] ?? '';
}

/**
 * 去除 TypeScript/JavaScript 注释，避免 JSDoc、URL 或普通注释被结构解析器误读。
 *
 * @param content 原始内容。
 * @returns 去除注释后的内容。
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 检测组件名称。
 *
 * @param filePath 文件路径。
 * @param scriptContent script 内容。
 * @returns 组件名称。
 */
function detectComponentName(filePath: string, scriptContent: string): string {
  const defineOptionsName = /defineOptions\s*\(\s*\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(scriptContent);

  if (defineOptionsName?.[1] !== undefined) {
    return defineOptionsName[1];
  }

  const exportDefaultName = /export\s+default\s+(?:defineComponent\s*\(\s*)?\{[\s\S]*?\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(
    scriptContent,
  );

  if (exportDefaultName?.[1] !== undefined) {
    return exportDefaultName[1];
  }

  const functionName = /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/.exec(scriptContent);

  if (functionName?.[1] !== undefined) {
    return functionName[1];
  }

  return fallbackComponentName(filePath);
}

/**
 * 获取兜底组件名。
 *
 * @param filePath 文件路径。
 * @returns 组件名。
 */
function fallbackComponentName(filePath: string): string {
  const baseName = path.basename(filePath, path.extname(filePath));

  if (baseName.toLowerCase() !== 'index') {
    return toPascalCase(baseName);
  }

  return toPascalCase(path.basename(path.dirname(filePath)));
}

/**
 * 检测 Props。
 *
 * @param scriptContent script 内容。
 * @param kind 组件文件类型。
 * @returns Props 列表。
 */
function detectProps(scriptContent: string, kind: ComponentFileKind): readonly ComponentProp[] {
  const props = new Map<string, ComponentProp>();

  for (const prop of detectDefineProps(scriptContent)) {
    props.set(prop.name, prop);
  }

  if (kind !== 'vue') {
    for (const prop of detectTsxProps(scriptContent)) {
      props.set(prop.name, prop);
    }
  }

  return sortByName([...props.values()]);
}

/**
 * 检测 defineProps。
 *
 * @param scriptContent script 内容。
 * @returns Props 列表。
 */
function detectDefineProps(scriptContent: string): readonly ComponentProp[] {
  const props: ComponentProp[] = [];
  const genericExpression = readCallGeneric(scriptContent, 'defineProps');

  if (genericExpression !== undefined) {
    props.push(...parseTypeProps(resolveTypeExpression(scriptContent, genericExpression)));
  }

  const argumentExpression = readCallArgument(scriptContent, 'defineProps');

  if (argumentExpression !== undefined && argumentExpression.trim().startsWith('{')) {
    props.push(...parseObjectProps(argumentExpression));
  }

  return props;
}

/**
 * 检测 TSX/JSX Props。
 *
 * @param scriptContent script 内容。
 * @returns Props 列表。
 */
function detectTsxProps(scriptContent: string): readonly ComponentProp[] {
  const propsTypeName = detectPropsTypeName(scriptContent);

  if (propsTypeName === undefined) {
    return [];
  }

  return parseTypeProps(resolveTypeExpression(scriptContent, propsTypeName));
}

/**
 * 检测 props 类型名。
 *
 * @param scriptContent script 内容。
 * @returns props 类型名。
 */
function detectPropsTypeName(scriptContent: string): string | undefined {
  const fcGeneric = /(?:React\.)?(?:FC|FunctionComponent)<\s*([A-Za-z_$][\w$]*)\s*>/.exec(scriptContent);

  if (fcGeneric?.[1] !== undefined) {
    return fcGeneric[1];
  }

  const functionParam = /function\s+[A-Z][A-Za-z0-9_]*\s*\(\s*[^:)]*\s*:\s*([A-Za-z_$][\w$]*)/.exec(scriptContent);

  if (functionParam?.[1] !== undefined) {
    return functionParam[1];
  }

  const arrowParam = /(?:const|let)\s+[A-Z][A-Za-z0-9_]*\s*=\s*\(\s*[^:)]*\s*:\s*([A-Za-z_$][\w$]*)/.exec(
    scriptContent,
  );

  return arrowParam?.[1];
}

/**
 * 读取调用泛型。
 *
 * @param content 内容。
 * @param callee 调用函数名。
 * @returns 泛型表达式。
 */
function readCallGeneric(content: string, callee: string): string | undefined {
  const calleeIndex = content.indexOf(`${callee}<`);

  if (calleeIndex < 0) {
    return undefined;
  }

  const genericStart = calleeIndex + callee.length;
  const genericEnd = findMatchingToken(content, genericStart, '<', '>');

  if (genericEnd < 0) {
    return undefined;
  }

  return content.slice(genericStart + 1, genericEnd).trim();
}

/**
 * 读取调用第一个参数。
 *
 * @param content 内容。
 * @param callee 调用函数名。
 * @returns 参数表达式。
 */
function readCallArgument(content: string, callee: string): string | undefined {
  const calleeIndex = content.indexOf(`${callee}(`);

  if (calleeIndex < 0) {
    return undefined;
  }

  const argumentStart = calleeIndex + callee.length;
  const argumentEnd = findMatchingToken(content, argumentStart, '(', ')');

  if (argumentEnd < 0) {
    return undefined;
  }

  return content.slice(argumentStart + 1, argumentEnd).trim();
}

/**
 * 查找匹配 token。
 *
 * @param content 内容。
 * @param openIndex 开始 token 下标。
 * @param openToken 开始 token。
 * @param closeToken 结束 token。
 * @returns 匹配 token 下标。
 */
function findMatchingToken(content: string, openIndex: number, openToken: string, closeToken: string): number {
  let depth = 0;
  let quote: string | undefined;

  for (let index = openIndex; index < content.length; index += 1) {
    const current = content[index];
    const previous = content[index - 1];

    if (quote !== undefined) {
      if (current === quote && previous !== '\\') {
        quote = undefined;
      }

      continue;
    }

    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }

    if (current === openToken) {
      depth += 1;
      continue;
    }

    if (current === closeToken) {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

/**
 * 解析类型 Props。
 *
 * @param typeExpression 类型表达式。
 * @returns Props 列表。
 */
function parseTypeProps(typeExpression: string | undefined): readonly ComponentProp[] {
  if (typeExpression === undefined) {
    return [];
  }

  const trimmedExpression = stripOuterBraces(typeExpression.trim());
  const props: ComponentProp[] = [];
  const propertyRegex = /(?:readonly\s+)?['"]?([A-Za-z_$][\w$-]*)['"]?(\?)?\s*:\s*([^;\n]+)[;\n]?/g;

  for (const match of trimmedExpression.matchAll(propertyRegex)) {
    const name = match[1];
    const optionalMark = match[2];
    const type = match[3]?.trim();

    if (name === undefined) {
      continue;
    }

    props.push({
      name,
      type,
      required: optionalMark !== '?',
    });
  }

  return props;
}

/**
 * 解析对象形式 Props。
 *
 * @param objectExpression 对象表达式。
 * @returns Props 列表。
 */
function parseObjectProps(objectExpression: string): readonly ComponentProp[] {
  const props: ComponentProp[] = [];
  const body = stripOuterBraces(objectExpression.trim());

  for (const entry of splitTopLevel(body, ',')) {
    const match = /^\s*['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*([\s\S]+?)\s*$/.exec(entry);

    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }

    props.push({
      name: match[1],
      type: detectObjectPropType(match[2]),
      required: /\brequired\s*:\s*true\b/.test(match[2]),
      defaultValue: detectObjectPropDefault(match[2]),
    });
  }

  return props;
}

/**
 * 检测对象 Props 类型。
 *
 * @param expression Props 表达式。
 * @returns 类型。
 */
function detectObjectPropType(expression: string): string | undefined {
  const typeMatch = /\btype\s*:\s*([^,}\n]+)/.exec(expression);

  if (typeMatch?.[1] !== undefined) {
    return typeMatch[1].trim();
  }

  const shorthandMatch = /^\s*([A-Za-z_$][\w$.]*)/.exec(expression);

  return shorthandMatch?.[1];
}

/**
 * 检测对象 Props 默认值。
 *
 * @param expression Props 表达式。
 * @returns 默认值。
 */
function detectObjectPropDefault(expression: string): string | undefined {
  const defaultMatch = /\bdefault\s*:\s*([^,}\n]+)/.exec(expression);

  return defaultMatch?.[1]?.trim();
}

/**
 * 解析类型表达式。
 *
 * @param scriptContent script 内容。
 * @param expression 类型表达式。
 * @returns 解析后的类型表达式。
 */
function resolveTypeExpression(scriptContent: string, expression: string): string | undefined {
  const trimmedExpression = expression.trim();

  if (trimmedExpression.startsWith('{')) {
    return trimmedExpression;
  }

  const interfaceMatch = new RegExp(`interface\\s+${escapeRegex(trimmedExpression)}\\s*\\{([\\s\\S]*?)\\}`).exec(
    scriptContent,
  );

  if (interfaceMatch?.[1] !== undefined) {
    return interfaceMatch[1];
  }

  const typeMatch = new RegExp(`type\\s+${escapeRegex(trimmedExpression)}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(
    scriptContent,
  );

  return typeMatch?.[1];
}

/**
 * 检测 Emits。
 *
 * @param scriptContent script 内容。
 * @returns Emits 列表。
 */
function detectEmits(scriptContent: string): readonly ComponentEmit[] {
  const emits = new Map<string, ComponentEmit>();
  const argumentExpression = readCallArgument(scriptContent, 'defineEmits');
  const genericExpression = readCallGeneric(scriptContent, 'defineEmits');

  for (const emit of parseDefineEmitsArgument(argumentExpression)) {
    emits.set(emit.name, emit);
  }

  for (const emit of parseDefineEmitsGeneric(genericExpression)) {
    emits.set(emit.name, emit);
  }

  const emitCallRegex = /(?:^|[^\w$])(?:emit|\$emit)\s*\(\s*['"`]([^'"`]+)['"`]/g;

  for (const match of scriptContent.matchAll(emitCallRegex)) {
    if (match[1] !== undefined) {
      emits.set(match[1], {
        name: match[1],
      });
    }
  }

  return sortByName([...emits.values()]);
}

/**
 * 解析 defineEmits 参数。
 *
 * @param argumentExpression 参数表达式。
 * @returns Emits 列表。
 */
function parseDefineEmitsArgument(argumentExpression: string | undefined): readonly ComponentEmit[] {
  if (argumentExpression === undefined) {
    return [];
  }

  if (argumentExpression.trim().startsWith('[')) {
    return [...argumentExpression.matchAll(/['"`]([^'"`]+)['"`]/g)].map((match) => ({
      name: match[1] ?? '',
    }));
  }

  if (argumentExpression.trim().startsWith('{')) {
    return [...stripOuterBraces(argumentExpression).matchAll(/['"`]?([A-Za-z_$][\w$:-]*)['"`]?\s*:/g)].map(
      (match) => ({
        name: match[1] ?? '',
      }),
    );
  }

  return [];
}

/**
 * 解析 defineEmits 泛型。
 *
 * @param genericExpression 泛型表达式。
 * @returns Emits 列表。
 */
function parseDefineEmitsGeneric(genericExpression: string | undefined): readonly ComponentEmit[] {
  if (genericExpression === undefined) {
    return [];
  }

  const emits: ComponentEmit[] = [];
  const overloadRegex = /\(\s*e\s*:\s*['"`]([^'"`]+)['"`]\s*(?:,\s*([^)]*))?\)\s*=>|e\s*:\s*['"`]([^'"`]+)['"`]/g;

  for (const match of genericExpression.matchAll(overloadRegex)) {
    const name = match[1] ?? match[3];

    if (name === undefined) {
      continue;
    }

    emits.push({
      name,
      payload: match[2]?.trim(),
    });
  }

  return emits;
}

/**
 * 检测 Slots。
 *
 * @param scriptContent script 内容。
 * @param templateContent template 内容。
 * @param kind 组件文件类型。
 * @returns Slots 列表。
 */
function detectSlots(
  scriptContent: string,
  templateContent: string,
  kind: ComponentFileKind,
): readonly ComponentSlot[] {
  const slots = new Map<string, ComponentSlot>();

  for (const slot of parseTemplateSlots(templateContent)) {
    slots.set(slot.name, slot);
  }

  for (const slot of parseDefineSlots(scriptContent)) {
    slots.set(slot.name, slot);
  }

  if (kind !== 'vue' && /\bchildren\b/.test(scriptContent)) {
    slots.set('default', {
      name: 'default',
      props: 'children',
    });
  }

  return sortByName([...slots.values()]);
}

/**
 * 解析模板插槽。
 *
 * @param templateContent template 内容。
 * @returns Slots 列表。
 */
function parseTemplateSlots(templateContent: string): readonly ComponentSlot[] {
  const slots: ComponentSlot[] = [];
  const slotRegex = /<slot\b([^>]*)>/g;

  for (const match of templateContent.matchAll(slotRegex)) {
    const attributes = match[1] ?? '';
    const nameMatch = /\bname\s*=\s*['"`]([^'"`]+)['"`]/.exec(attributes);

    slots.push({
      name: nameMatch?.[1] ?? 'default',
    });
  }

  return slots;
}

/**
 * 解析 defineSlots。
 *
 * @param scriptContent script 内容。
 * @returns Slots 列表。
 */
function parseDefineSlots(scriptContent: string): readonly ComponentSlot[] {
  const genericExpression = readCallGeneric(scriptContent, 'defineSlots');

  if (genericExpression === undefined) {
    return [];
  }

  const slots: ComponentSlot[] = [];
  const slotRegex = /['"]?([A-Za-z_$][\w$-]*)['"]?\??\s*:\s*\(([^)]*)\)\s*=>/g;

  for (const match of genericExpression.matchAll(slotRegex)) {
    if (match[1] === undefined) {
      continue;
    }

    slots.push({
      name: match[1],
      props: match[2]?.trim(),
    });
  }

  return slots;
}

/**
 * 检测依赖关系。
 *
 * @param filePath 文件路径。
 * @param content 文件内容。
 * @param context 分析上下文。
 * @returns 依赖关系列表。
 */
function detectDependencies(
  filePath: string,
  content: string,
  context: AnalyzeContext,
): readonly ComponentDependency[] {
  const dependencies = new Map<string, ComponentDependency>();
  const importRegex = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|import\s*\(|require\s*\()\s*['"`]([^'"`]+)['"`]/g;

  for (const match of content.matchAll(importRegex)) {
    const source = match[1];

    if (source === undefined) {
      continue;
    }

    const dependency = createDependency(filePath, source, context);
    dependencies.set(`${dependency.source}:${dependency.resolvedPath ?? ''}`, dependency);
  }

  return [...dependencies.values()].sort((left, right) => left.source.localeCompare(right.source));
}

/**
 * 创建依赖描述。
 *
 * @param filePath 当前文件路径。
 * @param source 导入源。
 * @param context 分析上下文。
 * @returns 依赖描述。
 */
function createDependency(filePath: string, source: string, context: AnalyzeContext): ComponentDependency {
  const resolvedPath = source.startsWith('.') ? resolveImportPath(filePath, source, context.targetDirectory) : undefined;
  const normalizedResolvedPath = resolvedPath === undefined ? undefined : normalizePath(resolvedPath);
  const internal = normalizedResolvedPath === undefined ? false : context.componentPathSet.has(normalizedResolvedPath);
  const dependencyKind: DependencyKind = source.startsWith('.')
    ? internal
      ? 'internal-component'
      : 'internal-file'
    : 'external-package';

  return {
    source,
    relative: source.startsWith('.'),
    resolvedPath: normalizedResolvedPath,
    internal,
    dependencyKind,
  };
}

/**
 * 解析导入路径。
 *
 * @param filePath 当前文件路径。
 * @param source 导入源。
 * @param targetDirectory 项目根目录。
 * @returns 解析后的项目相对路径。
 */
function resolveImportPath(filePath: string, source: string, targetDirectory: string): string | undefined {
  const absoluteBasePath = path.resolve(path.dirname(filePath), source);
  const resolvedAbsolutePath = resolveExistingPath(absoluteBasePath);

  if (resolvedAbsolutePath === undefined) {
    return normalizePath(path.relative(targetDirectory, absoluteBasePath));
  }

  return normalizePath(path.relative(targetDirectory, resolvedAbsolutePath));
}

/**
 * 解析实际存在的路径。
 *
 * @param basePath 基础路径。
 * @returns 实际存在的路径。
 */
function resolveExistingPath(basePath: string): string | undefined {
  if (fs.pathExistsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;

    if (fs.pathExistsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  if (fs.pathExistsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const extension of RESOLVABLE_EXTENSIONS) {
      const candidate = path.join(basePath, `index${extension}`);

      if (fs.pathExistsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * 读取已有 catalog。
 *
 * @param catalogPath catalog.json 路径。
 * @returns 已有 catalog 对象。
 */
async function readExistingCatalog(catalogPath: string): Promise<JsonObject | undefined> {
  if (!(await fs.pathExists(catalogPath))) {
    return undefined;
  }

  const content = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    throw new Error('.veaw/component-catalog/catalog.json 不是有效 JSON 对象');
  }

  return sanitizeJsonObject(content);
}

/**
 * 合并 catalog。
 *
 * @param existingCatalog 已有 catalog。
 * @param components 最新组件列表。
 * @returns 合并后的 catalog。
 */
function mergeCatalog(
  existingCatalog: JsonObject | undefined,
  components: readonly CatalogComponent[],
  availableResources: readonly CatalogResourceSummary[],
): JsonObject {
  const existingComponents = readExistingComponents(existingCatalog);
  const mergedComponents = stabilizeComponents(
    existingComponents,
    attachUsageMetadata(mergeComponents(existingComponents, components)),
  );

  return createCatalogObject(existingCatalog, mergedComponents, availableResources);
}

/**
 * 创建 catalog JSON 对象。
 *
 * @param existingCatalog 已有 catalog。
 * @param components 组件列表。
 * @param availableResources 可用资源摘要。
 * @returns catalog JSON 对象。
 */
function createCatalogObject(
  existingCatalog: JsonObject | undefined,
  components: readonly CatalogComponent[],
  availableResources: readonly CatalogResourceSummary[],
): JsonObject {
  const now = new Date().toISOString();
  const generatedAt = readExistingString(existingCatalog, 'generatedAt') ?? now;
  const existingUpdatedAt = readExistingString(existingCatalog, 'updatedAt');
  const baseCatalog: ComponentCatalog = {
    version: CATALOG_VERSION,
    generatedAt,
    updatedAt: existingUpdatedAt ?? now,
    scanRoots: SCAN_ROOTS,
    availableResources,
    components,
  };
  const nextCatalog = {
    ...(existingCatalog ?? {}),
    ...toJsonObject(baseCatalog),
  };

  if (
    existingCatalog !== undefined &&
    areJsonValuesEqual(stripCatalogUpdatedAt(existingCatalog), stripCatalogUpdatedAt(nextCatalog))
  ) {
    return nextCatalog;
  }

  return {
    ...nextCatalog,
    updatedAt: now,
  };
}

/**
 * 读取已有组件列表。
 *
 * @param existingCatalog 已有 catalog。
 * @returns 已有组件对象列表。
 */
function readExistingComponents(existingCatalog: JsonObject | undefined): readonly JsonObject[] {
  const components = existingCatalog?.components;

  if (!Array.isArray(components)) {
    return [];
  }

  return components.filter(isJsonObject);
}

/**
 * 合并组件列表。
 *
 * @param existingComponents 已有组件列表。
 * @param nextComponents 最新组件列表。
 * @returns 合并后的组件列表。
 */
function mergeComponents(
  existingComponents: readonly JsonObject[],
  nextComponents: readonly CatalogComponent[],
): readonly CatalogComponent[] {
  const existingComponentMap = new Map<string, JsonObject>();

  for (const component of existingComponents) {
    const filePath = typeof component.filePath === 'string' ? component.filePath : undefined;

    if (filePath !== undefined) {
      existingComponentMap.set(filePath, component);
    }
  }

  return nextComponents.map((component) => {
    const existingComponent = existingComponentMap.get(component.filePath);

    return mergeComponent(existingComponent, component);
  });
}

function mergeComponent(
  existingComponent: JsonObject | undefined,
  nextComponent: CatalogComponent,
): CatalogComponent {
  const now = new Date().toISOString();
  const nextComponentObject = toJsonObject(nextComponent);
  const existingUpdatedAt = readExistingString(existingComponent, 'updatedAt');
  const mergedComponent: JsonObject = {
    ...(existingComponent ?? {}),
    ...nextComponentObject,
    updatedAt: existingUpdatedAt ?? now,
  };

  if (
    existingComponent === undefined ||
    !areJsonValuesEqual(stripUpdatedAt(existingComponent), stripUpdatedAt(mergedComponent))
  ) {
    mergedComponent.updatedAt = now;
  }

  return mergedComponent as unknown as CatalogComponent;
}

function stabilizeComponents(
  existingComponents: readonly JsonObject[],
  components: readonly CatalogComponent[],
): readonly CatalogComponent[] {
  const existingComponentMap = new Map(
    existingComponents
      .filter((component) => typeof component.filePath === 'string')
      .map((component) => [component.filePath as string, component]),
  );

  return components.map((component) => mergeComponent(existingComponentMap.get(component.filePath), component));
}

function refreshDependencyMetadata(
  component: CatalogComponent,
  componentPathSet: ReadonlySet<string>,
): CatalogComponent {
  const dependencies = component.dependencies.map((dependency) => {
    const internal = dependency.resolvedPath !== undefined && componentPathSet.has(dependency.resolvedPath);

    return {
      ...dependency,
      internal,
      dependencyKind: dependency.relative
        ? internal
          ? 'internal-component' as const
          : 'internal-file' as const
        : 'external-package' as const,
    };
  });

  return {
    ...component,
    dependencies,
    usageHints: buildUsageHints(component.category, component.filePath, dependencies),
  };
}

/**
 * 增量合并组件列表。
 *
 * @param existingComponents 已有组件列表。
 * @param changedComponents 已重新分析组件。
 * @param removedFiles 已删除组件文件。
 * @returns 合并后的组件列表。
 */
function mergeIncrementalComponents(
  existingComponents: readonly JsonObject[],
  changedComponents: readonly CatalogComponent[],
  removedFiles: readonly string[],
): readonly CatalogComponent[] {
  const changedComponentMap = new Map(changedComponents.map((component) => [component.filePath, component]));
  const removedFileSet = new Set(removedFiles);
  const mergedComponents: CatalogComponent[] = [];

  for (const component of existingComponents) {
    const filePath = typeof component.filePath === 'string' ? component.filePath : undefined;

    if (filePath === undefined || removedFileSet.has(filePath)) {
      continue;
    }

    const changedComponent = changedComponentMap.get(filePath);

    if (changedComponent === undefined) {
      mergedComponents.push(component as unknown as CatalogComponent);
      continue;
    }

    mergedComponents.push(mergeComponent(component, changedComponent));
    changedComponentMap.delete(filePath);
  }

  return [
    ...mergedComponents,
    ...[...changedComponentMap.values()].sort((left, right) => left.filePath.localeCompare(right.filePath)),
  ];
}

/**
 * 读取已有组件路径。
 *
 * @param existingComponents 已有组件列表。
 * @returns 组件路径。
 */
function readExistingComponentPaths(existingComponents: readonly JsonObject[]): readonly string[] {
  return existingComponents
    .map((component) => component.filePath)
    .filter((filePath): filePath is string => typeof filePath === 'string');
}

/**
 * 读取已有 catalog 资源摘要。
 *
 * @param existingCatalog 已有 catalog。
 * @returns 资源摘要列表。
 */
function readExistingCatalogResources(existingCatalog: JsonObject | undefined): readonly CatalogResourceSummary[] {
  const resources = existingCatalog?.availableResources;

  if (!Array.isArray(resources)) {
    return [];
  }

  return resources.filter(isJsonObject) as unknown as readonly CatalogResourceSummary[];
}

/**
 * 解析变更中的现存组件文件。
 *
 * @param targetDirectory 项目根目录。
 * @param changedFiles 项目相对变更文件。
 * @returns 现存组件文件绝对路径。
 */
async function resolveChangedComponentFiles(
  targetDirectory: string,
  changedFiles: readonly string[],
): Promise<readonly string[]> {
  const componentFiles: string[] = [];

  for (const changedFile of changedFiles) {
    if (!isCatalogInputFile(changedFile)) {
      continue;
    }

    const filePath = path.join(targetDirectory, changedFile);

    if ((await fs.pathExists(filePath)) && (await fs.stat(filePath)).isFile()) {
      componentFiles.push(filePath);
    }
  }

  return componentFiles.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

/**
 * 解析变更中已删除的组件文件。
 *
 * @param targetDirectory 项目根目录。
 * @param changedFiles 项目相对变更文件。
 * @returns 已删除组件文件。
 */
function resolveRemovedComponentFiles(targetDirectory: string, changedFiles: readonly string[]): readonly string[] {
  return changedFiles
    .filter(isCatalogInputFile)
    .filter((changedFile) => !fs.pathExistsSync(path.join(targetDirectory, changedFile)))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * 判断文件是否属于 catalog 增量输入。
 *
 * @param filePath 项目相对路径。
 * @returns 是否属于组件目录输入。
 */
function isCatalogInputFile(filePath: string): boolean {
  return SCAN_ROOTS.some((scanRoot) => filePath.startsWith(`${scanRoot}/`)) && isComponentFile(filePath);
}

function stripCatalogUpdatedAt(catalog: JsonObject): JsonObject {
  return stripUpdatedAt(catalog);
}

function stripUpdatedAt(object: JsonObject): JsonObject {
  const value = { ...object };

  delete value.updatedAt;

  return value;
}

function areJsonValuesEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 读取已有字符串字段。
 *
 * @param object 对象。
 * @param key 字段名。
 * @returns 字符串字段。
 */
function readExistingString(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * 去掉外层大括号。
 *
 * @param expression 表达式。
 * @returns 去掉外层大括号后的表达式。
 */
function stripOuterBraces(expression: string): string {
  const trimmedExpression = expression.trim();

  if (trimmedExpression.startsWith('{') && trimmedExpression.endsWith('}')) {
    return trimmedExpression.slice(1, -1);
  }

  return trimmedExpression;
}

/**
 * 按顶层分隔符拆分字符串。
 *
 * @param content 内容。
 * @param separator 分隔符。
 * @returns 拆分结果。
 */
function splitTopLevel(content: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;

  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const previous = content[index - 1];

    if (quote !== undefined) {
      if (current === quote && previous !== '\\') {
        quote = undefined;
      }

      continue;
    }

    if (current === '"' || current === "'" || current === '`') {
      quote = current;
      continue;
    }

    if (current === '{' || current === '[' || current === '(' || current === '<') {
      depth += 1;
      continue;
    }

    if (current === '}' || current === ']' || current === ')' || current === '>') {
      depth -= 1;
      continue;
    }

    if (current === separator && depth === 0) {
      parts.push(content.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(content.slice(start));

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * 转换为 PascalCase。
 *
 * @param value 原始值。
 * @returns PascalCase 字符串。
 */
function toPascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/**
 * 转义正则字符串。
 *
 * @param value 原始字符串。
 * @returns 转义后的字符串。
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按名称排序。
 *
 * @param values 带名称字段的列表。
 * @returns 排序后的列表。
 */
function sortByName<TValue extends { readonly name: string }>(values: readonly TValue[]): readonly TValue[] {
  return [...values].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 标准化路径。
 *
 * @param filePath 文件路径。
 * @returns 标准化后的路径。
 */
function normalizePath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/');
}

/**
 * 将对象转成 JSON 对象。
 *
 * @param value 待转换值。
 * @returns JSON 对象。
 */
function toJsonObject(value: unknown): JsonObject {
  const sanitizedValue = sanitizeJsonValue(value);

  if (!isJsonObject(sanitizedValue)) {
    return {};
  }

  return sanitizedValue;
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
