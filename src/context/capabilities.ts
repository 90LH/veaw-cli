import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import type {
  ComponentCandidate,
  ComponentQueryResult,
  ContextEvidence,
  Degradation,
  DesignContext,
  ReviewFinding,
  ReviewResult,
  ScreenshotContext,
  TaskItem,
  TaskList,
  UiComponentContext,
} from './schemas.js';

type JsonRecord = Readonly<Record<string, unknown>>;

export interface ScreenshotContextInput {
  readonly projectDirectory: string;
  readonly screenshotPath?: string;
  readonly route?: string;
  readonly viewport?: string;
  readonly source?: 'user-provided' | 'local-test';
  readonly relatedComponents?: readonly string[];
}

export interface ComponentQueryInput {
  readonly projectDirectory: string;
  readonly query: string;
  readonly limit?: number;
}

export interface UiComponentContextInput extends ScreenshotContextInput {
  readonly requirement?: string;
  readonly query?: string;
  readonly enableMcp?: boolean;
  readonly mcpClient?: InternalComponentMcpClient;
}

export interface DesignContextInput extends UiComponentContextInput {
  readonly requirement: string;
}

export interface TaskListInput {
  readonly projectDirectory: string;
  readonly requirement: string;
  readonly planContent?: string;
  readonly designContext?: DesignContext;
}

export interface ReviewInput {
  readonly projectDirectory: string;
  readonly planContent?: string;
  readonly designContext?: DesignContext;
  readonly taskList?: TaskList;
  readonly uiComponentContext?: UiComponentContext;
}

export interface InternalComponentMcpQuery {
  readonly screenshot: ScreenshotContext;
  readonly requirement?: string;
  readonly localCandidates: readonly ComponentCandidate[];
}

export type InternalComponentMcpClient = (query: InternalComponentMcpQuery) => Promise<ComponentQueryResult>;

export interface InternalComponentMcpConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly toolName: string;
  readonly timeoutMs: number;
}

interface VeawContextFiles {
  readonly contextContent?: string;
  readonly projectJson?: JsonRecord;
  readonly catalogJson?: JsonRecord;
}

interface CatalogComponentRecord {
  readonly name: string;
  readonly filePath: string;
  readonly category?: string;
  readonly isShared?: boolean;
  readonly props: readonly string[];
  readonly emits: readonly string[];
  readonly slots: readonly string[];
  readonly dependencies: readonly string[];
  readonly usageHints: readonly string[];
}

interface JsonRpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export async function createScreenshotContext(input: ScreenshotContextInput): Promise<ScreenshotContext> {
  const generatedAt = new Date().toISOString();
  const relatedComponents = input.relatedComponents ?? [];

  if (input.screenshotPath === undefined || input.screenshotPath.trim() === '') {
    return {
      schema: 'screenshot-context',
      version: '1.0.0',
      generatedAt,
      available: false,
      route: input.route,
      viewport: input.viewport,
      source: 'missing',
      permission: 'not-provided',
      relatedComponents,
      observations: [],
      evidence: [],
      degradations: [createDegradation('SCREENSHOT_MISSING', '未提供用户显式截图或本地测试截图。', '继续使用本地 component catalog 和项目上下文。')],
    };
  }

  const resolvedPath = path.resolve(input.projectDirectory, input.screenshotPath);
  const reference = normalizePath(path.relative(input.projectDirectory, resolvedPath));

  if (!(await fs.pathExists(resolvedPath))) {
    return {
      schema: 'screenshot-context',
      version: '1.0.0',
      generatedAt,
      available: false,
      reference,
      route: input.route,
      viewport: input.viewport,
      source: 'missing',
      permission: 'explicit',
      relatedComponents,
      observations: [],
      evidence: [],
      degradations: [createDegradation('SCREENSHOT_NOT_FOUND', `截图文件不存在：${reference}`, '继续使用本地 component catalog 和项目上下文。')],
    };
  }

