#!/usr/bin/env node
/**
 * dsh-memory 测试 —— 零依赖，直接 `node test/run-tests.mjs`
 *
 * 两处沙箱坑都固化在这里了（详见每处的注释）：
 *   1. 「非 ASCII 路径」那组是**回归测试**：路径含非 ASCII 字符时 `fs.rmSync` 会静默失败
 *      甚至崩进程（0xC0000409），所以 CLI 用 `unlinkSync`；测试自己也用 `unlinkSync`。
 *   2. `run()` 不用管道捕获子进程输出：DSH 沙箱禁止命名管道，`spawnSync` 默认
 *      `stdio:'pipe'` 会 EPERM。改成重定向到文件。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem.mjs');
const SANDBOX = path.join(HERE, '..', '.test-sandbox');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 递归删除 —— 故意不用 `fs.rmSync`。
 * 实测（Node 24 + DSH 沙箱）：路径含非 ASCII 字符时 rmSync 会静默失败，配 recursive
 * 时甚至会直接把进程打死（0xC0000409）。`unlinkSync` + `rmdirSync` 则稳定可用。
 */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(p)) rmrf(path.join(p, entry));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

/** 跑一次 CLI。输出重定向到文件而不是管道（沙箱禁止命名管道 → EPERM）。 */
function run(args) {
  const outFile = path.join(SANDBOX, '.last-out.txt');
  const errFile = path.join(SANDBOX, '.last-err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [MEM, ...args], {
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, NO_COLOR: '1' },
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const out = fs.readFileSync(outFile, 'utf8');
  const err = fs.readFileSync(errFile, 'utf8');
  if (r.error) throw new Error(`无法启动 CLI：${r.error.code} ${r.error.message}`);
  return { code: r.status, out, err };
}

function freshRoot(label) {
  const root = path.join(SANDBOX, label);
  rmrf(root);
  return root;
}

