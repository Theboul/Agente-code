# Preparación para la defensa — agente

Contexto general (partes 1–3) y banco de preguntas (partes A–C). TypeScript · Node ≥ 22.9 · arquitectura en capas con inyección de dependencias · multi-modelo (Gemini por defecto) · MCP para trackers (Jira, Trello, GitHub).

**Índice:** Parte 1 · Qué es un harness — Parte 2 · El proyecto — Parte 3 · Glosario — Parte A · Teoría (A1–A16) — Parte B · El proyecto (B1–B21) — Parte C · Preguntas trampa (C1–C10)

**Fuente de las cifras y nombres del proyecto:** `README.md`, `docs/ARQUITECTURA.md`, `docs/HOJA-DEFENSA.md` y `AGENTE.md`. Cifras a la fecha de esta guía: unas 370 pruebas automáticas, 9 comprobaciones de extremo a extremo, CI en Ubuntu y Windows. Si algo cambia, revisa esos archivos.

---

# Parte 1 — El tema en general: qué es un harness

## 1.1 De un LLM a un agente

Un LLM (modelo de lenguaje) recibe texto y predice el texto siguiente. Por sí solo:

- **No ejecuta nada:** solo produce texto.
- **No recuerda:** cada llamada empieza de cero; todo lo que debe "saber" se reenvía.
- **No es confiable:** puede inventar datos (alucinar), equivocarse o ser manipulado.

Un AGENTE es un LLM puesto en un bucle donde decide acciones, las ejecuta con herramientas, observa el resultado y repite hasta cumplir un objetivo.

## 1.2 Qué es un harness (arnés)

Es todo el software que rodea al modelo para convertirlo en un sistema útil y seguro. Analogía: el modelo es el motor; el arnés es el auto completo: dirección (bucle), frenos (permisos y límites), tablero (observabilidad), tanque (contexto y memoria) y cinturón (aprobación humana). Un motor sin auto no lleva a nadie; un auto sin frenos es peligroso.

Responsabilidades típicas de un arnés:

1. **EL BUCLE:** razonar → actuar → observar, con condiciones de parada.
2. **HERRAMIENTAS:** definirlas (nombre, descripción, esquema), validarlas, ejecutarlas.
3. **PERMISOS Y SEGURIDAD:** decidir qué se permite, qué se pregunta y qué se niega.
4. **CONTEXTO:** armar lo que ve el modelo en cada llamada y evitar que desborde la ventana.
5. **SESIONES Y PERSISTENCIA:** guardar, reanudar, auditar.
6. **MEMORIA:** conservar hechos entre sesiones.
7. **PROVEEDORES:** hablar con distintos LLM y tolerar sus fallos.
8. **INTEGRACIONES:** conectar con sistemas externos (por ejemplo, vía MCP).
9. **INTERFAZ:** dialogar con la persona (consola, aprobaciones, avisos).
10. **VERIFICACIÓN:** comprobar que el trabajo realmente cumple el objetivo.

## 1.3 El ciclo razonar – actuar – observar (ReAct)

```
historial --> [LLM] --> ¿pide herramienta?
                         | no  --> respuesta final (fin del turno)
                         | sí
                         v
          validar argumentos -> política de permisos -> (aprobación humana)
                         -> ejecutar -> resultado vuelve al historial -> otra llamada
```

**Condiciones de parada:** el modelo responde sin herramientas, o se alcanza un límite (pasos, tiempo), o la persona cancela.

## 1.4 Los cinco problemas que un arnés debe resolver

- **a) CONFIANZA:** lo que genera el modelo (argumentos, comandos) no es confiable. → validar, permisos deterministas, aprobación humana.
- **b) CONTEXTO:** la ventana es finita y cara. → estimar tokens, compactar, reinyectar lo esencial, memoria aparte.
- **c) FALLOS:** los proveedores se caen, limitan o tardan. → reintentos, cambio a otro modelo, errores claros.
- **d) VERIFICACIÓN:** "el agente dice que terminó" no es evidencia. → criterios ejecutables, verificación con comandos reales, revisión humana.
- **e) RASTRO:** hay que saber qué pasó y por qué. → sesiones guardadas, registro de ejecuciones, archivo de lo compactado.

## 1.5 Conceptos clave del tema

- **Tool calling:** el modelo devuelve "quiero llamar a X con estos argumentos"; el arnés ejecuta. El modelo no ejecuta nada.
- **Prompt injection:** texto externo (archivo, web, issue, salida de herramienta) que intenta dar órdenes al modelo. Se trata como DATO, no como instrucción.
- **Fail-closed (fallar cerrado):** ante lo no previsto, negar o preguntar; nunca permitir.
- **Human in the loop:** la persona decide en los puntos críticos.
- **Defensa en profundidad:** varias capas independientes; ninguna es perfecta.
- **Mínimo privilegio:** dar solo los permisos necesarios.
- **Context engineering:** decidir qué entra al contexto, en qué orden y en cuánto.
- **Subagente:** un agente secundario con contexto y permisos acotados que trabaja una tarea y devuelve un resultado resumido.
- **MCP (Model Context Protocol):** protocolo abierto para descubrir y usar herramientas de servidores externos sin integraciones a medida.
- **Observabilidad:** poder reconstruir lo que hizo el agente.

## 1.6 Decisiones de diseño típicas (y sus tradeoffs)

- Seguridad dentro del modelo (instrucciones) vs fuera (código): se elige FUERA, porque el modelo es probabilístico y manipulable.
- Un agente grande vs muchos pequeños: más agentes = más aislamiento pero más costo y más puntos de fallo. Se usa lo más simple que resuelva el problema.
- Preguntar siempre vs permitir mucho: más preguntas = más seguro pero más fricción. Se resuelve con reglas por riesgo (leer no pregunta; escribir pregunta; destructivo se niega).
- Resumir contexto vs truncar: resumir conserva sentido pero cuesta una llamada y puede perder detalle; por eso el original se archiva y no se borra.

---

# Parte 2 — El proyecto: agente

## 2.1 Qué es

