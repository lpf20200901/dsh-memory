/**
 * dsh-memory 的 **DSH 插件**（Cordis）。
 *
 * 这一层刻意做得很薄：所有决策逻辑都在 `hook.mjs`（已单测，用假 agent/decision 完整覆盖），
 * 这里只负责三件事 —— 读配置、把 DSH 的依赖注进去、注册 pre-step 与两个工具。
 * 这样即使插件本身没法在无 DSH 环境里跑，它的行为也是被测试覆盖的。
 *
 * 与上游 `@deepseek-ai/dsh-agent-instructions` 的关系：**共存，不替换**。
 * 那个插件负责把 AGENTS.md 等工作区指令文件推进上下文；本插件负责把结构化的长期记忆
 * 推进上下文，并且**只推变化的部分**（上游没有差分，文件一变就整篇重注入）。
 */

import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { collectDocs, createEntry, ensureLayout, injectPayload, loadConfig } from '../bin/mem.mjs';
import { createMemoryHook } from './hook.mjs';
import { MEMORY_SOURCE_KIND } from './planner.mjs';
import { rankDocs } from './search.mjs';

export const name = 'memory';
export const inject = ['tools'];

export const Config = z.object({
  /** 记忆库根目录；留空则用会话工作目录下的 `memory/`。 */
  root: z.string().default(''),
  /** 首次（baseline）注入的字节预算；差分注入通常远小于它。 */
  maxBytes: z.number().step(1).min(256).default(3072),
  /** 关掉注入但保留工具（调试用）。 */
  enabled: z.boolean().default(true),
});

/** 把 (config, cwd) 解析成一次可用的记忆库句柄。 */
function openStore(config, cwd, { forWrite = false } = {}) {
  if (config.enabled === false) return null;
  const root = config.root ? path.resolve(config.root) : path.join(cwd ?? process.cwd(), 'memory');
  // 读的时候**绝不产生副作用**（不能在用户每个工作区里都建出 memory/ 目录）；
  // 只有真要写（memory_write）时才按需建目录 —— 否则在一个还没有 memory/ 的工作区里，
  // 工具会抛出让人摸不着头脑的 ENOENT（真机预检抓到的）。
  const L = ensureLayout(root, { create: forWrite });
  const fileConfig = loadConfig(root);
  const budget = config.maxBytes || fileConfig?.injectBudget || 3072;
  // 会话工作区是权威的 scope，显式传下去 —— 否则 createEntry 会退到记忆库声明或
  // process.cwd()，而插件的 process.cwd() 是 harness 的 launch-root（真机试用踩到）。
  const scope = `workspace:${cwd ?? process.cwd()}`;
  return { root, L, budget, scope };
}

