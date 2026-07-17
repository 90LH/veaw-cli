import path from 'node:path';
import fs from 'fs-extra';
import type {
  MaterializeResourceInput,
  MaterializeResourceResult,
  ResourceOverwritePolicy,
} from './types.js';

/**
 * 托管块开始标记。
 */
const MANAGED_BLOCK_START = '<!-- VEAW_RESOURCE_START -->';

/**
 * 托管块结束标记。
 */
const MANAGED_BLOCK_END = '<!-- VEAW_RESOURCE_END -->';

/**
 * 物化单个资源。
 *
 * @param input 物化输入。
 * @returns 物化结果。
 */
export async function materializeResource(input: MaterializeResourceInput): Promise<MaterializeResourceResult> {
  const sourcePath = path.join(input.workspaceDirectory, input.resource.sourcePath);
  const targetPath = path.join(input.projectDirectory, input.resource.targetPath);

  if (input.resource.copyPolicy === 'none') {
    return createResult(input.resource.id, 'skipped', sourcePath, targetPath);
  }

  if (input.resource.copyPolicy === 'reference') {
    return createResult(input.resource.id, 'referenced', sourcePath, targetPath);
  }

  const sourceContent = await fs.readFile(sourcePath, 'utf8');
  const content = input.resource.copyPolicy === 'render' ? renderTemplate(sourceContent, input.variables ?? {}) : sourceContent;

  const action = input.resource.copyPolicy === 'render' ? 'rendered' : 'copied';
  const written = await writeWithOverwritePolicy(targetPath, content, input.overwritePolicy ?? input.resource.overwritePolicy);

  return createResult(input.resource.id, written ? action : 'skipped', sourcePath, targetPath);
}

/**
 * 渲染模板。
 *
 * @param content 模板内容。
 * @param variables 变量表。
 * @returns 渲染后内容。
 */
export function renderTemplate(content: string, variables: Readonly<Record<string, string>>): string {
  return content.replaceAll(/\{\{\s*([A-Za-z_$][\w$.-]*)\s*\}\}/g, (match: string, key: string): string => {
    return variables[key] ?? match;
  });
}

/**
 * 按覆盖策略写入文件。
 *
 * @param targetPath 目标路径。
 * @param content 内容。
 * @param overwritePolicy 覆盖策略。
 * @returns 是否写入。
 */
async function writeWithOverwritePolicy(
  targetPath: string,
  content: string,
  overwritePolicy: ResourceOverwritePolicy,
): Promise<boolean> {
  const exists = await fs.pathExists(targetPath);

  if (overwritePolicy === 'never' && exists) {
    return false;
  }

  if (overwritePolicy === 'if-missing' && exists) {
    return false;
  }

  if (overwritePolicy === 'managed-block' && exists) {
    await fs.outputFile(targetPath, await replaceManagedBlock(targetPath, content));
    return true;
  }

  await fs.outputFile(targetPath, content);
  return true;
}

/**
 * 替换托管块。
 *
 * @param targetPath 目标路径。
 * @param content 新内容。
 * @returns 替换后的内容。
 */
async function replaceManagedBlock(targetPath: string, content: string): Promise<string> {
  const currentContent = await fs.readFile(targetPath, 'utf8');
  const startIndex = currentContent.indexOf(MANAGED_BLOCK_START);
  const endIndex = currentContent.indexOf(MANAGED_BLOCK_END);
  const managedContent = [MANAGED_BLOCK_START, content.trimEnd(), MANAGED_BLOCK_END].join('\n');

  if (startIndex >= 0 && endIndex > startIndex) {
    return `${currentContent.slice(0, startIndex)}${managedContent}${currentContent.slice(
      endIndex + MANAGED_BLOCK_END.length,
    )}`;
  }

  return `${currentContent.trimEnd()}\n\n${managedContent}\n`;
}

/**
 * 创建物化结果。
 *
 * @param resourceId 资源 id。
 * @param action 物化动作。
 * @param sourcePath 源路径。
 * @param targetPath 目标路径。
 * @returns 物化结果。
 */
function createResult(
  resourceId: string,
  action: MaterializeResourceResult['action'],
  sourcePath: string,
  targetPath: string,
): MaterializeResourceResult {
  return {
    resourceId,
    action,
    sourcePath,
    targetPath,
  };
}
