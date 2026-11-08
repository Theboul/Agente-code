import type { ModelMessage, ToolSet } from 'ai';
import { type CompactionEvent, compactIfNeeded } from './agent/compaction.js';
import { announcedWithoutActing, runTurn, TurnFailure, type TurnUsage } from './agent/loop.js';
import type { Config } from './config.js';
import { keyInstructions } from './connect/connect.js';
import { contextWindowFor } from './models.js';
import { missingKeyHint, resolveModel } from './providers.js';
import { ModelTurnError } from './turn-error.js';
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
  /** Se llama al compactar el historial, con el original de lo afectado (la sesión lo archiva). */
  onCompact?: (e: CompactionEvent) => void | Promise<void>;
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
    await compactIfNeeded(o.messages, {
      model,
      contextWindow: contextWindowFor(o.modelId, config.contextWindow),
      ratio: config.compactAt,
      signal: ac.signal,
      knownTokens: o.knownTokens,
      onRetry: (n, e, ms) =>
        ui.warn(
          `Resumen del contexto: fallo temporal, reintento ${n} en ${Math.round(ms / 1000)}s… (${truncate(e instanceof Error ? e.message : String(e), 90)})`,
        ),
      onCompact: async (e) => {
        const freed = Math.max(0, e.tokensBefore - e.tokensAfter).toLocaleString('es-ES');
        ui.notice(
          e.reason === 'summary'
            ? `⇣ Contexto compactado: ${e.removed} mensajes resumidos (≈ ${freed} tokens liberados). El original queda archivado.`
            : `⇣ Resultados antiguos de herramientas podados (≈ ${freed} tokens liberados). El original queda archivado.`,
        );
        await o.onCompact?.(e);
      },
    });
    ui.thinking();
    const fallbackId = config.fallbackModel;
    const useFallback = fallbackId && fallbackId !== o.modelId && !missingKeyHint(fallbackId, config);
    const r = await runTurn({
      model,
      fallback: useFallback
        ? {
            model: resolveModel(fallbackId, config),
            onSwitch: () => ui.warn(`${o.modelId} no responde o agotó su cuota: sigo con el modelo de respaldo ${fallbackId}.`),
          }
        : undefined,
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
    if (r.finishReason && !['stop', 'tool-calls'].includes(r.finishReason)) {
      ui.warn(`La respuesta terminó antes de tiempo (motivo: ${r.finishReason}). Escribe "continúa" o prueba otro modelo con /model.`);
    } else if (!r.limitReached && announcedWithoutActing(r.text, r.stepsUsed)) {
      ui.warn(
        'El modelo anunció una acción pero no la ejecutó. Escribe "hazlo" o "continúa" (los modelos pequeños a veces se detienen así; /model cambia de modelo).',
      );
    }
    return { text: r.text, newMessages: r.newMessages, usage: r.usage, stepsUsed: r.stepsUsed, limitReached: r.limitReached };
  } catch (thrown) {
    // El trabajo de los pasos ya completados viaja con el error para que la sesión lo conserve.
    const partial = thrown instanceof TurnFailure ? thrown.partial : [];
    const e = thrown instanceof TurnFailure ? thrown.original : thrown;
    if (ac.signal.aborted) throw new ModelTurnError('Interrumpido por el usuario.', partial, true);
    const msg = e instanceof Error ? e.message : String(e);
    const authHint = /api key|apikey|unauthori[sz]ed|\b40[13]\b|permission denied|invalid.*key/i.test(msg)
      ? '\nSi la clave es incorrecta, cámbiala con /login.'
      : '';
    throw new ModelTurnError(`Falló el modelo ${o.modelId}: ${msg}${authHint}`, partial);
  } finally {
    ui.idle();
    ui.endText();
    disarm();
    process.off('SIGINT', abort);
  }
}
