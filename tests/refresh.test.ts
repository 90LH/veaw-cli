import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { execa } from 'execa';
import fs from 'fs-extra';
import { runRefreshCommand, runStatusCommand } from '../src/commands/refresh.js';

/**
 * JSON 对象。
 */
type JsonObject = Record<string, unknown>;

/**
 * refresh/status 摘要。
 */
interface RefreshSummary {
  /**
   * 命令名。
   */
  readonly command: string;
  /**
   * 变更来源。
   */
  readonly source: string;
  /**
   * 变更来源明细。
   */
  readonly sources: readonly string[];
  /**
   * 参与路由的变更文件。
   */
  readonly changedFiles: readonly string[];
  /**
   * 写入文件。
   */
  readonly writes: readonly string[];
  /**
   * 跳过原因。
   */
  readonly skippedReason: string | null;
  /**
   * 目标摘要。
   */
  readonly targets: {
    readonly catalog: readonly string[];
    readonly context: readonly string[];
  };
  /**
   * 排除文件摘要。
   */
  readonly excludedFiles: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runRefreshCommand', (): void => {
  it('auto-detects Git changes and writes catalog output', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-refresh-auto-catalog-');

    await createRefreshProject(projectDirectory);
    await initializeGitRepository(projectDirectory);
    await writeFile(
      path.join(projectDirectory, 'src', 'components', 'DemoButton.vue'),
      [
        '<script setup lang="ts">',
        "defineOptions({ name: 'DemoButtonNext' });",
        'defineProps<{ readonly label: string }>();',
        '</script>',
        '<template><button>{{ label }}</button></template>',
        '',
      ].join('\n'),
    );

    const output = await runRefreshInDirectory(projectDirectory);
    const summary = parseSummary(output);
    const catalog = await readJsonObject(path.join(projectDirectory, '.veaw', 'component-catalog', 'catalog.json'));
    const demoButton = findComponent(readArray(catalog, 'components'), 'src/components/DemoButton.vue');

    assert.equal(readString(demoButton, 'name'), 'DemoButtonNext');
    assert.equal(summary.source, 'git-auto');
    assert.deepEqual(summary.sources, ['working-tree', 'staged', 'untracked', 'git-today']);
    assert.deepEqual(summary.writes, ['.veaw/component-catalog/catalog.json']);
    assert.deepEqual(summary.changedFiles, ['src/components/DemoButton.vue']);
    assert.deepEqual(summary.targets.catalog, ['src/components/DemoButton.vue']);
    assert.deepEqual(summary.targets.context, []);
    assertSkippedReason(summary, null);
  });

  it('auto-detects today Git commits and writes context output', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-refresh-auto-context-');

    await createRefreshProject(projectDirectory);
    await initializeGitRepository(projectDirectory);
    await writeFile(path.join(projectDirectory, 'src', 'router', 'index.ts'), 'export const routes = [{ path: "/" }];\n');
    await runGit(projectDirectory, ['add', 'src/router/index.ts']);
    await runGit(projectDirectory, ['commit', '-m', 'update router']);

    const output = await runRefreshInDirectory(projectDirectory);
    const summary = parseSummary(output);
    const contextContent = await readFile(path.join(projectDirectory, '.veaw', 'context.md'), 'utf8');

    assert.equal(summary.source, 'git-auto');
    assert.deepEqual(summary.sources, ['working-tree', 'staged', 'untracked', 'git-today']);
    assert.deepEqual(summary.writes, ['.veaw/context.md']);
    assert.deepEqual(summary.targets.catalog, []);
    assert.deepEqual(summary.targets.context, ['src/router/index.ts']);
    assert.match(contextContent, /# Manual Context/);
    assert.match(contextContent, /# Manual Tail/);
    assert.match(contextContent, /# VEAW Project Context/);
    assertSkippedReason(summary, null);
  });

  it('prints a dry-run JSON summary without writing files', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-refresh-dry-run-');

    await createRefreshProject(projectDirectory);

    const beforeSnapshot = await readVeawSnapshot(projectDirectory);
    const output = await runRefreshInDirectory(projectDirectory, {
      changed: ['src/components/DemoButton.vue', 'src/router/index.ts'],
      dryRun: true,
    });
    const afterSnapshot = await readVeawSnapshot(projectDirectory);
    const summary = parseSummary(output);

    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(summary.command, 'refresh');
    assert.equal(summary.source, 'changed-option');
    assert.deepEqual(summary.sources, ['changed-option']);
    assert.deepEqual(summary.writes, []);
    assert.deepEqual(summary.targets.catalog, ['src/components/DemoButton.vue']);
    assert.deepEqual(summary.targets.context, ['src/router/index.ts']);
    assertSkippedReason(summary, null);
  });

  it('writes only generated catalog/context output by default', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-refresh-write-');
    const projectJsonPath = path.join(projectDirectory, '.veaw', 'project.json');
    const lockfilePath = path.join(projectDirectory, '.veaw', 'resources.lock.json');
    const configPath = path.join(projectDirectory, '.veaw', 'config.json');
    const sessionPath = path.join(projectDirectory, '.veaw', 'session-log.md');

    await createRefreshProject(projectDirectory);

    const beforeProjectJson = await readFile(projectJsonPath, 'utf8');
    const beforeLockfile = await readFile(lockfilePath, 'utf8');
    const beforeConfig = await readFile(configPath, 'utf8');
    const beforeSession = await readFile(sessionPath, 'utf8');
    const output = await runRefreshInDirectory(projectDirectory, {
      changed: ['src/components/DemoButton.vue', 'src/layouts/AppShell.vue', 'src/router/index.ts'],
    });
    const summary = parseSummary(output);
    const catalog = await readJsonObject(path.join(projectDirectory, '.veaw', 'component-catalog', 'catalog.json'));
    const components = readArray(catalog, 'components');
    const demoButton = findComponent(components, 'src/components/DemoButton.vue');
    const appShell = findComponent(components, 'src/layouts/AppShell.vue');
    const contextContent = await readFile(path.join(projectDirectory, '.veaw', 'context.md'), 'utf8');

    assert.deepEqual(summary.writes, ['.veaw/component-catalog/catalog.json', '.veaw/context.md']);
    assertSkippedReason(summary, null);
    assert.equal(readString(demoButton, 'name'), 'DemoButton');
    assert.equal(readString(demoButton, 'customNote'), 'keep-component-note');
    assert.equal(readString(appShell, 'name'), 'AppShell');
    assert.match(contextContent, /# Manual Context/);
    assert.match(contextContent, /# Manual Tail/);
    assert.match(contextContent, /# VEAW Project Context/);
    assert.equal(await readFile(projectJsonPath, 'utf8'), beforeProjectJson);
    assert.equal(await readFile(lockfilePath, 'utf8'), beforeLockfile);
    assert.equal(await readFile(configPath, 'utf8'), beforeConfig);
    assert.equal(await readFile(sessionPath, 'utf8'), beforeSession);
  });

  it('excludes sensitive and generated paths before routing', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-refresh-exclude-');

    await createRefreshProject(projectDirectory);

    const beforeSnapshot = await readVeawSnapshot(projectDirectory);
    const output = await runRefreshInDirectory(projectDirectory, {
      changed: [
        '.env.local',
        'src/api/client.key',
        '.git/config',
        'node_modules/vue/index.js',
        'dist/assets/app.js',
        '.veaw/context.md',
        'README.md',
      ],
    });
    const summary = parseSummary(output);
    const afterSnapshot = await readVeawSnapshot(projectDirectory);

    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.deepEqual(summary.targets, {
      catalog: [],
      context: [],
    });
    assert.deepEqual(
      summary.excludedFiles.map((file) => file.reason).sort((left, right) => left.localeCompare(right)),
      [
        'build-output',
        'dependency-directory',
        'environment-file',
        'generated-directory',
        'git-directory',
        'secret-or-certificate',
      ],
    );
    assertSkippedReason(summary, 'no-routed-targets');
  });

  it('reports today Git diff in status without writing files', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-status-git-');

    await createRefreshProject(projectDirectory);
    await initializeGitRepository(projectDirectory);
    await writeFile(path.join(projectDirectory, 'src', 'api', 'today.ts'), 'export const today = true;\n');

    const beforeSnapshot = await readVeawSnapshot(projectDirectory);
    const output = await runStatusInDirectory(projectDirectory);
    const afterSnapshot = await readVeawSnapshot(projectDirectory);
    const summary = parseSummary(output);

    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(summary.command, 'status');
    assert.equal(summary.source, 'git-auto');
    assert.deepEqual(summary.sources, ['working-tree', 'staged', 'untracked', 'git-today']);
    assert.deepEqual(summary.writes, []);
    assert.deepEqual(summary.targets.context, ['src/api/today.ts']);
    assertSkippedReason(summary, null);
  });

  it('includes current working-tree view changes in status', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-status-working-tree-');
    const viewPath = path.join(projectDirectory, 'src', 'views', 'permissionManagement', 'index.vue');

    await createRefreshProject(projectDirectory);
    await fs.ensureDir(path.dirname(viewPath));
    await writeFile(
      viewPath,
      [
        '<script setup lang="ts">',
        "defineOptions({ name: 'PermissionManagement' });",
        '</script>',
        '<template><section /></template>',
        '',
      ].join('\n'),
    );
    await initializeGitRepository(projectDirectory);
    await writeFile(
      viewPath,
      [
        '<script setup lang="ts">',
        "defineOptions({ name: 'PermissionManagement' });",
        '</script>',
        '<template><section data-updated="true" /></template>',
        '',
      ].join('\n'),
    );

    const statusOutput = await runGitWithOutput(projectDirectory, ['status', '--short']);
    const beforeSnapshot = await readVeawSnapshot(projectDirectory);
    const output = await runStatusInDirectory(projectDirectory);
    const afterSnapshot = await readVeawSnapshot(projectDirectory);
    const summary = parseSummary(output);

    assert.match(statusOutput, / M src\/views\/permissionManagement\/index\.vue/);
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.equal(summary.source, 'git-auto');
    assert.deepEqual(summary.sources, ['working-tree', 'staged', 'untracked', 'git-today']);
    assert.ok(summary.changedFiles.includes('src/views/permissionManagement/index.vue'));
    assert.ok(summary.targets.catalog.includes('src/views/permissionManagement/index.vue'));
    assert.deepEqual(summary.writes, []);
    assertSkippedReason(summary, null);
  });

  it('does not scan or create .veaw when no changes exist', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-refresh-empty-');
    const output = await runRefreshInDirectory(projectDirectory);
    const summary = parseSummary(output);

    assertSkippedReason(summary, 'no-changes');
    assert.deepEqual(summary.writes, []);
    assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw')), false);
  });
});

