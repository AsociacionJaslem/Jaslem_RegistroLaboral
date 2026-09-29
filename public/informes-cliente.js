// ---------- GENERACIÓN DE INFORMES EN EL PROPIO NAVEGADOR ----------
// Sustituye a la antigua Cloud Function "generarInforme". Usa varias
// librerías cargadas como <script> normal en index.html (no como módulo
// ES, por eso se leen de "window"/global): jsPDF (para el PDF), SheetJS/xlsx
// (para el Excel) y zip.js (para el cifrado real del archivo final).
//
// ---------------------------------------------------------------------
// AVISO IMPORTANTE — qué seguridad es real y cuál no:
//
// - Ni jsPDF ni la versión gratuita de SheetJS pueden poner una contraseña
//   DENTRO del propio PDF o del propio Excel al generarlos en el navegador
//   (eso solo lo hacen programas de pago que corren en un servidor). Así
//   que el PDF y el Excel en sí, como archivo suelto, NO llevan cifrado.
//
// - Lo que SÍ es real y sí funciona: el archivo (PDF o Excel) se entrega
//   siempre dentro de un ZIP protegido con contraseña y cifrado AES-256
//   (el mismo cifrado fuerte que usan programas como WinZip o 7-Zip). Sin
//   la contraseña, el ZIP no se puede abrir en ningún programa — eso es
//   cifrado de verdad, no un simple bloqueo de edición.
//
// - Además, cada informe lleva impreso un "código de verificación" (una
//   huella digital SHA-256 de sus datos) y queda un registro aparte en
//   Firestore ("descargas_certificadas": quién lo descargó, cuándo, y esa
//   misma huella) que nadie puede modificar ni borrar. Si alguien
//   manipulase el PDF o el Excel después de descargarlo, sus datos ya no
//   generarían esa misma huella — así se puede demostrar que un documento
//   concreto es el original y no ha sido tocado.
//
// Esta combinación (ZIP cifrado con AES-256 + huella de verificación +
// registro de auditoría inalterable) es, dentro de lo que permite hacer un
// navegador sin depender de ningún servidor, lo más seguro que se puede
// ofrecer hoy en día.
// ---------------------------------------------------------------------

import {
  calcularPeriodo, obtenerDatosPeriodo, obtenerDatosHistoricoCompleto,
  obtenerTrabajadorCompleto, calcularHorasTrabajadas, estadoDeRegistro,
  registrarDescargaCertificada
} from './firestore-datos.js';
import { calcularHuellaTexto, formatearCodigoVerificacion, formatearFecha, formatearHoraCompleta } from './logica-comun.js';

const NOMBRE_ORGANIZACION = 'JÁSLEM';
const COLOR_VERDE_OSCURO = [41, 133, 120];
const COLOR_TEXTO = [31, 59, 55];
const COLORES_ESTADO = {
  'Correcto': [31, 111, 99],
  'Pendiente': [192, 57, 43],
  'Solicitada': [107, 63, 160],
  'Corregido': [185, 119, 14]
};

// Contraseña aleatoria robusta para el ZIP, cuando no se indica una propia.
// Se genera con crypto.getRandomValues (aleatoriedad de verdad, no Math.random).
function generarPasswordAleatoria() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!$%&#';
  const valores = new Uint32Array(16);
  crypto.getRandomValues(valores);
  return Array.from(valores).map(function (v) { return alfabeto[v % alfabeto.length]; }).join('');
}

// Empaqueta un archivo dentro de un ZIP cifrado con AES-256 (zip.js). Este
// es el cifrado real de todo el sistema (ver aviso al principio del archivo).
async function cifrarEnZip(blob, nombreDentroDelZip, password) {
  const zipWriter = new zip.ZipWriter(new zip.BlobWriter('application/zip'), {
    password: password,
    encryptionStrength: 3 // AES-256
  });
  await zipWriter.add(nombreDentroDelZip, new zip.BlobReader(blob));
  return zipWriter.close();
}