function md(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

const section = (t) => console.log(`\n${t}`);
const flat = (s, n = 220) => s.replace(/\s+/g, ' ').trim().slice(0, n);

rmrf(SANDBOX);
fs.mkdirSync(SANDBOX, { recursive: true });

/* ------------------------------------------------------------ 基础流程 */
section('基础流程（ASCII 路径）');
{
  const root = freshRoot('basic');

  let r = run(['init', '--root', root]);
  check('init 成功', r.code === 0, r.err);
  check('init 建出四个目录', ['facts', 'decisions', 'inbox', 'archive'].every((d) => fs.existsSync(path.join(root, d))));
  check('init 生成 config 与 journal', fs.existsSync(path.join(root, 'memory.config.json')) && fs.existsSync(path.join(root, 'journal.md')));

  r = run(['new', '--root', root, '--type', 'fact', '--conclusion', '结论一', '--reason', '理由一', '--tags', 'a,b', '--source', 's1']);
  check('new 成功', r.code === 0, r.err);
  check('new 落在 inbox', md(path.join(root, 'inbox')).length === 1);

  const idA = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  const raw = fs.readFileSync(path.join(root, 'inbox', `${idA}.md`), 'utf8');
  check('frontmatter 含 id/type/status', /^---\n/.test(raw) && raw.includes(`id: ${idA}`) && raw.includes('type: fact') && raw.includes('status: active'));
  check('tags 解析为数组', raw.includes('tags: [a, b]'));

  r = run(['promote', '--root', root, idA]);
  check('promote 成功', r.code === 0, r.err);
  check('promote 后 inbox 为空（没有幽灵重复）', md(path.join(root, 'inbox')).length === 0, `inbox 仍有 ${md(path.join(root, 'inbox')).join(',')}`);
  check('promote 后 facts 有 1 条', md(path.join(root, 'facts')).length === 1);

  run(['new', '--root', root, '--type', 'fact', '--conclusion', '结论二', '--tags', 'a,b', '--source', 's2']);
  const idB = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  r = run(['promote', '--root', root, idB, '--supersedes', idA]);
  check('promote --supersedes 成功', r.code === 0, r.err);
  check('旧条目已归档', md(path.join(root, 'archive')).some((f) => f.startsWith(idA)));
  check('旧条目不在 facts', !md(path.join(root, 'facts')).some((f) => f.startsWith(idA)));

  const newRaw = fs.readFileSync(path.join(root, 'facts', `${idB}.md`), 'utf8');
  const oldRaw = fs.readFileSync(path.join(root, 'archive', `${idA}.md`), 'utf8');
  check('新条目记录了 supersedes', newRaw.includes(`supersedes: [${idA}]`), flat(newRaw.split('---')[1]));
  check('旧条目被标 superseded', oldRaw.includes('status: superseded'), flat(oldRaw.split('---')[1]));
  check('旧条目记录了 superseded_by', oldRaw.includes(`superseded_by: ${idB}`), flat(oldRaw.split('---')[1]));

  run(['index', '--root', root]);
  r = run(['inject', '--root', root]);
  check('inject 只含 active（被取代的不出现）', !r.out.includes(idA) && r.out.includes(idB), flat(r.out));

  r = run(['validate', '--root', root]);
  const valOut = r.out + r.err;
  check('validate 通过', r.code === 0 && (/全部通过/.test(valOut) || /0 个问题/.test(valOut)), flat(valOut));

  r = run(['recall', '--root', root, '结论二']);
  check('recall 命中条目', r.code === 0 && r.out.includes(idB), flat(r.out));

  r = run(['journal', 'add', '--root', root, '流水一行']);
  check('journal add 成功', r.code === 0 && fs.readFileSync(path.join(root, 'journal.md'), 'utf8').includes('流水一行'), r.err);
}

/* ----------------------------------------- 回归：路径含非 ASCII 字符 */
section('回归测试：路径含非 ASCII（中文）');
{
  const root = freshRoot('中文路径的仓库');
  let r = run(['init', '--root', root]);
  check('非 ASCII 路径 init 成功', r.code === 0, r.err);
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '中文路径下的条目', '--source', 's']);
  const id = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  r = run(['promote', '--root', root, id]);
  check('非 ASCII 路径 promote 成功', r.code === 0, r.err);
  check('非 ASCII 路径 inbox 已清空', md(path.join(root, 'inbox')).length === 0, `残留 ${md(path.join(root, 'inbox')).join(',')}`);
  check('非 ASCII 路径 facts 有条目', md(path.join(root, 'facts')).length === 1);

  // 中文条目名 + 后续 supersede，覆盖"改完再写盘"的路径
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '中文条目二', '--source', 's2']);
  const id2 = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  r = run(['promote', '--root', root, id2, '--supersedes', id]);
  check('非 ASCII 路径下 supersede 成功', r.code === 0, r.err);
  check('非 ASCII 路径下旧条目已归档', md(path.join(root, 'archive')).some((f) => f.startsWith(id)));
}

