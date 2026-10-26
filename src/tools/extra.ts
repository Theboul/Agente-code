import { tool } from 'ai';
import { z } from 'zod';
import { authorize, type Permissions } from '../permissions.js';

/** Pregunta abierta al usuario cuando la tarea es ambigua. Sin terminal, el modelo debe decidir y documentar. */
export function askUserTool(perms: Permissions) {
  return tool({
    description:
      'Hace una pregunta al usuario cuando falta información que no puedes deducir del código (decisiones de diseño, requisitos ambiguos). ' +
      'No la uses para confirmar pasos rutinarios. Opcionalmente ofrece opciones.',
    inputSchema: z.object({
      question: z.string().describe('Pregunta clara y concreta'),
      options: z.array(z.string()).optional().describe('Opciones sugeridas'),
    }),
    execute: async ({ question, options }) => {
      const text = options?.length ? `${question}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join('\n')}` : question;
      const answer = await perms.ask?.(text);
      return answer?.trim() || 'Sin respuesta del usuario (no hay terminal interactivo). Decide con tu mejor criterio y deja la suposición escrita en el plan o el resumen.';
    },
  });
}

const MAX_BYTES = 1_000_000;
const MAX_TEXT = 20_000;

/** Rechaza destinos locales o de red privada (evita SSRF hacia servicios internos). */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** HTML → texto legible (sin scripts ni estilos). Suficiente para documentación; no es un navegador. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|pre|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Lee una URL pública (documentación, enlaces de una issue). Solo GET, pide permiso la primera vez por dominio. */
export function webFetchTool(perms: Permissions, fetchImpl: typeof fetch = fetch) {
  const allowedHosts = new Set<string>();
  return tool({
    description: 'Descarga una página web pública (http/https) y devuelve su texto. Úsala para leer documentación o enlaces mencionados en la tarea.',
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return { error: 'Solo se permiten URLs http/https.' };
      if (isBlockedHost(u.hostname)) return { error: 'Destino local o de red privada bloqueado.' };
      if (!allowedHosts.has(u.hostname)) {
        if (!(await authorize(perms, 'ask', `¿Permitir que el agente lea ${u.origin}?`))) return { error: 'DENEGADO por el usuario.' };
        allowedHosts.add(u.hostname);
      }
      try {
        const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'agente-cli' } });
        if (res.status >= 300 && res.status < 400) return { error: `Redirección a ${res.headers.get('location') ?? '?'}; pídela de nuevo con esa URL.` };
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const body = (await res.text()).slice(0, MAX_BYTES);
        const text = /html/i.test(res.headers.get('content-type') ?? '') ? htmlToText(body) : body;
        return { url, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…[recortado]' : text };
      } catch (e) {
        return { error: `No se pudo leer la URL: ${e instanceof Error ? e.message : e}` };
      }
    },
  });
}