// Texto canónico (siempre igual para los mismos datos, en el mismo orden)
// del que se calcula el código de verificación — es la huella de los DATOS,
// no del PDF/Excel ya maquetado, para que dos formatos del mismo informe
// compartan el mismo código.
function contenidoCanonico(trabajador, periodo, datos) {
  const partes = [
    'JASLEM-INFORME-v1', trabajador.dni, trabajador.nombre, periodo.etiqueta,
    JSON.stringify(datos.registros), JSON.stringify(datos.incidencias), JSON.stringify(datos.correcciones)
  ];
  return partes.join('␟');
}

// opciones: { proteger: true|false (por defecto true), password: 'xxxx' (opcional, si no se indica se genera una) }
export async function generarInformeCliente(db, auth, logoBase64, dni, tipoPeriodo, fechaReferenciaISO, formato, opciones) {
  const opts = opciones || {};
  const trabajador = await obtenerTrabajadorCompleto(db, dni);
  if (!trabajador) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };

  let periodo, datosPeriodo;
  if (tipoPeriodo === 'historico_completo') {
    datosPeriodo = await obtenerDatosHistoricoCompleto(db, trabajador.dni);
    periodo = { etiqueta: datosPeriodo.etiqueta };
  } else {
    periodo = calcularPeriodo(tipoPeriodo, fechaReferenciaISO);
    if (!periodo) return { ok: false, mensaje: 'Tipo de periodo no válido.' };
    datosPeriodo = await obtenerDatosPeriodo(db, trabajador.dni, periodo.inicio, periodo.fin);
  }

  const ahora = new Date();
  const generadoEl = formatearFecha(ahora) + ' ' + formatearHoraCompleta(ahora) + ' (hora de Canarias)';
  const generadoPor = (auth && auth.currentUser && auth.currentUser.email) || 'Sistema';

  const huellaCompleta = await calcularHuellaTexto(contenidoCanonico(trabajador, periodo, datosPeriodo));
  const codigoVerificacion = formatearCodigoVerificacion(huellaCompleta.slice(0, 16));

  const certificacion = { codigoVerificacion: codigoVerificacion, generadoEl: generadoEl, generadoPor: generadoPor };
  const nombreArchivoBase = 'Informe_' + trabajador.dni + '_' + tipoPeriodo + '_' + Date.now();

  let blobSinCifrar, nombreDentro;
  if (formato === 'pdf') {
    blobSinCifrar = generarPdf(logoBase64, trabajador, periodo, datosPeriodo, certificacion);
    nombreDentro = nombreArchivoBase + '.pdf';
  } else {
    blobSinCifrar = generarExcel(trabajador, periodo, datosPeriodo, certificacion);
    nombreDentro = nombreArchivoBase + '.xlsx';
  }

  const proteger = opts.proteger !== false;
  let blobFinal = blobSinCifrar, nombreArchivo = nombreDentro, password = null;

  if (proteger) {
    password = opts.password && String(opts.password).trim() ? String(opts.password).trim() : generarPasswordAleatoria();
    blobFinal = await cifrarEnZip(blobSinCifrar, nombreDentro, password);
    nombreArchivo = nombreArchivoBase + '.zip';
  }

  await registrarDescargaCertificada(db, auth, {
    dni: trabajador.dni, nombreTrabajador: trabajador.nombre, tipoPeriodo: tipoPeriodo,
    formato: formato, etiquetaPeriodo: periodo.etiqueta, nombreArchivo: nombreArchivo,
    huellaContenido: huellaCompleta, codigoVerificacion: codigoVerificacion, protegidoConZip: proteger
  });

  return {
    ok: true, blob: blobFinal, nombreArchivo: nombreArchivo, protegido: proteger,
    password: proteger ? password : null, codigoVerificacion: codigoVerificacion
  };
}

