import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { runAskCommand } from '../src/commands/ask.js';
import { runCatalogCommand } from '../src/commands/catalog.js';
import { runContextCommand } from '../src/commands/context.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { runInitCommand } from '../src/commands/init.js';
import { runPlanCommand } from '../src/commands/plan.js';
import { runSyncCommand } from '../src/commands/sync.js';
import {
  runWorkspaceCommand,
  runWorkspaceCommandsListCommand,
} from '../src/commands/workspace-commands.js';
import type { ResourceLockEntry, ResourceLockStatus } from '../src/resource-loader/index.js';

/**
 * JSON 对象。
 */
type JsonObject = Record<string, unknown>;

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('pilot acceptance fixture', (): void => {
  it('runs the repeatable pilot flow without touching a business project', async (): Promise<void> => {
    const workspaceDirectory = await createPilotWorkspaceFixture();
    const projectDirectory = await createPilotProjectFixture();
    const reports: CommandReport[] = [];

    await runInDirectory(projectDirectory, async (): Promise<void> => {
      reports.push(
        await runPilotStep('init', `veaw init --workspace ${workspaceDirectory}`, async (): Promise<void> => {
          await runInitCommand({
            workspace: workspaceDirectory,
          });
        }),
      );

      assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'config.json')), true);
      assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'project.json')), true);
      assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'resources.lock.json')), true);
      assert.equal(await readLockStatus(projectDirectory, 'prompt:pilot'), 'installed');

      reports.push(
        await runPilotStep('registry doctor', 'veaw doctor --registry --json', async (): Promise<void> => {
          await runDoctorCommand({
            registry: true,
            json: true,
            workspace: workspaceDirectory,
          });
        }),
      );

      reports.push(
        await runPilotStep('sync', 'veaw sync', async (): Promise<void> => {
          await runSyncCommand();
        }),
      );

      const lockfileAfterSync = await readFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), 'utf8');

      reports.push(
        await runPilotStep('sync idempotent', 'veaw sync', async (): Promise<void> => {
          await runSyncCommand();
        }),
      );

      assert.equal(await readFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), 'utf8'), lockfileAfterSync);

      reports.push(
        await runPilotStep('catalog', 'veaw catalog', async (): Promise<void> => {
          await runCatalogCommand();
        }),
      );

      const catalog = await readJsonObject(path.join(projectDirectory, '.veaw', 'component-catalog', 'catalog.json'));

      assert.equal(readCatalogComponentNames(catalog).includes('PilotButton'), true);

      reports.push(
        await runPilotStep('context', 'veaw context', async (): Promise<void> => {
          await runContextCommand();
        }),
      );

      const contextContent = await readFile(path.join(projectDirectory, '.veaw', 'context.md'), 'utf8');

      assert.match(contextContent, /VEAW Project Context/);
      assert.match(contextContent, /Pilot workspace context/);

      reports.push(
        await runPilotStep('ask', 'veaw ask "How should PilotButton be used?" -o .veaw/pilot-ask.md', async (): Promise<void> => {
          await runAskCommand(['How', 'should', 'PilotButton', 'be', 'used?'], {
            output: '.veaw/pilot-ask.md',
          });
        }),
      );

      assert.match(await readFile(path.join(projectDirectory, '.veaw', 'pilot-ask.md'), 'utf8'), /Pilot ask prompt/);

      reports.push(
        await runPilotStep('plan', 'veaw plan "Add pilot acceptance flow" -o .veaw/plans/pilot-plan.md', async (): Promise<void> => {
          await runPlanCommand(['Add', 'pilot', 'acceptance', 'flow'], {
            output: '.veaw/plans/pilot-plan.md',
          });
        }),
      );

      assert.match(await readFile(path.join(projectDirectory, '.veaw', 'plans', 'pilot-plan.md'), 'utf8'), /Pilot workflow/);

      reports.push(
        await runPilotStep('Workspace commands list', 'veaw commands list', async (): Promise<void> => {
          await runWorkspaceCommandsListCommand();
        }),
      );
      reports.push(
        await runPilotStep('Workspace command', 'veaw commands run pilot description=Ship-pilot', async (): Promise<void> => {
          await runWorkspaceCommand('pilot', ['description=Ship-pilot']);
        }),
      );

      assert.equal(reports.some((report) => report.outputLines.some((line) => line.includes('Pilot Workspace Command'))), true);

      await updateWorkspaceResource(workspaceDirectory, {
        registryName: 'prompts.json',
        resourceId: 'prompt:pilot',
        nextContent: '# Pilot ask prompt v2\nUse the updated pilot resource.',
        nextVersion: '1.0.1',
      });

      reports.push(
        await runPilotStep('sync after Workspace change', 'veaw sync', async (): Promise<void> => {
          await runSyncCommand();
        }),
      );

      const promptTargetPath = path.join(projectDirectory, '.veaw', 'resources', 'prompts', 'pilot.md');

      assert.equal(await readFile(promptTargetPath, 'utf8'), '# Pilot ask prompt v2\nUse the updated pilot resource.');
      assert.equal(await readLockStatus(projectDirectory, 'prompt:pilot'), 'installed');

      await writeFile(promptTargetPath, '# User local pilot edit');
      await updateWorkspaceResource(workspaceDirectory, {
        registryName: 'prompts.json',
        resourceId: 'prompt:pilot',
        nextContent: '# Pilot ask prompt v3\nWorkspace changed again.',
        nextVersion: '1.0.2',
      });

      reports.push(
        await runPilotStep('sync after manual project edit', 'veaw sync', async (): Promise<void> => {
          await runSyncCommand();
        }),
      );

      assert.equal(await readFile(promptTargetPath, 'utf8'), '# User local pilot edit');
      assert.equal(await readLockStatus(projectDirectory, 'prompt:pilot'), 'conflict');

      const lockfileBeforeFallback = await readFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), 'utf8');
      const missingWorkspaceDirectory = path.join(projectDirectory, 'missing-workspace');

      await writeJsonFile(path.join(projectDirectory, '.veaw', 'config.json'), {
        resourceMode: 'workspace',
        workspacePath: missingWorkspaceDirectory,
      });

      reports.push(
        await runPilotStep('fallback sync', 'veaw sync', async (): Promise<void> => {
          await runSyncCommand();
        }),
      );

      assert.equal(await readFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), 'utf8'), lockfileBeforeFallback);
      assert.equal(await readFile(promptTargetPath, 'utf8'), '# User local pilot edit');

      reports.push(
        await runPilotStep('fallback catalog', 'veaw catalog', async (): Promise<void> => {
          await runCatalogCommand();
        }),
      );
      reports.push(
        await runPilotStep('fallback context', 'veaw context', async (): Promise<void> => {
          await runContextCommand();
        }),
      );
      reports.push(
        await runPilotStep('fallback ask', 'veaw ask fallback -o .veaw/pilot-fallback-ask.md', async (): Promise<void> => {
          await runAskCommand(['fallback'], {
            output: '.veaw/pilot-fallback-ask.md',
          });
        }),
      );
      reports.push(
        await runPilotStep('fallback plan', 'veaw plan fallback -o .veaw/plans/pilot-fallback-plan.md', async (): Promise<void> => {
          await runPlanCommand(['fallback'], {
            output: '.veaw/plans/pilot-fallback-plan.md',
          });
        }),
      );

      assert.match(await readFile(path.join(projectDirectory, '.veaw', 'pilot-fallback-ask.md'), 'utf8'), /未提供对应上下文文件|Workspace Prompts/);
      assert.match(await readFile(path.join(projectDirectory, '.veaw', 'plans', 'pilot-fallback-plan.md'), 'utf8'), /CLI fallback/);

      const finalLockEntries = await readLockEntries(projectDirectory);

      await writeJsonFile(path.join(projectDirectory, '.veaw', 'pilot-report.json'), createPilotReport({
        projectDirectory,
        workspaceDirectory,
        reports,
        lockEntries: finalLockEntries,
      }));

      assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'pilot-report.json')), true);
    });
  });
});

