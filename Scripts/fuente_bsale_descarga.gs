/****************************************************
 * FUENTE BSALE — DESCARGA DE COTIZACIONES (Fase 2)
 *
 * Adaptado del Código.gs original del analista para correr en TU proyecto
 * standalone privado. Cambios respecto al original:
 *   - Escribe en TU planilla privada vía getWorkSS() (no getActiveSpreadsheet()).
 *   - El token va en Propiedades del Script (BSALE_TOKEN), NUNCA hardcodeado.
 *   - Sin menú onOpen (un proyecto standalone no tiene planilla contenedora).
 *
 * Llena "Cotizaciones Bsale" + "Cotizaciones Bsale Detalle" en tu planilla.
 * Luego GAS #0 (filtro) las lee desde ahí mismo (SOURCE_SS_ID = WORK_SS_ID).
 *
 * CONFIGURACIÓN: en Propiedades del Script añade BSALE_TOKEN = <tu token Bsale>.
 ****************************************************/

const BSALE_COT_CONFIG = {
  TOKEN_PROPERTY: 'BSALE_TOKEN',

  SHEET_HEADER: 'Cotizaciones Bsale',
  SHEET_DETAIL: 'Cotizaciones Bsale Detalle',

  DIAS_REVISION: 30,   // ventana del descargador COMPLETO (1×/día)
  DIAS_RAPIDO: 3,      // ventana del descargador RÁPIDO (cada 15 min)
  CARGAR_DETALLE: true,
  // Baja el detalle (1 llamada API por cotización) SOLO de tus cotizaciones.
  // El detalle de otros vendedores hoy no lo usa nadie y dispararía el límite
  // de 6 min del trigger. Pon false el día que el rollout multi-vendedor lo use.
  DETALLE_SOLO_MIS: true,
  EXIGIR_SKU_REAL: true,

  // false = baja TODAS las cotizaciones (todos los vendedores) a "Cotizaciones Bsale".
  // GAS #0 igual filtra solo las tuyas hacia "Cotizaciones Vendedor".
  // (Pon true si alguna vez quieres bajar solo las tuyas.)
  SOLO_MIS_COTIZACIONES: false,
  VENDEDORES_VALIDOS: VENDEDORES_VALIDOS_GLOBAL,

  LIMIT: 50,
  TZ: 'America/Santiago'
};

const HEADERS_COTIZACIONES = [
  'Fecha Emisión',
  'Fecha y Hora Cotización',
  'Numero Cotización',
  'Tracking Number',
  'Nombre Empresa',
  'Nombre Cliente',
  'Cliente RUT',
  'Email Cliente',
  'Sucursal',
  'Vendedor',
  'Monto Neto',
  'IVA',
  'Monto Total',
  'Estado',
  'Clave Técnica Bsale'
];

const HEADERS_COTIZACIONES_DETALLE = [
  'Numero Cotización',
  'Tracking Number',
  'SKU',
  'Tipo de Producto',
  'Impresión',
  'Cantidad',
  'Precio Neto Unitario',
  'Precio Bruto Unitario',
  'Total Neto Línea',
  'Total Bruto Línea',
  'Clave Técnica Detalle'
];

var cacheSkuVariantesCotizaciones_ = {};

/****************************************************
 * FUNCIÓN PRINCIPAL (manual o trigger)
 ****************************************************/
/**
 * RÁPIDO (cada 15 min): ventana corta + encadena el pipeline de entrada
 * (filtro → GAS #1 → deal + email) para que el correo salga al poco rato de cotizar.
 */
function sincronizarBsaleRapido() {
  descargarBsale_(BSALE_COT_CONFIG.DIAS_RAPIDO);
  try {
    filtrarCotizacionesVendedor(); // trae las nuevas a "Cotizaciones Vendedor" (quedan "Por procesar"; ya NO crea deals)
  } catch (e) {
    Logger.log('Error encadenando filtro tras descarga rápida: ' + e.message);
  }
}

/** COMPLETO (1×/día): ventana de 30 días para backfill/correcciones. */
function sincronizarBsaleCompleto() {
  descargarBsale_(BSALE_COT_CONFIG.DIAS_REVISION);
}

