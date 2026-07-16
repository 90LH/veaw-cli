import { execa } from 'execa';

/**
 * 命令执行结果。
 */
export interface ShellResult {
  /**
   * 标准输出。
   */
  readonly stdout: string;
  /**
   * 标准错误输出。
   */
  readonly stderr: string;
}

/**
 * 执行外部命令。
 *
 * @param command 命令名称。
 * @param args 命令参数。
 * @returns 命令执行结果。
 */
export async function runCommand(command: string, args: readonly string[] = []): Promise<ShellResult> {
  const result = await execa(command, args, {
    preferLocal: true,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