/**
 * 命令执行报告。
 */
interface CommandReport {
  /**
   * 步骤名称。
   */
  readonly step: string;
  /**
   * 对应 CLI 命令。
   */
  readonly command: string;
  /**
   * 退出码。
   */
  readonly exitCode: number;
  /**
   * 捕获的输出行。
   */
  readonly outputLines: readonly string[];
}

/**
 * pilot 报告输入。
 */
interface PilotReportInput {
  /**
   * 临时项目目录。
   */
  readonly projectDirectory: string;
  /**
   * 临时 Workspace 目录。
   */
  readonly workspaceDirectory: string;
  /**
   * 命令执行报告。
   */
  readonly reports: readonly CommandReport[];
  /**
   * 最终 lockfile 条目。
   */
  readonly lockEntries: readonly ResourceLockEntry[];
}

/**
 * Workspace 更新输入。
 */
interface WorkspaceResourceUpdateInput {
  /**
   * 子 Registry 文件名。
   */
  readonly registryName: string;
  /**
   * 资源 id。
   */
  readonly resourceId: string;
  /**
   * 新资源内容。
   */
  readonly nextContent: string;
  /**
   * 新资源版本。
   */
  readonly nextVersion: string;
}

/**
 * Registry 资源记录。
 */
interface RegistryResourceRecord {
  /**
   * 资源 id。
   */
  readonly id: string;
  /**
   * 资源类型。
   */
  readonly type: string;
  /**
   * 资源版本。
   */
  readonly version: string;
  /**
   * 源路径。
   */
  readonly sourcePath: string;
  /**
   * 目标路径。
   */
  readonly targetPath: string;
  /**
   * 标签。
   */
  readonly tags: readonly string[];
  /**
   * 依赖。
   */
  readonly dependencies: readonly string[];
  /**
   * 是否默认启用。
   */
  readonly enabledByDefault: boolean;
  /**
   * 复制策略。
   */
  readonly copyPolicy: string;
  /**
   * 覆盖策略。
   */
  readonly overwritePolicy: string;
  /**
   * 内容 hash。
   */
  readonly hash: string;
}

