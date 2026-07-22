/**
 * PANEL DE SEGUIMIENTO (pestaña "Panel Seguimiento") — dashboard diario.
 *
 * Cabecera: estado de ENVÍOS (ON/OFF) + fecha + resumen del día. Luego 4 secciones:
 *   1) POR PROCESAR   → cotizaciones nuevas: eliges Flujo (Deal + correo / Deal sin correo /
 *      No procesar), marcas la casilla "Procesar nuevas". Avisa si "se crea sola" (respaldo 12h).
 *   2) OCURRE HOY     → lo que pasa hoy: recordatorios día 3/7 que vencen + cierres del día.
 *   3) EN SEGUIMIENTO → resto de activos, con su próximo evento y fecha.
 *   4) PAUSADOS       → para reactivar.
 *
 * Cada fila de negocio lleva su desplegable Acción (Seguir / Saltar hoy / Pausar / Excluir),
 * así que puedes Pausar cualquiera — incluido un recordatorio o un cierre de hoy. "Pausar"
 * frena recordatorios Y el cierre (deja el deal en Cotizando). Todo escribe el estado real de
 * "Cotizaciones Vendedor" (Flujo col X, Control col W).
 *
 * Piezas:
 *   actualizarPanelSeguimiento()  reconstruye el dashboard (solo lee). 8:00 + a mano.
 *   onEditPanel(e)                casilla "Procesar nuevas" + desplegables (instalable onEdit).
 *   excluirPanel(dryRun)          borra en HubSpot + marca Excluida las filas "Excluir".
 * Los triggers (refresco 8:00 + onEditPanel) se crean en configurarTodosLosTriggers.
 */

const PANEL_NOMBRE = 'Panel Seguimiento';
const PANEL_ACCIONES = ['Seguir', 'Saltar hoy', 'Pausar', 'Excluir'];
const PANEL_COL_ESTADO   = 6;   // 1-indexed
const PANEL_COL_DESCARGA = 5;   // 1-indexed: checkbox "① Sincronizar Bsale" (fila 1)
const PANEL_COL_ACCION   = 8;   // 1-indexed: desplegable (Flujo o Acción) y checkbox "② Aprobar todo" (fila 1)
const PANEL_COL_TIPO     = 9;   // 1-indexed: marca oculta 'procesar' / 'seguimiento'
const PANEL_NCOLS        = 9;
const PANEL_FILA_CHECK   = 1;   // fila de los checkboxes de cabecera
const PANEL_COL_GUIA     = 11;  // columna donde empieza la guía del día (derecha del panel)