/**
 * Limpieza mensual: borra filas de más de 60 días de "Cotizaciones Bsale" y
 * "Cotizaciones Bsale Detalle" (volcado crudo, regenerable). NO toca
 * "Cotizaciones Vendedor" — ahí queda tu pipeline y el detalle (col U) para siempre.
 */
function limpiarBsaleViejos() {
  var DIAS = 60;
  var ss = getWorkSS();
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DIAS);
  cutoff.setHours(0, 0, 0, 0);

  // 1) Header: conservar filas con Fecha Emisión (col A) >= cutoff.
  var keptCots = {};
  var borradosH = 0;
  var hH = ss.getSheetByName(BSALE_COT_CONFIG.SHEET_HEADER);
  if (hH && hH.getLastRow() > 1) {
    var nH = HEADERS_COTIZACIONES.length;
    var dataH = hH.getRange(2, 1, hH.getLastRow() - 1, nH).getValues();
    var keepH = dataH.filter(function(r) {
      var f = aFecha_(r[0]);
      var keep = f && f.getTime() >= cutoff.getTime();
      if (keep) keptCots[String(r[2]).trim()] = true; // col C N° Cotización
      return keep;
    });
    borradosH = dataH.length - keepH.length;
    hH.getRange(2, 1, dataH.length, nH).clearContent();
    if (keepH.length) hH.getRange(2, 1, keepH.length, nH).setValues(keepH);
  }

  // 2) Detalle: conservar filas cuyo N° Cot (col A) siga en el header.
  var borradosD = 0;
  var hD = ss.getSheetByName(BSALE_COT_CONFIG.SHEET_DETAIL);
  if (hD && hD.getLastRow() > 1) {
    var nD = HEADERS_COTIZACIONES_DETALLE.length;
    var dataD = hD.getRange(2, 1, hD.getLastRow() - 1, nD).getValues();
    var keepD = dataD.filter(function(r) { return keptCots[String(r[0]).trim()]; });
    borradosD = dataD.length - keepD.length;
    hD.getRange(2, 1, dataD.length, nD).clearContent();
    if (keepD.length) hD.getRange(2, 1, keepD.length, nD).setValues(keepD);
  }

  Logger.log(' Limpieza Bsale (>' + DIAS + ' días): header -' + borradosH + ' | detalle -' + borradosD);
}

/**
 * Núcleo de descarga. diasRevision = ventana hacia atrás (días).
 */
