import path from 'node:path';
import fs from 'fs-extra';
import {
  isRecord,
  isWorkspaceResource,
  readBoolean,
  readString,
  readStringArray,
} from './guards.js';
import type {
  LoadedWorkspaceRegistry,
  ResourceRegistry,
  WorkspaceLocation,
  WorkspaceRegistry,
  WorkspaceRegistryEntry,
  WorkspaceRegistryMetadata,
} from './types.js';

/**
 * 当前支持的 Registry schema 版本。
 */
const SUPPORTED_SCHEMA_VERSION = '1.0.0';

/**
 * 读取 Workspace Registry。
 *
 * @param location Workspace 位置。
 * @returns 已加载 Registry。
 */
export async function readWorkspaceRegistry(location: WorkspaceLocation): Promise<LoadedWorkspaceRegistry> {
  if (location.kind !== 'workspace' || location.registriesDirectory === undefined) {
    throw new Error('CLI assets fallback does not provide Workspace registries.');
  }

  const registry = await readTopLevelRegistry(path.join(location.registriesDirectory, 'registry.json'));
  const childRegistries: ResourceRegistry[] = [];

  for (const entry of registry.registries) {
    const registryPath = path.join(location.registriesDirectory, entry.path);

    if (!(await fs.pathExists(registryPath))) {
      if (entry.required) {
        throw new Error(`Missing required registry: ${entry.path}`);
      }

      continue;
    }

    childRegistries.push(await readResourceRegistry(registryPath, registry.workspaceVersion));
  }

  const resources = childRegistries.flatMap((childRegistry) => childRegistry.resources);

  await validateResourceSources(location.rootDirectory, resources);

  return {
    location,
    registry,
    childRegistries,
    resources,
  };
}

/**
 * 读取顶层 Registry。
 *
 * @param registryPath Registry 文件路径。
 * @returns 顶层 Registry。
 */
async function readTopLevelRegistry(registryPath: string): Promise<WorkspaceRegistry> {
  const content = await readJsonObject(registryPath);
  const schemaVersion = readString(content, 'schemaVersion');
  const workspaceVersion = readString(content, 'workspaceVersion');
  const workspace = readWorkspaceMetadata(content.workspace);
  const registries = readRegistryEntries(content.registries);

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Unsupported registry schema version: ${schemaVersion ?? 'unknown'}`);
  }

  if (workspaceVersion === undefined || workspace === undefined || registries === undefined) {
    throw new Error('Invalid top-level Workspace registry.');
  }

  return {
    schemaVersion,
    workspaceVersion,
    workspace,
    registries,
  };
}

/**
 * 读取资源 Registry。
 *
 * @param registryPath Registry 文件路径。
 * @param workspaceVersion Workspace 版本。
 * @returns 资源 Registry。
 */
async function readResourceRegistry(registryPath: string, workspaceVersion: string): Promise<ResourceRegistry> {
  const content = await readJsonObject(registryPath);
  const schemaVersion = readString(content, 'schemaVersion');
  const resourceType = readString(content, 'resourceType');
  const registryWorkspaceVersion = readString(content, 'workspaceVersion');
  const resources = Array.isArray(content.resources) ? content.resources.filter(isWorkspaceResource) : undefined;

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Unsupported registry schema version: ${schemaVersion ?? 'unknown'}`);
  }

  if (
    resourceType === undefined ||
    registryWorkspaceVersion === undefined ||
    registryWorkspaceVersion !== workspaceVersion ||
    resources === undefined ||
    resources.length !== (Array.isArray(content.resources) ? content.resources.length : -1)
  ) {
    throw new Error(`Invalid resource registry: ${path.basename(registryPath)}`);
  }

  return {
    schemaVersion,
    workspaceVersion: registryWorkspaceVersion,
    resourceType,
    resources,
  };
}

/**
 * 读取 JSON 对象。
 *
 * @param filePath 文件路径。
 * @returns JSON 对象。
 */
async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const content = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    throw new Error(`JSON file is not an object: ${filePath}`);
  }

  return content;
}

/**
 * 读取 Workspace 元信息。
 *
 * @param value 原始值。
 * @returns Workspace 元信息。
 */
function readWorkspaceMetadata(value: unknown): WorkspaceRegistryMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, 'id');
  const name = readString(value, 'name');
  const rootMarker = readString(value, 'rootMarker');

  if (id === undefined || name === undefined || rootMarker === undefined) {
    return undefined;
  }

  return {
    id,
    name,
    rootMarker,
    description: readString(value, 'description'),
  };
}

/**
 * 读取 Registry 入口列表。
 *
 * @param value 原始值。
 * @returns Registry 入口列表。
 */
function readRegistryEntries(value: unknown): readonly WorkspaceRegistryEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.map(readRegistryEntry);

  if (entries.some((entry) => entry === undefined)) {
    return undefined;
  }

  return entries.filter((entry): entry is WorkspaceRegistryEntry => entry !== undefined);
}

/**
 * 读取 Registry 入口。
 *
 * @param value 原始值。
 * @returns Registry 入口。
 */
function readRegistryEntry(value: unknown): WorkspaceRegistryEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, 'id');
  const type = readString(value, 'type');
  const registryPath = readString(value, 'path');
  const required = readBoolean(value, 'required');

  if (id === undefined || type === undefined || registryPath === undefined || required === undefined) {
    return undefined;
  }

  return {
    id,
    type,
    path: registryPath,
    required,
  };
}

/**
 * 校验资源 sourcePath 是否存在。
 *
 * @param workspaceDirectory Workspace 根目录。
 * @param resources 资源列表。
 */
async function validateResourceSources(workspaceDirectory: string, resources: readonly { readonly sourcePath: string }[]): Promise<void> {
  for (const resource of resources) {
    const sourcePath = path.join(workspaceDirectory, resource.sourcePath);

    if (!(await fs.pathExists(sourcePath))) {
      throw new Error(`Missing resource sourcePath: ${resource.sourcePath}`);
    }
  }
}

/**
 * 读取字符串数组字段，保留给未来 registry metadata 校验使用。
 */
void readStringArray;