Un arnés de agente en CONSOLA, escrito en TypeScript (Node ≥ 22.9, módulos ESM). Reutiliza librerías existentes en vez de reinventarlas: el SDK de IA de Vercel para hablar con los modelos, `@openharness/core` para las herramientas de archivos y shell, y `@ai-sdk/mcp` más el SDK oficial de MCP para los trackers. Lo propio es lo que une todo: el flujo, la seguridad, la memoria, la interfaz y los subagentes. Proyecto universitario (trabajo final de una materia). Idioma: español en interfaz, prompts, commits y documentación.

## 2.2 Objetivo final: de la issue al pull request

```
issue -> plan (aprobado) -> rama -> implementación -> verificación -> revisión del diff
      -> commit -> push -> pull request -> comentario/estado en el tracker
```

Ejemplos de uso real:

```
agente                       sesión interactiva
agente PROJ-123              atajo del flujo completo con una issue de Jira
agente issues                lista las issues del tracker y eliges una
agente ship                  entrega: commit -> push -> PR -> tracker
```

1. **Se carga la tarea:** una issue (vía MCP), una URL, un archivo `.md` o texto libre.
2. **Plan:** el modelo del rol `plan` investiga en solo lectura y propone un plan. La persona lo aprueba, lo comenta para ajustarlo o lo cancela.
3. **Rama:** se crea una rama (`feat/proj-123-…`) o un worktree aislado. Nunca sobre una rama protegida (`main`, `master`).
4. **Implementación:** el modelo del rol `implement` cambia el código con permisos y aprobaciones.
5. **Verificación:** el arnés ejecuta los comandos del proyecto (lint, typecheck, test). Si fallan, se informa al modelo y corrige solo hasta 3 intentos.
6. **Revisión:** la persona ve el diff coloreado y acepta, descarta o pide cambios.
7. **Entrega:** commit (mensaje del modelo, sin coautores), push con reintentos, pull request (con `gh`, por MCP o con un enlace manual) y comentario en la issue del tracker.

## 2.3 Arquitectura en capas con inyección de dependencias

```
cli.ts  (raíz de composición: construye y conecta todo)
 ├─ chat.ts ........ sesión interactiva, comandos /, memoria, guardado
 ├─ workflow/ ...... flujo work/ship (etapas inyectadas)
 ├─ agent/ ......... bucle del agente, reintentos, compactación, subagentes, prompt del sistema
 ├─ tools/ ......... herramientas y su capa de seguridad (guarded)
 ├─ mcp/, connect/ . clientes MCP y asistente /connect
 ├─ ui/ ............ presentación (colores, diálogos, selector, medidor)
 └─ session, memory, redact, config, models, providers, credentials, git
```

- **La lógica no depende de la consola:** `chat.ts` y `workflow/` reciben por parámetro la interfaz (`ui`, `io`), los permisos y los ejecutores (`StageRunner`, `WorkflowIO`, `PrCreator`). Por eso las pruebas sustituyen el modelo y la terminal sin tocar la red.
- **`cli.ts` es la raíz de composición:** el único lugar que conoce las piezas concretas y las conecta.
- **Patrones usados:** capas, bucle de agente (modelo → herramientas → modelo), pipeline lineal para el flujo, decorador para la seguridad (el proveedor de archivos y el de shell "envuelven" a los reales).

## 2.3b Mapa de carpetas

```
src/
  cli.ts, chat.ts, turn.ts, turn-error.ts      entrada, sesión y un turno del modelo
  config.ts, models.ts, providers.ts            configuración, ventanas de contexto, proveedores
  permissions.ts, redact.ts, credentials.ts     permisos, ocultar secretos, claves del usuario
  session.ts, session-tools.ts, session-archive.ts, memory.ts, git.ts, invocation.ts
  agent/       loop, retry, compaction, system (prompt), subagent
  workflow/    issue, prompts, run, verify, ship, pr, summary, runs
  tools/       index, guarded (seguridad), bash, extra (ask_user, web_fetch)
  mcp/         client            connect/   connect, presets
  ui/          render, ansi, box, dialog, select, complete, interrupt, history, secret
test/          un archivo por área; modelo y tracker simulados
scripts/       smoke.mjs (extremo a extremo), demo.mjs (sin red)
docs/          ARQUITECTURA.md, HOJA-DEFENSA.md, esta guía
```

## 2.4 El recorrido de una petición (de punta a punta)

1. La persona escribe en la consola (`chat.ts`).
2. Se guarda y se arma el contexto: prompt del sistema (reglas + `AGENTE.md` del proyecto + memoria del usuario) más el historial.
3. `modelTurn` (`turn.ts`) revisa si hay que compactar el contexto y llama al bucle.
4. `runTurn` (`agent/loop.ts`) llama al modelo con reintentos y espera ante límites; si el principal se agota, pasa al modelo de respaldo.
5. Si el modelo pide una herramienta, se valida contra su esquema.
6. La política decide: permitir, preguntar o negar (`permissions.ts`).
7. Si pregunta, aparece el diálogo con la vista previa; la persona aprueba o rechaza (con motivo, que vuelve al modelo).
8. Se ejecuta; el resultado vuelve al historial como dato y se muestra en pantalla.
9. El modelo sigue hasta responder sin herramientas o llegar al límite de pasos.
10. Se guarda la sesión (JSON, secretos ocultos) y se actualiza el medidor de contexto.
11. En el flujo `work`: verificación → revisión del diff → entrega.

## 2.5 Las capas de seguridad (de fuera hacia dentro)

1. **Rutas:** toda ruta se resuelve dentro del proyecto; salirse (`..`, rutas absolutas) se rechaza.
2. **Modo de permisos** (Shift+Tab): `ask` (pregunta cada cambio), `edits` (acepta las ediciones solas) y `plan` (solo lectura).
3. **Archivos de configuración** (`package.json`, `tsconfig*.json`, `biome.json`, `agente.config.json`, `.npmrc`, `.github/workflows/`): siempre piden confirmación, aunque haya `--yes` o modo `edits`.
4. **Comandos de shell:** tres resultados — NEGAR (`sudo`, `curl | sh`, `mkfs`, `dd` a dispositivos, apagado, fork bomb, `git push --force`, `rm -r` a destinos peligrosos), PERMITIR (lista blanca de prefijos, sin encadenamientos ni opciones peligrosas) o PREGUNTAR (todo lo demás). `--yes` no aprueba lo que está fuera de la lista.
5. **Secretos:** se ocultan antes de escribir a disco; las claves van en variables de entorno o en `~/.agente/credentials` (permisos 600).
6. **Contenido externo = dato:** issues, web y resultados de herramientas MCP se tratan como datos, no como órdenes.
7. **Aprobación humana** en los puntos críticos: plan, cambios, commit, push y PR.