/** Normaliza un N° de cotización a solo dígitos sin ceros a la izquierda (para emparejar filas). */
function _panelNum_(v) {
  return String(v).replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * Reconstruye el dashboard "Panel Seguimiento" (solo lee; no envía nada).
 * Cabecera con estado de ENVÍOS + fecha + resumen del día, y 4 secciones:
 * POR PROCESAR · OCURRE HOY (recordatorios + cierres) · EN SEGUIMIENTO · PAUSADOS.
 * Cada fila de negocio lleva su desplegable, así que se puede Pausar cualquiera.
 */
function actualizarPanelSeguimiento() {
  var ss = getWorkSS();
  var origen = ss.getSheetByName('Cotizaciones Vendedor');
  if (!origen) { Logger.log('No existe "Cotizaciones Vendedor".'); return; }
  var last = origen.getLastRow();
  if (last < 2) { Logger.log('Sin datos.'); return; }

  var datos = origen.getRange(2, 1, last - 1, 25).getValues(); // hasta col Y
  var hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  var horasHastaMedianoche = (new Date(hoy.getTime() + 86400000).getTime() - Date.now()) / 3600000;
  var excluidas = (typeof cotizacionesExcluidas_ === 'function') ? cotizacionesExcluidas_() : {};
  var conPedido = (typeof cotizacionesConPedido_ === 'function') ? cotizacionesConPedido_() : {};
  var fmt = function (d) { return d ? Utilities.formatDate(d, 'America/Santiago', 'dd/MM') : ''; };

  var porProcesar = [], ocurreHoy = [], enSeguimiento = [], pausados = [];
  var nAutoHoy = 0, nRecHoy = 0, nCierreHoy = 0;

  for (var i = 0; i < datos.length; i++) {
    var f = datos[i];
    var etapa = String(f[COL_ETAPA] || '').trim();
    var control = String(f[COL_CONTROL] || '').trim();
    var deal = String(f[COL_DEALID] || '').trim();
    var num = String(f[2]), cli = String(f[5]), emp = String(f[4]), monto = Number(f[12]) || 0;

    // Negocios en Cotizando con deal (activos o pausados).
    if (etapa === ETAPA_COTIZANDO && deal && (control === '' || control === 'Respondida')) {
      var fe = aFecha_(f[0]);
      var dias = fe ? Math.round((Date.now() - fe.getTime()) / 86400000) : '';

      var dd = dias === '' ? -1 : dias;
      var thread = String(f[17] || '').trim(); // col R = Thread ID del inicial/día 3
      var gmailUrl = (thread && thread.indexOf('ID_') !== 0) ? 'https://mail.google.com/mail/u/0/#all/' + thread : '';
      // Sin Thread ID real = el cliente nunca recibió (o no quedó registrado) el correo inicial.
      var warnInicial = gmailUrl ? '' : '  ·  ⚠ sin correo inicial';
      var tienePedido = !!conPedido[_panelNum_(num)];
      var pedidoTxt = 'YA TIENE PEDIDO — el próximo cruce lo mueve';

      if (control === 'Respondida') {
        pausados.push({ vals: [num, cli, emp, monto, dias, 'Pausado', tienePedido ? pedidoTxt : '', 'Pausar'],
          dias: dd, deal: deal, gmail: gmailUrl });
        continue;
      }
      // Ya convertida: GAS #2 no le envía nada (mismo criterio), el cruce diario mueve el deal.
      if (tienePedido) {
        enSeguimiento.push({ vals: [num, cli, emp, monto, dias, 'Convertido', pedidoTxt, 'Seguir'],
          dias: dd, deal: deal, gmail: gmailUrl });
        continue;
      }
      var px = _panelProximo_(fe, f, hoy);
      var fechaTxt = fmt(px.fecha);
      if (px.venceHoy) {
        if (px.tipo === 'cierre') nCierreHoy++; else nRecHoy++;
        ocurreHoy.push({
          vals: [num, cli, emp, monto, dias, (px.tipo === 'cierre' ? 'CIERRE' : 'Recordatorio'),
                 px.evento + (px.tipo === 'cierre' ? ' — hoy' : ' — vence hoy') + warnInicial, 'Seguir'],
          cierre: px.tipo === 'cierre', dias: dd, deal: deal, gmail: gmailUrl
        });
      } else {
        enSeguimiento.push({
          vals: [num, cli, emp, monto, dias, 'Activo', px.evento + (fechaTxt ? ' — ' + fechaTxt : '') + warnInicial, 'Seguir'],
          dias: dd, deal: deal, gmail: gmailUrl
        });
      }
      continue;
    }

    // POR PROCESAR: candidata nueva (mismos criterios que GAS #1), sin Etapa/Control/Deal.
    if (etapa === '' && control === '' && !deal && _esCandidataNueva_(f, excluidas, conPedido)) {
      var ing = (f[COL_INGRESO] instanceof Date) ? f[COL_INGRESO] : aFecha_(f[COL_INGRESO]);
      var refMs = ing ? ing.getTime() : (aFecha_(f[0]) ? aFecha_(f[0]).getTime() : Date.now());
      var autoEnH = RESPALDO_HORAS - (Date.now() - refMs) / 3600000;
      var autoTxt = autoEnH <= 0 ? 'se crea sola (próxima corrida)' : 'se crea sola en ' + Math.round(autoEnH) + ' h';
      if (autoEnH <= horasHastaMedianoche) nAutoHoy++;
      var flujoActual = String(f[COL_FLUJO] || '').trim() || FLUJO_DEFECTO;
      porProcesar.push({ vals: [num, cli, emp, monto, _panelAntiguedad_(f), '', autoTxt, flujoActual] });
    }
  }

  ocurreHoy.sort(function (a, b) { return (a.cierre === b.cierre) ? b.dias - a.dias : (a.cierre ? -1 : 1); });
  enSeguimiento.sort(function (a, b) { return b.dias - a.dias; });
  pausados.sort(function (a, b) { return b.dias - a.dias; });

  var hoja = ss.getSheetByName(PANEL_NOMBRE) || ss.insertSheet(PANEL_NOMBRE);
  hoja.clear();
  hoja.getRange(1, 1, hoja.getMaxRows(), PANEL_NCOLS).clearDataValidations();

  // Cabecera: estado de envíos + fecha + 2 checkboxes de acción rápida.
  var envios = enviosActivos_() ? 'ENVÍOS: ACTIVADOS' : 'ENVÍOS: OFF (no sale ningún correo ni cierre)';
  hoja.getRange(1, 1, 1, PANEL_NCOLS).setBackground('#FFFFFF');
  hoja.getRange(1, 1).setValue(envios + '    ' + Utilities.formatDate(new Date(), 'America/Santiago', 'dd/MM/yyyy HH:mm'))
    .setFontWeight('bold').setFontColor(enviosActivos_() ? '#3D7038' : '#b00020').setFontSize(11);
  hoja.getRange(1, 4).setValue('① Sincronizar Bsale →').setFontWeight('bold').setFontColor('#3D7038').setFontSize(10);
  hoja.getRange(1, PANEL_COL_DESCARGA).insertCheckboxes().setValue(false);
  hoja.getRange(1, 7).setValue('② Aprobar todo →').setFontWeight('bold').setFontColor('#3D7038').setFontSize(10);
  hoja.getRange(1, PANEL_COL_ACCION).insertCheckboxes().setValue(false);
  hoja.getRange(2, 1, 1, PANEL_NCOLS).setBackground('#FFFFFF');
  hoja.getRange(2, 1).setValue('Hoy:  ' + porProcesar.length + ' por procesar  ·  ' + nRecHoy + ' recordatorios  ·  ' +
    nCierreHoy + ' cierres  ·  ' + nAutoHoy + ' auto-creaciones').setFontColor('#888888').setFontSize(10);

  var reglaFlujo = SpreadsheetApp.newDataValidation().requireValueInList(FLUJOS, true).setAllowInvalid(false).build();
  var reglaAccion = SpreadsheetApp.newDataValidation().requireValueInList(PANEL_ACCIONES, true).setAllowInvalid(false).build();

  var r = 4;
  function seccion(titulo, color, cab, filas, tipo, regla) {
    // Título de sección: fondo blanco, texto en el color de la sección
    hoja.getRange(r, 1, 1, PANEL_NCOLS).setBackground('#FFFFFF');
    hoja.getRange(r, 1).setValue(titulo).setFontWeight('bold').setFontColor(color).setFontSize(11);
    r++;
    // Header de columnas: gris muy claro, texto gris oscuro, tamaño pequeño
    hoja.getRange(r, 1, 1, PANEL_NCOLS).setValues([cab]).setFontWeight('bold')
      .setBackground('#F5F5F5').setFontColor('#666666').setFontSize(9);
    r++;
    if (filas.length) {
      var d = filas.map(function (x) { return x.vals.concat([tipo]); });
      hoja.getRange(r, 1, d.length, PANEL_NCOLS).setValues(d)
        .setBackground('#FFFFFF').setFontColor('#111111').setFontSize(10).setFontWeight('normal');
      hoja.getRange(r, 4, d.length, 1).setNumberFormat('#,##0');
      // Links: N° Cotización → deal en HubSpot · Cliente → hilo en Gmail (si la fila los trae).
      var rts = filas.map(function (x) {
        var rNum = SpreadsheetApp.newRichTextValue().setText(String(x.vals[0]));
        if (x.deal) rNum.setLinkUrl('https://app.hubspot.com/contacts/' + HS_ACCOUNT_ID + '/deal/' + x.deal);
        var rCli = SpreadsheetApp.newRichTextValue().setText(String(x.vals[1]));
        if (x.gmail) rCli.setLinkUrl(x.gmail);
        return [rNum.build(), rCli.build()];
      });
      hoja.getRange(r, 1, d.length, 2).setRichTextValues(rts);
      if (regla) hoja.getRange(r, PANEL_COL_ACCION, d.length, 1).setDataValidation(regla);
      r += d.length;
    } else {
      hoja.getRange(r, 1, 1, PANEL_NCOLS).setBackground('#FFFFFF');
      hoja.getRange(r, 1).setValue('(ninguna)').setFontColor('#CCCCCC').setFontSize(10).setFontWeight('normal');
      r++;
    }
    r++; // blanco entre secciones
  }

  seccion('POR PROCESAR (' + porProcesar.length + ')', '#3D7038',
    ['N° Cotización', 'Cliente', 'Empresa', 'Monto', 'Antigüedad', '', 'Entrada automática', 'Flujo', ''],
    porProcesar, 'procesar', reglaFlujo);

  seccion('OCURRE HOY (' + ocurreHoy.length + ')', '#111111',
    ['N° Cotización', 'Cliente', 'Empresa', 'Monto', 'Días', 'Evento', 'Detalle', 'Acción', ''],
    ocurreHoy, 'seguimiento', reglaAccion);

  seccion('EN SEGUIMIENTO (' + enSeguimiento.length + ')', '#555555',
    ['N° Cotización', 'Cliente', 'Empresa', 'Monto', 'Días', 'Estado', 'Próximo paso', 'Acción', ''],
    enSeguimiento, 'seguimiento', reglaAccion);

  seccion('PAUSADOS (' + pausados.length + ')', '#AAAAAA',
    ['N° Cotización', 'Cliente', 'Empresa', 'Monto', 'Días', 'Estado', '', 'Acción', ''],
    pausados, 'seguimiento', reglaAccion);

  hoja.hideColumns(PANEL_COL_TIPO);
  hoja.setFrozenRows(2);
  _dibujarGuia_(hoja);
  Logger.log('Panel: ' + porProcesar.length + ' por procesar | ' + ocurreHoy.length + ' ocurre hoy | ' +
    enSeguimiento.length + ' en seguimiento | ' + pausados.length + ' pausados.');
}

/** ¿La fila es una cotización nueva candidata (mismos criterios que GAS #1)? */
function _esCandidataNueva_(f, excluidas, conPedido) {
  var fe = aFecha_(f[0]);
  var reciente = fe && (Date.now() - fe.getTime()) < CONFIG_HS.DIAS_MAX_PARA_PROCESAR * 86400000;
  var vendedorOk = CONFIG_HS.VENDEDORES_VALIDOS.indexOf(String(f[9]).trim()) !== -1;
  var montoOk = Number(f[12]) > CONFIG_HS.MONTO_MINIMO;
  var noExcluida = !(excluidas && excluidas[String(f[2]).trim()]);
  // Si ya tiene pedido, NO es "nueva por cotizar" (el cliente ya compró).
  var sinPedido = !(conPedido && conPedido[String(f[2]).replace(/\D/g, '').replace(/^0+/, '')]);
  return reciente && vendedorOk && montoOk && noExcluida && sinPedido;
}

/** Antigüedad legible desde el sello de ingreso (col Y) o la emisión. */
function _panelAntiguedad_(f) {
  var ing = (f[COL_INGRESO] instanceof Date) ? f[COL_INGRESO] : aFecha_(f[COL_INGRESO]);
  var ref = ing || aFecha_(f[0]);
  if (!ref) return '';
  var h = (Date.now() - ref.getTime()) / 3600000;
  return h < 24 ? Math.round(h) + ' h' : Math.round(h / 24) + ' d';
}

/**
 * Próximo evento de un negocio activo: día 3, día 7 o cierre día 21.
 * Devuelve { evento, fecha, venceHoy, tipo:'recordatorio'|'cierre' }. Espeja GAS #2/#3.
 * f[18]=col S (día 3 enviado), f[19]=col T (día 7 enviado).
 */
function _panelProximo_(fe, f, hoy) {
  if (!fe) return { evento: '(fecha inválida)', fecha: null, venceHoy: false, tipo: '' };
  var edadMs = Date.now() - fe.getTime();
  // Espejar la guarda de GAS #2: >DIAS_MAX_SEGUIMIENTO días NO recibe día 3/7.
  // Sin esto el panel/resumen anuncia recordatorios que GAS #2 jamás enviará.
  var recordatoriosVigentes = edadMs <= CONFIG_SEG.DIAS_MAX_SEGUIMIENTO * 86400000;
  if (!f[18] && recordatoriosVigentes) {
    var d3 = calcularFechaHabil_(fe, 3);
    return { evento: 'Recordatorio día 3', fecha: d3, venceHoy: hoy.getTime() >= d3.getTime(), tipo: 'recordatorio' };
  }
  if (!f[19] && recordatoriosVigentes) {
    var d7 = calcularFechaHabil_(fe, 7);
    return { evento: 'Recordatorio día 7', fecha: d7, venceHoy: hoy.getTime() >= d7.getTime(), tipo: 'recordatorio' };
  }
  // Espejar la guarda de GAS #3: >DIAS_MAX_GUARDA días naturales tampoco se cierra solo.
  if (edadMs > CONFIG_CIERRE.DIAS_MAX_GUARDA * 86400000) {
    return { evento: 'Fuera de ventana (cerrar a mano)', fecha: null, venceHoy: false, tipo: '' };
  }
  var d21 = calcularFechaHabil_(fe, CONFIG_CIERRE.DIAS_CIERRE);
  return { evento: 'Cierre por silencio', fecha: d21, venceHoy: hoy.getTime() >= d21.getTime(), tipo: 'cierre' };
}

/**
 * Trigger instalable onEdit. Maneja:
 *   - la casilla "Procesar ahora" (fila 1) → procesa las nuevas según su Flujo;
 *   - el desplegable Flujo (filas 'procesar') → escribe col X;
 *   - el desplegable Acción (filas 'seguimiento') → Seguir/Pausar al instante (Excluir solo se marca).
 */
function onEditPanel(e) {
  if (!e || !e.range) return;
  var hoja = e.range.getSheet();
  if (hoja.getName() !== PANEL_NOMBRE) return;
  var row = e.range.getRow(), col = e.range.getColumn();
  // Solo reaccionar en la col de descarga (fila 1) y la col de acción (fila 1 + filas de datos).
  if (col !== PANEL_COL_ACCION && col !== PANEL_COL_DESCARGA) return;

  // Fila 1: los dos checkboxes de cabecera.
  if (row === PANEL_FILA_CHECK) {
    var activado = (e.value === true || String(e.value).toUpperCase() === 'TRUE');
    if (!activado) return;

    if (col === PANEL_COL_DESCARGA) {
      // 📥 Descargar cotizaciones: fuerza sincronización con Bsale y refresca el panel.
      try { sincronizarBsaleRapido(); } catch (err) { Logger.log('Error al descargar Bsale: ' + err.message); }
      actualizarPanelSeguimiento();
      return;
    }

    if (col === PANEL_COL_ACCION) {
      // ✅ Aprobar todo el día: procesa cotizaciones nuevas según su Flujo,
      // y si hay filas marcadas "Excluir", lanza el diálogo de confirmación.
      // M1 fix: leer el panel ANTES de llamar a gas1; solo llamar si hay filas "procesar".
      var panelDatos = hoja.getRange(1, 1, hoja.getLastRow(), PANEL_NCOLS).getValues();
      var hayPorProcesar = panelDatos.some(function(r) {
        return String(r[PANEL_COL_TIPO - 1] || '').trim() === 'procesar';
      });
      if (hayPorProcesar) {
        try { procesarCotizacionesNuevas(); } catch (err) { Logger.log('Error procesando nuevas: ' + err.message); }
        // Releer el panel tras el procesamiento para detectar "Excluir" actualizados.
        panelDatos = hoja.getRange(1, 1, hoja.getLastRow(), PANEL_NCOLS).getValues();
      } else {
        Logger.log('onEditPanel: no hay filas Por procesar; se omite procesarCotizacionesNuevas.');
      }
      var hayExcluir = panelDatos.some(function(r) {
        return String(r[PANEL_COL_TIPO - 1] || '').trim() === 'seguimiento'
          && String(r[PANEL_COL_ACCION - 1] || '').trim() === 'Excluir';
      });
      if (hayExcluir) excluirConConfirmacion();
      actualizarPanelSeguimiento();
      return;
    }
    return;
  }

  // Filas 3+: solo col PANEL_COL_ACCION (dropdowns de datos). La col descarga no aplica aquí.
  if (col !== PANEL_COL_ACCION) return;
  if (row < 3) return;
  var tipo = String(hoja.getRange(row, PANEL_COL_TIPO).getValue()).trim();
  var valor = String(e.value || '').trim();
  var num = _panelNum_(hoja.getRange(row, 1).getValue());
  if (!num) return;

  if (tipo === 'procesar') {
    if (FLUJOS.indexOf(valor) === -1) return;
    _panelEscribirFlujo_(num, valor); // guarda la decisión; se aplica al marcar la casilla o por respaldo
    return;
  }

  if (tipo === 'seguimiento') {
    if (PANEL_ACCIONES.indexOf(valor) === -1) return;
    if (valor === 'Excluir') { // destructivo: solo se marca; se confirma con excluirPanel()
      hoja.getRange(row, PANEL_COL_ESTADO).setValue('Por excluir (corre excluirPanel)');
      return;
    }
    var origen = getWorkSS().getSheetByName('Cotizaciones Vendedor');
    var datos = origen.getRange(2, 1, origen.getLastRow() - 1, 25).getValues();
    var nuevoEstado = _panelAplicarAccion_(origen, datos, num, valor);
    if (nuevoEstado) hoja.getRange(row, PANEL_COL_ESTADO).setValue(nuevoEstado);
  }
}

/** Escribe el Flujo (col X) de una cotización por su N°. */
function _panelEscribirFlujo_(num, flujo) {
  var origen = getWorkSS().getSheetByName('Cotizaciones Vendedor');
  var datos = origen.getRange(2, 1, origen.getLastRow() - 1, 25).getValues();
  for (var i = 0; i < datos.length; i++) {
    if (_panelNum_(datos[i][2]) === num) {
      origen.getRange(i + 2, COL_FLUJO + 1).setValue(flujo);
      return;
    }
  }
}

/**
 * Cambia el Control real de una cotización según la acción. Devuelve el nuevo Estado o null.
 * NO envía correos. "Saltar hoy" no cambia el estado (lo respeta GAS #2).
 */
function _panelAplicarAccion_(origen, datos, num, accion) {
  for (var i = 0; i < datos.length; i++) {
    var f = datos[i];
    if (String(f[COL_ETAPA] || '').trim() !== ETAPA_COTIZANDO) continue;
    if (!String(f[COL_DEALID] || '').trim()) continue;
    if (_panelNum_(f[2]) !== num) continue;
    var control = String(f[COL_CONTROL] || '').trim();
    if (accion === 'Pausar' && control === '') { origen.getRange(i + 2, COL_CONTROL + 1).setValue('Respondida'); return 'Pausado'; }
    if (accion === 'Seguir' && control === 'Respondida') { origen.getRange(i + 2, COL_CONTROL + 1).setValue(''); return 'Activo'; }
    // "Saltar hoy" persiste en la HOJA (col Z "Saltar hasta"): sobrevive refrescos del panel.
    if (accion === 'Saltar hoy' && control === '') { origen.getRange(i + 2, COL_SALTAR + 1).setValue(new Date()); return 'Salta hoy'; }
    if (accion === 'Seguir' && control === '') { origen.getRange(i + 2, COL_SALTAR + 1).setValue(''); return 'Activo'; }
    return null;
  }
  return null;
}

/**
 * Saca de TODO las filas 'seguimiento' marcadas "Excluir": borra el deal en HubSpot
 * (recuperable ~90 d) y deja la fila Etapa vacía / sin Deal ID / Control "Excluida".
 * dryRun por defecto = solo LISTA. Para ejecutar: excluirPanelReal(). No envía correos.
 */
function excluirPanel(dryRun) {
  if (dryRun === undefined) dryRun = true;
  var ss = getWorkSS();
  var panel = ss.getSheetByName(PANEL_NOMBRE);
  if (!panel || panel.getLastRow() < 2) { Logger.log('Panel vacío.'); return; }
  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!dryRun && !token) { Logger.log('Falta HUBSPOT_TOKEN.'); return; }

  var pf = panel.getRange(1, 1, panel.getLastRow(), PANEL_NCOLS).getValues();
  var marcados = {};
  pf.forEach(function (r) {
    if (String(r[PANEL_COL_TIPO - 1] || '').trim() === 'seguimiento' &&
        String(r[PANEL_COL_ACCION - 1] || '').trim() === 'Excluir') marcados[_panelNum_(r[0])] = true;
  });
  if (!Object.keys(marcados).length) { Logger.log('Ninguna fila marcada "Excluir".'); return; }

  var origen = ss.getSheetByName('Cotizaciones Vendedor');
  var datos = origen.getRange(2, 1, origen.getLastRow() - 1, 25).getValues();
  var dealsABorrar = {};
  for (var i = 0; i < datos.length; i++) {
    if (!marcados[_panelNum_(datos[i][2])]) continue;
    var d = String(datos[i][COL_DEALID] || '').trim();
    if (d) dealsABorrar[d] = true;
  }

  Logger.log('===== EXCLUIR DESDE PANEL ' + (dryRun ? '(DRY-RUN, no borra)' : '(REAL)') + ' =====');
  var borrados = 0, filasMarcadas = 0, dealsHechos = {};
  for (var i = 0; i < datos.length; i++) {
    var f = datos[i];
    var deal = String(f[COL_DEALID] || '').trim();
    var num = _panelNum_(f[2]);
    if (!(marcados[num] || (deal && dealsABorrar[deal]))) continue;

    if (deal && dealsABorrar[deal] && !dealsHechos[deal]) {
      dealsHechos[deal] = true;
      if (dryRun) { Logger.log('   Borraría deal ' + deal + ' (COT ' + f[2] + ')'); }
      else {
        var res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/deals/' + deal, {
          method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
        });
        Logger.log('   COT ' + f[2] + ' | deal ' + deal + ' -> DELETE HTTP ' + res.getResponseCode());
        borrados++;
      }
    }
    if (dryRun) { Logger.log('   Excluiría fila COT ' + f[2]); }
    else {
      origen.getRange(i + 2, COL_ETAPA + 1).setValue('');
      origen.getRange(i + 2, COL_DEALID + 1).setValue('');
      origen.getRange(i + 2, COL_CONTROL + 1).setValue('Excluida');
      filasMarcadas++;
    }
  }
  if (!dryRun) { SpreadsheetApp.flush(); actualizarPanelSeguimiento(); }
  Logger.log(dryRun ? 'Revisa la lista. Si está bien, corre excluirPanelReal().'
                    : 'Listo. Deals borrados: ' + borrados + ' | Filas Excluida: ' + filasMarcadas);
}
function excluirPanelReal() { excluirPanel(false); }

