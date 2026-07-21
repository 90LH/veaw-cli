import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import fs from 'fs-extra';
import { createAskAnswer, createAskPrompt, generateAskAnswer, generateAskPrompt, runAskCommand } from '../src/commands/ask.js';

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

    assert.match(prompt, /# AI 项目上下文包/);
    assert.match(prompt, /不是模型已经回答后的最终答案/);
    assert.match(prompt, /## 项目背景/);
    assert.match(prompt, /## 技术栈/);
    assert.match(prompt, /## 组件目录/);
    assert.match(prompt, /## 历史会话摘要/);
    assert.match(prompt, /## 用户问题/);
    assert.match(prompt, /## 执行约束/);
    assert.match(prompt, /如何新增 ask 命令？/);
  });
});

describe('generateAskAnswer', (): void => {
  it('generates a structured deterministic answer with evidence and gaps', (): void => {
    const answer = generateAskAnswer({
      question: '本项目使用什么 UI 库？',
      contextContent: '- UI 库：naive-ui\n- Service 目录：src/service',
      projectContent: JSON.stringify({
        projectInsights: {
          uiLibraries: ['naive-ui'],
          router: {
            packages: ['vue-router'],
            directories: ['src/router'],
          },
          stateManagement: {
            packages: ['pinia'],
            directories: ['src/store'],
          },
          apiDirectories: {
            paths: [],
          },
          serviceDirectories: {
            paths: ['src/service'],
          },
        },
      }),
      catalogContent: JSON.stringify({
        components: [{ name: 'DemoButton' }],
      }),
    });

    assert.match(answer, /## 结论/);
    assert.match(answer, /UI 库：naive-ui/);
    assert.match(answer, /路由：vue-router；目录：src\/router/);
    assert.match(answer, /状态管理：pinia；目录：src\/store/);
    assert.match(answer, /Service 目录：src\/service/);
    assert.match(answer, /## 证据来源/);
    assert.match(answer, /## 缺失上下文/);
    assert.match(answer, /## 保守建议/);
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

  it('includes prompt, rule, and skill resources from Workspace Registry', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const workspaceDirectory = await createWorkspaceFixture('veaw-ask-workspace-');

    await createVeawWorkspace(projectDirectory, workspaceDirectory);

    const prompt = await createAskPrompt(projectDirectory, '如何创建列表页？');

    assert.match(prompt, /prompt:list-page/);
    assert.match(prompt, /Workspace List Prompt/);
    assert.match(prompt, /rule:vue3/);
    assert.match(prompt, /Workspace Vue Rule/);
    assert.match(prompt, /skill:vue-page-create/);
    assert.match(prompt, /Workspace Vue Page Skill/);
  });
});

describe('createAskAnswer', (): void => {
  it('reads .veaw context and returns direct conclusions', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await createVeawWorkspace(projectDirectory);

    const answer = await createAskAnswer(projectDirectory, '本项目使用什么 UI 库？');

    assert.match(answer, /## 结论/);
    assert.match(answer, /UI 库：naive-ui/);
    assert.match(answer, /路由：vue-router；目录：src\/router/);
    assert.match(answer, /状态管理：pinia；目录：src\/store/);
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

  it('prints deterministic answer in answer mode while keeping legacy prompt mode compatible', async (): Promise<void> => {
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
      await runAskCommand(['本项目', '使用什么', 'UI库？'], {
        answer: true,
      });
      await runAskCommand(['本项目', '使用什么', 'UI库？'], {
        prompt: true,
      });
    } finally {
      process.chdir(originalCwd);
      console.log = originalConsoleLog;
    }

    assert.ok(logs.some((log) => log.includes('# VEAW ask 回答任务')));
    assert.ok(logs.some((log) => log.includes('# AI 项目上下文包')));
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
async function createVeawWorkspace(projectDirectory: string, workspaceDirectory?: string): Promise<void> {
  const veawDirectory = path.join(projectDirectory, '.veaw');

  await fs.ensureDir(path.join(veawDirectory, 'component-catalog'));
  await writeFile(path.join(veawDirectory, 'context.md'), '# Demo Context\n- UI 库：naive-ui\n- Service 目录：src/service');
  await writeFile(
    path.join(veawDirectory, 'project.json'),
    JSON.stringify({
      frameworks: ['Vue', 'Vite'],
      projectInsights: {
        uiLibraries: ['naive-ui'],
        router: {
          packages: ['vue-router'],
          directories: ['src/router'],
        },
        stateManagement: {
          packages: ['pinia'],
          directories: ['src/store'],
        },
        apiDirectories: {
          paths: [],
        },
        serviceDirectories: {
          paths: ['src/service'],
        },
      },
    }),
  );
  await writeFile(path.join(veawDirectory, 'component-catalog', 'catalog.json'), '{"components":[]}');
  await writeFile(path.join(veawDirectory, 'session-log.md'), '# Session Log');

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
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const registriesDirectory = path.join(workspaceDirectory, 'registries');

  temporaryDirectories.push(workspaceDirectory);

  await fs.ensureDir(registriesDirectory);
  await writeFile(path.join(workspaceDirectory, 'workspace.json'), '{"name":"VEAW"}');
  await writeFile(path.join(workspaceDirectory, 'list-prompt.md'), '# Workspace List Prompt');
  await writeFile(path.join(workspaceDirectory, 'vue-rule.md'), '# Workspace Vue Rule');
  await writeFile(path.join(workspaceDirectory, 'vue-page-skill.md'), '# Workspace Vue Page Skill');
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
      {
        id: 'rules',
        type: 'rule',
        path: 'rules.json',
        required: true,
      },
      {
        id: 'skills',
        type: 'skill',
        path: 'skills.json',
        required: true,
      },
    ],
  });
  await writeResourceRegistry(registriesDirectory, 'prompts.json', 'prompt', [
    createResource({
      id: 'prompt:list-page',
      type: 'prompt',
      sourcePath: 'list-prompt.md',
      targetPath: '.veaw/resources/prompts/list-page.md',
      tags: ['prompt', 'list', 'page'],
    }),
  ]);
  await writeResourceRegistry(registriesDirectory, 'rules.json', 'rule', [
    createResource({
      id: 'rule:vue3',
      type: 'rule',
      sourcePath: 'vue-rule.md',
      targetPath: '.veaw/resources/rules/vue-rule.md',
      tags: ['rule', 'vue'],
    }),
  ]);
  await writeResourceRegistry(registriesDirectory, 'skills.json', 'skill', [
    createResource({
      id: 'skill:vue-page-create',
      type: 'skill',
      sourcePath: 'vue-page-skill.md',
      targetPath: '.veaw/resources/skills/vue-page-create.md',
      tags: ['skill', 'vue', 'page'],
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
