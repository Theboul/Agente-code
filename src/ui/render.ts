import { c, clearLine, padEnd, restoreCursor, saveCursor, termWidth, truncate, upOneLine } from './ansi.js';
import { box } from './box.js';

type Out = { write(chunk: string): unknown; isTTY?: boolean };

const TOOL_NAMES: Record<string, string> = {
  readFile: 'Leer',
  writeFile: 'Escribir',
  editFile: 'Editar',
  listFiles: 'Listar',
  grep: 'Buscar',
  deleteFile: 'Borrar',
  bash: 'Bash',
  todowrite: 'Tareas',
  todoread: 'Tareas',
  ask_user: 'Pregunta',
  web_fetch: 'Web',
  start_workflow: 'Flujo',
};

const ARG_KEYS = ['filePath', 'dirPath', 'pattern', 'command', 'url', 'question', 'issue', 'path'];

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** "readFile" → { name: "Leer", arg: "src/a.js" }; las MCP "mcp__jira__create_issue" → "jira:create_issue". */
export function toolLabel(tool: string, input: unknown): { name: string; arg: string } {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  const name = TOOL_NAMES[tool] ?? (mcp ? `${mcp[1]}:${mcp[2]}` : tool);
  const obj = record(input);
  const key = ARG_KEYS.find((k) => typeof obj[k] === 'string');
  const arg = key ? String(obj[key]).replace(/\s+/g, ' ') : mcp ? truncate(JSON.stringify(input ?? {}), 60) : '';
  return { name, arg: truncate(arg, 80) };
}

