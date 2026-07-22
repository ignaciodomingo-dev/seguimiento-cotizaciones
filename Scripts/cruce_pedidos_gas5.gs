/****************************************************
 * CRUCE DE PEDIDOS (GAS #5)
 *
 * Cruza la pestaña "Pedidos" (CSV pegado a diario, 30 días) contra
 * "Cotizaciones Vendedor" por N° de cotización (Origen = "COT#####"), y según
 * el Estado del pedido mueve el deal de HubSpot a la etapa que corresponda.
 *
 * Lo que no calza limpio (cotización sin deal, COT no encontrada, doble
 * conversión, estado desconocido) se registra en la pestaña "Revisión manual".
 * Desde ahí, escribiendo "Crear deal" en la col Acción, procesarRevisionManual()
 * crea el deal a mano.
 *
 * Reutiliza normalizar_() (de fuente_bsale_descarga.gs).
 ****************************************************/

const CONFIG_CRUCE = {
  HOJA_COT: 'Cotizaciones Vendedor',
  HOJA_PEDIDOS: 'Pedidos',
  HOJA_REVISION: 'Revisión manual',
  URL_DEALS: 'https://api.hubapi.com/crm/v3/objects/deals/',
  URL_CONTACTS: 'https://api.hubapi.com/crm/v3/objects/contacts',

  OWNER_ID: HS_OWNER_ID,
  PIPELINE: 'default',
  CATEGORIA_CLIENTE: HS_CATEGORIA_CLIENTE,

  // Etapas HubSpot (pipeline "Cliente cartera")
  STAGE_PEDIDO_INGRESADO: 'contractsent',
  STAGE_VENTA_EXITOSA: 'STAGE_VENTA_EXITOSA',
  STAGE_VENTA_PERDIDA: 'STAGE_NEGOCIO_PERDIDO',

  // Índices de columnas (0-based)
  // "Cotizaciones Vendedor"
  COT_NUM: 2, COT_EMPRESA: 4, COT_CLIENTE: 5, COT_EMAIL: 7, COT_MONTO: 12,
  COT_ESTADO: 15, COT_DEALID: 16, COT_NPEDIDO: 21, // col V (nueva)
  // "Pedidos"
  PED_NPEDIDO: 1, PED_EMPRESA: 3, PED_CONTACTO: 5, PED_EMAIL: 6,
  PED_TOTAL: 10, PED_ORIGEN: 14, PED_ESTADO: 18
};

const HEADERS_REVISION = [
  'Fecha proceso', 'N° Pedido', 'COT', 'Cliente', 'Empresa', 'Email',
  'Monto', 'Estado pedido', 'Motivo', 'Acción', 'Resultado'
];

/**
 * Mapea el Estado del pedido (col S) a {stage, status}.
 * Devuelve null si no corresponde mover (Pendiente de Pago o estado desconocido).
 */
function etapaParaEstadoPedido_(estadoPedido) {
  var e = normalizar_(estadoPedido);
  // status = etiqueta EXACTA de la etapa de HubSpot (debe coincidir con ETAPAS_HS).
  if (e === 'completado') return { stage: CONFIG_CRUCE.STAGE_VENTA_EXITOSA, status: 'Venta Exitosa' };
  if (e === 'anulado')    return { stage: CONFIG_CRUCE.STAGE_VENTA_PERDIDA, status: 'Negocio perdido' };
  if (['pagado', 'en preparacion', 'listo para logistica', 'listo para retiro', 'en transito'].indexOf(e) !== -1) {
    return { stage: CONFIG_CRUCE.STAGE_PEDIDO_INGRESADO, status: 'Pedido ingresado' };
  }
  return null; // 'pendiente de pago' o desconocido → no mueve
}

// cotizacionesConPedido_ → núcleo (_config_ids.gs).

/****************************************************
 * FUNCIÓN PRINCIPAL (trigger diario 10:00)
 ****************************************************/