// panelSaltarHoy_ eliminada: "Saltar hoy" ahora escribe la col Z ("Saltar hasta") de la hoja
// real vía _panelAplicarAccion_, y GAS #2 la lee de ahí (sobrevive refrescos del panel).

// Los triggers del panel (refresco 8:00 + onEditPanel) se crean desde
// configurarTodosLosTriggers (_triggers.gs).

/**
 * Menú personalizado — aparece como "📋 Cotizaciones" en la barra de menú de la planilla.
 * Se instala como trigger onOpen instalable desde configurarTodosLosTriggers.
 * Expone las acciones manuales más frecuentes sin necesidad de abrir el editor de Apps Script.
 */
function onOpenPanel() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('📋 Cotizaciones')
    .addItem('🔄 Refrescar panel ahora',                      'actualizarPanelSeguimiento')
    .addItem('📨 Enviar resumen matutino ahora',              'enviarResumenMatutino')
    .addItem('📨 Enviar resumen post-cruce ahora',            'enviarResumenPostCruceManual')
    .addSeparator()
    .addItem('🔗 Cruzar pedidos ahora',                      'cruzarPedidos')
    .addItem('📋 Procesar revisión manual',                   'procesarRevisionManual')
    .addSeparator()
    .addItem('⏸️ Ver pausados (enviar por email)',            'listarPausadosPorEmail')
    .addItem('🗑️ Excluir deals marcados (con confirmación)', 'excluirConConfirmacion')
    .addToUi();
}

