/****************************************************
 * CONFIGURACIÓN CENTRAL DE TRIGGERS
 *
 * Ejecutar `configurarTodosLosTriggers` UNA vez (tras pegar todos los archivos).
 * Borra TODOS los triggers del proyecto y los recrea con las cadencias acordadas.
 ****************************************************/
function configurarTodosLosTriggers() {
  // Limpia todo (incluye los viejos, p.ej. el descargador horario que ya no existe).
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });

  // ── Descarga RÁPIDA (cada 15 min): descarga 3 días → filtro. Las nuevas quedan "Por procesar"
  //    (NO crea deals solo; eso lo decides en el panel o lo hace el respaldo a las 12 h).
  ScriptApp.newTrigger('sincronizarBsaleRapido').timeBased().everyMinutes(15).create();

  // ── Descarga COMPLETA 30 días (1×/día, madrugada): backfill/correcciones
  ScriptApp.newTrigger('sincronizarBsaleCompleto').timeBased().atHour(6).everyDays(1).inTimezone('America/Santiago').create();

  // ── Respaldo de entrada: tras RESPALDO_HORAS "Por procesar" sin decidir, crea el deal SIN correo.
  ScriptApp.newTrigger('procesarRespaldoSinCorreo').timeBased().everyHours(1).create();

  // ── Seguimientos día 3/7 (el propio script filtra L-V 9-18h)
  ScriptApp.newTrigger('procesarSeguimientos').timeBased().everyHours(1).create();

  // ── Cierre día hábil 21 por silencio (1×/día, madrugada).
  ScriptApp.newTrigger('cerrarCotizacionesVencidas').timeBased().atHour(6).everyDays(1).inTimezone('America/Santiago').create();

  // ── Monitor de respuestas Gmail (cada 30 min)
  ScriptApp.newTrigger('monitorearRespuestasGmail').timeBased().everyMinutes(30).create();

  // ── Sync onEdit Sheet → HubSpot (ediciones manuales en col P)
  ScriptApp.newTrigger('onEditSincronizar').forSpreadsheet(getWorkSS()).onEdit().create();

  // ── Cruce de pedidos (1×/día ~9:15-9:30, tras el pegado matinal del CSV a las 9:00)
  // atHour(9) dispara entre 9:00-9:30 en Apps Script (ventana de ±30 min).
  ScriptApp.newTrigger('cruzarPedidos').timeBased().atHour(9).everyDays(1).inTimezone('America/Santiago').create();

  // ── Procesa "Revisión manual": crea deals de las filas que marcaste "Crear deal" (cada hora)
  ScriptApp.newTrigger('procesarRevisionManual').timeBased().everyHours(1).create();

  // ── Limpieza mensual de "Cotizaciones Bsale" + Detalle (>60 días). El día 1 a las 5 AM.
  ScriptApp.newTrigger('limpiarBsaleViejos').timeBased().onMonthDay(1).atHour(5).inTimezone('America/Santiago').create();

  // ── "prepararSeguimientosDelDia" DEPRECADO: la pestaña "Seguimientos de hoy" fue reemplazada
  //    por el panel ("Saltar hoy" en la sección OCURRE HOY). Ya no tiene trigger.

  // ── Sync HubSpot → hoja: refleja en "Etapa" los cambios hechos en HubSpot (cada hora)
  ScriptApp.newTrigger('sincronizarEtapasDesdeHubSpot').timeBased().everyHours(1).create();

  // ── Panel Seguimiento: refresco diario (8 AM) + aplicación instantánea del desplegable (onEdit)
  ScriptApp.newTrigger('actualizarPanelSeguimiento').timeBased().atHour(8).everyDays(1).inTimezone('America/Santiago').create();
  ScriptApp.newTrigger('onEditPanel').forSpreadsheet(getWorkSS()).onEdit().create();

  // ── Menú personalizado "📋 Cotizaciones": se instala como onOpen instalable (proyecto standalone).
  ScriptApp.newTrigger('onOpenPanel').forSpreadsheet(getWorkSS()).onOpen().create();

  // ── Resumen matutino 8:00 AM: estado del día ANTES de cargar pedidos (cotizaciones nuevas,
  //    recordatorios y cierres del día). Cache key 'resumen_enviado_YYYYMMDD'.
  ScriptApp.newTrigger('enviarResumenMatutino').timeBased().atHour(8).everyDays(1).inTimezone('America/Santiago').create();

  // ── Resumen post-cruce: estado TRAS cruzar pedidos (~9:30). Lo llama cruzarPedidos() directamente.
  //    Cache key 'postcruce_enviado_YYYYMMDD'. Sin trigger propio.

  Logger.log('Triggers reconfigurados:');
  ScriptApp.getProjectTriggers().forEach(function(t) {
    Logger.log('   - ' + t.getHandlerFunction());
  });
}

/**
 * FRENO DE EMERGENCIA: borra TODOS los triggers (sistema en pausa total).
 * Nada se ejecuta hasta volver a correr configurarTodosLosTriggers.
 * Combínalo con ENVIOS_ACTIVOS = "NO" para garantía doble.
 */
function pausarSistema() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); n++; });
  Logger.log('Sistema en pausa: ' + n + ' triggers borrados. (Recuerda ENVIOS_ACTIVOS = "NO".)');
}

/**
 * Configura la vista sencilla en "Cotizaciones Vendedor": desplegable de Etapa
 * y oculta las columnas técnicas. Ejecutar UNA vez tras la migración.
 */
function configurarVistaKAM() {
  var ss = getWorkSS();
  var hoja = ss.getSheetByName('Cotizaciones Vendedor');
  if (!hoja) { Logger.log('No existe "Cotizaciones Vendedor".'); return; }

  hoja.getRange(1, COL_ETAPA + 1).setValue('Etapa').setFontWeight('bold');
  hoja.getRange(1, COL_CONTROL + 1).setValue('Control').setFontWeight('bold');

  // Desplegable en la columna Etapa (P), de la fila 2 en adelante.
  var etapas = Object.keys(ETAPAS_HS);
  var last = Math.max(hoja.getLastRow(), 2);
  var regla = SpreadsheetApp.newDataValidation().requireValueInList(etapas, true).setAllowInvalid(true).build();
  hoja.getRange(2, COL_ETAPA + 1, last - 1, 1).setDataValidation(regla);

  // Ocultar columnas técnicas: D(4) tracking, O(15) clave, R(18) thread, S(19) fecha d3,
  // T(20) fecha d7, W(23) Control.
  [4, 15, 18, 19, 20, 23].forEach(function(c) { hoja.hideColumns(c); });

  Logger.log('Vista configurada: desplegable en Etapa + columnas técnicas ocultas.');
}
