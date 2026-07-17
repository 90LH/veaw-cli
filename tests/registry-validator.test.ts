import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { validateVeaw, validateWorkspaceRegistry } from '../src/resource-loader/index.js';
import type { ValidationIssueCode } from '../src/resource-loader/index.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('validateWorkspaceRegistry', (): void => {
  it('accepts a valid Workspace registry', async (): Promise<void> => {
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-validator-valid-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
        }),
      ],
    });

    const issues = await validateWorkspaceRegistry(workspaceDirectory);

    assert.deepEqual(issues, []);
  });

  it('reports missing source files', async (): Promise<void> => {
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-validator-missing-',
      resources: [
        createFixtureResource({
          id: 'prompt:missing',
          fileName: 'missing.md',
          content: '# Missing',
          writeSource: false,
        }),
      ],
    });

    const issues = await validateWorkspaceRegistry(workspaceDirectory);

    assertHasCode(issues, 'VEAW_REGISTRY_SOURCE_MISSING');
  });

  it('reports hash mismatches', async (): Promise<void> => {
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-validator-hash-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
          hash: hashText('# Other'),
        }),
      ],
    });

    const issues = await validateWorkspaceRegistry(workspaceDirectory);

    assertHasCode(issues, 'VEAW_REGISTRY_HASH_MISMATCH');
  });

  it('reports duplicate resource ids', async (): Promise<void> => {
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-validator-duplicate-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
        }),
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base-copy.md',
          content: '# Base Copy',
        }),
      ],
    });

    const issues = await validateWorkspaceRegistry(workspaceDirectory);

    assertHasCode(issues, 'VEAW_REGISTRY_DUPLICATE_ID');
  });

  it('reports cyclic dependencies', async (): Promise<void> => {
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-validator-cycle-',
      resources: [
        createFixtureResource({
          id: 'prompt:a',
          fileName: 'a.md',
          content: '# A',
          dependencies: ['prompt:b'],
        }),
        createFixtureResource({
          id: 'prompt:b',
          fileName: 'b.md',
          content: '# B',
          dependencies: ['prompt:a'],
        }),
      ],
    });

    const issues = await validateWorkspaceRegistry(workspaceDirectory);

    assertHasCode(issues, 'VEAW_REGISTRY_DEP_CYCLE');
  });

  it('reports illegal target paths', async (): Promise<void> => {
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-validator-target-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
          targetPath: '../base.md',
        }),
      ],
    });

    const issues = await validateWorkspaceRegistry(workspaceDirectory);

    assertHasCode(issues, 'VEAW_REGISTRY_TARGET_INVALID');
  });
});

describe('validateVeaw', (): void => {
  it('accepts a project with a legacy lockfile', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-validator-project-');
    const workspaceDirectory = await createWorkspaceFixture({
      prefix: 'veaw-validator-workspace-',
      resources: [
        createFixtureResource({
          id: 'prompt:base',
          fileName: 'base.md',
          content: '# Base',
        }),
      ],
    });
    const targetPath = path.join(projectDirectory, '.veaw', 'resources', 'prompts', 'base.md');

    await fs.ensureDir(path.dirname(targetPath));
    await writeFile(targetPath, '# Base');
    await writeJsonFile(path.join(projectDirectory, '.veaw', 'config.json'), {
      workspacePath: workspaceDirectory,
    });
    await writeJsonFile(path.join(projectDirectory, '.veaw', 'resources.lock.json'), {
      schemaVersion: '1.0.0',
      workspaceVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      resources: [
        {
          id: 'prompt:base',
          type: 'prompt',
          version: '1.0.0',
          sourcePath: 'base.md',
          targetPath: '.veaw/resources/prompts/base.md',
          hash: hashText('# Base'),
        },
      ],
    });

    const result = await validateVeaw({
      projectDirectory,
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
  });
});

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
  /**
   * 依赖 id 列表。
   */
  readonly dependencies?: readonly string[];
  /**
   * 目标路径。
   */
  readonly targetPath?: string;
  /**
   * Registry hash。
   */
  readonly hash?: string;
  /**
   * 是否写入源文件。
   */
  readonly writeSource?: boolean;
}

/**
 * Workspace fixture 输入。
 */
interface WorkspaceFixtureInput {
  /**
   * 临时目录前缀。
   */
  readonly prefix: string;
  /**
   * 资源列表。
   */
  readonly resources: readonly FixtureResource[];
}

/**
 * 创建临时目录。
 *
 * @param prefix 目录前缀。
 * @returns 临时目录。
 */
async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));

  temporaryDirectories.push(directory);

  return directory;
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

  for (const resource of input.resources) {
    if (resource.writeSource !== false) {
      await writeFile(path.join(workspaceDirectory, resource.fileName), resource.content);
    }
  }

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
    targetPath: resource.targetPath ?? `.veaw/resources/prompts/${resource.fileName}`,
    tags: ['prompt'],
    dependencies: resource.dependencies ?? [],
    enabledByDefault: true,
    copyPolicy: 'copy',
    overwritePolicy: 'if-missing',
    hash: resource.hash ?? hashText(resource.content),
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
 * 断言存在指定错误码。
 *
 * @param issues 校验问题。
 * @param code 错误码。
 */
function assertHasCode(issues: readonly { readonly code: ValidationIssueCode }[], code: ValidationIssueCode): void {
  assert.equal(
    issues.some((issue) => issue.code === code),
    true,
    `Expected issue code ${code}`,
  );
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