/**
 * Genera y envía por email la lista de deals PAUSADOS (Control = "Respondida", Etapa = "Cotizando"),
 * ordenados de mayor a menor antigüedad. Incluye: N° cotización, cliente, empresa, monto, días.
 * Desde el menú: 📋 Cotizaciones → Ver pausados (enviar por email).
 */
function listarPausadosPorEmail() {
  var hoja = getWorkSS().getSheetByName('Cotizaciones Vendedor');
  if (!hoja || hoja.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('La hoja "Cotizaciones Vendedor" está vacía.');
    return;
  }

  var datos = hoja.getRange(2, 1, hoja.getLastRow() - 1, COL_CONTROL + 1).getValues();
  var hoy = Date.now();
  var pausados = [];

  for (var i = 0; i < datos.length; i++) {
    var f = datos[i];
    var etapa   = String(f[COL_ETAPA]   || '').trim();
    var control = String(f[COL_CONTROL] || '').trim();
    var deal    = String(f[COL_DEALID]  || '').trim();
    if (etapa !== ETAPA_COTIZANDO || control !== 'Respondida' || !deal) continue;

    var fe   = aFecha_(f[0]);
    var dias = fe ? Math.round((hoy - fe.getTime()) / 86400000) : null;
    pausados.push({
      num   : String(f[2] || '').trim(),
      cli   : String(f[5] || '').trim(),
      emp   : String(f[4] || '').trim(),
      monto : Number(f[12]) || 0,
      dias  : dias
    });
  }

  if (!pausados.length) {
    SpreadsheetApp.getUi().alert('No hay deals pausados actualmente.');
    return;
  }

  // Ordenar: sin fecha primero (dias=null), luego de mayor a menor (más antiguos primero).
  pausados.sort(function(a, b) {
    if (a.dias === null && b.dias === null) return 0;
    if (a.dias === null) return -1;
    if (b.dias === null) return 1;
    return b.dias - a.dias;
  });

  // Calcular monto total
  var totalMonto = pausados.reduce(function(s, p) { return s + p.monto; }, 0);

  // Construir email con el mismo estilo que el sistema
  var logoBlob = _logoBlob_();
  var logoHtml = logoBlob
    ? '<img src="cid:logoEmpresa" style="height:52px;width:auto;display:block;" alt="Mi Empresa">'
    : '<span style="font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:#111111;">MI EMPRESA</span>';

  var fecha = Utilities.formatDate(new Date(), 'America/Santiago', "d 'de' MMMM yyyy");

  var filas = pausados.map(function(p) {
    return [p.num, p.cli, p.emp, _mFmt_(p.monto), p.dias !== null ? p.dias + 'd' : '—'];
  });

  var tabla = _emailTabla_(['N° Cot', 'Cliente', 'Empresa', 'Monto', 'Días'], filas);
  var resumen = '<p style="font-size:12px;color:#888888;margin:0 0 24px 0;">'
    + pausados.length + ' deals pausados &nbsp;·&nbsp; Total: ' + _mFmt_(totalMonto)
    + '</p>';

  var cuerpo = _emailHdr_(logoHtml, 'Deals pausados', fecha)
    + _emailSeccion_('Pausados', pausados.length, resumen + tabla)
    + '<div style="padding:16px 0 0 0;">'
    + '<p style="font-size:11px;color:#AAAAAA;margin:0;">Para reactivar: Panel Seguimiento → sección PAUSADOS → Accion: Seguir.<br>'
    + 'Para excluir definitivamente: Accion: Excluir → menu Excluir deals marcados.</p>'
    + '</div>'
    + _emailFtr_();

  var mailOpts = { htmlBody: cuerpo };
  if (logoBlob) mailOpts.inlineImages = { logoEmpresa: logoBlob };

  GmailApp.sendEmail(
    'ventas@ejemplo.com',
    'Deals pausados (' + pausados.length + ') — ' + fecha,
    '',
    mailOpts
  );

  SpreadsheetApp.getUi().alert(
    'Email enviado con la lista de ' + pausados.length + ' deals pausados.\n'
    + 'Total en pausa: ' + _mFmt_(totalMonto)
  );
}

