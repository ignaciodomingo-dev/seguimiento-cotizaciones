/****************************************************
 * HELPERS DE CORREO AL CLIENTE (compartidos)
 * Firma, detalle, asunto, descarga del PDF de Bsale, y el cuerpo del email inicial.
 * Usados por GAS #1 (email inicial día 0). GAS #2 mantiene su propia versión inline.
 ****************************************************/

var ESTILO_NARROW_ = "font-family: 'Arial Narrow', Arial, sans-serif; font-size: 14px; color: #333;";

/**
 * Asunto estándar. DEBE ser idéntico en el inicial y en los seguimientos (día 3/7)
 * para que Gmail agrupe todo en el mismo hilo del cliente.
 */
function asuntoCotizacion_(numeroCot) {
  return 'Cotización N° ' + numeroCot + ' — Mi Empresa';
}

/** Solo la lista <ul> del detalle (sin encabezado). Vacío si no hay detalle. */
function listaDetalleHTML_(detalleTexto) {
  var t = String(detalleTexto || '').trim();
  if (!t) return '';
  return '<ul style="font-family: \'Arial Narrow\', Arial, sans-serif; font-size: 14px; color: #333; margin: 4px 0; padding-left: 20px;">'
    + t.split('\n').map(function(l) { return '<li style="margin-bottom: 2px;">' + l.trim() + '</li>'; }).join('')
    + '</ul>';
}

/** Lista del detalle con encabezado "Detalle del pedido:". Vacío si no hay. */
function detallePedidoHTML_(detalleTexto) {
  var lista = listaDetalleHTML_(detalleTexto);
  if (!lista) return '';
  return '<p style="' + ESTILO_NARROW_ + '"><strong>Detalle del pedido:</strong></p>' + lista;
}

/** Firma HTML de Mi Empresa (logo + datos de Vendedor). */
function firmaEmpresaHTML_() {
  return ''
    + '<p style="' + ESTILO_NARROW_ + '; font-size: 13px;">Saludos,</p><br>'
    + '<table style="border: none; font-family: \'Arial Narrow\', Arial, sans-serif; color: #333; line-height: 1.1;"><tr>'
    + '<td style="padding-right: 12px; border-right: 1.5px solid #2e7d32; vertical-align: middle;">'
    + '<img src="https://lh3.googleusercontent.com/d/YOUR_LOGO_FILE_ID" width="100" alt="Mi Empresa" style="display: block;"></td>'
    + '<td style="padding-left: 12px; vertical-align: middle;">'
    + '<strong style="font-size: 15px; color: #1a1a1a;">Vendedor Ejemplo</strong><br>'
    + '<span style="color: #666; font-size: 12px;">KAM</span><br><br>'
    + '<span style="font-size: 11px;">'
    + 'Tel: <a href="tel:+56900000000" style="text-decoration: none; color: #333;">+569 0000 0000</a><br>'
    + 'Email: <a href="mailto:ventas@ejemplo.com" style="text-decoration: none; color: #333;">ventas@ejemplo.com</a><br>'
    + 'Web: <a href="https://www.ejemplo.com" style="text-decoration: none; color: #333;">www.ejemplo.com</a></span><br><br>'
    + '<em style="color: #2e7d32; font-size: 10px;">Más de 10 años impulsando un packaging sustentable</em>'
    + '</td></tr></table>';
}

/** Cuerpo HTML completo del email inicial (día 0). */
function cuerpoEmailInicialHTML_(nombre, numeroCot, montoFmt, detalleTexto) {
  var lista = listaDetalleHTML_(detalleTexto);
  var bloqueDetalle = lista
    ? '<p style="' + ESTILO_NARROW_ + '">Este es el detalle:</p>' + lista
    : '';
  return ''
    + '<p style="' + ESTILO_NARROW_ + '">Hola ' + nombre + ', ¿cómo estás?</p>'
    + '<p style="' + ESTILO_NARROW_ + '">Dejo adjunta la cotización N° <strong>' + numeroCot + '</strong> por <strong>'
    + montoFmt + '</strong>.</p>'
    + bloqueDetalle
    + '<p style="' + ESTILO_NARROW_ + '">Quedo atento a cualquier duda o ajuste que necesites. '
    + '¡Avísame si te sirve y coordinamos los siguientes pasos!</p>'
    + firmaEmpresaHTML_();
}

/**
 * Cuerpo HTML del email inicial cuando el grupo tiene VARIAS cotizaciones.
 * cots = [{ num, monto, detalle }]. Lista cada una con su detalle.
 */
