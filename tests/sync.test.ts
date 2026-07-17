import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { runSyncCommand } from '../src/commands/sync.js';
import type { ResourceLockEntry } from '../src/resource-loader/index.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runSyncCommand', (): void => {
  it('syncs incremental Workspace resources and drops lock entries missing from Registry', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-sync-incremental-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-sync-workspace-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
        }),
        createFixtureResource({
          id: 'prompt:new',
          fileName: 'new.md',
          content: '# New',
        }),
      ],
    });

    await fs.ensureDir(path.join(projectDirectory, '.veaw', 'resources', 'prompts'));
    await writeProjectConfig(projectDirectory, workspaceDirectory);
    await writeFile(path.join(projectDirectory, '.veaw', 'resources', 'prompts', 'base.md'), '# Base');
    await writeResourceLockfile(projectDirectory, '1.0.0', [
      createLockEntry({
        id: 'prompt:base',
        fileName: 'base.md',
        content: '# Base',
      }),
      createLockEntry({
        id: 'prompt:removed',
        fileName: 'removed.md',
        content: '# Removed',
      }),
    ]);

    await runSyncInDirectory(projectDirectory);

    const newContent = await readFile(path.join(projectDirectory, '.veaw', 'resources', 'prompts', 'new.md'), 'utf8');
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));
    const lockEntries = readLockEntries(lockfile);

    assert.equal(newContent, '# New');
    assert.deepEqual(
      lockEntries.map((entry) => entry.id),
      ['prompt:base', 'prompt:new'],
    );
  });

  it('does not overwrite user-maintained content when a changed resource conflicts', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-sync-conflict-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-sync-workspace-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Workspace Update',
        }),
      ],
    });
    const targetPath = path.join(projectDirectory, '.veaw', 'resources', 'prompts', 'base.md');

    await fs.ensureDir(path.dirname(targetPath));
    await writeProjectConfig(projectDirectory, workspaceDirectory);
    await writeFile(targetPath, '# User Edit');
    await writeResourceLockfile(projectDirectory, '1.0.0', [
      createLockEntry({
        id: 'prompt:base',
        fileName: 'base.md',
        content: '# Old Workspace',
      }),
    ]);

    await runSyncInDirectory(projectDirectory);

    const targetContent = await readFile(targetPath, 'utf8');
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));
    const lockEntries = readLockEntries(lockfile);

    assert.equal(targetContent, '# User Edit');
    assert.equal(lockEntries[0]?.hash, hashText('# Old Workspace'));
  });

  it('updates Workspace and Registry snapshots when Workspace version changes', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-sync-version-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-sync-workspace-',
      workspaceVersion: '2.0.0',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
        }),
      ],
    });

    await fs.ensureDir(path.join(projectDirectory, '.veaw'));
    await writeProjectConfig(projectDirectory, workspaceDirectory);
    await writeResourceLockfile(projectDirectory, '1.0.0', []);

    await runSyncInDirectory(projectDirectory);

    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));

    assert.equal(config.workspaceVersion, '2.0.0');
    assert.equal(config.registryVersion, '1.0.0');
    assert.equal(lockfile.workspaceVersion, '2.0.0');
  });

  it('migrates legacy .veaw projects without dropping custom project fields', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-sync-legacy-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-sync-workspace-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
        }),
      ],
    });

    await fs.ensureDir(path.join(projectDirectory, '.veaw'));
    await writeJsonFile(path.join(projectDirectory, '.veaw', 'project.json'), {
      customProjectField: 'keep-me',
      nested: {
        userField: true,
      },
    });

    await runSyncInDirectory(projectDirectory, {
      workspace: workspaceDirectory,
    });

    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const projectJson = await readJsonObject(path.join(projectDirectory, '.veaw', 'project.json'));
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));

    assert.equal(config.resourceMode, 'workspace');
    assert.equal(config.workspacePath, workspaceDirectory);
    assert.equal(projectJson.customProjectField, 'keep-me');
    assert.deepEqual(projectJson.nested, {
      userField: true,
    });
    assert.equal(readLockEntries(lockfile).length, 1);
  });

  it('keeps existing project resources untouched when configured Workspace is missing', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-sync-missing-workspace-');
    const missingWorkspaceDirectory = path.join(projectDirectory, 'missing-workspace');
    const targetPath = path.join(projectDirectory, '.veaw', 'resources', 'prompts', 'base.md');

    await fs.ensureDir(path.dirname(targetPath));
    await writeProjectConfig(projectDirectory, missingWorkspaceDirectory);
    await writeFile(targetPath, '# Existing Project Resource');
    await writeResourceLockfile(projectDirectory, '1.0.0', [
      createLockEntry({
        id: 'prompt:base',
        fileName: 'base.md',
        content: '# Existing Project Resource',
      }),
    ]);

    const firstLockfile = await readFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), 'utf8');

    await runSyncInDirectory(projectDirectory);

    const nextConfig = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const nextLockfile = await readFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), 'utf8');
    const targetContent = await readFile(targetPath, 'utf8');

    assert.equal(nextConfig.workspacePath, missingWorkspaceDirectory);
    assert.equal(nextLockfile, firstLockfile);
    assert.equal(targetContent, '# Existing Project Resource');
  });
});

