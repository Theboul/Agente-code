import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { Config } from './config.js';

export function parseModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) {
    throw new Error(`Modelo inválido "${id}". Usa el formato "proveedor/modelo" (p. ej. google/gemini-3.5-flash-lite).`);
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
      throw new Error(`Proveedor desconocido "${provider}". Usa google, anthropic, openai, ollama o defínelo en ${'agente.config.json'} con "baseURL".`);
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

export interface ProviderHelp {
  label: string;
  /** Dónde se crea la clave. */
  url?: string;
  note: string;
}

export const PROVIDER_HELP: Record<string, ProviderHelp> = {
  google: { label: 'Google Gemini', url: 'https://aistudio.google.com/apikey', note: 'Tiene nivel gratuito, con límites por minuto y por día.' },
  anthropic: {
    label: 'Anthropic (Claude)',
    url: 'https://console.anthropic.com/settings/keys',
    note: 'Necesita crédito cargado en Billing; una suscripción a Claude no incluye API.',
  },
  openai: { label: 'OpenAI', url: 'https://platform.openai.com/api-keys', note: 'Necesita crédito cargado en la cuenta.' },
  ollama: { label: 'Ollama (local)', note: 'No usa clave: instala Ollama, ejecuta `ollama serve` y descarga un modelo con `ollama pull <modelo>`.' },
};

export type KeyCheck = 'valid' | 'invalid' | 'unknown';

/**
 * Comprueba una clave con una petición barata (listar modelos). "unknown" si no hay red o el proveedor no tiene
 * una comprobación conocida: en ese caso no se bloquea nada.
 */
export async function checkApiKey(provider: string, key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  const requests: Record<string, { url: string; headers: Record<string, string> }> = {
    google: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': key } },
    anthropic: { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
    openai: { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } },
  };
  const req = requests[provider];
  if (!req) return 'unknown';
  try {
    const res = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) return 'valid';
    return res.status === 400 || res.status === 401 || res.status === 403 ? 'invalid' : 'unknown';
  } catch {
    return 'unknown';
  }
}