  return {
    schema: 'screenshot-context',
    version: '1.0.0',
    generatedAt,
    available: true,
    reference,
    route: input.route,
    viewport: input.viewport,
    source: input.source ?? 'user-provided',
    permission: 'explicit',
    relatedComponents,
    observations: [],
    evidence: [createEvidence('screenshot', reference, '截图文件由用户显式提供或本地测试生成；CLI 不上传截图。', 1)],
    degradations: [
      createDegradation(
        'SCREENSHOT_VISUAL_PARSER_UNAVAILABLE',
        '当前 CLI 不内置视觉解析器，未从截图像素推断结构。',
        '如启用内部组件库 MCP，则仅把截图引用和元数据交给已配置 MCP；否则使用本地 catalog。',
      ),
    ],
  };
}

export async function queryLocalComponents(input: ComponentQueryInput): Promise<ComponentQueryResult> {
  const files = await readVeawContextFiles(input.projectDirectory);
  const components = readCatalogComponents(files.catalogJson);
  const queryText = input.query.trim();
  const tokens = queryText.toLowerCase().split(/\s+/u).filter((token) => token.length > 0);
  const candidates = components
    .map((component) => ({ component, score: scoreComponent(component, tokens) }))
    .filter((entry) => tokens.length === 0 || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.component.name.localeCompare(right.component.name))
    .slice(0, input.limit ?? 8)
    .map((entry) => createCatalogCandidate(entry.component, queryText));

  return {
    schema: 'component-query-result',
    version: '1.0.0',
    query: queryText,
    candidates,
    evidence: files.catalogJson === undefined
      ? []
      : [createEvidence('catalog', '.veaw/component-catalog/catalog.json', `读取本地 catalog，共 ${components.length} 个组件。`, 1)],
    degradations: files.catalogJson === undefined
      ? [createDegradation('CATALOG_MISSING', '未读取到 .veaw/component-catalog/catalog.json。', '返回空组件查询结果，主流程继续。')]
      : [],
  };
}

export async function createUiComponentContext(input: UiComponentContextInput): Promise<UiComponentContext> {
  const screenshot = await createScreenshotContext(input);
  const initialLocalQuery = await queryLocalComponents({
    projectDirectory: input.projectDirectory,
    query: input.query ?? input.requirement ?? screenshot.relatedComponents.join(' '),
  });
  const localQuery = initialLocalQuery.candidates.length > 0
    ? initialLocalQuery
    : await queryLocalComponents({
      projectDirectory: input.projectDirectory,
      query: '',
    });
  const degradations: Degradation[] = [...screenshot.degradations, ...localQuery.degradations];

  if (initialLocalQuery.candidates.length === 0) {
    degradations.push(createDegradation('LOCAL_CATALOG_NO_DIRECT_MATCH', '本地 catalog 未按查询词命中组件，已降级返回共享组件候选。', '继续以共享组件作为保守复用参考。'));
  }
  let mcpResult: ComponentQueryResult | undefined;

  if (input.enableMcp === true && !screenshot.available) {
    degradations.push(createDegradation('MCP_SKIPPED_SCREENSHOT_MISSING', '截图缺失，已跳过内部组件库 MCP 调用。', '仅使用本地 component catalog 查询结果。'));
  } else if (input.enableMcp === true) {
    try {
      const client = input.mcpClient ?? (await createConfiguredInternalComponentMcpClient(input.projectDirectory));
      mcpResult = await client({
        screenshot,
        requirement: input.requirement,
        localCandidates: localQuery.candidates,
      });
      degradations.push(...mcpResult.degradations);
    } catch (error: unknown) {
      degradations.push(createDegradation('MCP_CALL_FAILED', toErrorMessage(error), '仅使用本地 component catalog 查询结果。'));
    }
  } else {
    degradations.push(createDegradation('MCP_NOT_ENABLED', '未显式启用内部组件库 MCP。', '仅使用本地 component catalog 查询结果。'));
  }

  const candidates = mergeCandidates(localQuery.candidates, mcpResult?.candidates ?? []);

  return {
    schema: 'ui-component-context',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    screenshot,
    candidates,
    risks: createUiComponentRisks(screenshot, candidates, mcpResult),
    uncertainties: createUiComponentUncertainties(screenshot, candidates),
    alternatives: candidates.length === 0
      ? ['优先使用 Naive UI 基础控件和项目既有页面模式，避免引入未经确认的内部组件 API。']
      : ['项目 catalog 组件优先，内部组件库候选仅作为补充并需按证据确认 API。'],
    degradations,
  };
}

