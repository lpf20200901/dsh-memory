/**
 * 插件集成测试 —— 用桩模块把 `src/plugin.mjs` **真正 apply 起来**并驱动它，
 * 覆盖"注册了 pre-step 与工具、配置生效、注入走差分、工具真的能读写记忆库"。
 *
 * 跑：node --import ./test/stub-loader.mjs test/plugin-tests.mjs
 * （不能在没有 loader 的情况下直接 import 插件 —— 它依赖 DSH 提供的包）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, apply, inject as injectServices, name } from '../src/plugin.mjs';
import { createEntry, ensureLayout, injectPayload, readAll } from '../bin/mem.mjs';
import { MEMORY_SOURCE_KIND } from '../src/planner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(HERE, '..', '.test-sandbox');

let pass = 0;
let fail = 0;
const failures = [];
function check(n, c, d = '') {
  if (c) {
    pass += 1;
    console.log(`  ok   ${n}`);
  } else {
    fail += 1;
    failures.push(`${n}${d ? ` — ${d}` : ''}`);
    console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`);
  }
}
const section = (t) => console.log(`\n${t}`);

/**
 * 递归校验"无损 JSON" —— DSH 的工具层要求返回值里不能有 `undefined`（也不能有函数 / Date /
 * 类实例等）：只要有一个属性是 `undefined`，**整个工具调用就失败**
 * （`value is not lossless JSON`）。桩模块不校验这个，所以这里自己校验。
 * 真机上踩到过：命中流水行（没有 type/status）或没有 key 的条目时，输出里漏出了 undefined。
 */
function losslessError(value, path = '$') {
  if (value === undefined) return `${path} 是 undefined（DSH 判为非法）`;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return null;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const e = losslessError(v, `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${path} 不是普通对象`;
    for (const [k, v] of Object.entries(value)) {
      const e = losslessError(v, `${path}.${k}`);
      if (e) return e;
    }
    return null;
  }
  return `${path} 的类型 ${t} 不是 JSON 值`;
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) rmrf(path.join(p, e));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

/* -------------------------------------------------------- 假的 DSH ctx/agent */

function fakeCtx() {
  const handlers = new Map();
  const registered = [];
  const warnings = [];
  return {
    handlers,
    registered,
    warnings,
    on(event, fn) {
      handlers.set(event, fn);
    },
    tools: {
      register(tool) {
        registered.push(tool);
      },
    },
    logger: { warn: (...a) => warnings.push(a[0]) },
    get: () => undefined,
  };
}

function fakeAgent(cwd, id = 'session-test') {
  const nextStep = [];
  const inbox = {
    nextStep,
    prepend(queue, message) {
      if (queue !== 'next-step') throw new Error(`unexpected queue ${queue}`);
      nextStep.unshift(message);
    },
    replace(mid, message) {
      const i = nextStep.findIndex((m) => m.id === mid);
      if (i < 0) throw new Error(`replace miss ${mid}`);
      nextStep[i] = message;
    },
    remove(mid) {
      const i = nextStep.findIndex((m) => m.id === mid);
      if (i >= 0) nextStep.splice(i, 1);
    },
  };
  return { session: { header: { cwd, id } }, inbox };
}

/* ------------------------------------------------------------------ 准备记忆库 */

rmrf(SANDBOX);
const ROOT = path.join(SANDBOX, 'proj', 'memory');
ensureLayout(ROOT);
const L = ensureLayout(ROOT, { create: false });
createEntry(L, { type: 'fact', id: 'known-fact', conclusion: '路径含非 ASCII 时不要用 rmSync', tags: ['node'], source: 's0' });
const known = readAll(L).find((e) => e.id === 'known-fact');
fs.writeFileSync(path.join(L.facts, 'known-fact.md'), fs.readFileSync(known.file, 'utf8'), 'utf8');
fs.unlinkSync(known.file);

