import { isRecord } from './guards.js';
import type {
  ProjectProfile,
  ProjectProfileValue,
  ResourceConflictCondition,
  ResourceProfileCondition,
  ResourceQuery,
  ResourceSelectionDecision,
  ResourceSelectionInput,
  ResourceSelectionResult,
  WorkspaceResource,
} from './types.js';

/**
 * Control resource type.
 */
type ControlResourceType = 'preset' | 'extension';

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
   * Resolve final resources from project profile, presets, extensions and defaults.
   *
   * @param input Selection input.
   * @returns Selection result with explanations.
   */
  public resolveSelection(input: ResourceSelectionInput = {}): ResourceSelectionResult {
    if (!hasProjectProfile(input.profile) && input.presetIds === undefined && input.extensionIds === undefined) {
      return this.resolveLegacySelection();
    }

    const selectedIds = new Set<string>();
    const decisions = new Map<string, ResourceSelectionDecision>();

    this.selectEnabledDefaultResources(input.profile, selectedIds, decisions);
    this.selectControlResources('preset', input.presetIds, input.profile, selectedIds, decisions);
    this.selectControlResources('extension', input.extensionIds, input.profile, selectedIds, decisions);

    return this.createSelectionResult(selectedIds, decisions);
  }

  /**
   * Resolve legacy enabledByDefault resources.
   *
   * @returns Selection result.
   */
  private resolveLegacySelection(): ResourceSelectionResult {
    const enabledResourceIds = this.resources
      .filter((resource) => resource.enabledByDefault)
      .map((resource) => resource.id);
    const resources = this.resolveDependencies(enabledResourceIds);
    const selectedIds = new Set(resources.map((resource) => resource.id));

    return {
      resources,
      decisions: this.resources.map((resource) => ({
        id: resource.id,
        status: selectedIds.has(resource.id) ? 'selected' : 'excluded',
        reason: selectedIds.has(resource.id) ? 'legacy enabledByDefault selection' : 'not enabledByDefault in legacy selection',
      })),
    };
  }

  /**
   * Select ordinary enabled resources.
   *
   * @param profile Project profile.
   * @param selectedIds Selected id set.
   * @param decisions Decision map.
   */
  private selectEnabledDefaultResources(
    profile: ProjectProfile | undefined,
    selectedIds: Set<string>,
    decisions: Map<string, ResourceSelectionDecision>,
  ): void {
    for (const resource of this.resources) {
      if (resource.type === 'preset' || resource.type === 'extension') {
        continue;
      }

      if (!resource.enabledByDefault) {
        this.setExcludedDecision(decisions, resource, 'not enabledByDefault');
        continue;
      }

      this.selectResourceIfApplicable(resource, profile, selectedIds, decisions, 'enabledByDefault');
    }
  }

  /**
   * Select preset or extension resources.
   *
   * @param type Control resource type.
   * @param explicitIds Explicit ids.
   * @param profile Project profile.
   * @param selectedIds Selected id set.
   * @param decisions Decision map.
   */
  private selectControlResources(
    type: ControlResourceType,
    explicitIds: readonly string[] | undefined,
    profile: ProjectProfile | undefined,
    selectedIds: Set<string>,
    decisions: Map<string, ResourceSelectionDecision>,
  ): void {
    const candidates = this.resources
      .filter((resource) => resource.type === type)
      .filter((resource) => explicitIds?.includes(resource.id) ?? resource.enabledByDefault)
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const resource of candidates) {
      const selected = this.selectResourceIfApplicable(resource, profile, selectedIds, decisions, type);

      if (!selected) {
        continue;
      }

      for (const resourceId of resource.defaultResources ?? []) {
        const defaultResource = this.resourceMap.get(resourceId);

        if (defaultResource === undefined) {
          decisions.set(resourceId, {
            id: resourceId,
            status: 'excluded',
            reason: `default resource referenced by ${resource.id} is missing`,
            selectedBy: resource.id,
          });
          continue;
        }

        this.selectResourceIfApplicable(defaultResource, profile, selectedIds, decisions, `defaultResources:${resource.id}`);
      }
    }
  }

  /**
   * Select a single resource if it applies and does not conflict.
   *
   * @param resource Workspace resource.
   * @param profile Project profile.
   * @param selectedIds Selected id set.
   * @param decisions Decision map.
   * @param reason Selection reason.
   * @returns Whether the resource was selected.
   */
  private selectResourceIfApplicable(
    resource: WorkspaceResource,
    profile: ProjectProfile | undefined,
    selectedIds: Set<string>,
    decisions: Map<string, ResourceSelectionDecision>,
    reason: string,
  ): boolean {
    if (!matchesProfileCondition(profile, resource.appliesTo)) {
      this.setExcludedDecision(decisions, resource, 'profile does not match appliesTo');
      return false;
    }

    const conflictReason = findConflictReason(resource.conflictsWith, profile, selectedIds);

    if (conflictReason !== undefined) {
      decisions.set(resource.id, {
        id: resource.id,
        status: 'conflict',
        reason: conflictReason,
      });
      return false;
    }

    selectedIds.add(resource.id);
    decisions.set(resource.id, {
      id: resource.id,
      status: 'selected',
      reason,
    });

    return true;
  }

  /**
   * Set an excluded decision when the resource has no stronger decision.
   *
   * @param decisions Decision map.
   * @param resource Workspace resource.
   * @param reason Exclusion reason.
   */
  private setExcludedDecision(
    decisions: Map<string, ResourceSelectionDecision>,
    resource: WorkspaceResource,
    reason: string,
  ): void {
    if (decisions.has(resource.id)) {
      return;
    }

    decisions.set(resource.id, {
      id: resource.id,
      status: 'excluded',
      reason,
    });
  }

  /**
   * Create ordered selection result.
   *
   * @param selectedIds Selected ids.
   * @param decisions Decision map.
   * @returns Selection result.
   */
  private createSelectionResult(
    selectedIds: ReadonlySet<string>,
    decisions: Map<string, ResourceSelectionDecision>,
  ): ResourceSelectionResult {
    const resources = this.resolveDependencies([...selectedIds]);
    const dependencyIds = new Set(resources.map((resource) => resource.id));

    for (const resource of resources) {
      if (!decisions.has(resource.id)) {
        decisions.set(resource.id, {
          id: resource.id,
          status: 'selected',
          reason: 'dependency of selected resource',
        });
      }
    }

    for (const resource of this.resources) {
      if (!dependencyIds.has(resource.id) && !decisions.has(resource.id)) {
        decisions.set(resource.id, {
          id: resource.id,
          status: 'excluded',
          reason: 'not selected by profile, preset, extension or enabledByDefault',
        });
      }
    }

    return {
      resources,
      decisions: [...decisions.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
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

/**
 * Create a project profile from project.json-like data.
 *
 * @param projectJson Project JSON object.
 * @returns Project profile or undefined.
 */
export function createProjectProfileFromProjectJson(projectJson: unknown): ProjectProfile | undefined {
  if (!isRecord(projectJson)) {
    return undefined;
  }

  const packageManager = readString(projectJson, 'packageManager');
  const frameworks = readStringArray(projectJson, 'frameworks').map(normalizeProfileValue);
  const typescript = readObject(projectJson, 'typescript');
  const packageJson = readObject(projectJson, 'packageJson');
  const dependencies = {
    ...readStringRecord(packageJson, 'dependencies'),
    ...readStringRecord(packageJson, 'devDependencies'),
  };
  const language = readBoolean(typescript, 'enabled') === true || dependencies.typescript !== undefined ? 'typescript' : undefined;
  const uiLibrary = detectUiLibraries(dependencies);
  const projectType = frameworks.some((framework) => ['vue', 'react', 'next.js', 'vite'].includes(framework))
    ? 'frontend'
    : undefined;
  const profile: ProjectProfile = removeUndefinedProfileValues({
    framework: frameworks.length > 0 ? frameworks : undefined,
    language,
    packageManager: packageManager === undefined ? undefined : normalizeProfileValue(packageManager),
    uiLibrary: uiLibrary.length > 0 ? uiLibrary : undefined,
    projectType,
  });

  return hasProjectProfile(profile) ? profile : undefined;
}

/**
 * Check whether a project profile has any usable field.
 *
 * @param profile Project profile.
 * @returns Whether the profile has data.
 */
function hasProjectProfile(profile: ProjectProfile | undefined): profile is ProjectProfile {
  return (
    profile !== undefined &&
    (profile.framework !== undefined ||
      profile.language !== undefined ||
      profile.packageManager !== undefined ||
      profile.uiLibrary !== undefined ||
      profile.projectType !== undefined)
  );
}

/**
 * Check whether profile matches a condition.
 *
 * @param profile Project profile.
 * @param condition Profile condition.
 * @returns Whether the condition matches.
 */
function matchesProfileCondition(
  profile: ProjectProfile | undefined,
  condition: ResourceProfileCondition | undefined,
): boolean {
  if (condition === undefined) {
    return true;
  }

  if (!hasProjectProfile(profile)) {
    return false;
  }

  return (
    matchesProfileValue(profile.framework, condition.framework) &&
    matchesProfileValue(profile.language, condition.language) &&
    matchesProfileValue(profile.packageManager, condition.packageManager) &&
    matchesProfileValue(profile.uiLibrary, condition.uiLibrary) &&
    matchesProfileValue(profile.projectType, condition.projectType)
  );
}

/**
 * Find a conflict reason for a resource.
 *
 * @param condition Conflict condition.
 * @param profile Project profile.
 * @param selectedIds Current selected ids.
 * @returns Conflict reason.
 */
function findConflictReason(
  condition: ResourceConflictCondition | undefined,
  profile: ProjectProfile | undefined,
  selectedIds: ReadonlySet<string>,
): string | undefined {
  if (condition === undefined) {
    return undefined;
  }

  const selectedConflicts = [
    ...(condition.resources ?? []),
    ...(condition.presets ?? []),
    ...(condition.extensions ?? []),
  ].filter((resourceId) => selectedIds.has(resourceId));

  if (selectedConflicts.length > 0) {
    return `conflicts with selected resource ${selectedConflicts[0]}`;
  }

  if (hasProfileConditionFields(condition) && matchesProfileCondition(profile, condition)) {
    return 'conflicts with project profile';
  }

  return undefined;
}

/**
 * Check whether a condition contains profile fields.
 *
 * @param condition Profile condition.
 * @returns Whether profile fields exist.
 */
function hasProfileConditionFields(condition: ResourceProfileCondition): boolean {
  return (
    condition.framework !== undefined ||
    condition.language !== undefined ||
    condition.packageManager !== undefined ||
    condition.uiLibrary !== undefined ||
    condition.projectType !== undefined
  );
}

/**
 * Check a profile value.
 *
 * @param actual Actual profile value.
 * @param expected Expected condition value.
 * @returns Whether values match.
 */
function matchesProfileValue(
  actual: ProjectProfileValue | undefined,
  expected: ProjectProfileValue | undefined,
): boolean {
  if (expected === undefined) {
    return true;
  }

  if (actual === undefined) {
    return false;
  }

  const actualValues = toProfileValues(actual);
  const expectedValues = toProfileValues(expected);

  return expectedValues.some((value) => actualValues.includes(value));
}

/**
 * Normalize profile value to an array.
 *
 * @param value Profile value.
 * @returns Normalized array.
 */
function toProfileValues(value: ProjectProfileValue): readonly string[] {
  return (Array.isArray(value) ? value : [value]).map(normalizeProfileValue);
}

/**
 * Normalize a profile string.
 *
 * @param value Raw value.
 * @returns Normalized value.
 */
function normalizeProfileValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Detect known UI libraries from dependencies.
 *
 * @param dependencies Dependency record.
 * @returns UI library names.
 */
function detectUiLibraries(dependencies: Readonly<Record<string, string>>): readonly string[] {
  const knownUiLibraries = ['element-plus', 'ant-design-vue', 'naive-ui', 'vuetify', '@arco-design/web-vue'];

  return knownUiLibraries.filter((dependencyName) => dependencies[dependencyName] !== undefined);
}

/**
 * Remove undefined fields from a profile.
 *
 * @param profile Profile object.
 * @returns Clean profile.
 */
function removeUndefinedProfileValues(profile: ProjectProfile): ProjectProfile {
  return {
    ...(profile.framework === undefined ? {} : { framework: profile.framework }),
    ...(profile.language === undefined ? {} : { language: profile.language }),
    ...(profile.packageManager === undefined ? {} : { packageManager: profile.packageManager }),
    ...(profile.uiLibrary === undefined ? {} : { uiLibrary: profile.uiLibrary }),
    ...(profile.projectType === undefined ? {} : { projectType: profile.projectType }),
  };
}

/**
 * Read a string field.
 *
 * @param record Record.
 * @param key Field key.
 * @returns String value.
 */
function readString(record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a boolean field.
 *
 * @param record Record.
 * @param key Field key.
 * @returns Boolean value.
 */
function readBoolean(record: Readonly<Record<string, unknown>> | undefined, key: string): boolean | undefined {
  const value = record?.[key];

  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Read a JSON object field.
 *
 * @param record Record.
 * @param key Field key.
 * @returns Object value.
 */
function readObject(record: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> | undefined {
  const value = record[key];

  return isRecord(value) ? value : undefined;
}

/**
 * Read string array field.
 *
 * @param record Record.
 * @param key Field key.
 * @returns String array.
 */
function readStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key];

  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Read string record field.
 *
 * @param record Record.
 * @param key Field key.
 * @returns String record.
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
