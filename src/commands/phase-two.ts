import path from 'node:path';
import { Command } from 'commander';
import {
  createDesignContext,
  createReviewResult,
  createScreenshotContext,
  createTaskList,
  createUiComponentContext,
  formatJsonOutput,
  parseDesignContext,
  parseTaskList,
  parseUiComponentContext,
  queryLocalComponents,
  readOptionalProjectFile,
  writeExplicitOutput,
} from '../context/capabilities.js';
import { logger } from '../utils/logger.js';

interface SharedContextOptions {
  readonly output?: string;
}

interface ScreenshotOptions extends SharedContextOptions {
  readonly route?: string;
  readonly viewport?: string;
  readonly source?: 'user-provided' | 'local-test';
  readonly components?: string;
}

interface ComponentQueryOptions extends SharedContextOptions {
  readonly limit?: string;
}

interface UiComponentOptions extends ScreenshotOptions {
  readonly screenshot?: string;
  readonly query?: string;
  readonly enableMcp?: boolean;
}

type DesignContextOptions = UiComponentOptions;

interface TaskListOptions extends SharedContextOptions {
  readonly plan?: string;
  readonly designContext?: string;
}

interface ReviewOptions extends SharedContextOptions {
  readonly plan?: string;
  readonly designContext?: string;
  readonly taskList?: string;
  readonly uiComponentContext?: string;
}

