/**
 * PROCESO PRINCIPAL: FILTRADO + CONTACTO + DEAL
 * Sincroniza cotizaciones con HubSpot y activa el seguimiento automático.
 * Crea tarea de llamada T+1 en HubSpot para deals con monto > $500.000 CLP.
 */
const CONFIG_HS = {
  HOJA_NOMBRE: "Cotizaciones Vendedor",
  TIMEZONE: "America/Santiago",
  OWNER_ID: HS_OWNER_ID,
  PIPELINE: "default",
  DEAL_STAGE: "decisionmakerboughtin",
  CATEGORIA_CLIENTE: HS_CATEGORIA_CLIENTE,
  MONTO_MINIMO: 100000,
  MONTO_TAREA_LLAMADA: 500000,
  VENDEDORES_VALIDOS: VENDEDORES_VALIDOS_GLOBAL,
  DIAS_CIERRE_ESTIMADO: 8,
  DIAS_MAX_PARA_PROCESAR: 10 // GUARDA: solo se crean deal/correo para cotizaciones recientes
};

/**
 * Procesa las cotizaciones "Por procesar" según su Flujo (col X).
 * @param {Object} [opts]
 *   opts.soloAntiguasHrs {number} si se pasa, solo procesa las que llevan más de N horas
 *     "Por procesar" (las recién entradas se dejan para que tú decidas). Es el modo RESPALDO.
 *   opts.forzarSinCorreo {boolean} si true, NUNCA manda el correo inicial (modo RESPALDO).
 * Sin opts = modo BOTÓN: procesa todas las pendientes respetando el Flujo de cada una.
 */