/**
 * Registry 资源输入。
 */
interface RegistryResourceInput {
  /**
   * 资源 id。
   */
  readonly id: string;
  /**
   * 资源类型。
   */
  readonly type: string;
  /**
   * 源路径。
   */
  readonly sourcePath: string;
  /**
   * 目标路径。
   */
  readonly targetPath: string;
  /**
   * 标签。
   */
  readonly tags: readonly string[];
  /**
   * 内容。
   */
  readonly content: string;
  /**
   * 依赖。
   */
  readonly dependencies?: readonly string[];
}

/**
 * 在指定目录内执行回调。
 *
 * @param directory 工作目录。
 * @param callback 回调。
 */
async function runInDirectory(directory: string, callback: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const originalWorkspaceEnvironment = process.env.VEAW_WORKSPACE;

  try {
    process.exitCode = undefined;
    delete process.env.VEAW_WORKSPACE;
    process.chdir(directory);
    await callback();
  } finally {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;

    if (originalWorkspaceEnvironment === undefined) {
      delete process.env.VEAW_WORKSPACE;
    } else {
      process.env.VEAW_WORKSPACE = originalWorkspaceEnvironment;
    }
  }
}

/**
 * 执行 pilot 步骤并捕获输出。
 *
 * @param step 步骤名称。
 * @param command 命令展示文本。
 * @param callback 执行回调。
 * @returns 命令报告。
 */
async function runPilotStep(step: string, command: string, callback: () => Promise<void>): Promise<CommandReport> {
  const logs = await captureConsole(async (): Promise<void> => {
    process.exitCode = undefined;
    await callback();
  });
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;

  assert.equal(exitCode, 0, `${step} should exit successfully`);

  return {
    step,
    command,
    exitCode,
    outputLines: logs.map(truncateOutputLine),
  };
}

/**
 * 捕获 console 输出。
 *
 * @param callback 执行回调。
 * @returns 输出行。
 */
async function captureConsole(callback: () => Promise<void>): Promise<readonly string[]> {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const logs: string[] = [];

  console.log = (...data: unknown[]): void => {
    logs.push(data.map(String).join(' '));
  };
  console.error = (...data: unknown[]): void => {
    logs.push(data.map(String).join(' '));
  };
  console.warn = (...data: unknown[]): void => {
    logs.push(data.map(String).join(' '));
  };

  try {
    await callback();
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }

  return logs;
}

/**
 * 截断报告输出行。
 *
 * @param line 原始输出行。
 * @returns 截断后的输出行。
 */
function truncateOutputLine(line: string): string {
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

/**
 * 创建临时目录。
 *
 * @param prefix 目录名前缀。
 * @returns 临时目录路径。
 */
async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));

  temporaryDirectories.push(directory);

  return directory;
}

/**
 * 创建 pilot Workspace fixture。
 *
 * @returns Workspace 目录。
 */
