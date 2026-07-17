import { Command } from 'commander';
import ora from 'ora';
import { validateVeaw } from '../resource-loader/index.js';
import type { ValidationResult } from '../resource-loader/index.js';
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
 * doctor 命令选项。
 */
interface DoctorCommandOptions {
  /**
   * 校验 Registry 与 Project。
   */
  readonly registry?: boolean;
  /**
   * 输出 JSON。
   */
  readonly json?: boolean;
  /**
   * 显式 Workspace 路径。
   */
  readonly workspace?: string;
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
    .option('--registry', 'Validate Workspace registries and current project lockfile.')
    .option('--workspace <path>', 'Use a VEAW Workspace directory for registry validation.')
    .option('--json', 'Print machine-readable JSON output.')
    .action(async (options: DoctorCommandOptions): Promise<void> => {
      await runDoctorCommand(options);
    });
}

/**
 * 执行 doctor 命令。
 *
 * @param options doctor 命令选项。
 */
export async function runDoctorCommand(options: DoctorCommandOptions = {}): Promise<void> {
  if (options.registry === true) {
    await runRegistryDoctor(options);
    return;
  }

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
 * 执行 Registry doctor。
 *
 * @param options doctor 命令选项。
 */
async function runRegistryDoctor(options: DoctorCommandOptions): Promise<void> {
  const result = await validateVeaw({
    projectDirectory: process.cwd(),
    workspaceDirectory: options.workspace,
  });

  if (options.json === true) {
    console.log(JSON.stringify(result, undefined, 2));
  } else {
    printValidationSummary(result);
  }

  process.exitCode = result.exitCode;
}

/**
 * 输出校验摘要。
 *
 * @param result 校验结果。
 */
function printValidationSummary(result: ValidationResult): void {
  if (result.ok) {
    logger.success('Registry validation passed.');
  } else {
    logger.error(`Registry validation failed: ${result.summary.errorCount} error(s), ${result.summary.warningCount} warning(s).`);
  }

  for (const issue of result.issues) {
    const message = `${issue.code} ${issue.path}: ${issue.message}`;

    if (issue.severity === 'error') {
      logger.error(message);
      continue;
    }

    logger.warn(message);
  }
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
