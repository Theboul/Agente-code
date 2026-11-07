import type { ModelMessage } from 'ai';

/**
 * Un turno que terminó mal (error, interrupción con Esc, cuota agotada) pero dejó trabajo hecho: `partial` son los mensajes
 * de los pasos que SÍ se completaron (llamadas a herramientas con sus resultados). La sesión los conserva para no perder
 * lo que ya se hizo en disco.
 */
export class ModelTurnError extends Error {
  constructor(
    message: string,
    readonly partial: ModelMessage[] = [],
    readonly interrupted = false,
  ) {
    super(message);
    this.name = 'ModelTurnError';
  }
}

/** Nota que se añade tras un turno parcial, para que el historial termine de forma válida y el modelo sepa qué pasó. */
export const INTERRUPTED_NOTE =
  '[El turno se interrumpió o falló antes de terminar. Lo anterior es el trabajo que sí se completó; comprueba el estado antes de seguir.]';
