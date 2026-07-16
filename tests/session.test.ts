import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  appendSessionLog,
  endSession,
  formatSessionSummaries,
  listSessions,
  startSession,
} from '../src/commands/session.js';

/**
 * 测试临时目录列表。
 */
const temporaryDirectories: string[] = [];

afterEach(async (): Promise<void> => {
  const directories = temporaryDirectories.splice(0);

  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('session lifecycle', (): void => {
  it('creates session-log from template and records start metadata', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await startSession(projectDirectory, '新增 ask 命令');

    const sessionLog = await readSessionLog(projectDirectory);

    assert.match(sessionLog, /# Session Log/);
    assert.match(sessionLog, /## Session: 新增 ask 命令/);
    assert.match(sessionLog, /- Status: active/);
    assert.match(sessionLog, /- Started At: /);
    assert.match(sessionLog, /- Git Branch: /);
    assert.match(sessionLog, /- Git Commit: /);
  });

  it('appends logs and ends active session with summary', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await startSession(projectDirectory, '实现 session');
    await appendSessionLog(projectDirectory, '完成 start 和 log 子命令');
    await endSession(projectDirectory, '会话功能完成');

    const sessionLog = await readSessionLog(projectDirectory);
    const summaries = await listSessions(projectDirectory);

    assert.match(sessionLog, /完成 start 和 log 子命令/);
    assert.match(sessionLog, /- Status: ended/);
    assert.match(sessionLog, /- Ended At: /);
    assert.match(sessionLog, /会话功能完成/);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.title, '实现 session');
    assert.equal(summaries[0]?.status, 'ended');
    assert.equal(summaries[0]?.summary, '会话功能完成');
  });

  it('throws when logging without active session', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await assert.rejects(
      () => appendSessionLog(projectDirectory, '没有活动会话'),
      /veaw session start <title>/,
    );
  });

  it('continues current session when active session exists and user chooses continue', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await startSession(projectDirectory, '第一轮会话');
    await startSession(projectDirectory, '第二轮会话', {
      activeSessionChoice: 'continue',
    });

    const summaries = await listSessions(projectDirectory);

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.title, '第一轮会话');
    assert.equal(summaries[0]?.status, 'active');
  });

  it('ends current session before creating a new one when requested', async (): Promise<void> => {
    const projectDirectory = await createTemporaryProjectDirectory();

    await startSession(projectDirectory, '第一轮会话');
    await appendSessionLog(projectDirectory, '保留第一轮日志');
    await startSession(projectDirectory, '第二轮会话', {
      activeSessionChoice: 'end-and-start',
    });

    const sessionLog = await readSessionLog(projectDirectory);
    const summaries = await listSessions(projectDirectory);

    assert.match(sessionLog, /保留第一轮日志/);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0]?.title, '第一轮会话');
    assert.equal(summaries[0]?.status, 'ended');
    assert.equal(summaries[1]?.title, '第二轮会话');
    assert.equal(summaries[1]?.status, 'active');
  });
});

describe('formatSessionSummaries', (): void => {
  it('formats empty and non-empty session summaries', (): void => {
    assert.equal(formatSessionSummaries([]), '暂无会话记录。');

    const output = formatSessionSummaries([
      {
        title: '实现 plan',
        startedAt: '2026-07-16T00:00:00.000Z',
        endedAt: '2026-07-16T01:00:00.000Z',
        status: 'ended',
        summary: '已完成',
      },
    ]);

    assert.match(output, /实现 plan/);
    assert.match(output, /状态：ended/);
    assert.match(output, /总结：已完成/);
  });
});

/**
 * 创建测试项目目录。
 *
 * @returns 项目目录路径。
 */
async function createTemporaryProjectDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'veaw-session-'));

  temporaryDirectories.push(directory);

  return directory;
}

/**
 * 读取 session-log.md。
 *
 * @param projectDirectory 项目目录路径。
 * @returns session-log 内容。
 */
async function readSessionLog(projectDirectory: string): Promise<string> {
  return readFile(path.join(projectDirectory, '.veaw', 'session-log.md'), 'utf8');
}
