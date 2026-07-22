import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { runCatalogCommand } from '../src/commands/catalog.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('runCatalogCommand', (): void => {
  it('scans components and includes catalog extension/template resources from Workspace Registry', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-catalog-project-');
    const workspaceDirectory = await createWorkspaceFixture('veaw-catalog-workspace-');

    await createVueComponent(projectDirectory);
    await createVeawConfig(projectDirectory, workspaceDirectory);
    await runCatalogInDirectory(projectDirectory);

    const catalog = await readJsonObject(path.join(projectDirectory, '.veaw', 'component-catalog', 'catalog.json'));
    const resources = readArray(catalog, 'availableResources');
    const components = readArray(catalog, 'components');

    assert.equal(components.length, 1);
    assert.deepEqual(
      resources.map((resource) => readString(resource, 'id')),
      ['extension-template:component-catalog', 'extension:component-intelligence', 'template:component-catalog'],
    );
  });

  it('keeps catalog generation usable when Workspace is unavailable', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-catalog-fallback-');

    await createVueComponent(projectDirectory);
    await runCatalogInDirectory(projectDirectory);

    const catalog = await readJsonObject(path.join(projectDirectory, '.veaw', 'component-catalog', 'catalog.json'));
    const resources = readArray(catalog, 'availableResources');
    const components = readArray(catalog, 'components');

    assert.equal(resources.length, 0);
    assert.equal(components.length, 1);
  });

  it('does not misread constants or JSDoc links as component metadata', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-catalog-regression-');

    await fs.ensureDir(path.join(projectDirectory, 'src', 'views', 'login'));
    await fs.ensureDir(path.join(projectDirectory, 'src', 'components', 'custom'));
    await writeFile(
      path.join(projectDirectory, 'src', 'views', 'login', 'index.vue'),
      [
        '<script setup lang="ts">',
        'import { computed } from "vue";',
        'interface Props {',
        '  module?: string;',
        '}',
        'const props = defineProps<Props>();',
        'const color = computed(() => {',
        '  const COLOR_WHITE = "#ffffff";',
        '  return COLOR_WHITE;',
        '});',
        '</script>',
        '<template><div>{{ props.module }}{{ color }}</div></template>',
      ].join('\n'),
    );
    await writeFile(
      path.join(projectDirectory, 'src', 'components', 'custom', 'better-scroll.vue'),
      [
        '<script setup lang="ts">',
        'defineOptions({ name: "BetterScroll" });',
        'interface Props {',
        '  /**',
        '   * BetterScroll options',
        '   *',
        '   * @link https://better-scroll.github.io/docs/zh-CN/guide/base-scroll-options.html',
        '   */',
        '  options: Record<string, unknown>;',
        '}',
        'defineProps<Props>();',
        '</script>',
        '<template><slot /></template>',
      ].join('\n'),
    );

    await runCatalogInDirectory(projectDirectory);

    const catalog = await readJsonObject(path.join(projectDirectory, '.veaw', 'component-catalog', 'catalog.json'));
    const components = readArray(catalog, 'components');
    const login = findComponent(components, 'src/views/login/index.vue');
    const betterScroll = findComponent(components, 'src/components/custom/better-scroll.vue');
    const betterScrollProps = readArray(betterScroll, 'props');

    assert.equal(readString(login, 'name'), 'Login');
    assert.equal(readString(login, 'category'), 'page');
    assert.equal(readString(betterScroll, 'name'), 'BetterScroll');
    assert.equal(readString(betterScroll, 'category'), 'shared');
    assert.equal(readBoolean(betterScroll, 'isShared'), true);
    assert.deepEqual(
      betterScrollProps.map((prop) => readString(prop, 'name')),
      ['options'],
    );
    assert.ok(readUnknownArray(betterScroll, 'usageHints').length > 0);
  });

  it('removes stale components, preserves custom fields, and skips no-op writes', async (): Promise<void> => {
    const projectDirectory = await createTemporaryDirectory('veaw-catalog-idempotent-');
    const catalogPath = path.join(projectDirectory, '.veaw', 'component-catalog', 'catalog.json');
    const componentPath = path.join(projectDirectory, 'src', 'components', 'DemoButton.vue');

    await createVueComponent(projectDirectory);
    await runCatalogInDirectory(projectDirectory);

    const initialCatalog = await readJsonObject(catalogPath);
    const initialComponent = findComponent(readArray(initialCatalog, 'components'), 'src/components/DemoButton.vue');

    await writeJsonFile(catalogPath, {
      ...initialCatalog,
      customCatalogField: 'keep-catalog',
      components: [{ ...initialComponent, customComponentField: 'keep-component' }],
    });
    await runCatalogInDirectory(projectDirectory);

    const mergedCatalog = await readJsonObject(catalogPath);
    const mergedComponent = findComponent(readArray(mergedCatalog, 'components'), 'src/components/DemoButton.vue');

    assert.equal(readString(mergedCatalog, 'customCatalogField'), 'keep-catalog');
    assert.equal(readString(mergedComponent, 'customComponentField'), 'keep-component');

    const beforeContent = await readFile(catalogPath, 'utf8');
    const beforeMtime = (await stat(catalogPath)).mtimeMs;

    await runCatalogInDirectory(projectDirectory);

    assert.equal(await readFile(catalogPath, 'utf8'), beforeContent);
    assert.equal((await stat(catalogPath)).mtimeMs, beforeMtime);

    await unlink(componentPath);
    await runCatalogInDirectory(projectDirectory);

    const catalogAfterDelete = await readJsonObject(catalogPath);

    assert.equal(readArray(catalogAfterDelete, 'components').length, 0);
    assert.equal(readString(catalogAfterDelete, 'customCatalogField'), 'keep-catalog');
  });
});

