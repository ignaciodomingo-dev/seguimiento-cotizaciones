/****************************************************
 * HERRAMIENTAS DE SEGURIDAD / DIAGNÓSTICO (uso manual)
 *
 * Se ejecutan a mano desde el editor; NO tienen triggers.
 *   - frenarSeguimientoActivas / ...Real : congela (Control "Respondida") todo lo activo.
 *   - validarMotor                        : foto de solo lectura del estado del motor.
 *
 * (El antiguo motor de migración P→Etapa/W y las herramientas del incidente de junio
 *  se eliminaron tras cumplir su función.)
 ****************************************************/

/**
 * CONGELAR SEGUIMIENTO ACTIVO. Marca Control = "Respondida" en TODAS las filas en
 * seguimiento activo (Etapa "Cotizando" + Control vacío + Deal ID): salen de GAS #2
 * (recordatorios) y GAS #3 (cierre). NO toca HubSpot ni envía correos. Reversible
 * (borra la celda Control para reactivar).
 *
 * Uso: corre frenarSeguimientoActivas() (dryRun = solo lista). Si está bien,
 * frenarSeguimientoActivasReal().
 */
function frenarSeguimientoActivas(dryRun) {
  if (dryRun === undefined) dryRun = true;
  var hoja = getWorkSS().getSheetByName('Cotizaciones Vendedor');
  if (!hoja) { Logger.log('No existe "Cotizaciones Vendedor".'); return; }

  var last = hoja.getLastRow();
  if (last < 2) { Logger.log('Sin datos.'); return; }
  var datos = hoja.getRange(2, 1, last - 1, 23).getValues();
  var hoy = Date.now();
  var frenadas = 0;

  Logger.log('===== FRENAR SEGUIMIENTO ACTIVO ' + (dryRun ? '(DRY-RUN, no escribe)' : '(REAL)') + ' =====');
  for (var i = 0; i < datos.length; i++) {
    var f = datos[i];
    if (!enSeguimientoActivo_(f)) continue;
    var fe = aFecha_(f[0]);
    var edad = fe ? Math.round((hoy - fe.getTime()) / 86400000) : '?';
    Logger.log('   COT ' + f[2] + ' (' + edad + 'd) -> Control "Respondida"');
    if (!dryRun) hoja.getRange(i + 2, COL_CONTROL + 1).setValue('Respondida');
    frenadas++;
  }
  if (!dryRun) SpreadsheetApp.flush();
  Logger.log((dryRun ? 'Se frenarían: ' : 'Frenadas: ') + frenadas + ' filas.' +
    (dryRun ? ' Si está bien, corre frenarSeguimientoActivasReal().' : ''));
}

/** Ejecuta el congelado de verdad (escribe Control "Respondida"). */
function frenarSeguimientoActivasReal() { frenarSeguimientoActivas(false); }

/**
 * VALIDACIÓN DEL MOTOR (solo lectura). Foto del estado antes de reactivar:
 * cuántas cotizaciones procesaría GAS #1, cuántas "Cotizando" viejas hay, filas con
 * deal pero sin etapa, y deals compartidos por varias filas.
 */
function validarMotor() {
  var hoja = getWorkSS().getSheetByName('Cotizaciones Vendedor');
  if (!hoja) { Logger.log('No existe la hoja.'); return; }
  var last = hoja.getLastRow();
  if (last < 2) { Logger.log('Sin datos.'); return; }
  var datos = hoja.getRange(2, 1, last - 1, 23).getValues();
  var hoy = Date.now();

  var nuevas = [], cotizandoViejas = [], dealSinEtapa = 0, dealIds = {};
  datos.forEach(function(f) {
    var etapa = String(f[COL_ETAPA] || '').trim();
    var control = String(f[COL_CONTROL] || '').trim();
    var deal = String(f[COL_DEALID] || '').trim();
    var fe = aFecha_(f[0]);
    var edad = fe ? (hoy - fe.getTime()) / 86400000 : null;

    if (etapa === '' && control === '' && deal === '' && edad !== null && edad < CONFIG_HS.DIAS_MAX_PARA_PROCESAR &&
        Number(f[12]) > CONFIG_HS.MONTO_MINIMO && CONFIG_HS.VENDEDORES_VALIDOS.indexOf(String(f[9]).trim()) !== -1) {
      nuevas.push('COT ' + f[2] + ' (' + Math.round(edad) + 'd, $' + Number(f[12]).toLocaleString('es-CL') + ')');
    }
    if (etapa === ETAPA_COTIZANDO && control === '' && deal && edad !== null && edad > 14) {
      cotizandoViejas.push('COT ' + f[2] + ' (' + Math.round(edad) + 'd)');
    }
    if (deal && etapa === '') dealSinEtapa++;
    if (deal) dealIds[deal] = (dealIds[deal] || 0) + 1;
  });
  var compartidos = Object.keys(dealIds).filter(function(d) { return dealIds[d] > 1; }).length;

  Logger.log('===== VALIDACIÓN DEL MOTOR (solo lectura) =====');
  Logger.log('1) GAS #1 procesaría (Por procesar) a: ' + nuevas.length + ' cotizaciones');
  nuevas.slice(0, 30).forEach(function(x) { Logger.log('     ' + x); });
  Logger.log('2) "Cotizando" VIEJAS (>14d): ' + cotizandoViejas.length);
  cotizandoViejas.slice(0, 40).forEach(function(x) { Logger.log('     ' + x); });
  Logger.log('3) Filas con Deal pero sin Etapa: ' + dealSinEtapa);
  Logger.log('4) Deals compartidos por varias filas (vinculados): ' + compartidos);
}
