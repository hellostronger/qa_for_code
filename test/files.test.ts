// ============================================================
// 测试：文件捕获（capture.ts）+ 存储（store.ts）+ prompt + 集成
// ============================================================

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathInside, captureWriteFile, scanRunDir, toPosix } from '../src/files/capture.js';
import { FileStore } from '../src/files/store.js';
import { createRunFileTracker } from '../src/files/tracker.js';
import { buildSystemPrompt } from '../src/claude/prompt.js';
import { createClaudeParser } from '../src/claude/parser.js';
import type { StreamEvent } from '../src/types.js';

// ========== 临时目录工具 ==========

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qafiles-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ========== isPathInside / toPosix ==========

describe('isPathInside', () => {
  it('允许工作区内的相对/绝对路径', () => {
    const base = path.join(tmpDir, 'run');
    assert.ok(isPathInside(base, path.join(base, 'a.txt')));
    assert.ok(isPathInside(base, path.join(base, 'sub', 'a.txt')));
  });

  it('拒绝等于 baseDir 本身', () => {
    assert.ok(!isPathInside(tmpDir, tmpDir));
  });

  it('拒绝 ../ 逃逸', () => {
    const base = path.join(tmpDir, 'run');
    assert.ok(!isPathInside(base, path.join(tmpDir, 'other.txt')));
  });
});

describe('toPosix', () => {
  it('反斜杠转正斜杠', () => {
    assert.equal(toPosix('a\\b\\c.txt'), 'a/b/c.txt');
    assert.equal(toPosix('a/b/c.txt'), 'a/b/c.txt');
  });
});

// ========== captureWriteFile ==========

describe('captureWriteFile', () => {
  it('相对路径写入工作区', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fs.mkdir(runDir, { recursive: true });
    const ok = await captureWriteFile({ file_path: 'src/hello.txt', content: 'hi' }, runDir);
    assert.ok(ok);
    const content = await fs.readFile(path.join(runDir, 'src', 'hello.txt'), 'utf8');
    assert.equal(content, 'hi');
  });

  it('工作区内的绝对路径写入', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fs.mkdir(runDir, { recursive: true });
    const abs = path.join(runDir, 'abs.txt');
    const ok = await captureWriteFile({ file_path: abs, content: 'x' }, runDir);
    assert.ok(ok);
    assert.equal(await fs.readFile(abs, 'utf8'), 'x');
  });

  it('拒绝逃逸路径（/etc/passwd、../../、工作区外绝对路径）', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fs.mkdir(runDir, { recursive: true });

    assert.ok(!(await captureWriteFile({ file_path: '/etc/passwd', content: 'x' }, runDir)));
    assert.ok(!(await captureWriteFile({ file_path: '../../escape.txt', content: 'x' }, runDir)));
    const outside = path.join(tmpDir, 'other.txt');
    assert.ok(!(await captureWriteFile({ file_path: outside, content: 'x' }, runDir)));

    // 逃逸路径不应产生任何文件
    const files = await scanRunDir(runDir);
    assert.equal(files.length, 0);
  });

  it('非字符串 file_path/content 拒绝', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fs.mkdir(runDir, { recursive: true });
    assert.ok(!(await captureWriteFile({ file_path: 123, content: 'x' } as any, runDir)));
    assert.ok(!(await captureWriteFile({ file_path: 'a.txt', content: 123 } as any, runDir)));
  });
});

// ========== scanRunDir ==========

describe('scanRunDir', () => {
  it('递归返回 posix 相对路径和大小，跳过目录', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fs.mkdir(path.join(runDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'a.txt'), 'hello');
    await fs.writeFile(path.join(runDir, 'sub', 'b.txt'), 'world');

    const files = await scanRunDir(runDir);
    const rels = files.map((f) => f.relativePath).sort();
    assert.deepEqual(rels, ['a.txt', 'sub/b.txt']);
    assert.equal(files.find((f) => f.relativePath === 'a.txt')!.size, 5);
  });

  it('跳过符号链接（防逃逸）', async () => {
    const runDir = path.join(tmpDir, 'run');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'real.txt'), 'x');
    try {
      await fs.symlink('/etc/passwd', path.join(runDir, 'link.txt'));
    } catch {
      // Windows 无权限创建 symlink 时跳过
      return;
    }
    const files = await scanRunDir(runDir);
    assert.deepEqual(files.map((f) => f.relativePath), ['real.txt']);
  });
});