/* ------------------------------------------------------------------ 契约 */

section('插件契约（导出形状）');
{
  check('name 是 memory', name === 'memory', name);
  check('inject 声明了 tools 服务', Array.isArray(injectServices) && injectServices.includes('tools'), JSON.stringify(injectServices));
  check('Config 声明了 root/maxBytes/enabled/dueWithin', ['root', 'maxBytes', 'enabled', 'dueWithin'].every((k) => !!Config[k]), Object.keys(Config).join(','));
}

/* ------------------------------------------------------------------ 接线 */

section('apply() 接线：注册 pre-step 与两个工具');
const ctx = fakeCtx();
const cwdOfProject = path.join(SANDBOX, 'proj');
// apply 的返回值不是给 DSH 用的，而是留一个不污染 ctx 的测试缝（见 src/plugin.mjs 末尾注释）
const plugin = apply(ctx, { root: ROOT, maxBytes: 3072, enabled: true });

check('注册了 agent/pre-step', typeof ctx.handlers.get('agent/pre-step') === 'function');
check('注册了 2 个工具', ctx.registered.length === 2, ctx.registered.map((t) => t.name).join(","));
check('工具名正确', ctx.registered.map((t) => t.name).sort().join(",") === 'memory_search,memory_write', ctx.registered.map((t) => t.name).join(","));
for (const tool of ctx.registered) {
  check(`${tool.name} 有 description/parameters/execute/output`, !!tool.description && !!tool.parameters && typeof tool.execute === 'function' && !!tool.output);
}

/* ------------------------------------------------- 差分注入：端到端三轮 */

section('差分注入：通过插件真实跑三轮');
const preStep = ctx.handlers.get('agent/pre-step');
{
  const agent = fakeAgent(cwdOfProject);
  const userMsg = { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '干活' }] };

  // 第 1 轮：step 1、还没有已领取消息 → 进 inbox
  const d1 = { kind: 'ok', messages: [] };
  const o1 = await preStep({ agent, messages: [], step: 1 }, async () => d1);
  check('第 1 轮不打断 decision', o1 === d1);
  check('第 1 轮把 baseline 排进 inbox', agent.inbox.nextStep.length === 1);
  const baseline = agent.inbox.nextStep[0];
  check('baseline 内容是记忆条目', baseline.content[0].text.includes('不要用 rmSync'), baseline.content[0].text.slice(0, 60));
  check('baseline 带 source.entries', Array.isArray(baseline.source.entries) && baseline.source.entries[0].id === 'known-fact');

  // 第 2 轮：已领取里含上轮那条 → 状态一致 → 零注入
  const claimed = [userMsg, baseline];
  const d2 = { kind: 'ok', messages: [...claimed] };
  const o2 = await preStep({ agent: fakeAgent(cwdOfProject), messages: claimed, step: 2 }, async () => d2);
  check('第 2 轮零注入（记忆没变化）', o2.messages.length === d2.messages.length, String(o2.messages.length));

  // 第 3 轮：新写入一条并提升为 active → 只推差异
  const created = createEntry(L, { type: 'fact', id: 'new-fact', conclusion: '新结论：沙箱禁管道', tags: ['dsh'], source: 's1' });
  fs.writeFileSync(path.join(L.facts, 'new-fact.md'), fs.readFileSync(created.file, 'utf8'), 'utf8');
  fs.unlinkSync(created.file);
  const payload = injectPayload(L, 3072);
  check('记忆库现在有 2 条 active', payload.entries.length === 2, String(payload.entries.length));

  const d3 = { kind: 'ok', messages: [...claimed] };
  const o3 = await preStep({ agent: fakeAgent(cwdOfProject), messages: claimed, step: 3 }, async () => d3);
  check('第 3 轮插入 1 条', o3.messages.length === d3.messages.length + 1, String(o3.messages.length));
  const delta = o3.messages.find((m) => m.source?.kind === MEMORY_SOURCE_KIND && m.content[0].text.includes('新增'));
  check('第 3 轮推的是 delta', !!delta, JSON.stringify(o3.messages.map((m) => m.content[0].text.slice(0, 24))));
  check('delta 只含新条目', delta && /沙箱禁管道/.test(delta.content[0].text) && !/rmSync/.test(delta.content[0].text), delta?.content[0].text.slice(0, 120));
  // 回归：id 只走 source.entries，不进正文（曾占掉 40% 注入字节）
  check('注入正文不含 id 注释', delta && !delta.content[0].text.includes('<!--'), delta?.content[0].text.slice(0, 120));
  check('baseline 正文也不含 id 注释', !baseline.content[0].text.includes('<!--'), baseline.content[0].text.slice(0, 120));

  // 到期复核要用 payload 里的 date / verify_when —— 缺了它们，hook 就算不出"到点了"
  check('injectPayload 每条都带 date 键', payload.entries.every((e) => 'date' in e), JSON.stringify(payload.entries.map((e) => e.date)));
  check('injectPayload 每条都带 verifyWhen 键（没写则为 null）', payload.entries.every((e) => 'verifyWhen' in e && (e.verifyWhen === null || typeof e.verifyWhen === 'string')), JSON.stringify(payload.entries.map((e) => e.verifyWhen)));
}

