import path from 'node:path';
import fs from 'fs-extra';
import { ResourceResolver } from './resolver.js';
import type { LoadedWorkspaceRegistry, ProjectProfile, WorkspaceResource } from './types.js';

/**
 * Registry 资源内容查询。
 */
export interface ResourceContentQuery {
  /**
   * 资源 id 列表。
   */
  readonly ids?: readonly string[];
  /**
   * 资源类型列表。
   */
  readonly types?: readonly string[];
  /**
   * 任一标签匹配。
   */
  readonly tags?: readonly string[];
  /**
   * 是否只读取默认启用资源。
   */
  readonly enabledOnly?: boolean;
  /**
   * 是否解析依赖闭包。
   */
  readonly includeDependencies?: boolean;
  /**
   * Project profile used when enabledOnly should follow preset/profile selection.
   */
  readonly profile?: ProjectProfile;
}

/**
 * Registry 资源内容。
 */
export interface ResourceContent {
  /**
   * Registry 资源描述。
   */
  readonly resource: WorkspaceResource;
  /**
   * 资源文件内容。
   */
  readonly content: string;
}

/**
 * 读取匹配 Registry 资源的文本内容。
 *
 * @param registry 已加载 Workspace Registry。
 * @param query 内容查询。
 * @returns 资源内容列表。
 */
export async function readResourceContents(
  registry: LoadedWorkspaceRegistry,
  query: ResourceContentQuery,
): Promise<readonly ResourceContent[]> {
  const resources = selectResources(registry.resources, query);
  const result: ResourceContent[] = [];

  for (const resource of resources) {
    const sourcePath = path.join(registry.location.rootDirectory, resource.sourcePath);

    result.push({
      resource,
      content: await fs.readFile(sourcePath, 'utf8'),
    });
  }

  return result;
}

/**
 * 查询 Registry 资源。
 *
 * @param resources 资源列表。
 * @param query 查询条件。
 * @returns 匹配资源列表。
 */
export function selectResources(
  resources: readonly WorkspaceResource[],
  query: ResourceContentQuery,
): readonly WorkspaceResource[] {
  const candidateResources =
    query.enabledOnly === true && query.profile !== undefined
      ? new ResourceResolver(resources).resolveSelection({ profile: query.profile }).resources
      : resources;
  const baseResources = candidateResources
    .filter((resource) => matchesResource(resource, query))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (query.includeDependencies !== true) {
    return baseResources;
  }

  const resolver = new ResourceResolver(resources);

  return resolver.resolveDependencies(baseResources.map((resource) => resource.id));
}

/**
 * 判断资源是否匹配查询。
 *
 * @param resource Registry 资源。
 * @param query 查询条件。
 * @returns 是否匹配。
 */
function matchesResource(resource: WorkspaceResource, query: ResourceContentQuery): boolean {
  if (query.enabledOnly === true && query.profile === undefined && !resource.enabledByDefault) {
    return false;
  }

  if (query.ids !== undefined && !query.ids.includes(resource.id)) {
    return false;
  }

  if (query.types !== undefined && !query.types.includes(resource.type)) {
    return false;
  }

  if (query.tags !== undefined && !query.tags.some((tag) => resource.tags.includes(tag))) {
    return false;
  }

  return true;
}
