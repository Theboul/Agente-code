import { setTimeout as sleepMs } from 'node:timers/promises';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from 'ai';

import { isTransient, MAX_WAIT_MS, quotaExhaustedError, retryDelayMs, suggestedWaitMs } from './retry.js';

// Se reexportan para no romper a quien ya los importaba desde aquí.
export { isTransient, retryDelayMs, suggestedWaitMs };

export interface TurnOptions {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  messages: ModelMessage[];
  maxSteps: number;
  /** Si el modelo no emite nada en este tiempo (primer fragmento o entre fragmentos), se aborta con error. */
  idleTimeoutMs?: number;
  abortSignal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, output: unknown) => void;
}

/** Modelo de respaldo: se usa una sola vez si el principal agota la cuota o los reintentos por errores temporales. */
export interface TurnFallback {
  model: LanguageModel;
  onSwitch?: (reason: unknown) => void;
}

/** Consumo real que informa el proveedor (no una estimación). */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens de entrada del último paso: lo que ocupa hoy el contexto de la conversación. */
  contextTokens: number;
}

export interface TurnResult {
  /** Mensajes nuevos generados en este turno (asistente + herramientas). */
  newMessages: ModelMessage[];
  text: string;
  /** Pasos del modelo que se usaron en el turno (cada vuelta modelo → herramientas es un paso). */
  stepsUsed: number;
  /** El turno se cortó por llegar a `maxSteps` mientras el modelo aún pedía herramientas: el trabajo puede estar a medias. */
  limitReached: boolean;
  /** Motivo con que el proveedor cerró el turno (`stop`, `tool-calls`, `length`, `other`…). */
  finishReason?: string;
  usage: TurnUsage;
}

/**
 * El modelo cerró el turno diciendo que iba a hacer algo («Voy a listar los archivos…») sin llamar a ninguna herramienta.
 * Los modelos pequeños lo hacen a veces; sin aviso parece que el arnés se colgó.
 */
export function announcedWithoutActing(text: string, stepsUsed: number): boolean {
  if (stepsUsed !== 1) return false;
  const last =
    text
      .trim()
      .split(/(?<=[.!?:])\s+|\n+/)
      .filter(Boolean)
      .at(-1) ?? '';
  return /\b(voy a|vamos a|déjame|dejame|procedo a|a continuación|ahora voy|primero necesito)\b/i.test(last);
}

/** Ejecuta un turno completo del bucle agéntico: modelo → herramientas → modelo… hasta terminar. */
/** Error definitivo de un turno (tras agotar reintentos o por interrupción) con el trabajo que sí se completó. */
export class TurnFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly partial: ModelMessage[],
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

