# agente — hoja de defensa (1 página)

**Qué es:** arnés de código para consola, estilo Claude Code, en TypeScript. Convierte una issue de Jira/Trello/GitHub en una rama con cambios verificados, commit, push y PR opcional, con el humano aprobando cada paso.

**Demo (5 min):** `npm run demo` (subagente, sin red) → `agente` en un proyecto: pedir un cambio, ver permisos y diff coloreado → `/status`, `/remember`, `/memory` → `/connect jira`, `/issues`, flujo completo.

**Qué lo distingue**
1. Multi-modelo (Gemini por defecto; Anthropic/OpenAI/Ollama) con roles plan/implement/light.
2. MCP real para trackers; el flujo sincroniza el estado de la issue.
3. Memoria completa: sesiones retomables, compactación automática, `/remember`, memoria del flujo.
4. Subagentes de solo lectura con contexto aislado.
5. Seguridad por capas: rutas, comandos, confirmaciones, secretos redactados, contenido externo como datos, archivos de configuración que siempre piden confirmación.
6. Modelo de respaldo si se agota la cuota.
7. Verificado en Linux y Windows (CI + smoke).

**Arquitectura:** capas + inyección de dependencias; bucle de agente; pipeline lineal. Ver `docs/ARQUITECTURA.md`.

**Preguntas probables**
- *¿Por qué JSON y no SQLite?* Una sesión se lee y escribe entera; sin consultas relacionales; legible y portable.
- *¿Qué pasa si se acaba la cuota?* Reintentos con espera sugerida, se conserva el trabajo parcial, aviso claro.
- *¿Y si una issue contiene una orden maliciosa?* El prompt la trata como dato y las acciones sensibles piden confirmación.
- *¿Por qué los subagentes no escriben?* Evita conflictos y mantiene el control humano.
- *¿Qué no cubre aún?* Ejecución en sandbox, OAuth de Atlassian, interfaz interactiva probada solo en CI en Windows.

**Cifras:** ~360 pruebas, 9 comprobaciones de extremo a extremo, CI en 2 sistemas operativos.
