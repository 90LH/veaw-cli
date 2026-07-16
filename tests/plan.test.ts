import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { createPlanTemplate, generatePlanTemplate, runPlanCommand, writePlanFile } from '../src/commands/plan.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('generatePlanTemplate', (): void => {
  it('generates all required plan sections', (): void => {
    const template = generatePlanTemplate({
      requirement: '新增用户权限配置页面',
      contextContent: '# Context',
      projectContent: '{"frameworks":["Vue","Vite"]}',
      catalogContent: '{"components":[]}',
    });

    assert.match(template, /## 1\. 需求原文/);
    assert.match(template, /## 2\. 项目背景和技术栈/);
    assert.match(template, /## 3\. 相关现有组件与依赖关系/);
    assert.match(template, /## 4\. 推荐修改\/新增文件/);
    assert.match(template, /## 5\. 实施步骤/);
    assert.match(template, /## 6\. 风险、兼容性影响与验收标准/);
    assert.match(template, /新增用户权限配置页面/);
    assert.match(template, /不调用第三方 AI API/);
  });
});

describe('createPlanTemplate', (): void => {
  it('reads required .veaw context files', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await createVeawWorkspace(projectDirectory);

    const template = await createPlanTemplate(projectDirectory, '优化课程卡片交互');

    assert.match(template, /# Demo Context/);
    assert.match(template, /"frameworks":\["Vue","Vite"\]/);
    assert.match(template, /"components":\[\]/);
    assert.match(template, /优化课程卡片交互/);
  });

  it('throws remediation command when .veaw is missing', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await assert.rejects(
      () => createPlanTemplate(projectDirectory, '新增页面'),
      /veaw init/,
    );
  });

  it('throws remediation commands when required context files are missing', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await fs.ensureDir(path.join(projectDirectory, '.veaw'));

    await assert.rejects(
      () => createPlanTemplate(projectDirectory, '新增页面'),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /veaw sync/);
        assert.match(error.message, /veaw catalog/);
        assert.match(error.message, /veaw context/);
        return true;
      },
    );
  });
});

describe('writePlanFile', (): void => {
  it('writes to default .veaw/plans path', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const outputPath = await writePlanFile({
      targetDirectory: projectDirectory,
      content: '# Plan',
    });

    assert.equal(path.dirname(outputPath), path.join(projectDirectory, '.veaw', 'plans'));
    assert.match(path.basename(outputPath), /^\d{8}-\d{9}-plan\.md$/);
    assert.equal(await readFile(outputPath, 'utf8'), '# Plan');
  });

  it('does not overwrite existing files', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const outputFileName = 'existing-plan.md';

    await writeFile(path.join(projectDirectory, outputFileName), '# Existing');

    await assert.rejects(
      () =>
        writePlanFile({
          targetDirectory: projectDirectory,
          content: '# Next',
          output: outputFileName,
        }),
      /已拒绝覆盖/,
    );
  });
});

describe('runPlanCommand', (): void => {
  it('writes default plan file when dry-run is disabled', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const originalCwd = process.cwd();

    await createVeawWorkspace(projectDirectory);

    try {
      process.chdir(projectDirectory);
      await runPlanCommand(['新增', '课程', '页面']);
    } finally {
      process.chdir(originalCwd);
    }

    const planFiles = await readdir(path.join(projectDirectory, '.veaw', 'plans'));

    assert.equal(planFiles.length, 1);
    assert.match(planFiles[0] ?? '', /-plan\.md$/);
  });

  it('prints only to terminal in dry-run mode', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const originalCwd = process.cwd();
    const originalConsoleLog = console.log;
    const logs: string[] = [];

    await createVeawWorkspace(projectDirectory);

    console.log = (...data: unknown[]): void => {
      logs.push(data.map(String).join(' '));
    };

    try {
      process.chdir(projectDirectory);
      await runPlanCommand(['新增', '课程', '页面'], {
        dryRun: true,
      });
    } finally {
      process.chdir(originalCwd);
      console.log = originalConsoleLog;
    }

    assert.ok(logs.some((log) => log.includes('新增 课程 页面')));
    assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'plans')), false);
  });
});

/**
 * 创建测试项目目录。
 *
 * @returns 项目目录路径。
 */
async function createTemporaryProjectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veaw-plan-'));

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
}