function descargarBsale_(diasRevision) {
  var ss = getWorkSS(); // <-- tu planilla privada (antes: getActiveSpreadsheet())

  var sheetHeader = obtenerOCrearHoja_(ss, BSALE_COT_CONFIG.SHEET_HEADER, HEADERS_COTIZACIONES);
  var sheetDetail = obtenerOCrearHoja_(ss, BSALE_COT_CONFIG.SHEET_DETAIL, HEADERS_COTIZACIONES_DETALLE);

  validarEncabezados_(sheetHeader, HEADERS_COTIZACIONES);
  validarEncabezados_(sheetDetail, HEADERS_COTIZACIONES_DETALLE);

  var clavesHeader = leerClavesExistentes_(sheetHeader, HEADERS_COTIZACIONES.length);
  var clavesDetalle = leerClavesExistentes_(sheetDetail, HEADERS_COTIZACIONES_DETALLE.length);

  var hoy = new Date();
  var desde = new Date(hoy);
  desde.setDate(hoy.getDate() - diasRevision);

  var inicio = unixDia_(desde, 0, 0, 0);
  var fin = unixDia_(hoy, 23, 59, 59);

  Logger.log(' Buscando cotizaciones desde ' +
    Utilities.formatDate(desde, BSALE_COT_CONFIG.TZ, 'dd/MM/yyyy') + ' hasta ' +
    Utilities.formatDate(hoy, BSALE_COT_CONFIG.TZ, 'dd/MM/yyyy'));

  var filasHeader = [];
  var filasDetalle = [];
  var offset = 0;
  var totalProcesados = 0;
  var totalCotizaciones = 0;

  while (true) {
    var url = 'https://api.bsale.io/v1/documents.json'
      + '?emissiondaterange=[' + inicio + ',' + fin + ']'
      + '&expand=%5Bdocument_type,client,office,user,sellers,coin%5D'
      + '&limit=' + BSALE_COT_CONFIG.LIMIT
      + '&offset=' + offset
      + '&state=0';

    Logger.log(' Consultando documents offset ' + offset);

    var data = bsaleGetJson_(url);
    var docs = data.items || [];
    if (!docs.length) break;

    docs.forEach(function(doc) {
      totalProcesados++;
      if (!esCotizacion_(doc)) return;
      if (!esMiCotizacion_(doc)) return; // filtro por vendedor (si está activo)
      totalCotizaciones++;

      var fila = construirFilaCotizacion_(doc);
      var claveHeader = fila[fila.length - 1];
      if (!clavesHeader.has(claveHeader)) {
        filasHeader.push(fila);
        clavesHeader.add(claveHeader);
      }

      var cargarDetalle = BSALE_COT_CONFIG.CARGAR_DETALLE
        && (!BSALE_COT_CONFIG.DETALLE_SOLO_MIS || esVendedorValido_(doc));
      if (cargarDetalle) {
        var detalles = obtenerDetallesCotizacion_(doc);
        detalles.forEach(function(det, index) {
          var filaDet = construirFilaDetalleCotizacion_(doc, det, index);
          var claveDet = filaDet[filaDet.length - 1];
          if (!clavesDetalle.has(claveDet)) {
            filasDetalle.push(filaDet);
            clavesDetalle.add(claveDet);
          }
        });
      }
    });

    offset += BSALE_COT_CONFIG.LIMIT;
    if (offset >= Number(data.count || 0)) break;
    Utilities.sleep(500);
  }

  if (filasHeader.length > 0) {
    sheetHeader.getRange(sheetHeader.getLastRow() + 1, 1, filasHeader.length, HEADERS_COTIZACIONES.length)
      .setValues(filasHeader);
  }
  if (filasDetalle.length > 0) {
    sheetDetail.getRange(sheetDetail.getLastRow() + 1, 1, filasDetalle.length, HEADERS_COTIZACIONES_DETALLE.length)
      .setValues(filasDetalle);
  }

  Logger.log(' Documentos procesados: ' + totalProcesados);
  Logger.log(' Cotizaciones encontradas: ' + totalCotizaciones);
  Logger.log(' Cotizaciones nuevas agregadas: ' + filasHeader.length);
  Logger.log(' Líneas de detalle nuevas agregadas: ' + filasDetalle.length);
}

/****************************************************
 * DIAGNÓSTICO PDF — ejecutar UNA vez para descubrir
 * qué campo trae la URL del PDF de una cotización.
 * Revisa el Log: busca campos tipo urlPdf / urlPublicView / urlTimbre.
 ****************************************************/
function inspeccionarDocumentoCotizacion() {
  var hoy = new Date();
  var desde = new Date(hoy);
  desde.setDate(hoy.getDate() - BSALE_COT_CONFIG.DIAS_REVISION);

  var inicio = unixDia_(desde, 0, 0, 0);
  var fin = unixDia_(hoy, 23, 59, 59);

  var offset = 0;

  // Pagina igual que la sync hasta encontrar la PRIMERA cotización.
  while (true) {
    var url = 'https://api.bsale.io/v1/documents.json'
      + '?emissiondaterange=[' + inicio + ',' + fin + ']'
      + '&expand=%5Bdocument_type,client,office,user,sellers,coin%5D'
      + '&limit=' + BSALE_COT_CONFIG.LIMIT + '&offset=' + offset + '&state=0';

    var data = bsaleGetJson_(url);
    var docs = data.items || [];
    if (!docs.length) break;

    for (var i = 0; i < docs.length; i++) {
      if (esCotizacion_(docs[i])) {
        Logger.log(' JSON COMPLETO de una cotización (busca el campo del PDF):');
        Logger.log(JSON.stringify(docs[i], null, 2));
        // Intento por endpoint directo del documento, por si trae más campos:
        var detalleDoc = bsaleGetJson_('https://api.bsale.io/v1/documents/' + docs[i].id + '.json');
        Logger.log(' JSON del documento por id (campos extra / PDF):');
        Logger.log(JSON.stringify(detalleDoc, null, 2));
        return;
      }
    }

    offset += BSALE_COT_CONFIG.LIMIT;
    if (offset >= Number(data.count || 0)) break;
    Utilities.sleep(300);
  }

  Logger.log('No se encontró ninguna cotización en el rango.');
}