async function createPilotWorkspaceFixture(): Promise<string> {
  const workspaceDirectory = await createTemporaryDirectory('veaw-pilot-workspace-');
  const registriesDirectory = path.join(workspaceDirectory, 'registries');
  const resources = [
    createRegistryResource({
      id: 'template:context',
      type: 'template',
      sourcePath: 'resources/templates/context.md',
      targetPath: '.veaw/resources/templates/context.md',
      tags: ['context', 'project', 'catalog'],
      content: '# Pilot workspace context\nUse this context in acceptance runs.',
    }),
    createRegistryResource({
      id: 'template:session',
      type: 'template',
      sourcePath: 'resources/templates/session-log.md',
      targetPath: '.veaw/resources/templates/session-log.md',
      tags: ['session'],
      content: '# Pilot session log\n',
    }),
    createRegistryResource({
      id: 'prompt:pilot',
      type: 'prompt',
      sourcePath: 'resources/prompts/pilot.md',
      targetPath: '.veaw/resources/prompts/pilot.md',
      tags: ['ask', 'pilot'],
      content: '# Pilot ask prompt\nUse the pilot prompt resource.',
    }),
    createRegistryResource({
      id: 'rule:pilot',
      type: 'rule',
      sourcePath: 'resources/rules/pilot.md',
      targetPath: '.veaw/resources/rules/pilot.md',
      tags: ['pilot'],
      content: '# Pilot rule\nDo not overwrite user edits silently.',
    }),
    createRegistryResource({
      id: 'skill:pilot',
      type: 'skill',
      sourcePath: 'resources/skills/pilot.md',
      targetPath: '.veaw/resources/skills/pilot.md',
      tags: ['pilot'],
      content: '# Pilot skill\nUse conservative TypeScript changes.',
    }),
    createRegistryResource({
      id: 'workflow:pilot',
      type: 'workflow',
      sourcePath: 'resources/workflows/pilot.md',
      targetPath: '.veaw/resources/workflows/pilot.md',
      tags: ['pilot'],
      content: '# Pilot workflow\nValidate every CLI step.',
    }),
    createRegistryResource({
      id: 'command:pilot',
      type: 'command',
      sourcePath: 'resources/commands/pilot.md',
      targetPath: '.veaw/resources/commands/pilot.md',
      tags: ['pilot'],
      dependencies: ['skill:pilot'],
      content: '# Pilot Workspace Command\nGenerate a pilot command prompt.',
    }),
  ];

  await fs.ensureDir(registriesDirectory);
  await writeFile(path.join(workspaceDirectory, 'workspace.json'), '{"name":"VEAW Pilot"}');

  for (const resource of resources) {
    await fs.outputFile(path.join(workspaceDirectory, resource.sourcePath), getResourceContent(resource));
  }

  await writeJsonFile(path.join(registriesDirectory, 'registry.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    workspace: {
      id: 'veaw-pilot',
      name: 'VEAW Pilot',
      rootMarker: 'workspace.json',
    },
    registries: [
      createRegistryEntry('templates', 'template', 'templates.json'),
      createRegistryEntry('prompts', 'prompt', 'prompts.json'),
      createRegistryEntry('rules', 'rule', 'rules.json'),
      createRegistryEntry('skills', 'skill', 'skills.json'),
      createRegistryEntry('workflows', 'workflow', 'workflows.json'),
      createRegistryEntry('commands', 'command', 'commands.json'),
    ],
  });

  await writeChildRegistry(registriesDirectory, 'templates.json', 'template', resources);
  await writeChildRegistry(registriesDirectory, 'prompts.json', 'prompt', resources);
  await writeChildRegistry(registriesDirectory, 'rules.json', 'rule', resources);
  await writeChildRegistry(registriesDirectory, 'skills.json', 'skill', resources);
  await writeChildRegistry(registriesDirectory, 'workflows.json', 'workflow', resources);
  await writeCommandsRegistry(registriesDirectory, resources);

  return workspaceDirectory;
}

/**
 * 创建 pilot 项目 fixture。
 *
 * @returns 项目目录。
 */
