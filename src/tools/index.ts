import { createBashTool, createFsTools, createTodoTools, type TodoItem } from '@openharness/core';
import type { ToolSet } from 'ai';
import type { Permissions } from '../permissions.js';
import { askUserTool, webFetchTool } from './extra.js';
import { GuardedFsProvider, GuardedShellProvider, withLiteralEdit } from './guarded.js';

export interface ToolOptions {
  /** Se llama cada vez que el modelo actualiza su lista de tareas. */
  onTodos?: (todos: TodoItem[]) => void;
}

/**
 * Herramientas del agente. Archivos, shell y lista de tareas vienen de @openharness/core; aquí solo se
 * les pone por debajo el proveedor con seguridad (rutas del proyecto + confirmaciones).
 */
export function nativeTools(cwd: string, perms: Permissions, opts: ToolOptions = {}): ToolSet {
  const fs = new GuardedFsProvider(cwd, perms);
  const fsTools = createFsTools(fs);
  const { bash } = createBashTool(new GuardedShellProvider(cwd, perms));
  const todos = createTodoTools({ onUpdate: ({ todos }) => opts.onTodos?.(todos) });
  return {
    ...fsTools,
    editFile: withLiteralEdit(fsTools.editFile, fs),
    bash,
    ...todos,
    ask_user: askUserTool(perms),
    web_fetch: webFetchTool(perms),
  } as ToolSet;
}

/** Herramientas de solo lectura, para la etapa de planificación. */
export function readOnlyTools(cwd: string, perms: Permissions): ToolSet {
  const { readFile, listFiles, grep } = createFsTools(new GuardedFsProvider(cwd, perms));
  return { readFile, listFiles, grep, ask_user: askUserTool(perms), web_fetch: webFetchTool(perms) } as ToolSet;
}
