import { contextBar } from './ui/ansi.js';

/**
 * Ventana de contexto de los modelos conocidos. Son valores orientativos: si tu modelo no está aquí o tienes
 * otro límite, fíjalo con `contextWindow` en la configuración (manda siempre).
 */
const KNOWN_WINDOWS: [RegExp, number][] = [
  [/^google\/gemini/i, 1_000_000],
  [/^anthropic\/claude/i, 200_000],
  [/^openai\/(gpt-4o|gpt-4\.1|gpt-5|o\d)/i, 128_000],
  [/^ollama\//i, 32_000],
];

/** Si no se conoce el modelo (p. ej. un servidor propio compatible con OpenAI), se asume esto. */
export const DEFAULT_WINDOW = 128_000;

/**
 * Tope práctico: aunque el modelo admita 1M de tokens, mandar tanto contexto cuesta, tarda y choca con los
 * límites por minuto de los planes gratuitos. Se compacta y se calcula el porcentaje sobre este tope.
 */
export const PRACTICAL_CAP = 256_000;

/** Ventana efectiva para un modelo "proveedor/modelo": la configurada, o la conocida con tope práctico. */
export function contextWindowFor(modelId: string, configured?: number): number {
  if (configured) return configured;
  const known = KNOWN_WINDOWS.find(([re]) => re.test(modelId))?.[1] ?? DEFAULT_WINDOW;
  return Math.min(known, PRACTICAL_CAP);
}

export interface ContextUsage {
  tokens: number;
  window: number;
  /** 0-100, redondeado. */
  percent: number;
  /** Porcentaje a partir del cual se compacta. */
  compactAtPercent: number;
}

export function contextUsage(tokens: number, window: number, compactAt: number): ContextUsage {
  return { tokens, window, percent: Math.min(100, Math.round((tokens / window) * 100)), compactAtPercent: Math.round(compactAt * 100) };
}

const fmt = (n: number) => n.toLocaleString('es-ES');

/** "contexto: ▰▰▱▱▱▱▱▱▱▱ 21 % · 41.200 / 200.000 tokens · se compacta al 75 %". `approx` marca una estimación (aún sin dato del proveedor). */
export function formatContext(u: ContextUsage, approx = false): string {
  return `contexto: ${contextBar(u.percent, u.compactAtPercent)} ${approx ? '≈ ' : ''}${u.percent} % · ${fmt(u.tokens)} / ${fmt(u.window)} tokens · se compacta al ${u.compactAtPercent} %`;
}
