#!/usr/bin/env node
/**
 * `verify_when` → 到期复核（src/due.mjs）的单元测试 —— 纯逻辑，不碰文件系统、不依赖 DSH。
 * 跑：node test/due-tests.mjs
 *
 * 这里刻意把"散文写法"（"等换机器时"）也当成**正常输入**来断言：复核时机允许写成只有人看得懂
 * 的话，解析不出来不是错误，只是不会被主动提醒 —— 界限写清楚，免得以后有人把它改成报警告。
 */

import { collectDue, duePhrase, parseVerifyWhen, renderDue } from '../src/due.mjs';

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

const due = (v, from) => parseVerifyWhen(v, from).due;
const kind = (v, from) => parseVerifyWhen(v, from).kind;

/** collectDue 用的条目工厂（形状与 injectPayload().entries 对齐）。 */
const entry = (id, verifyWhen, date = '2026-01-01', line = `结论 ${id}`) => ({ id, line, date, verifyWhen });

/* ------------------------------------------------------------ 绝对日期 */
section('绝对日期：YYYY-MM-DD 原样采用');
{
  check('ISO 日期原样返回', due('2026-03-01') === '2026-03-01', String(due('2026-03-01')));
  check('ISO 日期的 kind 是 date', kind('2026-03-01') === 'date', kind('2026-03-01'));
  check('过去的日期也照收（判超期是 collectDue 的事）', due('2000-01-01') === '2000-01-01' && kind('2000-01-01') === 'date');
  check('前后空白被容忍', due('  2026-03-01  ') === '2026-03-01', String(due('  2026-03-01  ')));
  check('ISO 日期不受 fromDate 影响', due('2026-03-01', '坏日期') === '2026-03-01');
  check('非法月份（13 月）不当作日期', kind('2026-13-01') === 'unparsed', kind('2026-13-01'));
}

/* ------------------------------------------------------------ 相对写法 */
section('相对写法：天 / 周 / 个月 / 年');
{
  check('3 天后', due('3天后', '2026-01-01') === '2026-01-04', String(due('3天后', '2026-01-01')));
  check('10 天后（阿拉伯数字多位）', due('10天后', '2026-01-01') === '2026-01-11', String(due('10天后', '2026-01-01')));
  check('2 周后 = 14 天', due('2周后', '2026-01-01') === '2026-01-15', String(due('2周后', '2026-01-01')));
  check('1 个月后 = 下个月的同一日', due('1个月后', '2026-01-15') === '2026-02-15', String(due('1个月后', '2026-01-15')));
  check('省略「个」也认（N月后）', due('3月后', '2026-01-15') === '2026-04-15', String(due('3月后', '2026-01-15')));
  check('1 年后', due('1年后', '2026-01-01') === '2027-01-01', String(due('1年后', '2026-01-01')));
  check('相对写法 kind 是 relative', kind('1个月后', '2026-01-15') === 'relative', kind('1个月后', '2026-01-15'));
  check('「N天后」允许空格', due('2 天后', '2026-01-01') === '2026-01-03', String(due('2 天后', '2026-01-01')));
  check('周/星期/礼拜 等价', due('1星期后', '2026-01-01') === '2026-01-08' && due('1礼拜后', '2026-01-01') === '2026-01-08');

  // 中文数字 —— 实际写记忆时"半年后"这种比"6个月后"更常见
  check('中文数字：三个月后', due('三个月后', '2026-01-01') === '2026-04-01', String(due('三个月后', '2026-01-01')));
  check('中文数字：十天后', due('十天后', '2026-01-01') === '2026-01-11', String(due('十天后', '2026-01-01')));
  check('中文数字：十二个月后 = 一年', due('十二个月后', '2026-01-01') === '2027-01-01', String(due('十二个月后', '2026-01-01')));
  check('中文数字：两（= 二）', due('两周后', '2026-01-01') === '2026-01-15', String(due('两周后', '2026-01-01')));
  check('「半年后」是人话、不硬猜', kind('半年后', '2026-01-01') === 'unparsed', kind('半年后', '2026-01-01'));
}

