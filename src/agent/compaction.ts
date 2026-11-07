import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { withRetry } from './retry.js';

/** Estimación gruesa de tokens: caracteres del JSON / 4 (misma heurística que @openharness/core). */
export const estimateTokens = (messages: ModelMessage[]): number => Math.ceil(JSON.stringify(messages).length / 4);

const SUMMARY_PROMPT = `Resume esta conversación entre un usuario y un agente de programación para que el agente pueda continuar sin perder el hilo. Conserva: el objetivo, las decisiones tomadas, los archivos creados o modificados (rutas), el estado de las pruebas, errores pendientes y los siguientes pasos. Sé conciso y concreto. Escribe en español.`;

/** Quita el contenido de los resultados de herramientas anteriores a `boundary` (lo que más pesa y menos se necesita). */
function pruneToolResults(messages: ModelMessage[], boundary: number): ModelMessage[] {
  return messages.map((m, i) => {
    if (i >= boundary || m.role !== 'tool' || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((part) => (part.type === 'tool-result' ? { ...part, output: { type: 'text', value: '[resultado podado]' } } : part)),
    } as ModelMessage;
  });
}

/** Índice desde el que se protege el final de la conversación (≈ `protectedTokens` tokens). */
function protectedBoundary(messages: ModelMessage[], protectedTokens: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i]!]);
    if (acc >= protectedTokens) return i + 1;
  }
  return 0;
}

/** Qué se hizo al compactar, para avisar al usuario y archivar el original. */
export interface CompactionEvent {
  reason: 'summary' | 'prune';
  /** Mensajes tal como eran antes de compactar (solo los afectados). */
  original: ModelMessage[];
  /** Mensajes resumidos (summary) o 0 (prune). */
  removed: number;
  /** Tokens estimados antes y después. */
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Si el historial supera `ratio` de la ventana de contexto, lo reduce modificando `messages` en sitio:
 * 1) poda los resultados viejos de herramientas; 2) si no basta, resume lo anterior al tramo protegido con el modelo.
 * Devuelve cuántos mensajes se quitaron (0 = no hizo falta o solo se podó).
 */
export async function compactIfNeeded(
  messages: ModelMessage[],
  o: {
    model: LanguageModel;
    contextWindow: number;
    ratio: number;
    signal?: AbortSignal;
    /** Tamaño real conocido (informado por el proveedor); se usa si supera a la estimación. */
    knownTokens?: number;
    /** Se llama al compactar, con el original de lo afectado (para archivarlo) y las cifras (para avisar). */
    onCompact?: (e: CompactionEvent) => void | Promise<void>;
    /** Aviso de reintento si la llamada del resumen falla por un error temporal. */
    onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<number> {
  const limit = o.contextWindow * o.ratio;
  if (Math.max(estimateTokens(messages), o.knownTokens ?? 0) < limit) return 0;

  const boundary = protectedBoundary(messages, Math.floor(o.contextWindow * 0.2));
  const pruned = pruneToolResults(messages, boundary);
  // Lo podado también se descuenta del tamaño real: la decisión sigue basándose en el mayor de los dos datos.
  const saved = estimateTokens(messages) - estimateTokens(pruned);
  if (Math.max(estimateTokens(pruned), (o.knownTokens ?? 0) - saved) < limit * 0.8) {
    const original = messages.filter((m, i) => pruned[i] !== m);
    const before = estimateTokens(messages);
    messages.splice(0, messages.length, ...pruned);
    if (original.length) await o.onCompact?.({ reason: 'prune', original, removed: 0, tokensBefore: before, tokensAfter: estimateTokens(pruned) });
    return 0;
  }

  // El tramo conservado debe empezar en un mensaje del usuario (nunca en un resultado de herramienta huérfano).
  let cut = boundary;
  while (cut < pruned.length && pruned[cut]!.role !== 'user') cut++;
  const head = pruned.slice(0, cut);
  if (head.length < 2) return 0;

  const originalHead = messages.slice(0, cut);
  const tokensBefore = estimateTokens(messages);
  // Una llamada más al proveedor: puede toparse con el mismo límite por minuto que el turno, así que se reintenta.
  const { text } = await withRetry(
    () =>
      generateText({
        model: o.model,
        system: SUMMARY_PROMPT,
        messages: [
          {
            role: 'user',
            content: head
              .map((m) => `${m.role}: ${JSON.stringify(m.content)}`)
              .join('\n')
              .slice(-400_000),
          },
        ],
        abortSignal: o.signal,
      }),
    { signal: o.signal, onRetry: o.onRetry, sleep: o.sleep },
  );
  const summary: ModelMessage = { role: 'user', content: `[Resumen de la conversación anterior]\n\n${text}\n\n[La conversación continúa desde aquí]` };
  messages.splice(0, messages.length, summary, ...pruned.slice(cut));
  await o.onCompact?.({ reason: 'summary', original: originalHead, removed: head.length, tokensBefore, tokensAfter: estimateTokens(messages) });
  return head.length;
}
