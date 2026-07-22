import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { runContextCommand } from '../src/commands/context.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runContextCommand', (): void => {
  it('generates context from project facts and Workspace template/rule resources', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-context-project-');
    const workspaceDirectory = await createWorkspaceFixture('veaw-context-workspace-');

    await createVeawProject(projectDirectory, workspaceDirectory);
    await runContextInDirectory(projectDirectory);

    const contextContent = await readFile(path.join(projectDirectory, '.veaw', 'context.md'), 'utf8');

    assert.match(contextContent, /# VEAW Project Context/);
    assert.match(contextContent, /## 自动检测事实/);
    assert.match(contextContent, /未从源码或配置确认的信息不会写成事实/);
    assert.match(contextContent, /## UI 库/);
    assert.match(contextContent, /element-plus/);
    assert.match(contextContent, /## Router/);
    assert.match(contextContent, /vue-router/);
    assert.match(contextContent, /src\/router/);
    assert.match(contextContent, /## 状态管理/);
    assert.match(contextContent, /pinia/);
    assert.match(contextContent, /src\/store/);
    assert.match(contextContent, /## API \/ Service 目录/);
    assert.match(contextContent, /src\/api/);
    assert.match(contextContent, /src\/service/);
    assert.match(contextContent, /## Components 目录/);
    assert.match(contextContent, /src\/components/);
    assert.match(contextContent, /## Layout 目录/);
    assert.match(contextContent, /src\/layouts/);
    assert.match(contextContent, /## 人工维护约定模板/);
    assert.match(contextContent, /新页面路由、菜单与权限注册方式：待项目维护者确认/);
    assert.match(contextContent, /template:project-context/);
    assert.match(contextContent, /Workspace Context Template/);
    assert.match(contextContent, /rule:typescript/);
    assert.match(contextContent, /Workspace TypeScript Rule/);
  });

  it('keeps CLI fallback context generation when Workspace is unavailable', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-context-fallback-');

    await createVeawProject(projectDirectory);
    await runContextInDirectory(projectDirectory);

    const contextContent = await readFile(path.join(projectDirectory, '.veaw', 'context.md'), 'utf8');

    assert.match(contextContent, /# VEAW Project Context/);
    assert.match(contextContent, /当前未发现 Workspace Registry 资源/);
  });

  it('preserves manual regions and skips no-op writes', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-context-idempotent-');
    const contextPath = path.join(projectDirectory, '.veaw', 'context.md');

    await createVeawProject(projectDirectory);
    await runContextInDirectory(projectDirectory);

    const generatedContent = await readFile(contextPath, 'utf8');
    const generatedAt = generatedContent.match(/^> Generated at: (.+)$/m)?.[1];

    assert.ok(generatedAt);

    await writeFile(contextPath, `# Manual Head\n\n${generatedContent.trim()}\n\n# Manual Tail\n`);
    await runContextInDirectory(projectDirectory);

    const mergedContent = await readFile(contextPath, 'utf8');

    assert.match(mergedContent, /^# Manual Head/m);
    assert.match(mergedContent, /^# Manual Tail/m);
    assert.equal(mergedContent.match(/^> Generated at: (.+)$/m)?.[1], generatedAt);

    const beforeMtime = (await stat(contextPath)).mtimeMs;

    await runContextInDirectory(projectDirectory);

    assert.equal(await readFile(contextPath, 'utf8'), mergedContent);
    assert.equal((await stat(contextPath)).mtimeMs, beforeMtime);
  });
});

/**
 * 在指定目录执行 context。
 *
 * @param directory 目标目录。
 */
async function runContextInDirectory(directory: string): Promise<void> {
  const originalCwd = process.cwd();

  try {
    process.chdir(directory);
    await runContextCommand();
  } finally {
    process.chdir(originalCwd);
  }
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
 * 创建测试项目 .veaw。
 *
 * @param projectDirectory 项目目录。
 * @param workspaceDirectory Workspace 目录。
 */
async function createVeawProject(projectDirectory: string, workspaceDirectory?: string): Promise<void> {
  const veawDirectory = path.join(projectDirectory, '.veaw');

  await fs.ensureDir(path.join(veawDirectory, 'component-catalog'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'router'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'store'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'api'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'service'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'components'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'layouts'));
  await writeJsonFile(path.join(projectDirectory, 'package.json'), {
    dependencies: {
      'element-plus': '^2.0.0',
      'vue-router': '^4.0.0',
      pinia: '^2.0.0',
    },
  });
  await writeJsonFile(path.join(veawDirectory, 'project.json'), {
    name: 'demo',
    root: projectDirectory,
    frameworks: ['Vue', 'Vite'],
    packageManager: 'pnpm',
    nodeVersion: process.version,
    typescript: {
      enabled: true,
      configPath: 'tsconfig.json',
    },
    vite: {
      detected: true,
      configPath: 'vite.config.ts',
    },
    packageJson: {
      dependencies: {
        'element-plus': '^2.0.0',
        'vue-router': '^4.0.0',
        pinia: '^2.0.0',
      },
    },
    git: {
      branch: 'main',
    },
  });
  await writeJsonFile(path.join(veawDirectory, 'component-catalog', 'catalog.json'), {
    components: [],
  });

  if (workspaceDirectory !== undefined) {
    await writeJsonFile(path.join(veawDirectory, 'config.json'), {
      workspacePath: workspaceDirectory,
    });
  }
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
  await writeFile(path.join(workspaceDirectory, 'context-template.md'), '# Workspace Context Template');
  await writeFile(path.join(workspaceDirectory, 'typescript-rule.md'), '# Workspace TypeScript Rule');
  await writeTopLevelRegistry(registriesDirectory, [
    {
      id: 'templates',
      type: 'template',
      path: 'templates.json',
      required: true,
    },
    {
      id: 'rules',
      type: 'rule',
      path: 'rules.json',
      required: true,
    },
  ]);
  await writeResourceRegistry(registriesDirectory, 'templates.json', 'template', [
    createResource({
      id: 'template:project-context',
      type: 'template',
      sourcePath: 'context-template.md',
      targetPath: '.veaw/resources/templates/project-context.md',
      tags: ['template', 'project', 'context'],
    }),
  ]);
  await writeResourceRegistry(registriesDirectory, 'rules.json', 'rule', [
    createResource({
      id: 'rule:typescript',
      type: 'rule',
      sourcePath: 'typescript-rule.md',
      targetPath: '.veaw/resources/rules/typescript-rule.md',
      tags: ['rule', 'typescript'],
    }),
  ]);

  return workspaceDirectory;
}

/**
 * Registry 入口。
 */
interface RegistryEntry {
  /**
   * Registry id。
   */
  readonly id: string;
  /**
   * Registry 类型。
   */
  readonly type: string;
  /**
   * Registry 文件路径。
   */
  readonly path: string;
  /**
   * 是否必需。
   */
  readonly required: boolean;
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
}

/**
 * 写入顶层 Registry。
 *
 * @param registriesDirectory registries 目录。
 * @param registries 子 Registry 入口。
 */
async function writeTopLevelRegistry(registriesDirectory: string, registries: readonly RegistryEntry[]): Promise<void> {
  await writeJsonFile(path.join(registriesDirectory, 'registry.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    workspace: {
      id: 'veaw',
      name: 'VEAW',
      rootMarker: 'workspace.json',
    },
    registries,
  });
}

/**
 * 写入资源 Registry。
 *
 * @param registriesDirectory registries 目录。
 * @param fileName 文件名。
 * @param resourceType 资源类型。
 * @param resources 资源列表。
 */
async function writeResourceRegistry(
  registriesDirectory: string,
  fileName: string,
  resourceType: string,
  resources: readonly Record<string, unknown>[],
): Promise<void> {
  await writeJsonFile(path.join(registriesDirectory, fileName), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    resourceType,
    resources,
  });
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
    dependencies: [],
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