/** Error de un turno que ya completó pasos: lleva los mensajes de esos pasos para no repetirlos al reintentar. */
class PartialTurnError extends Error {
  constructor(
    readonly original: unknown,
    readonly partial: ModelMessage[],
    readonly steps: number,
    readonly usage: TurnUsage,
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

async function runTurnOnce(opts: TurnOptions): Promise<TurnResult> {
  const done: ModelMessage[] = [];
  const used: TurnUsage = { inputTokens: 0, outputTokens: 0, contextTokens: 0 };
  let steps = 0;
  // Vigilante de inactividad: se reinicia con cada fragmento recibido del modelo. El tiempo que
  // tardan las herramientas (tests, shell) no cuenta porque entonces no se espera al modelo.
  const ac = new AbortController();
  const onUserAbort = () => ac.abort();
  opts.abortSignal?.addEventListener('abort', onUserAbort);
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (!opts.idleTimeoutMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, opts.idleTimeoutMs);
  };
  const disarm = () => clearTimeout(timer);

  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: stepCountIs(opts.maxSteps),
    abortSignal: ac.signal,
    onStepFinish: (step) => {
      done.push(...((step.response.messages ?? []) as ModelMessage[]));
      steps++;
      used.inputTokens += step.usage.inputTokens ?? 0;
      used.outputTokens += step.usage.outputTokens ?? 0;
      used.contextTokens = step.usage.inputTokens ?? used.contextTokens;
    },
    onError: () => {}, // los errores se tratan abajo; evita el volcado por defecto del SDK
  });

  let text = '';
  let newMessages: ModelMessage[];
  let finishReason: string | undefined;
  try {
    arm();
    for await (const part of result.fullStream) {
      arm();
      switch (part.type) {
        case 'text-delta':
          text += part.text;
          opts.onText?.(part.text);
          break;
        case 'tool-call':
          opts.onToolCall?.(part.toolName, part.input);
          disarm(); // mientras corre la herramienta no se espera al modelo
          break;
        case 'tool-result':
          opts.onToolResult?.(part.toolName, part.output);
          break;
        case 'tool-error':
          opts.onToolResult?.(part.toolName, `Error: ${part.error instanceof Error ? part.error.message : String(part.error)}`);
          break;
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
    newMessages = (await result.responseMessages) as ModelMessage[];
    finishReason = await result.finishReason;
  } catch (e) {
    const err = timedOut ? new Error(`El modelo no respondió en ${(opts.idleTimeoutMs ?? 0) / 1000}s (reintenta o cambia de modelo con --model).`) : e;
    throw done.length ? new PartialTurnError(err, done, steps, used) : err;
  } finally {
    disarm();
    opts.abortSignal?.removeEventListener('abort', onUserAbort);
  }

  return { newMessages, text, stepsUsed: steps, limitReached: steps >= opts.maxSteps && finishReason === 'tool-calls', finishReason, usage: used };
}

/**
 * Ejecuta un turno; ante errores temporales del proveedor lo repite esperando lo que indique el proveedor o 2s, 4s, 8s…
 * Si el turno ya había completado pasos (herramientas ejecutadas), el reintento continúa desde ahí: no se repiten.
 */
export async function runTurn(
  opts: TurnOptions & {
    fallback?: TurnFallback;
    retries?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (n: number, e: unknown, waitMs: number) => void;
  },
): Promise<TurnResult> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? sleepMs;
  // Pasos ya completados en intentos fallidos: el reintento continúa desde ahí en vez de repetirlos.
  const carried: ModelMessage[] = [];
  let carriedSteps = 0;
  const carriedUsage: TurnUsage = { inputTokens: 0, outputTokens: 0, contextTokens: 0 };
  let model = opts.model;
  let fellBack = false;
  for (let attempt = 0; ; attempt++) {
    try {
      // El tope de pasos es del turno entero: los pasos ya hechos en intentos anteriores cuentan.
      const r = await runTurnOnce({ ...opts, model, messages: [...opts.messages, ...carried], maxSteps: Math.max(1, opts.maxSteps - carriedSteps) });
      return {
        ...r,
        newMessages: [...carried, ...r.newMessages],
        stepsUsed: carriedSteps + r.stepsUsed,
        usage: {
          inputTokens: carriedUsage.inputTokens + r.usage.inputTokens,
          outputTokens: carriedUsage.outputTokens + r.usage.outputTokens,
          contextTokens: r.usage.contextTokens,
        },
      };
    } catch (thrown) {
      const e = thrown instanceof PartialTurnError ? thrown.original : thrown;
      if (thrown instanceof PartialTurnError) {
        carried.push(...thrown.partial);
        carriedSteps += thrown.steps;
        carriedUsage.inputTokens += thrown.usage.inputTokens;
        carriedUsage.outputTokens += thrown.usage.outputTokens;
        carriedUsage.contextTokens = thrown.usage.contextTokens || carriedUsage.contextTokens;
      }
      // Si se rinde, el error lleva el trabajo ya completado para que no se pierda.
      const giveUp = (err: unknown): never => {
        throw carried.length ? new TurnFailure(err, [...carried]) : err;
      };
      const hint = suggestedWaitMs(e);
      const exhausted = attempt >= retries || (hint !== undefined && hint > MAX_WAIT_MS);
      if (!opts.abortSignal?.aborted && isTransient(e) && exhausted && opts.fallback && !fellBack) {
        // El modelo principal no da más de sí: se continúa con el de respaldo desde donde se quedó.
        fellBack = true;
        model = opts.fallback.model;
        opts.fallback.onSwitch?.(e);
        attempt = -1;
        continue;
      }
      if (opts.abortSignal?.aborted || attempt >= retries || !isTransient(e)) giveUp(e);
      if (hint !== undefined && hint > MAX_WAIT_MS) giveUp(quotaExhaustedError(hint));
      const wait = retryDelayMs(e, attempt);
      opts.onRetry?.(attempt + 1, e, wait);
      await sleep(wait);
    }
  }
}
