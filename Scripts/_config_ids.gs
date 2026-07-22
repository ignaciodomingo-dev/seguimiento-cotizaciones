/**
 * CONFIGURACIÓN DE PLANILLAS (proyecto standalone)
 * ------------------------------------------------------------------
 * ID de TU planilla privada. Toda lectura y escritura del sistema
 * pasa por getWorkSS(). Si en el futuro se vuelve a leer la planilla
 * compartida del analista, agregar SOURCE_SS_ID por separado.
 *
 * CÓMO OBTENER EL ID: está en la URL entre /d/ y /edit:
 *   https://docs.google.com/spreadsheets/d/[ESTE_ES_EL_ID]/edit
 * ------------------------------------------------------------------
 */
const WORK_SS_ID = "YOUR_SPREADSHEET_ID";

/** Tu planilla privada de trabajo (lectura + escritura). */
function getWorkSS() {
  return SpreadsheetApp.openById(WORK_SS_ID);
}

/**
 * Alias de getWorkSS() para la planilla de origen del filtro (GAS #0).
 * Hoy ambas son la misma planilla. Si en el futuro se separan, solo
 * cambiar este método.
 */
function getSourceSS() {
  return getWorkSS();
}

/* ===== MODELO DE ESTADOS (hoja "Cotizaciones Vendedor") =====
 * Col P (idx 15) = "Etapa": etiqueta REAL de la etapa de HubSpot.
 * Col Q (idx 16) = Deal ID.
 * Col W (idx 22) = "Control": bandera interna (Vinculada/Respondida/Excluida/Archivada).
 */
const COL_ETAPA = 15;
const COL_DEALID = 16;
const COL_CONTROL = 22;
const COL_FLUJO = 23;    // col X: decisión de entrada (Deal + correo / Deal sin correo / No procesar)
const COL_INGRESO = 24;  // col Y: cuándo entró la fila (sello del filtro), para el respaldo por horas
const COL_SALTAR = 25;   // col Z: "Saltar hasta" — GAS #2 no envía mientras hoy <= esta fecha (la escribe el panel; sobrevive refrescos)
const ETAPA_COTIZANDO = 'Cotizando';

/** Lista canónica de vendedores válidos. Usada por el filtro (GAS #0), la descarga (Bsale) y GAS #1. */
const VENDEDORES_VALIDOS_GLOBAL = ['Vendedor Ejemplo', 'Mi Empresa Spa'];

/** HubSpot: account, owner ID de Vendedor y categoría por defecto de cliente. */
const HS_ACCOUNT_ID     = 'YOUR_HUBSPOT_ACCOUNT_ID';
const HS_OWNER_ID       = 'YOUR_HUBSPOT_OWNER_ID';
const HS_CATEGORIA_CLIENTE = 'Cliente cartera';

/** Opciones del desplegable "Flujo" (qué hacer con una cotización nueva al procesarla). */
const FLUJOS = ['Deal + correo', 'Deal sin correo', 'No procesar'];
const FLUJO_DEFECTO = 'Deal + correo';
/** Tras estas horas "Por procesar" sin decisión, el respaldo crea el deal SIN correo inicial. */
const RESPALDO_HORAS = 12;

/**
 * INTERRUPTOR GLOBAL DE ENVÍOS (kill-switch). Mientras la propiedad de script
 * `ENVIOS_ACTIVOS` no sea exactamente "SI", el sistema NO manda ningún correo al cliente
 * (inicial ni día 3/7) ni cierra deals por silencio. Es independiente de los triggers:
 * garantiza "no sale nada" aunque todo lo demás falle. Encender es un acto deliberado.
 */
function enviosActivos_() {
  return String(PropertiesService.getScriptProperties().getProperty('ENVIOS_ACTIVOS') || '')
    .trim().toUpperCase() === 'SI';
}

/**
 * ÚNICA fuente de etapas: etiqueta -> ID de etapa del pipeline "default".
 * Calcado al pipeline real de HubSpot (verificado con listarEtapasHubSpot, 2026-06-25).
 * En el mismo orden que HubSpot. NO inventar etiquetas que no estén aquí.
 */
const ETAPAS_HS = {
  'Cotizando': 'decisionmakerboughtin',
  'Pedido ingresado': 'contractsent',
  'Entregado': 'closedlost',
  'Negocio perdido': 'STAGE_NEGOCIO_PERDIDO',
  'Venta Exitosa': 'STAGE_VENTA_EXITOSA',
  'Negocio en evaluación': 'STAGE_EN_EVALUACION',
  'Venta perdida Stock': 'STAGE_VENTA_PERDIDA_STOCK',
  'Licitación': 'STAGE_LICITACION'
};

/** ID de etapa de HubSpot -> etiqueta (inverso de ETAPAS_HS). '' si no se conoce. */
function etiquetaEtapa_(stageId) {
  for (var k in ETAPAS_HS) { if (ETAPAS_HS[k] === stageId) return k; }
  return '';
}

/**
 * Regla central del motor: una fila está en SEGUIMIENTO ACTIVO si
 * Etapa = "Cotizando", Control vacío (sin banderas) y tiene Deal ID.
 * (Sustituye al antiguo col P == "Activa").
 */
