import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

/**
 * 模板资源复制结果。
 */
export interface CopyAssetsResult {
  /**
   * 已复制文件数量。
   */
  readonly copiedFiles: number;
  /**
   * 已跳过文件数量。
   */
  readonly skippedFiles: number;
  /**
   * 已创建目录数量。
   */
  readonly createdDirectories: number;
}

/**
 * 可变模板资源复制结果。
 */
interface MutableCopyAssetsResult {
  /**
   * 已复制文件数量。
   */
  copiedFiles: number;
  /**
   * 已跳过文件数量。
   */
  skippedFiles: number;
  /**
   * 已创建目录数量。
   */
  createdDirectories: number;
}

/**
 * 资源目录名称。
 */
const ASSETS_DIRECTORY_NAME = 'assets';

/**
 * 将内置 assets 资源复制到目标工作区。
 *
 * @param targetWorkspaceDirectory 目标 VEAW 工作区目录。
 * @returns 模板资源复制结果。
 */
export async function copyAssetsToWorkspace(targetWorkspaceDirectory: string): Promise<CopyAssetsResult> {
  const assetsDirectory = await resolveAssetsDirectory();
  const result: MutableCopyAssetsResult = {
    copiedFiles: 0,
    skippedFiles: 0,
    createdDirectories: 0,
  };

  await copyDirectoryContents(assetsDirectory, targetWorkspaceDirectory, result);

  return result;
}

/**
 * 解析内置 assets 资源目录。
 *
 * @returns assets 资源目录路径。
 */
async function resolveAssetsDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidateDirectories = [
    path.resolve(moduleDirectory, '..', '..', ASSETS_DIRECTORY_NAME),
    path.resolve(moduleDirectory, '..', ASSETS_DIRECTORY_NAME),
  ];

  for (const candidateDirectory of candidateDirectories) {
    if (await fs.pathExists(candidateDirectory)) {
      return candidateDirectory;
    }
  }

  throw new Error('Assets directory not found.');
}

/**
 * 复制目录内容。
 *
 * @param sourceDirectory 源目录。
 * @param targetDirectory 目标目录。
 * @param result 复制结果。
 */
async function copyDirectoryContents(
  sourceDirectory: string,
  targetDirectory: string,
  result: MutableCopyAssetsResult,
): Promise<void> {
  await ensureTargetDirectory(targetDirectory, result);

  const entries = await fs.readdir(sourceDirectory);

  for (const entryName of entries) {
    await copyEntry(path.join(sourceDirectory, entryName), path.join(targetDirectory, entryName), result);
  }
}

/**
 * 复制单个资源项。
 *
 * @param sourcePath 源路径。
 * @param targetPath 目标路径。
 * @param result 复制结果。
 */
async function copyEntry(sourcePath: string, targetPath: string, result: MutableCopyAssetsResult): Promise<void> {
  const sourceStat = await fs.stat(sourcePath);

  if (sourceStat.isDirectory()) {
    await copyDirectoryContents(sourcePath, targetPath, result);
    return;
  }

  await copyFileIfMissing(sourcePath, targetPath, result);
}

/**
 * 确保目标目录存在。
 *
 * @param targetDirectory 目标目录。
 * @param result 复制结果。
 */
async function ensureTargetDirectory(targetDirectory: string, result: MutableCopyAssetsResult): Promise<void> {
  if (await fs.pathExists(targetDirectory)) {
    return;
  }

  await fs.ensureDir(targetDirectory);
  result.createdDirectories += 1;
}

/**
 * 在目标文件不存在时复制文件。
 *
 * @param sourceFilePath 源文件路径。
 * @param targetFilePath 目标文件路径。
 * @param result 复制结果。
 */
async function copyFileIfMissing(
  sourceFilePath: string,
  targetFilePath: string,
  result: MutableCopyAssetsResult,
): Promise<void> {
  if (await fs.pathExists(targetFilePath)) {
    result.skippedFiles += 1;
    return;
  }

  await fs.copy(sourceFilePath, targetFilePath, {
    errorOnExist: false,
    overwrite: false,
  });
  result.copiedFiles += 1;
}
