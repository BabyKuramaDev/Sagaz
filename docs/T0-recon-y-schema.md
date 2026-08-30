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
                   ('annotation','rule','llm','user','pack')),  -- 'pack' desde §4d (T11)
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

## 4b. Enmiendas post-implementación (T4)

Al implementar el schema (ticket T4) aparecieron dos puntos donde el DDL congelado y el ciclo de vida del efecto no cerraban solos. Se resolvieron con **convenciones** (sin cambiar una línea del SQL), validadas por Jero el 29-08-2026. Son parte del contrato del ledger: `sagaz verify` las asume.

1. **Sentinel `''` para `prev_hash`/`hash` mientras el efecto está `pending`.** El ciclo de vida es INSERT al recibir el `tools/call` (status `pending`, `seq` asignado) → UPDATE al cerrar (`result_json`, `ts_end`, `status`, y recién ahí `prev_hash` + `hash`). Como ambas columnas son `NOT NULL`, una fila pending guarda `''` en las dos. Se prefiere al nullable porque `NOT NULL` fuerza la escritura explícita y `''` nunca colisiona con un hash real (siempre 64 hex). Un efecto que quedó `pending` para siempre es dato honesto de un crash y no se limpia; `verify` marca como inconsistente cualquier fila `pending` con hash/`ts_end`, o cerrada sin hash.

2. **La cadena sigue el orden de cierre, no el `seq`.** Los clientes hacen tool calls concurrentes: un efecto puede cerrar antes que otro de `seq` menor, y uno colgado (crash) no debe bloquear el hasheo de los sanos. Por eso `prev_hash` es el hash del **último efecto cerrado** de la sesión (o `genesis_hash` para el primero), y el `seq` viaja dentro del payload canónico, con lo que el orden de emisión sigue siendo tamper-evident. La cola de la cadena se mantiene en memoria por sesión en el proceso que la abrió (único escritor; better-sqlite3 es síncrono); otro proceso no puede extender una sesión ajena. `verify` no ordena por `seq` ni por `ts_end`: reconstruye la cadena siguiendo los links `prev_hash → hash` desde `genesis_hash` y exige que todos los efectos cerrados sean alcanzables.

Formato canónico exacto (claves, orden, escapes, `genesis_hash`): documentado en `packages/core/src/ledger/hash.ts`. Truncamiento de `result_json`: marcador JSON `{"$truncated":{"original_bytes","kept_bytes"},"prefix"}`, hasheado como se almacena.

## 5. Checklist de cierre de T0

- [x] Código de agentsgate leído (proxy, store, checkpoint, shadow, rollback, adapters, intelligence)
- [x] Diferenciación documentada y verificable (tabla §2)
- [x] Schema v1 diseñado con decisiones justificadas
- [x] **Validación de Jero** → schema congelado (T4, 29-08-2026; ver §4b y `packages/core/src/ledger/schema.ts`)
- [x] Nombre: `sagaz` en npm está tomado (paquete ajeno, 2018–2022). Decisión (T6, 29-08-2026): la marca sigue siendo **Sagaz**; la CLI se publica como **`sagaz-mcp`** (libre, verificado) con bin `sagaz`; core y toybox como `sagaz-core` y `sagaz-toybox` (decisión post-T8: sin scope, la org `@sagaz` en npm no estaba disponible). Nada se publica hasta el lanzamiento (que T9.5 movió al completar T12 — SPEC §7).
## 4c. Enmienda T8 — tabla `approvals` (gates con confirmación)

Los gates por política (T8) necesitan un canal entre el proxy (que retiene la `tools/call`) y el operador (que decide desde otra terminal). Ese canal es SQLite: **tabla nueva, `effects` intacta** — ni una columna ni el hash cambian; el schema de §3 sigue congelado. Validado en el checkpoint de T8 (29-08-2026).

```sql
CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,               -- ulid
  effect_id    TEXT NOT NULL REFERENCES effects(id),
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decision     TEXT CHECK (decision IN ('allow','deny')),
  decided_by   TEXT                            -- operador (`sagaz approve --by`), o 'timeout'
);
CREATE INDEX idx_approvals_effect ON approvals (effect_id);
CREATE INDEX idx_approvals_open   ON approvals (requested_at) WHERE decided_at IS NULL;
```

