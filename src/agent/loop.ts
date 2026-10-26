import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';

export interface TurnOptions {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  messages: ModelMessage[];
  maxSteps: number;
  abortSignal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, output: unknown) => void;
}

export interface TurnResult {
  /** Mensajes nuevos generados en este turno (asistente + herramientas). */
  newMessages: ModelMessage[];
  text: string;
}

/** Ejecuta un turno completo del bucle agéntico: modelo → herramientas → modelo… hasta terminar. */
export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: stepCountIs(opts.maxSteps),
    abortSignal: opts.abortSignal,
  });

  let text = '';
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        text += part.text;
        opts.onText?.(part.text);
        break;
      case 'tool-call':
        opts.onToolCall?.(part.toolName, part.input);
        break;
      case 'tool-result':
        opts.onToolResult?.(part.toolName, part.output);
        break;
      case 'tool-error':
        opts.onToolResult?.(part.toolName, `Error: ${String(part.error)}`);
        break;
      case 'error':
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  return { newMessages: (await result.responseMessages) as ModelMessage[], text };
}
