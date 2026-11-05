# Falsos positivos de permisos y test del timeout

**Objetivo:** cerrar los avisos que dejaron las revisiones: `shutdown`/`reboot`/`poweroff` bloqueados dentro de argumentos, y un test del cierre tardío del timeout que sí pruebe algo.
**Alcance autorizado:** `src/permissions.ts`, `test/permissions.test.ts`, `test/core.test.ts`. Sin otros cambios de comportamiento.
**TDD:** desactivado (sin configuración); runner: `npm test` (vitest).
**Ruta:** directa en línea (dos archivos de código pequeños y entendidos).

## Tareas
- [x] T1 Acotar `shutdown`/`reboot`/`poweroff` a la posición de comando, con tests de falsos positivos y de bloqueos que deben seguir
- [x] T2 Test del cierre tardío: sin rechazos no manejados y salida posterior no incluida

## Verificación
`npm run lint` · `npm run typecheck` · `npm test`

## Progreso
T1 y T2 completas: 176 tests, lint y typecheck verificados. 5 tests de falsos positivos fallaban antes del cambio.

## Prueba de punta a punta (2026-11-02)
Repositorio de juguete en el directorio temporal, modelo real `google/gemini-3.5-flash-lite`:
- `agente work ... --yes`: plan, rama, implementación (`multiply` + test), verificación 2/2 y revisión OK. Verificado aparte: `npm test` 2 pasan, 0 fallan.
- `agente ship`: commit en Conventional Commits en español, sin coautor, autor correcto; push a un remoto local OK.
- Hallazgo: con `gh` autenticado pero un remoto que no es de GitHub, `gh pr create` fallaba y abortaba `ship` (exit 1) sin ofrecer el enlace manual. Corregido: en modo `auto` cae a MCP y luego a enlace manual, con el motivo (`PrOutcome.note`). Un método explícito sigue propagando el fallo.
- Pendiente: probar `ship` contra GitHub real y con un MCP de PR; con un remoto no GitHub el enlace manual dice "no se reconoce el remoto".