export async function createDesignContext(input: DesignContextInput): Promise<DesignContext> {
  const files = await readVeawContextFiles(input.projectDirectory);
  const projectSummary = readProjectSummary(files.projectJson);
  const uiComponentContext = await createUiComponentContext(input);
  const evidence: ContextEvidence[] = [
    ...uiComponentContext.screenshot.evidence,
    ...uiComponentContext.candidates.flatMap((candidate) => candidate.evidence),
  ];

  if (files.contextContent !== undefined) {
    evidence.push(createEvidence('context', '.veaw/context.md', '读取项目上下文约束。', 1));
  }

  return {
    schema: 'design-context',
    version: '1.0.0',
    requirement: input.requirement,
    layout: [
      '按现有后台页面结构组织内容区，优先复用项目布局和 Naive UI 容器控件。',
      uiComponentContext.screenshot.available ? '截图仅作为用户显式输入的视觉参考；未确认的像素细节不得写成事实。' : '未提供截图，布局需从同类页面源码继续确认。',
    ],
    interactions: ['覆盖加载、空数据、错误态和主要操作反馈；具体事件名以组件 catalog 或 MCP 证据为准。'],
    responsive: ['保持桌面管理端可扫描布局；移动或窄屏规则需从现有页面或需求确认。'],
    componentReuse: uiComponentContext.candidates,
    constraints: [
      `UI 库：${formatList(projectSummary.uiLibraries, '未确认')}`,
      `路由目录：${formatList(projectSummary.routerDirectories, '未确认')}`,
      `状态目录：${formatList(projectSummary.stateDirectories, '未确认')}`,
      `Service/API 目录：${formatList([...projectSummary.serviceDirectories, ...projectSummary.apiDirectories], '未确认')}`,
      '不绕过项目既有 Naive UI 和本地组件体系。',
    ],
    uncertainties: [
      ...uiComponentContext.uncertainties,
      '新页面名称、路由路径、菜单/权限字段仍需项目维护者确认。',
    ],
    evidence,
    degradations: uiComponentContext.degradations,
  };
}

export async function createTaskList(input: TaskListInput): Promise<TaskList> {
  const files = await readVeawContextFiles(input.projectDirectory);
  const projectSummary = readProjectSummary(files.projectJson);
  const servicePath = first([...projectSummary.serviceDirectories, ...projectSummary.apiDirectories], 'src/service');
  const routePath = first(projectSummary.routerDirectories, 'src/router');
  const storePath = first(projectSummary.stateDirectories, 'src/store');
  const featurePlaceholder = '<feature>';
  const tasks: TaskItem[] = [
    createTask(1, '确认同类页面和约定', [routePath, storePath, servicePath], [], ['只读查看同类页面、路由、store、service 文件'], '记录已确认入口和待确认字段。', ['上下文不足时不得编造菜单/权限字段。']),
    createTask(2, '定义接口与类型', [`${servicePath}/${featurePlaceholder}.ts`], ['任务 1'], ['pnpm run typecheck'], '请求参数和响应类型明确，未使用 any。', ['接口字段需以真实后端契约或现有 service 为准。']),
    createTask(3, '实现状态或 composable', [`${storePath}/modules/${featurePlaceholder}.ts`], ['任务 1', '任务 2'], ['pnpm run typecheck'], '跨组件状态放入 store，页面内逻辑优先 composable。', ['若只是页面局部状态，可不新增 store。']),
    createTask(4, '实现业务页面 UI', [`src/views/${featurePlaceholder}/index.vue`], ['任务 2', '任务 3'], ['pnpm run typecheck'], '页面复用已确认组件并覆盖加载、空、错状态。', input.designContext?.uncertainties ?? ['缺少 design-context，布局需人工确认。']),
    createTask(5, '注册路由并验证', [routePath], ['任务 4'], ['pnpm run typecheck', 'pnpm run lint', 'pnpm run build'], '页面可访问，路由、权限和菜单配置与项目约定一致。', ['路由元信息必须从源码确认后再填写。']),
  ];

  return {
    schema: 'task-list',
    version: '1.0.0',
    requirement: input.requirement,
    tasks,
    degradations: input.planContent === undefined
      ? [createDegradation('PLAN_CONTENT_MISSING', '未提供实施计划内容。', '基于项目上下文和 design-context 生成保守任务。')]
      : [],
  };
}

