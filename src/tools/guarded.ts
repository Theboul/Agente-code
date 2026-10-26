import { isAbsolute, relative, resolve, sep } from 'node:path';
import { NodeFsProvider, type FsProvider, type ShellProvider, type ShellResult } from '@openharness/core';
import { authorize, classifyCommand, type Permissions } from '../permissions.js';
import { execCommand } from './bash.js';

/** Resuelve una ruta y garantiza que queda dentro del directorio del proyecto. */
export function safePath(cwd: string, p: string): string {
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`Ruta fuera del proyecto: ${p}`);
  return abs;
}

const MAX_PREVIEW_LINES = 6;

/** Vista corta de un cambio: quita líneas iniciales/finales comunes y muestra lo que cambia. */
export function previewChange(oldText: string | undefined, newText: string): string {
  if (oldText === undefined) return `archivo nuevo, ${newText.split('\n').length} líneas`;
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const fmt = (sign: string, lines: string[]) =>
    lines.slice(0, MAX_PREVIEW_LINES).map((l) => `${sign} ${l.slice(0, 160)}`).concat(lines.length > MAX_PREVIEW_LINES ? [`${sign} …(+${lines.length - MAX_PREVIEW_LINES} líneas)`] : []);
  const out = [...fmt('-', a.slice(start, endA)), ...fmt('+', b.slice(start, endB))];
  return out.length ? `desde la línea ${start + 1}:\n${out.join('\n')}` : 'sin cambios';
}

const DENIED = 'DENEGADO por el usuario.';

/**
 * Sistema de archivos del proyecto: nada fuera del directorio, y toda escritura, borrado o
 * renombrado pide confirmación (con vista previa del cambio).
 */
export class GuardedFsProvider extends NodeFsProvider implements FsProvider {
  constructor(
    private readonly root: string,
    private readonly perms: Permissions,
  ) {
    super({ cwd: root });
  }

  override resolvePath(p: string): string {
    return safePath(this.root, p);
  }

  private rel(p: string) {
    return relative(this.root, this.resolvePath(p)) || '.';
  }

  override async writeFile(p: string, content: string): Promise<void> {
    const old = (await this.exists(p)) ? await super.readFile(p) : undefined;
    if (old === content) return;
    if (!(await authorize(this.perms, 'ask', `¿Escribir ${this.rel(p)}?  ${previewChange(old, content)}`))) throw new Error(DENIED);
    await super.writeFile(p, content);
  }

  override async remove(p: string, options?: { recursive?: boolean }): Promise<void> {
    if (!(await authorize(this.perms, 'ask', `¿BORRAR ${this.rel(p)}${options?.recursive ? ' (recursivo)' : ''}?`))) throw new Error(DENIED);
    await super.remove(p, options);
  }

  override async rename(from: string, to: string): Promise<void> {
    if (!(await authorize(this.perms, 'ask', `¿Mover ${this.rel(from)} → ${this.rel(to)}?`))) throw new Error(DENIED);
    await super.rename(from, to);
  }
}

/** Shell del proyecto: lista blanca de comandos, bloqueo de los peligrosos, confirmación del resto. */
export class GuardedShellProvider implements ShellProvider {
  constructor(
    private readonly root: string,
    private readonly perms: Permissions,
  ) {}

  async exec(command: string, options?: { timeout?: number }): Promise<ShellResult> {
    const decision = classifyCommand(command, this.perms.allowedCommands);
    if (decision === 'deny') return { stdout: '', stderr: 'DENEGADO: comando bloqueado por la política de seguridad.', exitCode: 126 };
    if (!(await authorize(this.perms, decision, `¿Ejecutar?  $ ${command}`))) return { stdout: '', stderr: DENIED, exitCode: 126 };
    const r = await execCommand(this.root, command, options?.timeout ?? 30_000);
    return { stdout: r.output, stderr: r.timedOut ? 'Tiempo de espera agotado.' : '', exitCode: r.code ?? 1 };
  }
}

/**
 * editFile de la librería usa String.replace con texto, que interpreta "$&", "$1", "$$" del código nuevo,
 * y reemplaza en silencio la primera coincidencia si hay varias. Aquí se escapan los "$" y se exige que
 * oldString sea único (salvo replaceAll).
 */
export function withLiteralEdit<T extends { execute?: (input: never, options: never) => unknown }>(edit: T, fs: FsProvider): T {
  const exec = edit.execute!;
  return {
    ...edit,
    execute: async (input: { filePath: string; oldString: string; newString: string; replaceAll?: boolean }, options: never) => {
      if (!input.replaceAll && input.oldString) {
        const path = fs.resolvePath(input.filePath);
        const count = (await fs.readFile(path)).split(input.oldString).length - 1;
        if (count > 1) return { error: `oldString aparece ${count} veces; añade más contexto o usa replaceAll`, filePath: path };
      }
      return exec({ ...input, newString: input.newString.replaceAll('$', '$$$$') } as never, options);
    },
  } as T;
}
