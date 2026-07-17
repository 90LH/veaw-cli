import path from 'node:path';
import fs from 'fs-extra';
import { isRecord, readString, readStringArray } from './guards.js';
import { readResourceContents, selectResources } from './content.js';
import { renderTemplate } from './materializer.js';
import { readWorkspaceRegistry } from './registry.js';
import type { LoadedWorkspaceRegistry, WorkspaceLocation, WorkspaceResource } from './types.js';

/**
 * 当前支持的 Workspace command schema 版本。
 */
const SUPPORTED_COMMAND_SCHEMA_VERSION = '1.0.0';

/**
 * Workspace command 参数类型。
 */
type WorkspaceCommandParameterType = 'string' | 'boolean' | 'number';

/**
 * Workspace command 执行类型。
 */
export type WorkspaceCommandExecutionType = 'generate-prompt' | 'render-template' | 'call-workflow';

/**
 * Workspace command 参数值。
 */
export type WorkspaceCommandParameterValue = string | boolean | number;

/**
 * Workspace command 参数表。
 */
export type WorkspaceCommandParameterValues = Readonly<Record<string, WorkspaceCommandParameterValue>>;

/**
 * Workspace command 参数定义。
 */
export interface WorkspaceCommandParameterDefinition {
  /**
   * 参数类型。
   */
  readonly type: WorkspaceCommandParameterType;
  /**
   * 参数说明。
   */
  readonly description: string;
  /**
   * 默认值。
   */
  readonly default?: WorkspaceCommandParameterValue;
}

/**
 * Workspace command 参数 schema。
 */
export interface WorkspaceCommandParameterSchema {
  /**
   * 固定为 object。
   */
  readonly type: 'object';
  /**
   * 参数属性。
   */
  readonly properties: Readonly<Record<string, WorkspaceCommandParameterDefinition>>;
  /**
   * 必填参数。
   */
  readonly required: readonly string[];
}

/**
 * Workspace command 执行定义。
 */
export interface WorkspaceCommandExecution {
  /**
   * 执行类型。
   */
  readonly type: WorkspaceCommandExecutionType;
  /**
   * prompt 命令资源 id。
   */
  readonly resourceId?: string;
  /**
   * template 资源 id。
   */
  readonly templateId?: string;
  /**
   * workflow 资源 id。
   */
  readonly workflowId?: string;
  /**
   * 输出路径参数名。
   */
  readonly outputPathParameter?: string;
}

/**
 * Workspace command 定义。
 */
export interface WorkspaceCommandDefinition {
  /**
   * command 资源 id。
   */
  readonly id: string;
  /**
   * CLI 可调用名称。
   */
  readonly name: string;
  /**
   * command 描述。
   */
  readonly description: string;
  /**
   * command 版本。
   */
  readonly version: string;
  /**
   * 参数 schema。
   */
  readonly parameters: WorkspaceCommandParameterSchema;
  /**
   * 依赖资源 id。
   */
  readonly dependencies: readonly string[];
  /**
   * 安全声明式执行定义。
   */
  readonly execution: WorkspaceCommandExecution;
}

/**
 * Workspace command registry。
 */
export interface WorkspaceCommandRegistry {
  /**
   * command schema 版本。
   */
  readonly schemaVersion: string;
  /**
   * Workspace Registry。
   */
  readonly workspaceRegistry: LoadedWorkspaceRegistry;
  /**
   * command 定义。
   */
  readonly commands: readonly WorkspaceCommandDefinition[];
}

/**
 * Workspace command 执行结果。
 */
export interface WorkspaceCommandExecutionResult {
  /**
   * command 定义。
   */
  readonly command: WorkspaceCommandDefinition;
  /**
   * 生成内容。
   */
  readonly content: string;
}

/**
 * 读取 Workspace command registry。
 *
 * @param location Workspace 位置。
 * @returns Workspace command registry。
 */
export async function readWorkspaceCommandRegistry(location: WorkspaceLocation): Promise<WorkspaceCommandRegistry> {
  const workspaceRegistry = await readWorkspaceRegistry(location);
  const commandsRegistryPath = resolveCommandsRegistryPath(workspaceRegistry);

  if (commandsRegistryPath === undefined) {
    return {
      schemaVersion: SUPPORTED_COMMAND_SCHEMA_VERSION,
      workspaceRegistry,
      commands: [],
    };
  }

  const content = await readJsonObject(commandsRegistryPath);
  const commandsValue = content.commands;
  const commandSchemaVersion = readString(content, 'commandSchemaVersion');

  if (commandsValue === undefined) {
    return {
      schemaVersion: commandSchemaVersion ?? SUPPORTED_COMMAND_SCHEMA_VERSION,
      workspaceRegistry,
      commands: [],
    };
  }

  if (commandSchemaVersion !== SUPPORTED_COMMAND_SCHEMA_VERSION) {
    throw new Error(`Unsupported Workspace command schema version: ${commandSchemaVersion ?? 'unknown'}`);
  }

  const commands = readWorkspaceCommandDefinitions(commandsValue);

  validateWorkspaceCommandResources(workspaceRegistry.resources, commands);

  return {
    schemaVersion: commandSchemaVersion,
    workspaceRegistry,
    commands,
  };
}

