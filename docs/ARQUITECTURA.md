# Arquitectura — Sistema de seguimiento de cotizaciones

> Documentación técnica del proyecto. Todos los identificadores (IDs de planilla,
> cuenta de HubSpot, correos, marca) fueron reemplazados por *placeholders* — ver
> [`Scripts/_config_ids.gs`](../Scripts/_config_ids.gs).

---

## 1. Qué hace

Automatiza el ciclo de vida completo de las cotizaciones de vendedor, desde Bsale hasta el cierre:

1. Descarga las cotizaciones desde la API de Bsale.
2. Filtra las de vendedor y crea un deal en HubSpot (etapa **Cotizando**).
3. Envía al cliente un **email inicial (día 0)** con el detalle + PDF de la cotización.
4. Si el monto supera $500.000, crea una tarea de llamada para el día siguiente.
5. Manda recordatorios el día hábil 3 y 7 (en el mismo hilo).
6. Si no hay respuesta, cierra el deal como **Venta perdida** el día hábil 21.
7. Cruza un CSV diario de **pedidos** para detectar conversiones y mover el deal a
   **Pedido ingresado** / **Venta exitosa** / **Venta perdida** según el estado del pedido.

Todo corre en **Google Apps Script**, en un proyecto standalone privado.

---

## 2. Arquitectura — proyecto standalone privado

Desde 2026-06-19 el sistema vive en un **proyecto Apps Script standalone** en el Drive
privado de vendedor (antes estaba pegado a la planilla compartida de Bsale del analista,
visible para toda la empresa). Accede a la planilla por ID, no con `getActiveSpreadsheet()`.

```
[API Bsale] → "Cotizaciones Bsale" (+Detalle) → [GAS#0 filtro] → "Cotizaciones Vendedor"
                                                                         │  (quedan "Por procesar")
                              [Panel: eliges Flujo + casilla "Procesar ahora"]
                                       [GAS#1] deal + tarea + correo según Flujo
                                       (respaldo: >12 h sin decidir → deal SIN correo)
                                       [GAS#2] recordatorios día 3 / 7
                                       [GAS#3] cierre día 21 (Venta perdida)
                                                                         │
[CSV pedidos] → "Pedidos" → [GAS#5 cruce] → mueve deal: Pedido ingresado / Venta exitosa / Venta perdida
                                          → lo que no calza → "Revisión manual"
                                                                         v
                                                                 [HubSpot] / [Gmail]
```

Todo en UNA planilla privada (`WORK_SS_ID`). En `_config_ids.gs`, `SOURCE_SS_ID = WORK_SS_ID`.

### Archivos del proyecto (14)

| Archivo | Rol |
|---|---|
| `_config_ids.gs` | IDs de planilla + helpers (`getWorkSS`, `getSourceSS`, `aFecha_`) |
| `fuente_bsale_descarga.gs` | Descarga de Bsale → "Cotizaciones Bsale" + Detalle (rápido 3d / completo 30d) |
| `filtrar_cotizaciones_vendedor.gs` | GAS #0 — filtra las de vendedor → "Cotizaciones Vendedor" |
| `crear_negocio_hubspot_gas1.gs` | GAS #1 — crea deal + tarea de llamada + **email inicial grupal** |
| `seguimiento_cotizaciones_gas2.gs` | GAS #2 — recordatorios día 3 y 7 |
| `panel_seguimiento.gs` | Pestaña "Panel Seguimiento": activar/pausar/saltar negocios (desplegable + onEdit) |
| `cierre_automatico_gas3.gs` | GAS #3 — cierre día 21 |
| `_migracion_estados.gs` | One-shots: migración de estados, limpieza de incidente, `frenarSeguimientoActivas`, `validarMotor` |
| `sincronizacion_gas4.gs` | GAS #4 — sync onEdit Sheet→HubSpot + monitor Gmail |
| `cruce_pedidos_gas5.gs` | GAS #5 — **cruce de pedidos + revisión manual** |
| `_email_comun.gs` | Helpers de correo (firma, detalle, asunto, cuerpo, descarga PDF de Bsale) |
| `_triggers.gs` | `configurarTodosLosTriggers` (reconfigura todas las cadencias) + `pausarSistema` |
| `_slack.gs` | Resúmenes (matutino + post-cruce) a Slack vía Incoming Webhook (opcional) |
| `_diagnostico.gs` | Diagnósticos / `encenderEnvios` / `apagarEnvios` / `autorizarPermisos` / `listarEtapasHubSpot` |

