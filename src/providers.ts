import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { Config } from './config.js';

export function parseModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) {
    throw new Error(`Modelo inválido "${id}". Usa el formato "proveedor/modelo" (p. ej. google/gemini-flash-latest).`);
  }
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

/**
 * Resuelve "proveedor/modelo" a un modelo del AI SDK.
 * Proveedores integrados: google, anthropic, openai, ollama.
 * Cualquier otro nombre definido en config.providers con baseURL se trata como OpenAI-compatible.
 */
export function resolveModel(id: string, config: Config): LanguageModel {
  const { provider, model } = parseModelId(id);
  const pc = config.providers[provider] ?? {};
  const apiKey = pc.apiKeyEnv ? process.env[pc.apiKeyEnv] : undefined;

  switch (provider) {
    case 'google':
      return createGoogleGenerativeAI({ ...(apiKey && { apiKey }), ...(pc.baseURL && { baseURL: pc.baseURL }) })(model);
    case 'anthropic':
      return createAnthropic({ ...(apiKey && { apiKey }), ...(pc.baseURL && { baseURL: pc.baseURL }) })(model);
    case 'openai':
      return createOpenAI({ ...(apiKey && { apiKey }), ...(pc.baseURL && { baseURL: pc.baseURL }) })(model);
    case 'ollama':
      return createOpenAI({ baseURL: pc.baseURL ?? 'http://localhost:11434/v1', apiKey: apiKey ?? 'ollama' }).chat(model);
    default:
      if (pc.baseURL) return createOpenAI({ baseURL: pc.baseURL, apiKey: apiKey ?? 'none' }).chat(model);
      throw new Error(
        `Proveedor desconocido "${provider}". Usa google, anthropic, openai, ollama o defínelo en ${'agente.config.json'} con "baseURL".`,
      );
  }
}

/** Variable de entorno que cada proveedor integrado necesita por defecto. */
export const DEFAULT_KEY_ENV: Record<string, string> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function missingKeyHint(id: string, config: Config): string | undefined {
  const { provider } = parseModelId(id);
  const env = config.providers[provider]?.apiKeyEnv ?? DEFAULT_KEY_ENV[provider];
  return env && !process.env[env] ? env : undefined;
}
