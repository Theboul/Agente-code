export type Decision = 'allow' | 'ask' | 'deny';

export type Asker = (question: string) => Promise<boolean>;

export interface Permissions {
  /** Pide confirmación al usuario (o la deniega si no hay terminal interactivo). */
  confirm: Asker;
  /** Aprobar todo sin preguntar (modo --yes). */
  autoApprove: boolean;
  allowedCommands: string[];
}

const DENY_PATTERNS = [/\bgit\s+push\b.*--force\b/, /\bgit\s+push\b.*\s-f\b/, /\brm\s+-rf?\s+\/(\s|$)/, /\bsudo\b/];
// Operadores de shell que permiten encadenar otro comando tras uno "permitido".
const CHAINING = /[;&|`$()<>\n]/;

export function classifyCommand(command: string, allowed: string[]): Decision {
  const cmd = command.trim();
  if (DENY_PATTERNS.some((r) => r.test(cmd))) return 'deny';
  if (CHAINING.test(cmd)) return 'ask';
  return allowed.some((p) => cmd === p || cmd.startsWith(p + ' ')) ? 'allow' : 'ask';
}

export async function authorize(perms: Permissions, decision: Decision, question: string): Promise<boolean> {
  if (decision === 'deny') return false;
  if (decision === 'allow' || perms.autoApprove) return true;
  return perms.confirm(question);
}