/**
 * 按名称查找 Workspace command。
 *
 * @param registry Workspace command registry。
 * @param commandName command 名称或 id。
 * @returns command 定义。
 */
export function findWorkspaceCommand(
  registry: WorkspaceCommandRegistry,
  commandName: string,
): WorkspaceCommandDefinition | undefined {
  return registry.commands.find((command) => command.name === commandName || command.id === commandName);
}

/**
 * 解析并校验 Workspace command 参数。
 *
 * @param command command 定义。
 * @param args CLI 参数。
 * @returns 参数值。
 */
export function parseWorkspaceCommandArguments(
  command: WorkspaceCommandDefinition,
  args: readonly string[],
): WorkspaceCommandParameterValues {
  const values: Record<string, WorkspaceCommandParameterValue> = {};

  for (const [parameterName, definition] of Object.entries(command.parameters.properties)) {
    if (definition.default !== undefined) {
      values[parameterName] = definition.default;
    }
  }

  for (const arg of args) {
    const separatorIndex = arg.indexOf('=');

    if (separatorIndex <= 0) {
      throw new Error(`Invalid argument format: ${arg}. Expected key=value.`);
    }

    const key = arg.slice(0, separatorIndex);
    const rawValue = arg.slice(separatorIndex + 1);
    const definition = command.parameters.properties[key];

    if (definition === undefined) {
      throw new Error(`Unknown argument for ${command.name}: ${key}`);
    }

    values[key] = parseParameterValue(key, rawValue, definition.type);
  }

  for (const requiredKey of command.parameters.required) {
    if (values[requiredKey] === undefined) {
      throw new Error(`Missing required argument for ${command.name}: ${requiredKey}`);
    }
  }

  return values;
}

/**
 * 执行安全声明式 Workspace command。
 *
 * @param registry Workspace command registry。
 * @param command command 定义。
 * @param parameters 参数值。
 * @returns 执行结果。
 */
export async function executeWorkspaceCommand(
  registry: WorkspaceCommandRegistry,
  command: WorkspaceCommandDefinition,
  parameters: WorkspaceCommandParameterValues,
): Promise<WorkspaceCommandExecutionResult> {
  if (command.execution.type === 'generate-prompt') {
    return {
      command,
      content: await createPromptExecutionContent(registry, command, parameters),
    };
  }

  if (command.execution.type === 'render-template') {
    return {
      command,
      content: await createTemplateExecutionContent(registry, command, parameters),
    };
  }

  return {
    command,
    content: await createWorkflowExecutionContent(registry, command, parameters),
  };
}

/**
 * 解析 commands registry 路径。
 *
 * @param registry 已加载 Workspace Registry。
 * @returns commands registry 路径。
 */
function resolveCommandsRegistryPath(registry: LoadedWorkspaceRegistry): string | undefined {
  const commandsEntry = registry.registry.registries.find((entry) => entry.id === 'commands');

  if (commandsEntry === undefined || registry.location.registriesDirectory === undefined) {
    return undefined;
  }

  return path.join(registry.location.registriesDirectory, commandsEntry.path);
}

/**
 * 读取 JSON 对象。
 *
 * @param filePath 文件路径。
 * @returns JSON 对象。
 */
async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const content = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

  if (!isRecord(content)) {
    throw new Error(`JSON file is not an object: ${filePath}`);
  }

  return content;
}

/**
 * 读取 Workspace command 定义列表。
 *
 * @param value 原始值。
 * @returns command 定义列表。
 */
function readWorkspaceCommandDefinitions(value: unknown): readonly WorkspaceCommandDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid Workspace commands registry: commands must be an array.');
  }

  return value.map(readWorkspaceCommandDefinition);
}

/**
 * 读取 Workspace command 定义。
 *
 * @param value 原始值。
 * @returns command 定义。
 */
function readWorkspaceCommandDefinition(value: unknown): WorkspaceCommandDefinition {
  if (!isRecord(value)) {
    throw new Error('Invalid Workspace command definition.');
  }

  const id = readString(value, 'id');
  const name = readString(value, 'name');
  const description = readString(value, 'description');
  const version = readString(value, 'version');
  const parameters = readParameterSchema(value.parameters);
  const dependencies = readStringArray(value, 'dependencies');
  const execution = readCommandExecution(value.execution);

  if (
    id === undefined ||
    name === undefined ||
    description === undefined ||
    version === undefined ||
    parameters === undefined ||
    dependencies === undefined ||
    execution === undefined
  ) {
    throw new Error('Invalid Workspace command definition.');
  }

  return {
    id,
    name,
    description,
    version,
    parameters,
    dependencies,
    execution,
  };
}