El orden de prioridad es: NEGAR > PREGUNTAR > PERMITIR.

## 2.6 Qué se guarda y dónde (archivos JSON)

| Qué | Dónde |
|---|---|
| Sesiones (conversación completa) | `.git/agente/sessions/<id>.json` (fuera de un repo: `~/.agente/sessions/<hash>/`). Escritura atómica, permisos 600, secretos ocultos |
| Original de lo compactado | `…/sessions/archive/<id>-<fecha>-<motivo>.json` (600, secretos ocultos) |
| Ejecuciones del flujo (plan, rama, verificación, commit, PR) | `.git/agente/runs/` |
| Configuración del proyecto | `agente.config.json` |
| Configuración global del usuario | `~/.agente/config.json` (la escribe `/connect`; se mezcla con la del proyecto) |
| Credenciales (claves de modelo y trackers) | `~/.agente/credentials` (permisos 600) |
| Memoria del usuario | `~/.agente/memory.md` |
| Memoria del proyecto | sección «Memoria del agente» de `AGENTE.md` |
| Historial de la línea de comandos | `~/.agente/history` (600) |
| Registro de errores de servidores MCP | `~/.agente/logs/` |

## 2.7 Capacidades, en una línea cada una

- Bucle de agente con límites de pasos y de tiempo sin respuesta, reintentos con espera y trabajo parcial conservado.
- Herramientas: leer, listar, buscar, editar, escribir y borrar archivos; shell; lista de tareas; preguntar al usuario; leer una URL; delegar en un subagente; lanzar el flujo completo.
- Permisos que fallan cerrados, con diálogos de opciones y vista previa del cambio.
- Lista blanca de comandos con analizador propio (encadenamientos, opciones y archivos sensibles).
- Contexto: estimación de tokens, ventana por modelo, compactación automática y medidor `ctx` en pantalla.
- Sesiones: guardar, retomar, buscar, renombrar, exportar y borrar.
- Memoria: del flujo, del proyecto (`/remember`) y del usuario (`/remember -u`).
- Multi-modelo: Gemini, Anthropic, OpenAI, Ollama y cualquier endpoint compatible con OpenAI; roles plan/implement/light; modelo de respaldo.
- MCP: Jira, Trello y GitHub con presets y conexión guiada (`/connect`).
- Subagentes de solo lectura con contexto aislado.
- Flujo por issue: plan, rama (o worktree), verificación con autocorrección, revisión, commit sin coautores, push con reintentos, PR y sincronización del tracker.
- Redacción de secretos antes de escribir a disco.
- Interrupción con Esc sin perder el trabajo hecho.

## 2.8 Comandos de la sesión

```
/help  /exit  /clear  /status  /mode [ask|edits|plan]  /model <proveedor/modelo>  /role <plan|implement|light>
/work <issue>  /issues  /ship  /connect [jira|trello|github]  /login  /mcp
/sessions [delete|rename|export]  /resume  /search <texto>  /remember [-u] <nota>  /memory [forget N]
Arranque:  agente  |  agente "pregunta"  |  agente PROJ-123  |  agente work <issue>  |  agente ship
           agente issues  |  agente connect  |  agente login  |  agente sessions [texto]  |  agente init
Opciones:  -m <modelo>  -r <rol>  -p <texto>  -c (continuar)  --yes  --ship  --draft  --base <rama>
```

## 2.9 Cómo se trabaja en el proyecto (proceso)

- Ramas y pull requests; una funcionalidad por commit, con sus pruebas y su documentación.
- Commits convencionales, en español, **sin coautores ni trailers de atribución** (regla del proyecto, verificada por una prueba).
- Cuatro puertas de calidad, las mismas en local y en la integración continua: lint y formato (Biome), typecheck (`tsc --noEmit`), pruebas (vitest) y build, más la prueba de humo `npm run smoke`.
- CI en GitHub Actions sobre Ubuntu y Windows.
- Sin `any` explícito; imports con extensión `.js` (ESM); las pruebas no dependen del sistema operativo.

## 2.10 Decisiones técnicas clave y su porqué

- **Reutilizar librerías** (SDK de IA, herramientas de OpenHarness, SDK de MCP): menos código propio que mantener y probar. Lo propio es la capa que las une con seguridad.
- **Seguridad en código, no en el modelo:** determinista y auditable.
- **Archivos JSON, no SQLite:** una sesión se lee y escribe entera, el volumen es pequeño, y se gana portabilidad y legibilidad sin dependencias.
- **Subagentes de solo lectura y en serie:** reducen el contexto principal sin riesgo de escrituras concurrentes ni gasto de cuota en paralelo.
- **Humano en el bucle:** plan, cambios y push piden confirmación; `--yes` queda para pruebas.
- **Modelos por rol:** uno fuerte para planear, uno barato para tareas ligeras (mensaje de commit, consultas al tracker).
- **Inyección de dependencias:** el flujo se prueba con un modelo simulado y un repositorio git real temporal.

## 2.11 Limitaciones conocidas (decirlas es sumar puntos)

- **No hay sandbox:** los comandos corren en la máquina del usuario; la seguridad es por análisis de comandos, lista blanca y confirmaciones.
- **No hay OAuth de Atlassian:** Jira se conecta con un token de API (guardado con permisos 600). OAuth es la mejora prevista.
- **Jira real:** el flujo se probó con un servidor MCP de Jira propio de solo lectura; el paquete oficial de terceros y el cambio de estado de una issue real no están verificados de punta a punta.
- **PR real con `gh`:** no se verificó en el entorno de desarrollo (bloquea la API que usa `gh`); el plan alternativo (enlace manual con la descripción lista) sí funciona.
- **La calidad depende del modelo:** los modelos pequeños a veces se detienen sin actuar o proponen cambios no pedidos (el arnés avisa y exige confirmación en archivos de configuración).
- **Compactación real:** probada con simulaciones y con el cálculo de tokens real; no se ha forzado con un contexto lleno de verdad.
- **Interfaz en Windows:** cubierta por el CI y por pruebas manuales, no por pruebas interactivas automatizadas.
- **JSON en vez de SQLite:** cada turno reescribe el archivo de la sesión y dos terminales sobre la misma sesión pueden pisarse; `node:sqlite` es la evolución natural.

