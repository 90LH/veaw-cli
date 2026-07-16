import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { ensureDirectory, pathExists, readTextFile, writeTextFile } from '../utils/file.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/shell.js';

/**
 * 活动会话处理方式。
 */
type ActiveSessionChoice = 'continue' | 'end-and-start';

/**
 * 会话命令操作。
 */
type SessionCommandAction = 'start' | 'log' | 'end' | 'list';

/**
 * Git 快照。
 */
interface GitSnapshot {
  /**
   * 当前 Git 分支。
   */
  readonly branch: string;
  /**
   * 当前 Git commit。
   */
  readonly commit: string;
}

/**
 * 会话块定位结果。
 */
interface SessionBlock {
  /**
   * 块开始下标。
   */
  readonly startIndex: number;
  /**
   * 块结束下标。
   */
  readonly endIndex: number;
  /**
   * 块完整内容。
   */
  readonly content: string;
}

/**
 * 会话摘要。
 */
interface SessionSummary {
  /**
   * 会话标题。
   */
  readonly title: string;
  /**
   * 开始时间。
   */
  readonly startedAt: string;
  /**
   * 结束时间。
   */
  readonly endedAt: string;
  /**
   * 会话状态。
   */
  readonly status: string;
  /**
   * 会话总结。
   */
  readonly summary?: string;
}

/**
 * 启动会话选项。
 */
interface StartSessionOptions {
  /**
   * 已存在活动会话时的处理方式。
   */
  readonly activeSessionChoice?: ActiveSessionChoice;
}

/**
 * start 命令交互回答。
 */
interface ActiveSessionAnswer {
  /**
   * 用户选择的处理方式。
   */
  readonly action: ActiveSessionChoice;
}

/**
 * 会话日志上下文。
 */
interface SessionLogContext {
  /**
   * 项目根目录。
   */
  readonly targetDirectory: string;
  /**
   * .veaw 工作区目录。
   */
  readonly veawDirectory: string;
  /**
   * session-log.md 路径。
   */
  readonly sessionLogPath: string;
}

/**
 * VEAW 工作区目录名。
 */
const VEAW_DIRECTORY_NAME = '.veaw';

/**
 * session-log 文件名。
 */
const SESSION_LOG_FILE_NAME = 'session-log.md';

/**
 * 会话区域标题。
 */
const SESSIONS_SECTION_TITLE = '## Sessions';

/**
 * 会话块开始标记。
 */
const SESSION_START_MARKER = '<!-- VEAW_SESSION_START -->';

/**
 * 会话块结束标记。
 */
const SESSION_END_MARKER = '<!-- VEAW_SESSION_END -->';

/**
 * 空总结占位。
 */
const EMPTY_SUMMARY_TEXT = 'No summary yet.';

/**
 * 注册 session 命令。
 *
 * @param program Commander 主程序实例。
 */
export function registerSessionCommand(program: Command): void {
  const sessionCommand = program.command('session').description('Manage AI development session logs.');

  sessionCommand
    .command('start')
    .description('Start a new AI development session.')
    .argument('<title...>', 'Session title.')
    .action(async (titleParts: readonly string[]): Promise<void> => {
      await runSessionCommand('start', titleParts);
    });

  sessionCommand
    .command('log')
    .description('Append a log entry to the current session.')
    .argument('<content...>', 'Log content.')
    .action(async (contentParts: readonly string[]): Promise<void> => {
      await runSessionCommand('log', contentParts);
    });

  sessionCommand
    .command('end')
    .description('End the current session.')
    .argument('[summary...]', 'Optional session summary.')
    .action(async (summaryParts: readonly string[] | undefined): Promise<void> => {
      await runSessionCommand('end', summaryParts ?? []);
    });

  sessionCommand
    .command('list')
    .description('List session summaries.')
    .action(async (): Promise<void> => {
      await runSessionCommand('list', []);
    });
}

/**
 * 执行 session 命令。
 *
 * @param action 会话命令操作。
 * @param contentParts 命令内容片段。
 */
