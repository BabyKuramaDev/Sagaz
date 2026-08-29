# SPEC — Sagaz (nombre provisorio)

> **Undo para agentes de IA.** Un proxy MCP open source que registra cada efecto que tus agentes producen en el mundo, clasifica su reversibilidad antes de ejecutarlo, y te da preview, checkpoint, rollback y compensaciones. Git para las acciones de tus agentes.

**Estado:** Spec v0.2 — Fase 0 completa (T0–T6), Fase 1 en curso (T7: clasificador). Enmiendas de implementación en `docs/T0-recon-y-schema.md` §4b.
**Licencia:** MIT
**Objetivo primario:** peso en la industria (revuelo, adopción, vocabulario propio), no revenue.
**Acto 2 (futuro, fuera de scope):** el ledger como base de "Compliance Officer para sistemas de IA".

---

## 1. Problema

Los agentes ejecutan acciones sobre el mundo real (DBs, APIs, emails, archivos) a velocidad de máquina y sin mecanismo de deshacer. Los incidentes ya son mainstream (PocketOS: base de producción + backups borrados en 9 segundos, top de HN). El software clásico tenía transacciones y rollback; los agentes rompieron eso porque sus efectos cruzan sistemas que no comparten coordinador transaccional.

**Insight central:** no existe el undo universal. Cada efecto cae en una de tres categorías:

| Tipo | Descripción | Ejemplo | Estrategia |
|---|---|---|---|
| **R** (Reversible) | Inversa determinística derivable | `create_row` → `delete_row`, `git commit` → `revert` | Compensación automática, sin LLM |
| **C** (Compensable) | No hay inversa, sí corrección semántica | Email enviado → email de corrección; ticket creado → cerrar con comentario | Compensación generada por LLM + aprobación humana |
| **I** (Irreversible) | No hay vuelta atrás | Transferencia ejecutada, dato entregado a un tercero | Gate: confirmación humana previa o bloqueo por política |

**El valor no es solo el rollback post-desastre: es la ejecución consciente de reversibilidad.** Saber ANTES de ejecutar en qué categoría cae cada acción cambia el modelo mental del usuario de "espero que no rompa nada" a "puedo soltarle la correa porque tengo punto de retorno".

## 2. Posicionamiento (decisiones tomadas en el reality check)

**Dónde NO jugamos:**
- ❌ Snapshots de filesystem como feature — commoditizado (Claude Code rewind, Gemini CLI /restore, Hermes, shadow git de agentsgate). No construimos shadow git ni repo paralelo. El filesystem sí queda cubierto por el rollback, pero como **un compensation pack más** (capture hook del contenido previo → restore), no como tier especial. Si el pitch suena a "backup de archivos", perdimos.
- ❌ Governance/auth enterprise — territorio de IBM ContextForge, Microsoft MCP Gateway, Kong, Gravitee. No competimos ahí.

**Dónde SÍ:**
- ✅ Efectos **externos** al sandbox: DBs, APIs, SaaS de terceros. El tier que nadie resuelve bien.
- ✅ El **effect ledger** con metadata de reversibilidad como primitivo central.
- ✅ Compensaciones semánticas (tipo C) asistidas por LLM con human-in-the-loop — la parte genuinamente nueva.

**Competencia directa conocida:** `agentsgate/agentsgate` (v0.2.0 en npm, TS, MIT, ~32k LOC, 7k+ tests — proxy + risk scoring + checkpoints con shadow git + adapters de rollback por snapshot + HITL + dashboard). Competente, sin distribución ni concepto nombrado. Recon completo en `docs/T0-recon-y-schema.md`. Diferencia verificada en código: su paradigma es **snapshot-and-restore** (restaurar copias del pasado; lo no fotografiable "se frena antes o no se recupera"); el nuestro es **compensación** (ejecutar inversas hacia adelante), clasificado por reversibilidad y no por riesgo, con compensación semántica tipo C — inexistente en agentsgate — como corazón del producto.