/* ------------------------------------------------------ 立即 / 马上 / 现在 */
section('立即 / 马上 / 现在：就是条目自己那一天');
{
  check('立即 = fromDate', due('立即', '2026-01-01') === '2026-01-01', String(due('立即', '2026-01-01')));
  check('马上 = fromDate', due('马上', '2026-01-01') === '2026-01-01');
  check('现在 = fromDate', due('现在', '2026-02-28') === '2026-02-28', String(due('现在', '2026-02-28')));
  check('立即的 kind 是 relative', kind('立即', '2026-01-01') === 'relative', kind('立即', '2026-01-01'));
  check('立即但缺基准日 → unparsed', due('立即') === null && kind('立即') === 'unparsed');
}

/* ----------------------------------------------------- 缺基准 / 散文写法 */
section('缺基准日与散文写法：都算 unparsed，且不是错误');
{
  check('fromDate 缺失 → unparsed', kind('3个月后') === 'unparsed', kind('3个月后'));
  check('fromDate 缺失时 due 为 null', due('3个月后') === null, String(due('3个月后')));
  check('fromDate 非法 → unparsed', kind('3个月后', '2026/01/01') === 'unparsed', kind('3个月后', '2026/01/01'));
  check('fromDate 是散文 → unparsed', kind('2周后', '不记得了') === 'unparsed');

  for (const text of ['等换机器时', '看情况', '以后再也不要这样干了', '下次大版本升级的时候']) {
    check(`散文「${text}」→ unparsed（不报错）`, kind(text, '2026-01-01') === 'unparsed', kind(text, '2026-01-01'));
  }
  check('散文时 due 为 null', due('等换机器时', '2026-01-01') === null);

  check('null → unparsed', kind(null) === 'unparsed');
  check('undefined → unparsed', kind(undefined) === 'unparsed');
  check('空串 → unparsed', kind('') === 'unparsed');
  check('纯空白 → unparsed', kind('   ') === 'unparsed');
  check('空值不抛异常', parseVerifyWhen(null, null).due === null && parseVerifyWhen(null, null).kind === 'unparsed');
}

/* --------------------------------------------------------- UTC 日期算术 */
section('日期算术：UTC 口径 + 进位 + 跨年 + 闰年');
{
  // 1 月 31 日加 1 个月会"溢出"到 3 月 3 日（setUTCMonth 的顺延语义，可复现）
  check('月份溢出：2026-01-31 + 1 个月 = 2026-03-03', due('1个月后', '2026-01-31') === '2026-03-03', String(due('1个月后', '2026-01-31')));
  check('月份跨年：2026-12-15 + 1 个月 = 2027-01-15', due('1个月后', '2026-12-15') === '2027-01-15', String(due('1个月后', '2026-12-15')));
  check('天数跨年：2026-12-31 + 1 天 = 2027-01-01', due('1天后', '2026-12-31') === '2027-01-01', String(due('1天后', '2026-12-31')));
  check('年跨年：2026-06-01 + 1 年 = 2027-06-01', due('1年后', '2026-06-01') === '2027-06-01');
  check('闰年 2028-02-28 + 1 天 = 2028-02-29', due('1天后', '2028-02-28') === '2028-02-29', String(due('1天后', '2028-02-28')));
  check('平年 2026-02-28 + 1 天 = 2026-03-01', due('1天后', '2026-02-28') === '2026-03-01', String(due('1天后', '2026-02-28')));
  // 月份是"加 30 天近似"最容易露馅的地方：近似会给出 2026-03-15，正确结果是 2026-02-15
  check('月份不是 30 天近似', due('1个月后', '2026-01-15') !== '2026-02-14' && due('1个月后', '2026-01-15') === '2026-02-15');
}