// ========== FileStore ==========

describe('FileStore', () => {
  it('createFile 幂等：同 session + path + size 返回已存在记录', () => {
    const store = new FileStore(path.join(tmpDir, 'ws'), 60000);
    const r1 = store.createFile({ runId: 's1', sessionId: 's1', name: 'a.txt', relativePath: 'a.txt', size: 5 });
    const r2 = store.createFile({ runId: 's1', sessionId: 's1', name: 'a.txt', relativePath: 'a.txt', size: 5 });
    assert.equal(r1.fileId, r2.fileId, '重复文件应返回同一记录');

    const r3 = store.createFile({ runId: 's1', sessionId: 's1', name: 'a.txt', relativePath: 'a.txt', size: 6 });
    assert.notEqual(r1.fileId, r3.fileId, 'size 不同应新开记录');
  });

  it('get / listByRun / delete', () => {
    const store = new FileStore(path.join(tmpDir, 'ws'), 60000);
    const r = store.createFile({ runId: 's1', sessionId: 's1', name: 'a.txt', relativePath: 'a.txt', size: 1 });
    assert.equal(store.get(r.fileId)?.name, 'a.txt');
    assert.equal(store.listByRun('s1').length, 1);
    assert.ok(store.delete(r.fileId));
    assert.equal(store.get(r.fileId), undefined);
  });

  it('deleteSession 级联删除记录 + 工作区目录', async () => {
    const base = path.join(tmpDir, 'ws');
    const store = new FileStore(base, 60000);
    const runDir = await store.ensureRunDir('s1');
    await fs.writeFile(path.join(runDir, 'a.txt'), 'x');
    store.createFile({ runId: 's1', sessionId: 's1', name: 'a.txt', relativePath: 'a.txt', size: 1 });

    await store.deleteSession('s1');
    assert.equal(store.listByRun('s1').length, 0);
    await assert.rejects(fs.access(runDir));
  });

  it('TTL 过期清理（小 ttl + 手动 deleteExpired）', async () => {
    const store = new FileStore(path.join(tmpDir, 'ws'), 50);
    const r = store.createFile({ runId: 's1', sessionId: 's1', name: 'a.txt', relativePath: 'a.txt', size: 1 });
    await new Promise((res) => setTimeout(res, 100));
    await store.deleteExpired();
    assert.equal(store.get(r.fileId), undefined);
  });
});

// ========== buildSystemPrompt ==========

describe('buildSystemPrompt(outputDir)', () => {
  it('有 outputDir 时包含文件生成规则', () => {
    const prompt = buildSystemPrompt('/workspace/s1');
    assert.ok(prompt.includes('File generation'));
    assert.ok(prompt.includes('/workspace/s1'));
    assert.ok(prompt.includes('OUTPUT_DIR'));
  });

  it('无参调用仍包含原有规则（向后兼容）', () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes('<system>'));
    assert.ok(prompt.includes('Read before answering'));
    assert.ok(prompt.includes('never reveal'));
  });
});

// ========== 集成：parser → tracker ==========

describe('RunFileTracker 集成', () => {
  it('从 Write tool_use 流生成 FileRecord', async () => {
    const store = new FileStore(path.join(tmpDir, 'ws'), 60000);
    const runDir = await store.ensureRunDir('s1');
    const tracker = createRunFileTracker(store, 's1', 's1');

    const events: StreamEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));

    // 模拟 Claude 输出一个 Write tool_use
    const payload = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool_1', name: 'Write' },
      },
    };
    parser.feed(JSON.stringify(payload) + '\n');
    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.txt","content":"hello world"}' },
      },
    }) + '\n');
    parser.feed(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    }) + '\n');
    parser.flush();

    // 喂给 tracker
    for (const ev of events) tracker.handleEvent(ev);
    const records = await tracker.finalize();

    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'a.txt');
    assert.equal(records[0].size, 11);
    assert.equal(records[0].relativePath, 'a.txt');
  });
});
