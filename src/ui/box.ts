import { type Paint, padEnd, truncate } from './ansi.js';

export interface BoxLine {
  text: string;
  paint?: Paint;
}

export interface BoxOptions {
  title?: string;
  width: number;
  /** Color del borde y del título. */
  border?: Paint;
}

const same: Paint = (s) => s;

/** Cuadro con bordes redondeados. El texto se recorta al ancho; el color se aplica después de recortar. */
export function box(lines: (BoxLine | string)[], { title, width, border = same }: BoxOptions): string[] {
  const inner = Math.max(10, width - 4);
  const head = title ? ` ${truncate(title, inner - 2)} ` : '';
  const top = `${border('╭─')}${border(head)}${border(`${'─'.repeat(Math.max(0, width - 3 - head.length))}╮`)}`;
  const rows = lines.map((l) => {
    const { text, paint = same } = typeof l === 'string' ? { text: l } : l;
    return `${border('│')} ${paint(truncate(text, inner))}${padEnd('', inner - Math.min(inner, [...text].length))} ${border('│')}`;
  });
  return [top, ...rows, border(`╰${'─'.repeat(width - 2)}╯`)];
}

/** Parte un texto largo en líneas de a lo sumo `width` caracteres, respetando saltos de línea y palabras. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && [...line].length + 1 + [...word].length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}