/**
 * Exclusión con confirmación desde el panel — sin necesidad del editor de Apps Script.
 * 1) Hace el dry-run y construye la lista de lo que se borraría.
 * 2) Muestra un diálogo nativo con esa lista.
 * 3) Solo si el usuario confirma, ejecuta el borrado real.
 */
function excluirConConfirmacion() {
  var ss = getWorkSS();
  var panel = ss.getSheetByName(PANEL_NOMBRE);
  if (!panel || panel.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('El panel está vacío.');
    return;
  }

  var pf = panel.getRange(1, 1, panel.getLastRow(), PANEL_NCOLS).getValues();
  var marcados = {};
  pf.forEach(function(r) {
    if (String(r[PANEL_COL_TIPO - 1] || '').trim() === 'seguimiento' &&
        String(r[PANEL_COL_ACCION - 1] || '').trim() === 'Excluir') {
      marcados[_panelNum_(r[0])] = String(r[1] || '').trim(); // num → cliente
    }
  });

  if (!Object.keys(marcados).length) {
    SpreadsheetApp.getUi().alert('Ninguna fila marcada como "Excluir" en el panel.');
    return;
  }

  // Construir lista legible para el diálogo
  var lineas = Object.keys(marcados).map(function(num) {
    return '• COT ' + num + (marcados[num] ? ' — ' + marcados[num] : '');
  });
  var mensaje = 'Se borrarán los siguientes deals en HubSpot (recuperable ~90 días):\n\n'
    + lineas.join('\n')
    + '\n\n¿Confirmas el borrado?';

  var respuesta = SpreadsheetApp.getUi().alert(
    '⚠️ Confirmar exclusión',
    mensaje,
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );

  if (respuesta === SpreadsheetApp.getUi().Button.YES) {
    excluirPanel(false); // borrado real
  } else {
    SpreadsheetApp.getUi().alert('Cancelado. No se borró nada.');
  }
}

