import type { ModelMessage, ToolSet } from 'ai';
import { compactIfNeeded } from './agent/compaction.js';
import { runTurn, type TurnUsage } from './agent/loop.js';
import type { Config } from './config.js';
import { keyInstructions } from './connect/connect.js';
import { contextWindowFor } from './models.js';
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
  /** Tokens reales del contexto según el último turno (si se conocen): la compactación usa el mayor entre esto y su estimación. */
  knownTokens?: number;
  /** false = redacción interna (commit, PR): el texto no se muestra tal cual. */
  stream?: boolean;
}

/** Un turno del agente con la salida visual de la sesión; Esc o Ctrl+C lo interrumpen. */
export interface ModelTurnResult {
  text: string;
  newMessages: ModelMessage[];
  usage: TurnUsage;
  stepsUsed: number;
  limitReached: boolean;
}

export async function modelTurn(ctx: TurnContext, o: ModelTurnOptions): Promise<ModelTurnResult> {
  const { config, ui, interrupt } = ctx;
  const hint = missingKeyHint(o.modelId, config);
  if (hint) throw new Error(keyInstructions(o.modelId, config));
  const stream = o.stream ?? true;
  const ac = new AbortController();
  const abort = () => ac.abort();
  const disarm = interrupt.arm(abort);
  process.once('SIGINT', abort);
  try {
    const model = resolveModel(o.modelId, config);
    const removed = await compactIfNeeded(o.messages, {
      model,
      contextWindow: contextWindowFor(o.modelId, config.contextWindow),
      ratio: config.compactAt,
      signal: ac.signal,
      knownTokens: o.knownTokens,
    });
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
    if (r.limitReached) {
      ui.warn(
        `Se alcanzó el límite de ${config.maxSteps} pasos del turno y el trabajo puede estar a medias. Escribe "continúa" para que siga (o sube maxSteps en la configuración).`,
      );
    }
    return { text: r.text, newMessages: r.newMessages, usage: r.usage, stepsUsed: r.stepsUsed, limitReached: r.limitReached };
  } catch (e) {
    if (ac.signal.aborted) throw new Error('Interrumpido por el usuario.');
    const msg = e instanceof Error ? e.message : String(e);
    const authHint = /api key|apikey|unauthori[sz]ed|\b40[13]\b|permission denied|invalid.*key/i.test(msg)
      ? '\nSi la clave es incorrecta, cámbiala con /login.'
      : '';
    throw new Error(`Falló el modelo ${o.modelId}: ${msg}${authHint}`);
  } finally {
    ui.idle();
    ui.endText();
    disarm();
    process.off('SIGINT', abort);
  }
}
