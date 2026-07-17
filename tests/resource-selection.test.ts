import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ResourceResolver,
  createProjectProfileFromProjectJson,
} from '../src/resource-loader/index.js';
import type {
  ProjectProfile,
  ResourceSelectionDecision,
  WorkspaceResource,
} from '../src/resource-loader/index.js';

describe('ResourceResolver profile selection', (): void => {
  it('selects Vue and TypeScript resources from project profile', (): void => {
    const resolver = new ResourceResolver(createSelectionFixtureResources());
    const profile = createProjectProfileFromProjectJson({
      frameworks: ['Vue', 'Vite'],
      packageManager: 'pnpm',
      typescript: {
        enabled: true,
      },
      packageJson: {
        dependencies: {
          vue: '^3.5.0',
          'element-plus': '^2.9.0',
        },
      },
    });

    const result = resolver.resolveSelection({
      profile,
    });
    const resourceIds = result.resources.map((resource) => resource.id);

    assert.ok(profile !== undefined);
    assert.equal(profile.language, 'typescript');
    assert.deepEqual(profile.uiLibrary, ['element-plus']);
    assert.equal(resourceIds.includes('preset:vue-spa'), true);
    assert.equal(resourceIds.includes('rule:vue-typescript'), true);
    assert.equal(resourceIds.includes('template:element-plus'), true);
    assert.equal(resourceIds.includes('rule:react-typescript'), false);
  });

  it('resolves different resources for different presets', (): void => {
    const resolver = new ResourceResolver(createSelectionFixtureResources());
    const profile: ProjectProfile = {
      framework: 'vue',
      language: 'typescript',
      packageManager: 'pnpm',
      projectType: 'frontend',
    };
    const spaSelection = resolver.resolveSelection({
      profile,
      presetIds: ['preset:vue-spa'],
    });
    const adminSelection = resolver.resolveSelection({
      profile,
      presetIds: ['preset:vue-admin'],
    });

    assert.equal(hasResource(spaSelection.resources, 'prompt:spa'), true);
    assert.equal(hasResource(spaSelection.resources, 'prompt:admin'), false);
    assert.equal(hasResource(adminSelection.resources, 'prompt:admin'), true);
    assert.equal(hasResource(adminSelection.resources, 'prompt:spa'), false);
  });

  it('reports extension conflicts without selecting the conflicting extension resources', (): void => {
    const resolver = new ResourceResolver(createSelectionFixtureResources());
    const result = resolver.resolveSelection({
      profile: {
        framework: 'vue',
        language: 'typescript',
        uiLibrary: 'element-plus',
      },
    });
    const conflictDecision = findDecision(result.decisions, 'extension:z-legacy-ui');

    assert.equal(hasResource(result.resources, 'extension:element-plus'), true);
    assert.equal(hasResource(result.resources, 'extension:z-legacy-ui'), false);
    assert.equal(conflictDecision?.status, 'conflict');
    assert.match(conflictDecision?.reason ?? '', /extension:element-plus/);
  });

  it('keeps legacy enabledByDefault behavior when no profile is provided', (): void => {
    const resolver = new ResourceResolver(createSelectionFixtureResources());
    const result = resolver.resolveSelection();
    const resourceIds = result.resources.map((resource) => resource.id);

    assert.equal(resourceIds.includes('rule:react-typescript'), true);
    assert.equal(resourceIds.includes('prompt:spa'), false);
    assert.equal(findDecision(result.decisions, 'rule:react-typescript')?.reason, 'legacy enabledByDefault selection');
  });

  it('explains selected, excluded and conflicted resources', (): void => {
    const resolver = new ResourceResolver(createSelectionFixtureResources());
    const result = resolver.resolveSelection({
      profile: {
        framework: 'vue',
        language: 'typescript',
        uiLibrary: 'element-plus',
      },
    });

    assert.equal(findDecision(result.decisions, 'rule:vue-typescript')?.status, 'selected');
    assert.equal(findDecision(result.decisions, 'rule:react-typescript')?.status, 'excluded');
    assert.equal(findDecision(result.decisions, 'extension:z-legacy-ui')?.status, 'conflict');
  });
});

