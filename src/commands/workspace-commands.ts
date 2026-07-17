import { Command } from 'commander';
import {
  discoverWorkspace,
  executeWorkspaceCommand,
  findWorkspaceCommand,
  parseWorkspaceCommandArguments,
  readWorkspaceCommandRegistry,
} from '../resource-loader/index.js';
import type { WorkspaceCommandDefinition, WorkspaceCommandRegistry } from '../resource-loader/index.js';
import { logger } from '../utils/logger.js';

/**
 * Workspace commands 命令选项。
 */
interface WorkspaceCommandsOptions {
  /**
   * VEAW Workspace 路径。
   */
  readonly workspace?: string;
}

/**
 * 注册 Workspace commands 内置命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerWorkspaceCommandsCommand(program: Command): void {
  const commands = program
    .command('commands')
    .description('List and run declarative Workspace commands.');

  commands
    .command('list')
    .description('List declarative Workspace commands.')
    .option('--workspace <path>', 'Use a VEAW Workspace directory.')
    .action(async (options: WorkspaceCommandsOptions): Promise<void> => {
      await runWorkspaceCommandsListCommand(options);
    });

  commands
    .command('run')
    .description('Generate output for a declarative Workspace command.')
    .argument('<command>', 'Workspace command name or id.')
    .argument('[args...]', 'Command arguments in key=value form.')
    .option('--workspace <path>', 'Use a VEAW Workspace directory.')
    .action(async (commandName: string, args: readonly string[], options: WorkspaceCommandsOptions): Promise<void> => {
      await runWorkspaceCommand(commandName, args, options);
    });
}

/**
 * 执行 commands list。
 *
 * @param options 命令选项。
 */
export async function runWorkspaceCommandsListCommand(options: WorkspaceCommandsOptions = {}): Promise<void> {
  try {
    const registry = await loadWorkspaceCommandRegistry(process.cwd(), options);

    if (registry === undefined || registry.commands.length === 0) {
      console.log('No Workspace commands found.');
      return;
    }

    console.log(formatWorkspaceCommandList(registry.commands));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`Workspace commands list failed: ${message}`);
    process.exitCode = 1;
  }
}

/**
 * 执行声明式 Workspace command。
 *
 * @param commandName command 名称或 id。
 * @param args 参数列表。
 * @param options 命令选项。
 */
export async function runWorkspaceCommand(
  commandName: string,
  args: readonly string[],
  options: WorkspaceCommandsOptions = {},
): Promise<void> {
  try {
    const registry = await loadWorkspaceCommandRegistry(process.cwd(), options);

    if (registry === undefined) {
      throw new Error('No Workspace registry was discovered. Declarative commands are unavailable in CLI assets fallback mode.');
    }

    const command = findWorkspaceCommand(registry, commandName);

    if (command === undefined) {
      throw new Error(`Unknown Workspace command: ${commandName}`);
    }

    const parameters = parseWorkspaceCommandArguments(command, args);
    const result = await executeWorkspaceCommand(registry, command, parameters);

    console.log(result.content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`Workspace command failed: ${message}`);
    process.exitCode = 1;
  }
}

/**
 * 加载 Workspace command registry。
 *
 * @param projectDirectory 项目目录。
 * @param options 命令选项。
 * @returns Workspace command registry。
 */
async function loadWorkspaceCommandRegistry(
  projectDirectory: string,
  options: WorkspaceCommandsOptions,
): Promise<WorkspaceCommandRegistry | undefined> {
  const location = await discoverWorkspace({
    projectDirectory,
    explicitWorkspacePath: options.workspace,
    environment: process.env,
  });

  if (location.kind !== 'workspace') {
    return undefined;
  }

  return readWorkspaceCommandRegistry(location);
}

/**
 * 格式化 Workspace command 列表。
 *
 * @param commands command 定义列表。
 * @returns 展示文本。
 */
function formatWorkspaceCommandList(commands: readonly WorkspaceCommandDefinition[]): string {
  return [
    'Workspace Commands',
    '',
    ...commands.map((command) => {
      const required = command.parameters.required.length > 0 ? command.parameters.required.join(', ') : 'none';

      return `- ${command.name} (${command.id}) [${command.execution.type}] required: ${required} - ${command.description}`;
    }),
  ].join('\n');
}
