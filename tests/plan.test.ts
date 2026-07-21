import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.match(template, /# VEAW 实施计划/);
    assert.match(template, /## 2\. 上下文结论/);
    assert.match(template, /## 3\. 推荐修改\/新增文件及职责/);
    assert.match(template, /## 4\. 路由、状态、service 与组件复用路径/);
    assert.match(template, /## 5\. 分步骤实施内容/);
    assert.match(template, /## 7\. 风险、兼容性与验收标准/);
    assert.match(template, /新增用户权限配置页面/);
    assert.match(template, /不调用第三方 AI API/);
    assert.doesNotMatch(template, /请补全以下内容/);
  });
});

describe('createPlanTemplate', (): void => {
  it('reads required .veaw context files', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await createVeawWorkspace(projectDirectory);

    const template = await createPlanTemplate(projectDirectory, '优化课程卡片交互');

    assert.match(template, /# VEAW 实施计划/);
    assert.match(template, /路由目录：src\/router/);
    assert.match(template, /Service 目录：src\/service/);
    assert.match(template, /组件复用：`src\/components\/advanced\/table-header-operation.vue`/);
    assert.match(template, /`.veaw\/context.md`：已读取/);
    assert.match(template, /优化课程卡片交互/);
  });

  it('includes workflow, template, and skill resources from Workspace Registry', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const workspaceDirectory = await createWorkspaceFixture('veaw-plan-workspace-');

    await createVeawWorkspace(projectDirectory, workspaceDirectory);

    const template = await createPlanTemplate(projectDirectory, '新增列表页');

    assert.match(template, /workflow:feature-development/);
    assert.match(template, /Workspace Feature Workflow/);
    assert.match(template, /template:vue-page/);
    assert.match(template, /Workspace Vue Page Template/);
    assert.match(template, /skill:vue-page-create/);
    assert.match(template, /Workspace Vue Page Skill/);
  });

  it('keeps current fallback plan content when Workspace is unavailable', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await createVeawWorkspace(projectDirectory);

    const template = await createPlanTemplate(projectDirectory, '新增页面');

    assert.match(template, /未发现可用 Workspace Registry 资源/);
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
  it('writes only to explicit output path', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();
    const outputPath = await writePlanFile({
      targetDirectory: projectDirectory,
      content: '# Plan',
      output: 'plan.md',
    });

    assert.equal(outputPath, path.join(projectDirectory, 'plan.md'));
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
  it('prints to terminal by default without creating a plans directory', async (): Promise<void> => {
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
      await runPlanCommand(['新增', '课程', '页面']);
    } finally {
      process.chdir(originalCwd);
      console.log = originalConsoleLog;
    }

    assert.ok(logs.some((log) => log.includes('# VEAW 实施计划')));
    assert.equal(await fs.pathExists(path.join(projectDirectory, '.veaw', 'plans')), false);
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

  it('writes a file only when output is provided', async (): Promise<void> => {
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
        output: 'plan.md',
      });
    } finally {
      process.chdir(originalCwd);
      console.log = originalConsoleLog;
    }

    assert.match(await readFile(path.join(projectDirectory, 'plan.md'), 'utf8'), /# VEAW 实施计划/);
    assert.ok(logs.some((log) => log.includes('# VEAW 实施计划')));
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
async function createVeawWorkspace(projectDirectory: string, workspaceDirectory?: string): Promise<void> {
  const veawDirectory = path.join(projectDirectory, '.veaw');

  await fs.ensureDir(path.join(veawDirectory, 'component-catalog'));
  await writeFile(
    path.join(veawDirectory, 'context.md'),
    '# Demo Context\n- Vue 组件优先使用 `<script setup lang="ts">` 与 Composition API。',
  );
  await writeFile(
    path.join(veawDirectory, 'project.json'),
    JSON.stringify({
      frameworks: ['Vue', 'Vite'],
      projectInsights: {
        uiLibraries: ['naive-ui'],
        router: {
          directories: ['src/router'],
        },
        stateManagement: {
          directories: ['src/store'],
        },
        apiDirectories: {
          paths: [],
        },
        serviceDirectories: {
          paths: ['src/service'],
        },
        componentDirectories: {
          paths: ['src/components'],
        },
        layoutDirectories: {
          paths: ['src/layouts'],
        },
      },
    }),
  );
  await writeFile(
    path.join(veawDirectory, 'component-catalog', 'catalog.json'),
    JSON.stringify({
      components: [
        {
          name: 'TableHeaderOperation',
          filePath: 'src/components/advanced/table-header-operation.vue',
          props: [],
          emits: [],
          slots: [],
        },
      ],
    }),
  );

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
  await writeFile(path.join(workspaceDirectory, 'feature-workflow.md'), '# Workspace Feature Workflow');
  await writeFile(path.join(workspaceDirectory, 'vue-page-template.md'), '# Workspace Vue Page Template');
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
        id: 'workflows',
        type: 'workflow',
        path: 'workflows.json',
        required: true,
      },
      {
        id: 'templates',
        type: 'template',
        path: 'templates.json',
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
  await writeResourceRegistry(registriesDirectory, 'workflows.json', 'workflow', [
    createResource({
      id: 'workflow:feature-development',
      type: 'workflow',
      sourcePath: 'feature-workflow.md',
      targetPath: '.veaw/resources/workflows/feature-development.md',
      tags: ['workflow', 'feature'],
    }),
  ]);
  await writeResourceRegistry(registriesDirectory, 'templates.json', 'template', [
    createResource({
      id: 'template:vue-page',
      type: 'template',
      sourcePath: 'vue-page-template.md',
      targetPath: '.veaw/resources/templates/vue-page.md',
      tags: ['template', 'vue', 'page'],
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