> El `Código.gs` del analista (descarga la Bsale compartida de la empresa) NO es parte de
> este proyecto; vive en la planilla compartida y no se toca.

---

## 3. Planillas y columnas

Pestañas en la planilla privada:

| Pestaña | Rol |
|---|---|
| `Cotizaciones Bsale` | Descargada de la API (todos los vendedores, solo encabezado). |
| `Cotizaciones Bsale Detalle` | Detalle de productos. Solo de las cotizaciones de vendedor (`DETALLE_SOLO_MIS`). |
| `Cotizaciones Vendedor` | Hoja de trabajo. GAS #0 escribe; #1, #2, #3, #5 leen y actualizan. |
| `Pedidos` | CSV de pedidos pegado a diario (30 días). Lee GAS #5. |
| `Revisión manual` | Pedidos que no calzan limpio (la crea/llena GAS #5). |
| `Excluir` | N° de cotización a NO automatizar (col A). GAS #1 las salta y marca "Excluida". |
| `Seguimientos de hoy` | **DEPRECADA** (sin trigger ni lector desde jul 6): la reemplazó el panel ("Saltar hoy" → col Z). Se puede borrar. |
| `Panel Seguimiento` | Centro de mando: negocios en Cotizando (activos + pausados) con acción Seguir / Saltar hoy / Pausar / Excluir (`panel_seguimiento.gs`). |

### Columnas de "Cotizaciones Vendedor"

| Col | Idx | Campo | Origen |
|---|---|---|---|
| A | 0 | Fecha Emisión | Bsale |
| B | 1 | Fecha y Hora Cotización | Bsale |
| C | 2 | N° Cotización | Bsale |
| D | 3 | Tracking Number | Bsale |
| E | 4 | Nombre Empresa | Bsale |
| F | 5 | Nombre Cliente | Bsale |
| G | 6 | Cliente RUT | Bsale |
| H | 7 | Email Cliente | Bsale |
| I | 8 | Sucursal | Bsale |
| J | 9 | Vendedor | Bsale |
| K–M | 10–12 | Monto Neto / IVA / Monto Total | Bsale |
| N | 13 | Estado (Bsale) | Bsale |
| O | 14 | Clave Técnica (`COTIZACION\|\|<docId>`) | Bsale |
| P | 15 | **Etapa** (etiqueta real de HubSpot) | GAS #1 / #3 / #5 / sync #4 |
| Q | 16 | Deal ID HubSpot | GAS #1 / #5 |
| R | 17 | Thread ID día 3 | GAS #1 / #2 |
| S–T | 18–19 | Fecha día 3 / día 7 enviado | GAS #2 |
| U | 20 | Detalle pedido | GAS #0 |
| V | 21 | N° Pedido | GAS #5 |
| W | 22 | **Control** (bandera interna de seguimiento) | GAS #1 / #2 / #4 / panel |
| X | 23 | **Flujo** (decisión de entrada: Deal + correo / Deal sin correo / No procesar) | panel / GAS #1 |
| Y | 24 | **Ingreso** (sello de cuándo entró la fila; para el respaldo de 12 h) | GAS #0 |
| Z | 25 | **Saltar hasta** ("Saltar hoy" del panel; GAS #2 no envía mientras hoy ≤ fecha) | panel / GAS #2 |

**Modelo de estados (dos columnas, desde la migración 2026-06):**
- **Etapa (col P)** = la etiqueta REAL de la etapa del deal en HubSpot: `Cotizando`,
  `Pedido ingresado`, `Venta Exitosa`, `Negocio perdido`, etc. Vacía si aún no hay deal.
- **Control (col W)** = bandera interna que decide el seguimiento:
  *(vacío)* = en seguimiento activo · `Vinculada` = comparte deal con otra cotización del
  mismo cliente/día · `Respondida` = pausado / el cliente contestó · `Excluida` = fuera de todo ·
  `Archivada` = histórica.
- **Regla central** (`enSeguimientoActivo_`): una fila recibe día 3/7 y se cierra al día 21
  solo si **Etapa = "Cotizando" + Control vacío + tiene Deal ID**.

### Columnas de "Pedidos" (CSV)

A Fecha · **B Referencia (N° pedido)** · C RUT · D Empresa · E Nombre Fantasía · F Contacto ·
G Correo · H Items · I–K Neto/IVA/Total · L Saldo · M Forma de Pago · N Transporte ·
**O Origen** (`COT#####` = de una cotización tuya / `CHK#####` = web directo, se ignora) ·
P Canal · Q Vendedor · R Documento · **S Estado**.

---

## 4. Reglas de negocio

### Entrada y seguimiento
- **Filtro a vendedor (GAS #0):** vendedor `Vendedor Ejemplo` / `Mi Empresa Spa`; dedup por N° Cot.
  Ya NO encadena la creación de deals: las nuevas quedan "Por procesar" (col Y sella el ingreso).
- **Compuerta de entrada (Panel):** GAS #1 ya no corre solo. Procesas las nuevas con la casilla
  "Procesar ahora", según el **Flujo** (col X) de cada una: `Deal + correo` / `Deal sin correo` /
  `No procesar`. **Respaldo** (`procesarRespaldoSinCorreo`, horario): a las `RESPALDO_HORAS` (12 h)
  sin decidir, crea el deal SIN correo; respeta "No procesar".
- **Monto mínimo para deal (GAS #1):** Monto Total > $100.000.
- **Agrupación:** `Email + fecha`. Varias cotizaciones del mismo cliente el mismo día → un deal.
  Primera fila `Activa`, las demás `Vinculada`. El deal toma el N° y monto más alto.
- **Email inicial (GAS #1, día 0):** al crear el deal, manda al cliente un correo con **todas las
  cotizaciones del grupo** (N°/monto/detalle de cada una) + **un PDF adjunto por cada una**
  (`Cotizacion_<N°>.pdf`, de `urlPdf`). Guarda Thread ID. Mismo asunto que día 3/7 → mismo hilo.
- **Recordatorios (GAS #2):** filas en seguimiento activo (Etapa "Cotizando" + Control vacío + Deal ID),
  L–V 9–18h Chile, respetando festivos, solo cotizaciones ≤14 días.
  Día 7 va **directo al cliente** con el mismo asunto (NO `thread.reply()`, que volvía a vendedor).
  Blindajes (2026-07-06): `LockService` (corridas solapadas no duplican), dedup por N° dentro de
  la corrida (filas duplicadas → un solo correo), día 3 tardío marca también col T (no salen día 3
  y día 7 el mismo día), y un fallo de envío dispara `alertarError_` (la fila ya quedó marcada
  como enviada → reenviar a mano). Salta filas con fecha vigente en col Z ("Saltar hasta") y
  cotizaciones que ya aparecen en "Pedidos".
- **Tarea de llamada (GAS #1):** solo si Monto Total > $500.000; 10:00 del día siguiente.

### Control del seguimiento — cómo parar (Panel Seguimiento)
Todo se maneja desde la pestaña `Panel Seguimiento` (la arma `actualizarPanelSeguimiento`, refresca 8:00),
columna **Acción** (la aplica `onEditPanel` al instante, salvo Excluir):

| Acción | Efecto en el estado real | Reversible |
|---|---|---|
| **Seguir** | Control vacío (activo). Reactiva uno pausado y limpia "Saltar hasta" (col Z). | — |
| **Saltar hoy** | Escribe la fecha en col Z ("Saltar hasta") de la hoja real; GAS #2 no envía mientras hoy ≤ esa fecha. Sobrevive refrescos del panel. | sí, vuelve mañana (o Seguir) |
| **Pausar** | Control → `Respondida`. No recibe nada ni se cierra; el deal sigue en Cotizando. | sí (Seguir) |
| **Excluir** | **Borra el deal en HubSpot** + Control → `Excluida` + limpia Etapa/Deal. | recuperable ~90 d en HubSpot |

Excluir NO se aplica al instante (es destructivo): se marca y se confirma con `excluirPanel` (dry-run) →
`excluirPanelReal`. Si el deal es compartido (Vinculada), arrastra todas sus filas.

**Señales del panel (2026-07-06):**
- Cabecera: estado de ENVÍOS (ON/OFF) + fecha y **hora de generación** (el panel es una foto, no vive).
- **N° Cotización** = link al deal en HubSpot · **Cliente** = link al hilo de Gmail (si existe).
- **"⚠ sin correo inicial"**: fila activa sin Thread ID real (col R) — el cliente no recibió (o no quedó
  registrado) el correo inicial. Típico de deals creados con envíos OFF o flujo "Deal sin correo".
- **"YA TIENE PEDIDO — el próximo cruce lo mueve"** (estado *Convertido*): la cotización ya aparece en
  la pestaña "Pedidos"; GAS #2 no le envía nada y el cruce diario moverá el deal. No cuenta como
  recordatorio del día (ni en el panel ni en el resumen matutino).
Otras vías equivalentes: mover la Etapa (col P) fuera de "Cotizando" cierra/gana el deal; si el cliente
responde el correo, `monitorearRespuestasGmail` pone Control `Respondida` solo.

### Ciclo de vida del deal (etapas HubSpot, pipeline `default` "Cliente cartera")
| Disparador | → Etapa | ID |
|---|---|---|
| Deal creado | **Cotizando** | `decisionmakerboughtin` |
| Pedido: Pagado / En preparación / Listo para Logística / Listo para Retiro / En Tránsito | **Pedido ingresado** | `contractsent` |
| Pedido: Completado | **Venta Exitosa** | `STAGE_VENTA_EXITOSA` |
| Pedido: Anulado | **Venta perdida** (Negocio perdido) | `STAGE_NEGOCIO_PERDIDO` |
| Sin respuesta al día hábil 21 (GAS #3) | **Venta perdida** | `STAGE_NEGOCIO_PERDIDO` |

### Cruce de pedidos (GAS #5)
- Lee "Pedidos", por cada `COT#####` busca la cotización (col C) y según el Estado (col S) mueve el deal.
- Actualiza el deal con el **N°/monto de la cotización que realmente convirtió** (clave si convirtió
  una *Vinculada*) + agrega el N° pedido a la **descripción** del deal. **Reabre** si estaba cerrado.
- **Idempotente:** solo toca HubSpot si el estado cambió.
- **`Pendiente de Pago` → fuera del cruce.** Si tiene deal, el flujo normal lo cierra (día 21) y lo
  reabre si luego paga; si no tiene deal, no interesa.
- **`CHK#####` (web directo) y COT de otros vendedores → se ignoran** (no son del pipeline de vendedor).
- Lo que no calza (cotización <$100k sin deal, estado desconocido, doble conversión) → "Revisión manual".

### Revisión manual
Pestaña con: Fecha, N° Pedido, COT, Cliente, Empresa, Email, Monto, Estado pedido, Motivo,
**Acción**, **Resultado**. Escribiendo `Crear deal` en *Acción*, `procesarRevisionManual` crea el
contacto + deal en la etapa correcta, lo **engancha a la fila** de la cotización (cols P/Q/V) para
que los cruces futuros lo sigan avanzando, y escribe el Deal ID en *Resultado*.

---

## 5. Configuración

### Script Properties
| Propiedad | Valor |
|---|---|
| `BSALE_TOKEN` | Token de la API de Bsale (header `access_token`) |
| `HUBSPOT_TOKEN` | Token de la Private App de HubSpot |
| `HUBSPOT_BCC` | BCC de HubSpot para registrar emails en el deal |
| `ENVIOS_ACTIVOS` | **Kill-switch**: solo con "SI" salen correos a clientes y cierres. Atajos: `encenderEnvios` / `apagarEnvios` (`_diagnostico.gs`). |
| `SLACK_WEBHOOK_URL` | (Opcional) webhook para los resúmenes en Slack; sin ella se omite en silencio |
| `LOGO_FILE_ID` | (Opcional) ID en Drive del PNG del logo para emails/Slack |

### Toggles `fuente_bsale_descarga.gs`
- `SOLO_MIS_COTIZACIONES: false` → "Cotizaciones Bsale" baja todos los vendedores.
- `DETALLE_SOLO_MIS: true` → detalle solo de las de vendedor (evita el límite de 6 min).
- `DIAS_REVISION: 30` (completo) · `DIAS_RAPIDO: 3` (rápido).

### Referencias HubSpot
Account `YOUR_HUBSPOT_ACCOUNT_ID` · Owner `YOUR_HUBSPOT_OWNER_ID` · Pipeline `default` · Propiedad N° cot `numero_de_cotizacion`
· N° pedido va en `description`. IDs de etapa en la tabla del ciclo de vida (§4).

### Bsale
PDF = `urlPdf` (URL pública, `UrlFetchApp`). Cotización = `document_type.name`. Endpoint `api.bsale.io/v1/documents.json`.

---

## 6. Operación

- **Triggers:** `configurarTodosLosTriggers` (en `_triggers.gs`) borra y recrea TODO. Cadencias:

  | Trigger | Cadencia |
  |---|---|
  | `sincronizarBsaleRapido` (3d) → encadena filtro (quedan "Por procesar") | cada 15 min |
  | `sincronizarBsaleCompleto` (30d) | diario 6 AM |
  | `procesarRespaldoSinCorreo` (respaldo 12 h, deal SIN correo) | cada 1h |
  | `procesarSeguimientos` (día 3/7) | cada 1h |
  | `cerrarCotizacionesVencidas` (día hábil 21) | diario 6 AM |
  | `monitorearRespuestasGmail` | cada 30 min |
  | `sincronizarEtapasDesdeHubSpot` (solo cotizaciones ≤90 días) | cada 1h |
  | `cruzarPedidos` → encadena `enviarResumenPostCruce` | diario 9:00–9:30 (tras pegar el CSV ~9 AM) |
  | `procesarRevisionManual` | cada 1h |
  | `actualizarPanelSeguimiento` | diario 8 AM |
  | `enviarResumenMatutino` (asunto lleva `[ENVÍOS OFF]` si el kill-switch está apagado) | diario 8 AM |
  | `limpiarBsaleViejos` (borra >60 días de las hojas Bsale) | mensual, día 1, 5 AM |
  | `onEditSincronizar` / `onEditPanel` | evento (onEdit) |
  | `onOpenPanel` (menú "📋 Cotizaciones") | evento (onOpen) |

- **Pegar pedidos:** cada mañana, borrar la pestaña "Pedidos" y pegar el CSV (30 días, encabezados fila 1).
- **Excluir una cotización:** poner cualquier valor en col P antes de que GAS #1 la procese.
- **Encender/apagar envíos:** `encenderEnvios` / `apagarEnvios` (`_diagnostico.gs`) — un clic en vez
  de editar la Script Property. `apagarEnvios` es el freno de emergencia (nada sale al cliente).
- **Diagnósticos (`_diagnostico.gs`):** `diagnosticoEstadovendedor`, `autorizarPermisos`,
  `listarEtapasHubSpot`, `diagnosticarPdfCotizacion` (en `_email_comun.gs`).
- **Probar email inicial:** `probarEmailInicialAMiMismo`.

---

## 7. Roadmap (pendiente)

1. **Rollout multi-vendedor:** "una hoja por vendedor" como sistema de empresa. OJO: infraestructura
   compartida, debería vivir en un proyecto/planilla oficial, NO en la privada de vendedor. Requiere
   `SOLO_MIS_COTIZACIONES: false` + `DETALLE_SOLO_MIS: false` + split por vendedor.
2. **Menú/botones en la planilla:** acciones manuales ("Cruzar pedidos ahora", etc.) desde un menú.
   Requiere un script ADHERIDO a la planilla privada + importar el proyecto standalone como Librería
   (los botones de Sheets solo llaman a scripts container-bound, no a un standalone).

> **Hecho:** standalone privado + descarga propia Bsale (jun 19) · email inicial día 0 con PDF ·
> umbral $100k · cruce de pedidos con ciclo de vida completo del deal + revisión manual ·
> cadencias (mail ≤15 min tras cotizar) (jun 22) · kill-switch `ENVIOS_ACTIVOS` + panel/resúmenes +
> Slack (jun 25–jul 1) · **lote 1** fixes auditoría: lock+dedup+alerta en GAS #2, dedup del filtro,
> panel/resumen espejan guardas reales, `[ENVÍOS OFF]` en asunto, sync HubSpot ≤90d (jul 6) ·
> **lote 2** panel: "Saltar hoy" persistente (col Z), badge "ya tiene pedido", aviso "sin correo
> inicial", links a HubSpot/Gmail, hora de generación (jul 6).
