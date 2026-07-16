import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { createAskPrompt, generateAskPrompt, runAskCommand } from '../src/commands/ask.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('generateAskPrompt', (): void => {
  it('generates all required sections', (): void => {
    const prompt = generateAskPrompt({
      question: '如何新增 ask 命令？',
      contextContent: '# Context',
      projectContent: '{"name":"demo"}',
      catalogContent: '{"components":[]}',
      sessionLogContent: '# Session',
    });

    assert.match(prompt, /## 项目背景/);
    assert.match(prompt, /## 技术栈/);
    assert.match(prompt, /## 组件目录/);
    assert.match(prompt, /## 历史会话摘要/);
    assert.match(prompt, /## 用户问题/);
    assert.match(prompt, /## 执行约束/);
    assert.match(prompt, /如何新增 ask 命令？/);
  });
});

describe('createAskPrompt', (): void => {
  it('reads .veaw files and skips missing optional context files', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const veawDirectory = path.join(projectDirectory, '.veaw');

    await fs.ensureDir(path.join(veawDirectory, 'component-catalog'));
    await writeFile(path.join(veawDirectory, 'context.md'), '# Demo Context');
    await writeFile(path.join(veawDirectory, 'project.json'), '{"frameworks":["Vue","Vite"]}');
    await writeFile(path.join(veawDirectory, 'component-catalog', 'catalog.json'), '{"components":[]}');

    const prompt = await createAskPrompt(projectDirectory, '组件怎么复用？');

    assert.match(prompt, /# Demo Context/);
    assert.match(prompt, /"frameworks":\["Vue","Vite"\]/);
    assert.match(prompt, /"components":\[\]/);
    assert.match(prompt, /组件怎么复用？/);
    assert.match(prompt, /未提供对应上下文文件/);
  });

  it('throws when .veaw workspace is missing', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await assert.rejects(
      () => createAskPrompt(projectDirectory, '现在能问吗？'),
      /未检测到 \.veaw 工作区，请先执行 veaw init/,
    );
  });
});

describe('runAskCommand', (): void => {
  it('writes generated prompt to output file', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const outputFileName = 'prompt.md';
    const originalCwd = process.cwd();
    const originalConsoleLog = console.log;
    const logs: string[] = [];

    await createVeawWorkspace(projectDirectory);

    console.log = (...data: unknown[]): void => {
      logs.push(data.map(String).join(' '));
    };

    try {
      process.chdir(projectDirectory);
      await runAskCommand(['如何', '使用', '组件？'], {
        output: outputFileName,
      });
    } finally {
      process.chdir(originalCwd);
      console.log = originalConsoleLog;
    }

    const outputContent = await readFile(path.join(projectDirectory, outputFileName), 'utf8');

    assert.match(outputContent, /## 用户问题/);
    assert.match(outputContent, /如何 使用 组件？/);
    assert.ok(logs.some((log) => log.includes('如何 使用 组件？')));
  });
});

/**
 * 创建测试项目目录。
 *
 * @returns 项目目录路径。
 */
async function createTemporaryProjectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veaw-ask-'));

  temporaryDirectories.push(directory);

  return directory;
}

/**
 * 创建完整 .veaw 测试工作区。
 *
 * @param projectDirectory 项目目录路径。
 */
async function createVeawWorkspace(projectDirectory: string): Promise<void> {
  const veawDirectory = path.join(projectDirectory, '.veaw');

  await fs.ensureDir(path.join(veawDirectory, 'component-catalog'));
  await writeFile(path.join(veawDirectory, 'context.md'), '# Demo Context');
  await writeFile(path.join(veawDirectory, 'project.json'), '{"frameworks":["Vue","Vite"]}');
  await writeFile(path.join(veawDirectory, 'component-catalog', 'catalog.json'), '{"components":[]}');
  await writeFile(path.join(veawDirectory, 'session-log.md'), '# Session Log');
}
