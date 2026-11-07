import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Los tests nunca deben leer ni escribir el ~/.agente real del usuario.
// Las pruebas con git real (repo, remoto, push) tardan hasta 5 s en Windows: el límite por defecto de vitest (5 s) las dejaba en el filo.
export default defineConfig({
  test: { env: { AGENTE_HOME: join(tmpdir(), 'agente-test-home') }, testTimeout: 30_000, hookTimeout: 30_000 },
});