/**
 * 读取参数 schema。
 *
 * @param value 原始值。
 * @returns 参数 schema。
 */
function readParameterSchema(value: unknown): WorkspaceCommandParameterSchema | undefined {
  if (!isRecord(value) || readString(value, 'type') !== 'object' || !isRecord(value.properties)) {
    return undefined;
  }

  const required = readStringArray(value, 'required');

  if (required === undefined) {
    return undefined;
  }

  const properties: Record<string, WorkspaceCommandParameterDefinition> = {};

  for (const [key, propertyValue] of Object.entries(value.properties)) {
    const property = readParameterDefinition(propertyValue);

    if (property === undefined) {
      return undefined;
    }

    properties[key] = property;
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

/**
 * 读取参数定义。
 *
 * @param value 原始值。
 * @returns 参数定义。
 */
function readParameterDefinition(value: unknown): WorkspaceCommandParameterDefinition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = readParameterType(value.type);
  const description = readString(value, 'description');

  if (type === undefined || description === undefined) {
    return undefined;
  }

  return {
    type,
    description,
    default: readParameterDefault(value.default, type),
  };
}

/**
 * 读取 command 执行定义。
 *
 * @param value 原始值。
 * @returns 执行定义。
 */
function readCommandExecution(value: unknown): WorkspaceCommandExecution | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = readExecutionType(value.type);

  if (type === undefined) {
    return undefined;
  }

  return {
    type,
    resourceId: readString(value, 'resourceId'),
    templateId: readString(value, 'templateId'),
    workflowId: readString(value, 'workflowId'),
    outputPathParameter: readString(value, 'outputPathParameter'),
  };
}

/**
 * 读取参数类型。
 *
 * @param value 原始值。
 * @returns 参数类型。
 */
function readParameterType(value: unknown): WorkspaceCommandParameterType | undefined {
  return value === 'string' || value === 'boolean' || value === 'number' ? value : undefined;
}

/**
 * 读取执行类型。
 *
 * @param value 原始值。
 * @returns 执行类型。
 */
function readExecutionType(value: unknown): WorkspaceCommandExecutionType | undefined {
  if (value === 'generate-prompt' || value === 'render-template' || value === 'call-workflow') {
    return value;
  }

  return undefined;
}

/**
 * 读取参数默认值。
 *
 * @param value 原始值。
 * @param type 参数类型。
 * @returns 默认值。
 */
function readParameterDefault(
  value: unknown,
  type: WorkspaceCommandParameterType,
): WorkspaceCommandParameterValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (type === 'string' && typeof value === 'string') {
    return value;
  }

  if (type === 'boolean' && typeof value === 'boolean') {
    return value;
  }

  if (type === 'number' && typeof value === 'number') {
    return value;
  }

  return undefined;
}

/**
 * 解析参数值。
 *
 * @param key 参数名。
 * @param rawValue 原始值。
 * @param type 参数类型。
 * @returns 参数值。
 */
function parseParameterValue(
  key: string,
  rawValue: string,
  type: WorkspaceCommandParameterType,
): WorkspaceCommandParameterValue {
  if (type === 'string') {
    return rawValue;
  }

  if (type === 'boolean') {
    if (rawValue === 'true') {
      return true;
    }

    if (rawValue === 'false') {
      return false;
    }

    throw new Error(`Invalid boolean argument ${key}: ${rawValue}`);
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number argument ${key}: ${rawValue}`);
  }

  return value;
}

/**
 * 校验 command 引用的资源是否存在。
 *
 * @param resources Registry 资源列表。
 * @param commands command 定义列表。
 */
function validateWorkspaceCommandResources(
  resources: readonly WorkspaceResource[],
  commands: readonly WorkspaceCommandDefinition[],
): void {
  const resourceIds = new Set(resources.map((resource) => resource.id));

  for (const command of commands) {
    const requiredResourceIds = [
      command.execution.resourceId,
      command.execution.templateId,
      command.execution.workflowId,
      ...command.dependencies,
    ].filter((resourceId): resourceId is string => resourceId !== undefined);

    for (const resourceId of requiredResourceIds) {
      if (!resourceIds.has(resourceId)) {
        throw new Error(`Workspace command ${command.name} references missing resource: ${resourceId}`);
      }
    }
  }
}

/**
 * 创建 prompt 执行内容。
 *
 * @param registry Workspace command registry。
 * @param command command 定义。
 * @param parameters 参数值。
 * @returns prompt 内容。
 */
async function createPromptExecutionContent(
  registry: WorkspaceCommandRegistry,
  command: WorkspaceCommandDefinition,
  parameters: WorkspaceCommandParameterValues,
): Promise<string> {
  const resourceId = requireExecutionResourceId(command, command.execution.resourceId, 'resourceId');
  const resources = await readResourceContents(registry.workspaceRegistry, {
    ids: [resourceId, ...command.dependencies],
    includeDependencies: true,
  });

  return [
    `# Workspace Command: ${command.name}`,
    '',
    command.description,
    '',
    '## Parameters',
    '',
    formatParameters(parameters),
    '',
    '## Command Definition',
    '',
    formatResourceContents(resources.filter((resource) => resource.resource.id === resourceId)),
    '',
    '## Dependency Resources',
    '',
    formatResourceContents(resources.filter((resource) => resource.resource.id !== resourceId)),
    '',
    '## Execution Boundary',
    '',
    '- This command only generates AI-ready input.',
    '- It does not execute shell commands or JavaScript.',
  ].join('\n');
}

