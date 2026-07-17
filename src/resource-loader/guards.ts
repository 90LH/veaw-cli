import type {
  ResourceCopyPolicy,
  ResourceConflictCondition,
  ResourceOverwritePolicy,
  ResourceProfileCondition,
  WorkspaceResource,
} from './types.js';

/**
 * 判断值是否是对象记录。
 *
 * @param value 待判断值。
 * @returns 是否是对象记录。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读取字符串字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串字段。
 */
export function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * 读取布尔字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 布尔字段。
 */
export function readBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = record[key];

  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 读取字符串数组字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串数组。
 */
export function readStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] | undefined {
  const value = record[key];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = value.filter((item): item is string => typeof item === 'string');

  return result.length === value.length ? result : undefined;
}

/**
 * 读取 profile 条件字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns profile 条件。
 */
export function readProfileCondition(
  record: Readonly<Record<string, unknown>>,
  key: string,
): ResourceProfileCondition | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return createProfileCondition(value);
}

/**
 * 读取冲突条件字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 冲突条件。
 */
export function readConflictCondition(
  record: Readonly<Record<string, unknown>>,
  key: string,
): ResourceConflictCondition | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return {
    ...createProfileCondition(value),
    resources: readStringArray(value, 'resources'),
    presets: readStringArray(value, 'presets'),
    extensions: readStringArray(value, 'extensions'),
  };
}

/**
 * 判断 copyPolicy 是否有效。
 *
 * @param value 待判断值。
 * @returns 是否是 copyPolicy。
 */
export function isCopyPolicy(value: unknown): value is ResourceCopyPolicy {
  return value === 'copy' || value === 'reference' || value === 'render' || value === 'none';
}

/**
 * 判断 overwritePolicy 是否有效。
 *
 * @param value 待判断值。
 * @returns 是否是 overwritePolicy。
 */
export function isOverwritePolicy(value: unknown): value is ResourceOverwritePolicy {
  return value === 'never' || value === 'if-missing' || value === 'managed-block' || value === 'always';
}

/**
 * 判断值是否是 WorkspaceResource。
 *
 * @param value 待判断值。
 * @returns 是否是 WorkspaceResource。
 */
export function isWorkspaceResource(value: unknown): value is WorkspaceResource {
  if (!isRecord(value)) {
    return false;
  }

  return (
    readString(value, 'id') !== undefined &&
    readString(value, 'type') !== undefined &&
    readString(value, 'version') !== undefined &&
    readString(value, 'sourcePath') !== undefined &&
    readString(value, 'targetPath') !== undefined &&
    readStringArray(value, 'tags') !== undefined &&
    readStringArray(value, 'dependencies') !== undefined &&
    readBoolean(value, 'enabledByDefault') !== undefined &&
    isCopyPolicy(value.copyPolicy) &&
    isOverwritePolicy(value.overwritePolicy) &&
    readString(value, 'hash') !== undefined &&
    isOptionalProfileCondition(value.appliesTo) &&
    isOptionalConflictCondition(value.conflictsWith) &&
    (value.defaultResources === undefined || readStringArray(value, 'defaultResources') !== undefined)
  );
}

/**
 * 创建 profile 条件。
 *
 * @param record 对象记录。
 * @returns profile 条件。
 */
function createProfileCondition(record: Readonly<Record<string, unknown>>): ResourceProfileCondition {
  return {
    ...readProfileConditionField(record, 'framework'),
    ...readProfileConditionField(record, 'language'),
    ...readProfileConditionField(record, 'packageManager'),
    ...readProfileConditionField(record, 'uiLibrary'),
    ...readProfileConditionField(record, 'projectType'),
  };
}

/**
 * 读取 profile 条件单个字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns profile 条件局部对象。
 */
function readProfileConditionField(
  record: Readonly<Record<string, unknown>>,
  key: keyof ResourceProfileCondition,
): Partial<ResourceProfileCondition> {
  const value = record[key];

  if (typeof value === 'string') {
    return {
      [key]: value,
    };
  }

  const arrayValue = readStringArray(record, key);

  if (arrayValue !== undefined) {
    return {
      [key]: arrayValue,
    };
  }

  return {};
}

/**
 * 判断可选 profile 条件是否有效。
 *
 * @param value 原始值。
 * @returns 是否有效。
 */
function isOptionalProfileCondition(value: unknown): boolean {
  return value === undefined || isProfileCondition(value);
}

/**
 * 判断可选冲突条件是否有效。
 *
 * @param value 原始值。
 * @returns 是否有效。
 */
function isOptionalConflictCondition(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (!isProfileCondition(value)) {
    return false;
  }

  return (
    value.resources === undefined || readStringArray(value, 'resources') !== undefined
  ) && (
    value.presets === undefined || readStringArray(value, 'presets') !== undefined
  ) && (
    value.extensions === undefined || readStringArray(value, 'extensions') !== undefined
  );
}

/**
 * 判断 profile 条件是否有效。
 *
 * @param value 原始值。
 * @returns 是否有效。
 */
function isProfileCondition(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalProfileValue(value.framework) &&
    isOptionalProfileValue(value.language) &&
    isOptionalProfileValue(value.packageManager) &&
    isOptionalProfileValue(value.uiLibrary) &&
    isOptionalProfileValue(value.projectType)
  );
}

/**
 * 判断 profile 条件值是否有效。
 *
 * @param value 原始值。
 * @returns 是否有效。
 */
function isOptionalProfileValue(value: unknown): boolean {
  return value === undefined || typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}