Convenciones:

1. **Ciclo de vida del efecto retenido.** `begin()` inserta el efecto `pending` como siempre; el proxy abre una fila en `approvals` y pollea `decided_at` (intervalo corto, snapshot fresco por lectura gracias a WAL). Con `allow` el flujo sigue igual que un efecto normal (cierra `ok`/`error`). Con `deny` o timeout el efecto cierra `status = 'blocked'` **sin haber sido reenviado**, y entra a la cadena de hashes como cualquier otro: un intento frenado es historia auditable.
2. **Timeout = deny, y queda escrito.** Al vencer `policy.confirmTimeoutMs` el proxy escribe él mismo `decision = 'deny', decided_by = 'timeout'`. Así `sagaz pending` deja de listarlo y un `sagaz approve` tardío es rechazado con la decisión vigente, en vez de quedar como aprobación fantasma que nadie consume. La escritura es atómica sobre `decided_at IS NULL`: si el operador gana la carrera en el último instante, vale su decisión.
3. **El porqué vive en `result_json`.** Un efecto `blocked` guarda como resultado exactamente la respuesta que recibió el agente (la plantilla, `isError: true`) con la metadata del gate en `_meta.sagaz` (`gate`, `class`, `policy`, `approvalId`, `decidedBy`, `waitedMs`). Una sola fuente de verdad para "qué se le dijo al agente" y "por qué"; `sagaz ledger` la lee de ahí.
4. **`block` no abre approval.** Solo `confirm` escribe en esta tabla. Un `block` cierra `blocked` de inmediato.
5. **Un solo escritor por cadena, sin cambios.** La CLI (`approve`/`deny`) escribe únicamente en `approvals`, nunca en `effects`; la invariante de `tail()` (§4b.2) no se toca. Si el proxy muere con una approval abierta, el efecto queda `pending` (huella honesta del crash, §4b.1) y la fila abierta queda visible en `sagaz pending` hasta que alguien decida; nadie la consume.

## 4d. Enmienda T9.5 — `class_source = 'pack'` (Fase 2)

Al especificar la Fase 2 (SPEC §6c) se auditó qué toca del contrato del ledger. Resultado: casi nada. `pre_state_json` (dentro del hash, escrito una sola vez al cierre), `undo_json`/`undo_status` (ciclo de vida, fuera de la cadena) y `compensates_id` ya existen en el schema congelado con exactamente la semántica que T10–T12 necesitan (§3, decisiones 1, 5 y 6). El rollback de T12 abre su propia sesión en el ledger, así que la invariante de un-solo-escritor (§4b.2) tampoco se toca — la regla "la CLI no escribe en `effects`" (§4c.5) era del canal de approvals, no una ley general.

Lo único que no cierra: T11 clasifica **R** a los efectos con inversa derivable por pack, y el CHECK de `class_source` (§3) solo admite `('annotation','rule','llm','user')` — no hay valor para "lo decidió un pack". Conflarlo con `'rule'` (heurística built-in) o `'user'` (regla del usuario) rompería la proveniencia, que existe justamente para debuggear el clasificador (§3, decisión 4). Enmienda: `class_source` gana el valor **`'pack'`**. Es la primera enmienda que toca la tabla `effects`; como SQLite no permite alterar un CHECK, la migración (rebuild de tabla) va dentro de T11. La cadena de hashes no cambia: `class_source` no participa del payload canónico (verificado en `packages/core/src/ledger/hash.ts` — las 12 claves canónicas no lo incluyen), así que las filas históricas siguen verificando igual.

**Aplicada (T11, 30-08-2026).** `migrateClassSourcePack` en `packages/core/src/ledger/schema.ts`: rebuild transaccional al abrir el ledger en modo escritura (procedimiento documentado de SQLite, FKs off + `foreign_key_check` antes del commit), idempotente; una apertura readonly no migra — leer filas viejas no lo necesita, solo escribir `'pack'`. Filas copiadas verbatim, cadena intacta; test en `packages/core/test/migration.test.ts` (ledger pre-T11 real: pre-estado, approval, fila pending de crash → migra sin perder filas y `verify` OK).