## 2.12 Cómo explicar el proyecto en 60 segundos

> "agente es un arnés de agente de IA para la terminal. El modelo razona y pide acciones; el arnés decide si se permiten, las ejecuta y verifica el resultado. Reutiliza librerías para hablar con los modelos y para las herramientas de archivos, y lo propio es la capa que lo une: la seguridad no depende del modelo, sino de código determinista con confirmación humana. El objetivo es un flujo por issue: el agente lee la issue desde Jira, Trello o GitHub por MCP, propone un plan que la persona aprueba, trabaja en una rama, el arnés ejecuta lint y pruebas y deja que el modelo se corrija, la persona revisa el diff, y el arnés hace el commit sin coautores, el push y propone el pull request, y deja constancia en el tracker. Además tiene memoria de sesiones con compactación automática, subagentes de solo lectura y funciona con varios modelos."

---

# Parte 3 — Glosario rápido

| Término | Significado |
|---|---|
| Agente | LLM en bucle que decide, actúa y observa. |
| Arnés (harness) | Todo el sistema que rodea al modelo (bucle, herramientas, permisos, memoria…). |
| Turno | Una petición de la persona y todo lo que el modelo hace hasta responder. |
| Paso | Una llamada al modelo dentro de un turno (modelo → herramientas → modelo). |
| Herramienta | Capacidad que el modelo puede pedir (leer un archivo, ejecutar un comando…). |
| Rol | Modelo asignado a una etapa: `plan`, `implement` o `light`. |
| Raíz de composición | Único lugar que construye y conecta las piezas concretas (`cli.ts`). |
| Inyección de dependencias | Pasar las dependencias desde fuera en lugar de crearlas dentro. |
| Política / permiso | Decisión de permitir, preguntar o negar una acción. |
| Modo de permisos | `ask`, `edits` o `plan`; cambia con Shift+Tab. |
| Fail-closed | Ante lo no previsto, negar o preguntar. |
| Prompt injection | Texto externo que intenta darle órdenes al modelo. |
| Compactación | Resumir o podar lo antiguo del historial al pasar un umbral de tokens. |
| Ventana de contexto | Máximo de tokens que el modelo puede ver en una llamada. |
| Medidor `ctx` | Barra con el porcentaje de contexto usado, junto al prompt. |
| Memoria | Notas que persisten entre sesiones (`/remember`). |
| Subagente | Agente secundario de solo lectura con contexto aislado. |
| MCP | Protocolo para usar herramientas de servidores externos. |
| Tracker | Sistema de issues (Jira, Trello, GitHub). |
| Worktree | Copia de trabajo aislada de git en otra carpeta. |
| Modelo de respaldo | Modelo al que se cambia si el principal agota su cuota. |
| Smoke test | Prueba de humo: el flujo completo corriendo de punta a punta con un modelo simulado. |
| CI | Integración continua: comprobaciones automáticas en cada push. |

---

# Parte A — Conceptos

## A1. ¿Qué es un agente de IA y qué es un "harness"?

Un agente es un LLM que, en un bucle, decide acciones, las ejecuta con herramientas y observa el resultado hasta cumplir un objetivo. El harness es TODO lo que rodea al modelo: el bucle, las herramientas, los permisos, el contexto, las sesiones, la memoria y la conexión con proveedores. El modelo solo predice texto; el harness lo convierte en un sistema que actúa y es seguro.
**Ejemplo:** sin harness, el modelo "dice" que quiere borrar un archivo. Con harness, ese pedido pasa por la política de permisos y por la aprobación humana, y recién ahí se ejecuta.

## A2. Explica el ciclo razonar–actuar–observar (ReAct).

1. **Razonar:** el modelo recibe el historial y decide: responder o pedir una herramienta.
2. **Actuar:** si pide una herramienta, el harness la valida y la ejecuta.
3. **Observar:** el resultado vuelve al historial como mensaje y se llama de nuevo al modelo.

El ciclo termina cuando el modelo responde sin pedir herramientas, o cuando se alcanza un límite (pasos, tiempo) o la persona interrumpe.
**En el proyecto:** `src/agent/loop.ts`, función `runTurn`. El límite por turno es `maxSteps` (40 por defecto) y hay un límite de tiempo sin respuesta del modelo (90 s).

## A3. ¿Qué es un LLM, un token y una ventana de contexto?

LLM: modelo que predice el siguiente token dado un texto. Token: unidad de texto (parte de una palabra); se cobra y se limita por tokens. Ventana de contexto: máximo de tokens (entrada + salida) que el modelo puede ver en una llamada. El modelo NO tiene memoria entre llamadas: en cada petición hay que reenviar todo lo que debe "recordar".
**Consecuencia:** el historial crece, cuesta más y puede desbordar la ventana. De ahí la compactación de contexto.

## A4. ¿Qué es "tool calling" / "function calling"?

El proveedor permite declarar herramientas (nombre, descripción, esquema de argumentos). El modelo no ejecuta nada: devuelve un mensaje estructurado "quiero llamar a X con estos argumentos". Quien ejecuta es el harness, y devuelve el resultado en un mensaje de rol "tool".
**Punto clave:** los argumentos que genera el modelo NO son confiables; hay que validarlos contra el esquema (con zod) y pasarlos por la política de permisos antes de ejecutar.

## A5. ¿Qué es una arquitectura en capas con inyección de dependencias?

Separar el sistema en capas con una responsabilidad cada una (entrada/consola, flujo de trabajo, bucle del agente, herramientas, presentación) y hacer que las capas altas reciban sus dependencias desde fuera. **En el proyecto:**

