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
