import { Command } from 'commander';
import { logger } from '../utils/logger.js';

/**
 * 当前 CLI 版本号。
 */
export const CLI_VERSION = '0.1.0';

/**
 * 注册 version 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Display the current CLI version.')
    .action((): void => {
      logger.info(CLI_VERSION);
    });
}