export async function runSessionCommand(
  action: SessionCommandAction,
  contentParts: readonly string[],
): Promise<void> {
  try {
    if (action === 'start') {
      await startSession(process.cwd(), normalizeRequiredText(contentParts, '会话标题不能为空'));
      return;
    }

    if (action === 'log') {
      await appendSessionLog(process.cwd(), normalizeRequiredText(contentParts, '会话记录不能为空'));
      return;
    }

    if (action === 'end') {
      await endSession(process.cwd(), normalizeOptionalText(contentParts));
      return;
    }

    const summaries = await listSessions(process.cwd());

    console.log(formatSessionSummaries(summaries));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`会话操作失败：${message}`);
    process.exitCode = 1;
  }
}

/**
 * 开始会话。
 *
 * @param targetDirectory 目标项目目录。
 * @param title 会话标题。
 * @param options 启动会话选项。
 */
export async function startSession(
  targetDirectory: string,
  title: string,
  options: StartSessionOptions = {},
): Promise<void> {
  const context = await createSessionLogContext(targetDirectory);
  const content = await readTextFile(context.sessionLogPath);
  const activeSession = findActiveSessionBlock(content);

  if (activeSession !== undefined) {
    const choice = options.activeSessionChoice ?? (await promptActiveSessionChoice());

    if (choice === 'continue') {
      logger.info('已继续当前未结束会话');
      return;
    }

    const endedContent = endSessionBlock(content, activeSession, undefined, createIsoTimestamp());

    await writeTextFile(context.sessionLogPath, endedContent);
  }

  const gitSnapshot = await readGitSnapshot(targetDirectory);
  const nextContent = appendSessionBlock(await readTextFile(context.sessionLogPath), {
    title,
    gitSnapshot,
    startedAt: createIsoTimestamp(),
  });

  await writeTextFile(context.sessionLogPath, nextContent);
  logger.success(`会话已开始：${title}`);
}

/**
 * 追加会话记录。
 *
 * @param targetDirectory 目标项目目录。
 * @param content 记录内容。
 */
export async function appendSessionLog(targetDirectory: string, content: string): Promise<void> {
  const context = await createSessionLogContext(targetDirectory);
  const currentContent = await readTextFile(context.sessionLogPath);
  const activeSession = findActiveSessionBlock(currentContent);

  if (activeSession === undefined) {
    throw new Error('没有活动会话，请先执行 veaw session start <title>');
  }

  const nextContent = replaceSessionBlock(
    currentContent,
    activeSession,
    appendLogEntryToBlock(activeSession.content, content, createIsoTimestamp()),
  );

  await writeTextFile(context.sessionLogPath, nextContent);
  logger.success('会话记录已追加');
}

/**
 * 结束当前会话。
 *
 * @param targetDirectory 目标项目目录。
 * @param summary 可选总结。
 */
export async function endSession(targetDirectory: string, summary: string | undefined): Promise<void> {
  const context = await createSessionLogContext(targetDirectory);
  const content = await readTextFile(context.sessionLogPath);
  const activeSession = findActiveSessionBlock(content);

  if (activeSession === undefined) {
    throw new Error('没有活动会话，请先执行 veaw session start <title>');
  }

  await writeTextFile(context.sessionLogPath, endSessionBlock(content, activeSession, summary, createIsoTimestamp()));
  logger.success('会话已结束');
}

/**
 * 列出会话摘要。
 *
 * @param targetDirectory 目标项目目录。
 * @returns 会话摘要列表。
 */
export async function listSessions(targetDirectory: string): Promise<readonly SessionSummary[]> {
  const context = await createSessionLogContext(targetDirectory);
  const content = await readTextFile(context.sessionLogPath);

  return readSessionBlocks(content).map(parseSessionSummary);
}

/**
 * 格式化会话摘要。
 *
 * @param summaries 会话摘要列表。
 * @returns Markdown 摘要。
 */
