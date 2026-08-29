# T0 — Recon de agentsgate + Schema del Effect Ledger v1

**Estado:** completado (análisis de código fuente real, clone del 29-08-2026)
**Salidas:** posicionamiento afilado (§2), schema v1 propuesto para congelar (§3), impactos sobre el SPEC (§4).

---

## 1. Qué es agentsgate realmente

No es un repo de fin de semana: **v0.2.0 en npm, ~32.000 LOC, 7.431 tests, CI, dashboard web, SECURITY.md con threat model serio.** Cero estrellas por falta de distribución, no de calidad. Tomarlo como competidor real y como fuente de lecciones de ingeniería.

**Su arquitectura (13 módulos):** proxy MCP (stdio + streamable HTTP) → risk engine (reglas → score 0-1 → allow/hold/block según "protection level" + policy rules de excepción) → checkpoint engine → **shadow git** para snapshots de archivos → adapters de rollback (SQLite/PG/MySQL = copia de tabla previa al write; Slack = borrar mensaje) → approval queue + dashboard → módulo "intelligence" (historial de outcomes por agente+tool — embrión de permisos progresivos).

**Su paradigma: snapshot-and-restore.** Fotografiar estado antes de tocar, restaurar la foto si algo sale mal. Para lo no-fotografiable (envíos salientes, shell), la respuesta explícita del README: *"Cannot be recalled. Stopped beforehand, or not at all."*

**Su identidad declarada:** herramienta local de un solo operador — "te protege de tu propio agente en tu propia máquina". Foco en coding agents, archivos y DBs locales.

## 2. La grieta (verificada en código, no intuida)

| Dimensión | agentsgate | Sagaz |
|---|---|---|
| Modelo de undo | Restaurar copias del pasado (shadow git, table copy) | Ejecutar operaciones inversas hacia adelante (compensaciones) |
| Clasificación | Por **riesgo** (score 0-1 → gate) | Por **reversibilidad** (R/C/I → estrategia de undo) — eje ortogonal |
| Compensación semántica (tipo C) | **Inexistente** — 0 menciones de "compensat" en 32k LOC; declarada imposible en README | El corazón del producto: LLM propone, humano aprueba, ledger registra |
| "Dry-run" | Modo monitor de sus reglas (loguea qué hubiera bloqueado) | Preview de efectos: "qué tocaría este agente en el mundo" |
| Audit log | Blobs JSON en SQLite; "tamper-evident" del marketing **no está en el código** | Ledger append-only con hash encadenado, real |
| Efectos externos (SaaS, APIs) | Frontera del producto (solo bloquear) | Territorio principal |
| Excepción parcial | Adapter Slack borra mensajes enviados — una compensación hardcodeada, sin generalizar ni conceptualizar | Compensación como primitivo general con taxonomía |

**Síntesis de posicionamiento:**
> agentsgate responde *"¿cómo vuelvo mi máquina al estado anterior?"*
> Sagaz responde *"¿cómo deshago lo que mi agente le hizo al mundo?"*

**Frase de posicionamiento (decisión post-review de Jero — producto integral):**
> *"One undo for everything your agent touched — including what no snapshot can reach."*
> El rewind del harness y agentsgate cubren archivos con snapshots; Sagaz cubre archivos + DB + mundo con un solo primitivo (ledger + compensación con capture hook), y su territorio único son los efectos que ningún snapshot alcanza.

**Riesgos que este recon actualiza:**
- agentsgate está activo y es competente; si pivotean a compensaciones nos corren de atrás con 7k tests de ventaja. Mitigación sin cambios: la carrera es distribución + concepto, shipping semanal.
- Su módulo intelligence ya acumula track record por agente → si algún día hacemos permisos progresivos, ellos tienen medio camino. No es scope nuestro ahora; anotado.
- Lección de ingeniería a copiar sin culpa: binding a loopback por default, cero auth como decisión documentada, SECURITY.md desde temprano. Para una herramienta de seguridad, la postura de seguridad ES marketing.

## 3. Effect Ledger — Schema v1 (a congelar)