export async function createReviewResult(input: ReviewInput): Promise<ReviewResult> {
  const findings: ReviewFinding[] = [];
  const files = await readVeawContextFiles(input.projectDirectory);
  const catalogComponents = readCatalogComponents(files.catalogJson);
  const catalogByReference = new Map(catalogComponents.map((component) => [component.filePath, component]));
  const textArtifacts = [input.planContent, stringifyOptional(input.designContext), stringifyOptional(input.taskList), stringifyOptional(input.uiComponentContext)]
    .filter((content): content is string => content !== undefined);

  if (textArtifacts.some((content) => /\bany\b/u.test(content))) {
    findings.push(createFinding('error', '发现 any 风险', ['输入计划或上下文包含 `any`。'], '改用 unknown 或明确类型，并在任务中加入 typecheck 验证。'));
  }

  for (const task of input.taskList?.tasks ?? []) {
    for (const filePath of task.files) {
      if (filePath.includes('<')) {
        findings.push(createFinding('warning', '存在占位文件路径', [filePath], '在进入实现前确认 feature 名称和真实路径。'));
        continue;
      }

      if (!(await fs.pathExists(path.resolve(input.projectDirectory, filePath)))) {
        findings.push(createFinding('info', '引用文件当前不存在', [filePath], '若该文件是新增目标可保留；若是既有入口，需先确认真实路径。'));
      }
    }
  }

  for (const candidate of collectCandidates(input)) {
    if (candidate.source !== 'catalog') {
      continue;
    }

    const catalogComponent = catalogByReference.get(candidate.reference);

    if (catalogComponent === undefined) {
      findings.push(createFinding('error', 'catalog 组件引用不存在', [candidate.reference], '删除该候选或重新从 catalog 查询。'));
      continue;
    }

    if (!hasSameMembers(candidate.api.props, catalogComponent.props)) {
      findings.push(createFinding('error', '组件 Props 与 catalog 不一致', [candidate.reference], '以 catalog 中的 props 证据为准修正组件 API。'));
    }
  }

  if (textArtifacts.some((content) => /\.veaw\//u.test(content) && /write|写入|output/iu.test(content))) {
    findings.push(createFinding('warning', '可能包含 .veaw 写入建议', ['生成内容提到 .veaw 写入相关描述。'], '默认流程保持 stdout-only，只有显式 --output 才写文件。'));
  }

  return {
    schema: 'review-result',
    version: '1.0.0',
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
    residualRisks: findings.length === 0
      ? ['未执行真实业务源码编译；截图像素级结构仍需人工或已配置 MCP 进一步确认。']
      : ['修复 findings 后仍需执行 typecheck/lint/build 和页面人工验收。'],
    testGaps: ['当前 review 仅校验已提供上下文和本地 catalog 证据，不替代完整单元测试或 E2E。'],
  };
}

export async function writeExplicitOutput(projectDirectory: string, output: string | undefined, content: string): Promise<string | undefined> {
  if (output === undefined) {
    return undefined;
  }

  const outputPath = path.resolve(projectDirectory, output);

  if (await fs.pathExists(outputPath)) {
    throw new Error(`输出文件已存在，已拒绝覆盖：${normalizePath(path.relative(projectDirectory, outputPath))}`);
  }

  await fs.ensureDir(path.dirname(outputPath));
  await fs.outputFile(outputPath, content);

  return outputPath;
}

export function formatJsonOutput(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}

export function parseDesignContext(content: string): DesignContext | undefined {
  const value = parseJson(content);

  return isRecord(value) && value.schema === 'design-context' ? value as unknown as DesignContext : undefined;
}

export function parseTaskList(content: string): TaskList | undefined {
  const value = parseJson(content);

  return isRecord(value) && value.schema === 'task-list' ? value as unknown as TaskList : undefined;
}

export function parseUiComponentContext(content: string): UiComponentContext | undefined {
  const value = parseJson(content);

  return isRecord(value) && value.schema === 'ui-component-context' ? value as unknown as UiComponentContext : undefined;
}

export async function readOptionalProjectFile(projectDirectory: string, filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined) {
    return undefined;
  }

  const absolutePath = path.resolve(projectDirectory, filePath);

  if (!(await fs.pathExists(absolutePath))) {
    return undefined;
  }

  return fs.readFile(absolutePath, 'utf8');
}