/* --------------------------------------------------------- validate 抓错 */
section('validate 能抓到的问题');
{
  const root = freshRoot('bad');
  run(['init', '--root', root]);
  run(['new', '--root', root, '--type', 'fact', '--conclusion', '正常条目', '--source', 's']);
  const goodId = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');

  fs.writeFileSync(
    path.join(root, 'facts', 'broken.md'),
    ['---', 'id: broken', 'type: fact', 'scope: workspace:x', 'status: active', 'date: 2026-01-01', 'superseded_by: 不存在的东西', '---', '', '## 结论', '坏的', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(root, 'facts', 'nofields.md'), ['---', 'id: nofields', '---', '', '## 结论', '缺字段', ''].join('\n'), 'utf8');
  // 文件名与 frontmatter 里的 id 故意不一致
  fs.writeFileSync(
    path.join(root, 'facts', 'mismatch.md'),
    ['---', 'id: 完全不同的id', 'type: fact', 'scope: workspace:x', 'status: active', 'date: 2026-01-01', '---', '', '## 结论', '文件名与 id 不一致', ''].join('\n'),
    'utf8',
  );

  const r = run(['validate', '--root', root]);
  const all = r.out + r.err;
  check('validate 报出问题（退出码 1）', r.code === 1, `code=${r.code}`);
  check('抓到 superseded_by 悬空引用', /superseded_by 指向不存在/.test(all), flat(all));
  check('抓到缺必填字段', /缺少必填字段/.test(all), flat(all));
  check('抓到 id 与文件名不一致', /id 与文件名不一致/.test(all), flat(all));

  rmrf(path.join(root, 'facts', 'broken.md'));
  rmrf(path.join(root, 'facts', 'nofields.md'));
  rmrf(path.join(root, 'facts', 'mismatch.md'));
  run(['promote', '--root', root, goodId]);
  run(['index', '--root', root]);
  const r2 = run(['validate', '--root', root]);
  check('修好后 validate 通过', r2.code === 0, flat(r2.out + r2.err));
}

/* --------------------------------------------------------- 注入预算 */
section('注入预算');
{
  const root = freshRoot('budget');
  run(['init', '--root', root]);
  for (let i = 0; i < 5; i += 1) {
    run(['new', '--root', root, '--type', 'fact', '--conclusion', `第 ${i} 条比较长的结论，用来撑大注入体积`, '--source', 's']);
    const id = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
    run(['promote', '--root', root, id]);
  }
  const r = run(['inject', '--root', root, '--budget', '50']);
  check('超预算时 inject 报错', r.code === 1, `code=${r.code}`);
  check('超预算信息含用量', /\d+ \/ 50 字节/.test(r.out + r.err), flat(r.out + r.err));
}

/* ------------------------------------------------- M2：语义键 key */
section('M2：语义键 key 与「一个 key 一个真相」');
{
  const root = freshRoot('key');
  run(['init', '--root', root, '--scope', 'workspace:x']);

  let r = run(['new', '--root', root, '--type', 'fact', '--id', 'budget-50', '--key', 'inject-budget', '--conclusion', '预算 50 字节', '--source', 's']);
  check('new --id 使用显式短 id', r.code === 0 && md(path.join(root, 'inbox'))[0] === 'budget-50.md', r.err);

  r = run(['new', '--root', root, '--type', 'fact', '--id', 'bad key!', '--conclusion', 'x', '--source', 's']);
  check('非法 id 被拒绝', r.code === 1, flat(r.err + r.out));

  r = run(['new', '--root', root, '--type', 'fact', '--id', 'k1', '--key', 'Bad Key!', '--conclusion', 'x', '--source', 's']);
  check('非法 key 被拒绝', r.code === 1 && /key 只允许/.test(r.err + r.out), flat(r.err + r.out));

  r = run(['promote', '--root', root, 'budget-50']);
  check('带 key 首次 promote 成功', r.code === 0, r.err);

  run(['new', '--root', root, '--type', 'fact', '--id', 'budget-100', '--key', 'inject-budget', '--conclusion', '预算 100 字节', '--source', 's2']);
  r = run(['promote', '--root', root, 'budget-100']);
  check('同 key 已有 active 时 promote 被拒绝', r.code === 1 && /一个 key 只能有一个真相/.test(r.err + r.out), flat(r.err + r.out));
  check('被拒绝后条目仍留在 inbox', md(path.join(root, 'inbox')).includes('budget-100.md'));

  r = run(['promote', '--root', root, 'budget-100', '--supersedes', 'budget-50']);
  check('显式 --supersedes 后放行', r.code === 0, r.err);

  run(['index', '--root', root]);
  r = run(['validate', '--root', root]);
  check('取代后 validate 无问题', r.code === 0, flat(r.out + r.err));

  // 手工造同 key 冲突 → validate 必须当**问题**报，而不是告警
  fs.writeFileSync(
    path.join(root, 'facts', 'budget-999.md'),
    ['---', 'id: budget-999', 'type: fact', 'scope: workspace:x', 'key: inject-budget', 'status: active', 'date: 2026-01-01', '---', '', '## 结论', '另一个预算结论', ''].join('\n'),
    'utf8',
  );
  r = run(['validate', '--root', root]);
  check('validate 把同 key 冲突当问题报出', r.code === 1 && /冲突：同一个 key/.test(r.out + r.err), flat(r.out + r.err));
  rmrf(path.join(root, 'facts', 'budget-999.md'));
}

/* --------------------------------------- M2：id 派生 / 差分载荷 / --fix */
section('M2：id 派生 / inject --json 差分载荷 / validate --fix');
{
  const root = freshRoot('m2');
  run(['init', '--root', root, '--scope', 'workspace:x']);

  const longConclusion = '这是一个很长很长的中文结论用来验证派生 id 不会变成一大串';
  run(['new', '--root', root, '--type', 'fact', '--conclusion', longConclusion, '--source', 's']);
  const derived = md(path.join(root, 'inbox'))[0].replace(/\.md$/, '');
  const slugPart = derived.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  check('派生 id 的 slug 部分 ≤ 20 字符', slugPart.length <= 20, `实际 ${slugPart.length}：${slugPart}`);

  const r = run(['new', '--root', root, '--type', 'fact', '--conclusion', longConclusion, '--source', 's']);
  check('派生 id 撞车时自动加序号（不失败）', r.code === 0 && md(path.join(root, 'inbox')).length === 2, r.err);

  for (const f of md(path.join(root, 'inbox'))) run(['promote', '--root', root, f.replace(/\.md$/, '')]);
  run(['index', '--root', root]);

  const j = run(['inject', '--root', root, '--json']);
  let payload = null;
  try {
    payload = JSON.parse(j.out);
  } catch {
    /* 下面断言会报出来 */
  }
  check('inject --json 是合法 JSON', payload !== null, flat(j.out));
  check('载荷含 version/bytes/budget/entries', !!payload && payload.version === 1 && typeof payload.bytes === 'number' && Array.isArray(payload.entries), flat(j.out));
  check('每条带 12 位 hash', !!payload && payload.entries.length === 2 && payload.entries.every((e) => /^[0-9a-f]{12}$/.test(e.hash)), flat(j.out));

  const h1 = payload.entries[0].hash;
  const j2 = JSON.parse(run(['inject', '--root', root, '--json']).out);
  check('同内容 hash 稳定（差分的前提）', j2.entries[0].hash === h1);

  const someId = payload.entries[0].id;
  const otherId = payload.entries[1].id;
  const file = path.join(root, 'facts', `${someId}.md`);
  const txt = fs
    .readFileSync(file, 'utf8')
    .replace('status: active', 'status: superseded')
    .replace('superseded_by: null', `superseded_by: ${otherId}`);
  fs.writeFileSync(file, txt, 'utf8');
  const fx = run(['validate', '--root', root, '--fix']);
  check('--fix 归档漏归档的 superseded', md(path.join(root, 'archive')).includes(`${someId}.md`), flat(fx.out + fx.err));
  check('--fix 重建了 index', fs.readFileSync(path.join(root, 'index.md'), 'utf8').includes(otherId));
  check('--fix 不做语义修改（双向不一致仍报问题）', fx.code === 1, `code=${fx.code}`);
}

/* --------------------------------------------------------- M2：mem set */
section('M2：mem set 修改已有条目');
{
  const root = freshRoot('set');
  run(['init', '--root', root, '--scope', 'workspace:x']);
  run(['new', '--root', root, '--type', 'fact', '--id', 'e1', '--conclusion', '原始结论', '--tags', 'a', '--source', 's']);
  run(['promote', '--root', root, 'e1']);
  const fileOf = () => fs.readFileSync(path.join(root, 'facts', 'e1.md'), 'utf8');

  let r = run(['set', '--root', root, 'e1', '--key', 'my-key', '--tags', 'a,b', '--verify-when', '半年后']);
  check('set 成功', r.code === 0, r.err);
  check('key 已写入', fileOf().includes('key: my-key'), flat(fileOf().split('---')[1]));
  check('tags 已更新', fileOf().includes('tags: [a, b]'));
  check('verify_when 已写入', fileOf().includes('verify_when: 半年后'));

  r = run(['set', '--root', root, 'e1', '--conclusion', '改过的结论']);
  check('set 替换结论正文', r.code === 0 && fileOf().includes('改过的结论'), r.err);
  check('理由小节保留', fileOf().includes('## 理由'));

  const before = JSON.parse(run(['inject', '--root', root, '--json']).out).entries[0].hash;
  run(['set', '--root', root, 'e1', '--conclusion', '再改一次']);
  const after = JSON.parse(run(['inject', '--root', root, '--json']).out).entries[0].hash;
  check('结论变化 → hash 变化（差分能感知）', before !== after);

  r = run(['set', '--root', root, 'e1']);
  check('无改动时报错', r.code === 1, flat(r.err + r.out));

  r = run(['set', '--root', root, '不存在', '--key', 'x']);
  check('改不存在的条目报错', r.code === 1 && /找不到条目/.test(r.err + r.out), flat(r.err + r.out));

  r = run(['set', '--root', root, 'e1', '--status', 'expired']);
  check('set --status expired', r.code === 0 && fileOf().includes('status: expired'), r.err);
  check('expired 条目不再参与注入', JSON.parse(run(['inject', '--root', root, '--json']).out).entries.length === 0);
}

/* ------------------------------------------------------------- 汇总 */
rmrf(SANDBOX);
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
