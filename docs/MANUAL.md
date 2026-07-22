# Manual de uso — Sistema de seguimiento de cotizaciones

Guía práctica de **qué tienes que hacer tú**. El sistema hace el resto solo.

---

## Protocolo diario

| Hora | Qué llega / qué haces |
|---|---|
| **8:00 AM** | Email automático: resumen del día (por procesar, recordatorios, cierres). |
| **8:00–9:00** | Abres la planilla → Panel Seguimiento → revisas y apruebas. |
| **9:00 AM** | Pegas el CSV de pedidos en la pestaña **Pedidos**. |
| **~9:30 AM** | Email automático: resumen post-cruce (deals movidos, revisión manual, pendientes). |

Eso es todo. El resto es automático.

---

## 1. El email de las 8 AM

Llega solo, de lunes a viernes (no festivos). Tres secciones:

- **Por procesar** — cotizaciones nuevas que esperan tu decisión de flujo.
- **Recordatorios hoy** — clientes a los que hoy les toca el día 3 o día 7.
- **Cierres hoy** — deals que llegan al día hábil 21 y se cierran solos.

Con ese email ya sabes qué te espera antes de abrir la planilla.

---

## 2. Panel Seguimiento — la cabecera

Al abrir la planilla verás el **Panel Seguimiento**. En la fila 1 hay dos checkboxes:

| Checkbox | Qué hace |
|---|---|
| **① Sincronizar Bsale** | Fuerza la descarga de Bsale ahora (sin esperar los 15 min). Refresca el panel. |
| **② Aprobar todo** | Procesa todas las cotizaciones nuevas según su Flujo. Si hay filas marcadas "Excluir", muestra un diálogo de confirmación antes de borrar. |

También tienes el menú **📋 Cotizaciones** en la barra superior con accesos directos a todas las acciones manuales.

---

## 3. Panel Seguimiento — las secciones

### POR PROCESAR (verde)
Cotizaciones nuevas. Elige el **Flujo** con el desplegable y luego marca ✅ Aprobar todo:

| Flujo | Qué hace |
|---|---|
| **Deal + correo** (por defecto) | Crea el deal y manda el correo inicial con PDF al cliente. |
| **Deal sin correo** | Crea el deal sin mandar correo (ya lo enviaste tú). |
| **No procesar** | No crea nada. La cotización queda excluida. |

> **Red de seguridad:** si una cotización lleva más de **12 horas** sin tocarla, el sistema la crea sola sin correo.

### OCURRE HOY (negro)
Recordatorios y cierres que vencen hoy. Puedes actuar sobre cada fila:

| Acción | Qué hace |
|---|---|
| **Seguir** | El sistema manda el recordatorio o ejecuta el cierre normalmente. |
| **Saltar hoy** | No manda nada hoy; retoma mañana. |
| **Pausar** | Congela el negocio: no recibe recordatorios ni se cierra. |
| **Excluir** | Borra el deal en HubSpot (destructivo — pide confirmación). |

### EN SEGUIMIENTO (gris oscuro)
Negocios activos con seguimiento en curso. Mismas acciones que arriba.

### PAUSADOS (gris claro)
Negocios congelados. Ponlos en **Seguir** para reactivarlos. Los pausados **no** expiran solos — el cierre del día 21 los salta.

Para revisar todos los pausados de una vez: menú **📋 Cotizaciones → Ver pausados (enviar por email)**. Llega un email con la lista ordenada por antigüedad, monto y total acumulado en pausa.

---

## 4. Pegar el CSV de pedidos (9:00 AM)

1. Descarga el CSV de pedidos de la plataforma (últimos **30 días**).
2. Planilla → pestaña **Pedidos**.
3. Borra todo lo que haya y pega el CSV nuevo (encabezados en fila 1).

El cruce corre automáticamente entre las **9:15 y 9:30**. No necesitas ejecutar nada.

---

## 5. El email post-cruce (~9:30 AM)

Llega después de que `cruzarPedidos` termina. Tres secciones:

- **Deals movidos** — qué cotizaciones pasaron a Pedido ingresado / Venta Exitosa / Negocio perdido.
- **A revisión manual** — pedidos que el sistema no pudo cruzar solo.
- **Por procesar en panel** — si quedaron cotizaciones nuevas sin aprobar.

---

## 6. Pestaña "Revisión manual"

Aquí caen los pedidos que el sistema no pudo cruzar automáticamente. Escribe en la columna **Acción**:

- **`Crear deal`** → crea el deal en HubSpot en la etapa correcta.
- **`Ignorar`** → descarta la fila (queda como registro, no vuelve a aparecer).

El sistema los procesa dentro de la hora siguiente. También puedes forzarlo desde el menú **📋 Cotizaciones → Procesar revisión manual**.

> Nunca borres filas de esta pestaña: si las borras, pueden reaparecer en el próximo cruce.

---

## 7. Etapas de los deals en HubSpot

| Etapa | Significa |
|---|---|
| **Cotizando** | Cotización enviada, esperando respuesta. |
| **Pedido ingresado** | El cliente hizo el pedido. |
| **Venta Exitosa** | Pedido completado (entregado). |
| **Negocio perdido** | Anulado o sin respuesta al día hábil 21. |

Puedes cambiar la etapa directamente en HubSpot; la hoja se sincroniza sola.

---

## 8. Menú 📋 Cotizaciones (acciones manuales)

Disponible en la barra superior de la planilla:

| Item | Para qué |
|---|---|
| Refrescar panel ahora | Reconstruye el panel al instante. |
| Enviar resumen matutino ahora | Te manda el email de las 8 AM en este momento. |
| Enviar resumen post-cruce ahora | Te manda el email de resumen post-cruce ahora. |
| Cruzar pedidos ahora | Ejecuta el cruce sin esperar el trigger. |
| Procesar revisión manual | Crea los deals marcados "Crear deal" al instante. |
| Ver pausados (enviar por email) | Manda un email con todos los deals pausados, ordenados por antigüedad, con monto y total acumulado. |
| Excluir deals marcados | Muestra qué se borraría y pide confirmación antes de ejecutar. |

---

## 9. Si algo falla

1. **Llega un email "Error en sistema de cotizaciones"** → revisa el detalle; entra a Apps Script → Ejecuciones (en rojo están los errores).
2. **Los automatismos se perdieron** → corre `configurarTodosLosTriggers` en `_triggers.gs` desde el editor.
3. **Freno de emergencia** → corre `pausarSistema` (borra todos los triggers) y pon `ENVIOS_ACTIVOS = NO` en Propiedades del script.
4. **Propiedades necesarias:** `BSALE_TOKEN`, `HUBSPOT_TOKEN`, `HUBSPOT_BCC`, `ENVIOS_ACTIVOS` (debe ser exactamente `SI`), `LOGO_FILE_ID`.

---

## 10. Mantención anual

- **Festivos:** la lista está en `_config_ids.gs` (constante `FESTIVOS_CL`). Cada diciembre hay que agregar los festivos variables del año siguiente (Semana Santa, etc.). Los fijos son automáticos.
- **Limpieza:** el día 1 de cada mes el sistema borra datos crudos de Bsale con más de 60 días. Tu historial en "Cotizaciones Vendedor" nunca se toca.