/**
 * 在指定目录执行 refresh。
 *
 * @param directory 项目目录。
 * @param options refresh 选项。
 * @returns JSON 输出。
 */
async function runRefreshInDirectory(
  directory: string,
  options: { readonly changed?: readonly string[]; readonly dryRun?: boolean; readonly writeGenerated?: boolean } = {},
): Promise<string> {
  return runCommandInDirectory(directory, async (): Promise<void> => {
    await runRefreshCommand(options);
  });
}

/**
 * 在指定目录执行 status。
 *
 * @param directory 项目目录。
 * @returns JSON 输出。
 */
async function runStatusInDirectory(directory: string): Promise<string> {
  return runCommandInDirectory(directory, runStatusCommand);
}

/**
 * 在指定目录捕获命令输出。
 *
 * @param directory 项目目录。
 * @param callback 命令回调。
 * @returns 捕获输出。
 */
async function runCommandInDirectory(directory: string, callback: () => Promise<void>): Promise<string> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;

  try {
    process.exitCode = undefined;
    process.chdir(directory);

    const output = await captureConsole(callback);

    assert.equal(process.exitCode, undefined);

    return output;
  } finally {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
  }
}

/**
 * 捕获 console 输出。
 *
 * @param callback 回调。
 * @returns 输出文本。
 */
