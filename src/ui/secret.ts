import type { KeySource } from './select.js';

export interface SecretDeps {
  keys: KeySource;
  out: { write(chunk: string): unknown };
}

const isPrintable = (s: string): boolean => [...s].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127);

/**
 * Lee un secreto sin mostrarlo (cada carácter se ve como "•"). Enter acepta; Esc o Ctrl+C cancelan (undefined);
 * Backspace borra; Ctrl+U limpia. Pegar texto funciona porque cada carácter llega como una tecla.
 */
export function readSecret(prompt: string, { keys, out }: SecretDeps): Promise<string | undefined> {
  return new Promise((resolve) => {
    let value = '';
    out.write(prompt);
    const stop = keys.listen((str, key) => {
      const done = (result: string | undefined) => {
        stop();
        out.write('\n');
        resolve(result);
      };
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(undefined);
      if (key.name === 'return' || key.name === 'enter') return done(value);
      if (key.name === 'backspace' || key.name === 'delete') {
        if (value) {
          value = [...value].slice(0, -1).join('');
          out.write('\b \b');
        }
        return;
      }
      if (key.ctrl && key.name === 'u') {
        out.write('\b \b'.repeat([...value].length));
        value = '';
        return;
      }
      if (str && !key.ctrl && isPrintable(str)) {
        value += str;
        out.write('•'.repeat([...str].length));
      }
    });
  });
}