**Producto integral, marketing enfocado:** un solo `sagaz rollback` deshace todo lo que pasó por el proxy — archivos, DB y mundo exterior — con un único primitivo (ledger + compensación con capture hook). El *pitch* lidera con los efectos externos, donde somos únicos: *"One undo for everything your agent touched — including what no snapshot can reach."* Límite documentado con honestidad: efectos vía bash o código deployado no pasan por el proxy y quedan fuera.

**Vocabulario propio (la bandera):** *effect ledger*, *anti-prompt* (la secuencia de compensaciones que emerge del ledger en orden inverso), taxonomía *R/C/I*. El que nombra el problema es dueño de la conversación.

**Pitch de una línea:** *"Your agents can act. Can they undo?"*

## 3. Producto — las 5 operaciones

1. **Ledger** (pasivo, siempre activo): cada `tools/call` queda registrada — también las lecturas (`class = 'read'`) — con tool, args, resultado, timestamp, clasificación R/C/I con su proveniencia, y el plan de undo con su ciclo de vida.
2. **Preview** (*effect preview*): "mostrame qué tocaría este agente en el mundo sin tocarlo". Intercepta cada call, la clasifica y reporta el efecto sin reenviar. No confundir con el "dry-run" de agentsgate, que es un modo monitor de sus reglas de riesgo. *Hipótesis: es la puerta de entrada de adopción (valor diario en desarrollo, sin necesidad de incidente).*
3. **Checkpoint**: marcar un momento; agrupa todo lo posterior como "revertible hasta acá".
4. **Rollback**: ejecutar el anti-prompt — compensaciones en orden inverso. Tipo R automático (usando el pre-estado capturado por el capture hook cuando la inversa lo necesita); tipo C propone y espera aprobación; tipo I reporta "esto no se puede deshacer" con honestidad brutal. Cubre archivos + DB + mundo con el mismo mecanismo; cada compensación ejecutada entra al ledger como efecto nuevo (nunca se reescribe la historia).
5. **Kill switch**: cortar el paso de tool calls ya, sin matar el proceso del agente.

## 4. Arquitectura

```
┌─────────────┐     stdio / HTTP      ┌──────────────────────────┐      stdio / HTTP     ┌──────────────┐
│ MCP Client   │ ──────────────────▶  │        SAGAZ (proxy)      │ ──────────────────▶  │ MCP Servers   │
│ (Claude Code,│ ◀──────────────────  │                          │ ◀──────────────────  │ (Postgres,    │
│ Cursor, SDK) │                      │  Interceptor              │                      │ Gmail, Jira…) │
└─────────────┘                      │  Clasificador R/C/I       │                      └──────────────┘
                                      │  Effect Ledger (SQLite)   │
                                      │  Compensation Engine      │
                                      │  Policy / Gates           │
                                      └────────────┬─────────────┘
                                                   │
                                              CLI + (futuro) dashboard web
```

**Componentes:**

- **Interceptor**: server MCP hacia el cliente, cliente MCP hacia los servers downstream. Pass-through transparente: el agente no sabe que existe (cero tokens de overhead, no aparece en el schema de tools).
- **Effect Ledger**: SQLite local (better-sqlite3). Tabla de efectos append-only con hash encadenado (tamper-evident barato). Es EL activo del proyecto — todo lo demás se construye arriba.
- **Clasificador R/C/I**, en cascada de precedencia (primer match gana; implementado en T7, niveles 1–3):
  1. **Reglas del usuario** en `sagaz.config.json` (`rules`: por tool exacto o glob, server opcional). SIEMPRE ganan: las anotaciones son declaraciones del server, no verdad revelada.
  2. **Anotaciones MCP**: `readOnlyHint: true` → `read`. `destructiveHint` no es una clase (destructivo ≠ irreversible): actúa como tope, el resultado nunca puede ser R.
  3. **Heurísticas built-in por nombre**, conservadoras (tabla en `packages/core/README.md`): `create_*` → R; `send_*|post_*|publish_*|notify_*` → C; `transfer_*|pay_*|charge_*|execute_*|drop_*` → I; `update_*|delete_*` → `unknown`.
  4. `unknown` si nada matchea.
  5. **LLM** (futuro, opcional, para lo gris): clasificación con un modelo barato, cacheada por tool. Off por default (local-first, cero llamadas externas sin opt-in).

  **Principio rector (decisión T6/T7):** `R` significa "sabemos ejecutar la inversa" — y un nombre solo nunca prueba eso. `create_*` → R se sostiene (la inversa se deriva del resultado, sin pre-estado); `update_*`/`delete_*` por nombre → `unknown` hasta que exista capture hook / pack o regla del usuario. Ante la duda, `unknown`: un falso "reversible" es el peor error posible del sistema; un `unknown` es solo un aviso. La clasificación no es retroactiva (el hash sella la fila) y en Fase 1 solo anota — los gates son un ticket aparte.