export function createInternalComponentMcpClient(config: InternalComponentMcpConfig): InternalComponentMcpClient {
  return async (query: InternalComponentMcpQuery): Promise<ComponentQueryResult> => callMcpServer(config, query);
}

async function createConfiguredInternalComponentMcpClient(projectDirectory: string): Promise<InternalComponentMcpClient> {
  const config = await readInternalComponentMcpConfig(projectDirectory);

  if (config === undefined) {
    throw new Error('未配置内部组件库 MCP。请在 .veaw/config.json 的 internalComponentMcp 或环境变量 VEAW_COMPONENT_MCP_COMMAND 中配置，并显式传入 --enable-mcp。');
  }

  return createInternalComponentMcpClient(config);
}

async function readInternalComponentMcpConfig(projectDirectory: string): Promise<InternalComponentMcpConfig | undefined> {
  const configPath = path.join(projectDirectory, '.veaw', 'config.json');
  const config = (await fs.pathExists(configPath)) ? parseJson(await fs.readFile(configPath, 'utf8')) : undefined;
  const mcpConfig = isRecord(config) && isRecord(config.internalComponentMcp) ? config.internalComponentMcp : undefined;
  const command = readString(mcpConfig, 'command') ?? process.env.VEAW_COMPONENT_MCP_COMMAND;

  if (command === undefined || command.trim() === '') {
    return undefined;
  }

  return {
    command,
    args: readStringArray(mcpConfig, 'args') ?? splitEnvArgs(process.env.VEAW_COMPONENT_MCP_ARGS),
    toolName: readString(mcpConfig, 'toolName') ?? process.env.VEAW_COMPONENT_MCP_TOOL ?? 'query_internal_components',
    timeoutMs: readNumber(mcpConfig, 'timeoutMs') ?? readEnvNumber(process.env.VEAW_COMPONENT_MCP_TIMEOUT_MS) ?? 5000,
  };
}

async function callMcpServer(config: InternalComponentMcpConfig, query: InternalComponentMcpQuery): Promise<ComponentQueryResult> {
  const discoveryMessages = [
    createJsonRpcMessage(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'veaw-cli', version: '0.1.0' },
    }),
    createJsonRpcNotification('notifications/initialized', {}),
    createJsonRpcMessage(2, 'tools/list', {}),
  ];
  const discoveryOutput = await runStdioJsonRpc(config, discoveryMessages.map(encodeMcpMessage).join(''));
  const discoveryResponses = parseMcpMessages(discoveryOutput);
  const toolNames = readMcpToolNames(discoveryResponses.find((message) => message.id === 2)?.result);

  if (!toolNames.includes(config.toolName)) {
    return createMcpDegradedResult('MCP_TOOL_UNAVAILABLE', `内部组件库 MCP 未确认可用工具：${config.toolName}`, query.requirement ?? '');
  }

  const callMessages = [
    createJsonRpcMessage(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'veaw-cli', version: '0.1.0' },
    }),
    createJsonRpcNotification('notifications/initialized', {}),
    createJsonRpcMessage(3, 'tools/call', {
      name: config.toolName,
      arguments: {
        screenshot: query.screenshot,
        requirement: query.requirement,
        localCandidates: query.localCandidates,
      },
    }),
  ];
  const output = await runStdioJsonRpc(config, callMessages.map(encodeMcpMessage).join(''));
  const responses = parseMcpMessages(output);
  const callResponse = responses.find((message) => message.id === 3);

  if (callResponse === undefined) {
    return createMcpDegradedResult('MCP_EMPTY_RESPONSE', '内部组件库 MCP 未返回 tools/call 响应。', query.requirement ?? '');
  }

  if (callResponse.error !== undefined) {
    return createMcpDegradedResult('MCP_ERROR_RESPONSE', '内部组件库 MCP 返回错误，已隐藏错误详情以避免泄露敏感信息。', query.requirement ?? '');
  }

  const candidates = readMcpCandidates(callResponse.result);

  return {
    schema: 'component-query-result',
    version: '1.0.0',
    query: query.requirement ?? '',
    candidates,
    evidence: candidates.flatMap((candidate) => candidate.evidence),
    degradations: candidates.length === 0 ? [createDegradation('MCP_EMPTY_RESULT', '内部组件库 MCP 未返回候选组件。', '继续使用本地 component catalog。')] : [],
  };
}

