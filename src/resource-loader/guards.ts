import type {
  ResourceCopyPolicy,
  ResourceOverwritePolicy,
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
    readString(value, 'hash') !== undefined
  );
}