function enSeguimientoActivo_(fila) {
  return String(fila[COL_ETAPA] || '').trim() === ETAPA_COTIZANDO
    && String(fila[COL_CONTROL] || '').trim() === ''
    && String(fila[COL_DEALID] || '').trim() !== '';
}

/**
 * Envía una alerta por correo a Vendedor cuando algo crítico falla en un trigger.
 * Throttle: máximo 1 alerta por `contexto` cada 30 min (evita spam si algo se cae).
 */
function alertarError_(contexto, mensaje) {
  try {
    var cache = CacheService.getScriptCache();
    var clave = 'alerta_' + contexto;
    if (cache.get(clave)) return;        // ya se alertó hace poco
    cache.put(clave, '1', 1800);         // 30 min
    GmailApp.sendEmail('ventas@ejemplo.com',
      ' Error en sistema de cotizaciones: ' + contexto,
      'Falló "' + contexto + '":\n\n' + mensaje + '\n\nRevisa las Ejecuciones en Apps Script.');
  } catch (e) {
    Logger.log('No se pudo enviar alerta (' + contexto + '): ' + e.message);
  }
}

/**
 * Convierte el valor de la columna "Fecha Emisión" a un objeto Date, tolerando:
 *  - Date (cuando Sheets ya lo interpretó como fecha, p.ej. filas del sistema viejo)
 *  - texto "dd/MM/yyyy" (cuando llega como string, según el locale de la planilla)
 * Devuelve null si no se puede interpretar. Independiente del locale.
 */
function aFecha_(valor) {
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor;
  var s = String(valor || '').trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/* ============================================================
 * HELPERS COMPARTIDOS (antes dispersos en archivos de fase;
 * centralizados aquí para que cada fase dependa solo del núcleo).
 * ============================================================ */

/** Normaliza texto: minúsculas, sin tildes, espacios colapsados. */
function normalizar_(texto) {
  return String(texto || '').toLowerCase().trim().replace(/\s+/g, ' ')
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n');
}

// Festivos chilenos fijos (ampliar según año). Formato: "MM-DD" o "YYYY-MM-DD".
const FESTIVOS_CL = [
  "01-01", "05-01", "05-21", "06-29", "07-16", "08-15",
  "09-18", "09-19", "10-12", "10-31", "11-01", "12-08", "12-25",
  // Variables 2026 (ajustar cada año)
  "2026-04-03", "2026-04-04", "2026-06-20"
];

/** Suma días hábiles a una fecha, saltando fines de semana y festivos chilenos. */
function calcularFechaHabil_(fechaInicio, diasSumar) {
  const fecha = new Date(fechaInicio);
  let diasContados = 0;
  while (diasContados < diasSumar) {
    fecha.setDate(fecha.getDate() + 1);
    if (esDiaHabil_(fecha)) diasContados++;
  }
  fecha.setHours(0, 0, 0, 0);
  return fecha;
}

function esDiaHabil_(fecha) {
  const dow = fecha.getDay();
  if (dow === 0 || dow === 6) return false;
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return !FESTIVOS_CL.includes(`${mm}-${dd}`) && !FESTIVOS_CL.includes(`${yyyy}-${mm}-${dd}`);
}

/**
 * Set { N° cotización (normalizado): true } de las cotizaciones que YA tienen pedido
 * (pestaña "Pedidos", columna O "Origen" = "COT#####"). Lo usan GAS #1/#2 y el panel
 * para no tratar como "nueva" una cotización que el cliente ya compró.
 */
function cotizacionesConPedido_() {
  var set = {};
  var hojaPed = getWorkSS().getSheetByName('Pedidos');
  if (!hojaPed || hojaPed.getLastRow() < 2) return set;
  hojaPed.getRange(2, 15, hojaPed.getLastRow() - 1, 1).getValues() // col O (15) = Origen
    .forEach(function (r) {
      var o = String(r[0] || '').trim().toUpperCase();
      if (o.indexOf('COT') === 0) {
        var n = o.replace(/\D/g, '').replace(/^0+/, '');
        if (n) set[n] = true;
      }
    });
  return set;
}

/**
 * Busca un contacto en HubSpot por email; si no existe lo crea. Devuelve su id.
 * Único helper de contacto (antes había dos versiones casi iguales en GAS #1 y #5).
 */
function buscarOCrearContacto_(email, nombreCompleto, empresa, token) {
  email = String(email || '').trim();
  if (!email) throw new Error('Email vacío, no se puede crear contacto');
  var headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  var resSearch = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'post', headers: headers,
    payload: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] }),
    muteHttpExceptions: true
  });
  if (resSearch.getResponseCode() === 200) {
    var sj = JSON.parse(resSearch.getContentText());
    if (sj.total > 0) return sj.results[0].id;
  }

  var partes = String(nombreCompleto || '').trim().split(/\s+/);
  var resCreate = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'post', headers: headers,
    payload: JSON.stringify({ properties: {
      email: email, firstname: partes[0] || '', lastname: partes.slice(1).join(' ') || '', company: String(empresa || '')
    } }),
    muteHttpExceptions: true
  });
  if (resCreate.getResponseCode() !== 201) {
    throw new Error('No se pudo crear contacto (HTTP ' + resCreate.getResponseCode() + '): ' + resCreate.getContentText());
  }
  return JSON.parse(resCreate.getContentText()).id;
}