function cruzarPedidos() {
 try {
  var ss = getWorkSS();
  var hojaCot = ss.getSheetByName(CONFIG_CRUCE.HOJA_COT);
  var hojaPed = ss.getSheetByName(CONFIG_CRUCE.HOJA_PEDIDOS);
  if (!hojaCot || !hojaPed) {
    Logger.log(' Falta la pestaña "' + CONFIG_CRUCE.HOJA_COT + '" o "' + CONFIG_CRUCE.HOJA_PEDIDOS + '".');
    return;
  }
  asegurarColumnaNPedido_(hojaCot);
  var hojaRev = obtenerOCrearHojaRevision_(ss);

  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) throw new Error('Falta HUBSPOT_TOKEN.');

  // 1) Índice de cotizaciones por N° (col C)
  var ultCot = hojaCot.getLastRow();
  var idxCot = {};
  if (ultCot >= 2) {
    var datosCot = hojaCot.getRange(2, 1, ultCot - 1, 22).getValues();
    datosCot.forEach(function(f, i) {
      var num = String(f[CONFIG_CRUCE.COT_NUM]).trim();
      if (num) idxCot[num] = { fila: f, rowIndex: i + 2 };
    });
  }

  // 2) N° de pedidos ya registrados en "Revisión manual" (para no duplicar log)
  var pedidosEnRevision = clavesRevision_(hojaRev);

  // 3) Recorrer pedidos
  var ultPed = hojaPed.getLastRow();
  if (ultPed < 2) { Logger.log('Pestaña "Pedidos" sin datos.'); return; }
  var datosPed = hojaPed.getRange(2, 1, ultPed - 1, 19).getValues();

  var dealsGanados = {}; // dealId → N° cot que ya lo movió en esta corrida (detecta doble)
  var movidos = 0, aRevision = 0, ignorados = 0, pendientes = 0;
  var resultado = { movidos: [], aRevision: 0 }; // datos para el resumen post-cruce

  datosPed.forEach(function(p) {
    var origen = String(p[CONFIG_CRUCE.PED_ORIGEN] || '').trim().toUpperCase();
    if (origen.indexOf('COT') !== 0) return; // CHK u otros → ignora

    var numCot = origen.replace(/\D/g, '').replace(/^0+/, ''); // "COT051691" → "51691"
    if (!numCot) return;

    var nPedido = String(p[CONFIG_CRUCE.PED_NPEDIDO] || '').trim();
    var estadoPed = String(p[CONFIG_CRUCE.PED_ESTADO] || '').trim();
    var mapeo = etapaParaEstadoPedido_(estadoPed);

    var match = idxCot[numCot];

    // COT que no está en TU hoja = otro vendedor (o cotización no cargada) → ignorar en silencio.
    if (!match) { ignorados++; return; }

    // Pendiente de Pago → FUERA del cruce. Si tiene deal, el flujo normal lo cierra
    // (mails + día 8) y lo reabre si luego paga; si no tiene deal, no nos interesa.
    if (normalizar_(estadoPed) === 'pendiente de pago') { pendientes++; return; }

    // --- Casos a Revisión manual (accionables) ---
    if (!String(match.fila[CONFIG_CRUCE.COT_DEALID]).trim()) {
      aRevision += logRevision_(hojaRev, pedidosEnRevision, p, numCot, 'Cotización sin deal (<$100k o archivada)');
      return;
    }
    if (!mapeo) {
      aRevision += logRevision_(hojaRev, pedidosEnRevision, p, numCot, 'Estado de pedido desconocido: ' + estadoPed);
      return;
    }

    var dealId = String(match.fila[CONFIG_CRUCE.COT_DEALID]).trim();

    // Doble conversión: el deal ya fue movido por OTRA cotización en esta corrida
    if (dealsGanados[dealId] && dealsGanados[dealId] !== numCot) {
      aRevision += logRevision_(hojaRev, pedidosEnRevision, p, numCot,
        'Doble conversión: el deal ya lo movió la cotización ' + dealsGanados[dealId]);
      return;
    }

    // Idempotencia: si la fila ya está en el estado objetivo, no hace nada
    if (String(match.fila[CONFIG_CRUCE.COT_ESTADO]).trim() === mapeo.status) {
      dealsGanados[dealId] = numCot;
      return;
    }

    // Anti-retroceso: nunca degradar a un estado de menor jerarquía
    var PRIO_ETAPA = { 'Cotizando': 0, 'Pedido ingresado': 1, 'Venta Exitosa': 2, 'Negocio perdido': 2 };
    var estadoActual = String(match.fila[CONFIG_CRUCE.COT_ESTADO]).trim();
    var prioActual = PRIO_ETAPA[estadoActual] !== undefined ? PRIO_ETAPA[estadoActual] : 0;
    var prioNuevo  = PRIO_ETAPA[mapeo.status]  !== undefined ? PRIO_ETAPA[mapeo.status]  : 0;
    if (prioNuevo <= prioActual) {
      Logger.log(' COT ' + numCot + ': omitido (retroceso de "' + estadoActual + '" → "' + mapeo.status + '")');
      dealsGanados[dealId] = numCot;
      return;
    }

    // Mover el deal + actualizar a la cotización que realmente convirtió
    var monto = Number(match.fila[CONFIG_CRUCE.COT_MONTO]) || 0;
    var empresa = String(match.fila[CONFIG_CRUCE.COT_EMPRESA] || '').trim();
    var ok = moverDealConPedido_(dealId, mapeo.stage, numCot, monto, nPedido, empresa, token);
    if (ok) {
      hojaCot.getRange(match.rowIndex, CONFIG_CRUCE.COT_ESTADO + 1).setValue(mapeo.status); // col P
      hojaCot.getRange(match.rowIndex, CONFIG_CRUCE.COT_NPEDIDO + 1).setValue(nPedido);     // col V
      dealsGanados[dealId] = numCot;
      movidos++;
      resultado.movidos.push({ num: numCot, empresa: empresa, monto: monto, estado: mapeo.status });
      Logger.log(' COT ' + numCot + ' → ' + mapeo.status + ' (deal ' + dealId + ', pedido ' + nPedido + ')');
    }
  });

  Logger.log('Cruce terminado. Deals movidos: ' + movidos +
    ' | A revisión manual: ' + aRevision +
    ' | Pendiente de pago (fuera): ' + pendientes +
    ' | Ignorados (otros vendedores / no encontrados): ' + ignorados);

  // Envía el resumen post-cruce con los datos de lo que se movió.
  resultado.aRevision = aRevision;
  try { enviarResumenPostCruce(resultado); } catch (e2) { alertarError_('resumen post-cruce', e2.message); }

 } catch (e) {
   alertarError_('cruce de pedidos', e.message);
   throw e;
 }
}

