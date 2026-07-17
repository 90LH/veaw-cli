import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import {
  executeWorkspaceCommand,
  findWorkspaceCommand,
  parseWorkspaceCommandArguments,
  readWorkspaceCommandRegistry,
} from '../src/resource-loader/index.js';
import {
  runWorkspaceCommand,
  runWorkspaceCommandsListCommand,
} from '../src/commands/workspace-commands.js';
import { discoverWorkspace } from '../src/resource-loader/index.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Workspace command registry', (): void => {
  it('lists and executes declarative generate-prompt Workspace commands', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-workspace-command-project-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-workspace-command-',
    });
    const location = await discoverWorkspace({
      projectDirectory,
      explicitWorkspacePath: workspaceDirectory,
    });
    const registry = await readWorkspaceCommandRegistry(location);
    const command = findWorkspaceCommand(registry, 'demo');

    assert.equal(registry.commands.length, 1);
    assert.equal(command?.id, 'command:demo');

    assert.ok(command !== undefined);

    const parameters = parseWorkspaceCommandArguments(command, ['description=Create demo', 'store=true']);
    const result = await executeWorkspaceCommand(registry, command, parameters);

    assert.match(result.content, /Workspace Command: demo/);
    assert.match(result.content, /description: Create demo/);
    assert.match(result.content, /store: true/);
    assert.match(result.content, /Demo Command Body/);
    assert.match(result.content, /Demo Skill Body/);
  });

  it('exposes Workspace commands through the built-in commands list and run entrypoint', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-workspace-command-project-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-workspace-command-',
    });
    const logs = await captureConsole(async (): Promise<void> => {
      await runInDirectory(projectDirectory, async (): Promise<void> => {
        await runWorkspaceCommandsListCommand({
          workspace: workspaceDirectory,
        });
        await runWorkspaceCommand('demo', ['description=Create demo'], {
          workspace: workspaceDirectory,
        });
      });
    });

    assert.ok(logs.some((log) => log.includes('demo (command:demo)')));
    assert.ok(logs.some((log) => log.includes('Demo Command Body')));
  });

  it('rejects unknown commands and invalid arguments', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-workspace-command-project-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-workspace-command-',
    });
    const location = await discoverWorkspace({
      projectDirectory,
      explicitWorkspacePath: workspaceDirectory,
    });
    const registry = await readWorkspaceCommandRegistry(location);
    const command = findWorkspaceCommand(registry, 'demo');

    assert.equal(findWorkspaceCommand(registry, 'missing'), undefined);
    assert.ok(command !== undefined);
    assert.throws(() => parseWorkspaceCommandArguments(command, []), /Missing required argument/);
    assert.throws(() => parseWorkspaceCommandArguments(command, ['unknown=value']), /Unknown argument/);
    assert.throws(() => parseWorkspaceCommandArguments(command, ['description=demo', 'store=yes']), /Invalid boolean/);
  });

  it('rejects unsupported Workspace command schema versions', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-workspace-command-project-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-workspace-command-',
      commandSchemaVersion: '9.0.0',
    });
    const location = await discoverWorkspace({
      projectDirectory,
      explicitWorkspacePath: workspaceDirectory,
    });

    await assert.rejects(
      () => readWorkspaceCommandRegistry(location),
      /Unsupported Workspace command schema version: 9\.0\.0/,
    );
  });

  it('rejects Workspace commands that reference missing resources', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-workspace-command-project-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-workspace-command-',
      missingDependency: true,
    });
    const location = await discoverWorkspace({
      projectDirectory,
      explicitWorkspacePath: workspaceDirectory,
    });

    await assert.rejects(
      () => readWorkspaceCommandRegistry(location),
      /references missing resource: skill:missing/,
    );
  });
});

/**
 * 在指定目录执行。
 *
 * @param directory 目标目录。
 * @param callback 回调。
 */
async function runInDirectory(directory: string, callback: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;

  try {
    process.exitCode = undefined;
    process.chdir(directory);
    await callback();
  } finally {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
  }
}

/**
 * 捕获 console.log 输出。
 *
 * @param callback 回调。
 * @returns 输出日志。
 */
