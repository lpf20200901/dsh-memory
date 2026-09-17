/**
 * 桩：@deepseek-ai/dsh-llm
 * 真实实现（见 dsh-agent-instructions 的用法）是：
 *   createUserMessage({ content: [{type:'text', text}], source })
 * 这里保持同样的入参/出参形状。
 */
let seq = 0;

export function createUserMessage({ content, source }) {
  seq += 1;
  return { id: `stub-msg-${seq}`, role: 'user', content, source };
}

export function resetStubMessageIds() {
  seq = 0;
}
