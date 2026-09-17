#!/usr/bin/env node
/**
 * 记忆插件「接线逻辑」的测试 —— 用**假的 agent / decision** 模拟 DSH 的 pre-step 合约，
 * 因此在没有 DSH 的环境里也能完整验证插件行为（这是刻意的设计：决策逻辑与 DSH 解耦）。
 *
 * 跑：node test/hook-tests.mjs
 */

import { createMemoryHook, isMemoryMessage, sameMemoryPayload } from '../src/hook.mjs';
import { MEMORY_SOURCE_KIND } from '../src/planner.mjs';

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
const section = (t) => console.log(`\n${t}`);

/* -------------------------------------------------------------- 假 DSH */

let seq = 0;
/** 等价于 createUserMessage({content:[{type:'text',text}], source:{kind:'memory', ...}}) */
function fakeCreateMessage(text, entries, form) {
  seq += 1;
  return {
    id: `mem-${seq}`,
    content: [{ type: 'text', text }],
    source: {
      kind: MEMORY_SOURCE_KIND,
      ...(Array.isArray(entries) ? { entries } : {}),
      ...(form ? { form } : {}),
    },
  };
}

function fakeAgent(cwd = 'D:\\proj') {
  const nextStep = [];
  return {
    session: { header: { cwd } },
    inbox: {
      nextStep,
      prepend(queue, message) {
        if (queue !== 'next-step') throw new Error(`unexpected queue: ${queue}`);
        nextStep.unshift(message);
      },
      replace(id, message) {
        const i = nextStep.findIndex((m) => m.id === id);
        if (i < 0) throw new Error(`replace: id not found: ${id}`);
        nextStep[i] = message;
      },
      remove(id) {
        const i = nextStep.findIndex((m) => m.id === id);
        if (i >= 0) nextStep.splice(i, 1);
      },
    },
  };
}

const entry = (id, hash, extra = {}) => ({ id, hash, type: 'fact', key: null, line: `结论 ${id}`, ...extra });

/** 造一个 hook；payload（条目集合）可以在测试中途改。 */
function makeHook(entriesRef, { logger = { warn() {} }, nudgeAfterTurns = 99 } = {}) {
  return createMemoryHook({
    loadPayload: async () => ({ entries: entriesRef.current, budget: 3072 }),
    createMessage: fakeCreateMessage,
    logger,
    // 默认把蒸馏提醒关掉（设很大），免得干扰别的用例；提醒本身有专门的测试段
    nudgeAfterTurns,
  });
}

/* --------------------------------------------------- 第一次：路走到 inbox */
section('step 1（本步还没开始）→ 只排队进 inbox');
{
  const entries = { current: [entry('a', 'h1')] };
  const hook = makeHook(entries);
  const agent = fakeAgent();
  const messages = [];
  const decision = { kind: 'ok', messages: [] };

  const out = await hook.handlePreStep({ agent, messages, step: 1 }, async () => decision);
  check('decision 原样返回（本步不动它）', out === decision);
  check('消息进了 inbox', agent.inbox.nextStep.length === 1);
  check('进的是我们的消息', isMemoryMessage(agent.inbox.nextStep[0]));
  check('内容是全量 baseline', agent.inbox.nextStep[0].content[0].text.includes('结论 a'));
  check('source 带上一轮状态（供下轮差分）', JSON.stringify(agent.inbox.nextStep[0].source.entries) === JSON.stringify([{ id: 'a', hash: 'h1' }]));
}

/* ------------------------------------------- 第二次：没有变化 → 什么都不做 */
section('第二轮（记忆没变化）→ 零注入');
{
  const entries = { current: [entry('a', 'h1')] };
  const hook = makeHook(entries);
  const agent = fakeAgent();
  const previous = fakeCreateMessage('whatever', [{ id: 'a', hash: 'h1' }]);
  const messages = [previous];
  const decision = { kind: 'ok', messages: [previous] };

  agent.inbox.nextStep.push(fakeCreateMessage('陈旧排队', [{ id: 'a', hash: 'OLD' }]));
  const out = await hook.handlePreStep({ agent, messages, step: 2 }, async () => decision);
  check('没有新消息被插入', out.messages.length === decision.messages.length, JSON.stringify(out.messages.length));
  check('陈旧的排队消息被清掉', agent.inbox.nextStep.length === 0, `剩 ${agent.inbox.nextStep.length}`);
}