async function captureConsole(callback: () => Promise<void>): Promise<readonly string[]> {
  const originalConsoleLog = console.log;
  const logs: string[] = [];

  console.log = (...data: unknown[]): void => {
    logs.push(data.map(String).join(' '));
  };

  try {
    await callback();
  } finally {
    console.log = originalConsoleLog;
  }

  return logs;
}

/**
 * 创建临时目录。
 *
 * @param prefix 目录名前缀。
 * @returns 临时目录。
 */
async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));

  temporaryDirectories.push(directory);

  return directory;
}

/**
 * Workspace fixture 输入。
 */
interface WorkspaceFixtureInput {
  /**
   * 目录名前缀。
   */
  readonly prefix: string;
  /**
   * command schema 版本。
   */
  readonly commandSchemaVersion?: string;
  /**
   * 是否制造缺失依赖。
   */
  readonly missingDependency?: boolean;
}

/**
 * 创建 Workspace fixture。
 *
 * @param input fixture 输入。
 * @returns Workspace 目录。
 */
async function createWorkspaceFixture(input: WorkspaceFixtureInput): Promise<string> {
  const workspaceDirectory = await createTemporaryDirectory(input.prefix);
  const registriesDirectory = path.join(workspaceDirectory, 'registries');
  const commandDependencies = input.missingDependency === true ? ['skill:missing'] : ['skill:demo'];

  await fs.ensureDir(registriesDirectory);
  await writeFile(path.join(workspaceDirectory, 'workspace.json'), '{"name":"VEAW"}');
  await writeFile(path.join(workspaceDirectory, 'demo-command.md'), '# Demo Command Body');
  await writeFile(path.join(workspaceDirectory, 'demo-skill.md'), '# Demo Skill Body');
  await writeJsonFile(path.join(registriesDirectory, 'registry.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    workspace: {
      id: 'veaw',
      name: 'VEAW',
      rootMarker: 'workspace.json',
    },
    registries: [
      {
        id: 'commands',
        type: 'command',
        path: 'commands.json',
        required: true,
      },
      {
        id: 'skills',
        type: 'skill',
        path: 'skills.json',
        required: true,
      },
    ],
  });
  await writeJsonFile(path.join(registriesDirectory, 'commands.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    resourceType: 'command',
    resources: [
      createResource({
        id: 'command:demo',
        type: 'command',
        sourcePath: 'demo-command.md',
        targetPath: '.veaw/resources/commands/demo.md',
        tags: ['command', 'demo'],
        dependencies: commandDependencies,
      }),
    ],
    commandSchemaVersion: input.commandSchemaVersion ?? '1.0.0',
    commands: [
      {
        id: 'command:demo',
        name: 'demo',
        description: 'Generate a demo prompt.',
        version: '1.0.0',
        parameters: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'Requirement description.',
            },
            store: {
              type: 'boolean',
              description: 'Whether to create store.',
              default: false,
            },
          },
          required: ['description'],
        },
        dependencies: commandDependencies,
        execution: {
          type: 'generate-prompt',
          resourceId: 'command:demo',
        },
      },
    ],
  });
  await writeJsonFile(path.join(registriesDirectory, 'skills.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    resourceType: 'skill',
    resources: [
      createResource({
        id: 'skill:demo',
        type: 'skill',
        sourcePath: 'demo-skill.md',
        targetPath: '.veaw/resources/skills/demo.md',
        tags: ['skill', 'demo'],
        dependencies: [],
      }),
    ],
  });

  return workspaceDirectory;
}

/**
 * 资源输入。
 */
interface ResourceInput {
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
   * 依赖资源。
   */
  readonly dependencies: readonly string[];
}

/**
 * 创建 Registry 资源。
 *
 * @param input 资源输入。
 * @returns Registry 资源。
 */
function createResource(input: ResourceInput): Record<string, unknown> {
  return {
    id: input.id,
    type: input.type,
    version: '1.0.0',
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    tags: input.tags,
    dependencies: input.dependencies,
    enabledByDefault: true,
    copyPolicy: 'reference',
    overwritePolicy: 'if-missing',
    hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