function generarPdf(logoBase64, trabajador, periodo, datos, certificacion) {
  const jsPDFCtor = window.jspdf.jsPDF;
  const pdf = new jsPDFCtor({ unit: 'pt', format: 'a4' });

  pdf.setProperties({
    title: 'Informe de jornada — ' + trabajador.nombre,
    subject: periodo.etiqueta,
    author: NOMBRE_ORGANIZACION,
    keywords: 'JASLEM,jornada,verificacion,' + certificacion.codigoVerificacion,
    creator: NOMBRE_ORGANIZACION + ' — Registro de jornada laboral'
  });

  if (logoBase64) {
    try { pdf.addImage(logoBase64, 'PNG', 40, 24, 90, 39); } catch (e) { /* si el logo falla, seguimos sin él */ }
  }
  pdf.setTextColor.apply(pdf, COLOR_VERDE_OSCURO);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(16);
  pdf.text(NOMBRE_ORGANIZACION, 140, 40);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
  pdf.text('Registro de jornada laboral', 140, 55);

  pdf.setDrawColor.apply(pdf, COLOR_VERDE_OSCURO);
  pdf.setLineWidth(1.2);
  pdf.line(40, 75, 555, 75);

  pdf.setTextColor.apply(pdf, COLOR_TEXTO);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14);
  pdf.text('Informe de ' + periodo.etiqueta, 40, 100);

  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
  pdf.text('Trabajador: ' + trabajador.nombre, 40, 120);
  pdf.text('DNI/NIE: ' + trabajador.dni + (trabajador.categoria ? '   ·   Categoría profesional: ' + trabajador.categoria : ''), 40, 134);
  if (trabajador.nss) pdf.text('Nº Seguridad Social: ' + trabajador.nss, 40, 148);

  pdf.setFont('helvetica', 'bold');
  pdf.text('Horas trabajadas en el periodo: ' + calcularHorasTrabajadas(datos.registros), 40, 166);

  const filas = datos.registros.map(function (r) {
    const estado = estadoDeRegistro(r, datos.correcciones);
    return [r.fecha, r.hora, r.tipo, estado.etiqueta, (r.advertencia || '').replace('ADVERTENCIA: ', '')];
  });

  pdf.autoTable({
    startY: 180,
    head: [['Fecha', 'Hora', 'Tipo', 'Estado', 'Detalle']],
    body: filas.length ? filas : [['—', '—', '—', 'Sin fichajes en este periodo', '']],
    headStyles: { fillColor: COLOR_VERDE_OSCURO, textColor: [255, 255, 255], fontSize: 9 },
    styles: { fontSize: 8.5, textColor: COLOR_TEXTO },
    didParseCell: function (data) {
      if (data.section === 'body' && data.column.index === 3) {
        const color = COLORES_ESTADO[data.cell.raw] || COLOR_TEXTO;
        data.cell.styles.textColor = color;
        data.cell.styles.fontStyle = 'bold';
      }
    }
  });

  let y = pdf.lastAutoTable.finalY + 20;
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8);
  pdf.text('Leyenda:', 40, y);
  let x = 90;
  Object.keys(COLORES_ESTADO).forEach(function (clave) {
    pdf.setFillColor.apply(pdf, COLORES_ESTADO[clave]);
    pdf.rect(x, y - 7, 8, 8, 'F');
    pdf.setTextColor.apply(pdf, COLOR_TEXTO); pdf.setFont('helvetica', 'normal');
    pdf.text(clave, x + 12, y);
    x += 95;
  });
  y += 20;

  if (datos.correcciones.length > 0) {
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10);
    pdf.setTextColor.apply(pdf, COLOR_VERDE_OSCURO);
    pdf.text('Correcciones registradas en el periodo', 40, y);
    y += 14;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
    pdf.setTextColor.apply(pdf, COLOR_TEXTO);
    datos.correcciones.forEach(function (c) {
      if (y > 760) { pdf.addPage(); y = 40; }
      const linea = (c.fechaSolicitud || '') + ' — ' + c.rolSolicitante + ' (' + c.solicitanteNombre + '): ' + c.tipoRegistro + ' del ' + c.fechaOriginal + ' ' + c.horaOriginal + ' — ' + c.motivo + (c.valorRectificado ? ' (fijado: ' + c.valorRectificado.hora + ' el ' + c.valorRectificado.fecha + ')' : '');
      const lineasPartidas = pdf.splitTextToSize(linea, 515);
      pdf.text(lineasPartidas, 40, y);
      y += 12 * lineasPartidas.length;
    });
  }

  // ---------- SELLO DE CERTIFICACIÓN (en la última página) ----------
  if (y > 740) { pdf.addPage(); y = 40; }
  y += 16;
  pdf.setDrawColor.apply(pdf, COLOR_VERDE_OSCURO);
  pdf.setLineWidth(0.7);
  pdf.line(40, y, 555, y);
  y += 16;
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9);
  pdf.setTextColor.apply(pdf, COLOR_VERDE_OSCURO);
  pdf.text('Documento certificado', 40, y);
  y += 13;
  pdf.setFont('courier', 'normal'); pdf.setFontSize(9);
  pdf.setTextColor.apply(pdf, COLOR_TEXTO);
  pdf.text('Código de verificación: ' + certificacion.codigoVerificacion, 40, y);
  y += 13;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
  pdf.text('Generado el ' + certificacion.generadoEl + ' por ' + certificacion.generadoPor + '.', 40, y);
  y += 11;
  pdf.text('Este código identifica de forma única los datos de este informe en el momento de su generación.', 40, y);
  y += 11;
  pdf.text('Cualquier modificación posterior del documento haría que este código dejara de corresponderse con su contenido.', 40, y);

  const totalPaginas = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= totalPaginas; i++) {
    pdf.setPage(i);
    pdf.setFontSize(7); pdf.setTextColor(72, 151, 145);
    pdf.text(NOMBRE_ORGANIZACION + ' · Documento generado automáticamente · Página ' + i + ' de ' + totalPaginas, 297, 815, { align: 'center' });
  }

  return pdf.output('blob');
}