/**
 * 创建模板渲染内容。
 *
 * @param registry Workspace command registry。
 * @param command command 定义。
 * @param parameters 参数值。
 * @returns 渲染内容。
 */
async function createTemplateExecutionContent(
  registry: WorkspaceCommandRegistry,
  command: WorkspaceCommandDefinition,
  parameters: WorkspaceCommandParameterValues,
): Promise<string> {
  const templateId = requireExecutionResourceId(command, command.execution.templateId, 'templateId');
  const resources = await readResourceContents(registry.workspaceRegistry, {
    ids: [templateId],
  });
  const template = resources[0];

  if (template === undefined) {
    throw new Error(`Workspace command ${command.name} references missing resource: ${templateId}`);
  }

  return renderTemplate(template.content, stringifyParameters(parameters));
}

/**
 * 创建 workflow 调用内容。
 *
 * @param registry Workspace command registry。
 * @param command command 定义。
 * @param parameters 参数值。
 * @returns workflow 输入内容。
 */
async function createWorkflowExecutionContent(
  registry: WorkspaceCommandRegistry,
  command: WorkspaceCommandDefinition,
  parameters: WorkspaceCommandParameterValues,
): Promise<string> {
  const workflowId = requireExecutionResourceId(command, command.execution.workflowId, 'workflowId');
  const workflowResources = selectResources(registry.workspaceRegistry.resources, {
    ids: [workflowId, ...command.dependencies],
    includeDependencies: true,
  });
  const contents = await readResourceContents(registry.workspaceRegistry, {
    ids: workflowResources.map((resource) => resource.id),
  });

  return [
    `# Workspace Workflow: ${command.name}`,
    '',
    '## Parameters',
    '',
    formatParameters(parameters),
    '',
    '## Workflow And Dependencies',
    '',
    formatResourceContents(contents),
  ].join('\n');
}

/**
 * 要求执行资源 id 存在。
 *
 * @param command command 定义。
 * @param resourceId 资源 id。
 * @param fieldName 字段名。
 * @returns 资源 id。
 */
function requireExecutionResourceId(
  command: WorkspaceCommandDefinition,
  resourceId: string | undefined,
  fieldName: string,
): string {
  if (resourceId === undefined) {
    throw new Error(`Workspace command ${command.name} execution is missing ${fieldName}.`);
  }

  return resourceId;
}

/**
 * 格式化参数。
 *
 * @param parameters 参数值。
 * @returns Markdown 内容。
 */
function formatParameters(parameters: WorkspaceCommandParameterValues): string {
  const entries = Object.entries(parameters);

  if (entries.length === 0) {
    return '- none';
  }

  return entries.map(([key, value]) => `- ${key}: ${String(value)}`).join('\n');
}

/**
 * 格式化资源内容。
 *
 * @param resources 资源内容。
 * @returns Markdown 内容。
 */
function formatResourceContents(resources: Awaited<ReturnType<typeof readResourceContents>>): string {
  if (resources.length === 0) {
    return '- none';
  }

  return resources
    .map((resource) =>
      [
        `### ${resource.resource.id}`,
        '',
        `- type: ${resource.resource.type}`,
        `- version: ${resource.resource.version}`,
        `- tags: ${resource.resource.tags.join(', ')}`,
        '',
        '```markdown',
        resource.content.trim(),
        '```',
      ].join('\n'),
    )
    .join('\n\n');
}

/**
 * 参数值转成模板变量。
 *
 * @param parameters 参数值。
 * @returns 模板变量。
 */
function stringifyParameters(parameters: WorkspaceCommandParameterValues): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(parameters)) {
    result[key] = String(value);
  }

  return result;
}
