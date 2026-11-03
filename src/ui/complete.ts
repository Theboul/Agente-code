/** Estado que alimenta el autocompletado: se actualiza a medida que se conocen issues, ramas y modelos. */
export interface CompletionState {
  commands: string[];
  issues: string[];
  branches: string[];
  models: string[];
  roles: string[];
  modes: string[];
  /** Lo activa Shift+Tab para que readline no lo trate como un Tab de completado. */
  suppress: boolean;
}

export type Completer = (line: string) => [string[], string];

/**
 * Autocompletado con Tab para readline: comandos "/…", claves de issues tras /work, ramas tras /ship,
 * modelos tras /model, roles tras /role y modos tras /mode. Devuelve [candidatos, texto que se completa].
 */
export function createCompleter(state: () => CompletionState): Completer {
  return (line) => {
    const s = state();
    if (s.suppress) {
      s.suppress = false;
      return [[], line];
    }
    if (!line.startsWith('/')) return [[], line];
    const space = line.indexOf(' ');
    if (space < 0) return [s.commands.filter((c) => c.startsWith(line)), line];
    const cmd = line.slice(0, space);
    const arg = line.slice(space + 1).trimStart();
    const pool: Record<string, string[]> = {
      '/work': s.issues,
      '/ship': s.branches,
      '/model': s.models,
      '/role': s.roles,
      '/mode': s.modes,
    };
    const hits = (pool[cmd] ?? []).filter((c) => c.toLowerCase().startsWith(arg.toLowerCase()));
    return [hits, arg];
  };
}