/* ------------------------------------------------------------------ 工具 */

section('工具：memory_write 与 memory_search');
const writeTool = ctx.registered.find((t) => t.name === 'memory_write');
const searchTool = ctx.registered.find((t) => t.name === 'memory_search');
const toolAgent = fakeAgent(cwdOfProject, 'session-tool');

{
  const result = await writeTool.execute(
    { type: 'decision', conclusion: '模型只能写收件箱', reason: '防止错误结论被反复注入', tags: ['design'], key: 'inbox-only' },
    { agent: toolAgent },
  );
  check('memory_write 返回 id 与 inbox 状态', !!result.id && result.status === 'inbox', JSON.stringify(result));

  const inboxCount = fs.readdirSync(L.inbox).filter((f) => f.endsWith('.md')).length;
  check('memory_write 真的写进了 inbox', inboxCount === 1, String(inboxCount));

  // D2 的关键验证：刚写的候选**不能**进入注入
  const after = injectPayload(L, 3072);
  check('候选条目未进入注入载荷（D2：模型不能直接改事实层）', !after.entries.some((e) => e.id === result.id), after.entries.map((e) => e.id).join(','));

  const rendered = writeTool.output.render({}, result);
  check('工具输出可渲染成文本', Array.isArray(rendered) && typeof rendered[0].text === 'string', JSON.stringify(rendered));
  check('渲染文案提到 inbox', /inbox/.test(rendered[0].text), rendered[0].text);

  // 真机试用踩到的 bug：工具写的条目 scope 落到了 harness 进程的 cwd（launch-root）。
  // 断言 scope 跟随**会话工作区**，绝不可能是 harness 进程的 cwd。
  const writtenRaw = fs.readFileSync(path.join(L.inbox, `${result.id}.md`), 'utf8');
  const writtenScope = /scope:\s*(.+)/.exec(writtenRaw)?.[1]?.trim();
  check('memory_write 的 scope 跟随会话工作区', writtenScope === `workspace:${cwdOfProject}`, String(writtenScope));
  check('scope 不是 harness 进程 cwd 那种值', !/launch-root|dsh-desktop/i.test(String(writtenScope)), String(writtenScope));
}