Decisiones de diseño antes del SQL:

1. **Las compensaciones son efectos.** Un rollback ejecuta tool calls; esas calls entran al mismo ledger como efectos nuevos, linkeados al efecto que compensan (`compensates_id`). El ledger nunca se reescribe — el undo es historia nueva, no borrado de historia. (Coherente con el modelo mental git: revert es un commit más.)
2. **Hash encadenado por sesión.** `hash = sha256(prev_hash + campos canónicos)`. Barato, verificable con un comando (`sagaz verify`), y hace real lo que agentsgate solo declara.
3. **Registrar todo, clasificar después.** También las lecturas (`class = 'read'`): costo marginal bajo, y el ledger completo es el "expediente vivo" del Acto 2 (compliance). Responde la pregunta abierta #2 del SPEC: **sí, todo.**
4. **Proveniencia de la clasificación.** `class_source` dice quién decidió (annotation MCP / regla / LLM / usuario). Crítico para debuggear el clasificador y para la confianza del usuario.
5. **El descriptor de undo es un plan, con ciclo de vida.** `undo_json` describe cómo se deshace; `undo_status` rastrea su estado: `none → planned → proposed → approved → executed | failed | impossible`. Tipo R salta directo a `planned`; tipo C pasa por `proposed → approved` (humano); tipo I nace `impossible`.
6. **Capture hook: el pre-estado se captura en el momento o no existe más.** Muchas inversas tipo R requieren el estado previo (la inversa de `write_file` necesita el contenido anterior; la de `delete_note`, la nota; la de `update_row`, la fila). Un compensation pack puede declarar una lectura de captura que el proxy ejecuta ANTES de reenviar la call mutante; el resultado se guarda en `pre_state_json`. Consecuencia estratégica: **el filesystem no es un tier especial — es un pack más** (capturar contenido previo → restaurarlo), sin shadow git ni repo paralelo: el pre-estado vive en el ledger. El producto es integral (un solo `sagaz rollback` deshace archivos + DB + mundo, siempre que haya pasado por MCP); el *marketing* sigue liderado por los efectos externos, donde somos únicos.

```sql
-- Sesiones: una corrida de agente a través del proxy
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,      -- ulid
  started_at  TEXT NOT NULL,         -- ISO 8601 UTC
  client_info TEXT,                  -- del initialize MCP (nombre/versión del cliente)
  config_hash TEXT,                  -- hash del sagaz.config vigente (reproducibilidad)
  genesis_hash TEXT NOT NULL         -- ancla de la cadena de hashes de la sesión
);

-- Checkpoints: marcas manuales o automáticas dentro de una sesión
CREATE TABLE checkpoints (
  id          TEXT PRIMARY KEY,      -- ulid
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  ts          TEXT NOT NULL,
  label       TEXT,                  -- "antes de la migración"
  auto        INTEGER NOT NULL DEFAULT 0
);

-- El ledger: append-only, nunca UPDATE salvo campos de ciclo de vida de undo
CREATE TABLE effects (
  id             TEXT PRIMARY KEY,   -- ulid (ordenable por tiempo)
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  checkpoint_id  TEXT REFERENCES checkpoints(id),  -- último checkpoint al momento
  seq            INTEGER NOT NULL,   -- orden estricto dentro de la sesión
  ts_start       TEXT NOT NULL,
  ts_end         TEXT,
  server         TEXT NOT NULL,      -- server MCP downstream
  tool           TEXT NOT NULL,
  args_json      TEXT NOT NULL,      -- argumentos verbatim
  pre_state_json TEXT,               -- pre-estado capturado por el capture hook del pack
  result_json    TEXT,               -- respuesta verbatim (truncable por config)
  status         TEXT NOT NULL CHECK (status IN
                   ('pending','ok','error','blocked','dry')),
  class          TEXT CHECK (class IN ('read','R','C','I','unknown')),
  class_source   TEXT CHECK (class_source IN
                   ('annotation','rule','llm','user')),
  class_reason   TEXT,               -- humano-legible: "matched rule delete_*"
  undo_json      TEXT,               -- plan de compensación (descriptor declarativo)
  undo_status    TEXT NOT NULL DEFAULT 'none' CHECK (undo_status IN
                   ('none','planned','proposed','approved',
                    'executed','failed','impossible')),
  compensates_id TEXT REFERENCES effects(id),  -- si este efecto ES una compensación
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,      -- sha256(prev_hash || canonical(campos inmutables))
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_effects_session ON effects (session_id, seq);
CREATE INDEX idx_effects_tool    ON effects (tool);
CREATE INDEX idx_effects_class   ON effects (class);
CREATE INDEX idx_effects_undo    ON effects (undo_status)
  WHERE undo_status IN ('proposed','approved');
```