function procesarCotizacionesNuevas(opts) {
  opts = opts || {};
  const soloAntiguasHrs = opts.soloAntiguasHrs || null;
  const forzarSinCorreo = !!opts.forzarSinCorreo;

  // Lock para evitar ejecuciones concurrentes que dupliquen deals
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log("Otra instancia en curso. Saliendo.");
    return;
  }

  try {
    const ss = getWorkSS();
    const hoja = ss.getSheetByName(CONFIG_HS.HOJA_NOMBRE);

    if (!hoja) {
      Logger.log("Error: No se encuentra la hoja '" + CONFIG_HS.HOJA_NOMBRE + "'.");
      return;
    }

    asegurarColumnasNuevas_(hoja);
    asegurarHojaExcluir_(ss);
    const excluidas = cotizacionesExcluidas_();
    const conPedido = cotizacionesConPedido_(); // N° que ya tienen pedido → no son "nuevas por cotizar"

    const ultimaFila = hoja.getLastRow();
    if (ultimaFila < 2) return;

    const datos = hoja.getRange(1, 1, ultimaFila, 25).getValues(); // hasta col Y (Ingreso)
    const filasParaProcesar = [];

    for (let i = 1; i < datos.length; i++) {
      const fila = datos[i];
      const vendedor = String(fila[9]).trim();
      const montoTotal = Number(fila[12]);
      const etapa = String(fila[COL_ETAPA] || "").trim();
      const control = String(fila[COL_CONTROL] || "").trim();
      const dealId = String(fila[COL_DEALID] || "").trim();
      const flujo = String(fila[COL_FLUJO] || "").trim();
      const fechaEmision = aFecha_(fila[0]);

      // GUARDA DE SEGURIDAD: solo cotizaciones RECIENTES. Una cotización antigua nunca es
      // "nueva"; si aparece como tal es un error de datos y NO se procesa (ni deal ni correo).
      const reciente = fechaEmision && (Date.now() - fechaEmision.getTime()) < CONFIG_HS.DIAS_MAX_PARA_PROCESAR * 86400000;

      // Cotización "Por procesar" = reciente + sin Etapa, sin Control y sin Deal ID.
      if (
        reciente &&
        CONFIG_HS.VENDEDORES_VALIDOS.includes(vendedor) &&
        montoTotal > CONFIG_HS.MONTO_MINIMO &&
        etapa === "" && control === "" && dealId === ""
      ) {
        // "No procesar" (Flujo) o pestaña "Excluir" → no crea deal ni email.
        if (flujo === 'No procesar' || excluidas[String(fila[2]).trim()]) {
          hoja.getRange(i + 1, COL_CONTROL + 1).setValue("Excluida"); // col W
          continue;
        }
        // Si la cotización YA tiene un pedido, no es una "nueva por cotizar": no se crea deal en
        // Cotizando ni se manda la cotización (el cliente ya compró). La maneja el cruce / Revisión manual.
        if (conPedido[String(fila[2]).replace(/\D/g, '').replace(/^0+/, '')]) continue;
        // Modo RESPALDO: solo las que llevan más de N horas sin decidir; el resto esperan al botón.
        if (soloAntiguasHrs) {
          const ingreso = (fila[COL_INGRESO] instanceof Date) ? fila[COL_INGRESO] : aFecha_(fila[COL_INGRESO]);
          const refMs = ingreso ? ingreso.getTime() : (fechaEmision ? fechaEmision.getTime() : Date.now());
          if ((Date.now() - refMs) < soloAntiguasHrs * 3600000) continue;
        }
        filasParaProcesar.push({ indiceOriginal: i + 1, datos: fila, flujo: flujo });
      }
    }

    if (filasParaProcesar.length === 0) {
      Logger.log("No hay cotizaciones nuevas que cumplan los requisitos.");
      return;
    }

    const grupos = agruparCotizaciones_(filasParaProcesar);
    const token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');

    if (!token) throw new Error("Falta HUBSPOT_TOKEN en Propiedades del Script.");

    for (const llave in grupos) {
      const grupo = grupos[llave];
      try {
        const fp = grupo.datosPrincipales;
        // N° principal = el de datosPrincipales (la cotización de N° MÁS ALTO del grupo,
        // que agruparCotizaciones_ ya rastrea). Antes se usaba numerosCot[último], que solo
        // coincide si las filas vienen ordenadas.
        const numeroCotPrincipal = String(fp[2]);

        const contactoId = buscarOCrearContacto_(String(fp[7]).trim(), String(fp[5]).trim(), String(fp[4]).trim(), token);

        // C1 — Idempotencia: si ya existe un deal con este N° en HubSpot (porque la corrida
        // anterior creó el deal pero falló al escribir la hoja), reusar en vez de duplicar.
        const dealExistente = _buscarDealPorCot_(numeroCotPrincipal, token);
        const dealId = dealExistente || crearDealHubSpot_(grupo, contactoId, token);

        if (dealId) {
          actualizarFilasExito_(hoja, grupo, dealId);

          if (!dealExistente) {
            // Deal recién creado: tarea de llamada + correo inicial.
            crearTareaLlamada_(grupo, dealId, token);
            const enviarCorreo = enviosActivos_() && !forzarSinCorreo && grupo.flujoPrincipal !== 'Deal sin correo';
            if (enviarCorreo) {
              enviarEmailInicial_(hoja, grupo, dealId);
            } else {
              const motivo = !enviosActivos_() ? 'envíos OFF (ENVIOS_ACTIVOS)'
                : (forzarSinCorreo ? 'respaldo' : (grupo.flujoPrincipal || '-'));
              Logger.log("Deal " + dealId + " creado SIN correo inicial (" + motivo + ").");
            }
          } else {
            // Deal ya existía: solo se actualizó la hoja. No re-enviar correo ni tarea.
            Logger.log("Deal existente reutilizado: " + dealId + " (COT " + numeroCotPrincipal + "). Solo se actualizó la hoja.");
          }
        }
        Utilities.sleep(250);
      } catch (e) {
        Logger.log("Error en grupo " + llave + ": " + e.message);
        alertarError_('creación de deal/email', e.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * LÓGICA DE DEALS (buscarOCrearContacto_ unificado vive en el núcleo, _config_ids.gs)
 */
function crearDealHubSpot_(grupo, contactoId, token) {
  const closeDate = new Date();
  closeDate.setDate(closeDate.getDate() + CONFIG_HS.DIAS_CIERRE_ESTIMADO);

  const empresa = Array.from(grupo.nombresEmpresa)[0] || "Sin Empresa";
  const numeroCotPrincipal = String(grupo.datosPrincipales[2]); // N° más alto del grupo

  const payload = {
    properties: {
      dealname: empresa + " - COT " + numeroCotPrincipal,
      amount: Math.round(grupo.montoUltimaCotiz).toString(),
      pipeline: CONFIG_HS.PIPELINE,
      dealstage: CONFIG_HS.DEAL_STAGE,
      hubspot_owner_id: CONFIG_HS.OWNER_ID,
      numero_de_cotizacion: numeroCotPrincipal,
      categoria_de_cliente: CONFIG_HS.CATEGORIA_CLIENTE,
      closedate: Utilities.formatDate(closeDate, CONFIG_HS.TIMEZONE, "yyyy-MM-dd")
    },
    associations: contactoId ? [{
      to: { id: contactoId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }]
    }] : []
  };

  const res = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/objects/deals", {
    method: 'post',
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 201) {
    throw new Error("Error creando deal (HTTP " + res.getResponseCode() + "): " + res.getContentText());
  }

  const json = JSON.parse(res.getContentText());
  if (!json.id) throw new Error("Respuesta sin id en creación de deal: " + res.getContentText());
  return json.id;
}

/**
 * HELPERS
 */
function agruparCotizaciones_(filas) {
  const grupos = {};
  filas.forEach(item => {
    const f = item.datos;
    const fecha = f[0] instanceof Date
      ? Utilities.formatDate(f[0], CONFIG_HS.TIMEZONE, "yyyy-MM-dd")
      : String(f[0]);

    // Llave: Email + Fecha (un negocio por cliente al día)
    const llave = f[7] + "_" + fecha;

    if (!grupos[llave]) {
      grupos[llave] = {
        filas: [],
        montoUltimaCotiz: 0,
        montoMaxGrupo: 0,   // monto más alto de cualquier cotización del grupo (para umbral de llamada)
        nombresEmpresa: new Set(),
        numerosCot: [],
        cotizaciones: [],
        datosPrincipales: f,
        numeroCotMaximo: 0,
        flujoPrincipal: ''
      };
    }

    grupos[llave].filas.push(item.indiceOriginal);
    grupos[llave].montoMaxGrupo = Math.max(grupos[llave].montoMaxGrupo, Number(f[12]) || 0);
    grupos[llave].nombresEmpresa.add(String(f[4]));
    grupos[llave].numerosCot.push(String(f[2]));
    grupos[llave].cotizaciones.push({
      num: String(f[2]), monto: Number(f[12]) || 0, detalle: f[20], clave: f[14]
    });

    // Gana la cotización con número MÁS ALTO (más reciente),
    // independiente del orden de las filas en la hoja.
    const numActual = Number(f[2]) || 0;
    if (numActual >= grupos[llave].numeroCotMaximo) {
      grupos[llave].numeroCotMaximo = numActual;
      grupos[llave].montoUltimaCotiz = Number(f[12]);
      grupos[llave].datosPrincipales = f;
      grupos[llave].flujoPrincipal = item.flujo || '';  // el flujo de la cotización que define el deal
    }
  });
  return grupos;
}

/**
 * RESPALDO: procesa las cotizaciones que llevan más de RESPALDO_HORAS "Por procesar"
 * sin que las hayas decidido. Crea el deal y arranca el seguimiento, pero NUNCA manda
 * el correo inicial (conservador: no reenvía una cotización que quizá ya enviaste tú).
 * Respeta "No procesar". Corre por trigger horario.
 */
function procesarRespaldoSinCorreo() {
  procesarCotizacionesNuevas({ soloAntiguasHrs: RESPALDO_HORAS, forzarSinCorreo: true });
}

function actualizarFilasExito_(hoja, grupo, dealId) {
  // Todas las filas del grupo: Etapa "Cotizando" + Deal ID. La primera sin Control
  // (queda en seguimiento); las demás con Control "Vinculada" (comparten deal, sin
  // seguimiento propio).
  grupo.filas.forEach((indice, idx) => {
    hoja.getRange(indice, COL_ETAPA + 1).setValue(ETAPA_COTIZANDO);                  // col P
    hoja.getRange(indice, COL_DEALID + 1).setValue(dealId);                          // col Q
    hoja.getRange(indice, COL_CONTROL + 1).setValue(idx === 0 ? "" : "Vinculada");   // col W
  });
}

/** Asegura los encabezados "Etapa" (col P) y "Control" (col W). */
function asegurarColumnasNuevas_(hoja) {
  if (String(hoja.getRange(1, COL_ETAPA + 1).getValue()).trim() !== 'Etapa') {
    hoja.getRange(1, COL_ETAPA + 1).setValue('Etapa').setFontWeight('bold');
  }
  if (String(hoja.getRange(1, COL_CONTROL + 1).getValue()).trim() !== 'Control') {
    hoja.getRange(1, COL_CONTROL + 1).setValue('Control').setFontWeight('bold');
  }
  if (String(hoja.getRange(1, COL_FLUJO + 1).getValue()).trim() !== 'Flujo') {
    hoja.getRange(1, COL_FLUJO + 1).setValue('Flujo').setFontWeight('bold');
  }
  if (String(hoja.getRange(1, COL_INGRESO + 1).getValue()).trim() !== 'Ingreso') {
    hoja.getRange(1, COL_INGRESO + 1).setValue('Ingreso').setFontWeight('bold');
  }
  if (String(hoja.getRange(1, COL_SALTAR + 1).getValue()).trim() !== 'Saltar hasta') {
    hoja.getRange(1, COL_SALTAR + 1).setValue('Saltar hasta').setFontWeight('bold');
  }
}

/** Crea la pestaña "Excluir" si no existe (col A = N° Cotización a excluir, una por fila). */
function asegurarHojaExcluir_(ss) {
  var hoja = ss.getSheetByName('Excluir');
  if (!hoja) {
    hoja = ss.insertSheet('Excluir');
    hoja.getRange(1, 1).setValue('N° Cotización a excluir (una por fila)').setFontWeight('bold').setBackground('#7f1d1d').setFontColor('#FFFFFF');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

/** Set { N° cotización: true } desde la pestaña "Excluir". Tolera "COT52600" y ceros a la izquierda. */
function cotizacionesExcluidas_() {
  var set = {};
  var hoja = getWorkSS().getSheetByName('Excluir');
  if (!hoja || hoja.getLastRow() < 2) return set;
  hoja.getRange(2, 1, hoja.getLastRow() - 1, 1).getValues().forEach(function(r) {
    var v = String(r[0] || '').replace(/\D/g, '');
    if (v) set[String(Number(v))] = true;
  });
  return set;
}

/**
 * Crea tarea de llamada en HubSpot T+1 si el monto del grupo supera $500.000 CLP.
 * Solo crea la tarea; no bloquea el flujo si falla.
 * Asociación task→deal: associationTypeId 216 (HUBSPOT_DEFINED).
 */
function crearTareaLlamada_(grupo, dealId, token) {
  // Usar el monto más alto del grupo: si hay varias cotizaciones, la más cara define si hay llamada.
  if ((grupo.montoMaxGrupo || grupo.montoUltimaCotiz) <= CONFIG_HS.MONTO_TAREA_LLAMADA) return;

  const f = grupo.datosPrincipales;
  const empresa = Array.from(grupo.nombresEmpresa)[0] || "Sin empresa";
  const contacto = String(f[5]).trim();
  const email = String(f[7]).trim();
  const numeroCot = String(grupo.datosPrincipales[2]); // N° más alto del grupo
  const montoFormato = "$" + Number(grupo.montoUltimaCotiz).toLocaleString('es-CL');

  const manana = calcularFechaHabil_(new Date(), 1); // T+1 día hábil (salta fines de semana y festivos)
  manana.setHours(10, 0, 0, 0);

  const payload = {
    properties: {
      hs_task_subject: "Llamar a " + empresa + " — COT " + numeroCot,
      hs_task_body: [
        "Empresa: " + empresa,
        "Contacto: " + contacto,
        "Email: " + email,
        "Cotización: " + numeroCot,
        "Monto: " + montoFormato
      ].join("\n"),
      hs_task_type: "CALL",
      hs_timestamp: manana.getTime().toString(),
      hubspot_owner_id: CONFIG_HS.OWNER_ID,
      hs_task_priority: "HIGH"
    },
    associations: [{
      to: { id: dealId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 216 }]
    }]
  };

  try {
    const res = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/objects/tasks", {
      method: 'post',
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 201) {
      Logger.log("Error creando tarea de llamada (HTTP " + res.getResponseCode() + "): " + res.getContentText());
    } else {
      Logger.log(" Tarea de llamada T+1 creada para deal " + dealId + " (" + montoFormato + ")");
    }
  } catch (e) {
    Logger.log("Error al crear tarea de llamada: " + e.message);
  }
}

/**
 * Envía el email INICIAL (día 0) al cliente con el PDF de la cotización adjunto,
 * y guarda el Thread ID en col R para la detección de respuestas de GAS #2.
 * Mismo asunto que los seguimientos → Gmail agrupa día 3 y 7 en este hilo.
 * No bloquea el flujo: cualquier error se loguea y sigue (el deal ya está creado).
 */
function enviarEmailInicial_(hoja, grupo, dealId) {
  try {
    const f = grupo.datosPrincipales;
    const email = String(f[7] || '').trim();
    if (!email) {
      Logger.log("Sin email cliente, no se envía inicial (deal " + dealId + ").");
      return;
    }

    const numeroCot = String(f[2]); // principal (N° más alto del grupo): define asunto/hilo
    const nombre = String(f[5] || '').trim();
    const asunto = asuntoCotizacion_(numeroCot);

    // Todas las cotizaciones del grupo (vinculadas incluidas) van en el mismo correo.
    const cots = (grupo.cotizaciones && grupo.cotizaciones.length)
      ? grupo.cotizaciones
      : [{ num: numeroCot, monto: Number(grupo.montoUltimaCotiz) || 0, detalle: f[20], clave: f[14] }];

    const cuerpoHTML = cots.length === 1
      ? cuerpoEmailInicialHTML_(nombre, cots[0].num, "$" + Number(cots[0].monto).toLocaleString('es-CL'), cots[0].detalle)
      : cuerpoEmailInicialGrupalHTML_(nombre, cots);

    const opciones = { htmlBody: cuerpoHTML };
    const bcc = PropertiesService.getScriptProperties().getProperty('HUBSPOT_BCC');
    if (bcc) opciones.bcc = bcc;

    // Un PDF por cada cotización del grupo.
    const attachments = [];
    cots.forEach(function(c) {
      var pdf = obtenerBlobPdfCotizacion_(c.clave, c.num);
      if (pdf) attachments.push(pdf);
    });
    if (attachments.length) opciones.attachments = attachments;
    else Logger.log(" Email inicial SIN PDF adjunto (deal " + dealId + ").");

    GmailApp.sendEmail(email, asunto, "", opciones);
    Logger.log(" Email inicial enviado a " + email + " (deal " + dealId +
      (attachments.length ? ", con " + attachments.length + " PDF)" : ", sin PDF)"));

    // Guardar Thread ID en col R de la fila principal (primera del grupo = "Activa").
    // Reintento: Gmail puede tardar unos segundos en indexar el mensaje recién enviado.
    Utilities.sleep(1500);
    var hilos = GmailApp.search('to:' + email + ' subject:"' + asunto + '" newer_than:1d');
    if (!hilos.length) {
      Utilities.sleep(3000);
      hilos = GmailApp.search('to:' + email + ' subject:"' + asunto + '" newer_than:1d');
    }
    const threadId = hilos.length > 0 ? hilos[0].getId() : 'ID_' + Date.now();
    hoja.getRange(grupo.filas[0], 18).setValue(threadId); // col R
  } catch (e) {
    Logger.log("Error enviando email inicial (deal " + dealId + "): " + e.message);
  }
}

/**
 * C1 — Idempotencia: busca en HubSpot si ya existe un deal con numero_de_cotizacion = numeroCot.
 * Devuelve el ID del deal si existe, o null si no.
 * Si la búsqueda falla (timeout/quota), devuelve null y deja que el flujo normal cree el deal.
 */
function _buscarDealPorCot_(numeroCot, token) {
  try {
    var res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      payload: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'numero_de_cotizacion', operator: 'EQ', value: String(numeroCot) }] }],
        properties: ['numero_de_cotizacion'],
        limit: 1
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      var data = JSON.parse(res.getContentText());
      if (data.total > 0) {
        Logger.log('_buscarDealPorCot_: deal existente COT ' + numeroCot + ' → ID ' + data.results[0].id);
        return data.results[0].id;
      }
    }
  } catch (e) {
    Logger.log('_buscarDealPorCot_ error (COT ' + numeroCot + '): ' + e.message);
  }
  return null;
}

// Los triggers de entrada (respaldo) se crean desde configurarTodosLosTriggers (_triggers.gs).
// NO debe existir un trigger horario de procesarCotizacionesNuevas: correría en "modo botón"
// y mandaría correos saltándose la compuerta del panel.
