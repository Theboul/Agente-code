import { setTimeout as sleepMs } from 'node:timers/promises';

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

export const MAX_WAIT_MS = 120_000;

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

/** Fin de los reintentos: el proveedor pide esperar más de lo razonable (cuota diaria agotada). */
export function quotaExhaustedError(hintMs: number): Error {
  const mins = Math.round(hintMs / 60_000);
  return new Error(
    `Cuota agotada: el proveedor pide esperar ~${mins >= 90 ? `${Math.round(mins / 60)} h` : `${mins} min`}. Usa otra clave o modelo (--model), o habilita facturación.`,
  );
}

export interface RetryOptions {
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
}

/** Ejecuta `fn` y, ante errores temporales del proveedor, la repite esperando lo que indique o 2 s, 4 s, 8 s… */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? ((ms: number) => sleepMs(ms));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (o.signal?.aborted || attempt >= retries || !isTransient(e)) throw e;
      const hint = suggestedWaitMs(e);
      if (hint !== undefined && hint > MAX_WAIT_MS) throw quotaExhaustedError(hint);
      const wait = retryDelayMs(e, attempt);
      o.onRetry?.(attempt + 1, e, wait);
      await sleep(wait);
    }
  }
}
