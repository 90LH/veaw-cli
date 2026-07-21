import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import fs from 'fs-extra';
import { afterEach, describe, it } from 'node:test';
import { registerPhaseTwoCommands } from '../src/commands/phase-two.js';
import {
  createInternalComponentMcpClient,
  createUiComponentContext,
  queryLocalComponents,
} from '../src/context/capabilities.js';
import { CONTEXT_SCHEMA_CATALOG } from '../src/context/schemas.js';
import type { ComponentQueryResult } from '../src/context/schemas.js';

const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('phase two schemas', (): void => {
  it('exposes all shared schema names', (): void => {
    assert.deepEqual(CONTEXT_SCHEMA_CATALOG.schemas, [
      'screenshot-context',
      'component-query-result',
      'ui-component-context',
      'design-context',
      'task-list',
      'review-result',
    ]);
  });
});

describe('queryLocalComponents', (): void => {
  it('queries local catalog with evidence', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    const result = await queryLocalComponents({
      projectDirectory,
      query: 'table operation',
    });

    assert.equal(result.schema, 'component-query-result');
    assert.equal(result.candidates[0]?.name, 'TableHeaderOperation');
    assert.deepEqual(result.candidates[0]?.api.props, ['loading']);
    assert.equal(result.evidence[0]?.source, 'catalog');
  });
});

describe('createUiComponentContext', (): void => {
  it('uses MCP candidates when explicitly enabled', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    await writeFile(path.join(projectDirectory, 'screen.png'), 'fake image');

    const result = await createUiComponentContext({
      projectDirectory,
      screenshotPath: 'screen.png',
      requirement: '需要表格操作栏',
      enableMcp: true,
      mcpClient: async (): Promise<ComponentQueryResult> => createMcpResult('InternalTableToolbar'),
    });

    assert.equal(result.screenshot.available, true);
    assert.ok(result.candidates.some((candidate) => candidate.name === 'InternalTableToolbar'));
    assert.ok(result.candidates.some((candidate) => candidate.source === 'catalog'));
  });

  it('degrades when MCP is not configured', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    await writeFile(path.join(projectDirectory, 'screen.png'), 'fake image');

    const result = await createUiComponentContext({
      projectDirectory,
      screenshotPath: 'screen.png',
      requirement: '需要表格操作栏',
      enableMcp: true,
    });

    assert.ok(result.degradations.some((item) => item.code === 'MCP_CALL_FAILED'));
    assert.ok(result.candidates.some((candidate) => candidate.source === 'catalog'));
  });

  it('degrades on MCP auth failure', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    await writeFile(path.join(projectDirectory, 'screen.png'), 'fake image');

    const result = await createUiComponentContext({
      projectDirectory,
      screenshotPath: 'screen.png',
      requirement: '需要表格操作栏',
      enableMcp: true,
      mcpClient: async (): Promise<ComponentQueryResult> => {
        throw new Error('鉴权失败');
      },
    });

    assert.ok(result.degradations.some((item) => item.code === 'MCP_CALL_FAILED' && item.reason.includes('鉴权失败')));
  });

  it('degrades on MCP timeout', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    await writeFile(path.join(projectDirectory, 'screen.png'), 'fake image');
    const timeoutClient = createInternalComponentMcpClient({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      toolName: 'query_internal_components',
      timeoutMs: 10,
    });

    const result = await createUiComponentContext({
      projectDirectory,
      screenshotPath: 'screen.png',
      requirement: '需要表格操作栏',
      enableMcp: true,
      mcpClient: timeoutClient,
    });

    assert.ok(result.degradations.some((item) => item.code === 'MCP_CALL_FAILED' && item.reason.includes('超时')));
  });

  it('degrades on empty MCP result', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    await writeFile(path.join(projectDirectory, 'screen.png'), 'fake image');

    const result = await createUiComponentContext({
      projectDirectory,
      screenshotPath: 'screen.png',
      requirement: '需要表格操作栏',
      enableMcp: true,
      mcpClient: async (): Promise<ComponentQueryResult> => ({
        schema: 'component-query-result',
        version: '1.0.0',
        query: 'table',
        candidates: [],
        evidence: [],
        degradations: [{ code: 'MCP_EMPTY_RESULT', reason: '无结果', fallback: '本地 catalog' }],
      }),
    });

    assert.ok(result.degradations.some((item) => item.code === 'MCP_EMPTY_RESULT'));
    assert.ok(result.candidates.some((candidate) => candidate.source === 'catalog'));
  });

  it('skips MCP when screenshot is missing', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    let called = false;

    const result = await createUiComponentContext({
      projectDirectory,
      requirement: '需要表格操作栏',
      enableMcp: true,
      mcpClient: async (): Promise<ComponentQueryResult> => {
        called = true;
        return createMcpResult('ShouldNotCall');
      },
    });

    assert.equal(called, false);
    assert.ok(result.degradations.some((item) => item.code === 'MCP_SKIPPED_SCREENSHOT_MISSING'));
  });

  it('keeps local catalog candidate first when MCP conflicts', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    await writeFile(path.join(projectDirectory, 'screen.png'), 'fake image');

    const result = await createUiComponentContext({
      projectDirectory,
      screenshotPath: 'screen.png',
      query: 'button',
      enableMcp: true,
      mcpClient: async (): Promise<ComponentQueryResult> => createMcpResult('ButtonIcon'),
    });

    assert.equal(result.candidates.filter((candidate) => candidate.name === 'ButtonIcon').length, 1);
    assert.equal(result.candidates.find((candidate) => candidate.name === 'ButtonIcon')?.source, 'catalog');
  });
});