/* ------------------------------------------------- 第二轮：有变化 → 只推差异 */
section('第二轮（记忆变了）→ 只注入变化块，且插在已领取消息之后');
{
  const entries = { current: [entry('a', 'h1'), entry('b', 'h2')] };
  const hook = makeHook(entries);
  const agent = fakeAgent();
  const prev = fakeCreateMessage('旧的全量', [{ id: 'a', hash: 'h1' }]);
  const claimed = [{ id: 'user-1', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, prev];
  const decision = { kind: 'ok', messages: [...claimed] };

  const out = await hook.handlePreStep({ agent, messages: claimed, step: 2 }, async () => decision);
  check('插入了 1 条新消息', out.messages.length === claimed.length + 1, String(out.messages.length));
  const inserted = out.messages.find((m) => isMemoryMessage(m) && m !== prev);
  check('插入的是记忆消息', !!inserted);
  check('插入位置在最后一条已领取消息之后', out.messages.indexOf(inserted) === out.messages.indexOf(prev) + 1, `at ${out.messages.indexOf(inserted)} vs prev ${out.messages.indexOf(prev)}`);
  check('内容是 delta（含"新增"）', /新增：/.test(inserted.content[0].text), inserted.content[0].text.slice(0, 80));
  check('delta 不复述未变化条目', !inserted.content[0].text.includes('结论 a'));
  check('带上了新的完整状态', JSON.stringify(inserted.source.entries) === JSON.stringify([{ id: 'a', hash: 'h1' }, { id: 'b', hash: 'h2' }]));
}

/* --------------------------------------------------------- 重复调用的幂等 */
section('同一步里 pre-step 再次触发 → 不重复插入');
{
  const entries = { current: [entry('a', 'h1')] };
  const hook = makeHook(entries);
  const agent = fakeAgent();
  const mine = fakeCreateMessage('已注入', [{ id: 'a', hash: 'h1' }]);
  const claimed = [{ id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }];
  const decision = { kind: 'ok', messages: [...claimed, mine] };

  const out = await hook.handlePreStep({ agent, messages: claimed, step: 3 }, async () => decision);
  check('没有插入第二条', out.messages.length === decision.messages.length, String(out.messages.length));
}

/* ------------------------------------------------------- reject / 空记忆库 */
section('边界：reject 决策、空记忆库、加载失败');
{
  // reject → 只走 inbox
  const entries = { current: [entry('a', 'h1')] };
  {
    const hook = makeHook(entries);
    const agent = fakeAgent();
    const decision = { kind: 'reject', messages: [] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 2 }, async () => decision);
    check('reject 时 decision 不变', out === decision);
    check('reject 时消息仍进 inbox', agent.inbox.nextStep.length === 1, String(agent.inbox.nextStep.length));
  }

  // 记忆库为空 → 清掉排队，不注入
  {
    const hook = makeHook({ current: [] });
    const agent = fakeAgent();
    agent.inbox.nextStep.push(fakeCreateMessage('陈旧', [{ id: 'x', hash: 'h' }]));
    const decision = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 2 }, async () => decision);
    check('空记忆库不注入', out.messages.length === 1);
    check('空记忆库清掉陈旧排队', agent.inbox.nextStep.length === 0);
  }

  // 加载失败 → 记日志 + 放行
  {
    const warned = [];
    const hook = createMemoryHook({
      loadPayload: async () => {
        throw new Error('磁盘炸了');
      },
      createMessage: fakeCreateMessage,
      logger: { warn: (...a) => warned.push(a[0]) },
    });
    const agent = fakeAgent();
    const decision = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
    const out = await hook.handlePreStep({ agent, messages: [], step: 2 }, async () => decision);
    check('加载失败时 decision 原样返回', out === decision);
    check('加载失败被记录', warned.length === 1, JSON.stringify(warned));
  }
}

/* ----------------------------------------------------------- 会话恢复场景 */
section('会话恢复 / 回放：从会话表面恢复状态');
{
  const entries = { current: [entry('a', 'h1')] };
  const hook = makeHook(entries);
  const memoryMsg = fakeCreateMessage('之前注入过的全量', [{ id: 'a', hash: 'h1' }]);
  const agent = fakeAgent();
  // 模拟：消息已经落盘到会话表面（surface），本步还没有任何已领取消息
  agent.session.surface = { nodes: [1, 2] };
  agent.session.eventAt = (seq) =>
    seq === 1 ? { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } } : { type: 'user/message', data: memoryMsg };

  const decision = { kind: 'ok', messages: [{ id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }] };
  const out = await hook.handlePreStep({ agent, messages: [], step: 5 }, async () => decision);
  check('恢复后识别出状态、不重复注入', out.messages.length === 1, String(out.messages.length));
  check('恢复时 decision 原样返回', out === decision);

  // 表面上的是旧状态 → 应该只推差异
  const agent2 = fakeAgent();
  agent2.session.surface = { nodes: [1] };
  agent2.session.eventAt = () => ({ type: 'user/message', data: fakeCreateMessage('旧的', [{ id: 'a', hash: 'STALE' }]) });
  const entries2 = { current: [entry('a', 'h1')] };
  const hook2 = makeHook(entries2);
  const d2 = { kind: 'ok', messages: [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }] };
  const out2 = await hook2.handlePreStep({ agent: agent2, messages: [], step: 5 }, async () => d2);
  check('表面状态陈旧 → 推差异而不是全量', out2.messages.length === 2 && /已更新：/.test(out2.messages[1].content[0].text), out2.messages.map((m) => m.content[0].text.slice(0, 20)).join(' | '));
}

