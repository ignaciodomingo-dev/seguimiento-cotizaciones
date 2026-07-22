/**
 * CIERRE AUTOMÁTICO DÍA 21 (GAS #3)
 * Corre 1×/día (madrugada). Busca filas en seguimiento activo cuya fecha de emisión sea
 * >= 21 días hábiles atrás y las cierra: Etapa → "Negocio perdido" en Sheet,
 * deal → "Perdido" en HubSpot.
 *
 * Depende de calcularFechaHabil_() y FESTIVOS_CL definidos en _config_ids.gs.
 */

const CONFIG_CIERRE = {
  HOJA_NOMBRE: "Cotizaciones Vendedor",
  URL_BASE_HS: "https://api.hubapi.com/crm/v3/objects/deals/",
  STAGE_PERDIDO: "STAGE_NEGOCIO_PERDIDO",
  DIAS_CIERRE: 21,        // días hábiles desde emisión hasta cerrar por silencio
  DIAS_MAX_GUARDA: 35     // GUARDA: no cerrar cotizaciones > este nº de días naturales (debe cubrir DIAS_CIERRE hábiles + festivos)
};

function cerrarCotizacionesVencidas() {
  // INTERRUPTOR GLOBAL: si los envíos no están activos, tampoco se cierran deals por silencio.
  if (!enviosActivos_()) { Logger.log("Envíos OFF (ENVIOS_ACTIVOS != SI). No se cierran cotizaciones."); return; }

  const ss = getWorkSS();
  const hoja = ss.getSheetByName(CONFIG_CIERRE.HOJA_NOMBRE);
  if (!hoja) {
    Logger.log("Error: no se encontró la hoja " + CONFIG_CIERRE.HOJA_NOMBRE);
    return;
  }

  const token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) throw new Error("Falta HUBSPOT_TOKEN en Propiedades del Script.");

  const datos = hoja.getDataRange().getValues();
  const hoySinHora = new Date();
  hoySinHora.setHours(0, 0, 0, 0);

  let cerradas = 0;

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const nFila = i + 1;

    // Solo filas en seguimiento activo: Etapa "Cotizando" + Control vacío + con Deal ID.
    if (!enSeguimientoActivo_(fila)) continue;

    const fechaEmision = aFecha_(fila[0]);
    if (!fechaEmision) continue;

    // GUARDA: no cerrar automaticamente cotizaciones antiguas (> DIAS_MAX_GUARDA dias); se dejan para revision manual.
    if ((Date.now() - fechaEmision.getTime()) > CONFIG_CIERRE.DIAS_MAX_GUARDA * 86400000) continue;

    // Día de cierre = DIAS_CIERRE días hábiles desde emisión
    const fechaCierre = calcularFechaHabil_(fechaEmision, CONFIG_CIERRE.DIAS_CIERRE);
    if (hoySinHora.getTime() < fechaCierre.getTime()) continue;

    try {
      // C2 — Orden correcto: PRIMERO HubSpot, DESPUÉS la hoja.
      // Si el PATCH falla, no tocamos la hoja → la sync horaria no puede revertir el estado.
      // Si el PATCH ok y el write de hoja falla: HubSpot="Negocio perdido", hoja="Cotizando"
      // → la próxima sync lee HubSpot y corrige la hoja sola (se auto-sana).

      // 1. Mover deal a "Perdido" en HubSpot.
      const res = UrlFetchApp.fetch(CONFIG_CIERRE.URL_BASE_HS + fila[16], {
        method: 'patch',
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        payload: JSON.stringify({ properties: { dealstage: CONFIG_CIERRE.STAGE_PERDIDO } }),
        muteHttpExceptions: true
      });

      if (res.getResponseCode() !== 200) {
        // HubSpot falló: no tocar la hoja. La próxima corrida (mañana) lo reintentará.
        Logger.log("Error cerrando deal en HubSpot (fila " + nFila + ", HTTP " + res.getResponseCode() + "): " + res.getContentText());
        alertarError_('cierre-dia21 fila ' + nFila, 'HTTP ' + res.getResponseCode() + ' — ' + res.getContentText().slice(0, 200));
        continue;
      }

      // 2. HubSpot ok: ahora marcar en Sheet.
      hoja.getRange(nFila, COL_ETAPA + 1).setValue("Negocio perdido");
      SpreadsheetApp.flush();
      cerradas++;
      Logger.log(" Fila " + nFila + " cerrada — HubSpot OK + hoja OK.");

    } catch (e) {
      Logger.log("Error fila " + nFila + ": " + e.message);
    }
  }

  Logger.log("Cierre automático finalizado. Deals cerrados: " + cerradas);
}

// El trigger de cierre se crea desde configurarTodosLosTriggers (_triggers.gs).
// ⚠️ Tras subir este cambio, correr configurarTodosLosTriggers() para recrear el trigger con el nuevo nombre.
