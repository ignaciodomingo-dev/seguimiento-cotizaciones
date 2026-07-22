/**
 * SISTEMA DE SEGUIMIENTO AUTOMÁTICO (GAS #2)
 *
 * Cambios respecto a versión anterior:
 * - Día 7: verifica si el cliente respondió al hilo de Gmail antes de enviar.
 * - Día 7: verifica que el deal siga en etapa "Cotizando" en HubSpot antes de enviar.
 * - Día 7: se envía como respuesta al hilo del día 3 (no como email nuevo).
 */

const CONFIG_SEG = {
  HOJA_NOMBRE: "Cotizaciones Vendedor",
  TIMEZONE: "America/Santiago",
  DIAS_MAX_SEGUIMIENTO: 14, // GUARDA: no seguir cotizaciones mas antiguas que esto (dia 3/7 solo aplica a recientes)
  URL_BASE_HS: "https://api.hubapi.com/crm/v3/objects/deals/",
  DEAL_STAGE_COTIZANDO: "decisionmakerboughtin"
  // ESTILO_NARROW_ definida en _email_comun.gs (compartido en el proyecto).
};

// FESTIVOS_CL y calcularFechaHabil_/esDiaHabil_ viven en el núcleo (_config_ids.gs).

function procesarSeguimientos() {
  // INTERRUPTOR GLOBAL: si los envíos no están activos, no se manda ningún recordatorio.
  if (!enviosActivos_()) { Logger.log("Envíos OFF (ENVIOS_ACTIVOS != SI). No se envían seguimientos."); return; }

  const ahora = new Date();

  // Verificar horario laboral (L-V 9-18h hora Chile)
  const dia = ahora.getDay();
  const hora = parseInt(Utilities.formatDate(ahora, CONFIG_SEG.TIMEZONE, "H"), 10);
  if (dia === 0 || dia === 6 || hora < 9 || hora >= 18) {
    Logger.log("Fuera de horario laboral. Saliendo...");
    return;
  }

  const ss = getWorkSS();
  const hoja = ss.getSheetByName(CONFIG_SEG.HOJA_NOMBRE);
  if (!hoja) {
    Logger.log("Error: No se encontró la hoja " + CONFIG_SEG.HOJA_NOMBRE);
    return;
  }

  const propiedades = PropertiesService.getScriptProperties();
  const token = propiedades.getProperty('HUBSPOT_TOKEN');
  const bcc = propiedades.getProperty('HUBSPOT_BCC');
  if (!token || !bcc) throw new Error("Falta configuración de HubSpot en Propiedades.");

  // Lock: dos corridas solapadas (trigger horario + ejecución manual) leerían las mismas
  // filas antes de que la otra marque S/T y duplicarían correos. El lock se libera solo
  // al terminar la ejecución.
  const lockSeg = LockService.getScriptLock();
  if (!lockSeg.tryLock(30000)) {
    Logger.log("Otra instancia de seguimientos en curso. Saliendo.");
    return;
  }

  const datos = hoja.getDataRange().getValues();
  const hoySinHora = new Date();
  hoySinHora.setHours(0, 0, 0, 0);

  // Cotizaciones que ya tienen un pedido (cualquier estado) → NO se les envía seguimiento.
  const cotsConPedido = cotizacionesConPedido_();

  // N° ya enviados en ESTA corrida: si la hoja trae filas duplicadas del mismo N°
  // (p. ej. re-descarga de Bsale con otro docId), solo la primera envía.
  const cotsEnviadasCorrida = {};

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const nFila = i + 1;

    // Solo filas en seguimiento activo: Etapa "Cotizando" + Control vacío + con Deal ID.
    if (!enSeguimientoActivo_(fila)) continue;

    // Si la cotización ya tiene un pedido (incluido Pendiente de Pago), no enviar: el cliente ya compró.
    if (cotsConPedido[String(fila[2]).replace(/\D/g, '').replace(/^0+/, '')]) continue;

    // "Saltar hoy" del panel: la col Z ("Saltar hasta") guarda la fecha en la HOJA REAL,
    // así la marca sobrevive aunque el panel se refresque (antes vivía solo en el desplegable).
    const saltarHasta = fila.length > COL_SALTAR ? aFecha_(fila[COL_SALTAR]) : null;
    if (saltarHasta) {
      saltarHasta.setHours(0, 0, 0, 0);
      if (hoySinHora.getTime() <= saltarHasta.getTime()) continue;
    }

    const fechaEmision = aFecha_(fila[0]);
    if (!fechaEmision) {
      Logger.log("Fila " + nFila + ": fecha de emisión inválida");
      continue;
    }

    // GUARDA DE SEGURIDAD: el seguimiento (día 3/7) solo aplica a cotizaciones recientes.
    // Una cotización antigua nunca debe recibir un recordatorio "día 3".
    if ((Date.now() - fechaEmision.getTime()) > CONFIG_SEG.DIAS_MAX_SEGUIMIENTO * 86400000) continue;

    const fechaToca3 = calcularFechaHabil_(fechaEmision, 3);
    const fechaToca7 = calcularFechaHabil_(fechaEmision, 7);

    // fila[18] = Fecha día 3 enviado (col S), fila[19] = Fecha día 7 enviado (col T)
    let enviarMail = false;
    let esDia3 = false;

    if (hoySinHora >= fechaToca3 && !fila[18]) {
      esDia3 = true;
      enviarMail = true;
    } else if (hoySinHora >= fechaToca7 && !fila[19]) {
      esDia3 = false;
      enviarMail = true;
    }

    if (!enviarMail) continue;

    // Dedup por N° dentro de la corrida (filas duplicadas → un solo correo).
    const numCotFila = String(fila[2]).trim();
    if (cotsEnviadasCorrida[numCotFila]) {
      Logger.log("Fila " + nFila + ": N° " + numCotFila + " ya envió en esta corrida (fila duplicada). Se omite.");
      continue;
    }
    cotsEnviadasCorrida[numCotFila] = true;

    try {
      // Consultar HubSpot (agrega dealstage para verificación en día 7)
      const res = UrlFetchApp.fetch(
        CONFIG_SEG.URL_BASE_HS + fila[16] + "?properties=numero_de_cotizacion,amount,dealstage",
        {
          headers: { "Authorization": "Bearer " + token },
          muteHttpExceptions: true
        }
      );

      if (res.getResponseCode() !== 200) {
        Logger.log("Error al consultar HubSpot fila " + nFila + " (HTTP " + res.getResponseCode() + ")");
        continue;
      }

      const deal = JSON.parse(res.getContentText()).properties;

      if (!deal.amount || !deal.numero_de_cotizacion) {
        Logger.log("Fila " + nFila + ": faltan numero_de_cotizacion o amount en HubSpot");
        continue;
      }

      // --- Checks previos exclusivos del día 7 ---
      if (!esDia3) {
        // Check 1: el deal debe seguir en "Cotizando". Si lo movieron manualmente, no enviar.
        if (deal.dealstage && deal.dealstage !== CONFIG_SEG.DEAL_STAGE_COTIZANDO) {
          Logger.log("Fila " + nFila + ": deal ya no está en Cotizando (" + deal.dealstage + "). Marcando Respondida.");
          hoja.getRange(nFila, COL_CONTROL + 1).setValue("Respondida"); // col W (Control)
          continue;
        }

        // Check 2: si el cliente respondió al hilo del día 3, no enviar.
        const threadId = String(fila[17] || "").trim(); // col R = Thread ID día 3
        if (threadId && !threadId.startsWith("ID_")) {
          try {
            const thread = GmailApp.getThreadById(threadId);
            if (thread) {
              const emailCliente = String(fila[7]).trim().toLowerCase();
              const respondio = thread.getMessages().some(m =>
                m.getFrom().toLowerCase().includes(emailCliente)
              );
              if (respondio) {
                Logger.log("Fila " + nFila + ": cliente respondió por email. Marcando Respondida.");
                hoja.getRange(nFila, COL_CONTROL + 1).setValue("Respondida"); // col W (Control)
                continue;
              }
            }
          } catch (eThread) {
            Logger.log("Fila " + nFila + ": error leyendo thread Gmail — " + eThread.message);
          }
        }
      }

      const monto = "$" + Number(deal.amount).toLocaleString('es-CL');
      const asunto = `Cotización N° ${deal.numero_de_cotizacion} — Mi Empresa`;

      // Detalle de productos desde col U (índice 20)
      const detalleTexto = String(fila[20] || "").trim();
      const detalleHTML = detalleTexto
        ? `<p style="${ESTILO_NARROW_}"><strong>Detalle del pedido:</strong></p>
           <ul style="font-family: 'Arial Narrow', Arial, sans-serif; font-size: 14px; color: #333; margin: 4px 0; padding-left: 20px;">
             ${detalleTexto.split("\n").map(l => `<li style="margin-bottom: 2px;">${l.trim()}</li>`).join("")}
           </ul>`
        : "";

      const mensajeCuerpo = esDia3 ? `
        <p style="${ESTILO_NARROW_}">Hola ${fila[5]}, ¿cómo estás?</p>
        <p style="${ESTILO_NARROW_}">Te escribo para retomar la cotización N° <strong>${deal.numero_de_cotizacion}</strong> por <strong>${monto}</strong> que te envié hace unos días. ¿Pudiste revisarla con tu equipo?</p>
        ${detalleHTML}
        <p style="${ESTILO_NARROW_}">Avísame si tienes cualquier duda o si quieres que demos el visto bueno para programar la entrega del pedido lo antes posible.</p>
      ` : `
        <p style="${ESTILO_NARROW_}">Hola ${fila[5]}, ¿qué tal todo?</p>
        <p style="${ESTILO_NARROW_}">Te contacto para ver si tienes alguna novedad sobre la cotización N° <strong>${deal.numero_de_cotizacion}</strong> por <strong>${monto}</strong>. ¿Tienes alguna duda pendiente o necesitas que revisemos algo más para dar el paso final con el pedido?</p>
        ${detalleHTML}
        <p style="${ESTILO_NARROW_}">Avísame cómo prefieres proceder.</p>
      `;

      const cuerpoHTML = mensajeCuerpo + firmaEmpresaHTML_();

      // Marcar fecha ANTES de enviar para evitar reenvíos si algo falla después
      const fechaHoy = Utilities.formatDate(ahora, CONFIG_SEG.TIMEZONE, "dd/MM/yyyy");
      if (esDia3) {
        hoja.getRange(nFila, 19).setValue(fechaHoy); // col S = Fecha día 3 enviado
        // Día 3 TARDÍO: si ya pasó también la fecha del día 7, este correo cumple por ambos.
        // Evita que la corrida siguiente mande el "día 7" una hora después del "día 3".
        if (hoySinHora >= fechaToca7) {
          hoja.getRange(nFila, 20).setValue(fechaHoy); // col T = Fecha día 7 enviado
        }
      } else {
        hoja.getRange(nFila, 20).setValue(fechaHoy); // col T = Fecha día 7 enviado
      }
      SpreadsheetApp.flush();

      // Enviar: día 3 → email nuevo. Día 7 → respuesta en el mismo hilo.
      if (esDia3) {
        GmailApp.sendEmail(fila[7], asunto, "", { htmlBody: cuerpoHTML, bcc: bcc });

        // Guardar Thread ID del hilo recién creado.
        // Reintento: Gmail puede tardar unos segundos en indexar el mensaje.
        Utilities.sleep(2000);
        var hilos = GmailApp.search('to:' + fila[7] + ' subject:"' + asunto + '" newer_than:1d');
        if (!hilos.length) {
          Utilities.sleep(3000);
          hilos = GmailApp.search('to:' + fila[7] + ' subject:"' + asunto + '" newer_than:1d');
        }
        const idDelHilo = hilos.length > 0 ? hilos[0].getId() : 'ID_' + ahora.getTime();
        hoja.getRange(nFila, 18).setValue(idDelHilo); // col R = Thread ID día 3

      } else {
        // Día 7: enviar el seguimiento AL CLIENTE (fila[7]).
        //
        // NO usar thread.reply(): GmailThread.reply() responde al remitente del
        // último mensaje del hilo. Si el cliente no había respondido, ese último
        // mensaje es nuestro propio correo del día 3, por lo que la respuesta
        // volvía a ventas@ejemplo.com en vez de ir al cliente (bug confirmado).
        // El parámetro "to" no se respeta en reply(), así que enviamos directo.
        //
        // Conservamos el mismo asunto del día 3 para que Gmail agrupe ambos
        // correos en la misma conversación del cliente.
        GmailApp.sendEmail(fila[7], asunto, "", { htmlBody: cuerpoHTML, bcc: bcc });
      }

      Logger.log(" Mail día " + (esDia3 ? "3" : "7") + " enviado a " + fila[7] + " (fila " + nFila + ")");

    } catch (e) {
      // OJO: la fecha (col S/T) ya se marcó antes de enviar (anti-duplicado), así que un
      // fallo aquí = correo NO enviado pero fila marcada como enviada. La alerta es la
      // única señal para reenviarlo a mano; no dejarlo solo en el Logger.
      Logger.log("Error fila " + nFila + ": " + e.message);
      alertarError_('seguimiento día 3/7 fila ' + nFila + ' (COT ' + fila[2] + ')',
        e.message + '\n\nLa fila quedó marcada como enviada: revisar y reenviar a mano si corresponde.');
    }
  }
}

// "Saltar hoy" ahora se lee de la col Z ("Saltar hasta") de la hoja, escrita por el panel.
// (seguimientosCancelados_ / panelSaltarHoy_ eliminadas: leían el desplegable del panel,
//  que se pierde con cada refresco.)
// calcularFechaHabil_ / esDiaHabil_ → núcleo (_config_ids.gs).