{
  const hit = await searchTool.execute({ query: 'rmSync' }, { agent: toolAgent });
  check('memory_search 能搜到已有事实', hit.total >= 1 && hit.matches.some((m) => m.id === 'known-fact'), JSON.stringify(hit).slice(0, 200));

  const byKey = await searchTool.execute({ query: 'inbox-only' }, { agent: toolAgent });
  check('memory_search 能按 key 搜到 inbox 候选', byKey.matches.some((m) => m.where === 'inbox'), JSON.stringify(byKey.matches));

  const none = await searchTool.execute({ query: '绝对搜不到的词xyzzy' }, { agent: toolAgent });
  check('搜不到时 total=0', none.total === 0, JSON.stringify(none));

  const journalLine = await searchTool.execute({ query: '流水一行' }, { agent: toolAgent });
  check('memory_search 覆盖 journal（本轮没写则为 0）', journalLine.total === 0 || journalLine.matches.some((m) => m.where === 'journal'), JSON.stringify(journalLine.total));

  // 中文连写检索：查询不带空格也要命中（bigram 分词）—— 老实现（纯子串）这里必然落空
  const zh = await searchTool.execute({ query: '沙箱禁管道' }, { agent: toolAgent });
  check('memory_search 支持中文连写检索', zh.matches.some((m) => m.id === 'new-fact'), JSON.stringify(zh).slice(0, 200));
  check('memory_search 结果带 score 与 snippet', typeof zh.matches[0]?.score === 'number' && !!zh.matches[0]?.snippet, JSON.stringify(zh.matches[0] ?? {}).slice(0, 200));

  // --where 收窄到 facts：inbox 里的候选不应该出现
  const factsOnly = await searchTool.execute({ query: '沙箱禁管道', where: 'facts' }, { agent: toolAgent });
  check('where=facts 只返回事实层', factsOnly.matches.length > 0 && factsOnly.matches.every((m) => m.where === 'facts'), JSON.stringify(factsOnly.matches.map((m) => m.where)));

  const rendered = searchTool.output.render({}, none);
  check('无可渲染输出时不炸', Array.isArray(rendered) && typeof rendered[0].text === 'string', JSON.stringify(rendered));

  // 回归（真机踩到）：命中**没有 key 的条目**或**流水行**时，输出里曾漏出 `undefined`，
  // 而 DSH 要求无损 JSON → 整个 memory_search 调用直接失败（"value is not lossless JSON"）。
  const keyless = await searchTool.execute({ query: 'rmSync' }, { agent: toolAgent });
  check('命中无 key 条目时输出是无损 JSON', losslessError(keyless) === null, losslessError(keyless) ?? '');
  check('无 key 条目确实命中了（不是空结果蒙过去）', keyless.matches.length > 0 && keyless.matches.every((m) => !('key' in m)), JSON.stringify(keyless.matches.map((m) => Object.keys(m))));

  // 流水行没有 type/status/key —— 这些字段必须整条省掉，而不是留成 undefined
  fs.appendFileSync(path.join(L.root, 'journal.md'), '- 2026-01-01 流水：命名管道那条坑\n', 'utf8');
  const journalHit = await searchTool.execute({ query: '命名管道那条坑', where: 'journal' }, { agent: toolAgent });
  check('流水行能被检索到', journalHit.total > 0, JSON.stringify(journalHit).slice(0, 160));
  check('命中流水行时输出是无损 JSON', losslessError(journalHit) === null, losslessError(journalHit) ?? '');
  check(
    '流水行命中不含 type/status/key 字段（省掉而不是留 undefined）',
    journalHit.matches.every((m) => !('type' in m) && !('status' in m) && !('key' in m)),
    JSON.stringify(journalHit.matches.map((m) => Object.keys(m))),
  );
  check('memory_write 的输出也是无损 JSON', losslessError(await writeTool.execute({ type: 'fact', conclusion: '无损 JSON 探针' }, { agent: toolAgent })) === null);
}

/* ------------------------------------------------- 到期复核：真接线跑一遍 */

