import path from 'node:path';
import fs from 'fs-extra';

/**
 * 项目依赖表。
 */
export type ProjectDependencyMap = Readonly<Record<string, string>>;

/**
 * 检测到的目录摘要。
 */
export interface ProjectDirectorySummary {
  /**
   * 是否检测到目录。
   */
  readonly detected: boolean;
  /**
   * 项目相对路径。
   */
  readonly paths: readonly string[];
}

/**
 * 依赖和目录共同推断出的项目能力。
 */
export interface ProjectFeatureSummary {
  /**
   * 是否检测到能力。
   */
  readonly detected: boolean;
  /**
   * 相关依赖包。
   */
  readonly packages: readonly string[];
  /**
   * 相关项目目录。
   */
  readonly directories: readonly string[];
}

/**
 * 前端项目结构洞察。
 */
export interface ProjectInsightSummary {
  /**
   * UI 库依赖。
   */
  readonly uiLibraries: readonly string[];
  /**
   * Router 信息。
   */
  readonly router: ProjectFeatureSummary;
  /**
   * 状态管理信息。
   */
  readonly stateManagement: ProjectFeatureSummary;
  /**
   * API 目录。
   */
  readonly apiDirectories: ProjectDirectorySummary;
  /**
   * service 目录。
   */
  readonly serviceDirectories: ProjectDirectorySummary;
  /**
   * Components 目录。
   */
  readonly componentDirectories: ProjectDirectorySummary;
  /**
   * Layout 目录。
   */
  readonly layoutDirectories: ProjectDirectorySummary;
}

/**
 * 已知 UI 库依赖。
 */
const UI_LIBRARY_PACKAGES = [
  'element-plus',
  'ant-design-vue',
  'naive-ui',
  '@arco-design/web-vue',
  'vuetify',
  'vant',
  '@varlet/ui',
  'primevue',
  '@headlessui/vue',
] as const;

/**
 * 已知 Router 依赖。
 */
const ROUTER_PACKAGES = ['vue-router', 'react-router', 'react-router-dom', '@tanstack/router', 'next'] as const;

/**
 * 已知状态管理依赖。
 */
const STATE_MANAGEMENT_PACKAGES = ['pinia', 'vuex', 'zustand', 'redux', '@reduxjs/toolkit', 'mobx', 'jotai'] as const;

/**
 * Router 目录候选。
 */
const ROUTER_DIRECTORY_CANDIDATES = ['src/router', 'src/routes', 'router', 'routes'] as const;

/**
 * 状态管理目录候选。
 */
const STATE_DIRECTORY_CANDIDATES = ['src/store', 'src/stores', 'src/stores/modules', 'src/pinia', 'store', 'stores'] as const;

/**
 * API 目录候选。
 */
const API_DIRECTORY_CANDIDATES = ['src/api', 'src/apis', 'src/http', 'src/request', 'src/utils/http', 'api'] as const;

/**
 * Service 目录候选。
 */
const SERVICE_DIRECTORY_CANDIDATES = ['src/service', 'src/services', 'src/api/service', 'service', 'services'] as const;

/**
 * Components 目录候选。
 */
const COMPONENT_DIRECTORY_CANDIDATES = ['src/components', 'src/common/components', 'src/shared/components', 'components'] as const;

/**
 * Layout 目录候选。
 */
const LAYOUT_DIRECTORY_CANDIDATES = ['src/layouts', 'src/layout', 'layouts', 'layout'] as const;

/**
 * 推断项目 UI、Router、状态和关键目录信息。
 *
 * @param targetDirectory 项目根目录。
 * @param seedDependencies 已知依赖表。
 * @returns 项目结构洞察。
 */