- **Compensation Engine**:
  - Tipo R: mapa declarativo `tool → inversa` (provisto por packs por dominio + config del usuario).
  - Tipo C: generación por LLM con contexto del efecto + resultado, SIEMPRE con aprobación humana antes de ejecutar. Una compensación mal generada es un segundo incidente.
- **Policy/Gates**: reglas simples en config — `tipo I → bloquear | pedir confirmación`, `tool X → siempre preguntar`, umbrales. (Mínimo viable de "engarce" sin competir con los gateways.)
- **CLI**: hoy `sagaz serve`, `sagaz ledger`, `sagaz status`, `sagaz verify`; después `sagaz checkpoint`, `sagaz rollback [--dry]`. Dashboard web queda para Fase 4.

**Decisiones técnicas:**

| Decisión | Elección | Por qué |
|---|---|---|
| Lenguaje | TypeScript, Node ≥ 20 | SDK MCP de referencia, distribución npx, tu lengua materna, velocidad = foso |
| SDK | `@modelcontextprotocol/sdk` oficial | Compatibilidad con la spec que evoluciona rápido |
| Storage | SQLite (better-sqlite3) | Local-first, cero infra, queryable, portable |
| Transporte v1 | stdio primero, streamable HTTP después | stdio cubre Claude Code/Cursor/Desktop = la tribu |
| Distribución | npm, ejecutable vía `npx` | Adopción en 30 segundos editando el mcp config |
| Filosofía | Local-first, sin telemetría, sin cuenta | Confianza — es una herramienta de seguridad, no puede fonear a casa |
| Testing | Vitest + un MCP server de juguete propio para e2e | El server de juguete además sirve para demos/reels |

## 5. Fases

**Fase 0 — El esqueleto que respira (~2-3 semanas de foco)**
Proxy pass-through funcionando con Claude Code + ledger persistente + CLI para verlo. Sin clasificación, sin rollback. Éxito = "corrí mi agente a través de Sagaz y puedo ver cada efecto que produjo".

**Fase 1 — Ojos (clasificación + preview)**
Clasificador R/C/I (niveles 1 y 2, sin LLM) + preview + gates básicos por política. Éxito = "Sagaz me frenó un `DROP TABLE` y me mostró qué iba a tocar antes de tocarlo". **Este es el momento del primer post/lanzamiento público** — preview + gate ya es demo viral con el toybox.

**Fase 2 — Manos (rollback determinístico)**
Checkpoint + rollback de efectos tipo R con packs de compensación (JSON declarativo, con capture hook) para 2-3 dominios (empezar por: el toybox de efectos externos para demo, Postgres, y UN SaaS con API amable — GitHub issues o similar; el filesystem entra como un pack más, sin shadow git). Éxito = el reel de "el agente rompió todo → `sagaz rollback` → todo vuelve" — la demo insignia es compensar un envío, no restaurar un archivo.

**Fase 3 — Cerebro (compensación semántica)**
Tipo C: LLM genera la compensación propuesta, humano aprueba, se ejecuta, queda en el ledger. El anti-prompt completo. La parte más novedosa y más citable (acá va el blog post técnico serio).

**Fase 4 — Cara (dashboard + ecosistema)**
Dashboard web local, packs de compensación como plugins de la comunidad, streamable HTTP, integración con más harnesses.

