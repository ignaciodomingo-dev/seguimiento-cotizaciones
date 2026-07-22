# Sistema de seguimiento de cotizaciones

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-V8-4285F4?logo=google&logoColor=white)
![HubSpot](https://img.shields.io/badge/HubSpot-CRM%20API-FF7A59?logo=hubspot&logoColor=white)
![Gmail](https://img.shields.io/badge/Gmail-API-EA4335?logo=gmail&logoColor=white)
![Status](https://img.shields.io/badge/status-portfolio%20%C2%B7%20anonymized-blue)

**Automatización de punta a punta del ciclo de vida de una cotización de ventas** —
desde que se genera en el ERP hasta que se cierra en el CRM — construida sobre
**Google Apps Script**, integrando la **API de un ERP**, la **API de HubSpot**,
**Gmail** y **Slack**.

> **TL;DR (English):** End-to-end sales-quote lifecycle automation built on Google
> Apps Script. Pulls quotes from an ERP API, creates & advances deals in HubSpot,
> sends threaded follow-up emails via Gmail, reconciles a daily orders CSV to detect
> conversions, and closes stale deals — with a global fail-closed kill-switch for
> safe operation. See the [engineering case study](docs/CASO-DE-ESTUDIO.md).

### En una línea

Reemplazó un proceso manual de seguimiento comercial por un sistema autónomo que
corre solo de lunes a viernes, respeta festivos y horario hábil de Chile, y le
escribe a **clientes reales** — por lo que está diseñado para **fallar de forma
segura** (si algo se rompe, deja de enviar en vez de enviar de más).

**Lo que demuestra:** integración de múltiples APIs, diseño *fail-closed* para
sistemas con efectos externos, idempotencia, manejo de secretos fuera del código,
y un [postmortem real](docs/CASO-DE-ESTUDIO.md) con análisis de causa raíz.

> ℹ️ **Repositorio de portafolio.** Es un sistema real que estuvo en producción,
> aquí **anonimizado**: todos los identificadores (IDs de planilla, cuenta de
> HubSpot, correos, teléfono, marca) fueron reemplazados por *placeholders*. No
> contiene credenciales — los secretos viven en las *Script Properties* de Apps
> Script, nunca en el código.

---

## Qué hace

1. **Descarga** las cotizaciones desde la API del ERP a una planilla de trabajo.
2. **Filtra** las del vendedor y **crea un negocio** en HubSpot (etapa *Cotizando*).
3. Envía al cliente un **correo inicial (día 0)** con el detalle y el PDF adjunto.
4. Manda **recordatorios el día hábil 3 y 7**, agrupados en el mismo hilo de Gmail.
5. Si no hay respuesta, **cierra el negocio como perdido** al día hábil 21.
6. **Cruza un CSV diario de pedidos** para detectar conversiones y mover el negocio
   a *Pedido ingresado* / *Venta exitosa* / *Venta perdida* según el estado real.
7. Manda **resúmenes diarios** (matutino y post-cruce) por correo y a Slack.

Todo con un **interruptor global de envíos** (*kill-switch*) que, apagado,
garantiza que no sale ningún correo al cliente aunque el resto falle.

## Arquitectura

```
[API ERP] ──▶ Planilla "Cotizaciones Bsale" ──▶ [Filtro] ──▶ "Cotizaciones Vendedor"
                                                                    │ (quedan "Por procesar")
                        [Panel de control: eliges flujo + "Procesar ahora"]
                                     │
                                     ▼
              [Crear negocio] ──▶ negocio + tarea + correo inicial (día 0)
                                     │
              [Seguimientos]  ──▶ recordatorios día 3 / 7 (mismo hilo)
                                     │
              [Cierre]        ──▶ día hábil 21 → Venta perdida
                                     │
[CSV pedidos] ──▶ [Cruce] ──▶ mueve el negocio: Pedido ingresado / Venta exitosa / perdida
                                     │
                                     ▼
                              [HubSpot]  ·  [Gmail]  ·  [Slack]
```

Documentación técnica completa (planillas, columnas, reglas de negocio, cadencias
de los triggers) en **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)**.

## Destacado de ingeniería

📄 **[Caso de estudio: un incidente de envíos y el rediseño *fail-closed*](docs/CASO-DE-ESTUDIO.md)**

Un postmortem real: cómo un modelo que fallaba *abierto* (ante cualquier error,
tendía a mandar correos) se rediseñó para fallar *cerrado*, con un kill-switch
global, guardas de idempotencia y defensa en profundidad. Es la mejor muestra de
cómo abordo sistemas con efectos hacia afuera.

## Decisiones de diseño que vale la pena mirar

- **Fail-closed por defecto.** El estado seguro es *no contactar al cliente*; enviar
  requiere condiciones positivas y explícitas. ([`_config_ids.gs`](Scripts/_config_ids.gs))
- **Kill-switch independiente de los triggers.** Un interruptor global corta todos
  los envíos aunque el resto del sistema esté activo.
- **Secretos fuera del código.** Tokens del ERP y HubSpot en *Script Properties*.
- **Idempotencia.** El cruce de pedidos solo toca HubSpot si el estado cambió; las
  migraciones abortan si ya se corrieron.
- **Agrupación de hilos en Gmail.** Mismo asunto en día 0/3/7 para que el cliente
  vea una sola conversación.
- **Robustez de fechas y locale.** Zona horaria y festivos de Chile, parsing
  tolerante de fechas que llegan como texto o como `Date`.

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| [`Scripts/`](Scripts/) | Código Google Apps Script (`.gs`). Cada fase en su archivo. |
| [`Scripts/_config_ids.gs`](Scripts/_config_ids.gs) | Configuración central, helpers, kill-switch, modelo de estados. |
| [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) | Documentación técnica completa. |
| [`docs/CASO-DE-ESTUDIO.md`](docs/CASO-DE-ESTUDIO.md) | Postmortem del incidente y rediseño. |
| [`docs/MANUAL.md`](docs/MANUAL.md) | Manual de operación diaria. |
| [`tools/`](tools/) | Utilidades de apoyo (p. ej. preparar el logo para Slack). |

## Cómo se desplegaría

Es un proyecto de Apps Script *standalone* que se sube con [`clasp`](https://github.com/google/clasp):

```bash
cp Scripts/.clasp.json.example Scripts/.clasp.json   # y pon tu scriptId
cd Scripts && clasp push
```

Luego se configuran las *Script Properties* (`BSALE_TOKEN`, `HUBSPOT_TOKEN`,
`HUBSPOT_BCC`, `ENVIOS_ACTIVOS`, `SLACK_WEBHOOK_URL`, `LOGO_FILE_ID`) y se corre
`configurarTodosLosTriggers`. Detalle en [docs/MANUAL.md](docs/MANUAL.md).

## Stack

`Google Apps Script (V8)` · `HubSpot CRM API` · `ERP REST API` · `Gmail` ·
`Google Sheets` · `Slack Incoming Webhooks` · `clasp`

## Licencia

[MIT](LICENSE) © Ignacio Domingo
