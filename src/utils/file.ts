import fs from 'fs-extra';

/**
 * 确保目录存在。
 *
 * @param directoryPath 目录路径。
 */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.ensureDir(directoryPath);
}

/**
 * 判断路径是否存在。
 *
 * @param targetPath 目标路径。
 * @returns 路径是否存在。
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  return fs.pathExists(targetPath);
}

/**
 * 写入 JSON 文件。
 *
 * @param filePath 文件路径。
 * @param data JSON 数据。
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.writeJson(filePath, data, {
    spaces: 2,
  });
}
