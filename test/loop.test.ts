import { tool } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { retryDelayMs, runTurn, suggestedWaitMs, TurnFailure } from '../src/agent/loop.js';

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
    const base = {
      system: 's',
      messages: [{ role: 'user' as const, content: 'x' }],
      tools: {},
      maxSteps: 3,
      sleep: async (ms: number) => void sleeps.push(ms),
    };

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

describe('reintento con progreso', () => {
  it('tras un fallo temporal a mitad de turno continúa desde los pasos ya hechos, sin repetir herramientas', async () => {
    let calls = 0;
    let executed = 0;
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        calls++;
        prompts.push(JSON.stringify(prompt));
        if (calls === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'eco', input: JSON.stringify({ x: 'hola' }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool' }, usage },
            ] as never),
          };
        }
        if (calls === 2) throw Object.assign(new Error('límite por minuto'), { statusCode: 429, isRetryable: true });
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'terminado' },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ] as never),
        };
      },
    });
    const r = await runTurn({
      model,
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      maxSteps: 5,
      sleep: async () => {},
      tools: { eco: tool({ description: 'eco', inputSchema: z.object({ x: z.string() }), execute: async ({ x }) => (executed++, `eco:${x}`) }) },
    });
    expect(executed).toBe(1);
    expect(calls).toBe(3);
    expect(prompts[2]).toContain('eco:hola'); // el reintento ya ve el resultado de la herramienta
    expect(r.text).toBe('terminado');
    expect(r.newMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
  });
});

describe('uso real y límite de pasos', () => {
  const usage100 = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  };
  const toolStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'c', toolName: 'eco', input: JSON.stringify({ x: 'a' }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool' }, usage: usage100 },
  ];
  const textStep = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'listo' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage100 },
  ];
  const eco = { eco: tool({ description: 'eco', inputSchema: z.object({ x: z.string() }), execute: async ({ x }) => x }) };
  const modelOf = (...steps: unknown[][]) => {
    let n = 0;
    return new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream((steps[Math.min(n++, steps.length - 1)] ?? textStep) as never) }),
    });
  };
  const base = { system: 's', messages: [{ role: 'user' as const, content: 'x' }], tools: eco };

  it('devuelve los tokens reales del proveedor, los pasos usados y no marca límite si el modelo terminó solo', async () => {
    const r = await runTurn({ ...base, model: modelOf(toolStep, textStep), maxSteps: 5 });
    expect(r.stepsUsed).toBe(2);
    expect(r.limitReached).toBe(false);
    expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 40, contextTokens: 100 });
  });

  it('marca el límite cuando el turno se corta con el modelo aún pidiendo herramientas', async () => {
    const r = await runTurn({ ...base, model: modelOf(toolStep), maxSteps: 3 });
    expect(r.stepsUsed).toBe(3);
    expect(r.limitReached).toBe(true);
  });

  it('terminar justo en el último paso permitido no cuenta como límite', async () => {
    const r = await runTurn({ ...base, model: modelOf(toolStep, textStep), maxSteps: 2 });
    expect(r.stepsUsed).toBe(2);
    expect(r.limitReached).toBe(false);
  });

  it('el tope de pasos es del turno entero: los pasos de intentos fallidos cuentan', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 2) throw Object.assign(new Error('503'), { statusCode: 503, isRetryable: true });
        return { stream: convertArrayToReadableStream(toolStep as never) };
      },
    });
    const r = await runTurn({ ...base, model, maxSteps: 3, sleep: async () => {} });
    expect(r.stepsUsed).toBe(3); // 1 paso, fallo, y solo 2 más: no vuelve a empezar de cero
    expect(r.limitReached).toBe(true);
    expect(r.usage.inputTokens).toBe(300);
  });
});

describe('trabajo parcial al fallar', () => {
  const usageP = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const toolStepP = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'c', toolName: 'eco', input: JSON.stringify({ x: 'a' }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool' }, usage: usageP },
  ];
  const eco = { eco: tool({ description: 'eco', inputSchema: z.object({ x: z.string() }), execute: async ({ x }) => `eco:${x}` }) };

  it('un fallo definitivo tras un paso completado lleva ese trabajo (llamada y resultado) en el error', async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (n++ === 0) return { stream: convertArrayToReadableStream(toolStepP as never) };
        throw Object.assign(new Error('clave inválida'), { statusCode: 401 });
      },
    });
    const err = await runTurn({ model, system: 's', messages: [{ role: 'user', content: 'x' }], tools: eco, maxSteps: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(TurnFailure);
    expect((err as TurnFailure).original).toMatchObject({ message: 'clave inválida' });
    expect((err as TurnFailure).partial.map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(JSON.stringify((err as TurnFailure).partial)).toContain('eco:a');
  });

  it('si falla antes de completar ningún paso, el error llega tal cual (sin trabajo parcial)', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => Promise.reject(Object.assign(new Error('sin red'), { statusCode: 401 })) });
    const err = await runTurn({ model, system: 's', messages: [{ role: 'user', content: 'x' }], tools: eco, maxSteps: 5 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(TurnFailure);
    expect(String(err.message)).toContain('sin red');
  });
});
