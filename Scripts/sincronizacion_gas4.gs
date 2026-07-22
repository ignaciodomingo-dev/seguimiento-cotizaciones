/**
 * SINCRONIZACIÓN BIDIRECCIONAL (GAS #4)
 *
 * 1. onEditSincronizar (trigger instalable): cuando cambias la Etapa (col P) a mano,
 *    actualiza el deal en HubSpot. Usa el ÚNICO mapa de etapas: ETAPAS_HS (_config_ids.gs).
 *    Solo sincroniza etiquetas que existan ahí (p. ej. "Venta Exitosa", "Negocio perdido").
 *
 * 2. monitorearRespuestasGmail (cada hora, horario laboral): detecta si el cliente
 *    respondió al hilo del día 3 y pone Control = "Respondida".
 *    Solo en filas en seguimiento activo con Thread ID en col R.
 *
 * Los triggers se crean desde configurarTodosLosTriggers (_triggers.gs).
 */

const CONFIG_SYNC = {
  HOJA_NOMBRE: "Cotizaciones Vendedor",
  TIMEZONE: "America/Santiago",
  URL_BASE_HS: "https://api.hubapi.com/crm/v3/objects/deals/",
  COL_ESTADO: 16,       // columna P (1-indexed)
  COL_DEAL_ID: 17,      // columna Q
  COL_THREAD_ID: 18,    // columna R
  COL_EMAIL_CLIENTE: 8  // columna H
};

// ─── 1. TRIGGER onEdit: Sheet → HubSpot ──────────────────────────────────────

/**
 * Se ejecuta cuando el USUARIO edita manualmente la hoja.
 * Los cambios programáticos de GAS #2 y GAS #3 NO disparan este trigger.
 */
function onEditSincronizar(e) {
  if (!e || !e.range) return;

  const hoja = e.range.getSheet();
  if (hoja.getName() !== CONFIG_SYNC.HOJA_NOMBRE) return;
  if (e.range.getColumn() !== CONFIG_SYNC.COL_ESTADO) return;

  const nFila = e.range.getRow();
  if (nFila < 2) return; // ignorar encabezado

  const nuevaEtapa = String(e.value || "").trim();
  const stageHS = ETAPAS_HS[nuevaEtapa];
  if (!stageHS) return; // etiqueta sin mapeo a etapa de HubSpot, no hacer nada

  const dealId = String(hoja.getRange(nFila, CONFIG_SYNC.COL_DEAL_ID).getValue()).trim();
  if (!dealId) {
    Logger.log("Fila " + nFila + ": sin Deal ID, no se puede actualizar HubSpot.");
    return;
  }

  const token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) {
    Logger.log("Error: falta HUBSPOT_TOKEN en Propiedades del Script.");
    return;
  }

  try {
    const res = UrlFetchApp.fetch(CONFIG_SYNC.URL_BASE_HS + dealId, {
      method: 'patch',
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      payload: JSON.stringify({ properties: { dealstage: stageHS } }),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() === 200) {
      Logger.log("Deal " + dealId + " -> " + nuevaEtapa + " en HubSpot (fila " + nFila + ")");
    } else {
      Logger.log("Error HubSpot (HTTP " + res.getResponseCode() + "): " + res.getContentText());
    }
  } catch (err) {
    Logger.log("Error al sincronizar con HubSpot: " + err.message);
  }
}

// ─── 2. MONITOR GMAIL: respuestas del cliente → Sheet ────────────────────────

/**
 * Corre cada hora en horario laboral (L-V 9–18h hora Chile).
 * Busca filas "Activa" con Thread ID y verifica si el cliente respondió.
 * Si respondió, cambia el estado a "Respondida" en la hoja.
 */