function runStdioJsonRpc(config: InternalComponentMcpConfig, input: string): Promise<string> {
  return new Promise((resolve, reject): void => {
    const child = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeout = setTimeout((): void => {
      child.kill();
      reject(new Error('内部组件库 MCP 调用超时。'));
    }, config.timeoutMs);

    child.stdout.on('data', (chunk: Buffer): void => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer): void => {
      stderrChunks.push(chunk);
    });
    child.on('error', (error: Error): void => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code: number | null): void => {
      clearTimeout(timeout);

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

        reject(new Error(stderr.length > 0 ? `内部组件库 MCP 退出码 ${code ?? 'unknown'}。` : `内部组件库 MCP 调用失败：${code ?? 'unknown'}`));
        return;
      }

      resolve(Buffer.concat(stdoutChunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

async function readVeawContextFiles(projectDirectory: string): Promise<VeawContextFiles> {
  const veawDirectory = path.join(projectDirectory, '.veaw');

  return {
    contextContent: await readOptionalText(path.join(veawDirectory, 'context.md')),
    projectJson: parseJsonRecord(await readOptionalText(path.join(veawDirectory, 'project.json'))),
    catalogJson: parseJsonRecord(await readOptionalText(path.join(veawDirectory, 'component-catalog', 'catalog.json'))),
  };
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  if (!(await fs.pathExists(filePath))) {
    return undefined;
  }

  return fs.readFile(filePath, 'utf8');
}

function readCatalogComponents(catalogJson: JsonRecord | undefined): readonly CatalogComponentRecord[] {
  const components = isRecord(catalogJson) && Array.isArray(catalogJson.components) ? catalogJson.components : [];

  return components.filter(isRecord).map(readCatalogComponent).filter((component): component is CatalogComponentRecord => component !== undefined);
}

function readCatalogComponent(component: JsonRecord): CatalogComponentRecord | undefined {
  const name = readString(component, 'name');
  const filePath = readString(component, 'filePath');

  if (name === undefined || filePath === undefined) {
    return undefined;
  }

  return {
    name,
    filePath,
    category: readString(component, 'category') ?? readString(component, 'componentKind'),
    isShared: readBoolean(component, 'isShared'),
    props: readNamedArray(component, 'props'),
    emits: readNamedArray(component, 'emits'),
    slots: readNamedArray(component, 'slots'),
    dependencies: readDependencies(component),
    usageHints: readStringArray(component, 'usageHints') ?? [],
  };
}

function readNamedArray(record: JsonRecord, key: string): readonly string[] {
  const value = record[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((item) => readString(item, 'name')).filter((name): name is string => name !== undefined);
}

function readDependencies(record: JsonRecord): readonly string[] {
  const value = record.dependencies;

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((item) => readString(item, 'resolvedPath') ?? readString(item, 'source')).filter((source): source is string => source !== undefined);
}

function scoreComponent(component: CatalogComponentRecord, tokens: readonly string[]): number {
  if (tokens.length === 0) {
    if (component.isShared === true || component.filePath.startsWith('src/components/')) {
      return 3;
    }

    if (component.filePath.startsWith('src/layouts/')) {
      return 2;
    }

    return 1;
  }

  const haystack = [component.name, component.filePath, component.category, ...component.props, ...component.emits, ...component.slots, ...component.usageHints]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLowerCase();

  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function createCatalogCandidate(component: CatalogComponentRecord, query: string): ComponentCandidate {
  return {
    name: component.name,
    source: 'catalog',
    reference: component.filePath,
    category: component.category,
    isShared: component.isShared,
    api: {
      props: component.props,
      emits: component.emits,
      slots: component.slots,
    },
    examples: [],
    dependencies: component.dependencies,
    usageHints: component.usageHints,
    matchReason: query.length === 0 ? '无查询词时按 catalog 路径优先级返回候选，优先项目组件。' : `与查询词“${query}”匹配。`,
    evidence: [createEvidence('catalog', component.filePath, `本地 catalog 组件 ${component.name}。`, 1)],
  };
}

function mergeCandidates(localCandidates: readonly ComponentCandidate[], mcpCandidates: readonly ComponentCandidate[]): readonly ComponentCandidate[] {
  const result: ComponentCandidate[] = [...localCandidates];
  const keys = new Set(result.map((candidate) => candidate.name.toLowerCase()));

  for (const candidate of mcpCandidates) {
    const key = candidate.name.toLowerCase();

    if (keys.has(key)) {
      continue;
    }

    result.push(candidate);
    keys.add(key);
  }

  return result;
}

function createUiComponentRisks(screenshot: ScreenshotContext, candidates: readonly ComponentCandidate[], mcpResult: ComponentQueryResult | undefined): readonly string[] {
  const risks: string[] = [];

  if (!screenshot.available) {
    risks.push('缺少截图，无法校验视觉结构与组件匹配。');
  }

  if (mcpResult === undefined) {
    risks.push('内部组件库 MCP 未参与，内部库候选不可确认。');
  }

  if (candidates.length === 0) {
    risks.push('本地 catalog 与 MCP 均未返回候选组件。');
  }

  return risks;
}

function createUiComponentUncertainties(screenshot: ScreenshotContext, candidates: readonly ComponentCandidate[]): readonly string[] {
  const uncertainties: string[] = [];

  if (screenshot.observations.length === 0) {
    uncertainties.push('当前未从截图提取布局、控件、层级、状态、尺寸或间距事实。');
  }

  if (!candidates.some((candidate) => candidate.source === 'catalog')) {
    uncertainties.push('未找到可确认的项目已有组件候选。');
  }

  return uncertainties;
}

function readProjectSummary(projectJson: JsonRecord | undefined): {
  readonly uiLibraries: readonly string[];
  readonly routerDirectories: readonly string[];
  readonly stateDirectories: readonly string[];
  readonly apiDirectories: readonly string[];
  readonly serviceDirectories: readonly string[];
} {
  const insights = isRecord(projectJson?.projectInsights) ? projectJson.projectInsights : undefined;

  return {
    uiLibraries: readStringArray(insights, 'uiLibraries') ?? [],
    routerDirectories: readStringArray(readRecord(insights, 'router'), 'directories') ?? [],
    stateDirectories: readStringArray(readRecord(insights, 'stateManagement'), 'directories') ?? [],
    apiDirectories: readStringArray(readRecord(insights, 'apiDirectories'), 'paths') ?? [],
    serviceDirectories: readStringArray(readRecord(insights, 'serviceDirectories'), 'paths') ?? [],
  };
}

function createTask(order: number, goal: string, files: readonly string[], dependencies: readonly string[], verification: readonly string[], doneDefinition: string, risks: readonly string[]): TaskItem {
  return {
    order,
    goal,
    files,
    dependencies,
    verification,
    doneDefinition,
    risks,
  };
}

function collectCandidates(input: ReviewInput): readonly ComponentCandidate[] {
  return [
    ...(input.designContext?.componentReuse ?? []),
    ...(input.uiComponentContext?.candidates ?? []),
  ];
}

function readMcpCandidates(result: unknown): readonly ComponentCandidate[] {
  const payload = unwrapMcpPayload(result);
  const candidates = isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates : [];

  return candidates.filter(isRecord).map(readMcpCandidate).filter((candidate): candidate is ComponentCandidate => candidate !== undefined);
}

function readMcpToolNames(result: unknown): readonly string[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    return [];
  }

  return result.tools.filter(isRecord).map((tool) => readString(tool, 'name')).filter((name): name is string => name !== undefined);
}

function unwrapMcpPayload(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }

  if (Array.isArray(result.content)) {
    const textContent = result.content.filter(isMcpTextContent).map((item) => item.text).join('\n').trim();
    const parsed = parseJson(textContent);

    return parsed ?? result;
  }

  return result;
}

function readMcpCandidate(record: JsonRecord): ComponentCandidate | undefined {
  const name = readString(record, 'name');

  if (name === undefined) {
    return undefined;
  }

  const reference = readString(record, 'reference') ?? `mcp:${name}`;
  const apiRecord = readRecord(record, 'api');

  return {
    name,
    source: 'mcp',
    reference,
    category: readString(record, 'category'),
    api: {
      props: readStringArray(apiRecord, 'props') ?? readStringArray(record, 'props') ?? [],
      emits: readStringArray(apiRecord, 'emits') ?? readStringArray(record, 'emits') ?? [],
      slots: readStringArray(apiRecord, 'slots') ?? readStringArray(record, 'slots') ?? [],
    },
    examples: readStringArray(record, 'examples') ?? [],
    dependencies: readStringArray(record, 'dependencies') ?? [],
    usageHints: readStringArray(record, 'usageHints') ?? [],
    matchReason: readString(record, 'matchReason') ?? '内部组件库 MCP 返回候选。',
    evidence: [createEvidence('mcp', reference, `内部组件库 MCP 候选 ${name}。`, readNumber(record, 'confidence') ?? 0.6)],
  };
}

function createMcpDegradedResult(code: string, reason: string, query: string): ComponentQueryResult {
  return {
    schema: 'component-query-result',
    version: '1.0.0',
    query,
    candidates: [],
    evidence: [],
    degradations: [createDegradation(code, reason, '继续使用本地 component catalog。')],
  };
}

function parseMcpMessages(output: string): readonly JsonRpcMessage[] {
  const framed = parseContentLengthMessages(output);

  if (framed.length > 0) {
    return framed;
  }

  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseJson)
    .filter(isJsonRpcMessage);
}

function parseContentLengthMessages(output: string): readonly JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  let cursor = 0;

  while (cursor < output.length) {
    const headerEnd = output.indexOf('\r\n\r\n', cursor);

    if (headerEnd === -1) {
      break;
    }

    const header = output.slice(cursor, headerEnd);
    const lengthMatch = /Content-Length:\s*(\d+)/iu.exec(header);

    if (lengthMatch?.[1] === undefined) {
      break;
    }

    const length = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const body = output.slice(bodyStart, bodyStart + length);
    const parsed = parseJson(body);

    if (isJsonRpcMessage(parsed)) {
      messages.push(parsed);
    }

    cursor = bodyStart + length;
  }

  return messages;
}

function encodeMcpMessage(message: unknown): string {
  const body = JSON.stringify(message);

  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function createJsonRpcMessage(id: number, method: string, params: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

function createJsonRpcNotification(method: string, params: unknown): unknown {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

function createEvidence(source: ContextEvidence['source'], ref: string, note: string, confidence: number): ContextEvidence {
  return {
    source,
    ref,
    note,
    confidence,
  };
}

function createDegradation(code: string, reason: string, fallback: string): Degradation {
  return {
    code,
    reason,
    fallback,
  };
}

function createFinding(severity: ReviewFinding['severity'], title: string, evidence: readonly string[], recommendation: string): ReviewFinding {
  return {
    severity,
    title,
    evidence,
    recommendation,
  };
}

function parseJsonRecord(content: string | undefined): JsonRecord | undefined {
  const parsed = content === undefined ? undefined : parseJson(content);

  return isRecord(parsed) ? parsed : undefined;
}

function parseJson(content: string | undefined): unknown | undefined {
  if (content === undefined || content.trim() === '') {
    return undefined;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function readString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === 'string' ? value : undefined;
}

function readBoolean(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];

  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(record: JsonRecord | undefined, key: string): readonly string[] | undefined {
  const value = record?.[key];

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return undefined;
  }

  return value;
}

function readRecord(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];

  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && (typeof value.id === 'number' || value.result !== undefined || value.error !== undefined);
}

function isMcpTextContent(value: unknown): value is McpTextContent {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function hasSameMembers(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort((a, b) => a.localeCompare(b));
  const rightSorted = [...right].sort((a, b) => a.localeCompare(b));

  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
}

function first(values: readonly string[], fallback: string): string {
  return values[0] ?? fallback;
}

function formatList(values: readonly string[], fallback: string): string {
  return values.length > 0 ? values.join('、') : fallback;
}

function stringifyOptional(value: unknown | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

function splitEnvArgs(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }

  return value.split(' ').map((item) => item.trim()).filter((item) => item.length > 0);
}

function readEnvNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/gu, '/');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
