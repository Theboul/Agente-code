import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Los tests nunca deben leer ni escribir el ~/.agente real del usuario.
export default defineConfig({ test: { env: { AGENTE_HOME: join(tmpdir(), 'agente-test-home') } } });
