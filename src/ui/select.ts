import { emitKeypressEvents } from 'node:readline';
import { eraseUp, hideCursor, showCursor } from './ansi.js';

export interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

export type KeyHandler = (str: string | undefined, key: Key) => void;

/** Fuente de teclas: la terminal real o, en los tests, una simulada. `listen` devuelve la función para dejar de escuchar. */
export interface KeySource {
  listen(handler: KeyHandler): () => void;
}

/**
 * Teclas de la terminal real. Mientras escucha, desconecta temporalmente a readline (para que no haga eco ni
 * edite su línea) y lo vuelve a conectar al terminar.
 */
export function stdinKeys(stdin: NodeJS.ReadStream = process.stdin): KeySource {
  return {
    listen(handler) {
      emitKeypressEvents(stdin);
      const saved = stdin.listeners('keypress') as KeyHandler[];
      stdin.removeAllListeners('keypress');
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', handler);
      return () => {
        stdin.off('keypress', handler);
        for (const l of saved) stdin.on('keypress', l);
        if (stdin.isTTY && !wasRaw) stdin.setRawMode(false);
      };
    },
  };
}

export interface SelectOptions {
  count: number;
  /** Dibuja las líneas del cuadro para la opción seleccionada. */
  render: (selected: number) => string[];
  keys: KeySource;
  out: { write(chunk: string): unknown };
  initial?: number;
  /** Al terminar, borra el cuadro en vez de dejarlo en pantalla (el llamador imprime un resumen). */
  clear?: boolean;
}

/** Resultado: índice elegido, o "cancel" con Esc / Ctrl+C. Flechas o j/k para mover, 1-9 elige directo, Enter confirma. */
export function selectIndex({ count, render, keys, out, initial = 0, clear = false }: SelectOptions): Promise<number | 'cancel'> {
  return new Promise((resolve) => {
    let selected = initial;
    let drawn = 0;
    const draw = () => {
      const lines = render(selected);
      out.write(`${eraseUp(drawn)}${lines.join('\n')}\n`);
      drawn = lines.length;
    };
    out.write(hideCursor);
    draw();
    const stop = keys.listen((str, key) => {
      let result: number | 'cancel' | undefined;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) result = 'cancel';
      else if (key.name === 'return' || key.name === 'enter') result = selected;
      else if (key.name === 'up' || str === 'k') selected = (selected + count - 1) % count;
      else if (key.name === 'down' || key.name === 'tab' || str === 'j') selected = (selected + 1) % count;
      else if (str && /^[1-9]$/.test(str) && Number(str) <= count) result = Number(str) - 1;
      if (result === undefined) return draw();
      if (typeof result === 'number') selected = result;
      stop();
      if (clear) {
        out.write(eraseUp(drawn));
        drawn = 0;
      } else draw();
      out.write(showCursor);
      resolve(result);
    });
  });
}