describe('phase two commands', (): void => {
  it('prints to stdout by default without creating files', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    const before = await snapshotDirectory(projectDirectory);
    const logs = await runCommand(projectDirectory, ['component-query', 'table']);
    const after = await snapshotDirectory(projectDirectory);

    assert.ok(logs.some((log) => log.includes('"schema": "component-query-result"')));
    assert.deepEqual(after, before);
  });

  it('writes only with explicit output and refuses overwrite', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();

    await runCommand(projectDirectory, ['component-query', 'table', '--output', 'component-query.json']);

    const outputPath = path.join(projectDirectory, 'component-query.json');
    assert.equal(await fs.pathExists(outputPath), true);
    const before = await fs.readFile(outputPath, 'utf8');
    await runCommand(projectDirectory, ['component-query', 'table', '--output', 'component-query.json']);
    assert.equal(await fs.readFile(outputPath, 'utf8'), before);
  });

  it('creates design context, task list, and review output', async (): Promise<void> => {
    const projectDirectory = await createProjectFixture();
    const designLogs = await runCommand(projectDirectory, ['design-context', '新增', '业务页面']);
    const taskLogs = await runCommand(projectDirectory, ['task-list', '新增', '业务页面']);
    const reviewLogs = await runCommand(projectDirectory, ['review']);

    assert.ok(designLogs.some((log) => log.includes('"schema": "design-context"')));
    assert.ok(taskLogs.some((log) => log.includes('"schema": "task-list"')));
    assert.ok(reviewLogs.some((log) => log.includes('"schema": "review-result"')));
  });
});

function createMcpResult(name: string): ComponentQueryResult {
  return {
    schema: 'component-query-result',
    version: '1.0.0',
    query: 'table',
    candidates: [
      {
        name,
        source: 'mcp',
        reference: `mcp:${name}`,
        category: 'internal',
        api: {
          props: ['title'],
          emits: ['confirm'],
          slots: ['default'],
        },
        examples: ['<InternalTableToolbar title="列表" />'],
        dependencies: ['internal-ui'],
        usageHints: ['内部组件库候选，需确认授权和版本。'],
        matchReason: 'MCP mock result.',
        evidence: [{ source: 'mcp', ref: `mcp:${name}`, note: 'mock', confidence: 0.8 }],
      },
    ],
    evidence: [{ source: 'mcp', ref: 'mock', note: 'mock', confidence: 0.8 }],
    degradations: [],
  };
}

async function createProjectFixture(): Promise<string> {
  const projectDirectory = await createTemporaryDirectory('veaw-phase-two-');
  const veawDirectory = path.join(projectDirectory, '.veaw');

  await fs.ensureDir(path.join(veawDirectory, 'component-catalog'));
  await fs.writeJson(path.join(veawDirectory, 'project.json'), {
    version: '0.1.0',
    projectInsights: {
      uiLibraries: ['naive-ui'],
      router: { directories: ['src/router'] },
      stateManagement: { directories: ['src/store'] },
      apiDirectories: { paths: [] },
      serviceDirectories: { paths: ['src/service'] },
    },
  });
  await writeFile(path.join(veawDirectory, 'context.md'), '# Context');
  await fs.writeJson(path.join(veawDirectory, 'component-catalog', 'catalog.json'), {
    version: '0.1.0',
    components: [
      {
        name: 'TableHeaderOperation',
        filePath: 'src/components/advanced/table-header-operation.vue',
        category: 'shared',
        isShared: true,
        props: [{ name: 'loading' }],
        emits: [{ name: 'refresh' }],
        slots: [{ name: 'default' }],
        dependencies: [{ source: 'naive-ui' }],
        usageHints: ['共享表格操作组件'],
      },
      {
        name: 'ButtonIcon',
        filePath: 'src/components/custom/button-icon.vue',
        category: 'shared',
        isShared: true,
        props: [{ name: 'icon' }],
        emits: [],
        slots: [{ name: 'default' }],
        dependencies: [{ source: 'naive-ui' }],
        usageHints: ['图标按钮'],
      },
    ],
  });
  await fs.ensureDir(path.join(projectDirectory, 'src', 'router'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'store'));
  await fs.ensureDir(path.join(projectDirectory, 'src', 'service'));

  return projectDirectory;
}

async function runCommand(projectDirectory: string, args: readonly string[]): Promise<readonly string[]> {
  const program = new Command();
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const logs: string[] = [];

  program.exitOverride();
  program.name('veaw');
  registerPhaseTwoCommands(program);
  console.log = (message?: unknown): void => {
    logs.push(String(message));
  };
  process.chdir(projectDirectory);

  try {
    await program.parseAsync(['node', 'veaw', ...args], { from: 'node' });
    return logs;
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    process.exitCode = undefined;
  }
}

async function snapshotDirectory(directoryPath: string): Promise<readonly string[]> {
  const entries: string[] = [];

  await collectFiles(directoryPath, directoryPath, entries);

  return entries.sort((left, right) => left.localeCompare(right));
}

async function collectFiles(rootDirectory: string, directoryPath: string, entries: string[]): Promise<void> {
  const children = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const child of children) {
    const childPath = path.join(directoryPath, child.name);

    if (child.isDirectory()) {
      await collectFiles(rootDirectory, childPath, entries);
      continue;
    }

    if (child.isFile()) {
      entries.push(path.relative(rootDirectory, childPath).replace(/\\/gu, '/'));
    }
  }
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));

  temporaryDirectories.push(directory);

  return directory;
}
