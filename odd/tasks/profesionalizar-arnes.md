# Profesionalizar el arnés

**Objetivo:** que un desarrollador pueda instalar, usar y contribuir al arnés con calidad verificable.
**Alcance autorizado:** herramientas de calidad, documentación, CI y licencia. Incluye endurecimiento de classifyCommand, timeout de bash sin esperar a los hijos y rutas con "/" en las confirmaciones; el resto es herramientas, documentación y CI.
**TDD:** desactivado (sin configuración que lo active); runner: `npm test` (vitest).
**Ruta:** directa en línea (archivos de configuración y documentación, sin diseño pendiente).

## Tareas
- [x] T1 Biome: lint y formato con scripts `lint`, `format`, `check`; corregir hallazgos (commit 8114fc4)
- [x] T2 `AGENTE.md`, `LICENSE` (MIT) y `.gitignore` (.codegraph, agente.config.json, .atl) (commit e923add)
- [x] T3 CI en GitHub Actions: lint, typecheck, test en Linux y Windows (commit 13ef185)
- [x] T4 README: instalación global (`npm link`), requisito de Git Bash en Windows, `gh`/MCP para PR (commit 13ef185)
- [x] T5 Endurecer classifyCommand con tests adversariales (deny, ask, allow)
- [x] T6 Avisos de la revisión: permissions en CI, tests del timeout de bash y de rel()

## Verificación
`npm run lint` · `npm run typecheck` · `npm test`

## Progreso
T1-T6 completas (127 tests, lint y typecheck verificados; tres revisiones aprobadas). Pendiente: cerrar el bypass de comillas y globs en la guía de lectura, reforzar el test del cierre tardío, dividir cli.ts y la prueba de punta a punta.