async function createPilotProjectFixture(): Promise<string> {
  const projectDirectory = await createTemporaryDirectory('veaw-pilot-project-');

  await writeJsonFile(path.join(projectDirectory, 'package.json'), {
    name: 'veaw-pilot-project',
    version: '0.1.0',
    type: 'module',
    packageManager: 'pnpm@9.15.4',
    dependencies: {
      vue: '^3.5.0',
      vite: '^6.0.0',
      typescript: '^5.7.0',
    },
  });
  await writeJsonFile(path.join(projectDirectory, 'tsconfig.json'), {
    compilerOptions: {
      strict: true,
    },
  });
  await fs.outputFile(
    path.join(projectDirectory, 'src', 'components', 'PilotButton.vue'),
    [
      '<script setup lang="ts">',
      'interface PilotButtonProps {',
      '  readonly label: string;',
      '}',
      '',
      'defineOptions({',
      "  name: 'PilotButton',",
      '});',
      '',
      'defineProps<PilotButtonProps>();',
      "defineEmits<{ (event: 'confirm'): void }>();",
      '</script>',
      '',
      '<template>',
      '  <button type="button" @click="$emit(\'confirm\')">',
      '    {{ label }}',
      '  </button>',
      '</template>',
      '',
    ].join('\n'),
  );

  return projectDirectory;
}

/**
 * 创建 Registry 入口。
 *
 * @param id Registry id。
 * @param type Registry 类型。
 * @param registryPath Registry 文件路径。
 * @returns Registry 入口。
 */
function createRegistryEntry(id: string, type: string, registryPath: string): JsonObject {
  return {
    id,
    type,
    path: registryPath,
    required: true,
  };
}

/**
 * 创建 Registry 资源。
 *
 * @param input 资源输入。
 * @returns Registry 资源。
 */
function createRegistryResource(input: RegistryResourceInput): RegistryResourceRecord {
  return {
    id: input.id,
    type: input.type,
    version: '1.0.0',
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    tags: input.tags,
    dependencies: input.dependencies ?? [],
    enabledByDefault: true,
    copyPolicy: 'copy',
    overwritePolicy: 'if-missing',
    hash: hashText(input.content),
  };
}

/**
 * 读取资源内容。
 *
 * @param resource Registry 资源。
 * @returns 内容。
 */
function getResourceContent(resource: RegistryResourceRecord): string {
  if (resource.id === 'template:context') {
    return '# Pilot workspace context\nUse this context in acceptance runs.';
  }

  if (resource.id === 'template:session') {
    return '# Pilot session log\n';
  }

  if (resource.id === 'prompt:pilot') {
    return '# Pilot ask prompt\nUse the pilot prompt resource.';
  }

  if (resource.id === 'rule:pilot') {
    return '# Pilot rule\nDo not overwrite user edits silently.';
  }

  if (resource.id === 'skill:pilot') {
    return '# Pilot skill\nUse conservative TypeScript changes.';
  }

  if (resource.id === 'workflow:pilot') {
    return '# Pilot workflow\nValidate every CLI step.';
  }

  return '# Pilot Workspace Command\nGenerate a pilot command prompt.';
}

/**
 * 写入子 Registry。
 *
 * @param registriesDirectory Registry 目录。
 * @param fileName 文件名。
 * @param resourceType 资源类型。
 * @param resources 所有资源。
 */
async function writeChildRegistry(
  registriesDirectory: string,
  fileName: string,
  resourceType: string,
  resources: readonly RegistryResourceRecord[],
): Promise<void> {
  await writeJsonFile(path.join(registriesDirectory, fileName), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    resourceType,
    resources: resources.filter((resource) => resource.type === resourceType),
  });
}

/**
 * 写入 commands Registry。
 *
 * @param registriesDirectory Registry 目录。
 * @param resources 所有资源。
 */
async function writeCommandsRegistry(
  registriesDirectory: string,
  resources: readonly RegistryResourceRecord[],
): Promise<void> {
  await writeJsonFile(path.join(registriesDirectory, 'commands.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    resourceType: 'command',
    resources: resources.filter((resource) => resource.type === 'command'),
    commandSchemaVersion: '1.0.0',
    commands: [
      {
        id: 'command:pilot',
        name: 'pilot',
        description: 'Generate a pilot command prompt.',
        version: '1.0.0',
        parameters: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'Pilot requirement description.',
            },
          },
          required: ['description'],
        },
        dependencies: ['skill:pilot'],
        execution: {
          type: 'generate-prompt',
          resourceId: 'command:pilot',
        },
      },
    ],
  });
}

/**
 * 更新 Workspace 源文件与 Registry hash。
 *
 * @param workspaceDirectory Workspace 目录。
 * @param input 更新输入。
 */
