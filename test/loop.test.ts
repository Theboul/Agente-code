import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { retryDelayMs, runTurn, suggestedWaitMs } from '../src/agent/loop.js';

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

describe('reintentos ante errores temporales', () => {
  it('repite el turno si el proveedor está saturado (503) y falla si no es temporal', async () => {
    const ok = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'ya' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ];
    const make = (failWith: unknown, times: number) => {
      let n = 0;
      return new MockLanguageModelV4({
        doStream: async () => {
          if (n++ < times) throw failWith;
          return { stream: convertArrayToReadableStream(ok as never) };
        },
      });
    };
    const sleeps: number[] = [];
    const base = { system: 's', messages: [{ role: 'user' as const, content: 'x' }], tools: {}, maxSteps: 3, sleep: async (ms: number) => void sleeps.push(ms) };

    const busy = Object.assign(new Error('alta demanda'), { statusCode: 503, isRetryable: true });
    const r = await runTurn({ ...base, model: make(busy, 2) });
    expect(r.text).toBe('ya');
    expect(sleeps).toEqual([2000, 4000]);

    // límite de cuota con la espera sugerida, envuelto como lo hace el SDK
    const quota = Object.assign(new Error('Failed after 3 attempts'), { lastError: new Error('You exceeded your quota. Please retry in 3.2s.') });
    expect(retryDelayMs(quota, 0)).toBe(3700);
    expect(retryDelayMs(new Error('x'), 2)).toBe(8000);
    sleeps.length = 0;
    await runTurn({ ...base, model: make(quota, 1) });
    expect(sleeps).toEqual([3700]);

    const daily = Object.assign(new Error('x'), { lastError: new Error('quota. Please retry in 9h55m28.03s.') });
    expect(suggestedWaitMs(daily)).toBeCloseTo((9 * 3600 + 55 * 60 + 28.03) * 1000, 0);
    await expect(runTurn({ ...base, model: make(daily, 5) })).rejects.toThrow(/Cuota agotada.*10 h/);

    const bad = Object.assign(new Error('clave inválida'), { statusCode: 401 });
    await expect(runTurn({ ...base, model: make(bad, 5) })).rejects.toThrow(/clave inválida/);
  });
});