async function captureConsole(callback: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: string[] = [];

  console.log = (...data: unknown[]): void => {
    logs.push(data.map(String).join(' '));
  };
  console.warn = (...data: unknown[]): void => {
    logs.push(data.map(String).join(' '));
  };
  console.error = (...data: unknown[]): void => {
    logs.push(data.map(String).join(' '));
  };

  try {
    await callback();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  return logs.join('\n');
}

/**
 * 创建测试项目。
 *
 * @param projectDirectory 项目目录。
 */
async function createRefreshProject(projectDirectory: string): Promise<void> {
  const veawDirectory = path.join(projectDirectory, '.veaw');

  await fs.ensureDir(path.join(projectDirectory, 'src', 'components'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'layouts'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'router'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'api'));
  await fs.ensureDir(path.join(veawDirectory, 'component-catalog'));
  await writeFile(
    path.join(projectDirectory, 'src', 'components', 'DemoButton.vue'),
    [
      '<script setup lang="ts">',
      "defineOptions({ name: 'DemoButton' });",
      'defineProps<{ readonly label: string }>();',
      '</script>',
      '<template><button>{{ label }}</button></template>',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(projectDirectory, 'src', 'layouts', 'AppShell.vue'),
    [
      '<script setup lang="ts">',
      "defineOptions({ name: 'AppShell' });",
      '</script>',
      '<template><main><slot /></main></template>',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(projectDirectory, 'src', 'router', 'index.ts'), 'export const routes = [];\n');
  await writeJsonFile(path.join(projectDirectory, 'package.json'), {
    dependencies: {
      vue: '^3.5.0',
      'vue-router': '^4.0.0',
    },
  });
  await writeJsonFile(path.join(veawDirectory, 'project.json'), {
    name: 'refresh-demo',
    root: projectDirectory,
    frameworks: ['Vue', 'Vite'],
    packageManager: 'pnpm',
    nodeVersion: process.version,
    customProjectField: 'keep-project-field',
    packageJson: {
      dependencies: {
        vue: '^3.5.0',
        'vue-router': '^4.0.0',
      },
    },
    typescript: {
      enabled: true,
    },
    vite: {
      detected: true,
    },
  });
  await writeJsonFile(path.join(veawDirectory, 'config.json'), {
    customConfigField: 'keep-config-field',
  });
  await writeJsonFile(path.join(veawDirectory, 'resources.lock.json'), {
    schemaVersion: '1.0.0',
    workspaceVersion: '1.0.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    resources: [],
  });
  await writeJsonFile(path.join(veawDirectory, 'component-catalog', 'catalog.json'), {
    customCatalogField: 'keep-catalog-field',
    components: [
      {
        filePath: 'src/components/DemoButton.vue',
        name: 'OldDemoButton',
        customNote: 'keep-component-note',
      },
    ],
  });
  await writeFile(
    path.join(veawDirectory, 'context.md'),
    [
      '# Manual Context',
      '',
      '<!-- VEAW_CONTEXT_START -->',
      'old generated content',
      '<!-- VEAW_CONTEXT_END -->',
      '',
      '# Manual Tail',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(veawDirectory, 'session-log.md'), '# Session\n');
}

/**
 * 初始化 Git 仓库。
 *
 * @param projectDirectory 项目目录。
 */
async function initializeGitRepository(projectDirectory: string): Promise<void> {
  await runGit(projectDirectory, ['init']);
  await runGit(projectDirectory, ['config', 'user.email', 'veaw@example.com']);
  await runGit(projectDirectory, ['config', 'user.name', 'VEAW Test']);
  await runGit(projectDirectory, ['add', '.']);
  await runGit(projectDirectory, ['commit', '-m', 'initial'], {
    GIT_AUTHOR_DATE: createYesterdayIsoString(),
    GIT_COMMITTER_DATE: createYesterdayIsoString(),
  });
}

/**
 * 执行 Git 命令。
 *
 * @param projectDirectory 项目目录。
 * @param args Git 参数。
 * @param environment 环境变量。
 */
async function runGit(
  projectDirectory: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  await execa('git', args, {
    cwd: projectDirectory,
    env: environment,
  });
}

/**
 * 执行 Git 命令并读取输出。
 *
 * @param projectDirectory 项目目录。
 * @param args Git 参数。
 * @returns Git 标准输出。
 */
async function runGitWithOutput(projectDirectory: string, args: readonly string[]): Promise<string> {
  const result = await execa('git', args, {
    cwd: projectDirectory,
  });

  return result.stdout;
}

/**
 * 创建昨天的 ISO 日期时间。
 *
 * @returns ISO 日期时间。
 */
function createYesterdayIsoString(): string {
  const date = new Date();

  date.setDate(date.getDate() - 1);

  return date.toISOString();
}

/**
 * 读取 .veaw 文件快照。
 *
 * @param projectDirectory 项目目录。
 * @returns 文件快照。
 */
async function readVeawSnapshot(projectDirectory: string): Promise<Readonly<Record<string, string | undefined>>> {
  const filePaths = [
    '.veaw/config.json',
    '.veaw/project.json',
    '.veaw/resources.lock.json',
    '.veaw/session-log.md',
    '.veaw/context.md',
    '.veaw/component-catalog/catalog.json',
  ];
  const snapshot: Record<string, string | undefined> = {};

  for (const filePath of filePaths) {
    const absolutePath = path.join(projectDirectory, filePath);

    snapshot[filePath] = (await fs.pathExists(absolutePath)) ? await readFile(absolutePath, 'utf8') : undefined;
  }

  return snapshot;
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
 * 解析命令摘要。
 *
 * @param output 命令输出。
 * @returns refresh/status 摘要。
 */
function parseSummary(output: string): RefreshSummary {
  const summary = JSON.parse(output) as unknown;

  assert.ok(isRefreshSummary(summary));

  return summary;
}

/**
 * 断言 skippedReason 字段存在且值正确。
 *
 * @param summary refresh/status 摘要。
 * @param expected 预期跳过原因。
 */
function assertSkippedReason(summary: RefreshSummary, expected: string | null): void {
  assert.equal(Object.hasOwn(summary, 'skippedReason'), true);
  assert.equal(summary.skippedReason, expected);
}

/**
 * 读取对象数组字段。
 *
 * @param record JSON 对象。
 * @param key 字段名。
 * @returns 对象数组。
 */
function readArray(record: Readonly<JsonObject>, key: string): readonly JsonObject[] {
  const value = record[key];

  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * 读取字符串字段。
 *
 * @param record JSON 对象。
 * @param key 字段名。
 * @returns 字符串字段。
 */
function readString(record: Readonly<JsonObject>, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * 查找组件。
 *
 * @param components 组件列表。
 * @param filePath 组件路径。
 * @returns 组件对象。
 */
function findComponent(components: readonly JsonObject[], filePath: string): JsonObject {
  const component = components.find((item) => readString(item, 'filePath') === filePath);

  assert.ok(component, `Expected component ${filePath}`);

  return component;
}

/**
 * 判断值是否为 refresh/status 摘要。
 *
 * @param value 待判断值。
 * @returns 是否为 refresh/status 摘要。
 */
function isRefreshSummary(value: unknown): value is RefreshSummary {
  return (
    isRecord(value) &&
    isRecord(value.targets) &&
    typeof value.source === 'string' &&
    Array.isArray(value.sources) &&
    Array.isArray(value.changedFiles) &&
    Array.isArray(value.writes) &&
    Object.hasOwn(value, 'skippedReason')
  );
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
