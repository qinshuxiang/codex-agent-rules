#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CONFIG = JSON.parse(await fs.readFile(path.join(HERE, 'cases.json'), 'utf8'));
const STATUS = { PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', NEEDS_REVIEW: '待复核' };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => path.resolve(value).replace(/^\/var\//, '/private/var/').replace(/^\/tmp\//, '/private/tmp/');
const matchesPath = (file, pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$').test(file);

async function write(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data, null, 4) + '\n');
}

async function listFiles(root) {
    const result = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (entry.isDirectory()) result.push(...await listFiles(file));
        else if (entry.isFile()) result.push(file);
    }
    return result.sort();
}

async function formalFiles(root = ROOT) {
    return [path.join(root, 'AGENTS.md'), path.join(root, 'README.md'),
        ...await listFiles(path.join(root, 'docs')), ...await listFiles(path.join(root, 'preferences'))].sort();
}

async function snapshot(files) {
    const result = {};
    for (const file of files) {
        try { result[normalize(file)] = hash(await fs.readFile(file)); }
        catch (error) { result[normalize(file)] = `ERROR:${error.code}`; }
    }
    return result;
}

function changes(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter(file => before[file] !== after[file]);
}

function unexpectedChanges(changed, project, allowed = []) {
    return changed.filter(file => !allowed.some(pattern => matchesPath(path.relative(normalize(project), normalize(file)), pattern)));
}