/* ------------------------------------------------------------- collectDue */
section('collectDue：只有设了 verify_when 的才算到期');
{
  const entries = [
    entry('nodate', null),
    entry('empty', ''),
    entry('iso-over', '2000-01-01'),
    entry('today', '2026-03-01'),
    entry('soon', '2026-03-03'),
    entry('later', '2026-06-01'),
    entry('prose', '等换机器时'),
    entry('rel', '1个月后', '2026-01-15'),
  ];
  const today = '2026-03-01';

  const only = collectDue(entries, today);
  const ids = only.map((d) => d.id);
  check('没设 verify_when 的条目不出现在结果里（null）', !ids.includes('nodate'), ids.join(','));
  check('verify_when 为空串的条目也不出现', !ids.includes('empty'), ids.join(','));
  check('散文 verify_when 不算到期', !ids.includes('prose'), ids.join(','));
  check('未来的日期不算到期', !ids.includes('later'), ids.join(','));
  check('within=0 时只剩已超期/今天到期', ids.join(',') === 'iso-over,rel,today', ids.join(','));
  check('超期最久的排最前', only[0].id === 'iso-over', ids.join(','));
  check('今天到期的 overdueDays=0', only.find((d) => d.id === 'today').overdueDays === 0);
  check('超期条目 overdueDays 是正数', only.find((d) => d.id === 'iso-over').overdueDays > 0);
  check('相对写法算出的 due 也参与', only.find((d) => d.id === 'rel').due === '2026-02-15', String(only.find((d) => d.id === 'rel')?.due));
  check('结果带回 verifyWhen 原文', only.find((d) => d.id === 'rel').verifyWhen === '1个月后');
  check('结果带回结论正文', only.find((d) => d.id === 'today').line === '结论 today');
  check('unparsed 恒为 false（散文已被排除在外）', only.every((d) => d.unparsed === false));
  // 关键：人话写法**不是**到期项 —— 否则它会每个会话都提醒一次、且永远消不掉
  check('散文条目连 due 都没有', only.every((d) => typeof d.due === 'string'), JSON.stringify(only.map((d) => d.due)));
}

section('collectDue：overdueDays 正负零与排序');
{
  const today = '2026-03-10';
  const list = collectDue([entry('over', '2026-03-05'), entry('zero', '2026-03-10'), entry('later', '2026-03-12')], today, { within: 5 });
  const byId = Object.fromEntries(list.map((d) => [d.id, d]));
  check('已超期 5 天', byId.over?.overdueDays === 5, String(byId.over?.overdueDays));
  check('今天到期 = 0', byId.zero?.overdueDays === 0, String(byId.zero?.overdueDays));
  check('还有 2 天 = -2（within 内会返回）', byId.later?.overdueDays === -2, String(byId.later?.overdueDays));
  check('within > 0 时负数条目也返回', list.length === 3, String(list.length));
  check('排序：超期多的在前（负数在最后）', list.map((d) => d.id).join(',') === 'over,zero,later', list.map((d) => d.id).join(','));

  const sameDay = collectDue([entry('b', '2026-03-05'), entry('a', '2026-03-05')], today, { within: 0 });
  check('同分按 id 排序', sameDay.map((d) => d.id).join(',') === 'a,b', sameDay.map((d) => d.id).join(','));

  const narrow = collectDue([entry('later', '2026-03-12')], today);
  check('within=0 时不返回还没到期的', narrow.length === 0, String(narrow.length));
  const wide = collectDue([entry('later', '2026-03-12')], today, { within: 2 });
  check('within=2 刚好覆盖 2 天后到期', wide.length === 1, String(wide.length));

  check('limit 截断', collectDue([entry('a', '2026-03-05'), entry('b', '2026-03-06')], today, { limit: 1 }).length === 1);
  check('空输入 → 空结果', collectDue([], today).length === 0);
  check('today 非法 → 空结果（不抛异常）', collectDue([entry('a', '2026-03-05')], '不是日期').length === 0);
  check('默认参数可省略', collectDue([entry('a', '2026-03-05')], today).length === 1);
}