/**
 * 在指定目录执行 catalog。
 *
 * @param directory 目标目录。
 */
async function runCatalogInDirectory(directory: string): Promise<void> {
  const originalCwd = process.cwd();

  try {
    process.chdir(directory);
    await runCatalogCommand();
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
 * 创建 Vue 组件。
 *
 * @param projectDirectory 项目目录。
 */
async function createVueComponent(projectDirectory: string): Promise<void> {
  await fs.ensureDir(path.join(projectDirectory, 'src', 'components'));
  await writeFile(
    path.join(projectDirectory, 'src', 'components', 'DemoButton.vue'),
    [
      '<script setup lang="ts">',
      'defineProps<{',
      '  label: string;',
      '}>();',
      '</script>',
      '<template>',
      '  <button>{{ label }}</button>',
      '</template>',
    ].join('\n'),
  );
}

/**
 * 创建 .veaw/config.json。
 *
 * @param projectDirectory 项目目录。
 * @param workspaceDirectory Workspace 目录。
 */
async function createVeawConfig(projectDirectory: string, workspaceDirectory: string): Promise<void> {
  await writeJsonFile(path.join(projectDirectory, '.veaw', 'config.json'), {
    workspacePath: workspaceDirectory,
  });
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
  await writeFile(path.join(workspaceDirectory, 'component-extension.md'), '# Component Extension');
  await writeFile(path.join(workspaceDirectory, 'component-extension-template.md'), '# Component Extension Template');
  await writeFile(path.join(workspaceDirectory, 'component-template.md'), '# Component Template');
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
        id: 'extensions',
        type: 'extension',
        path: 'extensions.json',
        required: true,
      },
      {
        id: 'templates',
        type: 'template',
        path: 'templates.json',
        required: true,
      },
    ],
  });
  await writeResourceRegistry(registriesDirectory, 'extensions.json', 'extension', [
    createResource({
      id: 'extension:component-intelligence',
      type: 'extension',
      sourcePath: 'component-extension.md',
      targetPath: '.veaw/resources/extensions/component-intelligence.md',
      tags: ['extension', 'component', 'catalog'],
    }),
    createResource({
      id: 'extension-template:component-catalog',
      type: 'extension-template',
      sourcePath: 'component-extension-template.md',
      targetPath: '.veaw/resources/extensions/component-catalog.md',
      tags: ['extension', 'component', 'catalog', 'template'],
    }),
  ]);
  await writeResourceRegistry(registriesDirectory, 'templates.json', 'template', [
    createResource({
      id: 'template:component-catalog',
      type: 'template',
      sourcePath: 'component-template.md',
      targetPath: '.veaw/resources/templates/component-catalog.md',
      tags: ['template', 'component', 'catalog'],
    }),
  ]);

  return workspaceDirectory;
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
    enabledByDefault: false,
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
 * 读取数组字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 数组字段。
 */
function readArray(record: Readonly<Record<string, unknown>>, key: string): readonly Record<string, unknown>[] {
  const value = record[key];

  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * 读取数组字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 数组字段。
 */
function readUnknownArray(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key];

  return Array.isArray(value) ? value : [];
}

/**
 * 读取字符串字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 字符串字段。
 */
function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
}

/**
 * 读取布尔字段。
 *
 * @param record 对象记录。
 * @param key 字段名。
 * @returns 布尔字段。
 */
function readBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = record[key];

  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 查找组件。
 *
 * @param components 组件列表。
 * @param filePath 组件路径。
 * @returns 组件。
 */
function findComponent(
  components: readonly Record<string, unknown>[],
  filePath: string,
): Readonly<Record<string, unknown>> {
  const component = components.find((item) => readString(item, 'filePath') === filePath);

  assert.ok(component, `Expected component ${filePath}`);

  return component;
}

/**
 * 判断值是否是对象记录。
 *
 * @param value 待判断值。
 * @returns 是否是对象记录。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