const truncated = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function apply(ctx, config = {}) {
  const storeOf = (cwd, opts) => openStore(config, cwd, opts);

  /* ------------------------------------------------------------ 注入 */
  const hook = createMemoryHook({
    loadPayload: async (cwd) => {
      const store = storeOf(cwd);
      if (!store) return null;
      try {
        return injectPayload(store.L, store.budget);
      } catch (error) {
        ctx.logger?.warn?.('memory: 读取记忆库失败 %o', error);
        return null;
      }
    },
    createMessage: (text, entries, form) =>
      createUserMessage({
        content: [{ type: 'text', text }],
        // entries 只在携带状态时出现；蒸馏提醒（form='nudge'）故意不带 entries，
        // 这样它不会被当成"上一轮状态"而把差分基线清零。
        source: {
          kind: MEMORY_SOURCE_KIND,
          ...(Array.isArray(entries) ? { entries } : {}),
          ...(form ? { form } : {}),
        },
      }),
    logger: ctx.logger,
  });

  ctx.on('agent/pre-step', (input, next) => hook.handlePreStep(input, next));

  /* -------------------------------------------------------- 读取工具 */
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        'Search the project long-term memory (dsh-memory): confirmed facts, decisions, the journal, ' +
        'the session index, and the inbox of pending candidates. Use it when the user refers to past ' +
        'decisions, conventions, or "we already figured this out". Results are ranked by relevance and ' +
        'each carries a snippet; Chinese queries are matched by bigram, so no need to add spaces.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keywords to look for (id, conclusion, key, tags, journal text). Chinese works without spaces.',
        },
        where: {
          type: 'string',
          enum: ['all', 'facts', 'decisions', 'inbox', 'archive', 'journal', 'sessions', 'index'],
          description: 'Narrow the search to one layer. Default all.',
        },
        limit: { type: 'integer', description: 'Max matches to return. Default 20.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true },
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  where: { type: 'string', required: true },
                  type: { type: 'string' },
                  status: { type: 'string' },
                  key: { type: 'string' },
                  line: { type: 'string', required: true },
                  snippet: { type: 'string' },
                  score: { type: 'number' },
                  matched: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.total === 0 ? 'No memory entries matched.' : `Matched ${value.total} memory entr${value.total === 1 ? 'y' : 'ies'}.`,
          },
        ],
      },
      execute(args, exec) {
        const store = storeOf(exec?.agent?.session?.header?.cwd);
        if (!store) return Promise.resolve({ total: 0, matches: [] });
        const limit = Number.isFinite(args.limit) ? Number(args.limit) : 20;
        const want = args.where ?? 'all';

        // 检索逻辑与 `mem recall` 完全共用（src/search.mjs）：分词、打分、片段只有一份实现
        const docs = collectDocs(store.L, { where: want });
        const hits = rankDocs(docs, args.query, { limit });

        const matches = hits.map((h) => ({
          id: h.id,
          where: h.where,
          type: h.type,
          status: h.status,
          key: h.key ?? undefined,
          line: truncated(h.line, 240),
          snippet: truncated(h.snippet, 240),
          score: Number(h.score.toFixed(2)),
          matched: h.matched,
        }));

        return Promise.resolve({ total: matches.length, matches });
      },
      presentCall: (args) => ({ card: 'generic', title: `Search memory: ${truncated(args.query, 60)}`, kind: 'other', rawInput: args }),
    }),
  );

  /* -------------------------------------------------------- 写入工具 */
  ctx.tools.register(
    defineTool({
      name: 'memory_write',
      description:
        'Record a durable candidate entry into the project memory INBOX. Use it when the user expresses a ' +
        'preference, fixes a convention, reaches a conclusion, or hits a pitfall worth remembering. ' +
        'Entries land in inbox/ and do NOT get injected until a human promotes them to the fact layer — ' +
        'so write freely, but write conclusions (not process).',
      parameters: {
        type: { type: 'string', required: true, enum: ['fact', 'decision'], description: 'fact = a truth about the project; decision = a choice plus its reason.' },
        conclusion: { type: 'string', required: true, description: 'One-line conclusion, not a narrative.' },
        reason: { type: 'string', description: 'Why it holds / why it was chosen.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Topic tags for later retrieval.' },
        key: { type: 'string', description: 'Semantic key: only one active fact may exist per key. Lowercase, [a-z0-9._-].' },
        id: { type: 'string', description: 'Optional short explicit id; derived from the conclusion when omitted.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Recorded candidate ${value.id} in the memory inbox (not yet injected; needs promotion to become a standing fact).`,
          },
        ],
      },
      execute(args, exec) {
        // forWrite：允许按需建出记忆库目录（读路径绝不建目录）
        const store = storeOf(exec?.agent?.session?.header?.cwd, { forWrite: true });
        if (!store) throw new Error('memory_write: 记忆库不可用（检查插件配置 enabled/root）');
        const created = createEntry(store.L, {
          type: args.type,
          conclusion: args.conclusion,
          reason: args.reason,
          tags: args.tags,
          key: args.key,
          id: args.id,
          scope: store.scope,
          source: exec?.agent?.session?.header?.id ?? null,
        });
        return Promise.resolve({ id: created.id, status: 'inbox' });
      },
      presentCall: (args) => ({ card: 'generic', title: `Remember: ${truncated(args.conclusion, 60)}`, kind: 'other', rawInput: args }),
    }),
  );
}
