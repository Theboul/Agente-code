/** Interrupción del turno en curso con Esc o Ctrl+C (en modo raw, Ctrl+C llega como tecla, no como señal). */
export class Interrupt {
  private current?: () => void;
  private quitFn?: () => void;
  private listener?: (str: string | undefined, key: { name?: string }) => void;

  constructor(private readonly stdin: NodeJS.ReadStream = process.stdin) {}

  /** Mientras dure el turno, Esc lo aborta. Devuelve la función para desarmar. */
  arm(abort: () => void): () => void {
    this.current = abort;
    if (this.stdin.isTTY) {
      this.listener = (_s, key) => {
        if (key.name === 'escape') this.fire();
      };
      this.stdin.on('keypress', this.listener);
    }
    return () => this.disarm();
  }

  disarm(): void {
    this.current = undefined;
    if (this.listener) this.stdin.off('keypress', this.listener);
    this.listener = undefined;
  }

  /** Qué hacer para salir de la sesión (cancela la pregunta pendiente del prompt). */
  onQuit(fn: (() => void) | undefined): void {
    this.quitFn = fn;
  }

  /** true si había algo a lo que pedirle que salga. */
  quit(): boolean {
    if (!this.quitFn) return false;
    this.quitFn();
    return true;
  }

  /** true si había un turno en curso al que se le pidió abortar. */
  fire(): boolean {
    const fn = this.current;
    if (!fn) return false;
    fn();
    return true;
  }
}