**Regla anti-scope-creep:** nada de risk scoring sofisticado, nada de multi-tenant, nada enterprise hasta que la Fase 3 exista. El foso es conceptual + distribución, no features.

## 6. Tickets — Fase 0

Formato habitual: tickets chicos, checkpoints explícitos, diffs-only review, merge commits.

**T0 — Recon de agentsgate + spec del ledger** *(sin código de producto)* — **hecho**
Leer el código de agentsgate a fondo. Documentado en `docs/T0-recon-y-schema.md`: qué hace, qué no hace, dónde nos diferenciamos, y el schema SQL del ledger v1 (tablas `sessions`, `checkpoints`, `effects`; `class`/`undo_json` quedan null en F0).
✓ Checkpoint: schema revisado y **congelado** antes de escribir el proxy.

**T1 — Scaffold del proyecto** — **hecho**
Repo público desde el día uno. pnpm + TS strict + Vitest + tsup. Estructura: `packages/core` (proxy + ledger), `packages/cli`. README con el pitch y un GIF placeholder. CI mínimo (build + test).
✓ Checkpoint: `npx` local levanta un "hello proxy" que no hace nada.

**T2 — MCP server de juguete (`packages/toybox`)** — **hecho**
Un server MCP propio con tools deliberadamente peligrosas que simulan **efectos externos** sobre un sandbox SQLite con estado inspeccionable — no archivos. Implementado: CRM (`list/create/update/delete_contact`), comms (`send_email`, `list_inbox`, `post_tweet`, `delete_tweet`, `list_timeline`), banco (`list_accounts`, `transfer_funds`), con anotaciones MCP deliberadamente mezcladas; `drop_everything` diferido a Fase 2. Tabla en `packages/toybox/README.md`. Base para e2e y para TODAS las demos/reels futuras; la demo insignia es compensar un envío.
✓ Checkpoint: toybox corre standalone conectado a Claude Code.

**T3 — Proxy pass-through stdio** — **hecho**
El interceptor: Sagaz se declara en el mcp config del cliente apuntando a N servers downstream (config `sagaz.config.json`). Forwarding transparente de `initialize`, `tools/list`, `tools/call`. Sin ledger todavía.
✓ Checkpoint: Claude Code usa toybox A TRAVÉS de Sagaz sin notar diferencia (e2e verde).

**T4 — Effect ledger v1** — **hecho**
Persistir cada `tools/call` + resultado en SQLite según schema de T0, con hash encadenado. Distinguir lecturas de mutaciones con la señal más burda disponible (annotations `readOnlyHint` si existe; si no, todo se registra).
✓ Checkpoint: correr una sesión de agente y ver N filas coherentes en la DB.

**T5 — CLI de lectura** — **hecho**
`sagaz ledger` (tabla legible, filtros por sesión/tool), `sagaz status`. Nada de escritura todavía.
✓ Checkpoint: el GIF del README se graba con esto. **Fin de Fase 0 = primer contenido build-in-public (sin lanzamiento formal, "estoy construyendo esto").**

**T6 — Auditoría de salida al mundo** — **hecho**
El repo se hace público al final de Fase 1. Auditoría como dev escéptico (README, legibilidad, higiene, docs) → informe → aplicar solo lo aprobado. Decisión de nombre: marca Sagaz, CLI publicada como `sagaz-mcp` (bin `sagaz`), `@sagaz/core`, `@sagaz/toybox`.

## 6b. Tickets — Fase 1

**T7 — Clasificador R/C/I, niveles 1–3 (sin LLM)** — **en curso**
Cascada reglas de usuario → anotaciones → heurísticas → `unknown` (§4). Solo anota, no frena.
✓ Checkpoint: reel del toybox con la columna `class` viva; tests de la cascada y de usuario-sobre-anotación.

**T8 — Gates por política** *(siguiente)*: `tipo I → confirmar | bloquear`, `tool X → siempre preguntar`; `status = 'blocked'` en el ledger.
**T9 — Preview**: reportar el efecto sin reenviar (`status = 'dry'`).