/**
 * RESUMEN MATUTINO (8:00 AM)
 * Envía un email a Vendedor con las 3 acciones del día:
 *   1) Cotizaciones nuevas por procesar
 *   2) Recordatorios que vencen hoy (día 3 / día 7)
 *   3) Cierres automáticos que ocurren hoy (día 21)
 */
function enviarResumenMatutino() {
  // Guard 1: solo días hábiles (L-V, no festivos).
  if (!esDiaHabil_(new Date())) { Logger.log('Resumen matutino: día no hábil, no se envía.'); return; }

  // Guard 2: deduplicación diaria. Si ya se envió hoy (p. ej. por trigger + llamada manual),
  // no enviar de nuevo. La caché dura 24h y se resetea sola al día siguiente.
  var hoyStr = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyyMMdd');
  var cache = CacheService.getScriptCache();
  var cacheKey = 'resumen_enviado_' + hoyStr;
  if (cache.get(cacheKey)) { Logger.log('Resumen matutino ya enviado hoy (' + hoyStr + '). Skipping.'); return; }
  cache.put(cacheKey, '1', 86400); // 24 h

  var ss = getWorkSS();
  var origen = ss.getSheetByName('Cotizaciones Vendedor');
  if (!origen || origen.getLastRow() < 2) return;

  var datos = origen.getRange(2, 1, origen.getLastRow() - 1, 25).getValues();
  var hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  var excluidas = cotizacionesExcluidas_();
  var conPedido  = cotizacionesConPedido_();

  var porProcesar  = [];
  var recordatorios = [];
  var cierres       = [];

  for (var i = 0; i < datos.length; i++) {
    var f       = datos[i];
    var etapa   = String(f[COL_ETAPA]   || '').trim();
    var control = String(f[COL_CONTROL] || '').trim();
    var deal    = String(f[COL_DEALID]  || '').trim();
    var fila    = { num: String(f[2]), cli: String(f[5]), emp: String(f[4]), monto: Number(f[12]) || 0 };

    // Nuevas por procesar (mismos criterios que el panel)
    if (etapa === '' && control === '' && !deal && _esCandidataNueva_(f, excluidas, conPedido)) {
      porProcesar.push(fila);
      continue;
    }

    // Activas: revisar si hoy vence algo
    if (etapa === ETAPA_COTIZANDO && deal && control === '') {
      // Ya tiene pedido → GAS #2 no le envía nada; no anunciarla como acción del día.
      if (conPedido[_panelNum_(f[2])]) continue;
      var fe = aFecha_(f[0]);
      if (!fe) continue;
      var px = _panelProximo_(fe, f, hoy);
      if (!px.venceHoy) continue;
      if (px.tipo === 'cierre') {
        cierres.push(fila);
      } else {
        recordatorios.push({ num: fila.num, cli: fila.cli, emp: fila.emp, monto: fila.monto, tipo: px.evento });
      }
    }
  }

  var fecha  = Utilities.formatDate(new Date(), 'America/Santiago', "EEEE dd/MM/yyyy");
  var total  = porProcesar.length + recordatorios.length + cierres.length;
  // El estado de ENVÍOS va en el ASUNTO: es la señal que faltó cuando el kill-switch
  // quedó OFF 12 días y el resumen siguió anunciando recordatorios que nunca salían.
  var enviosOn = enviosActivos_();
  var asunto = (enviosOn ? '' : '[ENVÍOS OFF] ')
    + 'Resumen ' + Utilities.formatDate(new Date(), 'America/Santiago', 'dd/MM')
    + ' — ' + total + (total === 1 ? ' accion' : ' acciones');
  var avisoEnvios = enviosOn ? ''
    : '<p style="font-size:13px;font-weight:bold;color:#b00020;margin:20px 0 0 0;">'
      + 'ENVÍOS OFF: hoy NO saldrá ningún correo a clientes ni cierre automático '
      + '(Script Property ENVIOS_ACTIVOS distinta de "SI"). Los recordatorios y cierres '
      + 'listados abajo quedarán pendientes.</p>';

  var logoBlob = _logoBlob_();
  var logoHtml = logoBlob
    ? '<img src="cid:logoEmpresa" style="height:52px;width:auto;display:block;" alt="Mi Empresa">'
    : '<span style="font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;line-height:1.6;color:#111111;">MI EMPRESA</span>';

  var cuerpo = _emailHdr_(logoHtml, 'Resumen del dia', fecha)
    + avisoEnvios
    + _emailSeccion_('Por procesar', porProcesar.length,
        _emailTabla_(['N° Cot', 'Cliente', 'Empresa', 'Monto'],
          porProcesar.map(function(r) { return [r.num, r.cli, r.emp, _mFmt_(r.monto)]; })))
    + _emailSeccion_('Recordatorios hoy', recordatorios.length,
        _emailTabla_(['N° Cot', 'Cliente', 'Empresa', 'Tipo', 'Monto'],
          recordatorios.map(function(r) { return [r.num, r.cli, r.emp, r.tipo, _mFmt_(r.monto)]; })))
    + _emailSeccion_('Cierres hoy', cierres.length,
        _emailTabla_(['N° Cot', 'Cliente', 'Empresa', 'Monto'],
          cierres.map(function(r) { return [r.num, r.cli, r.emp, _mFmt_(r.monto)]; })))
    + _emailFtr_();

  var mailOpts = { htmlBody: cuerpo };
  if (logoBlob) mailOpts.inlineImages = { logoEmpresa: logoBlob };
  GmailApp.sendEmail('ventas@ejemplo.com', asunto, '', mailOpts);
  try { _slackResumenMatutino_(fecha, porProcesar, recordatorios, cierres); } catch (e) { Logger.log('Slack matutino error: ' + e.message); }
  Logger.log('Resumen matutino enviado · Por procesar: ' + porProcesar.length
    + ' | Recordatorios: ' + recordatorios.length + ' | Cierres: ' + cierres.length);
}