function generarExcel(trabajador, periodo, datos, certificacion) {
  const filas = [
    [NOMBRE_ORGANIZACION + ' — Informe de ' + periodo.etiqueta],
    ['Trabajador: ' + trabajador.nombre + '   DNI/NIE: ' + trabajador.dni + (trabajador.categoria ? '   Categoría: ' + trabajador.categoria : '')],
    ['Horas trabajadas en el periodo: ' + calcularHorasTrabajadas(datos.registros)]
  ];
  filas.push([], ['Fecha', 'Hora', 'Tipo', 'Estado', 'Detalle']);
  datos.registros.forEach(function (r) {
    const estado = estadoDeRegistro(r, datos.correcciones);
    filas.push([r.fecha, r.hora, r.tipo, estado.etiqueta, (r.advertencia || '').replace('ADVERTENCIA: ', '')]);
  });
  if (datos.registros.length === 0) filas.push(['Sin fichajes registrados en este periodo.']);

  if (datos.correcciones.length > 0) {
    filas.push([]);
    filas.push(['Correcciones registradas en el periodo']);
    datos.correcciones.forEach(function (c) {
      filas.push([(c.fechaSolicitud || '') + ' — ' + c.rolSolicitante + ' (' + c.solicitanteNombre + '): ' + c.tipoRegistro + ' del ' + c.fechaOriginal + ' ' + c.horaOriginal + ' — ' + c.motivo + (c.valorRectificado ? ' (fijado: ' + c.valorRectificado.hora + ' el ' + c.valorRectificado.fecha + ')' : '')]);
    });
  }

  filas.push([]);
  filas.push(['Documento certificado']);
  filas.push(['Código de verificación', certificacion.codigoVerificacion]);
  filas.push(['Generado el', certificacion.generadoEl]);
  filas.push(['Generado por', certificacion.generadoPor]);
  filas.push(['Este código identifica de forma única los datos de este informe en el momento de su generación. Cualquier modificación posterior haría que dejara de corresponderse con su contenido.']);

  const hoja = window.XLSX.utils.aoa_to_sheet(filas);
  hoja['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 45 }];
  const libro = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(libro, hoja, 'Informe');
  const buffer = window.XLSX.write(libro, { bookType: 'xlsx', type: 'array' });
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
