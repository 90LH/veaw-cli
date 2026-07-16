import fs from 'fs-extra';

/**
 * 读取目录下的直接子项名称。
 *
 * @param directoryPath 目录路径。
 * @returns 子项名称列表。
 */
export async function readDirectory(directoryPath: string): Promise<string[]> {
  return fs.readdir(directoryPath);
}

/**
 * 确保目录存在。
 *
 * @param directoryPath 目录路径。
 */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.ensureDir(directoryPath);
}

/**
 * 删除目录及其所有内容。
 *
 * @param directoryPath 目录路径。
 */
export async function removeDirectory(directoryPath: string): Promise<void> {
  await fs.remove(directoryPath);
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
 * 读取文本文件。
 *
 * @param filePath 文件路径。
 * @returns 文本内容。
 */
export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
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

/**
 * 写入文本文件。
 *
 * @param filePath 文件路径。
 * @param content 文本内容。
 */
export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.outputFile(filePath, content);
}

/**
 * 在文件不存在时写入文本内容。
 *
 * @param filePath 文件路径。
 * @param content 文本内容。
 * @returns 是否写入了文件。
 */
export async function writeTextFileIfNotExists(filePath: string, content: string): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  await fs.outputFile(filePath, content);

  return true;
}
