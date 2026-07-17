import path from 'node:path';
import fs from 'fs-extra';
import { isRecord, readString } from './guards.js';
import type { ResourceLockEntry, ResourceLockfile, WorkspaceResource } from './types.js';

/**
 * VEAW 目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * resources lockfile 文件名。
 */
const RESOURCE_LOCKFILE_NAME = 'resources.lock.json';

/**
 * lockfile schema 版本。
 */
const LOCKFILE_SCHEMA_VERSION = '1.0.0';

/**
 * 读取资源 lockfile。
 *
 * @param projectDirectory 项目根目录。
 * @returns lockfile 或 undefined。
 */
export async function readResourceLockfile(projectDirectory: string): Promise<ResourceLockfile | undefined> {
  const lockfilePath = resolveResourceLockfilePath(projectDirectory);

  if (!(await fs.pathExists(lockfilePath))) {
    return undefined;
  }

  const content = JSON.parse(await fs.readFile(lockfilePath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    throw new Error('.veaw/resources.lock.json is not a JSON object.');
  }

  return parseResourceLockfile(content);
}

/**
 * 写入资源 lockfile。
 *
 * @param projectDirectory 项目根目录。
 * @param lockfile lockfile 内容。
 */
export async function writeResourceLockfile(projectDirectory: string, lockfile: ResourceLockfile): Promise<void> {
  await fs.outputJson(resolveResourceLockfilePath(projectDirectory), lockfile, {
    spaces: 2,
  });
}

/**
 * 从资源创建 lockfile。
 *
 * @param workspaceVersion Workspace 版本。
 * @param resources 资源列表。
 * @returns lockfile。
 */
export function createResourceLockfile(
  workspaceVersion: string,
  resources: readonly WorkspaceResource[],
): ResourceLockfile {
  return {
    schemaVersion: LOCKFILE_SCHEMA_VERSION,
    workspaceVersion,
    generatedAt: new Date().toISOString(),
    resources: resources.map(createLockEntry),
  };
}

/**
 * 解析 lockfile 路径。
 *
 * @param projectDirectory 项目根目录。
 * @returns lockfile 路径。
 */
export function resolveResourceLockfilePath(projectDirectory: string): string {
  return path.join(projectDirectory, VEAW_DIRECTORY_NAME, RESOURCE_LOCKFILE_NAME);
}

/**
 * 创建 lockfile 条目。
 *
 * @param resource Workspace 资源。
 * @returns lockfile 条目。
 */
function createLockEntry(resource: WorkspaceResource): ResourceLockEntry {
  return {
    id: resource.id,
    type: resource.type,
    version: resource.version,
    sourcePath: resource.sourcePath,
    targetPath: resource.targetPath,
    hash: resource.hash,
  };
}

/**
 * 解析资源 lockfile。
 *
 * @param record JSON 对象。
 * @returns lockfile。
 */
function parseResourceLockfile(record: Readonly<Record<string, unknown>>): ResourceLockfile {
  const schemaVersion = readString(record, 'schemaVersion');
  const workspaceVersion = readString(record, 'workspaceVersion');
  const generatedAt = readString(record, 'generatedAt');
  const resources = Array.isArray(record.resources) ? record.resources.map(parseLockEntry) : undefined;

  if (
    schemaVersion !== LOCKFILE_SCHEMA_VERSION ||
    workspaceVersion === undefined ||
    generatedAt === undefined ||
    resources === undefined ||
    resources.some((resource) => resource === undefined)
  ) {
    throw new Error('Invalid .veaw/resources.lock.json.');
  }

  return {
    schemaVersion,
    workspaceVersion,
    generatedAt,
    resources: resources.filter((resource): resource is ResourceLockEntry => resource !== undefined),
  };
}

/**
 * 解析 lockfile 条目。
 *
 * @param value 原始值。
 * @returns lockfile 条目。
 */
function parseLockEntry(value: unknown): ResourceLockEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, 'id');
  const type = readString(value, 'type');
  const version = readString(value, 'version');
  const sourcePath = readString(value, 'sourcePath');
  const targetPath = readString(value, 'targetPath');
  const hash = readString(value, 'hash');

  if (
    id === undefined ||
    type === undefined ||
    version === undefined ||
    sourcePath === undefined ||
    targetPath === undefined ||
    hash === undefined
  ) {
    return undefined;
  }

  return {
    id,
    type,
    version,
    sourcePath,
    targetPath,
    hash,
  };
}