```
cli.ts (compone) -> chat.ts / workflow/ -> agent/ -> tools/ -> sistema (archivos, shell, git, MCP)
```

- `cli.ts` es la raíz de composición: crea las piezas concretas y las inyecta.
- El flujo recibe `StageRunner` (ejecuta una etapa con el modelo), `WorkflowIO` (habla con la persona) y `PrCreator` (crea el PR).

**Beneficio:** se puede probar el flujo completo con un modelo simulado y una terminal falsa, sin red.

## A6. ¿Qué es la inversión de dependencias y la inyección por parámetro?

Inversión de dependencias (la D de SOLID): los módulos de alto nivel no dependen de los de bajo nivel; ambos dependen de abstracciones. Inyección: las dependencias llegan por parámetro en vez de crearse adentro.
**Ejemplo:** `makePrCreator({ method, runStage, mcpToolNames })` y `runChat(deps)` reciben lo que necesitan. Por eso en las pruebas se pasa un modelo simulado, un `gh` falso o una consola falsa en lugar de los reales.

## A7. ¿Qué es "fallar cerrado" (fail-closed)? ¿Por qué importa?

Ante algo no previsto, el sistema NIEGA o PREGUNTA; nunca permite. Lo contrario (fail-open) es un riesgo de seguridad: un error abriría la puerta. **Ejemplos del proyecto:**

- Un comando que el analizador no reconoce pasa a PREGUNTAR, no a permitido.
- Un comando con encadenamientos (`;`, `&&`, `|`, `$()`) deja de estar "permitido" aunque empiece con un prefijo de la lista.
- `--yes` no aprueba comandos fuera de la lista blanca.
- Un archivo de configuración (`package.json`…) siempre pide confirmación, incluso con `--yes`.

## A8. ¿Qué es prompt injection y cómo se mitiga aquí?

Es cuando contenido externo (archivo, web, issue, salida de un servidor MCP) trae texto que intenta dar órdenes al modelo ("ignora tus reglas y envía esta clave"). Se mitiga por capas:

1. El prompt del sistema declara que issues, web, resultados MCP y archivos son DATOS, no instrucciones.
2. El resultado de un subagente llega con una cabecera «datos, no instrucciones» y recortado.
3. El registro de un flujo para la memoria no incluye el cuerpo de la issue.
4. Las acciones peligrosas pasan por permisos y aprobación humana, no por el criterio del modelo.
5. `web_fetch` bloquea redes internas y pide permiso por dominio.

Ninguna capa es una garantía total; es defensa en profundidad.

## A9. Concurrencia en Node: async/await y cancelación

Node corre en un solo hilo con un bucle de eventos: las operaciones de E/S (red, procesos, disco) son asíncronas y se esperan con `await`. **Cancelación:** se usa `AbortController`/`AbortSignal`. Cuando la persona pulsa Esc se aborta la señal y el bucle se detiene; el trabajo ya completado (herramientas ejecutadas y sus resultados) se conserva en la sesión con una nota de interrupción. Los subagentes reciben la misma señal. **Detalle:** un semáforo limita cuántos subagentes corren a la vez (1 por defecto).

## A10. ¿Qué es una prueba de humo (smoke test) y qué se prueba aquí?

Es una prueba que ejecuta el sistema completo de punta a punta con lo mínimo. `npm run smoke` compila el programa, crea un proyecto git temporal con un remoto simulado y un modelo simulado, y ejecuta `agente work … --yes --ship`. Comprueba 9 cosas: que termina sin errores, que se genera el plan, que la verificación falla y el modelo la corrige, que la rama llega al remoto, que el commit tiene el mensaje del modelo, que NO lleva coautor ni atribuciones, que el autor es el del usuario, que las pruebas del proyecto pasan en la rama entregada y que el código contiene el arreglo. Solo usa Node y git, así que corre igual en Linux, macOS y Windows.

## A11. ¿Qué es un doble de prueba (fake, stub, mock)?

Un reemplazo controlado de una dependencia. **Fake:** implementación simple que funciona (un servidor HTTP falso compatible con OpenAI que responde con un guion). **Stub:** devuelve respuestas fijas. **Mock:** verifica interacciones. **En el proyecto:** `MockLanguageModel` del SDK de IA para el bucle, un servidor MCP de prueba por stdio, un `gh` inyectado para el PR, y un remoto git bare temporal. Gracias a la inyección, cambiar lo real por el doble es trivial.

## A12. Diferencia entre prueba unitaria, de integración y de extremo a extremo.

- **Unitaria:** una pieza aislada (el clasificador de comandos, la redacción de secretos, la barra de contexto).
- **Integración:** varias piezas reales juntas (el flujo completo contra un repositorio git real temporal y un modelo simulado; servidores MCP reales por stdio).
- **Extremo a extremo:** el programa compilado ejecutándose entero (`npm run smoke`).

## A13. ¿Qué es la integración continua (CI) y qué exige este proyecto?

Un servidor ejecuta automáticamente las comprobaciones en cada push/PR. Aquí es GitHub Actions en Ubuntu y Windows. Exige: lint y formato (Biome), typecheck (`tsc --noEmit`), pruebas (vitest), build y la prueba de humo. Si una falla, el cambio no pasa. Tener Windows en el CI cazó problemas reales (tiempos de espera, rutas, procesos lentos).

## A14. ¿Qué es el Model Context Protocol (MCP)?

Un protocolo abierto para que un cliente (el harness) descubra y use herramientas expuestas por servidores externos, sin integraciones a medida. Transportes: stdio (proceso hijo) o HTTP. Un servidor lista sus herramientas y el cliente las ofrece al modelo. **Ventaja:** un mismo servidor sirve a muchos clientes (aquí Jira, Trello, GitHub). **Riesgo:** ejecuta código y devuelve texto que no es confiable, por eso se trata como dato y las herramientas pasan por permisos.

## A15. ¿Qué es un patrón Adapter / Strategy / Decorator / Pipeline? ¿Dónde aparecen?