function monitorearRespuestasGmail() {
  const ahora = new Date();
  const dia = ahora.getDay();
  const hora = parseInt(Utilities.formatDate(ahora, CONFIG_SYNC.TIMEZONE, "H"), 10);
  if (dia === 0 || dia === 6 || hora < 9 || hora >= 18) return;

  const ss = getWorkSS();
  const hoja = ss.getSheetByName(CONFIG_SYNC.HOJA_NOMBRE);
  if (!hoja) {
    Logger.log("Error: no se encontró la hoja " + CONFIG_SYNC.HOJA_NOMBRE);
    return;
  }

  const datos = hoja.getDataRange().getValues();
  let detectadas = 0;

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const nFila = i + 1;

    if (!enSeguimientoActivo_(fila)) continue;

    const threadId = String(fila[CONFIG_SYNC.COL_THREAD_ID - 1] || "").trim();
    if (!threadId || threadId.startsWith("ID_")) continue;

    const emailCliente = String(fila[CONFIG_SYNC.COL_EMAIL_CLIENTE - 1] || "").trim().toLowerCase();
    if (!emailCliente) continue;

    try {
      const thread = GmailApp.getThreadById(threadId);
      if (!thread) continue;

      const respondio = thread.getMessages().some(m =>
        m.getFrom().toLowerCase().includes(emailCliente)
      );

      if (respondio) {
        hoja.getRange(nFila, COL_CONTROL + 1).setValue("Respondida"); // col W (Control)
        detectadas++;
        Logger.log("Fila " + nFila + ": " + emailCliente + " respondio -> Control: Respondida");
      }
    } catch (eThread) {
      Logger.log("Error leyendo thread fila " + nFila + ": " + eThread.message);
    }
  }

  if (detectadas > 0) SpreadsheetApp.flush();
  Logger.log("Monitor Gmail finalizado. Respuestas detectadas: " + detectadas);
}

// ─── 3. SYNC HubSpot → Hoja: la etapa real del deal se refleja en "Etapa" ─────

/**
 * Lee la etapa actual de cada deal en HubSpot y la escribe en la columna "Etapa"
 * de la hoja. Así, si mueves un deal en HubSpot, la hoja queda al día. Corre cada hora.
 * No toca filas sin Deal ID ni filas con Control "Archivada"/"Excluida".
 */
function sincronizarEtapasDesdeHubSpot() {
  var ss = getWorkSS();
  var hoja = ss.getSheetByName(CONFIG_SYNC.HOJA_NOMBRE);
  if (!hoja) return;
  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) return;

  var last = hoja.getLastRow();
  if (last < 2) return;

  var datos = hoja.getRange(2, 1, last - 1, 23).getValues(); // incluye Etapa(P) y Control(W)
  // Solo cotizaciones de los últimos 90 días: los deals viejos ya no se mueven en HubSpot,
  // y sin este corte la consulta horaria crece sin límite con el histórico de la hoja.
  var cutoffSync = Date.now() - 90 * 86400000;
  var dealIds = [];
  datos.forEach(function(f) {
    var d = String(f[COL_DEALID] || '').trim();
    var ctrl = String(f[COL_CONTROL] || '').trim();
    if (!d || ctrl === 'Archivada' || ctrl === 'Excluida') return;
    var fe = aFecha_(f[0]);
    if (!fe || fe.getTime() < cutoffSync) return;
    dealIds.push(d);
  });
  if (!dealIds.length) return;

  var stagePorDeal = _leerEtapasDealsHS_(dealIds, token);

  // Leer toda la columna Etapa de una vez para escritura en batch al final.
  var etapaVals = hoja.getRange(2, COL_ETAPA + 1, datos.length, 1).getValues();
  var actualizadas = 0;
  for (var i = 0; i < datos.length; i++) {
    var f = datos[i];
    var d = String(f[COL_DEALID] || '').trim();
    if (!d || !stagePorDeal[d]) continue;
    var etiqueta = etiquetaEtapa_(stagePorDeal[d]);
    if (!etiqueta) continue; // etapa desconocida → no tocar
    if (etiqueta !== String(f[COL_ETAPA] || '').trim()) {
      etapaVals[i][0] = etiqueta; // acumular cambio en memoria
      actualizadas++;
    }
  }
  // Una sola escritura para todos los cambios (evita N llamadas individuales a setValue).
  if (actualizadas > 0) {
    hoja.getRange(2, COL_ETAPA + 1, datos.length, 1).setValues(etapaVals);
  }
  Logger.log('Sync HubSpot->hoja: etapas actualizadas: ' + actualizadas);
}

/** Lee dealstage de varios deals por lotes de 100. Devuelve { dealId: stageId }. */
function _leerEtapasDealsHS_(dealIds, token) {
  var out = {};
  for (var i = 0; i < dealIds.length; i += 100) {
    var chunk = dealIds.slice(i, i + 100);
    var res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ properties: ['dealstage'], inputs: chunk.map(function(id) { return { id: id }; }) }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200 || code === 207) {
      (JSON.parse(res.getContentText()).results || []).forEach(function(d) {
        out[d.id] = d.properties ? d.properties.dealstage : '';
      });
    }
    Utilities.sleep(200);
  }
  return out;
}

// Los triggers (onEditSincronizar + monitorearRespuestasGmail) se crean desde
// configurarTodosLosTriggers (_triggers.gs). No hay creadores sueltos por archivo.
