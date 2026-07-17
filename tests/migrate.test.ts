import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { runMigrateCommand } from '../src/commands/migrate.js';
import type { ResourceLockEntry } from '../src/resource-loader/index.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runMigrateCommand', (): void => {
  it('previews and applies migration for legacy CLI assets projects', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-migrate-fallback-');

    await createLegacyFallbackProject(projectDirectory);

    await runMigrateInDirectory(projectDirectory);

    assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'config.json')), false);
    assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'resources.lock.json')), false);

    await runMigrateInDirectory(projectDirectory, {
      apply: true,
    });

    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));
    const migrationRecord = await readJsonObject(path.join(projectDirectory, '.veaw', 'migrations', 'legacy-migration.json'));
    const lockEntries = readLockEntries(lockfile);
    const firstSnapshot = await readVeawSnapshot(projectDirectory);

    await runMigrateInDirectory(projectDirectory, {
      apply: true,
    });

    const secondSnapshot = await readVeawSnapshot(projectDirectory);

    assert.equal(config.resourceMode, 'fallback');
    assert.equal(typeof config.assetsPath, 'string');
    assert.equal(lockEntries.length > 0, true);
    assert.equal(lockEntries.every((entry) => entry.type === 'fallback-asset'), true);
    assert.equal(lockEntries.every((entry) => entry.status === 'installed'), true);
    assert.equal(migrationRecord.resourceMode, 'fallback');
    assert.deepEqual(secondSnapshot, firstSnapshot);
  });

  it('marks user-modified Workspace resources as conflicts without overwriting them', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-migrate-conflict-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-migrate-workspace-',
      content: '# Workspace Base',
    });
    const targetPath = path.join(projectDirectory, '.veaw', 'resources', 'prompts', 'base.md');

    await fs.ensureDir(path.dirname(targetPath));
    await writeFile(targetPath, '# User Base');

    await runMigrateInDirectory(projectDirectory, {
      apply: true,
      workspace: workspaceDirectory,
    });

    const targetContent = await readFile(targetPath, 'utf8');
    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));
    const lockEntries = readLockEntries(lockfile);

    assert.equal(targetContent, '# User Base');
    assert.equal(config.resourceMode, 'workspace');
    assert.equal(config.workspacePath, workspaceDirectory);
    assert.equal(lockEntries[0]?.sourceHash, hashText('# Workspace Base'));
    assert.equal(lockEntries[0]?.targetHash, hashText('# User Base'));
    assert.equal(lockEntries[0]?.status, 'conflict');
    assert.equal(lockEntries[0]?.lastAction, 'migrate');
  });

  it('preserves custom project.json fields while migrating missing config and lockfile', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-migrate-custom-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-migrate-workspace-',
      content: '# Workspace Base',
    });

    await fs.ensureDir(path.join(projectDirectory, '.veaw'));
    await writeJsonFile(path.join(projectDirectory, '.veaw', 'project.json'), {
      generatedAt: '2026-01-01T00:00:00.000Z',
      customProjectField: 'keep-me',
      nested: {
        userField: true,
      },
    });

    await runMigrateInDirectory(projectDirectory, {
      apply: true,
      workspace: workspaceDirectory,
    });

    const projectJson = await readJsonObject(path.join(projectDirectory, '.veaw', 'project.json'));
    const config = await readJsonObject(path.join(projectDirectory, '.veaw', 'config.json'));
    const lockfile = await readJsonObject(path.join(projectDirectory, '.veaw', 'resources.lock.json'));
    const lockEntries = readLockEntries(lockfile);

    assert.deepEqual(projectJson, {
      generatedAt: '2026-01-01T00:00:00.000Z',
      customProjectField: 'keep-me',
      nested: {
        userField: true,
      },
    });
    assert.equal(config.workspaceVersion, '1.0.0');
    assert.equal(config.registryVersion, '1.0.0');
    assert.equal(lockEntries[0]?.status, 'missing');
  });
});

/**
 * 在指定目录执行 migrate。
 *
 * @param directory 目标目录。
 * @param options migrate 选项。
 */
async function runMigrateInDirectory(
  directory: string,
  options: { readonly workspace?: string; readonly apply?: boolean } = {},
): Promise<void> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;

  try {
    process.exitCode = undefined;
    process.chdir(directory);
    await runMigrateCommand(options);
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
 * 创建旧 CLI fallback 项目。
 *
 * @param projectDirectory 项目目录。
 */
async function createLegacyFallbackProject(projectDirectory: string): Promise<void> {
  const assetsDirectory = path.join(process.cwd(), 'assets');

  await fs.copy(assetsDirectory, path.join(projectDirectory, '.veaw', 'assets'));
  await writeFile(path.join(projectDirectory, '.veaw', 'context.md'), await readFile(path.join(assetsDirectory, 'context.md'), 'utf8'));
  await writeFile(
    path.join(projectDirectory, '.veaw', 'session-log.md'),
    await readFile(path.join(assetsDirectory, 'session-log.md'), 'utf8'),
  );
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
   * 资源内容。
   */
  readonly content: string;
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

  await fs.ensureDir(registriesDirectory);
  await writeFile(path.join(workspaceDirectory, 'workspace.json'), '{"name":"VEAW"}');
  await writeFile(path.join(workspaceDirectory, 'base.md'), input.content);
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
        id: 'prompts',
        type: 'prompt',
        path: 'prompts.json',
        required: true,
      },
    ],
  });
  await writeJsonFile(path.join(registriesDirectory, 'prompts.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    resourceType: 'prompt',
    resources: [
      {
        id: 'prompt:base',
        type: 'prompt',
        version: '1.0.0',
        sourcePath: 'base.md',
        targetPath: '.veaw/resources/prompts/base.md',
        tags: ['prompt'],
        dependencies: [],
        enabledByDefault: true,
        copyPolicy: 'copy',
        overwritePolicy: 'if-missing',
        hash: hashText(input.content),
      },
    ],
  });

  return workspaceDirectory;
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
 * 读取 .veaw 文件快照。
 *
 * @param projectDirectory 项目目录。
 * @returns 文件快照。
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

/**
 * 计算文本 SHA-256。
 *
 * @param content 文本内容。
 * @returns hash 字符串。
 */
function hashText(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
