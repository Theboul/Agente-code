import { generateText, type LanguageModel, type ModelMessage } from 'ai';

/** Estimación gruesa de tokens: caracteres del JSON / 4 (misma heurística que @openharness/core). */
export const estimateTokens = (messages: ModelMessage[]): number => Math.ceil(JSON.stringify(messages).length / 4);

const SUMMARY_PROMPT = `Resume esta conversación entre un usuario y un agente de programación para que el agente pueda continuar sin perder el hilo. Conserva: el objetivo, las decisiones tomadas, los archivos creados o modificados (rutas), el estado de las pruebas, errores pendientes y los siguientes pasos. Sé conciso y concreto. Escribe en español.`;

/** Quita el contenido de los resultados de herramientas anteriores a `boundary` (lo que más pesa y menos se necesita). */
function pruneToolResults(messages: ModelMessage[], boundary: number): ModelMessage[] {
  return messages.map((m, i) => {
    if (i >= boundary || m.role !== 'tool' || !Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map((part) => (part.type === 'tool-result' ? { ...part, output: { type: 'text', value: '[resultado podado]' } } : part)) } as ModelMessage;
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

/**
 * Si el historial supera `ratio` de la ventana de contexto, lo reduce modificando `messages` en sitio:
 * 1) poda los resultados viejos de herramientas; 2) si no basta, resume lo anterior al tramo protegido con el modelo.
 * Devuelve cuántos mensajes se quitaron (0 = no hizo falta o solo se podó).
 */
export async function compactIfNeeded(
  messages: ModelMessage[],
  o: { model: LanguageModel; contextWindow: number; ratio: number; signal?: AbortSignal },
): Promise<number> {
  const limit = o.contextWindow * o.ratio;
  if (estimateTokens(messages) < limit) return 0;

  const boundary = protectedBoundary(messages, Math.floor(o.contextWindow * 0.2));
  const pruned = pruneToolResults(messages, boundary);
  if (estimateTokens(pruned) < limit * 0.8) {
    messages.splice(0, messages.length, ...pruned);
    return 0;
  }

  // El tramo conservado debe empezar en un mensaje del usuario (nunca en un resultado de herramienta huérfano).
  let cut = boundary;
  while (cut < pruned.length && pruned[cut]!.role !== 'user') cut++;
  const head = pruned.slice(0, cut);
  if (head.length < 2) return 0;

  const { text } = await generateText({
    model: o.model,
    system: SUMMARY_PROMPT,
    messages: [{ role: 'user', content: head.map((m) => `${m.role}: ${JSON.stringify(m.content)}`).join('\n').slice(-400_000) }],
    abortSignal: o.signal,
  });
  const summary: ModelMessage = { role: 'user', content: `[Resumen de la conversación anterior]\n\n${text}\n\n[La conversación continúa desde aquí]` };
  messages.splice(0, messages.length, summary, ...pruned.slice(cut));
  return head.length;
}