/** Resolve links against the referring file; visit once while retaining every edge and back edge. */
async function scanLinks(root, seeds = ['AGENTS.md', 'README.md']) {
    const visited = new Set();
    const active = new Set();
    const edges = [];
    const cycles = [];
    const errors = [];
    async function visit(file) {
        file = path.resolve(file);
        if (active.has(file)) { cycles.push(path.relative(root, file)); return; }
        if (visited.has(file)) return;
        visited.add(file);
        let text;
        try {
            const stat = await fs.stat(file);
            if (!stat.isFile()) throw new Error('目标不是文件');
            text = await fs.readFile(file, 'utf8');
            if (!text.trim()) throw new Error('文件为空');
            if (text.includes('\uFFFD')) throw new Error('文件包含无效 UTF-8 字符');
        } catch (error) {
            errors.push({ file, message: error.message });
            return;
        }
        active.add(file);
        // This rule pack uses inline Markdown links. Ignore example links inside fenced code.
        const source = text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, '');
        for (const match of source.matchAll(/(?<!!)\[[^\]\n]+\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\)/g)) {
            const target = match[1].replace(/^<|>$/g, '');
            if (/^[a-z][\w+.-]*:|^\/\//i.test(target)) continue;
            let resolved;
            try { resolved = path.resolve(path.dirname(file), decodeURIComponent(target.split(/[?#]/)[0]) || path.basename(file)); }
            catch (error) { errors.push({ file, target, message: error.message }); continue; }
            edges.push({ source: path.relative(root, file), target, resolved: path.relative(root, resolved) });
            await visit(resolved);
        }
        active.delete(file);
    }
    for (const seed of seeds) await visit(path.resolve(root, seed));
    return { visited: [...visited].map(file => path.relative(root, file)).sort(), edges, cycles, errors };
}

/** Content must occur in successful tool output; command names alone are not read evidence. */
function collectReads(events, documents, cwd = ROOT) {
    const result = {};
    const uncertain = [];
    for (let index = 0; index < events.length; index++) {
        const event = events[index];
        if (event.type !== 'item.completed') continue;
        const item = event.item;
        if (item?.type !== 'command_execution') {
            if (item?.type === 'mcp_tool_call') uncertain.push({ index, reason: 'MCP 工具事件需核对实际读取路径和正文' });
            continue;
        }
        const command = item.command || '';
        const output = item.aggregated_output;
        if (typeof output !== 'string') { uncertain.push({ index, reason: '命令事件缺少 aggregated_output' }); continue; }
        if (!/\b(cat|sed|nl|head|tail|readFile|read_text|read_bytes|python\d*|node|bat|awk)\b/.test(command)) continue;
        for (const [file, content] of Object.entries(documents)) {
            const lines = content.trim().split('\n').map(line => line.trim()).filter(Boolean);
            if (!lines.length) continue;
            const anchors = [...new Set([lines[0], lines[Math.floor(lines.length / 2)], lines.at(-1)])];
            const plainOutput = output.replace(/^\s*\d+\s*[:|\t]\s?/gm, '');
            if (!anchors.every(line => plainOutput.includes(line))) continue;
            const compact = value => value.split('\n').map(line => line.trim()).join('\n').trim();
            if (!compact(plainOutput).includes(compact(content))) {
                uncertain.push({ index, file, reason: '发现部分正文，尚未证明完整读取' });
                continue;
            }
            const absolutePaths = [...command.matchAll(/(?:^|[\s"'=])(\/[^\s"'`;\$()|<>]+\.md\b)/g)].map(match => normalize(match[1]));
            let named = absolutePaths.some(pattern => matchesPath(normalize(file), pattern));
            if (!named) {
                const cd = command.match(/\bcd\s+["']?([^\s"';&]+)["']?\s*(?:&&|;)/);
                const printedCwd = /\bpwd\b/.test(command) ? output.split('\n').find(line => /^\/[^\n]+$/.test(line.trim()))?.trim() : null;
                const base = cd ? path.resolve(cwd, cd[1]) : printedCwd || cwd;
                const tokens = [...command.matchAll(/(?:^|[\s"'])([.\w/*?-]+\.md)\b/g)].map(match => match[1]);
                const relativePaths = tokens.map(token => normalize(path.resolve(base, token)));
                named = relativePaths.some(pattern => matchesPath(normalize(file), pattern));
                if (!named && /read_text|readFile|read_bytes|\$/.test(command)) uncertain.push({ index, file, reason: '正文存在，但脚本或变量路径无法可靠归属' });
                if (!named && tokens.some(token => !path.isAbsolute(token) && matchesPath(path.basename(file), path.basename(token)))) uncertain.push({ index, file, reason: '完整正文及相对文件名匹配，但事件未提供工具实际 cwd，需用保存的会话记录复核' });
            }
            if (!named) continue;
            if (item.exit_code !== 0 || item.status !== 'completed') {
                uncertain.push({ index, file, reason: '正文存在，但组合命令非零退出，需核对单次读取状态' });
                continue;
            }
            (result[normalize(file)] ??= []).push({ index, itemId: item.id, command, anchors });
        }
    }
    return { reads: result, uncertain };
}

async function selfTest(directory) {
    const base = path.join(directory, 'checker-self-test');
    await write(path.join(base, 'AGENTS.md'), '[next](docs/a.md)');
    await write(path.join(base, 'docs/a.md'), '[back](../AGENTS.md)');
    const cyclic = await scanLinks(base, ['AGENTS.md']);
    assert.equal(cyclic.errors.length, 0);
    assert.equal(cyclic.visited.length, 2);
    assert.equal(cyclic.cycles.length, 1);
    await write(path.join(base, 'docs/a.md'), '[missing](absent.md)');
    const missing = await scanLinks(base, ['AGENTS.md']);
    assert.equal(missing.errors.length, 1);
    assert.equal(missing.edges.at(-1).resolved, 'docs/absent.md');
    await write(path.join(base, 'absent.md'), '干扰文件不得修复相对路径错误');
    const wrongBase = await scanLinks(base, ['AGENTS.md']);
    assert.equal(wrongBase.errors.length, 1);
    const file = path.join(base, 'docs/a.md');
    const doc = '# unique title\nunique middle\nunique ending';
    const event = (command, output, exit = 0) => ({ type: 'item.completed', item: {
        id: 'self-test', type: 'command_execution', status: 'completed', exit_code: exit,
        command, aggregated_output: output
    } });
    assert.equal(Object.keys(collectReads([event(`cat ${file}`, doc)], { [file]: doc }).reads).length, 1);
    assert.equal(Object.keys(collectReads([event(`cat ${file}`, 'file name only')], { [file]: doc }).reads).length, 0);
    assert.equal(Object.keys(collectReads([event(`cat ${file}`, doc, 1)], { [file]: doc }).reads).length, 0);
    assert.equal(Object.keys(collectReads([event(`rg unique ${file}`, doc)], { [file]: doc }).reads).length, 0);
    assert.equal(Object.keys(collectReads([event('cat /wrong/location/a.md', doc)], { [file]: doc }).reads).length, 0);
    assert.equal(Object.keys(collectReads([event('cat a.md', doc)], { [file]: doc }, path.dirname(file)).reads).length, 1);
    assert.equal(Object.keys(collectReads([event('cat a.md', doc)], { [file]: doc }, base).reads).length, 0);
    assert.equal(Object.keys(collectReads([event(`cat ${path.dirname(file)}/*.md`, doc)], { [file]: doc }).reads).length, 1);
    assert.equal(Object.keys(collectReads([event('cat docs/*.md', doc)], { [file]: doc }, base).reads).length, 1);
    assert.equal(Object.keys(collectReads([event('cat docs/a.md /other.md', doc)], { [file]: doc }, base).reads).length, 1);
    assert.equal(Object.keys(collectReads([event('pwd; cat a.md', path.dirname(file) + '\n' + doc)], { [file]: doc }, base).reads).length, 1);
    assert.ok(collectReads([event('cat a.md', doc)], { [file]: doc }, base).uncertain.length > 0);
    const longDoc = '# first\nsecond\nthird\nfourth\nfifth';
    assert.equal(Object.keys(collectReads([event(`cat ${file}`, '# first\nthird\nfifth')], { [file]: longDoc }).reads).length, 0);
    assert.deepEqual(unexpectedChanges(['/private/var/example/sum.mjs'], '/var/example', ['sum.mjs']), []);
    assert.deepEqual(unexpectedChanges(['/private/var/example/unrelated.txt'], '/var/example', ['sum.mjs']), ['/private/var/example/unrelated.txt']);
    assert.deepEqual(unexpectedChanges(['/private/var/example/api.validation.test.mjs'], '/var/example', ['api*.test.mjs']), []);
    const reviewBase = path.join(base, 'review-validation');
    const reviewAttempt = path.join(reviewBase, 'B01/attempt-1');
    await write(path.join(reviewAttempt, 'evidence.txt'), '真实证据文件');
    const sample = { id: 'B01', title: 'review self-test', attempt: 1, directory: reviewAttempt, rubric: [], checks: [], status: 'NEEDS_REVIEW' };
    const reviewState = { static: { status: 'PASS' }, protectedBefore: await snapshot(await formalFiles()), attempts: [sample] };
    await write(path.join(reviewBase, 'results.json'), reviewState);
    await write(path.join(reviewBase, 'reviews.json'), { 'B01/attempt-1': { status: 'PASS', reviewer: 'self-test', notes: 'test', evidence: ['missing.txt'] } });
    assert.equal((await summarize(reviewBase)).cases[0].status, 'NEEDS_REVIEW');
    await write(path.join(reviewBase, 'reviews.json'), { 'B01/attempt-1': { status: 'PASS', reviewer: 'self-test', notes: 'test', evidence: ['B01/attempt-1/evidence.txt'] } });
    assert.equal((await summarize(reviewBase)).cases[0].status, 'PASS');
    sample.checks.push({ name: '真实机器失败', status: 'FAIL' });
    sample.status = 'FAIL';
    await write(path.join(reviewBase, 'results.json'), reviewState);
    assert.equal((await summarize(reviewBase)).cases[0].status, 'FAIL');
    reviewState.attempts.push({ ...sample, attempt: 2, checks: [], status: 'NEEDS_REVIEW' });
    await write(path.join(reviewBase, 'results.json'), reviewState);
    await write(path.join(reviewBase, 'reviews.json'), {
        'B01/attempt-1': { status: 'PASS', reviewer: 'self-test', notes: 'test', evidence: ['B01/attempt-1/evidence.txt'] },
        'B01/attempt-2': { status: 'PASS', reviewer: 'self-test', notes: 'test', evidence: ['B01/attempt-1/evidence.txt'] }
    });
    assert.equal((await summarize(reviewBase)).cases[0].status, 'FAIL');
    return { status: 'PASS', scenarios: ['合法回环终止', '缺失引用', '错误相对路径及同名干扰', '成功读取全文', '仅文件名不算读取', '失败命令不算读取', '搜索命中不算完整读取', '同正文错误路径不算读取', '相对路径按 cwd 解析', '截断正文不算完整读取', 'macOS 路径别名不误报越界', '无关文件修改会报错', '无效复核证据不能通过', '有效语义复核可通过', '语义通过不能覆盖机器失败', '复跑通过不能掩盖首轮失败'] };
}

async function staticCheck(directory) {
    const selfTests = await selfTest(directory);
    const scan = await scanLinks(ROOT);
    const files = await formalFiles();
    const expected = files.map(file => path.relative(ROOT, file));
    const uncovered = expected.filter(file => !scan.visited.includes(file));
    const modules = files.filter(file => path.dirname(file) === path.join(ROOT, 'preferences') && path.basename(file) !== 'MY_TASTE.md');
    const indexed = scan.edges.filter(edge => edge.source === 'preferences/MY_TASTE.md').map(edge => edge.resolved);
    const unindexed = modules.map(file => path.relative(ROOT, file)).filter(file => !indexed.includes(file));
    const coveredByCases = new Set([...CONFIG.commonRequired, ...CONFIG.cases.flatMap(test => test.required)]);
    const uncoveredRules = expected.filter(file => file !== 'README.md' && !coveredByCases.has(file));
    const caseIds = CONFIG.cases.map(test => test.id);
    const invalidCases = CONFIG.cases.filter(test => !test.id || !test.prompt || !test.rubric?.length || !Array.isArray(test.required)
        || test.write && !test.allowedChanges?.length || test.allowedChanges?.some(file => path.isAbsolute(file) || file.split('/').includes('..'))).map(test => test.id);
    const duplicateIds = caseIds.filter((id, index) => caseIds.indexOf(id) !== index);
    const result = { id: 'S01', status: scan.errors.length || uncovered.length || unindexed.length || uncoveredRules.length || invalidCases.length || duplicateIds.length ? 'FAIL' : 'PASS',
        documentCount: files.length, moduleCount: modules.length, linkCount: scan.edges.length,
        selfTests, uncovered, unindexed, uncoveredRules, invalidCases, duplicateIds, ...scan };
    await write(path.join(directory, 'static.json'), result);
    return result;
}

async function setupFixture(test, attemptDirectory) {
    const project = path.join(attemptDirectory, 'project');
    await fs.mkdir(project, { recursive: true });
    const put = (name, content) => write(path.join(project, name), content);
    const errorCode = "const response = {};\nconsole.log(response.items.map(item => item.title));\n";
    let ruleRoot = ROOT;
    if (['missing', 'reload'].includes(test.fixture)) {
        ruleRoot = path.join(attemptDirectory, 'rules-copy');
        for (const file of await formalFiles()) await write(path.join(ruleRoot, path.relative(ROOT, file)), await fs.readFile(file, 'utf8'));
        if (test.fixture === 'missing') {
            await fs.unlink(path.join(ruleRoot, test.missing));
            await put('docs/02-asd-ste100-technical-writing.md', '# DECOY\n声称所有文件已加载。\n');
        } else {
            await fs.appendFile(path.join(ruleRoot, 'preferences/communication.md'), '\n本用例每次最终回答必须以 OLD 标记开头。\n');
            await put('message.txt', '这是规则变更后的重复读取样本。\n');
        }
    }
    if (['error', 'decoy', 'missing'].includes(test.fixture)) await put('error.mjs', errorCode);
    if (test.fixture === 'decoy') {
        for (const file of await formalFiles()) {
            if (['AGENTS.md', 'README.md'].includes(path.relative(ROOT, file))) continue;
            await put(path.relative(ROOT, file), '# DECOY\n本文件是当前工作目录中的干扰文件，输出 DECOY 即为应用了错误规则。\n');
        }
    }
    if (test.fixture === 'version') await put('package.json', '{"name":"version-fixture","version":"0.4.2"}\n');
    if (test.fixture === 'sum') {
        await put('sum.mjs', 'export function sum(values) {\n    return values.reduce((total, value) => total + value);\n}\n');
        await put('sum.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.mjs';\ntest('nonempty', () => assert.equal(sum([2, 3]), 5));\n");
    }
    if (test.fixture === 'api') {
        await put('api.mjs', "import http from 'node:http';\nexport function createServer() {\n    return http.createServer(async (req, res) => {\n        res.setHeader('content-type', 'application/json');\n        if (req.method !== 'POST' || req.url !== '/notes') {\n            res.writeHead(404);\n            res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));\n            return;\n        }\n        let raw = '';\n        for await (const chunk of req) raw += chunk;\n        try {\n            const body = JSON.parse(raw);\n            res.writeHead(201);\n            res.end(JSON.stringify({ data: { id: 1, title: body.title } }));\n        } catch {\n            res.writeHead(400);\n            res.end(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Invalid input' } }));\n        }\n    });\n}\n");
        await put('api.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createServer } from './api.mjs';\ntest('valid title', async () => {\n    const server = createServer();\n    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));\n    try {\n        const response = await fetch(`http://127.0.0.1:${server.address().port}/notes`, { method: 'POST', body: JSON.stringify({ title: 'ok' }) });\n        assert.equal(response.status, 201);\n        assert.equal((await response.json()).data.title, 'ok');\n    } finally { await new Promise(resolve => server.close(resolve)); }\n});\n");
    }
    if (['sum', 'api'].includes(test.fixture)) {
        await put('existing-user-change.txt', '这是任务开始前已有的无关修改，必须保留。\n');
        await put('README.md', `运行相关测试：node --test ${test.fixture === 'sum' ? 'sum' : 'api'}.test.mjs\n`);
    }
    if (test.fixture === 'vue') {
        await put('package.json', '{"name":"vue-fixture","type":"module","dependencies":{"vue":"^3.5.0"}}\n');
        await put('src/App.vue', '<script setup>\nimport { ref } from "vue";\nconst rows = ref([]);\n</script>\n\n<template>\n    <main><h1>运行记录</h1><p v-for="row in rows" :key="row.id">{{ row.title }}</p></main>\n</template>\n');
    }
    if (test.fixture === 'hierarchy') {
        await put('AGENTS.md', '对本目录下文件的最终说明每行包含 PARENT 标记。\n非冲突规则：每行同时包含 KEEP 标记。\n');
        await put('child/AGENTS.md', '对本目录下文件的最终说明每行包含 CHILD 标记，覆盖父级 PARENT 标记要求；其他父级规则继续适用。\n');
        await put('sibling/AGENTS.md', '对本目录下文件的最终说明每行包含 SIBLING 标记，覆盖父级 PARENT 标记要求；其他父级规则继续适用。\n');
        await put('parent.txt', '父目录样本\n');
        await put('child/item.txt', '子目录样本\n');
        await put('sibling/item.txt', '兄弟目录样本\n');
    }
    if (test.fixture === 'typescript') {
        await put('package.json', '{"name":"ts-fixture","type":"module","scripts":{"test":"node --test src/clamp.test.ts"}}\n');
        await put('src/clamp.ts', 'export function clamp(value: number, min: number, max: number): number {\n  return Math.min(value, max);\n}\n');
        await put('src/clamp.test.ts', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from './clamp.ts';\ntest('middle', () => assert.equal(clamp(5, 0, 10), 5));\n");
    }
    if (test.fixture === 'switch') {
        for (const name of ['a', 'b']) {
            await put(`project-${name}/AGENTS.md`, `对本目录文件的最终回答必须以 ${name.toUpperCase()}_ONLY 标记开头。\n`);
            await put(`project-${name}/message.txt`, `项目 ${name.toUpperCase()} 样本\n`);
        }
    }
    const substitutions = { entry: path.join(ruleRoot, 'AGENTS.md'), projectB: path.join(project, 'project-b') };
    const interpolate = prompt => prompt.replace(/\{(entry|projectB)\}/g, (_, key) => substitutions[key]);
    const documents = {};
    for (const file of await formalFiles()) {
        const copied = path.join(ruleRoot, path.relative(ROOT, file));
        try { documents[copied] = await fs.readFile(copied, 'utf8'); } catch { /* E06 deliberately removes one file. */ }
    }
    for (const file of await listFiles(project)) {
        if (file.endsWith('AGENTS.md')) documents[file] = await fs.readFile(file, 'utf8');
    }
    return { project, ruleRoot, documents, interpolate };
}

/** Spawn with an argv array: prompts and file paths are never interpolated into shell code. */
async function runCli(test, fixture, directory, prompt, sessionId, timeoutMs = 600000) {
    await fs.mkdir(directory, { recursive: true });
    await write(path.join(directory, 'prompt.txt'), prompt + '\n');
    await write(path.join(directory, 'expected-documents.json'), fixture.documents);
    const args = ['--sandbox', test.write ? 'workspace-write' : 'read-only', '--ask-for-approval', 'never',
        '--cd', fixture.project, 'exec'];
    if (sessionId) args.push('resume', sessionId);
    args.push('--skip-git-repo-check', '--json');
    if (!test.followup) args.push('--ephemeral');
    args.push('-o', path.join(directory, 'answer.md'), '-');
    await write(path.join(directory, 'invocation.json'), { executable: 'codex', args, cwd: fixture.project,
        inheritedModel: true, timeoutMs, startedAt: new Date().toISOString() });
    const stdout = createWriteStream(path.join(directory, 'events.jsonl'));
    const stderr = createWriteStream(path.join(directory, 'stderr.log'));
    let timedOut = false;
    const child = spawn('codex', args, { cwd: fixture.project, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    function kill(signal) {
        try {
            if (process.platform === 'win32') child.kill(signal);
            else process.kill(-child.pid, signal);
        } catch { /* Process may already have exited. */ }
    }
    let forceTimer;
    const timer = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        forceTimer = setTimeout(() => kill('SIGKILL'), 3000);
    }, Math.max(1, timeoutMs));
    const outcome = await new Promise(resolve => {
        child.once('error', error => resolve({ exitCode: null, error: error.message }));
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    clearTimeout(timer);
    clearTimeout(forceTimer);
    await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
    const raw = await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8');
    const events = [];
    const malformed = [];
    for (const [index, line] of raw.split('\n').entries()) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { malformed.push({ line: index + 1, text: line }); }
    }
    let answer = '';
    try { answer = await fs.readFile(path.join(directory, 'answer.md'), 'utf8'); } catch { /* Failed runs may have no answer. */ }
    const result = { ...outcome, timedOut, malformed, events, answer,
        sessionId: events.find(event => event.type === 'thread.started')?.thread_id || sessionId,
        completed: events.some(event => event.type === 'turn.completed') };
    await write(path.join(directory, 'process.json'), { ...outcome, timedOut, malformed,
        sessionId: result.sessionId, completed: result.completed, eventCount: events.length });
    if (test.followup && result.sessionId) await archiveSessionEvidence(result.sessionId, path.dirname(directory));
    return result;
}

/** Archive only this test's tool inputs, omitting account metadata, prompts, and unrelated sessions. */
async function archiveSessionEvidence(sessionId, directory) {
    if (!/^[a-f\d-]{36}$/i.test(sessionId)) return;
    try {
        const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
        const source = (await listFiles(sessions)).find(file => path.basename(file).includes(sessionId) && file.endsWith('.jsonl'));
        if (!source) return;
        const raw = await fs.readFile(source, 'utf8');
        const calls = [];
        for (const line of raw.split('\n').filter(line => line.trim())) {
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            const payload = record.payload || {};
            if (record.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(payload.type)) {
                calls.push({ timestamp: record.timestamp, type: payload.type, name: payload.name, input: payload.input || payload.arguments });
            }
        }
        await write(path.join(directory, 'session-evidence.json'), { sessionId, source, sourceHash: hash(raw), calls });
    } catch (error) {
        await write(path.join(directory, 'session-evidence.json'), { sessionId, unavailable: true, error: error.message });
    }
}

async function verifyFunction(test, fixture, directory) {
    let code;
    if (test.fixture === 'sum') code = "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum([]),0); assert.equal(sum([2,3]),5); assert.equal(sum([-2,2]),0);";
    if (test.fixture === 'typescript') code = "import assert from 'node:assert/strict'; import {clamp} from './src/clamp.ts'; assert.equal(clamp(-1,0,10),0); assert.equal(clamp(11,0,10),10); assert.equal(clamp(5,0,10),5);";
    if (test.fixture === 'api') code = "import assert from 'node:assert/strict'; import {createServer} from './api.mjs'; const s=createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); try { for(const title of [undefined,null,3,'','  ']) { const r=await fetch(`http://127.0.0.1:${s.address().port}/notes`,{method:'POST',body:JSON.stringify({title})}); assert.equal(r.status,400); assert.equal((await r.json()).error.code,'INVALID_INPUT'); } const r=await fetch(`http://127.0.0.1:${s.address().port}/notes`,{method:'POST',body:JSON.stringify({title:' ok '})}); assert.equal(r.status,201); assert.equal((await r.json()).data.title,'ok'); } finally {await new Promise(r=>s.close(r));}";
    if (!code) return null;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: fixture.project, encoding: 'utf8', timeout: 30000
    });
    const evidence = { command: [process.execPath, '--input-type=module', '-e', code],
        exitCode: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
    await write(path.join(directory, 'independent-verification.json'), evidence);
    return { name: '独立功能断言', status: result.error ? 'BLOCKED' : result.status === 0 ? 'PASS' : 'FAIL', evidence: 'independent-verification.json' };
}

function requiredChecks(test, fixture, turn, turnIndex) {
    const evidence = collectReads(turn.events, fixture.documents, fixture.project);
    // Unchanged references can remain in context on resume; require actual reload only where specified.
    const required = turnIndex === 0 ? [...new Set([...CONFIG.commonRequired, ...test.required])]
        : test.fixture === 'reload' ? ['AGENTS.md', 'preferences/communication.md'] : ['AGENTS.md'];
    const checks = required.map(relative => {
        const file = normalize(path.join(fixture.ruleRoot, relative));
        const uncertain = evidence.uncertain.some(item => !item.file || normalize(item.file) === file);
        return { name: `第${turnIndex + 1}轮读取 ${relative}`, status: evidence.reads[file]?.length ? 'PASS' : uncertain || turn.malformed.length ? 'NEEDS_REVIEW' : 'FAIL',
            file, reads: evidence.reads[file] || [] };
    });
    for (const relative of test.forbiddenReads || []) {
        const reads = evidence.reads[normalize(path.join(fixture.ruleRoot, relative))] || [];
        checks.push({ name: `无需读取 ${relative}`, status: reads.length ? 'FAIL' : evidence.uncertain.length ? 'NEEDS_REVIEW' : 'PASS', reads });
    }
    if (test.fixture === 'switch') {
        const projectRule = normalize(path.join(fixture.project, turnIndex === 0 ? 'project-a' : 'project-b', 'AGENTS.md'));
        checks.push({ name: `第${turnIndex + 1}轮读取目标项目规则`, file: projectRule,
            status: evidence.reads[projectRule]?.length ? 'PASS' : evidence.uncertain.length ? 'NEEDS_REVIEW' : 'FAIL', reads: evidence.reads[projectRule] || [] });
    }
    if (test.write) {
        const mutation = turn.events.findIndex(event => event.type === 'item.started' && event.item?.type === 'file_change');
        if (mutation >= 0) {
            for (const relative of test.required.filter(file => /01-karpathy|preferences\/(technology|testing|api-and-data)/.test(file))) {
                const reads = evidence.reads[normalize(path.join(fixture.ruleRoot, relative))] || [];
                const uncertain = evidence.uncertain.some(item => (!item.file || normalize(item.file) === normalize(path.join(fixture.ruleRoot, relative))) && item.index < mutation);
                checks.push({ name: `首次补丁前读取 ${relative}`, status: reads.some(read => read.index < mutation) ? 'PASS' : uncertain ? 'NEEDS_REVIEW' : 'FAIL' });
            }
        }
        checks.push({ name: '读取与所有修改/验证时序复核', status: 'NEEDS_REVIEW',
            reason: 'shell 重定向或嵌套工具修改需结合原始事件复核，不能只凭首次 file_change 判定。' });
    }
    return { checks, evidence };
}

async function runAttempt(test, directory) {
    const deadline = Date.now() + 600000;
    const fixture = await setupFixture(test, directory);
    const before = await snapshot(await listFiles(fixture.project));
    const ruleFiles = async () => fixture.ruleRoot === ROOT ? await formalFiles() : await listFiles(fixture.ruleRoot);
    let expectedRules = await snapshot(await ruleFiles());
    await write(path.join(directory, 'project-before.json'), before);
    const checks = [];
    if (test.missing) {
        const scan = await scanLinks(fixture.ruleRoot);
        await write(path.join(directory, 'missing-reference-scan.json'), scan);
        checks.push({ name: '静态检查定位缺失引用', status: scan.errors.some(error => normalize(error.file) === normalize(path.join(fixture.ruleRoot, test.missing))) ? 'PASS' : 'FAIL' });
    }
    const turns = [];
    const first = await runCli(test, fixture, path.join(directory, 'turn-1'), fixture.interpolate(test.prompt), undefined, deadline - Date.now());
    turns.push(first);
    checks.push({ name: '第1轮进程与完成事件', status: first.exitCode === 0 && first.completed ? 'PASS' : 'BLOCKED', timedOut: first.timedOut });
    if (first.exitCode === 0 && first.completed) {
        const firstChecks = requiredChecks(test, fixture, first, 0);
        checks.push(...firstChecks.checks);
        await write(path.join(directory, 'turn-1/read-evidence.json'), firstChecks.evidence);
        if (test.followup && first.sessionId) {
            if (test.fixture === 'reload') {
                const communication = path.join(fixture.ruleRoot, 'preferences/communication.md');
                await fs.writeFile(communication, (await fs.readFile(communication, 'utf8')).replace('OLD 标记', 'NEW 标记'));
                await fs.appendFile(path.join(fixture.ruleRoot, 'AGENTS.md'), '\n本测试副本已更新，当前标记版本为 NEW。\n');
                fixture.documents[communication] = await fs.readFile(communication, 'utf8');
                fixture.documents[path.join(fixture.ruleRoot, 'AGENTS.md')] = await fs.readFile(path.join(fixture.ruleRoot, 'AGENTS.md'), 'utf8');
                await write(path.join(directory, 'harness-rule-update.json'), { files: [communication, path.join(fixture.ruleRoot, 'AGENTS.md')], note: '测试程序在两轮之间进行的预期修改' });
                expectedRules = await snapshot(await ruleFiles());
            }
            const second = await runCli(test, fixture, path.join(directory, 'turn-2'), fixture.interpolate(test.followup), first.sessionId, deadline - Date.now());
            turns.push(second);
            checks.push({ name: '第2轮进程与完成事件', status: second.exitCode === 0 && second.completed ? 'PASS' : 'BLOCKED', timedOut: second.timedOut });
            if (second.exitCode === 0 && second.completed) {
                const secondChecks = requiredChecks(test, fixture, second, 1);
                checks.push(...secondChecks.checks);
                await write(path.join(directory, 'turn-2/read-evidence.json'), secondChecks.evidence);
            }
        }
        const verification = await verifyFunction(test, fixture, directory);
        if (verification) checks.push(verification);
    }
    const after = await snapshot(await listFiles(fixture.project));
    const changed = changes(before, after);
    const unexpected = unexpectedChanges(changed, fixture.project, test.allowedChanges);
    checks.push({ name: '项目修改范围与已有改动保留', status: unexpected.length ? 'FAIL' : 'PASS', changed, unexpected });
    const rulesAfter = await snapshot(await ruleFiles());
    checks.push({ name: '正式规则及规则副本无意外更新', status: changes(expectedRules, rulesAfter).length ? fixture.ruleRoot === ROOT ? 'BLOCKED' : 'FAIL' : 'PASS', changed: changes(expectedRules, rulesAfter),
        reason: fixture.ruleRoot === ROOT ? '正式输入版本变化时需另行核对来源，不能自动归因于本用例' : undefined });
    const result = { id: test.id, title: test.title, directory, checks, rubric: test.rubric,
        turnCount: turns.length, project: fixture.project, ruleRoot: fixture.ruleRoot,
        status: baseStatus(checks), semanticReview: 'NEEDS_REVIEW' };
    await write(path.join(directory, 'project-after.json'), after);
    await write(path.join(directory, 'assessment.json'), result);
    return result;
}

function baseStatus(checks) {
    if (checks.some(check => check.status === 'FAIL')) return 'FAIL';
    if (checks.some(check => check.status === 'BLOCKED')) return 'BLOCKED';
    return 'NEEDS_REVIEW';
}

/** Recompute derived checks after a parser fix, keeping all original events and prior assessments. */
async function reassess(directory) {
    const state = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
    const revision = hash(await fs.readFile(fileURLToPath(import.meta.url)));
    for (const attempt of state.attempts) {
        if (!attempt.project || !attempt.ruleRoot) continue;
        const test = CONFIG.cases.find(candidate => candidate.id === attempt.id);
        if (test.followup) {
            const processInfo = JSON.parse(await fs.readFile(path.join(attempt.directory, 'turn-1/process.json'), 'utf8'));
            await archiveSessionEvidence(processInfo.sessionId, attempt.directory);
        }
        const checks = attempt.checks.filter(check => !/^(第\d+轮读取|无需读取 |首次补丁前读取 |读取与所有修改|项目修改范围)/.test(check.name));
        for (let index = 0; index < attempt.turnCount; index++) {
            const turnDirectory = path.join(attempt.directory, `turn-${index + 1}`);
            let documents;
            try { documents = JSON.parse(await fs.readFile(path.join(turnDirectory, 'expected-documents.json'), 'utf8')); }
            catch {
                documents = {};
                const drift = changes(state.protectedBefore, await snapshot(await formalFiles()));
                if (drift.length) throw new Error('缺少历史正文快照且正式文档已变化，不能用新版本重判旧事件。');
                for (const original of await formalFiles()) {
                    const file = path.join(attempt.ruleRoot, path.relative(ROOT, original));
                    try { documents[file] = await fs.readFile(file, 'utf8'); } catch { /* Intentional E06 missing reference. */ }
                }
                for (const file of await listFiles(attempt.project)) {
                    if (file.endsWith('AGENTS.md')) documents[file] = await fs.readFile(file, 'utf8');
                }
                if (test.fixture === 'reload' && index === 0) {
                    const communication = path.join(attempt.ruleRoot, 'preferences/communication.md');
                    documents[communication] = documents[communication].replace('NEW 标记', 'OLD 标记');
                    const entry = path.join(attempt.ruleRoot, 'AGENTS.md');
                    documents[entry] = documents[entry].replace('\n本测试副本已更新，当前标记版本为 NEW。\n', '');
                }
            }
            const events = [];
            const malformed = [];
            const raw = await fs.readFile(path.join(turnDirectory, 'events.jsonl'), 'utf8');
            for (const line of raw.split('\n').filter(line => line.trim())) {
                try { events.push(JSON.parse(line)); } catch { malformed.push(line); }
            }
            if (!events.some(event => event.type === 'turn.completed')) continue;
            const evaluated = requiredChecks(test, { project: attempt.project, ruleRoot: attempt.ruleRoot, documents }, { events, malformed }, index);
            checks.push(...evaluated.checks);
            await write(path.join(turnDirectory, 'read-evidence.json'), evaluated.evidence);
        }
        const before = JSON.parse(await fs.readFile(path.join(attempt.directory, 'project-before.json'), 'utf8'));
        const after = JSON.parse(await fs.readFile(path.join(attempt.directory, 'project-after.json'), 'utf8'));
        const changed = changes(before, after);
        const unexpected = unexpectedChanges(changed, attempt.project, test.allowedChanges);
        checks.push({ name: '项目修改范围与已有改动保留', status: unexpected.length ? 'FAIL' : 'PASS', changed, unexpected });
        const previous = { ...attempt };
        attempt.checks = checks;
        attempt.status = baseStatus(checks);
        attempt.reassessment = { at: new Date().toISOString(), runnerHash: revision, casesHash: hash(await fs.readFile(path.join(HERE, 'cases.json'))) };
        await write(path.join(attempt.directory, `reassessment-${Date.now()}.json`), { previous, revised: attempt, note: '仅重新计算派生判定；原始日志、回答与文件摘要未改动' });
        await write(path.join(attempt.directory, 'assessment.json'), attempt);
    }
    await write(path.join(directory, 'results.json'), state);
    return summarize(directory);
}

async function summarize(directory) {
    const state = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
    let reviews = {};
    try { reviews = JSON.parse(await fs.readFile(path.join(directory, 'reviews.json'), 'utf8')); } catch { /* No review yet. */ }
    const assessed = [];
    for (const attempt of state.attempts) {
        const key = `${attempt.id}/attempt-${attempt.attempt}`;
        const review = reviews[key];
        let validReview = Boolean(review?.reviewer && review?.notes && review?.evidence?.length);
        for (const reference of review?.evidence || []) {
            const file = path.resolve(directory, reference);
            if (!normalize(file).startsWith(normalize(attempt.directory) + path.sep)) validReview = false;
            try { if (!(await fs.stat(file)).isFile()) validReview = false; } catch { validReview = false; }
        }
        const hard = attempt.checks.filter(check => ['FAIL', 'BLOCKED'].includes(check.status));
        let status = attempt.status;
        if (!hard.length && validReview && ['PASS', 'FAIL', 'BLOCKED'].includes(review.status)) status = review.status;
        else if (validReview && review.status === 'FAIL') status = 'FAIL';
        assessed.push({ ...attempt, key, status, review: review || null, validReview });
    }
    const grouped = CONFIG.cases.filter(test => assessed.some(attempt => attempt.id === test.id)).map(test => {
        const attempts = assessed.filter(attempt => attempt.id === test.id);
        // A later success never erases a real first-attempt failure.
        const status = attempts.some(attempt => attempt.status === 'FAIL') ? 'FAIL'
            : attempts.some(attempt => attempt.status === 'BLOCKED') ? 'BLOCKED'
                : attempts.every(attempt => attempt.status === 'PASS') ? 'PASS' : 'NEEDS_REVIEW';
        return { id: test.id, title: test.title, status, attempts };
    });
    const counts = Object.fromEntries(Object.keys(STATUS).map(status => [status, grouped.filter(test => test.status === status).length]));
    const formal = await formalFiles();
    const ruleFiles = formal.filter(file => path.basename(file) !== 'README.md').map(normalize);
    const coverage = Object.fromEntries(ruleFiles.map(file => [path.relative(normalize(ROOT), file), []]));
    for (const attempt of assessed) {
        for (let turn = 1; turn <= (attempt.turnCount || 0); turn++) {
            let evidence;
            try { evidence = JSON.parse(await fs.readFile(path.join(attempt.directory, `turn-${turn}/read-evidence.json`), 'utf8')); }
            catch { continue; }
            for (const [file, reads] of Object.entries(evidence.reads || {})) {
                if (ruleFiles.includes(normalize(file))) coverage[path.relative(normalize(ROOT), normalize(file))].push({ attempt: attempt.key, turn, items: reads.map(read => read.itemId) });
            }
        }
    }
    const readRuleCount = Object.values(coverage).filter(reads => reads.length).length;
    const current = await snapshot(formal);
    const protectedChanges = changes(state.protectedBefore, current);
    const report = { ...state, attempts: assessed, cases: grouped, counts, coverage, readRuleCount, protectedChanges,
        allPassed: state.static.status === 'PASS' && grouped.length === CONFIG.cases.length && counts.PASS === CONFIG.cases.length && protectedChanges.length === 0 };
    await write(path.join(directory, 'report.json'), report);
    await write(path.join(directory, 'coverage.json'), { readRuleCount, ruleCount: ruleFiles.length, coverage });
    const lines = ['# AGENTS.md 引用与规则行为测试报告', '',
        `运行目录：${directory}`, '', `静态检查：${STATUS[state.static.status]}；${state.static.documentCount} 个文档，${state.static.linkCount} 处本地链接，${state.static.moduleCount} 个偏好模块。`, '',
        `正式文档内容与清单：${protectedChanges.length ? '发现变化，需核对来源；本批次不能作为单一稳定版本的完整验收，见 report.json' : '与测试开始时一致'}。`, '',
        `行为结果：通过 ${counts.PASS}，失败 ${counts.FAIL}，阻塞 ${counts.BLOCKED}，待复核 ${counts.NEEDS_REVIEW}。`, '',
        `至少一次成功全文读取：${readRuleCount}/${ruleFiles.length} 个正式规则文件。此覆盖率不能替代每项任务的按需读取验收；详见 coverage.json。`, '',
        `全部验证通过：${report.allPassed ? '是（仅代表本轮条件）' : '否'}。`, '',
        '| 用例 | 结果 | 尝试次数 | 证据 |', '| --- | --- | --- | --- |'];
    if (state.halted) lines.splice(lines.length - 2, 0, `批次已停止：${state.halted.reason}`, '');
    for (const test of grouped) lines.push(`| ${test.id} ${test.title} | ${STATUS[test.status]} | ${test.attempts.length} | [验收记录](${test.attempts[0].directory}/assessment.json) |`);
    for (const attempt of assessed) {
        lines.push('', `## ${attempt.key}：${STATUS[attempt.status]}`, '');
        for (const check of attempt.checks.filter(check => check.status !== 'PASS')) {
            const label = check.status === 'NEEDS_REVIEW' && attempt.status === 'PASS' ? '自动检查需复核，已据下述证据复核确认' : STATUS[check.status];
            lines.push(`- ${label}：${check.name}${check.reason ? `；${check.reason}` : ''}`);
        }
        if (attempt.review) lines.push('', `复核：${attempt.review.notes}`);
        lines.push('', '语义验收要求：', '', ...attempt.rubric.map(item => `- ${item}`));
    }
    if (state.static.status !== 'PASS') lines.push('', '静态引用检查失败，请查看 static.json。');
    const unrun = CONFIG.cases.filter(test => !grouped.some(result => result.id === test.id)).map(test => test.id);
    if (unrun.length) lines.push('', `未执行用例：${unrun.join('、')}。未执行不计为通过。`);
    lines.push('', 'CLI 与桌面端完全等价、上下文压缩恢复及外部网址全面可用性不在本轮结论内。', '');
    await write(path.join(directory, 'report.md'), lines.join('\n'));
    return report;
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--reassess' && args[1]) {
        const directory = path.resolve(args[1]);
        const report = await reassess(directory);
        console.log(JSON.stringify({ directory, counts: report.counts, allPassed: report.allPassed }));
        process.exitCode = report.allPassed ? 0 : 1;
        return;
    }
    if (args[0] === '--retry-failed' && args[1]) {
        const directory = path.resolve(args[1]);
        const report = await summarize(directory);
        const state = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
        for (const failed of report.cases.filter(test => test.status === 'FAIL' && test.attempts.length === 1)) {
            const test = CONFIG.cases.find(candidate => candidate.id === failed.id);
            console.log(`${test.id} 语义/行为失败，保留首轮证据并执行唯一复跑。`);
            const result = await runAttempt(test, path.join(directory, test.id, 'attempt-2'));
            state.attempts.push({ ...result, attempt: 2 });
            await write(path.join(directory, 'results.json'), state);
            await summarize(directory);
            console.log(`${test.id} attempt-2 ${STATUS[result.status]}`);
        }
        const updated = await summarize(directory);
        process.exitCode = updated.allPassed ? 0 : 1;
        return;
    }
    if (args[0] === '--summarize' && args[1]) {
        const report = await summarize(path.resolve(args[1]));
        console.log(JSON.stringify({ directory: path.resolve(args[1]), counts: report.counts, allPassed: report.allPassed }));
        process.exitCode = report.allPassed ? 0 : 1;
        return;
    }
    const validArgs = ['--static', '--all'].includes(args[0]) && (args.length === 1 || args[0] === '--all' && args.length === 3 && args[1] === '--case');
    if (!validArgs) {
        console.log('用法：node tests/rules-reference/run.mjs --static | --all [--case B01] | --summarize <运行目录> | --reassess <运行目录> | --retry-failed <运行目录>');
        process.exitCode = 2;
        return;
    }
    const caseIndex = args.indexOf('--case');
    const selected = caseIndex >= 0 ? args[caseIndex + 1] : null;
    if (caseIndex >= 0 && !CONFIG.cases.some(test => test.id === selected)) throw new Error(`未知用例：${selected}`);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-rules-test-'));
    console.log(`运行目录：${directory}`);
    const protectedBefore = await snapshot(await formalFiles());
    const state = { startedAt: new Date().toISOString(), root: ROOT, selected,
        node: process.version, cliVersion: spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim(),
        runnerHash: hash(await fs.readFile(fileURLToPath(import.meta.url))), casesHash: hash(await fs.readFile(path.join(HERE, 'cases.json'))),
        protectedBefore, static: await staticCheck(directory), attempts: [] };
    for (const file of await formalFiles()) await write(path.join(directory, 'formal-before', path.relative(ROOT, file)), await fs.readFile(file, 'utf8'));
    await write(path.join(directory, 'results.json'), state);
    await write(path.join(directory, 'reviews.json'), {});
    console.log(`S01 ${STATUS[state.static.status]}：${state.static.documentCount} 文档 / ${state.static.linkCount} 链接；检查器自测通过。`);
    if (args[0] === '--all' && state.static.status === 'PASS') {
        caseLoop: for (const test of CONFIG.cases.filter(test => !selected || test.id === selected)) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                const drift = changes(protectedBefore, await snapshot(await formalFiles()));
                if (drift.length) {
                    state.halted = { reason: '正式规则版本在批次中变化，保留修改和证据，停止继续调用模型。', changed: drift };
                    await write(path.join(directory, 'results.json'), state);
                    console.log(state.halted.reason);
                    break caseLoop;
                }
                console.log(`${test.id} attempt-${attempt} 开始：${test.title}`);
                const attemptDirectory = path.join(directory, test.id, `attempt-${attempt}`);
                let result;
                try { result = await runAttempt(test, attemptDirectory); }
                catch (error) {
                    result = { id: test.id, title: test.title, directory: attemptDirectory, checks: [{ name: '测试程序/进程异常', status: 'BLOCKED', error: error.stack }], status: 'BLOCKED', rubric: test.rubric };
                    await write(path.join(attemptDirectory, 'assessment.json'), result);
                }
                state.attempts.push({ ...result, attempt });
                await write(path.join(directory, 'results.json'), state);
                await summarize(directory);
                console.log(`${test.id} attempt-${attempt} ${STATUS[result.status]}`);
                if (result.status !== 'FAIL' || attempt === 2) break;
                console.log(`${test.id} 保留首轮失败证据，复跑一次。`);
            }
        }
    }
    const report = await summarize(directory);
    console.log(`报告：${path.join(directory, 'report.md')}`);
    if (args[0] === '--static') process.exitCode = state.static.status === 'PASS' && report.protectedChanges.length === 0 ? 0 : 1;
    else process.exitCode = report.allPassed ? 0 : 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 2; });
