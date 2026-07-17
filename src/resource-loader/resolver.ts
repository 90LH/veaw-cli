import type { ResourceQuery, WorkspaceResource } from './types.js';

/**
 * 资源解析器。
 */
export class ResourceResolver {
  /**
   * 按 id 索引的资源。
   */
  private readonly resourceMap: ReadonlyMap<string, WorkspaceResource>;

  /**
   * 创建资源解析器。
   *
   * @param resources 资源列表。
   */
  public constructor(private readonly resources: readonly WorkspaceResource[]) {
    this.resourceMap = new Map(resources.map((resource) => [resource.id, resource]));
  }

  /**
   * 按 id 获取资源。
   *
   * @param id 资源 id。
   * @returns 资源。
   */
  public getById(id: string): WorkspaceResource | undefined {
    return this.resourceMap.get(id);
  }

  /**
   * 查询资源。
   *
   * @param query 查询条件。
   * @returns 匹配资源列表。
   */
  public find(query: ResourceQuery): readonly WorkspaceResource[] {
    return this.resources.filter((resource) => {
      if (query.ids !== undefined && !query.ids.includes(resource.id)) {
        return false;
      }

      if (query.type !== undefined && resource.type !== query.type) {
        return false;
      }

      if (query.tag !== undefined && !resource.tags.includes(query.tag)) {
        return false;
      }

      return true;
    });
  }

  /**
   * 解析资源依赖闭包。
   *
   * @param ids 起始资源 id 列表。
   * @returns 按依赖优先排序后的资源。
   */
  public resolveDependencies(ids: readonly string[]): readonly WorkspaceResource[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: WorkspaceResource[] = [];

    for (const id of ids) {
      this.visitResource(id, visited, visiting, result);
    }

    return result;
  }

  /**
   * 深度优先访问资源。
   *
   * @param id 资源 id。
   * @param visited 已访问集合。
   * @param visiting 当前访问集合。
   * @param result 结果列表。
   */
  private visitResource(
    id: string,
    visited: Set<string>,
    visiting: Set<string>,
    result: WorkspaceResource[],
  ): void {
    if (visited.has(id)) {
      return;
    }

    if (visiting.has(id)) {
      throw new Error(`Circular resource dependency detected: ${id}`);
    }

    const resource = this.resourceMap.get(id);

    if (resource === undefined) {
      throw new Error(`Missing resource dependency: ${id}`);
    }

    visiting.add(id);

    for (const dependencyId of resource.dependencies) {
      this.visitResource(dependencyId, visited, visiting, result);
    }

    visiting.delete(id);
    visited.add(id);
    result.push(resource);
  }
}
