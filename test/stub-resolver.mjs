/**
 * 测试用的模块解析钩子：把插件 import 的 @deepseek-ai/* 重定向到 test/stubs/ 下的桩。
 * 用法：node --import ./test/stub-loader.mjs test/plugin-tests.mjs
 *
 * 为什么不用 node_modules 放桩：那会把测试垃圾塞进包目录，也不好解释。用 loader 更干净。
 */

import { fileURLToPath } from 'node:url';

const STUBS = {
  '@deepseek-ai/schemastery': './stubs/schemastery.mjs',
  '@deepseek-ai/dsh-tools': './stubs/dsh-tools.mjs',
  '@deepseek-ai/dsh-llm': './stubs/dsh-llm.mjs',
  '@deepseek-ai/cordis': './stubs/cordis.mjs',
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export const stubPaths = Object.fromEntries(
  Object.entries(STUBS).map(([k, v]) => [k, fileURLToPath(new URL(v, import.meta.url))]),
);