/**
 * 在指定目录执行 sync。
 *
 * @param directory 目标目录。
 * @param options sync 选项。
 */
async function runSyncInDirectory(directory: string, options: { readonly workspace?: string } = {}): Promise<void> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;

  try {
    process.exitCode = undefined;
    process.chdir(directory);
    await runSyncCommand(options);
  } finally {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
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
 * Workspace fixture 输入。
 */
interface WorkspaceFixtureInput {
  /**
   * 目录名前缀。
   */
  readonly prefix: string;
  /**
   * Workspace 版本。
   */
  readonly workspaceVersion?: string;
  /**
   * 资源列表。
   */
  readonly resources: readonly FixtureResource[];
}

/**
 * Fixture 资源。
 */
interface FixtureResource {
  /**
   * 资源 id。
   */
  readonly id: string;
  /**
   * 源文件名。
   */
  readonly fileName: string;
  /**
   * 源文件内容。
   */
  readonly content: string;
}

/**
 * 创建最小 Workspace fixture。
 *
 * @param input fixture 输入。
 * @returns Workspace 目录。
 */
async function createWorkspaceFixture(input: WorkspaceFixtureInput): Promise<string> {
  const workspaceDirectory = await createTemporaryDirectory(input.prefix);
  const registriesDirectory = path.join(workspaceDirectory, 'registries');
  const workspaceVersion = input.workspaceVersion ?? '1.0.0';

  await fs.ensureDir(registriesDirectory);
  await writeFile(path.join(workspaceDirectory, 'workspace.json'), '{"name":"VEAW"}');

  for (const resource of input.resources) {
    await writeFile(path.join(workspaceDirectory, resource.fileName), resource.content);
  }

  await writeJsonFile(path.join(registriesDirectory, 'registry.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion,
    workspace: {
      id: 'veaw',
      name: 'VEAW',
      rootMarker: 'workspace.json',
    },
    registries: [
      {
        id: 'prompts',
        type: 'prompt',
        path: 'prompts.json',
        required: true,
      },
    ],
  });
  await writeJsonFile(path.join(registriesDirectory, 'prompts.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion,
    resourceType: 'prompt',
    resources: input.resources.map(createRegistryResource),
  });

  return workspaceDirectory;
}

/**
 * 创建 fixture 资源。
 *
 * @param input fixture 资源。
 * @returns fixture 资源。
 */
function createFixtureResource(input: FixtureResource): FixtureResource {
  return input;
}

/**
 * 创建 Registry 资源对象。
 *
 * @param resource fixture 资源。
 * @returns Registry 资源对象。
 */
function createRegistryResource(resource: FixtureResource): Record<string, unknown> {
  return {
    id: resource.id,
    type: 'prompt',
    version: '1.0.0',
    sourcePath: resource.fileName,
    targetPath: `.veaw/resources/prompts/${resource.fileName}`,
    tags: ['prompt'],
    dependencies: [],
    enabledByDefault: true,
    copyPolicy: 'copy',
    overwritePolicy: 'if-missing',
    hash: hashText(resource.content),
  };
}

/**
 * 创建 lockfile 条目。
 *
 * @param input lock 条目输入。
 * @returns lockfile 条目。
 */
function createLockEntry(input: FixtureResource): ResourceLockEntry {
  return {
    id: input.id,
    type: 'prompt',
    version: '1.0.0',
    sourcePath: input.fileName,
    targetPath: `.veaw/resources/prompts/${input.fileName}`,
    hash: hashText(input.content),
  };
}

/**
 * 写入项目 Workspace 配置。
 *
 * @param projectDirectory 项目目录。
 * @param workspaceDirectory Workspace 目录。
 */
async function writeProjectConfig(projectDirectory: string, workspaceDirectory: string): Promise<void> {
  await writeJsonFile(path.join(projectDirectory, '.veaw', 'config.json'), {
    resourceMode: 'workspace',
    workspacePath: workspaceDirectory,
  });
}

/**
 * 写入资源 lockfile。
 *
 * @param projectDirectory 项目目录。
 * @param workspaceVersion Workspace 版本。
 * @param resources lockfile 条目。
 */
async function writeResourceLockfile(
  projectDirectory: string,
  workspaceVersion: string,
  resources: readonly ResourceLockEntry[],
): Promise<void> {
  await writeJsonFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion,
    generatedAt: '2026-01-01T00:00:00.000Z',
    resources,
  });
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
 * 读取 lockfile 条目。
 *
 * @param record JSON 对象。
 * @returns lockfile 条目。
 */
function readLockEntries(record: Readonly<Record<string, unknown>>): readonly ResourceLockEntry[] {
  return Array.isArray(record.resources) ? (record.resources as readonly ResourceLockEntry[]) : [];
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