function cuerpoEmailInicialGrupalHTML_(nombre, cots) {
  var bloques = cots.map(function(c) {
    var montoFmt = '$' + Number(c.monto).toLocaleString('es-CL');
    return '<p style="' + ESTILO_NARROW_ + '; margin-bottom: 2px;">• Cotización N° <strong>' + c.num
      + '</strong> por <strong>' + montoFmt + '</strong></p>'
      + detallePedidoHTML_(c.detalle);
  }).join('');

  return ''
    + '<p style="' + ESTILO_NARROW_ + '">Hola ' + nombre + ', ¿cómo estás?</p>'
    + '<p style="' + ESTILO_NARROW_ + '">Te comparto las cotizaciones que preparamos para ti. '
    + 'Adjunto el PDF de cada una con todo el detalle.</p>'
    + bloques
    + '<p style="' + ESTILO_NARROW_ + '">Quedo atento a cualquier duda o ajuste que necesites. '
    + '¡Avísame si te sirven y coordinamos los siguientes pasos!</p>'
    + firmaEmpresaHTML_();
}

/**
 * Descarga el PDF de la cotización desde Bsale como Blob para adjuntar.
 * claveTecnica = "COTIZACION||<docId>" (col O). Devuelve null si no se puede
 * (sin bloquear el envío del correo).
 */
function obtenerBlobPdfCotizacion_(claveTecnica, numeroCot) {
  try {
    var partes = String(claveTecnica || '').split('||');
    var docId = partes.length > 1 ? partes[1].trim() : '';
    if (!docId) return null;

    var doc = bsaleGetJson_('https://api.bsale.io/v1/documents/' + docId + '.json');
    var urlPdf = doc.urlPdf || doc.urlPdfOriginal;
    if (!urlPdf) return null;

    var resp = UrlFetchApp.fetch(urlPdf, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;

    var nombre = 'Cotizacion_' + (numeroCot ? numeroCot : docId) + '.pdf';
    return resp.getBlob().setName(nombre);
  } catch (e) {
    Logger.log(' No se pudo obtener PDF (' + claveTecnica + '): ' + e.message);
    return null;
  }
}

/**
 * DIAGNÓSTICO PDF: revisa qué devuelve realmente la URL del PDF de Bsale
 * (código HTTP, tipo de contenido, tamaño y primeros bytes). Ayuda a entender
 * por qué el adjunto llega vacío. Ejecutar y pegar el Log.
 */
function diagnosticarPdfCotizacion() {
  var hoja = getWorkSS().getSheetByName('Cotizaciones Vendedor');
  var datos = hoja.getDataRange().getValues();

  for (var i = datos.length - 1; i >= 1; i--) {
    var f = datos[i];
    if (!String(f[16] || '').trim()) continue; // necesita Deal ID

    var docId = String(f[14] || '').split('||')[1];
    Logger.log(' docId: ' + docId);

    var doc = bsaleGetJson_('https://api.bsale.io/v1/documents/' + docId + '.json');
    Logger.log('urlPdf: ' + doc.urlPdf);
    Logger.log('urlPdfOriginal: ' + doc.urlPdfOriginal);

    [doc.urlPdf, doc.urlPdfOriginal].forEach(function(u) {
      if (!u) return;
      try {
        var resp = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
        var blob = resp.getBlob();
        Logger.log('--- URL: ' + u);
        Logger.log('    HTTP: ' + resp.getResponseCode());
        Logger.log('    Content-Type: ' + blob.getContentType());
        Logger.log('    Bytes: ' + blob.getBytes().length);
        Logger.log('    Inicio: ' + resp.getContentText().substring(0, 120).replace(/\n/g, ' '));
      } catch (e) {
        Logger.log('--- URL: ' + u + ' → ERROR: ' + e.message);
      }
    });
    return;
  }
  Logger.log('No hay cotización con Deal ID.');
}

/**
 * PRUEBA: envía el email inicial A TI MISMO (ventas@ejemplo.com) usando la última
 * cotización con Deal ID, para revisar formato y PDF antes de que salga a clientes.
 * No afecta el flujo de producción.
 */
function probarEmailInicialAMiMismo() {
  var hoja = getWorkSS().getSheetByName('Cotizaciones Vendedor');
  var datos = hoja.getDataRange().getValues();

  for (var i = datos.length - 1; i >= 1; i--) {
    var f = datos[i];
    if (!String(f[16] || '').trim()) continue; // necesita Deal ID

    var numeroCot = f[2];
    var nombre = String(f[5] || '').trim();
    var montoFmt = '$' + Number(f[12]).toLocaleString('es-CL');
    var cuerpo = cuerpoEmailInicialHTML_(nombre, numeroCot, montoFmt, f[20]);

    var opciones = { htmlBody: cuerpo };
    var pdf = obtenerBlobPdfCotizacion_(f[14], numeroCot);
    if (pdf) opciones.attachments = [pdf];

    GmailApp.sendEmail('ventas@ejemplo.com', '[PRUEBA] ' + asuntoCotizacion_(numeroCot), '', opciones);
    Logger.log(' Prueba enviada a ventas@ejemplo.com | Cot ' + numeroCot + (pdf ? ' (con PDF)' : ' (SIN PDF)'));
    return;
  }
  Logger.log('No se encontró ninguna cotización con Deal ID para la prueba.');
}
