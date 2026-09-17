/**
 * 真机预检 —— 必须在 **DSH profile 的 node_modules 里**运行，这样 `@deepseek-ai/*`
 * 才会解析到真实实现（而不是 test/stubs 里的桩）。
 *
 * 它验证的是桩测试覆盖不到的那部分：真实的 `defineTool` / `schemastery` 是否接受我们的定义。
 * 跑法（用 DSH 自带的 node）：
 *   <DSH_HOME>\.desktop-bin\node.cmd <profile>\node_modules\dsh-memory\test\preflight-import.mjs
 *
 * 退出码 0 = 预检通过；非 0 = 有问题，**此时不要把它加进 profile**。
 */

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push([ok, name, detail]);
  if (!ok) failed += 1;
}

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const storeRoot = process.env.MEM_PREFLIGHT_ROOT || `${here}.preflight-store/memory`;

try {
  const mod = await import(new URL('../src/plugin.mjs', import.meta.url).href);
  check('插件模块可加载（真实 @deepseek-ai/* 全部解析成功）', true);
  check('导出 name = memory', mod.name === 'memory', String(mod.name));
  check('导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject));
  check('导出 apply 是函数', typeof mod.apply === 'function');
  // 真实的 schemastery 返回的是 Schema 实例（自有键是 type/meta/toString/dict），
  // 所以要看它有没有把我们的字段解析进去，而不是看它像不像普通对象。
  const configKeys = mod.Config?.dict ? Object.keys(mod.Config.dict) : Object.keys(mod.Config ?? {});
  check(
    '真实 schemastery 解析出了 root/maxBytes/enabled',
    ['root', 'maxBytes', 'enabled'].every((k) => configKeys.includes(k)),
    configKeys.join(','),
  );
  try {
    const normalized = typeof mod.Config === 'function' ? mod.Config({}) : null;
    check('Config({}) 能取到默认值 maxBytes=3072', !normalized || normalized.maxBytes === 3072, JSON.stringify(normalized));
  } catch (error) {
    check('Config({}) 不应抛异常', false, `${error?.name}: ${error?.message}`);
  }

  /* ---- 用假 ctx 真 apply，看真实 defineTool 是否接受我们的工具定义 ---- */
  const handlers = new Map();
  const registered = [];
  const warnings = [];
  const ctx = {
    on: (event, fn) => handlers.set(event, fn),
    tools: { register: (tool) => registered.push(tool) },
    logger: { warn: (...a) => warnings.push(String(a[0])) },
    get: () => undefined,
  };

  mod.apply(ctx, { root: storeRoot, maxBytes: 3072, enabled: true });

  check('真实 defineTool 接受了两个工具定义', registered.length === 2, registered.map((t) => t.name).join(','));
  check('注册了 agent/pre-step', typeof handlers.get('agent/pre-step') === 'function');
  for (const tool of registered) {
    check(`${tool.name} 有 name/description/parameters/execute`, !!tool.name && !!tool.description && !!tool.parameters && typeof tool.execute === 'function');
  }

  /* ---- 工具真的能读写（真实模块链路） ---- */
  const agent = {
    session: { header: { cwd: `${here}.preflight-store`, id: 'preflight' } },
    inbox: { nextStep: [], prepend() {}, replace() {}, remove() {} },
  };

  const writeTool = registered.find((t) => t.name === 'memory_write');
  const searchTool = registered.find((t) => t.name === 'memory_search');

  const written = await writeTool.execute(
    { type: 'fact', conclusion: '真机预检写入的条目', tags: ['preflight'], key: 'preflight-entry' },
    { agent },
  );
  check('memory_write 返回 id/status', !!written.id && written.status === 'inbox', JSON.stringify(written));

  const found = await searchTool.execute({ query: '真机预检' }, { agent });
  check('memory_search 找得到刚写的条目', found.total >= 1, JSON.stringify(found).slice(0, 160));

  const renderWrite = writeTool.output?.render?.({}, written);
  check('memory_write 的 render 可用', Array.isArray(renderWrite) && typeof renderWrite[0]?.text === 'string');
  const renderSearch = searchTool.output?.render?.({}, found);
  check('memory_search 的 render 可用', Array.isArray(renderSearch) && typeof renderSearch[0]?.text === 'string');

  /* ---- 差分注入链路（真实模块 + 真 pre-step） ---- */
  const preStep = handlers.get('agent/pre-step');
  const step1Decision = { kind: 'ok', messages: [] };
  const out1 = await preStep({ agent: { ...agent, inbox: { nextStep: [], prepend(q, m) { this.nextStep.unshift(m); }, replace() {}, remove() {} } }, messages: [], step: 1 }, async () => step1Decision);
  check('pre-step 在 step 1 不打断 decision', out1 === step1Decision);
} catch (error) {
  check('预检未抛异常', false, `${error?.name}: ${error?.message}`);
}

console.log('\n=== 真机预检 ===');
for (const [ok, name, detail] of results) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}
console.log(`\n${results.length - failed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
