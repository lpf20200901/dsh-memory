/**
 * 桩：@deepseek-ai/dsh-tools
 * 真实实现会做参数校验与渲染，这里只保留"能拿到工具定义"这一点 ——
 * 我们要验证的是插件的注册行为与 execute 逻辑，不是 DSH 的框架细节。
 */
export const defineTool = (definition) => definition;
