/**
 * 测试用的 DSH 桩模块：把插件依赖的 4 个 @deepseek-ai 包换成最小实现，
 * 这样就能在**没有 DSH 的环境里**真正 `apply()` 这个插件并驱动它，
 * 而不是只做静态检查。真实环境里这些包由 DSH profile 提供。
 */

// @deepseek-ai/schemastery —— 只需要可链式调用、能取到默认值即可
const chain = (fallback) => {
  const node = {
    default: (v) => chain(v),
    step: () => node,
    min: () => node,
    max: () => node,
    required: () => node,
    __fallback: fallback,
  };
  return node;
};

export default {
  string: () => chain(''),
  number: () => chain(0),
  boolean: () => chain(false),
  array: () => chain([]),
  object: (spec) => spec,
};