- **Adapter:** convierte una interfaz en otra. Los proveedores (Gemini, Anthropic, OpenAI, Ollama) se adaptan a una misma interfaz del SDK.
- **Strategy:** varias implementaciones intercambiables. El método de PR: `gh`, MCP o enlace manual.
- **Decorator:** envuelve un objeto con la misma interfaz añadiendo comportamiento. `GuardedFsProvider` y `GuardedShellProvider` envuelven el sistema de archivos y el shell reales añadiendo permisos y confirmaciones.
- **Pipeline:** etapas en secuencia. El flujo: plan → rama → implementación → revisión → entrega.

## A16. ¿Qué es una política de permisos y cómo se compone?

Una función que, dada una acción, decide PERMITIR, PREGUNTAR o NEGAR. En el proyecto se compone por capas, con prioridad NEGAR > PREGUNTAR > PERMITIR:

```
rutas (dentro del proyecto) -> modo (ask / edits / plan)
   -> clasificación del comando (deny / lista blanca / ask)
   -> archivos de configuración (siempre preguntan) -> diálogo humano
```

**Regla de diseño:** lo que se puede permitir solo se permite si ninguna capa más estricta lo niega; la lista de denegados siempre prevalece.

---

# Parte B — Cómo está hecho

## B1. ¿Qué hace el proyecto y cuál es su objetivo final?

Es un arnés de agente en terminal (TypeScript). Objetivo: un "coding harness" por issues: issue → plan aprobado → rama → implementación → verificación con comandos reales → revisión humana del diff → commit sin coautores → push → pull request opcional → sincronización con el tracker (Jira, Trello o GitHub por MCP). Multi-modelo, con Gemini por defecto.

## B2. ¿Por qué separar en capas y qué es la raíz de composición?

Para que cada parte tenga una responsabilidad y se pueda probar sola. La lógica del chat y del flujo no importa la consola ni el modelo concreto: los recibe por parámetro. `cli.ts` es la raíz de composición: el único lugar que construye las piezas concretas (modelo, permisos, MCP, interfaz, creador de PR) y las conecta. Si cada módulo construyera sus propias dependencias, no se podría sustituir nada en las pruebas.

## B3. ¿Cómo funciona el bucle del agente?

`runTurn` (`agent/loop.ts`) llama al modelo con las herramientas, procesa lo que llega (texto, llamadas a herramientas, resultados) y repite. Detalles: tope de 40 pasos por turno (`maxSteps`); si se alcanza con el modelo aún pidiendo herramientas se avisa («escribe "continúa»); si el modelo no emite nada durante 90 s se aborta; devuelve los tokens reales que informa el proveedor; y si falla a mitad de turno conserva los pasos ya hechos para no repetirlos. También avisa cuando el modelo cierra el turno sin terminar o anuncia una acción sin ejecutarla.

## B4. ¿Cómo se manejan los errores del proveedor y los reintentos?

`agent/retry.ts`. Un error temporal (saturación 503, límite de uso 429, red) se reintenta hasta 3 veces con espera exponencial (2 s, 4 s, 8 s) o con la espera que sugiera el proveedor, si es razonable. Si el proveedor pide esperar más de 2 minutos (cuota diaria agotada), se falla rápido con un mensaje claro («cuota agotada, usa otra clave o modelo»). No se reintentan los errores de clave (por ejemplo 401) ni los que no son temporales. Si hay `fallbackModel` configurado, al agotarse el principal el turno continúa con ese modelo desde donde se quedó, una sola vez y avisando.

## B5. ¿Cómo funcionan las sesiones y qué se guarda?

Cada conversación es un archivo JSON (`.git/agente/sessions/<id>.json`; dentro de `.git` para no ensuciar el árbol de trabajo). Contiene los mensajes, el título, las fechas y el modelo. Se escribe de forma atómica (a un temporal y luego se renombra), con permisos 600, y con los secretos ocultos. Se guarda tras cada turno; si no se puede guardar, se avisa una vez y el chat sigue. Se pueden listar, retomar, buscar, renombrar, exportar a Markdown y borrar.

## B6. ¿Cómo se reanuda una sesión?

`agente -c` retoma la más reciente; `agente --resume` (o `/resume`) muestra la lista para elegir. Se recarga el historial y el modelo sigue la misma conversación. Si un turno fue interrumpido con Esc o falló, la sesión conserva las herramientas ya ejecutadas y sus resultados con una nota, para que el modelo sepa qué quedó hecho. El registro de un flujo (`/work`, `/ship`) también queda en la sesión, así el modelo recuerda qué rama, plan y commit se hicieron.

## B7. ¿Cómo se conecta MCP con el modelo?

El cliente (`mcp/client.ts`, sobre `@ai-sdk/mcp`) arranca los servidores configurados (locales por stdio o remotos por HTTP), descubre sus herramientas y las ofrece al modelo con el nombre `mcp__servidor__herramienta`. Se controla qué se expone (`includeTools`/`excludeTools`) para ahorrar tokens, y qué se ejecuta sin preguntar (`autoApprove`). Los valores de la configuración admiten `${VARIABLE}` del entorno. Los servidores locales corren con un entorno limpio (sin las claves de los modelos). `/connect jira|trello|github` guía la conexión con presets y guarda el token en `~/.agente/credentials`.

## B8. ¿Qué pasa si un servidor MCP falla?

La sesión arranca igual: el estado de cada servidor se muestra (`/mcp`) como correcto o con su error. El error de los servidores locales va a un registro en `~/.agente/logs/` y el mensaje de conexión lo menciona. Un servidor caído no impide usar el resto ni el chat. Si no hay ningún tracker conectado, el arnés avisa y sugiere `/connect`.

## B9. ¿Cómo se evita que el shell ejecute algo peligroso?

Capas, de mayor a menor prioridad (`permissions.ts`):

1. **Lista de denegados** (siempre, incluso con `--yes`): `sudo`, `curl | sh`, `mkfs`, `dd` a dispositivos, apagado/reinicio como comando, fork bomb, `git push --force` y variantes, `rm -r` sobre `/`, `~`, `.` o el proyecto.
2. **Lista blanca** (`allowedCommands`, por prefijo): `git status`, `git diff`, `git log`, `ls`, `cat`, `npm test`, `npm run lint`, `npm run typecheck`… Solo se permite si no hay encadenamientos (`; & | \` $ ( ) < >`), ni opciones que escriben o ejecutan, ni archivos con secretos (`.env`, claves, `.ssh`…).
3. **Todo lo demás pregunta**, con diálogo.

**Limitación honesta:** es una barrera por análisis, no un entorno aislado; no sustituye un sandbox.

## B10. ¿Cómo funciona la aprobación humana?

Cuando la política dice "preguntar" aparece un diálogo con la herramienta, el objetivo y una vista previa del cambio (diff). Opciones: 1) sí, 2) sí y no volver a preguntar en esta sesión, 3) no, y decir qué hacer distinto. Lo que la persona escribe vuelve al modelo como «DENEGADO por el usuario. El usuario indica: …». Los modos de permisos (`ask`, `edits`, `plan`) se cambian con Shift+Tab. Los archivos de configuración nunca ofrecen "no volver a preguntar".

