import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { runInitCommand } from '../src/commands/init.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runInitCommand', (): void => {
  it('initializes a new project from Workspace registry resources', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-init-project-');
    const workspaceDirectory = await createWorkspaceFixture('veaw-init-workspace-');

    await runInitInDirectory(projectDirectory, {
      workspace: workspaceDirectory,
    });

    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const projectJson = await readJsonObject(path.join(projectDirectory, '.veaw', 'project.json'));
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));
    const contextContent = await readFile(path.join(projectDirectory, '.veaw', 'context.md'), 'utf8');
    const commandContent = await readFile(
      path.join(projectDirectory, '.veaw', 'resources', 'commands', 'demo.md'),
      'utf8',
    );

    assert.equal(config.resourceMode, 'workspace');
    assert.equal(config.workspacePath, workspaceDirectory);
    assert.equal(projectJson.name, path.basename(projectDirectory));
    assert.match(contextContent, /Workspace Context/);
    assert.match(commandContent, /Demo Command/);
    assert.equal(Array.isArray(lockfile.resources), true);
    assert.equal((lockfile.resources as readonly unknown[]).length, 3);
  });

  it('uses CLI assets fallback when Workspace is not discoverable', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-init-fallback-');

    await runInitInDirectory(projectDirectory);

    const assetEntries = await readdir(path.join(projectDirectory, '.veaw', 'assets'));
    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));

    assert.equal(config.resourceMode, 'fallback');
    assert.ok(assetEntries.includes('context.md'));
    assert.ok(assetEntries.includes('session-log.md'));
    assert.equal((lockfile.resources as readonly unknown[]).length, 0);
  });

  it('preserves existing project.json and config.json custom fields on legacy .veaw projects', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-init-legacy-');
    const workspaceDirectory = await createWorkspaceFixture('veaw-init-workspace-');

    await fs.ensureDir(path.join(projectDirectory, '.veaw'));
    await writeJsonFile(path.join(projectDirectory, '.veaw', 'project.json'), {
      generatedAt: '2026-01-01T00:00:00.000Z',
      customProjectField: 'keep-me',
      nested: {
        userField: true,
      },
    });
    await writeJsonFile(path.join(projectDirectory, '.veaw', 'config.json'), {
      customConfigField: 'keep-me-too',
    });

    await runInitInDirectory(projectDirectory, {
      workspace: workspaceDirectory,
    });

    const projectJson = await readJsonObject(path.join(projectDirectory, '.veaw', 'project.json'));
    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));

    assert.equal(projectJson.generatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(projectJson.customProjectField, 'keep-me');
    assert.deepEqual(projectJson.nested, {
      userField: true,
    });
    assert.equal(config.customConfigField, 'keep-me-too');
    assert.equal(config.resourceMode, 'workspace');
  });

  it('is idempotent when run repeatedly with the same Workspace', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-init-idempotent-');
    const workspaceDirectory = await createWorkspaceFixture('veaw-init-workspace-');

    await runInitInDirectory(projectDirectory, {
      workspace: workspaceDirectory,
    });

    const firstSnapshot = await readVeawSnapshot(projectDirectory);

    await runInitInDirectory(projectDirectory, {
      workspace: workspaceDirectory,
    });

    const secondSnapshot = await readVeawSnapshot(projectDirectory);

    assert.deepEqual(secondSnapshot, firstSnapshot);
  });
});

/**
 * 在指定目录执行 init。
 *
 * @param directory 目标目录。
 * @param options init 选项。
 */
async function runInitInDirectory(directory: string, options: { readonly workspace?: string } = {}): Promise<void> {
  const originalCwd = process.cwd();

  try {
    process.chdir(directory);
    await runInitCommand(options);
  } finally {
    process.chdir(originalCwd);
  }
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
 * 创建最小 Workspace fixture。
 *
 * @param prefix 目录名前缀。
 * @returns Workspace 目录。
 */
async function createWorkspaceFixture(prefix: string): Promise<string> {
  const workspaceDirectory = await createTemporaryDirectory(prefix);
  const registriesDirectory = path.join(workspaceDirectory, 'registries');

  await fs.ensureDir(registriesDirectory);
  await writeFile(path.join(workspaceDirectory, 'workspace.json'), '{"name":"VEAW"}');
  await writeFile(path.join(workspaceDirectory, 'context-template.md'), '# Workspace Context');
  await writeFile(path.join(workspaceDirectory, 'session-template.md'), '# Workspace Session');
  await writeFile(path.join(workspaceDirectory, 'demo-command.md'), '# Demo Command');
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
        id: 'templates',
        type: 'template',
        path: 'templates.json',
        required: true,
      },
      {
        id: 'commands',
        type: 'command',
        path: 'commands.json',
        required: true,
      },
    ],
  });
  await writeJsonFile(path.join(registriesDirectory, 'templates.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    resourceType: 'template',
    resources: [
      createResource({
        id: 'template:context',
        type: 'template',
        sourcePath: 'context-template.md',
        targetPath: '.veaw/resources/templates/context.md',
        tags: ['template', 'context'],
        dependencies: [],
      }),
      createResource({
        id: 'template:session',
        type: 'template',
        sourcePath: 'session-template.md',
        targetPath: '.veaw/resources/templates/session.md',
        tags: ['template', 'session'],
        dependencies: [],
      }),
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
        tags: ['command'],
        dependencies: ['template:context'],
      }),
    ],
  });

  return workspaceDirectory;
}

/**
 * 创建资源测试对象。
 *
 * @param input 资源输入。
 * @returns 资源对象。
 */
function createResource(input: {
  readonly id: string;
  readonly type: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly tags: readonly string[];
  readonly dependencies: readonly string[];
}): Record<string, unknown> {
  return {
    id: input.id,
    type: input.type,
    version: '1.0.0',
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    tags: input.tags,
    dependencies: input.dependencies,
    enabledByDefault: true,
    copyPolicy: 'copy',
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

/**
 * 读取 JSON 对象。
 *
 * @param filePath 文件路径。
 * @returns JSON 对象。
 */
async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
}

/**
 * 读取 .veaw 文件快照。
 *
 * @param projectDirectory 项目目录。
 * @returns 文件内容快照。
 */
async function readVeawSnapshot(projectDirectory: string): Promise<Readonly<Record<string, string>>> {
  const veawDirectory = path.join(projectDirectory, '.veaw');
  const filePaths = await collectFiles(veawDirectory);
  const snapshot: Record<string, string> = {};

  for (const filePath of filePaths) {
    snapshot[path.relative(veawDirectory, filePath).replaceAll(path.sep, '/')] = await readFile(filePath, 'utf8');
  }

  return snapshot;
}

/**
 * 递归收集文件。
 *
 * @param directoryPath 目录路径。
 * @returns 文件路径列表。
 */
async function collectFiles(directoryPath: string): Promise<readonly string[]> {
  const entries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      filePaths.push(...(await collectFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(entryPath);
    }
  }

  return filePaths.sort((left, right) => left.localeCompare(right));
}