export async function inspectProjectInsights(
  targetDirectory: string,
  seedDependencies: ProjectDependencyMap = {},
): Promise<ProjectInsightSummary> {
  const dependencies = {
    ...seedDependencies,
    ...(await readPackageDependencies(targetDirectory)),
  };
  const routerDirectories = await findExistingDirectories(targetDirectory, ROUTER_DIRECTORY_CANDIDATES);
  const stateDirectories = await findExistingDirectories(targetDirectory, STATE_DIRECTORY_CANDIDATES);

  return {
    uiLibraries: findInstalledPackages(dependencies, UI_LIBRARY_PACKAGES),
    router: createFeatureSummary(findInstalledPackages(dependencies, ROUTER_PACKAGES), routerDirectories),
    stateManagement: createFeatureSummary(findInstalledPackages(dependencies, STATE_MANAGEMENT_PACKAGES), stateDirectories),
    apiDirectories: createDirectorySummary(await findExistingDirectories(targetDirectory, API_DIRECTORY_CANDIDATES)),
    serviceDirectories: createDirectorySummary(await findExistingDirectories(targetDirectory, SERVICE_DIRECTORY_CANDIDATES)),
    componentDirectories: createDirectorySummary(await findExistingDirectories(targetDirectory, COMPONENT_DIRECTORY_CANDIDATES)),
    layoutDirectories: createDirectorySummary(await findExistingDirectories(targetDirectory, LAYOUT_DIRECTORY_CANDIDATES)),
  };
}

/**
 * 读取 package.json dependencies 与 devDependencies。
 *
 * @param targetDirectory 项目根目录。
 * @returns 依赖表。
 */
async function readPackageDependencies(targetDirectory: string): Promise<ProjectDependencyMap> {
  const packageJsonPath = path.join(targetDirectory, 'package.json');

  if (!(await fs.pathExists(packageJsonPath))) {
    return {};
  }

  const content = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    return {};
  }

  return {
    ...readStringRecord(content, 'dependencies'),
    ...readStringRecord(content, 'devDependencies'),
  };
}

/**
 * 创建能力摘要。
 *
 * @param packages 依赖包。
 * @param directories 目录。
 * @returns 能力摘要。
 */
function createFeatureSummary(packages: readonly string[], directories: readonly string[]): ProjectFeatureSummary {
  return {
    detected: packages.length > 0 || directories.length > 0,
    packages,
    directories,
  };
}

/**
 * 创建目录摘要。
 *
 * @param paths 目录路径。
 * @returns 目录摘要。
 */
function createDirectorySummary(paths: readonly string[]): ProjectDirectorySummary {
  return {
    detected: paths.length > 0,
    paths,
  };
}

/**
 * 查找已安装包。
 *
 * @param dependencies 依赖表。
 * @param packageNames 包名候选。
 * @returns 已安装包名。
 */
function findInstalledPackages(
  dependencies: ProjectDependencyMap,
  packageNames: readonly string[],
): readonly string[] {
  return packageNames.filter((packageName) => dependencies[packageName] !== undefined);
}

/**
 * 查找存在的目录。
 *
 * @param targetDirectory 项目根目录。
 * @param candidates 候选目录。
 * @returns 存在的项目相对目录。
 */
async function findExistingDirectories(
  targetDirectory: string,
  candidates: readonly string[],
): Promise<readonly string[]> {
  const directories: string[] = [];

  for (const candidate of candidates) {
    const candidatePath = path.join(targetDirectory, candidate);

    if ((await fs.pathExists(candidatePath)) && (await fs.stat(candidatePath)).isDirectory()) {
      directories.push(candidate);
    }
  }

  return directories.map(normalizePath);
}

/**
 * 读取字符串记录字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串记录。
 */
function readStringRecord(record: Readonly<Record<string, unknown>>, key: string): ProjectDependencyMap {
  const value = record[key];

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
 * 判断值是否是对象记录。
 *
 * @param value 待判断值。
 * @returns 是否是对象记录。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 标准化为 POSIX 风格路径。
 *
 * @param filePath 文件路径。
 * @returns 标准化路径。
 */
function normalizePath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/');
}
