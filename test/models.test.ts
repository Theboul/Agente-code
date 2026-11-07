import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/agent/compaction.js';
import { contextUsage, contextWindowFor, DEFAULT_WINDOW, formatContext, PRACTICAL_CAP } from '../src/models.js';

describe('ventana de contexto por modelo', () => {
  it('conoce los proveedores habituales y aplica un tope práctico', () => {
    expect(contextWindowFor('anthropic/claude-sonnet-5-5')).toBe(200_000);
    expect(contextWindowFor('openai/gpt-4o-mini')).toBe(128_000);
    expect(contextWindowFor('ollama/qwen2.5-coder:7b')).toBe(32_000);
    // Gemini admite 1M, pero se limita al tope práctico (coste, latencia y límites por minuto)
    expect(contextWindowFor('google/gemini-3.5-flash-lite')).toBe(PRACTICAL_CAP);
  });

  it('un modelo desconocido usa el valor por defecto', () => {
    expect(contextWindowFor('miservidor/modelo-x')).toBe(DEFAULT_WINDOW);
  });

  it('lo configurado manda sobre todo, incluso por encima del tope práctico', () => {
    expect(contextWindowFor('google/gemini-3.5-flash-lite', 40_000)).toBe(40_000);
    expect(contextWindowFor('anthropic/claude-x', 900_000)).toBe(900_000);
  });
});

describe('porcentaje de contexto', () => {
  it('calcula y formatea el uso', () => {
    const u = contextUsage(41_200, 200_000, 0.75);
    expect(u).toEqual({ tokens: 41_200, window: 200_000, percent: 21, compactAtPercent: 75 });
    expect(formatContext(u)).toBe('contexto: 41.200 / 200.000 tokens (21 %) · se compacta al 75 %');
    expect(formatContext(u, true)).toContain('≈ 41.200');
  });

  it('no pasa del 100 % y redondea', () => {
    expect(contextUsage(300_000, 200_000, 0.75).percent).toBe(100);
    expect(contextUsage(1, 3, 0.5).percent).toBe(33);
  });

  it('la estimación de caracteres/4 sirve de respaldo', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(400) }])).toBeGreaterThan(100);
  });
});