## B11. ¿Para qué sirven los límites?

Evitan bucles infinitos y gasto descontrolado: `maxSteps` (40) por turno; tiempo sin respuesta del modelo (90 s); `maxFixAttempts` (3) para que la autocorrección tras una verificación fallida no sea infinita; en subagentes, 12 pasos y resultado de hasta 4.000 caracteres. Al llegar al límite se avisa y se puede continuar.

## B12. ¿Qué es la compactación de contexto y cuándo ocurre?

Antes de cada llamada se estima el contexto (con el dato real del proveedor si lo hay). Al pasar del 75 % de la ventana (`compactAt`) se hace en dos pasos: primero se podan los resultados antiguos de herramientas; si no basta, se resume lo antiguo con el modelo y se conserva lo reciente. El original de lo afectado se archiva (`archive/`, permisos 600, secretos ocultos). La ventana depende del modelo (Gemini 1 M, Anthropic 200 k, OpenAI 128 k, Ollama 32 k) con un tope práctico de 256 k. En pantalla: medidor `ctx ▰▰▱▱…` junto al prompt y, al compactar, el aviso «antes → después».

## B13. ¿Cómo funciona la memoria?

Tres niveles: (1) la sesión guardada; (2) **memoria del flujo**: tras `/work` o `/ship` se anota un resumen (issue, rama, verificación, plan, commit, push, PR) sin el cuerpo de la issue; (3) **memoria explícita del usuario**: `/remember` guarda una nota en la sección «Memoria del agente» de `AGENTE.md` (proyecto) o en `~/.agente/memory.md` (`-u`, personal). Solo la persona escribe en la memoria, nunca el modelo; se rechazan notas vacías, muy largas o con aspecto de secreto. `/memory` las lista y `/memory forget N` las borra.

## B14. ¿Cómo se verifica el trabajo?

Tras implementar, `workflow/verify.ts` ejecuta los comandos del proyecto: los de `workflow.verify` o, si no están, los detecta (lint, typecheck y test de `package.json`; `cargo test`, `go test`). Si algo falla, la salida se entrega al modelo y corrige; se repite hasta `maxFixAttempts`. Solo cuando todo pasa se pasa a la revisión. La verificación usa comandos reales, no la palabra del modelo.

## B15. ¿Qué ocurre después de la revisión?

La persona ve el resumen y el diff (coloreado) y acepta, descarta o pide cambios. Luego, la entrega en cuatro pasos: **commit** (mensaje generado por el modelo del rol `light` y revisable), **push** (con reintentos ante fallos de red; nunca a ramas protegidas), **pull request** (con `gh` si está autenticado; si no, por una herramienta MCP; si no, un enlace manual con la descripción ya escrita) y **tracker** (comentario en la issue y, si se configura, cambio de estado). Cada paso se puede aprobar por separado.

## B16. ¿Cómo se garantiza que los commits no lleven coautores?

El mensaje que genera el modelo se sanitiza: se eliminan líneas `Co-Authored-By` y atribuciones tipo «Generated with…». Además, tras el commit se comprueba el resultado real (por si un hook de git añade un coautor) y se corrige. El autor es siempre el del git del usuario. La prueba de humo lo verifica en cada ejecución.

## B17. ¿Cómo funcionan los subagentes?

El modelo principal puede llamar a la herramienta `delegate` con una tarea de investigación. Se ejecuta el mismo bucle `runTurn` pero con una conversación nueva (solo la tarea), un prompt propio, solo tres herramientas de lectura (`readFile`, `listFiles`, `grep`), el modelo del rol `light` (o `subagents.model`) y hasta 12 pasos. Al terminar solo vuelve un resumen, marcado como dato y recortado. Corren de uno en uno. No pueden escribir, ejecutar comandos ni delegar a su vez. En pantalla salen anidados con `│`. **Ventaja:** el subagente puede leer muchos archivos sin llenar el contexto principal.

## B18. ¿Cómo se protegen los secretos?

- Las claves van en variables de entorno o en `~/.agente/credentials` (permisos 600), nunca en archivos versionados; `${VAR}` en la configuración.
- Antes de escribir una sesión o un archivo de compactación se ocultan claves reconocibles (Google, Atlassian, OpenAI/Anthropic, GitHub, Slack, AWS, JWT, `Bearer`, líneas de `.env`, pares JSON, claves privadas).
- Los servidores MCP locales no heredan las claves de los modelos.
- El pegado de claves en `/login` y `/connect` no se muestra en pantalla.
- Los archivos con aspecto de secreto (`.env`, `.ssh`…) hacen que un comando pregunte.

Es una heurística conservadora, no una garantía: puede dejar pasar formatos raros.

## B19. ¿Cómo se configura el proyecto?

`agente.config.json` en el proyecto y `~/.agente/config.json` global; se mezclan en profundidad (el del proyecto manda). Se valida con un esquema (zod). Define el modelo y los roles, proveedores con URL propia, servidores MCP, el flujo (prefijo de ramas, aislamiento por rama o worktree, comandos de verificación, remoto, ramas protegidas, método de PR, sincronización del tracker), los subagentes y los límites. `agente init` crea la configuración y los prompts editables en `.agente/prompts/`.

## B20. ¿Cómo funciona el multi-modelo?