## 7. Distribución (es parte del producto, no un anexo)

- **Build-in-public desde el commit 1**: el repo es el contenido. Devlog corto por fase.
- **Lanzamiento formal en Fase 1** (preview + gate): Show HN + post técnico "There is no universal undo" presentando la taxonomía R/C/I y el effect ledger como conceptos. El objetivo del post es que la gente use NUESTRO vocabulario.
- **Reels**: el toybox existe para esto — demo de 30 segundos: agente rompe todo → rollback → todo vuelve. Formato multi-cut con hook.
- **Cada incidente público de agentes** (van a seguir pasando) = ventana de contenido reactivo: "así se hubiera visto en el ledger".

## 8. Riesgos y respuestas

| Riesgo | Respuesta |
|---|---|
| Labs incorporan rollback nativo (12-18m) | Ser el Switzerland: agnóstico de modelo/harness. Los labs harán lo suyo, genérico y cerrado a su ecosistema. |
| Gateways enterprise agregan la feature | Specialized vs. suite: una cosa impecable, local-first, para developers — no para CISOs. |
| El problema resulta "más chico" (preview + confirmación cubre el 80%) | Aceptable: preview + gates YA es un producto útil (Fase 1). El rollback sofisticado es upside, no requisito de supervivencia. |
| Compensaciones LLM mal generadas = segundo incidente | Tipo C SIEMPRE con humano en el loop. Nunca auto-ejecutar compensaciones generadas. |
| Rollback pisa cambios legítimos posteriores (concurrencia, clásico de sagas) | v1: detectar y avisar (comparar estado actual vs. resultado registrado), nunca pisar en silencio. |
| Efectos fuera de MCP (bash, código deployado) | Scope explícito v1: efectos que pasan por tools MCP. Documentar la limitación con honestidad. |
| agentsgate u otro repo despega antes | La carrera es de distribución, no de features. Shipping + contenido semanal. |
| agentsgate pivotea a compensaciones (activo, competente, 7k+ tests de ventaja) | Velocidad + concepto nombrado: el post de lanzamiento instala el vocabulario (effect ledger, R/C/I, anti-prompt) antes de que exista alternativa. Si copian, copian nuestros términos. |

## 9. Preguntas abiertas

1. **Nombre definitivo.** "Sagaz" (saga pattern + sagaz; pronunciable en inglés) vs. alternativas más literales (undo-proxy, ledgr, rewindr). Criterio: googleable, npm libre, dominio disponible.
2. ~~¿El ledger registra también los `tools/list` y lecturas, o solo mutaciones?~~ **Respondida (T0): se registra todo**, lecturas incluidas (`class = 'read'`); costo marginal bajo y es el expediente vivo del Acto 2. El ruido se maneja con filtros en la CLI.
3. ¿Checkpoint manual solamente (CLI) o también automático por sesión/turno? *(Propuesta T0, sin cerrar: automático por sesión + manual por CLI; el schema ya lo contempla con `checkpoints.auto`.)*
4. ~~Formato de los "compensation packs": ¿JSON declarativo, TS plugins, o ambos?~~ **Respondida (T0): JSON declarativo primero, TS plugins después.** El formato de `undo_json` (inversa + capture hook) es la base.
5. ¿Cómo convive con el rewind nativo de Claude Code sin confundir al usuario? Resuelta en espíritu por la frase de posicionamiento ("un solo undo para todo lo que tu agente tocó — incluido lo que ningún snapshot alcanza"); queda abierta la ejecución concreta del mensaje.

## 10. Definición de éxito

- **3 meses:** Fase 2 completa, lanzamiento hecho, el término "effect ledger" usado por alguien que no somos nosotros.
- **6 meses:** 1k+ stars o equivalente en tracción real (issues de terceros, PRs externos), Sagaz mencionado en discusiones de seguridad de agentes que no iniciamos.
- **12 meses:** la decisión del Acto 2 (capa compliance sobre el ledger) se toma con datos reales de adopción.