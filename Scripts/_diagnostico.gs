/**
 * DIAGNÓSTICO DE SOLO LECTURA (sin efectos secundarios).
 * Cuenta el estado de "Cotizaciones Vendedor" para verificar la transición
 * antes de activar triggers. NO escribe en HubSpot ni envía correos.
 *
 * Lo que importa: "Sin estado" = filas que GAS #1 procesaría creando un deal.
 * Si la copia del sistema viejo trajo los estados, ese número debe ser bajo
 * (solo cotizaciones genuinamente nuevas).
 */
/**
 * ENCIENDE los envíos: pone la Script Property ENVIOS_ACTIVOS = "SI".
 * Equivale a editar la propiedad a mano en Configuración del proyecto.
 * Desde la próxima corrida el sistema puede enviar correos y cerrar deals.
 */
function encenderEnvios() {
  PropertiesService.getScriptProperties().setProperty('ENVIOS_ACTIVOS', 'SI');
  Logger.log('ENVIOS_ACTIVOS = SI — envíos ACTIVADOS. Corre actualizarPanelSeguimiento para verlo en el panel.');
}

/**
 * APAGA los envíos (kill-switch): ENVIOS_ACTIVOS = "NO".
 * Freno de emergencia: no sale ningún correo a clientes ni cierre automático.
 */
function apagarEnvios() {
  PropertiesService.getScriptProperties().setProperty('ENVIOS_ACTIVOS', 'NO');
  Logger.log('ENVIOS_ACTIVOS = NO — envíos APAGADOS (no sale ningún correo ni cierre).');
}

/**
 * Fuerza el consentimiento de TODOS los permisos del proyecto (incluido Gmail)
 * sin efectos secundarios: solo lecturas. Ejecutar una vez antes de los triggers.
 */
function autorizarPermisos() {
  getWorkSS().getName();          // Sheets
  GmailApp.getAliases();          // Gmail (solo lectura, no envía)
  ScriptApp.getProjectTriggers(); // Triggers
  Logger.log(' Permisos autorizados: Sheets, Gmail, Triggers.');
}

/**
 * Lista todas las pipelines de Negocios y sus etapas con el ID interno.
 * Úsalo para conseguir los IDs de "Pedido ingresado", "Venta exitosa", "Venta perdida".
 */
function listarEtapasHubSpot() {
  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) { Logger.log('Falta HUBSPOT_TOKEN.'); return; }

  var res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Error HubSpot (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
    return;
  }

  JSON.parse(res.getContentText()).results.forEach(function(p) {
    Logger.log('━━ PIPELINE: ' + p.label + '  (id: ' + p.id + ')');
    p.stages
      .sort(function(a, b) { return a.displayOrder - b.displayOrder; })
      .forEach(function(s) {
        Logger.log('   • ' + s.label + '   →   id: ' + s.id);
      });
  });
}

function diagnosticoEstadoVendedor() {
  var ss = getWorkSS();
  var hoja = ss.getSheetByName('Cotizaciones Vendedor');
  if (!hoja) {
    Logger.log(' No existe la pestaña "Cotizaciones Vendedor". Revisa el nombre exacto.');
    return;
  }

  var lastRow = hoja.getLastRow();
  if (lastRow < 2) {
    Logger.log('Hoja "Cotizaciones Vendedor" sin datos.');
    return;
  }

  var VENDEDORES = VENDEDORES_VALIDOS_GLOBAL;
  var MONTO_MINIMO = CONFIG_HS.MONTO_MINIMO;

  var datos = hoja.getRange(2, 1, lastRow - 1, 23).getValues();
  var total = datos.length;
  var conDeal = 0, crearianDeal = 0;
  var porEtapa = {}, porControl = {};

  datos.forEach(function(f) {
    var etapa = String(f[COL_ETAPA] || '').trim();      // col P (Etapa)
    var control = String(f[COL_CONTROL] || '').trim();  // col W (Control)
    var dealId = String(f[COL_DEALID] || '').trim();    // col Q (Deal ID)
    if (dealId) conDeal++;
    porEtapa[etapa || '(vacia)'] = (porEtapa[etapa || '(vacia)'] || 0) + 1;
    porControl[control || '(vacio)'] = (porControl[control || '(vacio)'] || 0) + 1;

    // Cotizacion nueva que GAS #1 procesaria: sin Etapa, sin Control y sin Deal ID + criterio.
    if (etapa === '' && control === '' && dealId === '') {
      var vendedor = String(f[9] || '').trim();
      if (VENDEDORES.indexOf(vendedor) !== -1 && Number(f[12]) > MONTO_MINIMO) crearianDeal++;
    }
  });

  Logger.log('Diagnostico "Cotizaciones Vendedor" (solo lectura)');
  Logger.log('Filas: ' + total + ' | con Deal ID: ' + conDeal);
  Logger.log('GAS #1 crearia deal a: ' + crearianDeal +
    ' (sin Etapa/Control/Deal + vendedor + monto > $' + MONTO_MINIMO.toLocaleString('es-CL') + ')');
  Logger.log('Por Etapa: ' + JSON.stringify(porEtapa, null, 2));
  Logger.log('Por Control: ' + JSON.stringify(porControl, null, 2));
}