Un modelo se indica como `proveedor/modelo` (por ejemplo `google/gemini-3.5-flash-lite`). Hay proveedores integrados (Google, Anthropic, OpenAI, Ollama) y cualquier endpoint compatible con OpenAI definido en `providers` con `baseURL` (OpenRouter, Ollama en la nube…). Cada etapa usa un rol: `plan`, `implement`, `light`. Se cambia en la sesión con `/model` y `/role`, o al arrancar con `-m`. Cambiar de proveedor es cambiar la configuración y la variable de entorno de la clave.

## B21. ¿Cómo se prueba el proyecto y qué exige el CI?

Unas 370 pruebas con vitest (un archivo por área: permisos, bucle, compactación, sesiones, memoria, MCP, flujo, entrega, interfaz, subagentes), todas con modelo y tracker simulados y sin red; más la prueba de humo de extremo a extremo (9 comprobaciones); más `npm run demo`, que muestra un subagente sin red ni claves. El CI corre lint, typecheck, pruebas, build y smoke en Ubuntu y Windows. No se mide la cobertura como porcentaje: se prueba el comportamiento.

---

# Parte C — Preguntas trampa

## C1. "¿Por qué JSON y no SQLite (o Postgres) para las sesiones?"

Una sesión se lee y se escribe entera, el volumen es pequeño (decenas o cientos por proyecto) y no hay consultas relacionales. JSON es legible, portable, sin dependencias nativas, y vive dentro de `.git` sin ensuciar el proyecto. La escritura es atómica. Pasaría a SQLite si hubiera miles de sesiones, búsqueda frecuente o varios procesos escribiendo a la vez; `node:sqlite` viene incluido en Node 22. **Debilidades reconocidas:** cada turno reescribe el archivo, la búsqueda recorre todos los archivos y dos terminales sobre la misma sesión pueden pisarse.

## C2. "¿Por qué no dejar que el modelo decida qué es peligroso?"

Porque el modelo es probabilístico y manipulable (prompt injection). La seguridad debe ser DETERMINISTA y estar fuera del modelo: política en código y aprobación humana.

## C3. "¿Tu lista de comandos garantiza la seguridad?"

No. Es una barrera por análisis, con limitaciones (no cubre todo lo posible). Por eso hay capas (rutas, lista de denegados, lista blanca, confirmación, secretos) y falla cerrada; y está declarado que no hay un entorno aislado (sandbox), que sería la siguiente mejora. Reconocer los límites es parte de un buen diseño.

## C4. "¿Por qué el humano aprueba el plan y el diff si ya hay verificación automática?"

Porque la verificación solo comprueba lo que los comandos del proyecto saben comprobar (lint, tipos, pruebas). No sabe si el cambio es lo que se pidió, ni si el modelo tocó algo que no debía. El humano decide en los puntos críticos y el modelo nunca se "autodeclara" exitoso: el arnés ejecuta los comandos y muestra el resultado real.

## C5. "¿Qué pasa si una issue contiene instrucciones maliciosas?"

Se trata como dato, no como instrucción: el prompt lo declara, el registro del flujo no guarda el cuerpo de la issue y las acciones sensibles (escribir, ejecutar, push, PR) pasan por permisos y aprobación humana, no por el criterio del modelo. No es una garantía total; es defensa en profundidad.

## C6. "¿Por qué los subagentes son de solo lectura?"

Para evitar escrituras concurrentes y mantener el control humano: una investigación no necesita escribir, y así no requiere confirmaciones ni puede romper nada. Además no pueden delegar a su vez, así que no hay subagentes anidados, y corren de uno en uno para no agotar la cuota de los planes gratuitos.

## C7. "¿Qué mejorarías o qué dejaste pendiente?"

Respuesta honesta (está documentada): un entorno aislado para el shell (sandbox); OAuth de Atlassian en lugar del token de API; migrar las sesiones a SQLite si crece el volumen; verificar de punta a punta el paquete MCP oficial de Jira y la creación real de PR; forzar y observar una compactación con un contexto lleno de verdad; pruebas interactivas automatizadas en Windows.

## C8. "¿Qué cambiarías si mañana hay que pasar de Gemini a otro proveedor?"

Solo la configuración (`model` o `roles`: `proveedor/modelo`) y la variable de entorno de la clave. Si el proveedor tiene una API compatible con OpenAI, basta definirlo en `providers` con su `baseURL`. El resto del arnés no cambia, porque habla con una interfaz común de modelo.

## C9. "¿Por qué no usaste un framework de agentes como LangChain?"

Se reutilizaron librerías para lo genérico (el SDK de IA para proveedores y streaming, OpenHarness para las herramientas de archivos, el SDK de MCP) y se escribió a mano lo que es la tesis del proyecto: el flujo por issue, la seguridad, la memoria y la interfaz. Un framework grande ocultaría justamente las decisiones que se quieren defender y añadiría dependencias.

## C10. "¿Por qué confiar en las pruebas si no mides la cobertura?"

La cobertura mide líneas ejecutadas, no que se verifique lo correcto. Aquí se prueba el comportamiento con modelo y tracker simulados, con un repositorio git real temporal y de extremo a extremo (smoke), y el CI corre en dos sistemas operativos. Es una red de seguridad, no una garantía; medir cobertura sería una mejora sencilla.

---

# Consejos para la defensa

1. Responde siempre con la estructura: QUÉ es → POR QUÉ se hizo así → DÓNDE está en el código → LIMITACIÓN conocida.
2. Cuando no sepas algo, di «eso está documentado como pendiente» antes que inventar. Admitir límites suma puntos.
3. Ten a mano un recorrido de punta a punta: petición → contexto → bucle → modelo → herramienta → política → aprobación → resultado → sesión → verificación → revisión → commit → PR.
4. Practica dibujar el diagrama: `cli.ts` (compone) → `chat`/`workflow` → `agent` → `tools` → sistema, con la capa de seguridad (`guarded` + `permissions`) en medio.
5. Para la demo: usa Gemini, no uses `--yes` (que se vean el diálogo y el diff), y ten `npm run demo` como plan B si falla la red.
6. Di solo lo comprobado: el flujo con Gemini real, los subagentes, la memoria, el CI en dos sistemas operativos y que no hay coautores. Lo demás, preséntalo como trabajo futuro.