async function updateWorkspaceResource(workspaceDirectory: string, input: WorkspaceResourceUpdateInput): Promise<void> {
  const registryPath = path.join(workspaceDirectory, 'registries', input.registryName);
  const registry = await readJsonObject(registryPath);
  const resources = readRegistryResources(registry).map((resource) =>
    resource.id === input.resourceId
      ? {
          ...resource,
          version: input.nextVersion,
          hash: hashText(input.nextContent),
        }
      : resource,
  );
  const updatedResource = resources.find((resource) => resource.id === input.resourceId);

  assert.ok(updatedResource !== undefined);

  await writeFile(path.join(workspaceDirectory, updatedResource.sourcePath), input.nextContent);
  await writeJsonFile(registryPath, {
    ...registry,
    resources,
  });
}

/**
 * 读取 Registry 资源列表。
 *
 * @param registry Registry JSON。
 * @returns Registry 资源列表。
 */
function readRegistryResources(registry: Readonly<JsonObject>): readonly RegistryResourceRecord[] {
  const resources = registry.resources;

  assert.ok(Array.isArray(resources));

  return resources.map((resource) => {
    assert.ok(isRegistryResourceRecord(resource));

    return resource;
  });
}

/**
 * 判断值是否是 Registry 资源记录。
 *
 * @param value 待判断值。
 * @returns 是否是 Registry 资源记录。
 */
function isRegistryResourceRecord(value: unknown): value is RegistryResourceRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.version === 'string' &&
    typeof value.sourcePath === 'string' &&
    typeof value.targetPath === 'string' &&
    Array.isArray(value.tags) &&
    Array.isArray(value.dependencies) &&
    typeof value.enabledByDefault === 'boolean' &&
    typeof value.copyPolicy === 'string' &&
    typeof value.overwritePolicy === 'string' &&
    typeof value.hash === 'string'
  );
}

/**
 * 读取 catalog 组件名称。
 *
 * @param catalog catalog JSON。
 * @returns 组件名称列表。
 */
function readCatalogComponentNames(catalog: Readonly<JsonObject>): readonly string[] {
  const components = catalog.components;

  if (!Array.isArray(components)) {
    return [];
  }

  return components
    .filter(isRecord)
    .map((component) => component.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * 读取指定资源 lock 状态。
 *
 * @param projectDirectory 项目目录。
 * @param resourceId 资源 id。
 * @returns lock 状态。
 */
async function readLockStatus(projectDirectory: string, resourceId: string): Promise<ResourceLockStatus | undefined> {
  return (await readLockEntries(projectDirectory)).find((entry) => entry.id === resourceId)?.status;
}

/**
 * 读取 lockfile 条目。
 *
 * @param projectDirectory 项目目录。
 * @returns lockfile 条目。
 */
async function readLockEntries(projectDirectory: string): Promise<readonly ResourceLockEntry[]> {
  const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));
  const resources = lockfile.resources;

  assert.ok(Array.isArray(resources));

  return resources as readonly ResourceLockEntry[];
}

/**
 * 创建 pilot 验收报告。
 *
 * @param input 报告输入。
 * @returns JSON 报告。
 */
function createPilotReport(input: PilotReportInput): JsonObject {
  return {
    projectDirectory: input.projectDirectory,
    workspaceDirectory: input.workspaceDirectory,
    commands: input.reports,
    resources: input.lockEntries.map((entry) => ({
      id: entry.id,
      status: entry.status,
      lastAction: entry.lastAction,
      sourceHash: entry.sourceHash,
      targetHash: entry.targetHash,
      targetPath: entry.targetPath,
    })),
    risks: [
      'Workspace command fallback is intentionally unavailable when no Workspace registry can be discovered.',
      'Catalog and context contain timestamps, so idempotency assertions focus on lockfile and managed resources.',
    ],
  };
}

/**
 * 写入 JSON 文件。
 *
 * @param filePath 文件路径。
 * @param data JSON 数据。
 */
async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.outputJson(filePath, data, {
    spaces: 2,
  });
}

/**
 * 读取 JSON 对象。
 *
 * @param filePath 文件路径。
 * @returns JSON 对象。
 */
async function readJsonObject(filePath: string): Promise<JsonObject> {
  const content = JSON.parse(await readFile(filePath, 'utf8')) as unknown;

  assert.ok(isRecord(content));

  return content;
}

/**
 * 判断值是否是对象记录。
 *
 * @param value 待判断值。
 * @returns 是否是对象记录。
 */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 计算文本 SHA-256。
 *
 * @param content 文本内容。
 * @returns hash 字符串。
 */
function hashText(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