/****************************************************
 * CONSTRUCCIÓN DE FILAS
 ****************************************************/
function construirFilaCotizacion_(doc) {
  var cliente = doc.client || {};
  var nombreEmpresa = cliente.company || '';
  var nombreCliente = [cliente.firstName, cliente.lastName].filter(Boolean).join(' ');
  if (!nombreCliente && nombreEmpresa) nombreCliente = nombreEmpresa;

  var vendedor = obtenerVendedor_(doc);
  var sucursal = doc.office && doc.office.name ? doc.office.name : '';
  var tracking = doc.token || '';
  var numero = doc.number || '';
  var docId = doc.id || tracking || numero;
  var estado = doc.state !== undefined ? String(doc.state) : '';
  var clave = 'COTIZACION||' + String(docId);

  return [
    doc.emissionDate ? formatFecha_(doc.emissionDate) : '',
    doc.generationDate ? formatFechaHora_(doc.generationDate) : '',
    numero,
    tracking,
    nombreEmpresa,
    nombreCliente,
    limpiarRut_(cliente.code || ''),
    cliente.email || '',
    sucursal,
    vendedor,
    numeroSeguro_(doc.netAmount),
    numeroSeguro_(doc.taxAmount),
    numeroSeguro_(doc.totalAmount),
    estado,
    clave
  ];
}

function construirFilaDetalleCotizacion_(doc, det, index) {
  var numero = doc.number || '';
  var tracking = doc.token || '';
  var docId = doc.id || tracking || numero;
  var detalleId = det.id || ('IDX_' + index);

  var textoProducto = det.comment || det.note || det.description || '';
  var infoProducto = separarProductoEImpresion_(textoProducto);
  var sku = obtenerSkuRealCotizacion_(det, textoProducto, infoProducto.tipoProducto);
  var cantidad = numeroSeguro_(det.quantity);

  var precioNetoUnit = numeroSeguro_(det.netUnitValue !== undefined ? det.netUnitValue : 0);
  var precioBrutoUnit = numeroSeguro_(det.totalUnitValue !== undefined ? det.totalUnitValue : det.unitValue);
  var totalNetoLinea = numeroSeguro_(det.netAmount !== undefined ? det.netAmount : precioNetoUnit * cantidad);
  var totalBrutoLinea = numeroSeguro_(det.totalAmount !== undefined ? det.totalAmount : precioBrutoUnit * cantidad);

  var claveDetalle = 'COTIZACION_DETALLE||' + String(docId) + '||' + String(detalleId);

  return [
    numero, tracking, sku,
    infoProducto.tipoProducto, infoProducto.impresion, cantidad,
    precioNetoUnit, precioBrutoUnit, totalNetoLinea, totalBrutoLinea,
    claveDetalle
  ];
}

/****************************************************
 * DETALLES DE COTIZACIÓN
 ****************************************************/
function obtenerDetallesCotizacion_(doc) {
  var docId = doc.id;
  if (!docId) throw new Error(' Cotización sin doc.id. No se puede obtener detalle sin riesgo de datos incompletos.');

  var detalles = [];
  var offset = 0;
  var limit = 50;

  while (true) {
    var url = 'https://api.bsale.io/v1/documents/' + docId + '/details.json'
      + '?expand=%5Bvariant%5D&limit=' + limit + '&offset=' + offset;

    Logger.log(' Consultando detalle cotización doc.id=' + docId + ' offset=' + offset);

    var data = bsaleGetJson_(url);
    var items = data.items || [];
    items.forEach(function(item) { detalles.push(item); });
    if (!items.length) break;

    offset += limit;
    if (offset >= Number(data.count || 0)) break;
    Utilities.sleep(300);
  }
  return detalles;
}

/****************************************************
 * FILTRO COTIZACIÓN
 ****************************************************/
function esCotizacion_(doc) {
  var tipo = doc.document_type && doc.document_type.name ? normalizar_(doc.document_type.name) : '';
  return tipo.indexOf('cotizacion') !== -1;
}

/**
 * True si la cotización es de un vendedor válido (o si el filtro está apagado).
 * Compara normalizado para tolerar tildes/espacios.
 */