/* ------------------------------------------------------- 蒸馏提醒（M3 第三块） */
section('会话结束蒸馏钩子：长会话里提醒一次，且不污染差分状态');
{
  const entries = { current: [entry('a', 'h1')] };
  const agent = fakeAgent();
  const seen = fakeCreateMessage('已注入', [{ id: 'a', hash: 'h1' }]);
  const claimed = [{ id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }];

  // 轮次还没到 → 不提醒
  const hook1 = makeHook(entries, { nudgeAfterTurns: 4 });
  const d1 = { kind: 'ok', messages: [...claimed, seen] };
  const o1 = await hook1.handlePreStep({ agent, messages: claimed, step: 2 }, async () => d1);
  check('轮次未到时不安慰/不提醒', o1.messages.length === d1.messages.length, String(o1.messages.length));

  // 轮次到了 → 提醒一次
  const hook2 = makeHook(entries, { nudgeAfterTurns: 4 });
  const d2 = { kind: 'ok', messages: [...claimed, seen] };
  const o2 = await hook2.handlePreStep({ agent, messages: claimed, step: 5 }, async () => d2);
  check('长会话触发蒸馏提醒', o2.messages.length === d2.messages.length + 1, String(o2.messages.length));
  const nudge = o2.messages.find((m) => m.source?.form === 'nudge');
  check('提醒消息带 form=nudge', !!nudge, JSON.stringify(o2.messages.map((m) => m.source)));
  check('提醒**不带** entries（不污染状态）', nudge && !('entries' in nudge.source), JSON.stringify(nudge?.source));
  check('提醒文案提到 memory_write', !!nudge && /memory_write/.test(nudge.content[0].text));

  // 同会话再触发 → 不再提醒
  const claimed2 = [...o2.messages];
  const d3 = { kind: 'ok', messages: [...claimed2] };
  const o3 = await hook2.handlePreStep({ agent, messages: claimed2, step: 7 }, async () => d3);
  check('同一会话只提醒一次', o3.messages.length === d3.messages.length, String(o3.messages.length));

  // 关键回归：提醒之后，下一轮仍能正确算差分（不能因为提醒而全量重灌）
  const agent2 = fakeAgent();
  const hook3 = makeHook(entries, { nudgeAfterTurns: 4 });
  const stateMsg = fakeCreateMessage('全量', [{ id: 'a', hash: 'h1' }]);
  const c = [{ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }];
  const dNudge = { kind: 'ok', messages: [...c, stateMsg] };
  const outNudge = await hook3.handlePreStep({ agent: agent2, messages: c, step: 6 }, async () => dNudge);
  check('提醒确实插进来了', outNudge.messages.some((m) => m.source?.form === 'nudge'));
  const afterNudge = [...outNudge.messages];
  const dNext = { kind: 'ok', messages: [...afterNudge] };
  const outNext = await hook3.handlePreStep({ agent: agent2, messages: afterNudge, step: 7 }, async () => dNext);
  check('提醒之后下一轮不重复注入（差分状态未被提醒污染）', outNext === dNext, `len=${outNext.messages.length}`);
}

/* ----------------------------------------------------------- 幂等与工具函数 */
section('工具函数');
{
  check('isMemoryMessage 识别自己', isMemoryMessage({ source: { kind: MEMORY_SOURCE_KIND } }));
  check('isMemoryMessage 不误判别的插件', !isMemoryMessage({ source: { kind: 'agent-instructions' } }));
  check('isMemoryMessage 不误判用户消息', !isMemoryMessage({ source: { kind: 'user' } }));
  check('isMemoryMessage 容忍 null', !isMemoryMessage(null));

  const a = fakeCreateMessage('same', [{ id: 'x', hash: 'h' }]);
  const b = fakeCreateMessage('same', [{ id: 'x', hash: 'h' }]);
  const c = fakeCreateMessage('same', [{ id: 'x', hash: 'DIFFERENT' }]);
  check('同内容同状态 → 等价', sameMemoryPayload(a, b));
  check('状态不同 → 不等价', !sameMemoryPayload(a, c));
  check('null 安全', !sameMemoryPayload(a, null));

  let threw = false;
  try {
    createMemoryHook({ createMessage: fakeCreateMessage });
  } catch {
    threw = true;
  }
  check('缺少 loadPayload 时构造报错', threw);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