/**
 * RESUMEN POST-CRUCE (~9:30 AM)
 * Lo dispara cruzarPedidos() al terminar, pasando los resultados del cruce.
 * Informa qué deals se movieron, cuántos quedaron en "Revisión manual",
 * y cuántas cotizaciones nuevas siguen pendientes en el panel.
 *
 * resultado = { movidos: [{ num, empresa, monto, estado }], aRevision: N }
 * Si se llama manualmente (desde menú) resultado = null → muestra solo el estado actual.
 *
 * Cache key propio ('postcruce_enviado_YYYYMMDD') independiente del resumen matutino.
 */
function enviarResumenPostCruce(resultado) {
  // Guard 1: solo días hábiles.
  if (!esDiaHabil_(new Date())) { Logger.log('Post-cruce: día no hábil, no se envía.'); return; }

  // Guard 2: deduplicación diaria (cache key DISTINTO al del matutino).
  var hoyKey = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyyMMdd');
  var cache = CacheService.getScriptCache();
  var cacheKey = 'postcruce_enviado_' + hoyKey;
  if (cache.get(cacheKey)) { Logger.log('Post-cruce ya enviado hoy (' + hoyKey + '). Skipping.'); return; }
  cache.put(cacheKey, '1', 86400);

  // Contar "Por procesar" actual en la hoja (para saber si quedan nuevas sin aprobar).
  var ss = getWorkSS();
  var origen = ss.getSheetByName('Cotizaciones Vendedor');
  var nPorProcesar = 0;
  if (origen && origen.getLastRow() >= 2) {
    var datos = origen.getRange(2, 1, origen.getLastRow() - 1, 25).getValues();
    var excluidas = (typeof cotizacionesExcluidas_ === 'function') ? cotizacionesExcluidas_() : {};
    var conPedido  = (typeof cotizacionesConPedido_  === 'function') ? cotizacionesConPedido_()  : {};
    datos.forEach(function(f) {
      if (!String(f[COL_ETAPA] || '').trim() && !String(f[COL_CONTROL] || '').trim()
          && !String(f[COL_DEALID] || '').trim() && _esCandidataNueva_(f, excluidas, conPedido)) {
        nPorProcesar++;
      }
    });
  }

  var movidos   = (resultado && resultado.movidos)   ? resultado.movidos   : [];
  var aRevision = (resultado && resultado.aRevision) ? resultado.aRevision : 0;

  var fecha  = Utilities.formatDate(new Date(), 'America/Santiago', "EEEE dd/MM/yyyy HH:mm");
  var asunto = 'Cruce ' + Utilities.formatDate(new Date(), 'America/Santiago', 'dd/MM')
    + ' — ' + movidos.length + ' movidos'
    + (aRevision    ? ' · ' + aRevision    + ' revision'   : '')
    + (nPorProcesar ? ' · ' + nPorProcesar + ' pendientes' : '');

  var logoBlob = _logoBlob_();
  var logoHtml = logoBlob
    ? '<img src="cid:logoEmpresa" style="height:52px;width:auto;display:block;" alt="Mi Empresa">'
    : '<span style="font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;line-height:1.6;color:#111111;">MI EMPRESA</span>';

  var notaRevision = aRevision > 0
    ? '<p style="font-size:13px;color:#555555;margin:8px 0 0 0;">Revisar pestana "Revision manual" — escribe "Crear deal" en las que quieras procesar.</p>'
    : '<p style="font-size:13px;color:#CCCCCC;margin:8px 0 0 0;">Ninguna</p>';

  var notaPendientes = nPorProcesar > 0
    ? '<p style="font-size:13px;color:#555555;margin:8px 0 0 0;">Quedan cotizaciones nuevas sin aprobar en el panel.</p>'
    : '<p style="font-size:13px;color:#CCCCCC;margin:8px 0 0 0;">Todo procesado.</p>';

  var cuerpo = _emailHdr_(logoHtml, 'Cruce de pedidos', fecha)
    + _emailSeccion_('Deals movidos', movidos.length,
        _emailTabla_(['N° Cot', 'Empresa', 'Monto', 'Estado'],
          movidos.map(function(m) { return [m.num, m.empresa, _mFmt_(m.monto), m.estado]; })))
    + _emailSeccion_('A revision manual', aRevision, notaRevision)
    + _emailSeccion_('Por procesar en panel', nPorProcesar, notaPendientes)
    + _emailFtr_();

  var mailOpts = { htmlBody: cuerpo };
  if (logoBlob) mailOpts.inlineImages = { logoEmpresa: logoBlob };
  GmailApp.sendEmail('ventas@ejemplo.com', asunto, '', mailOpts);
  try { _slackResumenPostCruce_(fecha, movidos, aRevision, nPorProcesar); } catch (e) { Logger.log('Slack post-cruce error: ' + e.message); }
  Logger.log('Post-cruce enviado · Movidos: ' + movidos.length + ' | A revision: ' + aRevision + ' | Por procesar: ' + nPorProcesar);
}

/** Wrapper sin parámetros para el menú personalizado. */
function enviarResumenPostCruceManual() { enviarResumenPostCruce(null); }

// ─── HELPERS DE EMAIL MI EMPRESA ────────────────────────────────────────────
// Diseño: minimalista negro/blanco/verde (#3D7038). Sin emojis.
// Para activar el logo: Propiedades del Script → LOGO_FILE_ID → ID del PNG en Google Drive.
// El archivo NO necesita ser público; el script lo lee con DriveApp directamente.

/**
 * Dibuja la Guía del día en la columna PANEL_COL_GUIA del panel.
 * Se reconstruye en cada refresco. Ocupa ~30 filas a la derecha de los datos.
 */
