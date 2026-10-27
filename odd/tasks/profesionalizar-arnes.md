# Profesionalizar el arnés

**Objetivo:** que un desarrollador pueda instalar, usar y contribuir al arnés con calidad verificable.
**Alcance autorizado:** herramientas de calidad, documentación, CI y licencia. Sin cambios de comportamiento del agente.
**TDD:** desactivado (sin configuración que lo active); runner: `npm test` (vitest).
**Ruta:** directa en línea (archivos de configuración y documentación, sin diseño pendiente).

## Tareas
- [x] T1 Biome: lint y formato con scripts `lint`, `format`, `check`; corregir hallazgos (commit 8114fc4)
- [x] T2 `AGENTE.md`, `LICENSE` (MIT) y `.gitignore` (.codegraph, agente.config.json, .atl) (commit e923add)
- [x] T3 CI en GitHub Actions: lint, typecheck, test en Linux y Windows (commit 13ef185)
- [x] T4 README: instalación global (`npm link`), requisito de Git Bash en Windows, `gh`/MCP para PR (commit 13ef185)

## Verificación
`npm run lint` · `npm run typecheck` · `npm test`

## Progreso
T1-T4 completas. lint, typecheck y 50 tests verificados. Siguiente: tests adversariales de classifyCommand, dividir cli.ts, prueba de punta a punta.