export function registerPhaseTwoCommands(program: Command): void {
  program
    .command('screenshot-context')
    .description('Create a machine-readable screenshot context from an explicit local screenshot reference.')
    .argument('[screenshot]', 'Explicit user-provided or local-test screenshot path.')
    .option('--route <route>', 'Related page route.')
    .option('--viewport <viewport>', 'Viewport label, for example 1440x900.')
    .option('--source <source>', 'Screenshot source: user-provided or local-test.', 'user-provided')
    .option('--components <names>', 'Comma-separated related component names.')
    .option('-o, --output <file>', 'Write JSON output to a file.')
    .action(async (screenshot: string | undefined, options: ScreenshotOptions): Promise<void> => {
      await runJsonCommand(async (): Promise<unknown> => createScreenshotContext({
        projectDirectory: process.cwd(),
        screenshotPath: screenshot,
        route: options.route,
        viewport: options.viewport,
        source: normalizeScreenshotSource(options.source),
        relatedComponents: splitList(options.components),
      }), options.output);
    });

  program
    .command('component-query')
    .description('Query local component catalog as a stable fallback for component intelligence.')
    .argument('<query...>', 'Component query words.')
    .option('--limit <number>', 'Maximum candidate count.')
    .option('-o, --output <file>', 'Write JSON output to a file.')
    .action(async (queryParts: readonly string[], options: ComponentQueryOptions): Promise<void> => {
      await runJsonCommand(async (): Promise<unknown> => queryLocalComponents({
        projectDirectory: process.cwd(),
        query: normalizeParts(queryParts),
        limit: parsePositiveInteger(options.limit),
      }), options.output);
    });

  program
    .command('ui-component-context')
    .description('Merge screenshot metadata, local catalog, and optional internal component MCP candidates.')
    .argument('[requirement...]', 'Optional page or component requirement.')
    .option('--screenshot <file>', 'Explicit screenshot path.')
    .option('--route <route>', 'Related page route.')
    .option('--viewport <viewport>', 'Viewport label, for example 1440x900.')
    .option('--components <names>', 'Comma-separated related component names.')
    .option('--query <text>', 'Local catalog query text.')
    .option('--enable-mcp', 'Explicitly enable configured internal component MCP.')
    .option('-o, --output <file>', 'Write JSON output to a file.')
    .action(async (requirementParts: readonly string[] | undefined, options: UiComponentOptions): Promise<void> => {
      await runJsonCommand(async (): Promise<unknown> => createUiComponentContext({
        projectDirectory: process.cwd(),
        requirement: normalizeOptionalParts(requirementParts),
        screenshotPath: options.screenshot,
        route: options.route,
        viewport: options.viewport,
        relatedComponents: splitList(options.components),
        query: options.query,
        enableMcp: options.enableMcp === true,
      }), options.output);
    });

  program
    .command('design-context')
    .description('Create machine-readable design context from requirement, project context, screenshot, and component candidates.')
    .argument('<requirement...>', 'Page requirement.')
    .option('--screenshot <file>', 'Explicit screenshot path.')
    .option('--route <route>', 'Related page route.')
    .option('--viewport <viewport>', 'Viewport label, for example 1440x900.')
    .option('--components <names>', 'Comma-separated related component names.')
    .option('--query <text>', 'Local catalog query text.')
    .option('--enable-mcp', 'Explicitly enable configured internal component MCP.')
    .option('-o, --output <file>', 'Write JSON output to a file.')
    .action(async (requirementParts: readonly string[], options: DesignContextOptions): Promise<void> => {
      await runJsonCommand(async (): Promise<unknown> => createDesignContext({
        projectDirectory: process.cwd(),
        requirement: normalizeParts(requirementParts),
        screenshotPath: options.screenshot,
        route: options.route,
        viewport: options.viewport,
        relatedComponents: splitList(options.components),
        query: options.query,
        enableMcp: options.enableMcp === true,
      }), options.output);
    });

  program
    .command('task-list')
    .description('Generate an ordered task list from a plan and optional design context.')
    .argument('<requirement...>', 'Page requirement.')
    .option('--plan <file>', 'Plan file path to read.')
    .option('--design-context <file>', 'Design context JSON file path to read.')
    .option('-o, --output <file>', 'Write JSON output to a file.')
    .action(async (requirementParts: readonly string[], options: TaskListOptions): Promise<void> => {
      const projectDirectory = process.cwd();
      const designContent = await readOptionalProjectFile(projectDirectory, options.designContext);

      await runJsonCommand(async (): Promise<unknown> => createTaskList({
        projectDirectory,
        requirement: normalizeParts(requirementParts),
        planContent: await readOptionalProjectFile(projectDirectory, options.plan),
        designContext: designContent === undefined ? undefined : parseDesignContext(designContent),
      }), options.output);
    });

  program
    .command('review')
    .description('Review generated VEAW plan, design context, task list, and UI component context for consistency.')
    .option('--plan <file>', 'Plan file path to read.')
    .option('--design-context <file>', 'Design context JSON file path to read.')
    .option('--task-list <file>', 'Task list JSON file path to read.')
    .option('--ui-component-context <file>', 'UI component context JSON file path to read.')
    .option('-o, --output <file>', 'Write JSON output to a file.')
    .action(async (options: ReviewOptions): Promise<void> => {
      const projectDirectory = process.cwd();
      const designContent = await readOptionalProjectFile(projectDirectory, options.designContext);
      const taskListContent = await readOptionalProjectFile(projectDirectory, options.taskList);
      const uiComponentContent = await readOptionalProjectFile(projectDirectory, options.uiComponentContext);

      await runJsonCommand(async (): Promise<unknown> => createReviewResult({
        projectDirectory,
        planContent: await readOptionalProjectFile(projectDirectory, options.plan),
        designContext: designContent === undefined ? undefined : parseDesignContext(designContent),
        taskList: taskListContent === undefined ? undefined : parseTaskList(taskListContent),
        uiComponentContext: uiComponentContent === undefined ? undefined : parseUiComponentContext(uiComponentContent),
      }), options.output);
    });
}

async function runJsonCommand(createValue: () => Promise<unknown>, output: string | undefined): Promise<void> {
  try {
    const value = await createValue();
    const content = formatJsonOutput(value);

    console.log(content);

    const outputPath = await writeExplicitOutput(process.cwd(), output, content);

    if (outputPath === undefined) {
      logger.info('默认 stdout-only，未写入文件');
      return;
    }

    logger.success(`已写入 ${normalizePath(path.relative(process.cwd(), outputPath))}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`生成第二阶段上下文失败：${message}`);
    process.exitCode = 1;
  }
}

function normalizeParts(parts: readonly string[]): string {
  return parts.join(' ').trim();
}

function normalizeOptionalParts(parts: readonly string[] | undefined): string | undefined {
  const normalized = parts === undefined ? '' : normalizeParts(parts);

  return normalized.length === 0 ? undefined : normalized;
}

function splitList(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }

  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeScreenshotSource(value: string | undefined): 'user-provided' | 'local-test' {
  return value === 'local-test' ? 'local-test' : 'user-provided';
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/gu, '/');
}
