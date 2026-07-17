import { Command } from 'commander';
import { registerAskCommand } from './commands/ask.js';
import { registerCatalogCommand } from './commands/catalog.js';
import { registerContextCommand } from './commands/context.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInitCommand } from './commands/init.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerSessionCommand } from './commands/session.js';
import { registerSyncCommand } from './commands/sync.js';
import { CLI_VERSION, registerVersionCommand } from './commands/version.js';
import { registerWorkspaceCommandsCommand } from './commands/workspace-commands.js';

/**
 * CLI 主程序实例。
 */
const program = new Command();

program
  .name('veaw')
  .description('Veaw command line interface.')
  .version(CLI_VERSION, '-v, --version', 'Display the current CLI version.');

registerAskCommand(program);
registerInitCommand(program);
registerSyncCommand(program);
registerCatalogCommand(program);
registerContextCommand(program);
registerPlanCommand(program);
registerSessionCommand(program);
registerDoctorCommand(program);
registerWorkspaceCommandsCommand(program);
registerVersionCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(message);
  process.exitCode = 1;
});
