import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';

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

export interface TurnResult {
  /** Mensajes nuevos generados en este turno (asistente + herramientas). */
  newMessages: ModelMessage[];
  text: string;
}

/** Ejecuta un turno completo del bucle agéntico: modelo → herramientas → modelo… hasta terminar. */
/** Error de un turno que ya completó pasos: lleva los mensajes de esos pasos para no repetirlos al reintentar. */
class PartialTurnError extends Error {
  constructor(
    readonly original: unknown,
    readonly partial: ModelMessage[],
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

async function runTurnOnce(opts: TurnOptions): Promise<TurnResult> {
  const done: ModelMessage[] = [];
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
    onStepFinish: (step) => void done.push(...((step.response.messages ?? []) as ModelMessage[])),
    onError: () => {}, // los errores se tratan abajo; evita el volcado por defecto del SDK
  });

  let text = '';
  let newMessages: ModelMessage[];
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
          opts.onToolResult?.(part.toolName, `Error: ${String(part.error)}`);
          break;
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
    newMessages = (await result.responseMessages) as ModelMessage[];
  } catch (e) {
    const err = timedOut ? new Error(`El modelo no respondió en ${(opts.idleTimeoutMs ?? 0) / 1000}s (reintenta o cambia de modelo con --model).`) : e;
    throw done.length ? new PartialTurnError(err, done) : err;
  } finally {
    disarm();
    opts.abortSignal?.removeEventListener('abort', onUserAbort);
  }

  return { newMessages, text };
}

type ProviderError = { isRetryable?: boolean; statusCode?: number; code?: number; message?: string; lastError?: unknown; cause?: unknown };

function chain(e: unknown): ProviderError[] {
  const out: ProviderError[] = [];
  for (let cur = e as ProviderError | undefined, i = 0; cur && typeof cur === 'object' && i < 4; i++) {
    out.push(cur);
    cur = (cur.lastError ?? cur.cause) as ProviderError | undefined;
  }
  return out;
}

const TRANSIENT_TEXT = /quota|rate.?limit|high demand|overloaded|unavailable|try again later|resource.?exhausted/i;

/** Errores temporales del proveedor (sobrecarga, límite de tasa, 5xx) que merecen un reintento. */
export function isTransient(e: unknown): boolean {
  return chain(e).some(
    (err) => err.isRetryable === true || [429, 500, 502, 503, 504].includes(err.statusCode ?? err.code ?? 0) || TRANSIENT_TEXT.test(err.message ?? ''),
  );
}

const MAX_WAIT_MS = 120_000;

/** Segundos que el proveedor pide esperar ("retry in 52s"), si lo indica. */
export function suggestedWaitMs(e: unknown): number | undefined {
  for (const err of chain(e)) {
    const m = /retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i.exec(err.message ?? '');
    if (m) return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + parseFloat(m[3]!)) * 1000;
  }
  return undefined;
}

/** Espera antes de reintentar: la que sugiere el proveedor ("retry in 52s") o exponencial 2s, 4s, 8s. */
export function retryDelayMs(e: unknown, attempt: number): number {
  const hint = suggestedWaitMs(e);
  return hint !== undefined ? Math.min(MAX_WAIT_MS, Math.ceil(hint) + 500) : 2000 * 2 ** attempt;
}

/**
 * Ejecuta un turno; ante errores temporales del proveedor lo repite esperando lo que indique el proveedor o 2s, 4s, 8s…
 * Si el turno ya había completado pasos (herramientas ejecutadas), el reintento continúa desde ahí: no se repiten.
 */
export async function runTurn(opts: TurnOptions & { retries?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (n: number, e: unknown, waitMs: number) => void }): Promise<TurnResult> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Pasos ya completados en intentos fallidos: el reintento continúa desde ahí en vez de repetirlos.
  const carried: ModelMessage[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await runTurnOnce({ ...opts, messages: [...opts.messages, ...carried] });
      return { ...r, newMessages: [...carried, ...r.newMessages] };
    } catch (thrown) {
      const e = thrown instanceof PartialTurnError ? thrown.original : thrown;
      if (thrown instanceof PartialTurnError) carried.push(...thrown.partial);
      if (opts.abortSignal?.aborted || attempt >= retries || !isTransient(e)) throw e;
      const hint = suggestedWaitMs(e);
      if (hint !== undefined && hint > MAX_WAIT_MS) {
        const mins = Math.round(hint / 60_000);
        throw new Error(
          `Cuota agotada: el proveedor pide esperar ~${mins >= 90 ? `${Math.round(mins / 60)} h` : `${mins} min`}. Usa otra clave o modelo (--model), o habilita facturación.`,
        );
      }
      const wait = retryDelayMs(e, attempt);
      opts.onRetry?.(attempt + 1, e, wait);
      await sleep(wait);
    }
  }
}
