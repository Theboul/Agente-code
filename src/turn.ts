import type { ModelMessage, ToolSet } from 'ai';
import { compactIfNeeded } from './agent/compaction.js';
import { runTurn } from './agent/loop.js';
import type { Config } from './config.js';
import { missingKeyHint, resolveModel } from './providers.js';
import { truncate } from './ui/ansi.js';
import type { Interrupt } from './ui/interrupt.js';
import type { Ui } from './ui/render.js';

export interface TurnContext {
  config: Config;
  ui: Ui;
  interrupt: Interrupt;
}

export interface ModelTurnOptions {
  modelId: string;
  system: string;
  tools: ToolSet;
  /** Historial: se compacta en sitio si hace falta. El llamador añade `newMessages` al terminar. */
  messages: ModelMessage[];
  /** false = redacción interna (commit, PR): el texto no se muestra tal cual. */
  stream?: boolean;
}

/** Un turno del agente con la salida visual de la sesión; Esc o Ctrl+C lo interrumpen. */
export async function modelTurn(ctx: TurnContext, o: ModelTurnOptions): Promise<{ text: string; newMessages: ModelMessage[] }> {
  const { config, ui, interrupt } = ctx;
  const hint = missingKeyHint(o.modelId, config);
  if (hint) throw new Error(`Falta la variable de entorno ${hint} para usar ${o.modelId}.`);
  const stream = o.stream ?? true;
  const ac = new AbortController();
  const abort = () => ac.abort();
  const disarm = interrupt.arm(abort);
  process.once('SIGINT', abort);
  try {
    const model = resolveModel(o.modelId, config);
    const removed = await compactIfNeeded(o.messages, { model, contextWindow: config.contextWindow, ratio: config.compactAt, signal: ac.signal });
    if (removed) ui.notice(`⇣ Contexto compactado (${removed} mensajes resumidos)`);
    ui.thinking();
    const r = await runTurn({
      model,
      system: o.system,
      tools: o.tools,
      messages: o.messages,
      maxSteps: config.maxSteps,
      idleTimeoutMs: config.requestTimeoutSeconds * 1000,
      abortSignal: ac.signal,
      onRetry: (n, e, ms) => {
        ui.warn(
          `${o.modelId}: fallo temporal o límite de uso. Reintento ${n} en ${Math.round(ms / 1000)}s… (${truncate(e instanceof Error ? e.message : String(e), 110)})`,
        );
        ui.thinking('Esperando');
      },
      onText: (d) => stream && ui.text(d),
      onToolCall: (n, i) => ui.toolCall(n, i),
      onToolResult: (n, out) => {
        ui.toolResult(n, out);
        ui.thinking();
      },
    });
    return { text: r.text, newMessages: r.newMessages };
  } catch (e) {
    throw ac.signal.aborted ? new Error('Interrumpido por el usuario.') : new Error(`Falló el modelo ${o.modelId}: ${e instanceof Error ? e.message : e}`);
  } finally {
    ui.idle();
    ui.endText();
    disarm();
    process.off('SIGINT', abort);
  }
}
