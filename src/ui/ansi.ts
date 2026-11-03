const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Los colores se activan solo en una terminal real y respetan NO_COLOR (https://no-color.org). */
export const colorEnabled = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrapWith = (open: number, close: number) => (text: string) => (colorEnabled() ? `${ESC}[${open}m${text}${ESC}[${close}m` : text);

export const c = {
  bold: wrapWith(1, 22),
  dim: wrapWith(2, 22),
  strike: wrapWith(9, 29),
  red: wrapWith(31, 39),
  green: wrapWith(32, 39),
  yellow: wrapWith(33, 39),
  blue: wrapWith(34, 39),
  magenta: wrapWith(35, 39),
  cyan: wrapWith(36, 39),
  gray: wrapWith(90, 39),
};

export type Paint = (text: string) => string;

export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** Ancho visible (sin códigos de color). No considera caracteres de doble ancho. */
export const visibleWidth = (s: string): number => [...stripAnsi(s)].length;

/** Recorta a `max` caracteres visibles añadiendo "…". Solo para texto sin colores. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

export const padEnd = (s: string, width: number): string => s + ' '.repeat(Math.max(0, width - visibleWidth(s)));

/** Ancho útil de la terminal (máx. 100 para que los cuadros no se estiren en pantallas grandes). */
export const termWidth = (): number => Math.max(40, Math.min(process.stdout.columns ?? 80, 100));

/** Códigos para redibujar en sitio: sube `lines` líneas y borra hasta el final de la pantalla. */
export const eraseUp = (lines: number): string => (lines > 0 ? `${ESC}[${lines}A\r${ESC}[J` : '');
export const clearLine = `\r${ESC}[K`;
export const hideCursor = `${ESC}[?25l`;
export const showCursor = `${ESC}[?25h`;
