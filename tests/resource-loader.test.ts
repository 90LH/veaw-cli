import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import {
  ResourceResolver,
  createResourceLockfile,
  discoverWorkspace,
  readResourceLockfile,
  readWorkspaceRegistry,
  writeResourceLockfile,
} from '../src/resource-loader/index.js';
import type { WorkspaceResource } from '../src/resource-loader/index.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('discoverWorkspace', (): void => {
  it('uses explicit workspace path when it points to a Workspace registry', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-project-');
    const workspaceDirectory = await createWorkspaceFixture('veaw-workspace-');
    const location = await discoverWorkspace({
      projectDirectory,
      explicitWorkspacePath: workspaceDirectory,
      fallbackAssetsDirectory: path.join(projectDirectory, 'assets'),
    });

    assert.equal(location.kind, 'workspace');
    assert.equal(location.source, 'explicit');
    assert.equal(location.rootDirectory, workspaceDirectory);
  });

  it('falls back to CLI assets when no Workspace can be discovered', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-project-');
    const fallbackAssetsDirectory = path.join(projectDirectory, 'cli-assets');

    await fs.ensureDir(fallbackAssetsDirectory);

    const location = await discoverWorkspace({
      projectDirectory,
      environment: {},
      fallbackAssetsDirectory,
    });

    assert.equal(location.kind, 'fallback');
    assert.equal(location.source, 'fallback');
    assert.equal(location.assetsDirectory, fallbackAssetsDirectory);
  });
});

describe('readWorkspaceRegistry', (): void => {
  it('rejects unsupported registry schema versions', async (): Promise<void> => {
    const workspaceDirectory = await createWorkspaceFixture('veaw-workspace-');

    await writeJsonFile(path.join(workspaceDirectory, 'registries', 'registry.json'), {
      schemaVersion: '9.0.0',
      workspaceVersion: '1.0.0',
      workspace: {
        id: 'veaw',
        name: 'VEAW',
        rootMarker: 'workspace.json',
      },
      registries: [],
    });

    const location = await discoverWorkspace({
      projectDirectory: workspaceDirectory,
      explicitWorkspacePath: workspaceDirectory,
    });

    await assert.rejects(
      () => readWorkspaceRegistry(location),
      /Unsupported registry schema version: 9\.0\.0/,
    );
  });
});

describe('ResourceResolver', (): void => {
  it('resolves dependencies before the requested resource', (): void => {
    const baseResource = createResource({
      id: 'template:base',
      type: 'template',
      tags: ['template'],
      dependencies: [],
    });
    const pageResource = createResource({
      id: 'skill:page',
      type: 'skill',
      tags: ['skill', 'page'],
      dependencies: ['template:base'],
    });
    const resolver = new ResourceResolver([pageResource, baseResource]);
    const resolved = resolver.resolveDependencies(['skill:page']);

    assert.deepEqual(
      resolved.map((resource) => resource.id),
      ['template:base', 'skill:page'],
    );
    assert.equal(resolver.find({ type: 'skill' }).length, 1);
    assert.equal(resolver.find({ tag: 'page' })[0]?.id, 'skill:page');
  });
});

describe('resource lockfile', (): void => {
  it('creates, writes, and reads .veaw/resources.lock.json', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-project-');
    const resources = [
      createResource({
        id: 'prompt:list-page',
        type: 'prompt',
        tags: ['prompt'],
        dependencies: [],
      }),
    ];
    const lockfile = createResourceLockfile('1.0.0', resources);

    await writeResourceLockfile(projectDirectory, lockfile);

    const nextLockfile = await readResourceLockfile(projectDirectory);

    assert.equal(nextLockfile?.schemaVersion, '1.0.0');
    assert.equal(nextLockfile?.workspaceVersion, '1.0.0');
    assert.equal(nextLockfile?.resources.length, 1);
    assert.equal(nextLockfile?.resources[0]?.id, 'prompt:list-page');
    assert.equal(nextLockfile?.resources[0]?.sourceHash, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(nextLockfile?.resources[0]?.targetHash, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(nextLockfile?.resources[0]?.status, 'installed');
    assert.equal(nextLockfile?.resources[0]?.lastAction, 'init');
  });

  it('reads legacy lockfile entries with hash only', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-project-');

    await writeJsonFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), {
      schemaVersion: '1.0.0',
      workspaceVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [
        {
          id: 'prompt:list-page',
          type: 'prompt',
          version: '1.0.0',
          sourcePath: 'prompt:list-page.md',
          targetPath: '.veaw/resources/prompt:list-page.md',
          hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    });

    const lockfile = await readResourceLockfile(projectDirectory);

    assert.equal(lockfile?.resources[0]?.sourceHash, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(lockfile?.resources[0]?.targetHash, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(lockfile?.resources[0]?.lastAction, 'migrate');
  });
});

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
  await writeFile(path.join(workspaceDirectory, 'source.md'), '# Source');
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
      createResource({
        id: 'prompt:source',
        type: 'prompt',
        tags: ['prompt'],
        dependencies: [],
        sourcePath: 'source.md',
      }),
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
 * 创建资源测试对象。
 *
 * @param input 资源输入。
 * @returns Workspace 资源。
 */
function createResource(input: {
  readonly id: string;
  readonly type: string;
  readonly tags: readonly string[];
  readonly dependencies: readonly string[];
  readonly sourcePath?: string;
}): WorkspaceResource {
  return {
    id: input.id,
    type: input.type,
    version: '1.0.0',
    sourcePath: input.sourcePath ?? `${input.id}.md`,
    targetPath: `.veaw/resources/${input.id}.md`,
    tags: input.tags,
    dependencies: input.dependencies,
    enabledByDefault: true,
    copyPolicy: 'copy',
    overwritePolicy: 'if-missing',
    hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
}
