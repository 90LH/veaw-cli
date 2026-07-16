import { Command } from 'commander';
import ora from 'ora';
import { runCommand } from '../utils/shell.js';
import { logger } from '../utils/logger.js';

/**
 * 环境检查结果。
 */
interface DoctorCheckResult {
  /**
   * 检查项名称。
   */
  readonly name: string;
  /**
   * 检查是否通过。
   */
  readonly passed: boolean;
  /**
   * 检查输出信息。
   */
  readonly message: string;
}

/**
 * 注册 doctor 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the local development environment.')
    .action(async (): Promise<void> => {
      await runDoctorCommand();
    });
}

/**
 * 执行 doctor 命令。
 */
async function runDoctorCommand(): Promise<void> {
  const spinner = ora('Checking environment...').start();
  const results = await Promise.all([checkNodeVersion(), checkPackageManager()]);

  spinner.stop();

  for (const result of results) {
    if (result.passed) {
      logger.success(`${result.name}: ${result.message}`);
      continue;
    }

    logger.error(`${result.name}: ${result.message}`);
  }

  if (results.every((result) => result.passed)) {
    logger.success('Environment looks good.');
    return;
  }

  process.exitCode = 1;
}

/**
 * 检查 Node.js 版本。
 *
 * @returns 检查结果。
 */
async function checkNodeVersion(): Promise<DoctorCheckResult> {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

  return {
    name: 'Node.js',
    passed: major >= 20,
    message: process.version,
  };
}

/**
 * 检查 pnpm 是否可用。
 *
 * @returns 检查结果。
 */
async function checkPackageManager(): Promise<DoctorCheckResult> {
  try {
    const result = await runCommand('pnpm', ['--version']);

    return {
      name: 'pnpm',
      passed: true,
      message: result.stdout,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'pnpm is not available.';

    return {
      name: 'pnpm',
      passed: false,
      message,
    };
  }
}
