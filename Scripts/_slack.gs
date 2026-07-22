/**
 * NOTIFICACIONES SLACK — MI EMPRESA
 *
 * Envía los mismos resúmenes que el email (matutino + post-cruce) a Slack via Incoming Webhook.
 * Usa Block Kit: logo como miniatura (accessory), filas como texto estructurado (no tablas pipe).
 *
 * Propiedades requeridas en Script Properties:
 *   SLACK_WEBHOOK_URL  → https://hooks.slack.com/services/...
 *   LOGO_FILE_ID       → ID del PNG del logo en Google Drive (debe ser público)
 *
 * Si SLACK_WEBHOOK_URL no está configurado, las funciones se saltean sin error.
 */

/** URL pública del logo desde LOGO_FILE_ID. */
function _slackLogoUrl_() {
  var id = PropertiesService.getScriptProperties().getProperty('LOGO_FILE_ID') || '';
  return id ? 'https://drive.google.com/uc?export=view&id=' + id : '';
}

/** Envía un payload de Block Kit al webhook. Silencioso si no hay URL configurada.
 *  icon_url: usa el logo de Drive como avatar de la app (el círculo junto al nombre).
 */
function _slackEnviar_(bloques) {
  var url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL') || '';
  if (!url) { Logger.log('Slack: SLACK_WEBHOOK_URL no configurado, se omite.'); return; }
  var payload = { blocks: bloques };
  var logoUrl = _slackLogoUrl_();
  if (logoUrl) payload.icon_url = logoUrl;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Slack error: ' + e.message);
  }
}

/**
 * Fecha en español: "miércoles 01/07/2026".
 * Utilities.formatDate devuelve día en inglés (JVM locale), así que lo mapeamos.
 */
function _slackFecha_(fecha) {
  var dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var d = (fecha instanceof Date) ? fecha : new Date();
  return dias[d.getDay()] + ' ' + Utilities.formatDate(d, 'America/Santiago', 'dd/MM/yyyy');
}

/**
 * Cabecera: título + fecha. El logo va como avatar de la app (icon_url en _slackEnviar_),
 * no dentro del mensaje.
 */
function _slackHdr_(titulo, fecha) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*' + titulo.toUpperCase() + '*\n' + fecha }
    },
    { type: 'divider' }
  ];
}

/** Pie institucional. */
function _slackFtr_() {
  return [{
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Mi Empresa · Seguimiento de cotizaciones' }]
  }];
}

/**
 * Formatea filas como texto legible (no tablas pipe — Slack no las soporta).
 * Resultado: "• *52501*  ·  María González  ·  Empresa Demo  ·  $450.000"
 * Máx. 15 filas visibles.
 */
function _slackFilas_(filas) {
  var MAX = 15;
  var extra = filas.length > MAX ? filas.length - MAX : 0;
  var lineas = filas.slice(0, MAX).map(function(f) {
    var celdas = f.map(String);
    // Primera celda en negrita (N° cotización), resto separado por ·
    return '• *' + celdas[0] + '*  ·  ' + celdas.slice(1).join('  ·  ');
  });
  if (extra) lineas.push('_... y ' + extra + ' más_');
  return lineas.join('\n');
}

/**
 * Sección con etiqueta + contador + contenido.
 * Si hay filas: texto formateado. Si no: texto vacío.
 */
function _slackSeccion_(label, count, filas, textoVacio) {
  var bloques = [];
  bloques.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*' + label.toUpperCase() + '*  ·  ' + count }
  });
  if (filas && filas.length) {
    bloques.push({
      type: 'section',
      text: { type: 'mrkdwn', text: _slackFilas_(filas) }
    });
  } else {
    bloques.push({
      type: 'section',
      text: { type: 'mrkdwn', text: textoVacio || '_Ninguna_' }
    });
  }
  bloques.push({ type: 'divider' });
  return bloques;
}

/**
 * Resumen matutino a Slack.
 * Llamado desde enviarResumenMatutino() con los mismos datos que el email.
 */
function _slackResumenMatutino_(fecha, porProcesar, recordatorios, cierres) {
  var bloques = [];

  _slackHdr_('Resumen del dia', _slackFecha_(new Date())).forEach(function(b) { bloques.push(b); });

  _slackSeccion_(
    'Por procesar', porProcesar.length,
    porProcesar.map(function(r) { return [r.num, r.cli, r.emp, _mFmt_(r.monto)]; })
  ).forEach(function(b) { bloques.push(b); });

  _slackSeccion_(
    'Recordatorios hoy', recordatorios.length,
    recordatorios.map(function(r) { return [r.num, r.cli, r.emp, r.tipo, _mFmt_(r.monto)]; })
  ).forEach(function(b) { bloques.push(b); });

  _slackSeccion_(
    'Cierres hoy', cierres.length,
    cierres.map(function(r) { return [r.num, r.cli, r.emp, _mFmt_(r.monto)]; })
  ).forEach(function(b) { bloques.push(b); });

  _slackFtr_().forEach(function(b) { bloques.push(b); });

  _slackEnviar_(bloques);
  Logger.log('Slack matutino enviado.');
}

/**
 * Resumen post-cruce a Slack.
 * Llamado desde enviarResumenPostCruce() con los mismos datos que el email.
 */
function _slackResumenPostCruce_(fecha, movidos, aRevision, nPorProcesar) {
  var bloques = [];

  _slackHdr_('Cruce de pedidos', _slackFecha_(new Date())).forEach(function(b) { bloques.push(b); });

  _slackSeccion_(
    'Deals movidos', movidos.length,
    movidos.map(function(m) { return [m.num, m.empresa, _mFmt_(m.monto), m.estado]; })
  ).forEach(function(b) { bloques.push(b); });

  _slackSeccion_(
    'A revision manual', aRevision, [],
    aRevision > 0
      ? '_Revisar pestaña "Revision manual" — escribe "Crear deal" en las que quieras procesar._'
      : '_Ninguna_'
  ).forEach(function(b) { bloques.push(b); });

  _slackSeccion_(
    'Por procesar en panel', nPorProcesar, [],
    nPorProcesar > 0
      ? '_Quedan cotizaciones nuevas sin aprobar en el panel._'
      : '_Todo procesado._'
  ).forEach(function(b) { bloques.push(b); });

  _slackFtr_().forEach(function(b) { bloques.push(b); });

  _slackEnviar_(bloques);
  Logger.log('Slack post-cruce enviado.');
}

/**
 * TEST RÁPIDO: envía un resumen matutino de muestra a Slack.
 * Correr desde el editor de Apps Script para verificar diseño y logo.
 * No afecta la caché ni envía emails.
 */
function testSlackAhora() {
  var porProcesar  = [
    { num: '52501', cli: 'María González', emp: 'Empresa Demo', monto: 450000 },
    { num: '52502', cli: 'Juan Pérez',     emp: 'Cliente Test', monto: 128000 }
  ];
  var recordatorios = [
    { num: '52480', cli: 'Ana Martínez', emp: 'Corp Demo', monto: 890000, tipo: 'Recordatorio día 3' }
  ];
  var cierres = [];
  _slackResumenMatutino_(null, porProcesar, recordatorios, cierres);
  Logger.log('Test Slack enviado.');
}
