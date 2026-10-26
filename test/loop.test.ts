import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runTurn } from '../src/agent/loop.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

describe('bucle agéntico', () => {
  it('ejecuta la herramienta y devuelve el texto final', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        const chunks =
          calls === 1
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'c1', toolName: 'eco', input: JSON.stringify({ x: 'hola' }) },
                { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool' }, usage },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'listo' },
                { type: 'text-end', id: 't' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
              ];
        return { stream: convertArrayToReadableStream(chunks as never) };
      },
    });
    const seen: string[] = [];
    const res = await runTurn({
      model,
      system: 's',
      messages: [{ role: 'user', content: 'di hola' }],
      maxSteps: 5,
      tools: { eco: tool({ description: 'eco', inputSchema: z.object({ x: z.string() }), execute: async ({ x }) => `eco:${x}` }) },
      onToolResult: (_n, o) => seen.push(String(o)),
    });
    expect(seen).toEqual(['eco:hola']);
    expect(res.text).toBe('listo');
    expect(res.newMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(calls).toBe(2);
  });
});