/**
 * 创建资源选择 fixture。
 *
 * @returns 资源列表。
 */
function createSelectionFixtureResources(): readonly WorkspaceResource[] {
  return [
    createResource({
      id: 'rule:base',
      type: 'rule',
      enabledByDefault: true,
    }),
    createResource({
      id: 'rule:vue-typescript',
      type: 'rule',
      enabledByDefault: true,
      appliesTo: {
        framework: 'vue',
        language: 'typescript',
      },
    }),
    createResource({
      id: 'rule:react-typescript',
      type: 'rule',
      enabledByDefault: true,
      appliesTo: {
        framework: 'react',
        language: 'typescript',
      },
    }),
    createResource({
      id: 'preset:vue-spa',
      type: 'preset',
      enabledByDefault: true,
      copyPolicy: 'none',
      appliesTo: {
        framework: 'vue',
        language: 'typescript',
        projectType: 'frontend',
      },
      defaultResources: ['prompt:spa'],
    }),
    createResource({
      id: 'preset:vue-admin',
      type: 'preset',
      enabledByDefault: false,
      copyPolicy: 'none',
      appliesTo: {
        framework: 'vue',
        language: 'typescript',
      },
      defaultResources: ['prompt:admin'],
    }),
    createResource({
      id: 'prompt:spa',
      type: 'prompt',
      enabledByDefault: false,
    }),
    createResource({
      id: 'prompt:admin',
      type: 'prompt',
      enabledByDefault: false,
    }),
    createResource({
      id: 'extension:element-plus',
      type: 'extension',
      enabledByDefault: true,
      copyPolicy: 'none',
      appliesTo: {
        uiLibrary: 'element-plus',
      },
      defaultResources: ['template:element-plus'],
    }),
    createResource({
      id: 'extension:z-legacy-ui',
      type: 'extension',
      enabledByDefault: true,
      copyPolicy: 'none',
      appliesTo: {
        framework: 'vue',
      },
      conflictsWith: {
        extensions: ['extension:element-plus'],
      },
      defaultResources: ['template:legacy-ui'],
    }),
    createResource({
      id: 'template:element-plus',
      type: 'template',
      enabledByDefault: false,
    }),
    createResource({
      id: 'template:legacy-ui',
      type: 'template',
      enabledByDefault: false,
    }),
  ];
}

/**
 * 创建测试资源。
 *
 * @param input 资源输入。
 * @returns Workspace 资源。
 */
function createResource(input: Partial<WorkspaceResource> & Pick<WorkspaceResource, 'id' | 'type'>): WorkspaceResource {
  return {
    id: input.id,
    type: input.type,
    version: input.version ?? '1.0.0',
    sourcePath: input.sourcePath ?? `${input.id}.md`,
    targetPath: input.targetPath ?? `.veaw/resources/${input.id}.md`,
    tags: input.tags ?? [input.type],
    dependencies: input.dependencies ?? [],
    enabledByDefault: input.enabledByDefault ?? false,
    copyPolicy: input.copyPolicy ?? 'copy',
    overwritePolicy: input.overwritePolicy ?? 'if-missing',
    hash: input.hash ?? 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    appliesTo: input.appliesTo,
    conflictsWith: input.conflictsWith,
    defaultResources: input.defaultResources,
  };
}

/**
 * 判断资源列表是否包含指定资源。
 *
 * @param resources 资源列表。
 * @param id 资源 id。
 * @returns 是否包含。
 */
function hasResource(resources: readonly WorkspaceResource[], id: string): boolean {
  return resources.some((resource) => resource.id === id);
}

/**
 * 查找资源选择决策。
 *
 * @param decisions 决策列表。
 * @param id 资源 id。
 * @returns 选择决策。
 */
function findDecision(
  decisions: readonly ResourceSelectionDecision[],
  id: string,
): ResourceSelectionDecision | undefined {
  return decisions.find((decision) => decision.id === id);
}
