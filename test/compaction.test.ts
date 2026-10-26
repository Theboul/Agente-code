import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { compactIfNeeded, estimateTokens } from '../src/agent/compaction.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function summaryModel() {
  const parts = [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'RESUMEN DE LA CONVERSACIÓN' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ];
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'RESUMEN DE LA CONVERSACIÓN' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => ({ stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...parts] as never) }),
  });
}

const history = (n: number): ModelMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `mensaje ${i} ` + 'x'.repeat(400) }) as ModelMessage);

describe('compactación de contexto', () => {
  it('no hace nada por debajo del umbral', async () => {
    const msgs = history(4);
    expect(await compactIfNeeded(msgs, { model: summaryModel(), contextWindow: 100_000, ratio: 0.75 })).toBe(0);
    expect(msgs).toHaveLength(4);
  });

  it('primero poda resultados viejos de herramientas, sin llamar al modelo', async () => {
    const big = 'r'.repeat(6000);
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'haz algo' },
      ...Array.from({ length: 6 }, (_, i): ModelMessage[] => [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'readFile', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'readFile', output: { type: 'text', value: big } }] },
      ]).flat(),
      { role: 'user', content: 'sigue' },
    ];
    let llamadas = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => (llamadas++, { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) as never });
    const antes = estimateTokens(msgs);
    expect(await compactIfNeeded(msgs, { model, contextWindow: 8_000, ratio: 0.75 })).toBe(0);
    expect(estimateTokens(msgs)).toBeLessThan(antes / 3);
    expect(JSON.stringify(msgs)).toContain('[resultado podado]');
    expect(llamadas).toBe(0);
  });

  it('resume el historial largo en sitio con un modelo del SDK v7', async () => {
    const msgs = history(60);
    const before = estimateTokens(msgs);
    const removed = await compactIfNeeded(msgs, { model: summaryModel(), contextWindow: 4000, ratio: 0.75 });
    expect(removed).toBeGreaterThan(0);
    expect(estimateTokens(msgs)).toBeLessThan(before);
    expect(JSON.stringify(msgs)).toContain('RESUMEN DE LA CONVERSACIÓN');
  });
});