function esMiCotizacion_(doc) {
  if (!BSALE_COT_CONFIG.SOLO_MIS_COTIZACIONES) return true;
  return esVendedorValido_(doc);
}

/** True si el vendedor de la cotización está en VENDEDORES_VALIDOS (normalizado). */
function esVendedorValido_(doc) {
  var vendedor = normalizar_(obtenerVendedor_(doc));
  return BSALE_COT_CONFIG.VENDEDORES_VALIDOS.some(function(v) {
    return normalizar_(v) === vendedor;
  });
}

/****************************************************
 * SKU / PRODUCTO / IMPRESIÓN
 ****************************************************/
function obtenerSkuRealCotizacion_(det, textoProducto, tipoProducto) {
  var codigoDetalle = String(det.code || '').trim();
  if (codigoDetalle) return limpiarEtiquetaProducto_(codigoDetalle);

  if (det.variant && det.variant.code) {
    var skuExpandido = String(det.variant.code || '').trim();
    if (skuExpandido) return limpiarEtiquetaProducto_(skuExpandido);
  }

  if (det.variant && det.variant.id) {
    var variantId = String(det.variant.id);
    if (cacheSkuVariantesCotizaciones_[variantId]) return cacheSkuVariantesCotizaciones_[variantId];

    var url = 'https://api.bsale.io/v1/variants/' + variantId + '.json';
    Logger.log(' Buscando SKU real variante id=' + variantId);

    var variante = bsaleGetJson_(url);
    var skuVariante = String(variante.code || '').trim();
    if (skuVariante) {
      cacheSkuVariantesCotizaciones_[variantId] = limpiarEtiquetaProducto_(skuVariante);
      Utilities.sleep(200);
      return cacheSkuVariantesCotizaciones_[variantId];
    }

    if (BSALE_COT_CONFIG.EXIGIR_SKU_REAL) {
      throw new Error(' Variante sin SKU real. variant.id=' + variantId +
        ' | Texto producto: ' + String(textoProducto || '').slice(0, 150));
    }
  }

  var fallback = extraerSkuCotizacionFallback_(textoProducto, tipoProducto);
  if (BSALE_COT_CONFIG.EXIGIR_SKU_REAL) {
    throw new Error(' No se pudo obtener SKU real desde det.code ni desde variante. ' +
      'No se cargan datos para evitar SKU incompleto. Fallback detectado: ' + fallback +
      ' | Texto producto: ' + String(textoProducto || '').slice(0, 150));
  }

  Logger.log(' SKU no disponible desde det.code ni variante. Se usa fallback descriptivo: ' + fallback);
  return fallback;
}

function separarProductoEImpresion_(texto) {
  var limpio = String(texto || '').trim();
  if (!limpio) return { tipoProducto: '', impresion: '' };

  var lineas = limpio.split(/\r?\n/).map(function(l) { return String(l || '').trim(); }).filter(Boolean);
  if (!lineas.length) return { tipoProducto: '', impresion: '' };

  var tipoProducto = limpiarEtiquetaProducto_(lineas[0]);
  var impresion = '';

  var idxPersonalizacion = lineas.findIndex(function(l) {
    return normalizar_(l).indexOf('personalizacion') !== -1;
  });

  if (idxPersonalizacion !== -1) {
    impresion = lineas.slice(idxPersonalizacion + 1)
      .map(function(l) { return limpiarTextoImpresion_(l); }).filter(Boolean).join(' | ');
  } else {
    var posiblesImpresion = lineas.slice(1).filter(function(l) {
      var n = normalizar_(l);
      return n.indexOf('serigrafia') !== -1 || n.indexOf('color') !== -1 || n.indexOf('lado') !== -1
        || n.indexOf('impresion') !== -1 || n.indexOf('bordado') !== -1 || n.indexOf('dtf') !== -1
        || n.indexOf('uv') !== -1 || n.indexOf('tampografia') !== -1 || n.indexOf('laser') !== -1;
    });
    impresion = posiblesImpresion.map(function(l) { return limpiarTextoImpresion_(l); }).filter(Boolean).join(' | ');
  }

  return { tipoProducto: tipoProducto, impresion: impresion };
}

