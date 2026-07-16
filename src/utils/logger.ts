import chalk from 'chalk';

/**
 * 日志输出器。
 */
interface Logger {
  /**
   * 输出普通信息。
   */
  readonly info: (message: string) => void;
  /**
   * 输出成功信息。
   */
  readonly success: (message: string) => void;
  /**
   * 输出警告信息。
   */
  readonly warn: (message: string) => void;
  /**
   * 输出错误信息。
   */
  readonly error: (message: string) => void;
}

/**
 * 命令行日志工具。
 */
export const logger: Logger = {
  info(message: string): void {
    console.log(chalk.cyan(message));
  },
  success(message: string): void {
    console.log(chalk.green(`✓ ${message}`));
  },
  warn(message: string): void {
    console.warn(chalk.yellow(`! ${message}`));
  },
  error(message: string): void {
    console.error(chalk.red(`✗ ${message}`));
  },
};
