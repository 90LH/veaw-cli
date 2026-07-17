import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { isRecord, readString } from './guards.js';
import type { VeawProjectConfig, WorkspaceDiscoveryOptions, WorkspaceLocation } from './types.js';

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * 项目配置文件名。
 */
const PROJECT_CONFIG_FILE_NAME = 'config.json';

/**
 * Workspace registry 目录名。
 */
const REGISTRIES_DIRECTORY_NAME = 'registries';

/**
 * Workspace 根标记文件名。
 */
const WORKSPACE_MARKER_FILE_NAME = 'workspace.json';

/**
 * 发现 VEAW Workspace。
 *
 * @param options 发现选项。
 * @returns Workspace 或 fallback 位置。
 */
export async function discoverWorkspace(options: WorkspaceDiscoveryOptions): Promise<WorkspaceLocation> {
  const projectDirectory = path.resolve(options.projectDirectory);
  const explicitLocation = await resolveWorkspaceCandidate(options.explicitWorkspacePath, 'explicit');

  if (explicitLocation !== undefined) {
    return explicitLocation;
  }

  const environmentLocation = await resolveWorkspaceCandidate(options.environment?.VEAW_WORKSPACE, 'environment');

  if (environmentLocation !== undefined) {
    return environmentLocation;
  }

  const projectConfig = await readProjectConfig(projectDirectory);
  const projectConfigLocation = await resolveWorkspaceCandidate(projectConfig?.workspacePath, 'project-config');

  if (projectConfigLocation !== undefined) {
    return projectConfigLocation;
  }

  const ancestorLocation = await findWorkspaceFromAncestors(projectDirectory);

  if (ancestorLocation !== undefined) {
    return ancestorLocation;
  }

  return createFallbackLocation(options.fallbackAssetsDirectory);
}

/**
 * 读取项目 .veaw/config.json。
 *
 * @param projectDirectory 项目根目录。
 * @returns 项目配置。
 */
export async function readProjectConfig(projectDirectory: string): Promise<VeawProjectConfig | undefined> {
  const configPath = path.join(projectDirectory, VEAW_DIRECTORY_NAME, PROJECT_CONFIG_FILE_NAME);

  if (!(await fs.pathExists(configPath))) {
    return undefined;
  }

  const content = JSON.parse(await fs.readFile(configPath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    return undefined;
  }

  return {
    workspacePath: readString(content, 'workspacePath'),
  };
}

/**
 * 根据候选路径解析 Workspace。
 *
 * @param candidatePath 候选路径。
 * @param source 发现来源。
 * @returns Workspace 位置。
 */
async function resolveWorkspaceCandidate(
  candidatePath: string | undefined,
  source: WorkspaceLocation['source'],
): Promise<WorkspaceLocation | undefined> {
  if (candidatePath === undefined || candidatePath.trim().length === 0) {
    return undefined;
  }

  const rootDirectory = path.resolve(candidatePath);

  if (!(await isWorkspaceRoot(rootDirectory))) {
    return undefined;
  }

  return {
    source,
    kind: 'workspace',
    rootDirectory,
    registriesDirectory: path.join(rootDirectory, REGISTRIES_DIRECTORY_NAME),
  };
}

/**
 * 从当前目录向上查找 Workspace。
 *
 * @param startDirectory 起始目录。
 * @returns Workspace 位置。
 */
async function findWorkspaceFromAncestors(startDirectory: string): Promise<WorkspaceLocation | undefined> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    if (await isWorkspaceRoot(currentDirectory)) {
      return {
        source: 'ancestor',
        kind: 'workspace',
        rootDirectory: currentDirectory,
        registriesDirectory: path.join(currentDirectory, REGISTRIES_DIRECTORY_NAME),
      };
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

/**
 * 判断目录是否是 VEAW Workspace 根目录。
 *
 * @param directoryPath 目录路径。
 * @returns 是否是 Workspace 根目录。
 */
async function isWorkspaceRoot(directoryPath: string): Promise<boolean> {
  return (
    (await fs.pathExists(path.join(directoryPath, WORKSPACE_MARKER_FILE_NAME))) &&
    (await fs.pathExists(path.join(directoryPath, REGISTRIES_DIRECTORY_NAME, 'registry.json')))
  );
}

/**
 * 创建 CLI assets fallback 位置。
 *
 * @param fallbackAssetsDirectory 外部传入的 fallback assets 目录。
 * @returns fallback 位置。
 */
function createFallbackLocation(fallbackAssetsDirectory: string | undefined): WorkspaceLocation {
  const assetsDirectory = fallbackAssetsDirectory ?? resolveBundledAssetsDirectory();

  return {
    source: 'fallback',
    kind: 'fallback',
    rootDirectory: assetsDirectory,
    assetsDirectory,
  };
}

/**
 * 解析 CLI 内置 assets 目录。
 *
 * @returns assets 目录。
 */
function resolveBundledAssetsDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

  return path.resolve(moduleDirectory, '..', '..', 'assets');
}