export interface ResultSummary {
  text: string;
  tone: 'ok' | 'error' | 'denied' | 'plain';
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** Texto de un resultado MCP ({ content: [{ type: "text", text }] }), resumido: "2 elementos" si es JSON, o su primera línea. */
function mcpText(output: unknown): string | undefined {
  const content = record(output).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join('\n')
    .trim();
  if (!text) return undefined;
  try {
    const json: unknown = JSON.parse(text);
    if (Array.isArray(json)) return `${json.length} elemento${json.length === 1 ? '' : 's'}`;
    if (json && typeof json === 'object') return `{ ${Object.keys(json).slice(0, 5).join(', ')} }`;
  } catch {
    /* no es JSON: se muestra el texto */
  }
  return text;
}

/** Resumen de una línea del resultado de una herramienta, como el "⎿" de Claude Code. */
export function summarizeResult(tool: string, output: unknown): ResultSummary {
  if (typeof output === 'string') {
    if (/^(Error: )?DENEGADO/.test(output)) return { text: truncate(firstLine(output), 100), tone: 'denied' };
    if (output.startsWith('Error')) return { text: truncate(firstLine(output), 100), tone: 'error' };
    return { text: truncate(firstLine(output), 100), tone: 'plain' };
  }
  const o = record(output);
  if (typeof o.error === 'string') return { text: truncate(firstLine(o.error), 100), tone: o.error.startsWith('DENEGADO') ? 'denied' : 'error' };
  switch (tool) {
    case 'readFile':
      return { text: `Leídas ${Number(o.toLine ?? 0) - Number(o.fromLine ?? 1) + 1} líneas`, tone: 'plain' };
    case 'writeFile':
      return { text: `Escrito (${o.bytesWritten} bytes)`, tone: 'ok' };
    case 'editFile':
      return { text: `Editado (${o.replacements} reemplazo${o.replacements === 1 ? '' : 's'})`, tone: 'ok' };
    case 'deleteFile':
      return { text: 'Borrado', tone: 'ok' };
    case 'listFiles':
      return { text: `${o.totalCount ?? o.count} entradas`, tone: 'plain' };
    case 'grep':
      return { text: `${o.matchCount} coincidencia${o.matchCount === 1 ? '' : 's'}`, tone: 'plain' };
    case 'bash': {
      const code = Number(o.exitCode ?? 0);
      const body = firstLine(String(o.stdout || o.stderr || ''));
      return {
        text: code === 0 ? `✓ ${truncate(body, 90) || 'sin salida'}` : `✗ código ${code}${body ? ` · ${truncate(body, 80)}` : ''}`,
        tone: code === 0 ? 'ok' : 'error',
      };
    }
    case 'todowrite':
    case 'todoread':
      return { text: `${Array.isArray(o.todos) ? o.todos.length : 0} tareas`, tone: 'plain' };
    case 'web_fetch':
      return { text: `${String(o.text ?? '').length} caracteres leídos`, tone: 'plain' };
    default:
      return { text: truncate(firstLine(mcpText(output) ?? JSON.stringify(output) ?? ''), 100), tone: 'plain' };
  }
}

/** Formato inline de una línea de Markdown: **negrita**, `código`, #títulos y viñetas. */
export function formatMarkdownLine(line: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return c.bold(heading[1]!.length <= 2 ? c.cyan(heading[2]!) : heading[2]!);
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  const body = bullet ? `${bullet[1]}• ${bullet[2]}` : line;
  return body.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => c.bold(t)).replace(/`([^`]+)`/g, (_, t: string) => c.cyan(t));
}

const FRAMES = ['✻', '✽', '✶', '✳'];
const TODO_MARK: Record<string, (s: string) => string> = {
  completed: (s) => `${c.green('☒')} ${c.dim(c.strike(s))}`,
  in_progress: (s) => `${c.cyan('◼')} ${c.bold(s)}`,
  cancelled: (s) => `${c.red('☒')} ${c.dim(c.strike(s))}`,
  pending: (s) => `☐ ${s}`,
};

/** Salida de la sesión: mensajes del asistente, herramientas, tareas e indicador de "pensando". */
export class Ui {
  private buf = '';
  private inFence = false;
  private bulletPending = true;
  private spinner?: NodeJS.Timeout;
  private spinnerStart = 0;
  private pending = 0;

  constructor(private readonly out: Out = process.stdout) {}

  private write(s: string) {
    this.out.write(s);
  }

  /** Muestra "✻ Pensando… (3s · Esc para interrumpir)" mientras se espera al modelo. */
  thinking(label = 'Pensando'): void {
    if (!this.out.isTTY || this.spinner) return;
    this.spinnerStart = Date.now();
    let i = 0;
    const tick = () =>
      this.write(
        `${clearLine}${c.cyan(FRAMES[i++ % FRAMES.length]!)} ${c.dim(`${label}… (${Math.round((Date.now() - this.spinnerStart) / 1000)}s · Esc para interrumpir)`)}`,
      );
    tick();
    this.spinner = setInterval(tick, 250);
  }

  idle(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = undefined;
    this.write(clearLine);
  }

  banner(info: { model: string; cwd: string; branch?: string; mcp?: number }): void {
    const lines = [
      { text: '✻ Bienvenido a agente', paint: c.bold },
      '',
      { text: `modelo   ${info.model}`, paint: c.dim },
      { text: `carpeta  ${info.cwd}${info.branch ? `  (${info.branch})` : ''}`, paint: c.dim },
      ...(info.mcp ? [{ text: `mcp      ${info.mcp} herramientas`, paint: c.dim }] : []),
      '',
      { text: '/help comandos · /work <issue> flujo completo · /exit salir', paint: c.dim },
    ];
    this.write(`${box(lines, { width: Math.min(termWidth(), 80), border: c.cyan }).join('\n')}\n`);
  }

  /** Regla sobre la línea de entrada, con el modo de permisos: "── modo: … · Shift+Tab cambia ────". */
  rule(label?: string): string {
    if (!label) return c.gray('─'.repeat(termWidth()));
    const text = ` ${label} `;
    return `${c.gray('──')}${c.dim(text)}${c.gray('─'.repeat(Math.max(2, termWidth() - 2 - [...text].length)))}`;
  }

  /** Línea de entrada: regla superior y "›" como prompt. */
  prompt(label?: string): string {
    return `\n${this.rule(label)}\n${c.bold('›')} `;
  }

  /** Redibuja la regla sin tocar lo que el usuario ya escribió (solo si la entrada cabe en una línea). */
  redrawRule(label: string, typed: number): void {
    if (!this.out.isTTY || typed + 4 >= termWidth()) return;
    this.write(`${saveCursor}${upOneLine}\r${clearLine}${this.rule(label)}${restoreCursor}`);
  }

  text(delta: string): void {
    this.idle();
    this.buf += delta;
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
      this.emitLine(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
  }

  /** Vuelca lo que quede en el búfer y termina el bloque de texto actual. */
  endText(): void {
    if (this.buf) this.emitLine(this.buf);
    this.buf = '';
    this.inFence = false;
    this.bulletPending = true;
  }

  private emitLine(line: string) {
    const fence = /^\s*```/.test(line);
    const body = fence ? c.dim(line) : this.inFence ? c.cyan(line) : formatMarkdownLine(line);
    if (fence) this.inFence = !this.inFence;
    if (!line.trim()) return this.write('\n');
    this.write(`${this.bulletPending ? `${c.bold('●')} ` : '  '}${body}\n`);
    this.bulletPending = false;
  }

  toolCall(tool: string, input: unknown): void {
    this.idle();
    this.endText();
    const { name, arg } = toolLabel(tool, input);
    this.pending++;
    this.write(`${c.bold('●')} ${c.bold(name)}${arg ? c.dim(`(${arg})`) : ''}\n`);
  }

  toolResult(tool: string, output: unknown): void {
    this.idle();
    // La lista de tareas ya se dibujó al actualizarse (todos()); no hace falta repetirla como resultado.
    if (tool === 'todowrite' || tool === 'todoread') {
      this.pending = Math.max(0, this.pending - 1);
      return;
    }
    const { text, tone } = summarizeResult(tool, output);
    const paint = tone === 'error' || tone === 'denied' ? c.red : tone === 'ok' ? c.green : c.dim;
    const label = this.pending > 1 ? `${toolLabel(tool, undefined).name}: ` : '';
    this.pending = Math.max(0, this.pending - 1);
    this.write(`  ${c.dim('⎿')}  ${paint(`${label}${text}`)}\n`);
  }

  todos(todos: { content: string; status: string }[]): void {
    this.idle();
    this.write(`${todos.map((t) => `  ${c.dim('⎿')}  ${(TODO_MARK[t.status] ?? TODO_MARK.pending!)(t.content)}`).join('\n')}\n`);
  }

  notice(text: string): void {
    this.idle();
    this.write(`${c.dim(text)}\n`);
  }

  warn(text: string): void {
    this.idle();
    this.write(`${c.yellow('⚠')} ${text}\n`);
  }

  error(text: string): void {
    this.idle();
    this.endText();
    this.write(`${c.red('✖')} ${text}\n`);
  }

  /** Tabla de comandos de /help. */
  table(rows: [string, string][]): void {
    const w = Math.max(...rows.map(([a]) => a.length)) + 2;
    this.write(`${rows.map(([a, b]) => `  ${c.cyan(padEnd(a, w))}${b}`).join('\n')}\n`);
  }
}