function _dibujarGuia_(hoja) {
  var col = PANEL_COL_GUIA;

  // Ancho de la columna guía
  hoja.setColumnWidth(col, 310);

  // Helper interno: escribe una celda de guía
  var r = 1;
  function fila(texto, opts) {
    opts = opts || {};
    var cell = hoja.getRange(r, col);
    cell.setValue(texto || '')
      .setFontSize(opts.size  || 10)
      .setFontWeight(opts.bold  ? 'bold' : 'normal')
      .setFontColor(opts.color || '#444444')
      .setBackground(opts.bg   || '#FFFFFF')
      .setVerticalAlignment('middle');
    if (opts.height) hoja.setRowHeight(r, opts.height);
    r++;
  }

  // ── Título
  fila('GUIA DEL DIA',    { bold: true, size: 11, color: '#3D7038', height: 28 });
  fila('',                { height: 6 });

  // ── Pasos de la mañana
  fila('PASOS DE LA MANANA', { bold: true, size: 9, color: '#888888', bg: '#F5F5F5', height: 20 });
  fila('1.  Abrir panel y revisar secciones',         { color: '#111111' });
  fila('2.  Marcar casilla  ①  Sincronizar Bsale',   { color: '#111111' });
  fila('3.  Elegir Flujo en cada fila nueva',         { color: '#111111' });
  fila('4.  Marcar casilla  ②  Aprobar todo',        { color: '#111111' });
  fila('5.  9:00 AM — pegar CSV en pestana Pedidos', { color: '#111111' });
  fila('6.  ~9:30 AM — llega email post-cruce (auto)', { color: '#111111' });
  fila('',                { height: 6 });

  // ── Secciones del panel
  fila('SECCIONES DEL PANEL', { bold: true, size: 9, color: '#888888', bg: '#F5F5F5', height: 20 });
  fila('POR PROCESAR     cotizaciones nuevas',          { color: '#3D7038' });
  fila('OCURRE HOY       recordatorios y cierres',      { color: '#111111' });
  fila('EN SEGUIMIENTO   activos en curso',              { color: '#555555' });
  fila('PAUSADOS         congelados (sin recordatorios)',{ color: '#AAAAAA' });
  fila('',                { height: 6 });

  // ── Flujo (cotizaciones nuevas)
  fila('FLUJO — cotizaciones nuevas', { bold: true, size: 9, color: '#888888', bg: '#F5F5F5', height: 20 });
  fila('Deal + correo     crea deal y envia email al cliente', { color: '#111111' });
  fila('Deal sin correo   crea deal, sin email',               { color: '#111111' });
  fila('No procesar       excluye sin crear nada',             { color: '#111111' });
  fila('',                { height: 6 });

  // ── Acción (seguimiento)
  fila('ACCION — en seguimiento', { bold: true, size: 9, color: '#888888', bg: '#F5F5F5', height: 20 });
  fila('Seguir        flujo normal (recordatorio o cierre)',    { color: '#111111' });
  fila('Saltar hoy    omite recordatorio de hoy',              { color: '#111111' });
  fila('Pausar        congela sin cerrar',                     { color: '#111111' });
  fila('Excluir       borra de HubSpot (pide confirmacion)',   { color: '#111111' });
  fila('',                { height: 6 });

  // ── Si algo falla
  fila('SI ALGO FALLA', { bold: true, size: 9, color: '#888888', bg: '#F5F5F5', height: 20 });
  fila('Menu Cotizaciones → acciones manuales',             { color: '#111111' });
  fila('ENVIOS: OFF = no sale nada al cliente',             { color: '#b00020' });
  fila('Soporte: ventas@ejemplo.com',                         { color: '#888888', size: 9 });
}

/** Devuelve el blob del logo desde Drive, o null si no está configurado. */
function _logoBlob_() {
  var id = PropertiesService.getScriptProperties().getProperty('LOGO_FILE_ID') || '';
  if (!id) return null;
  try { return DriveApp.getFileById(id).getBlob().setName('logo.png'); } catch (e) { return null; }
}

/** Formatea monto en pesos chilenos: $1.234.567 */
function _mFmt_(m) { return '$' + Number(m).toLocaleString('es-CL'); }

/**
 * Cabecera del email: logo a la izquierda, titulo + fecha a la derecha.
 * logoHtml = '<img src="cid:logoEmpresa"...>' o texto fallback 'MI EMPRESA'.
 */
function _emailHdr_(logoHtml, titulo, fecha) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;color:#111111;">'
    + '<div style="padding:28px 0 20px 0;border-bottom:1px solid #E8E8E8;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    +   '<td style="vertical-align:bottom;">' + logoHtml + '</td>'
    +   '<td style="vertical-align:bottom;text-align:right;">'
    +     '<p style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#AAAAAA;margin:0 0 5px 0;">' + titulo + '</p>'
    +     '<p style="font-size:15px;font-weight:normal;color:#111111;margin:0;">' + fecha + '</p>'
    +   '</td>'
    + '</tr></table>'
    + '</div>';
}

/** Pie del email. Cierra también el div contenedor principal. */
function _emailFtr_() {
  return '<div style="border-top:1px solid #E8E8E8;padding-top:14px;margin-top:36px;">'
    + '<p style="font-size:11px;color:#CCCCCC;margin:0;">Sistema Cotizaciones &middot; Mi Empresa</p>'
    + '</div></div>';
}

/**
 * Tabla minimalista.
 * headers: array de strings. La primera columna se renderiza en gris (#888), la ultima a la derecha.
 * filas: array de arrays de strings (una por celda).
 */
function _emailTabla_(headers, filas) {
  var TH   = 'text-align:left;padding:0 16px 8px 0;font-size:10px;font-weight:bold;letter-spacing:0.8px;color:#AAAAAA;border-bottom:1px solid #111111;text-transform:uppercase;white-space:nowrap;';
  var TH_R = 'text-align:right;padding:0 0 8px 0;font-size:10px;font-weight:bold;letter-spacing:0.8px;color:#AAAAAA;border-bottom:1px solid #111111;text-transform:uppercase;';
  var TD   = 'padding:11px 16px 11px 0;font-size:13px;color:#111111;border-bottom:1px solid #F0F0F0;';
  var TD_N = 'padding:11px 16px 11px 0;font-size:12px;color:#888888;border-bottom:1px solid #F0F0F0;';
  var TD_R = 'padding:11px 0;font-size:13px;color:#111111;text-align:right;border-bottom:1px solid #F0F0F0;';

  var html = '<table style="width:100%;border-collapse:collapse;"><tr>';
  headers.forEach(function(h, i) {
    html += '<th style="' + (i === headers.length - 1 ? TH_R : TH) + '">' + h + '</th>';
  });
  html += '</tr>';

  if (!filas.length) {
    html += '<tr><td colspan="' + headers.length + '" style="padding:14px 0;font-size:13px;color:#CCCCCC;">Ninguna</td></tr>';
  }
  filas.forEach(function(celdas) {
    html += '<tr>';
    celdas.forEach(function(v, i) {
      var esLast  = (i === celdas.length - 1);
      var esFirst = (i === 0);
      html += '<td style="' + (esLast ? TD_R : esFirst ? TD_N : TD) + '">' + (v || '') + '</td>';
    });
    html += '</tr>';
  });
  html += '</table>';
  return html;
}

/** Seccion con etiqueta en verde + contador + contenido (tabla o parrafo). */
function _emailSeccion_(label, count, contenido) {
  return '<div style="margin-top:28px;">'
    + '<p style="font-size:10px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#3D7038;margin:0 0 12px 0;">'
    + label + ' &mdash; ' + count + '</p>'
    + contenido
    + '</div>';
}
