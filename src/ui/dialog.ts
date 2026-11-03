import type { PermissionKind, PermissionReply, PermissionRequest } from '../permissions.js';
import type { DecisionPrompt } from '../workflow/run.js';
import { c, termWidth } from './ansi.js';
import { type BoxLine, box } from './box.js';
import { type KeySource, selectIndex } from './select.js';

const QUESTION: Record<PermissionKind, string> = {
  edit: '¿Quieres aplicar este cambio?',
  create: '¿Quieres crear este archivo?',
  delete: '¿Quieres borrarlo?',
  move: '¿Quieres moverlo?',
  command: '¿Quieres ejecutar este comando?',
  mcp: '¿Quieres ejecutar esta herramienta?',
  web: '¿Quieres permitir esta lectura?',
  workflow: '¿Quieres iniciar este flujo?',
};

type OptionId = 'yes' | 'session' | 'no';

export interface DialogOption {
  id: OptionId;
  label: string;
}

export function dialogOptions(req: PermissionRequest): DialogOption[] {
  const opts: DialogOption[] = [{ id: 'yes', label: 'Sí' }];
  if (req.session) opts.push({ id: 'session', label: `Sí, no volver a preguntar por ${req.session.label} en esta sesión` });
  opts.push({ id: 'no', label: 'No, y decirle al agente qué hacer distinto' });
  return opts;
}

const paintPreview = (line: string): BoxLine =>
  line.startsWith('+ ') ? { text: line, paint: c.green } : line.startsWith('- ') ? { text: line, paint: c.red } : { text: line, paint: c.dim };

/** Cuadro del diálogo de permiso, como el de Claude Code: qué se va a hacer, vista previa y opciones numeradas. */
export function renderDialog(req: PermissionRequest, options: DialogOption[], selected: number, width: number): string[] {
  const lines: (BoxLine | string)[] = [];
  if (req.target) lines.push({ text: req.target, paint: c.bold }, '');
  if (req.preview?.length) lines.push(...req.preview.map(paintPreview), '');
  lines.push({ text: QUESTION[req.kind], paint: c.bold });
  for (const [i, o] of options.entries()) {
    const on = i === selected;
    lines.push({ text: `${on ? '❯' : ' '} ${i + 1}. ${o.label}`, paint: on ? c.cyan : (s) => s });
  }
  return [...box(lines, { title: req.title, width, border: c.yellow }), c.dim('  ↑↓ elegir · Enter confirmar · Esc cancelar')];
}

export interface PrompterDeps {
  keys: KeySource;
  out: { write(chunk: string): unknown };
  /** Pregunta de texto libre (para "qué hacer distinto"). */
  ask: (question: string) => Promise<string | undefined>;
  interactive: () => boolean;
  /** Se llama antes de mostrar el cuadro (para detener el indicador de "pensando"). */
  onOpen?: () => void;
}

/**
 * Diálogo de permisos con memoria de sesión: "sí, y no volver a preguntar" recuerda la clave (ediciones, un comando,
 * una herramienta MCP, un dominio) hasta que termina la sesión. Sin terminal interactivo, rechaza.
 */
export function createPermissionPrompter(deps: PrompterDeps): (req: PermissionRequest) => Promise<PermissionReply> {
  const remembered = new Set<string>();
  return async (req) => {
    if (req.session && remembered.has(req.session.key)) return { allow: true };
    if (!deps.interactive()) return { allow: false };
    deps.onOpen?.();
    const options = dialogOptions(req);
    const subject = req.target ? ` ${req.target}` : '';
    const choice = await selectIndex({
      count: options.length,
      render: (sel) => renderDialog(req, options, sel, termWidth()),
      keys: deps.keys,
      out: deps.out,
      clear: true,
    });
    const id = choice === 'cancel' ? 'cancel' : options[choice]!.id;
    if (id === 'yes' || id === 'session') {
      if (id === 'session' && req.session) remembered.add(req.session.key);
      deps.out.write(`${c.green('✔')} ${req.title}${subject}${id === 'session' ? c.dim(' (permitido en esta sesión)') : ''}\n`);
      return { allow: true };
    }
    deps.out.write(`${c.red('✖')} ${req.title}${subject} ${c.dim('· rechazado')}\n`);
    if (id === 'cancel') return { allow: false };
    const feedback = (await deps.ask(c.dim('¿Qué debería hacer distinto? (Enter para omitir)\n› ')))?.trim();
    return { allow: false, feedback: feedback || undefined };
  };
}

export type DecisionReply = { kind: 'approve'; allowEdits?: boolean } | { kind: 'cancel' } | { kind: 'feedback'; text: string };

/** Cuadro con opciones numeradas para las decisiones del flujo (plan, revisión, commit, push, PR). */
export function renderDecision(p: DecisionPrompt, options: string[], selected: number, width: number): string[] {
  const lines: (BoxLine | string)[] = [];
  if (p.detail?.length) lines.push(...p.detail.map((l) => ({ text: l, paint: c.dim })), '');
  for (const [i, label] of options.entries()) {
    const on = i === selected;
    lines.push({ text: `${on ? '❯' : ' '} ${i + 1}. ${label}`, paint: on ? c.cyan : (s) => s });
  }
  return [...box(lines, { title: p.title, width, border: c.cyan }), c.dim('  ↑↓ elegir · Enter confirmar · Esc cancelar')];
}

/** Decisiones del flujo con el mismo estilo que los permisos. Sin terminal interactivo cancela. */
export function createDecisionPrompter(deps: PrompterDeps): (p: DecisionPrompt) => Promise<DecisionReply> {
  return async (p) => {
    if (!deps.interactive()) return { kind: 'cancel' };
    deps.onOpen?.();
    const options = [p.approve, ...(p.approveWithEdits ? [p.approveWithEdits] : []), ...(p.feedback ? [p.feedback] : []), p.cancel];
    const choice = await selectIndex({
      count: options.length,
      render: (sel) => renderDecision(p, options, sel, termWidth()),
      keys: deps.keys,
      out: deps.out,
      clear: true,
    });
    if (choice === 'cancel' || options[choice] === p.cancel) {
      deps.out.write(`${c.red('✖')} ${p.title} ${c.dim('· no')}\n`);
      return { kind: 'cancel' };
    }
    if (options[choice] === p.approve || options[choice] === p.approveWithEdits) {
      const allowEdits = options[choice] === p.approveWithEdits;
      deps.out.write(`${c.green('✔')} ${p.title} ${c.dim(allowEdits ? '· sí, ediciones automáticas' : '· sí')}\n`);
      return allowEdits ? { kind: 'approve', allowEdits } : { kind: 'approve' };
    }
    const text = (await deps.ask(c.dim('Escribe qué cambiar\n› ')))?.trim();
    return text ? { kind: 'feedback', text } : { kind: 'cancel' };
  };
}