function extraerSkuCotizacionFallback_(textoProducto, tipoProducto) {
  var texto = String(textoProducto || '').trim();
  if (!texto) return limpiarEtiquetaProducto_(tipoProducto || '');

  var lineas = texto.split(/\r?\n/).map(function(l) { return String(l || '').trim(); }).filter(Boolean);
  if (!lineas.length) return limpiarEtiquetaProducto_(tipoProducto || '');

  return limpiarEtiquetaProducto_(lineas[0]);
}

function limpiarEtiquetaProducto_(texto) {
  return String(texto || '')
    .replace(/^sku\s*:/i, '').replace(/^modelo\s*:/i, '')
    .replace(/^producto\s*:/i, '').replace(/^tipo\s*de\s*producto\s*:/i, '').trim();
}

function limpiarTextoImpresion_(texto) {
  return String(texto || '')
    .replace(/^personalizaci[oó]n\s*:/i, '').replace(/^impresi[oó]n\s*:/i, '').trim();
}

/****************************************************
 * HELPERS SHEETS
 ****************************************************/
function obtenerOCrearHoja_(ss, nombre, headers) {
  var sheet = ss.getSheetByName(nombre);
  if (!sheet) {
    sheet = ss.insertSheet(nombre);
    prepararHoja_(sheet, headers);
    return sheet;
  }
  if (sheet.getLastRow() === 0) prepararHoja_(sheet, headers);
  return sheet;
}

function prepararHoja_(sheet, headers) {
  sheet.clearContents();
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#1F3864').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  Logger.log(' Hoja preparada: ' + sheet.getName());
}

function validarEncabezados_(sheet, headersEsperados) {
  var actuales = sheet.getRange(1, 1, 1, headersEsperados.length).getValues()[0];
  var problemas = [];
  for (var i = 0; i < headersEsperados.length; i++) {
    if (String(actuales[i] || '').trim() !== headersEsperados[i]) {
      problemas.push('Columna ' + (i + 1) + ': esperado "' + headersEsperados[i] +
        '", encontrado "' + actuales[i] + '"');
    }
  }
  if (problemas.length > 0) {
    throw new Error(' Encabezados incorrectos en "' + sheet.getName() +
      '". No se continúa para evitar romper estructura. Detalle: ' + problemas.join(' | '));
  }
}

function leerClavesExistentes_(sheet, columnaClave) {
  var set = new Set();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return set;

  var valores = sheet.getRange(2, columnaClave, lastRow - 1, 1).getValues();
  valores.forEach(function(row) {
    var clave = String(row[0] || '').trim();
    if (clave) set.add(clave);
  });
  return set;
}

/****************************************************
 * HELPERS BSALE
 ****************************************************/
function bsaleGetJson_(url) {
  var token = PropertiesService.getScriptProperties().getProperty(BSALE_COT_CONFIG.TOKEN_PROPERTY);
  if (!token) throw new Error(' No existe token guardado. Configura BSALE_TOKEN en Propiedades del Script.');

  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { access_token: token },
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    throw new Error(' Error API Bsale HTTP ' + code + ' | Endpoint: ' + url + ' | Respuesta: ' + body);
  }
  return JSON.parse(body);
}

/****************************************************
 * HELPERS GENERALES
 ****************************************************/
function obtenerVendedor_(doc) {
  if (doc.sellers && doc.sellers.items && doc.sellers.items.length > 0) {
    var s = doc.sellers.items[0];
    return [s.firstName, s.lastName].filter(Boolean).join(' ');
  }
  if (doc.user) {
    return [doc.user.firstName, doc.user.lastName].filter(Boolean).join(' ');
  }
  return '';
}

function numeroSeguro_(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;
  var n = Number(valor);
  return isNaN(n) ? 0 : n;
}

function limpiarRut_(rut) {
  return String(rut || '').replace(/[.\-]/g, '').toLowerCase().trim();
}

// normalizar_ → núcleo (_config_ids.gs).

function unixDia_(fecha, h, m, s) {
  return Math.floor(new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), h, m, s).getTime() / 1000);
}

function formatFecha_(unix) {
  return Utilities.formatDate(new Date(unix * 1000), BSALE_COT_CONFIG.TZ, 'dd/MM/yyyy');
}

function formatFechaHora_(unix) {
  return Utilities.formatDate(new Date(unix * 1000), BSALE_COT_CONFIG.TZ, 'dd/MM/yyyy HH:mm:ss');
}