section('到期复核：通过插件真实接线发出 form=due 的提醒');
{
  // 造一条"早已过期"的条目（verify_when 是过去日期），直接写进 facts/
  const created = createEntry(L, { type: 'fact', id: 'stale-fact', conclusion: '该复核的老结论', source: 's2' });
  fs.writeFileSync(path.join(L.facts, 'stale-fact.md'), fs.readFileSync(created.file, 'utf8'), 'utf8');
  fs.unlinkSync(created.file);
  const stalePath = path.join(L.facts, 'stale-fact.md');
  fs.writeFileSync(stalePath, fs.readFileSync(stalePath, 'utf8').replace('verify_when: null', 'verify_when: 2000-01-01'), 'utf8');

  const dueCtx = fakeCtx();
  apply(dueCtx, { root: ROOT, maxBytes: 3072 });
  const agent = fakeAgent(cwdOfProject, 'session-due');

  // 传一份"已含全部当前记忆状态"的历史：这样 plan 是 none，走的正是到期提醒该出场的那条路
  const state = injectPayload(L, 3072).entries.map((e) => ({ id: e.id, hash: e.hash }));
  const seen = { id: 'seen', source: { kind: MEMORY_SOURCE_KIND, entries: state }, content: [{ type: 'text', text: '之前注入过' }] };
  const claimed = [{ id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, seen];
  const d = { kind: 'ok', messages: [...claimed] };

  const out = await dueCtx.handlers.get('agent/pre-step')({ agent, messages: claimed, step: 2 }, async () => d);
  const dueMsg = out.messages.find((m) => m.source?.form === 'due');
  check('插件接线能发出到期提醒', !!dueMsg, JSON.stringify(out.messages.map((m) => m.source?.form)));
  check('提醒通过真实 createUserMessage 构造', !!dueMsg && dueMsg.role === 'user' && Array.isArray(dueMsg.content), JSON.stringify(dueMsg?.content));
  check('提醒的 source.entries 是 undefined（不污染差分基线）', dueMsg && dueMsg.source.entries === undefined, JSON.stringify(dueMsg?.source));
  check('提醒文案含该复核的条目', !!dueMsg && /该复核的老结论/.test(dueMsg.content[0].text), dueMsg?.content[0].text.slice(0, 160));
  check('这一轮不重复注入记忆（desired 本来就是 null）', out.messages.filter((m) => m.source?.kind === MEMORY_SOURCE_KIND).length === 2, String(out.messages.length));

  // 同一个会话再跑一步 → 不再提醒
  const nextMessages = [...out.messages];
  const d2 = { kind: 'ok', messages: [...nextMessages] };
  const out2 = await dueCtx.handlers.get('agent/pre-step')({ agent, messages: nextMessages, step: 3 }, async () => d2);
  check('同一会话不重复提醒（真实接线）', out2 === d2, String(out2.messages.length));
  check('到期提醒没带来告警噪音', dueCtx.warnings.length === 0, JSON.stringify(dueCtx.warnings));

  // verify_when 写成**人话** → 一律不提醒（否则每个会话都弹一次、永远消不掉）
  fs.writeFileSync(stalePath, fs.readFileSync(stalePath, 'utf8').replace('verify_when: 2000-01-01', 'verify_when: 等换机器时'), 'utf8');
  const proseCtx = fakeCtx();
  apply(proseCtx, { root: ROOT, maxBytes: 3072 });
  const proseAgent = fakeAgent(cwdOfProject, 'session-prose');
  const state2 = injectPayload(L, 3072).entries.map((e) => ({ id: e.id, hash: e.hash }));
  const seen2 = { id: 'seen2', source: { kind: MEMORY_SOURCE_KIND, entries: state2 }, content: [{ type: 'text', text: '之前注入过' }] };
  const claimed2 = [{ id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, seen2];
  const d3 = { kind: 'ok', messages: [...claimed2] };
  const out3 = await proseCtx.handlers.get('agent/pre-step')({ agent: proseAgent, messages: claimed2, step: 2 }, async () => d3);
  check('verify_when 是人话时不提醒（真实接线）', out3 === d3, JSON.stringify(out3.messages.map((m) => m.source?.form)));

  // dueWithin 从插件 Config **真的透传**到 hook：条目 10 天后才到复核期，
  // 默认（0）不提醒，"提前 30 天"要提醒。只看 schema 有没有字段是不够的 —— 得走真接线。
  const soonRoot = path.join(SANDBOX, 'due-within', 'memory');
  ensureLayout(soonRoot);
  const soonL = ensureLayout(soonRoot, { create: false });
  const inTenDays = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const soonCreated = createEntry(soonL, { type: 'fact', id: 'soon-fact', conclusion: '十天后该复核的事', verifyWhen: inTenDays, source: 's1' });
  fs.writeFileSync(path.join(soonL.facts, 'soon-fact.md'), fs.readFileSync(soonCreated.file, 'utf8'), 'utf8');
  fs.unlinkSync(soonCreated.file);

  const soonCwd = path.join(SANDBOX, 'due-within');
  const soonState = injectPayload(soonL, 3072).entries.map((e) => ({ id: e.id, hash: e.hash }));
  const seenSoon = { id: 'seen-soon', source: { kind: MEMORY_SOURCE_KIND, entries: soonState }, content: [{ type: 'text', text: '之前注入过' }] };
  const claimedSoon = [{ id: 'u-soon', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, seenSoon];
  const dSoon = { kind: 'ok', messages: [...claimedSoon] };

  const offCtxSoon = fakeCtx();
  apply(offCtxSoon, { root: soonRoot });
  const outSoonOff = await offCtxSoon.handlers.get('agent/pre-step')({ agent: fakeAgent(soonCwd, 'session-soon-off'), messages: claimedSoon, step: 2 }, async () => dSoon);
  check('dueWithin 默认 0：还没到期的条目不提醒', outSoonOff === dSoon, JSON.stringify(outSoonOff.messages.map((m) => m.source?.form)));

  const onCtxSoon = fakeCtx();
  apply(onCtxSoon, { root: soonRoot, dueWithin: 30 });
  const outSoonOn = await onCtxSoon.handlers.get('agent/pre-step')({ agent: fakeAgent(soonCwd, 'session-soon-on'), messages: claimedSoon, step: 2 }, async () => dSoon);
  const dueSoon = outSoonOn.messages.find((m) => m.source?.form === 'due');
  check('dueWithin=30：还没到期但快了 → 提醒（Config 真的透传到了 hook）', !!dueSoon, JSON.stringify(outSoonOn.messages.map((m) => m.source?.form)));
  check('到期提醒里带上 verify_when 原值', !!dueSoon && dueSoon.content[0].text.includes(inTenDays), dueSoon?.content[0].text.slice(0, 120));
  check('dueWithin 生效时也不带 entries（不污染差分基线）', !!dueSoon && dueSoon.source.entries === undefined, JSON.stringify(dueSoon?.source));
}

/* ------------------------------------------------------------ 配置与容错 */

section('配置与容错');
{
  // enabled:false → 不注入（但工具仍在）
  const off = fakeCtx();
  apply(off, { enabled: false, root: ROOT });
  const agent = fakeAgent(cwdOfProject, 'session-off');
  const d = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  const out = await off.handlers.get('agent/pre-step')({ agent, messages: [], step: 2 }, async () => d);
  check('enabled:false 时不注入', out === d, String(out.messages.length));
  check('enabled:false 时工具仍注册', off.registered.length === 2);

  // root 指向不存在的目录 → 不注入、不抛异常、**零告警噪音**
  const empty = fakeCtx();
  const emptyHook = apply(empty, { root: path.join(SANDBOX, 'nope', 'memory') });
  const agent2 = fakeAgent(path.join(SANDBOX, 'nope'), 'session-nope');
  const d2 = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  const out2 = await empty.handlers.get('agent/pre-step')({ agent: agent2, messages: [], step: 2 }, async () => d2);
  check('记忆库不存在时不注入也不抛错', out2 === d2);
  // 连续跑两步：以前 due 字段漏在早退分支上时，每一步都会抛 TypeError 被 catch 成"加载失败"，
  // 于是这里会看到 2 条告警（`<= 1` 的旧阈值恰好放过了它）。现在必须**一条都没有**。
  const out2b = await empty.handlers.get('agent/pre-step')({ agent: agent2, messages: [], step: 3 }, async () => d2);
  check('记忆库不存在时第二步也不注入', out2b === d2, String(out2b.messages.length));
  check('记忆库不存在时连续两步零告警（早退分支字段齐全）', empty.warnings.length === 0, JSON.stringify(empty.warnings));

  // 直接钉住 planFor 的返回形状：任何返回路径上 due 都必须是数组。
  // （曾经早退分支漏了 due → 解构成 undefined → due.length 抛 TypeError 被 catch 成"加载失败"。）
  const planned = await emptyHook.planFor(agent2, [], d2);
  check('planFor 早退分支也返回 due 数组', Array.isArray(planned.due) && planned.due.length === 0, JSON.stringify(planned));
  check('planFor 早退分支的 plan/desired 为 null', planned.plan === null && planned.desired === null, JSON.stringify(planned).slice(0, 160));
  check('planFor 早退分支也返回 entries 数组', Array.isArray(planned.entries), JSON.stringify(planned).slice(0, 160));
  const plannedOk = await plugin.planFor(fakeAgent(cwdOfProject, 'session-plan'), [], { kind: 'ok', messages: [] });
  check('记忆库正常时 planFor 也返回 due 数组', Array.isArray(plannedOk.due), JSON.stringify(plannedOk).slice(0, 160));

  // 全新工作区：目录还不存在 —— memory_write 应该**按需创建**，而不是抛 ENOENT（真机预检抓到的）
  const freshRoot = path.join(SANDBOX, 'fresh', 'memory');
  const freshCtx = fakeCtx();
  apply(freshCtx, { root: freshRoot });
  const freshWrite = freshCtx.registered.find((t) => t.name === 'memory_write');
  const freshResult = await freshWrite.execute({ type: 'fact', conclusion: '新工作区里的第一条' }, { agent: fakeAgent(path.join(SANDBOX, 'fresh'), 'session-fresh') });
  check('新工作区里 memory_write 按需创建记忆库', fs.existsSync(path.join(freshRoot, 'inbox', `${freshResult.id}.md`)), freshResult.id);

  // 但**读路径不能有副作用**：只读取不该在用户每个工作区里都建出 memory/
  const readOnlyRoot = path.join(SANDBOX, 'readonly-probe', 'memory');
  const readCtx = fakeCtx();
  apply(readCtx, { root: readOnlyRoot });
  const agentRO = fakeAgent(path.join(SANDBOX, 'readonly-probe'), 'session-ro');
  const dRO = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  await readCtx.handlers.get('agent/pre-step')({ agent: agentRO, messages: [], step: 2 }, async () => dRO);
  await readCtx.registered.find((t) => t.name === 'memory_search').execute({ query: 'x' }, { agent: agentRO });
  check('读路径不创建目录（无副作用）', !fs.existsSync(readOnlyRoot), readOnlyRoot);

  // enabled:false → 工具明确报错，而不是静默什么都不做
  const offCtx = fakeCtx();
  apply(offCtx, { enabled: false, root: ROOT });
  const offWrite = offCtx.registered.find((t) => t.name === 'memory_write');
  let threw = null;
  try {
    await offWrite.execute({ type: 'fact', conclusion: 'x' }, { agent: toolAgent });
  } catch (e) {
    threw = e;
  }
  check('enabled:false 时 memory_write 明确报错', !!threw, String(threw?.message));
}

rmrf(SANDBOX);
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