/* --------------------------------------------------------------- renderDue */
section('renderDue：注入文案');
{
  const list = collectDue([entry('a', '2000-01-01', '2026-01-01', '甲结论'), entry('b', '2026-03-01', '2026-01-01', '乙结论')], '2026-03-01');
  const text = renderDue(list);
  check('用 system-reminder 包裹', text.startsWith('<system-reminder>') && text.endsWith('</system-reminder>'), text.slice(0, 40));
  check('每条一行、带结论正文', text.includes('- 甲结论') && text.includes('- 乙结论'), text.slice(0, 200));
  check('行内带 verify_when 原值', text.includes('verify_when: 2000-01-01') && text.includes('verify_when: 2026-03-01'), text.slice(0, 300));
  check('超期条目写「已超期 N 天」', /甲结论.*（已超期 \d+ 天）/.test(text), text.slice(0, 300));
  check('今天到期写「今天到期」', /乙结论.*（今天到期）/.test(text), text.slice(0, 300));
  check('给出可执行的下一步：supersede', text.includes('mem supersede'), text.slice(-260));
  check('给出可执行的下一步：set --status expired', text.includes('mem set <id> --status expired'), text.slice(-260));
  check('仍然成立的可以推后 verify_when', text.includes('--verify-when'), text.slice(-260));
  check('结尾有「不用管」的退出口', text.includes('忽略本条'), text.slice(-80));
  check('文案足够短（< 700 字节）', Buffer.byteLength(text, 'utf8') < 700, String(Buffer.byteLength(text, 'utf8')));

  // 未来条目落在 within 里时，措辞是「还有 N 天」
  const soonText = renderDue(collectDue([entry('s', '2026-03-05', '2026-01-01', '丙结论')], '2026-03-01', { within: 7 }));
  check('未到期条目写「还有 N 天」', /丙结论.*（还有 4 天）/.test(soonText), soonText.slice(0, 300));

  // 上限与「另有 N 条」
  const many = collectDue(
    Array.from({ length: 8 }, (_, i) => entry(`e${i}`, '2026-02-01', '2026-01-01', `结论 ${i}`)),
    '2026-03-01',
  );
  const capped = renderDue(many);
  // 只数"条目行"：正文行里带 verify_when，说明行/收尾的建议行都不带
  const itemLines = (t) => t.split('\n').filter((l) => l.startsWith('- ') && l.includes('verify_when:')).length;
  check('默认最多列 5 条', itemLines(capped) === 5, String(itemLines(capped)));
  check('超出部分补「另有 3 条也到期了」', capped.includes('（另有 3 条也到期了）'), capped.slice(0, 400));
  const one = renderDue(many, { max: 1 });
  check('max 可调（max:1 只列 1 条）', itemLines(one) === 1 && one.includes('（另有 7 条也到期了）'), one.slice(0, 300));

  const proseOnly = collectDue([entry('p', '等换机器时')], '2026-03-01');
  check('只写了人话的 → collectDue 返回空（不触发提醒，见 hook-tests）', proseOnly.length === 0, JSON.stringify(proseOnly));
  check('因此 renderDue 也返回空字符串', renderDue(proseOnly) === '', renderDue(proseOnly));

  check('空列表 → 空字符串（一个字都不注入）', renderDue([]) === '');
  check('null 安全', renderDue(null) === '');
}

/* ------------------------------------------------------------------ 措辞 */
section('duePhrase');
{
  check('正数 → 已超期 N 天', duePhrase(3) === '已超期 3 天', duePhrase(3));
  check('0 → 今天到期', duePhrase(0) === '今天到期', duePhrase(0));
  check('负数 → 还有 N 天', duePhrase(-2) === '还有 2 天', duePhrase(-2));
  check('null → 已到期', duePhrase(null) === '已到期', duePhrase(null));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