export function formatSessionSummaries(summaries: readonly SessionSummary[]): string {
  if (summaries.length === 0) {
    return '暂无会话记录。';
  }

  return summaries
    .map((summary, index) =>
      [
        `## ${index + 1}. ${summary.title}`,
        '',
        `- 开始时间：${summary.startedAt}`,
        `- 结束时间：${summary.endedAt}`,
        `- 状态：${summary.status}`,
        `- 总结：${summary.summary ?? '无'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/**
 * 创建 session-log 上下文，并确保文件存在。
 *
 * @param targetDirectory 目标项目目录。
 * @returns session-log 上下文。
 */
async function createSessionLogContext(targetDirectory: string): Promise<SessionLogContext> {
  const veawDirectory = path.join(targetDirectory, VEAW_DIRECTORY_NAME);
  const sessionLogPath = path.join(veawDirectory, SESSION_LOG_FILE_NAME);

  await ensureDirectory(veawDirectory);

  if (!(await pathExists(sessionLogPath))) {
    await writeTextFile(sessionLogPath, await readSessionLogTemplate());
    logger.success(`创建 ${path.relative(process.cwd(), sessionLogPath)}`);
  }

  return {
    targetDirectory,
    veawDirectory,
    sessionLogPath,
  };
}

/**
 * 读取 session-log 模板。
 *
 * @returns session-log 模板内容。
 */
async function readSessionLogTemplate(): Promise<string> {
  const assetsDirectory = await resolveAssetsDirectory();

  return readTextFile(path.join(assetsDirectory, SESSION_LOG_FILE_NAME));
}

/**
 * 解析内置 assets 目录。
 *
 * @returns 内置 assets 目录路径。
 */
async function resolveAssetsDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '..', '..', 'assets'),
    path.resolve(moduleDirectory, '..', 'assets'),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('未找到内置 assets 目录，无法创建 session-log.md');
}

/**
 * 追加会话块。
 *
 * @param content 当前 session-log 内容。
 * @param input 会话信息。
 * @returns 更新后的内容。
 */
function appendSessionBlock(
  content: string,
  input: { readonly title: string; readonly gitSnapshot: GitSnapshot; readonly startedAt: string },
): string {
  const baseContent = ensureSessionsSection(content);
  const block = createSessionBlock(input);

  return `${baseContent.trimEnd()}\n\n${block}\n`;
}

/**
 * 创建会话块。
 *
 * @param input 会话信息。
 * @returns 会话 Markdown 块。
 */
function createSessionBlock(input: {
  readonly title: string;
  readonly gitSnapshot: GitSnapshot;
  readonly startedAt: string;
}): string {
  return [
    SESSION_START_MARKER,
    `## Session: ${normalizeSingleLine(input.title)}`,
    '',
    '- Status: active',
    `- Started At: ${input.startedAt}`,
    '- Ended At: -',
    `- Git Branch: ${input.gitSnapshot.branch}`,
    `- Git Commit: ${input.gitSnapshot.commit}`,
    '',
    '### Logs',
    '',
    '### Summary',
    '',
    EMPTY_SUMMARY_TEXT,
    SESSION_END_MARKER,
  ].join('\n');
}

/**
 * 确保 session-log 有 Sessions 区域。
 *
 * @param content 当前内容。
 * @returns 包含 Sessions 区域的内容。
 */
function ensureSessionsSection(content: string): string {
  if (content.includes(SESSIONS_SECTION_TITLE)) {
    return content;
  }

  return `${content.trimEnd()}\n\n${SESSIONS_SECTION_TITLE}\n`;
}

/**
 * 追加日志到会话块。
 *
 * @param block 会话块。
 * @param content 日志内容。
 * @param timestamp 日志时间。
 * @returns 更新后的会话块。
 */
function appendLogEntryToBlock(block: string, content: string, timestamp: string): string {
  const entry = `- ${timestamp}\n\n${indentMarkdownBlock(content)}`;
  const summaryIndex = block.indexOf('\n### Summary');

  if (summaryIndex < 0) {
    return `${block.trimEnd()}\n\n${entry}\n`;
  }

  const beforeSummary = block.slice(0, summaryIndex).trimEnd();
  const afterSummary = block.slice(summaryIndex);

  return `${beforeSummary}\n\n${entry}${afterSummary}`;
}

/**
 * 结束会话块。
 *
 * @param content 当前 session-log 内容。
 * @param block 会话块。
 * @param summary 可选总结。
 * @param endedAt 结束时间。
 * @returns 更新后的 session-log 内容。
 */
function endSessionBlock(
  content: string,
  block: SessionBlock,
  summary: string | undefined,
  endedAt: string,
): string {
  const nextBlock = replaceSummary(
    block.content.replace('- Status: active', '- Status: ended').replace('- Ended At: -', `- Ended At: ${endedAt}`),
    summary,
  );

  return replaceSessionBlock(content, block, nextBlock);
}

/**
 * 替换会话总结。
 *
 * @param block 会话块。
 * @param summary 可选总结。
 * @returns 更新后的会话块。
 */
function replaceSummary(block: string, summary: string | undefined): string {
  if (summary === undefined || summary.trim().length === 0) {
    return block;
  }

  const summaryIndex = block.indexOf('\n### Summary');

  if (summaryIndex < 0) {
    return `${block.trimEnd()}\n\n### Summary\n\n${summary.trim()}`;
  }

  const summaryHeaderEnd = summaryIndex + '\n### Summary'.length;
  const markerIndex = block.indexOf(SESSION_END_MARKER, summaryHeaderEnd);

  if (markerIndex < 0) {
    return block;
  }

  const beforeSummary = block.slice(0, summaryHeaderEnd).trimEnd();
  const afterSummary = block.slice(markerIndex);

  return `${beforeSummary}\n\n${summary.trim()}\n${afterSummary}`;
}

/**
 * 替换 session-log 中的会话块。
 *
 * @param content 当前 session-log 内容。
 * @param block 原会话块。
 * @param nextBlock 新会话块。
 * @returns 更新后的 session-log 内容。
 */
function replaceSessionBlock(content: string, block: SessionBlock, nextBlock: string): string {
  return `${content.slice(0, block.startIndex)}${nextBlock}${content.slice(block.endIndex)}`;
}

/**
 * 查找当前活动会话块。
 *
 * @param content session-log 内容。
 * @returns 活动会话块。
 */
function findActiveSessionBlock(content: string): SessionBlock | undefined {
  return [...readSessionBlocks(content)]
    .reverse()
    .find((block) => readField(block.content, 'Status') === 'active');
}

/**
 * 读取所有会话块。
 *
 * @param content session-log 内容。
 * @returns 会话块列表。
 */
function readSessionBlocks(content: string): readonly SessionBlock[] {
  const blocks: SessionBlock[] = [];
  const blockRegex = new RegExp(`${escapeRegex(SESSION_START_MARKER)}[\\s\\S]*?${escapeRegex(SESSION_END_MARKER)}`, 'g');

  for (const match of content.matchAll(blockRegex)) {
    const blockContent = match[0];
    const startIndex = match.index;

    if (startIndex === undefined) {
      continue;
    }

    blocks.push({
      startIndex,
      endIndex: startIndex + blockContent.length,
      content: blockContent,
    });
  }

  return blocks;
}

/**
 * 解析会话摘要。
 *
 * @param block 会话块。
 * @returns 会话摘要。
 */
function parseSessionSummary(block: SessionBlock): SessionSummary {
  return {
    title: readSessionTitle(block.content),
    startedAt: readField(block.content, 'Started At') ?? 'Unknown',
    endedAt: readField(block.content, 'Ended At') ?? '-',
    status: readField(block.content, 'Status') ?? 'unknown',
    summary: readSummary(block.content),
  };
}

/**
 * 读取会话标题。
 *
 * @param block 会话块。
 * @returns 会话标题。
 */
function readSessionTitle(block: string): string {
  const match = /^## Session: (.+)$/m.exec(block);

  return match?.[1]?.trim() ?? 'Untitled';
}

/**
 * 读取字段。
 *
 * @param block 会话块。
 * @param fieldName 字段名。
 * @returns 字段值。
 */
function readField(block: string, fieldName: string): string | undefined {
  const match = new RegExp(`^- ${escapeRegex(fieldName)}: (.*)$`, 'm').exec(block);

  return match?.[1]?.trim();
}

/**
 * 读取会话总结。
 *
 * @param block 会话块。
 * @returns 会话总结。
 */
function readSummary(block: string): string | undefined {
  const summaryStart = block.indexOf('\n### Summary');

  if (summaryStart < 0) {
    return undefined;
  }

  const contentStart = summaryStart + '\n### Summary'.length;
  const markerIndex = block.indexOf(SESSION_END_MARKER, contentStart);
  const summary = block.slice(contentStart, markerIndex < 0 ? undefined : markerIndex).trim();

  if (summary.length === 0 || summary === EMPTY_SUMMARY_TEXT) {
    return undefined;
  }

  return summary;
}

/**
 * 读取 Git 快照。
 *
 * @param targetDirectory 目标项目目录。
 * @returns Git 快照。
 */
async function readGitSnapshot(targetDirectory: string): Promise<GitSnapshot> {
  return {
    branch: (await runGitCommand(targetDirectory, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'Unknown',
    commit: (await runGitCommand(targetDirectory, ['rev-parse', 'HEAD'])) ?? 'Unknown',
  };
}

/**
 * 执行 Git 命令。
 *
 * @param targetDirectory 目标项目目录。
 * @param args Git 参数。
 * @returns 命令输出。
 */
async function runGitCommand(targetDirectory: string, args: readonly string[]): Promise<string | undefined> {
  const originalCwd = process.cwd();

  try {
    process.chdir(targetDirectory);

    const result = await runCommand('git', args);

    return result.stdout.trim();
  } catch {
    return undefined;
  } finally {
    process.chdir(originalCwd);
  }
}

/**
 * 提示用户处理已有活动会话。
 *
 * @returns 活动会话处理方式。
 */
async function promptActiveSessionChoice(): Promise<ActiveSessionChoice> {
  const answer = await inquirer.prompt<ActiveSessionAnswer>([
    {
      type: 'list',
      name: 'action',
      message: '检测到已有未结束会话，请选择处理方式：',
      choices: [
        {
          name: '继续当前会话',
          value: 'continue',
        },
        {
          name: '结束当前会话后新建',
          value: 'end-and-start',
        },
      ],
    },
  ]);

  return answer.action;
}

/**
 * 标准化必填文本。
 *
 * @param parts 文本片段。
 * @param errorMessage 错误信息。
 * @returns 标准化文本。
 */
function normalizeRequiredText(parts: readonly string[], errorMessage: string): string {
  const text = normalizeOptionalText(parts);

  if (text === undefined) {
    throw new Error(errorMessage);
  }

  return text;
}

/**
 * 标准化可选文本。
 *
 * @param parts 文本片段。
 * @returns 标准化文本。
 */
function normalizeOptionalText(parts: readonly string[]): string | undefined {
  const text = parts.join(' ').trim();

  return text.length > 0 ? text : undefined;
}

/**
 * 标准化单行文本。
 *
 * @param value 原始文本。
 * @returns 单行文本。
 */
function normalizeSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

/**
 * 缩进 Markdown 块。
 *
 * @param content 原始内容。
 * @returns 缩进后的内容。
 */
function indentMarkdownBlock(content: string): string {
  return content
    .trim()
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * 创建 ISO 时间戳。
 *
 * @returns ISO 时间戳。
 */
function createIsoTimestamp(): string {
  return new Date().toISOString();
}

/**
 * 转义正则字符串。
 *
 * @param value 原始字符串。
 * @returns 转义后的字符串。
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
