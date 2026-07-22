/**
 * FILTRO DE COTIZACIONES (GAS #0)
 * Lee "Cotizaciones Bsale", copia a "Cotizaciones Vendedor" las cotizaciones nuevas
 * de los vendedores válidos, y rellena col U (Detalle pedido) desde "Cotizaciones Bsale Detalle".
 * Sella col Y (Ingreso). Ya NO crea deals: las nuevas quedan "Por procesar" (decisión en el panel).
 */
function filtrarCotizacionesVendedor() {
  // Origen = planilla compartida de Bsale (se LEE). Destino = tu planilla privada (se ESCRIBE).
  const ssOrigen = getSourceSS();
  const ssDestino = getWorkSS();
  const hojaOrigen = ssOrigen.getSheetByName("Cotizaciones Bsale");
  const nombreDestino = "Cotizaciones Vendedor";

  if (!hojaOrigen || hojaOrigen.getLastRow() < 2) {
    Logger.log("Hoja origen vacía o no encontrada.");
    return;
  }

  let hojaDestino = ssDestino.getSheetByName(nombreDestino) || ssDestino.insertSheet(nombreDestino);

  // 1. Cargar mapa de detalle de productos (una sola lectura de la hoja de detalle, planilla origen)
  const mapaDetalle = _cargarDetalleProductos_(ssOrigen);

  // 2. Obtener datos de origen (Columnas A a O = 15 columnas)
  const ultimaFilaOrigen = hojaOrigen.getLastRow();
  const datosOrigen = hojaOrigen.getRange(2, 1, ultimaFilaOrigen - 1, 15).getValues();

  // 3. Obtener datos existentes en destino para evitar duplicados
  let datosDestino = [];
  const ultimaFilaDestino = hojaDestino.getLastRow();
  if (ultimaFilaDestino > 1) {
    datosDestino = hojaDestino.getRange(2, 1, ultimaFilaDestino - 1, 15).getValues();
  }

  // 4. Mapa de duplicados usando N° Cotización (Columna C / Índice 2)
  const existentes = new Set(datosDestino.map(fila => fila[2].toString().trim()));
  const vendedoresFiltro = VENDEDORES_VALIDOS_GLOBAL;

  // 5. Filtrar nuevas cotizaciones
  const nuevasFilas = datosOrigen.filter(fila => {
    const vendedor = String(fila[9]).trim();
    const numCot = fila[2].toString().trim();
    if (!vendedoresFiltro.includes(vendedor) || existentes.has(numCot) || numCot === "") return false;
    // Dedup TAMBIÉN dentro del lote: "Cotizaciones Bsale" puede traer el mismo N° dos veces
    // (la descarga deduplica por docId, y una cotización reeditada genera otro docId).
    // Sin esto entrarían filas duplicadas → correos duplicados en GAS #2.
    existentes.add(numCot);
    return true;
  });

  if (nuevasFilas.length === 0) {
    Logger.log("No se encontraron cotizaciones nuevas para agregar.");
    return;
  }

  // 6. Asegurar header de col U
  _asegurarHeaderDetalle_(hojaDestino);

  // 7. Extender cada fila con columnas P-T vacías (las rellena GAS #1) + detalle en col U
  const filasCompletas = nuevasFilas.map(fila => {
    const numCot = String(fila[2]).trim();
    const detalle = mapaDetalle[numCot] || "";
    return [...fila, "", "", "", "", "", detalle]; // 15 originales + 5 vacías (P-T) + detalle (U)
  });

  const primeraNueva = hojaDestino.getLastRow() + 1;
  hojaDestino.getRange(primeraNueva, 1, filasCompletas.length, 21).setValues(filasCompletas);

  // Sello de ingreso (col Y) de cada fila nueva, para el respaldo por horas.
  // El Flujo (col X) queda vacío = "por decidir" hasta que lo marques en el panel.
  const ahora = new Date();
  const sellos = filasCompletas.map(function () { return [ahora]; });
  hojaDestino.getRange(primeraNueva, COL_INGRESO + 1, filasCompletas.length, 1).setValues(sellos);

  Logger.log('Se agregaron ' + filasCompletas.length + ' filas nuevas (quedan "Por procesar").');

  // YA NO se encadena la creación de deals/correos. Las cotizaciones nuevas quedan
  // "Por procesar": se procesan con el botón (procesarCotizacionesNuevas) según su Flujo,
  // o por el respaldo (procesarRespaldoSinCorreo) si pasan RESPALDO_HORAS sin decidir.
}

/**
 * Lee "Cotizaciones Bsale Detalle" y devuelve un mapa { numeroCot → string multilinea }.
 * Cada línea: "Tipo de producto | Impresión | Cantidad uds"
 */
function _cargarDetalleProductos_(ss) {
  const mapa = {};
  const hojaDetalle = ss.getSheetByName("Cotizaciones Bsale Detalle");
  if (!hojaDetalle || hojaDetalle.getLastRow() < 2) return mapa;

  const datos = hojaDetalle.getRange(2, 1, hojaDetalle.getLastRow() - 1, 6).getValues();
  datos.forEach(d => {
    const numCot = String(d[0]).trim(); // col A = N° Cotización
    if (!numCot) return;

    const producto  = String(d[3]).trim() || "Sin descripción"; // col D
    const impresion = String(d[4]).trim() || "Sin impresión";   // col E
    const cantidad  = String(d[5]).trim() || "";                // col F

    const linea = `${producto} | ${impresion} | ${cantidad} uds`;
    mapa[numCot] = mapa[numCot] ? mapa[numCot] + "\n" + linea : linea;
  });

  return mapa;
}

function _asegurarHeaderDetalle_(hoja) {
  if (!hoja.getRange(1, 21).getValue()) {
    hoja.getRange(1, 21).setValue("Detalle pedido").setFontWeight("bold");
  }
}

// El filtro se ejecuta encadenado desde sincronizarBsaleRapido (cada 15 min). No tiene
// trigger propio; los triggers se configuran en configurarTodosLosTriggers (_triggers.gs).