/**
 * PATCH del deal: etapa + N°/monto de la cotización que convirtió + agrega N° pedido
 * a la descripción (sin borrar lo que haya).
 */
function moverDealConPedido_(dealId, stage, numCot, monto, nPedido, empresa, token) {
  try {
    var headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

    var resGet = UrlFetchApp.fetch(CONFIG_CRUCE.URL_DEALS + dealId + '?properties=description',
      { headers: headers, muteHttpExceptions: true });
    var descActual = '';
    if (resGet.getResponseCode() === 200) {
      var props = JSON.parse(resGet.getContentText()).properties || {};
      descActual = props.description || '';
    }
    var linea = 'Pedido N° ' + nPedido;
    var nuevaDesc = !descActual ? linea
      : (descActual.indexOf(linea) !== -1 ? descActual : descActual + '\n' + linea);

    var payload = {
      properties: {
        dealname: (empresa || 'Sin Empresa') + ' - COT ' + numCot,
        dealstage: stage,
        numero_de_cotizacion: String(numCot),
        amount: String(Math.round(monto)),
        description: nuevaDesc
      }
    };
    var res = UrlFetchApp.fetch(CONFIG_CRUCE.URL_DEALS + dealId, {
      method: 'patch', headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('Error moviendo deal ' + dealId + ' (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
      return false;
    }
    return true;
  } catch (e) {
    Logger.log('Error moverDealConPedido_ (' + dealId + '): ' + e.message);
    return false;
  }
}

/****************************************************
 * REVISIÓN MANUAL
 ****************************************************/
function obtenerOCrearHojaRevision_(ss) {
  var hoja = ss.getSheetByName(CONFIG_CRUCE.HOJA_REVISION);
  if (!hoja) {
    hoja = ss.insertSheet(CONFIG_CRUCE.HOJA_REVISION);
    hoja.appendRow(HEADERS_REVISION);
    hoja.getRange(1, 1, 1, HEADERS_REVISION.length).setFontWeight('bold').setBackground('#7f1d1d').setFontColor('#FFFFFF');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

/** Set de N° de pedido ya presentes en "Revisión manual" (col B), para no duplicar. */
function clavesRevision_(hojaRev) {
  var set = {};
  var last = hojaRev.getLastRow();
  if (last < 2) return set;
  hojaRev.getRange(2, 2, last - 1, 1).getValues().forEach(function(r) {
    var k = String(r[0] || '').trim();
    if (k) set[k] = true;
  });
  return set;
}

/** Agrega una fila a "Revisión manual" si ese N° pedido no estaba. Devuelve 1 si agregó, 0 si no. */
function logRevision_(hojaRev, yaRegistrados, pedidoRow, numCot, motivo) {
  var nPedido = String(pedidoRow[CONFIG_CRUCE.PED_NPEDIDO] || '').trim();
  if (nPedido && yaRegistrados[nPedido]) return 0; // ya estaba
  hojaRev.appendRow([
    Utilities.formatDate(new Date(), 'America/Santiago', 'dd/MM/yyyy HH:mm'),
    nPedido,
    numCot,
    String(pedidoRow[CONFIG_CRUCE.PED_CONTACTO] || ''),
    String(pedidoRow[CONFIG_CRUCE.PED_EMPRESA] || ''),
    String(pedidoRow[CONFIG_CRUCE.PED_EMAIL] || ''),
    Number(pedidoRow[CONFIG_CRUCE.PED_TOTAL]) || 0,
    String(pedidoRow[CONFIG_CRUCE.PED_ESTADO] || ''),
    motivo,
    '', ''
  ]);
  if (nPedido) yaRegistrados[nPedido] = true;
  return 1;
}

/**
 * Procesa "Revisión manual": filas con Acción = "Crear deal" y Resultado vacío.
 * Crea contacto + deal en HubSpot en la etapa que corresponde al Estado del pedido,
 * agrega el N° pedido a la descripción, y escribe el Deal ID en la col Resultado.
 * Ejecutar a mano cuando hayas marcado filas, o por trigger.
 */
function procesarRevisionManual() {
  var ss = getWorkSS();
  var hojaRev = ss.getSheetByName(CONFIG_CRUCE.HOJA_REVISION);
  if (!hojaRev) { Logger.log('No existe "Revisión manual".'); return; }

  var last = hojaRev.getLastRow();
  if (last < 2) return;

  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) throw new Error('Falta HUBSPOT_TOKEN.');

  // Índice de cotizaciones por N° (para enganchar el deal creado a su fila).
  var hojaCot = ss.getSheetByName(CONFIG_CRUCE.HOJA_COT);
  var idxCot = {};
  var ultCot = hojaCot ? hojaCot.getLastRow() : 0;
  if (ultCot >= 2) {
    hojaCot.getRange(2, 1, ultCot - 1, 22).getValues().forEach(function(f, i) {
      var num = String(f[CONFIG_CRUCE.COT_NUM]).trim();
      if (num) idxCot[num] = i + 2; // rowIndex
    });
  }

  var datos = hojaRev.getRange(2, 1, last - 1, HEADERS_REVISION.length).getValues();
  var creados = 0;

  datos.forEach(function(r, i) {
    var accion = normalizar_(r[9]);   // col J
    var resultado = String(r[10] || '').trim(); // col K
    if (resultado) return; // ya procesada

    // Descartar: marcar "Ignorar" / "Descartar" en Acción → queda como registro inerte.
    if (accion === 'ignorar' || accion === 'descartar') {
      hojaRev.getRange(i + 2, 11).setValue('Ignorado');
      return;
    }
    if (accion !== 'crear deal') return;

    var nPedido = String(r[1] || '').trim();
    var numCot = String(r[2] || '').trim();
    var cliente = String(r[3] || '').trim();
    var empresa = String(r[4] || '').trim();
    var email = String(r[5] || '').trim();
    var monto = Number(r[6]) || 0;
    var estadoPed = String(r[7] || '').trim();
    var mapeo = etapaParaEstadoPedido_(estadoPed) || { stage: CONFIG_CRUCE.STAGE_PEDIDO_INGRESADO, status: 'Pedido ingresado' };

    try {
      if (!email) throw new Error('Sin email');
      var contactoId = buscarOCrearContacto_(email, cliente, empresa, token);
      var dealId = crearDealManual_(empresa, numCot, monto, mapeo.stage, contactoId, nPedido, token);
      // Engancha el deal a la fila de la cotización → los cruces futuros lo siguen avanzando solos.
      var enganchado = engancharDealAFila_(hojaCot, idxCot, numCot, dealId, mapeo.status, nPedido);
      hojaRev.getRange(i + 2, 11).setValue('Deal ' + dealId + (enganchado ? ' creado y enganchado' : ' creado (cotización no estaba en la hoja)'));
      creados++;
    } catch (e) {
      hojaRev.getRange(i + 2, 11).setValue('Error: ' + e.message);
    }
  });

  Logger.log('Revisión manual procesada. Deals creados: ' + creados);
}

// buscarOCrearContacto_ (unificado) → núcleo (_config_ids.gs).

function crearDealManual_(empresa, numCot, monto, stage, contactoId, nPedido, token) {
  var headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  var payload = {
    properties: {
      dealname: (empresa || 'Sin Empresa') + ' - COT ' + numCot,
      amount: String(Math.round(monto)),
      pipeline: CONFIG_CRUCE.PIPELINE,
      dealstage: stage,
      hubspot_owner_id: CONFIG_CRUCE.OWNER_ID,
      numero_de_cotizacion: String(numCot),
      categoria_de_cliente: CONFIG_CRUCE.CATEGORIA_CLIENTE,
      description: 'Pedido N° ' + nPedido + ' (creado desde revisión manual)'
    },
    associations: contactoId ? [{
      to: { id: contactoId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
    }] : []
  };
  var res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/deals', {
    method: 'post', headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 201) throw new Error('No se pudo crear deal (HTTP ' + res.getResponseCode() + ')');
  return JSON.parse(res.getContentText()).id;
}

/** Escribe Deal ID + estado + N° pedido en la fila de la cotización (si existe en la hoja). */
function engancharDealAFila_(hojaCot, idxCot, numCot, dealId, status, nPedido) {
  if (!hojaCot) return false;
  var rowIndex = idxCot[String(numCot).trim()];
  if (!rowIndex) return false;
  hojaCot.getRange(rowIndex, CONFIG_CRUCE.COT_ESTADO + 1).setValue(status);   // col P (Etapa)
  hojaCot.getRange(rowIndex, CONFIG_CRUCE.COT_DEALID + 1).setValue(dealId);   // col Q
  hojaCot.getRange(rowIndex, CONFIG_CRUCE.COT_NPEDIDO + 1).setValue(nPedido); // col V
  // Control: SOLO se limpia si era "Excluida"/"Archivada" (reabrir). NUNCA pisar "Respondida"
  // ni "Vinculada" (eso descongelaría un seguimiento pausado a propósito). Bug C2 corregido.
  var ctrlActual = String(hojaCot.getRange(rowIndex, COL_CONTROL + 1).getValue()).trim();
  if (ctrlActual === 'Excluida' || ctrlActual === 'Archivada') {
    hojaCot.getRange(rowIndex, COL_CONTROL + 1).setValue('');
  }
  return true;
}

/** Asegura el encabezado de la col V (N° Pedido) en "Cotizaciones Vendedor". */
function asegurarColumnaNPedido_(hoja) {
  if (!hoja.getRange(1, CONFIG_CRUCE.COT_NPEDIDO + 1).getValue()) {
    hoja.getRange(1, CONFIG_CRUCE.COT_NPEDIDO + 1).setValue('N° Pedido').setFontWeight('bold');
  }
}

// El trigger de cruce (diario 10:00) se crea desde configurarTodosLosTriggers (_triggers.gs).