**Notas de implementación:**
- El hash cubre solo campos inmutables (id, seq, ts_start, server, tool, args, result, status, class al momento del cierre). Los campos de ciclo de vida de undo mutan y quedan fuera de la cadena — la compensación ejecutada tiene su PROPIA fila hasheada, así que la integridad histórica no depende de ellos.
- `result_json` truncable por config (default p.ej. 64KB) — los resultados pueden contener archivos enteros. El hash se computa sobre lo almacenado.
- Privacidad: el ledger contiene args con potenciales secretos. Heredar la decisión de agentsgate: local-first, loopback, y documentarlo sin eufemismos desde el día uno.
- `undo_json` v1 (formato mínimo, tipo R): `{"kind":"tool_call","server":"...","tool":"...","args":{...}}`. Tipo C agrega `{"kind":"llm_proposed","rationale":"...","proposed_call":{...}}`. Los packs pueden declarar además un capture hook: `{"capture":{"tool":"read_file","args_from":{"path":"$.args.path"}},"inverse":{...}}` — la lectura se ejecuta antes de reenviar la call y alimenta `pre_state_json`. Formato extensible = base de los compensation packs (pregunta abierta #4: **JSON declarativo primero, TS plugins después**).
- El hash cubre también `pre_state_json` (es inmutable, se escribe una sola vez al cerrar el efecto).

## 4. Impactos sobre el SPEC (diffs a aplicar)

1. **Producto integral, marketing enfocado.** Un solo `sagaz rollback` deshace todo lo que pasó por el proxy — archivos, DB y mundo exterior. El filesystem se cubre con un pack (capture hook + restore), NO con shadow git: no construimos snapshots, no competimos en ese tier con features, pero la experiencia de rollback es completa. El pitch sigue liderado por efectos externos: *"un solo undo para todo lo que tu agente tocó — incluido lo que ningún snapshot alcanza"*. Límite documentado: efectos vía bash no pasan por el proxy y quedan fuera. → §2, §3 y §5 del SPEC.
2. **Renombrar la operación 2 a "preview"** (o dejar dry-run pero definirlo como *effect preview*), para no chocar con el dry-run de agentsgate que significa otra cosa. → §3.
3. **Toybox (T2) reorientado a efectos externos:** tools tipo `send_fake_email`, `create_crm_contact`, `post_fake_tweet` sobre un sandbox con estado inspeccionable — no archivos. La demo insignia es compensar un envío, no restaurar un archivo. → §6.
4. **Preguntas abiertas #2 y #4: respondidas** (registrar todo; packs JSON-first). Quedan abiertas #1 (nombre — verificar npm/dominio), #3 (checkpoint automático: propuesta = auto por sesión + manual por CLI) y #5 (resuelta en espíritu por la frase de convivencia).
5. **Nuevo riesgo en tabla:** "agentsgate pivotea a compensaciones" — mitigación: velocidad + concepto nombrado + post de lanzamiento que instale el vocabulario antes.

## 5. Checklist de cierre de T0

- [x] Código de agentsgate leído (proxy, store, checkpoint, shadow, rollback, adapters, intelligence)
- [x] Diferenciación documentada y verificable (tabla §2)
- [x] Schema v1 diseñado con decisiones justificadas
- [ ] **Validación de Jero** → congelar schema
- [ ] Nombre: verificar disponibilidad npm + dominio antes de T1