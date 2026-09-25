// ---------- GENERACIÓN DE INFORMES EN EL PROPIO NAVEGADOR ----------
// Sustituye a la antigua Cloud Function "generarInforme". Usa dos
// librerías cargadas como <script> normal en index.html (no como módulo
// ES, por eso se leen de "window"): jsPDF (para el PDF) y SheetJS/xlsx
// (para el Excel).
//
// AVISO IMPORTANTE sobre el cifrado: jsPDF (la librería de PDF que
// funciona en el navegador) NO soporta proteger el PDF con contraseña.
// El PDF se genera igual de bien, con los mismos colores y cabecera
// corporativa, pero SIN cifrado. Si de verdad necesitas un PDF que pida
// contraseña al abrirse, la única forma fiable es generarlo con un
// programa que se ejecute en un ordenador (no en el navegador) — coméntalo
// si te hace falta y se puede preparar un script aparte para eso.

import { calcularPeriodo, obtenerDatosPeriodo, obtenerTrabajadorCompleto, calcularHorasTrabajadas, estadoDeRegistro } from './firestore-datos.js';

const NOMBRE_ORGANIZACION = 'JÁSLEM';
const COLOR_VERDE_OSCURO = [41, 133, 120];
const COLOR_TEXTO = [31, 59, 55];
const COLORES_ESTADO = {
  'Correcto': [31, 111, 99],
  'Pendiente': [192, 57, 43],
  'Solicitada': [107, 63, 160],
  'Corregido': [185, 119, 14]
};

export async function generarInformeCliente(db, logoBase64, dni, tipoPeriodo, fechaReferenciaISO, formato, cifrarSolicitado) {
  const trabajador = await obtenerTrabajadorCompleto(db, dni);
  if (!trabajador) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };

  const periodo = calcularPeriodo(tipoPeriodo, fechaReferenciaISO);
  if (!periodo) return { ok: false, mensaje: 'Tipo de periodo no válido.' };

  const datosPeriodo = await obtenerDatosPeriodo(db, trabajador.dni, periodo.inicio, periodo.fin);
  const nombreArchivoBase = 'Informe_' + trabajador.dni + '_' + tipoPeriodo + '_' + Date.now();

  if (formato === 'pdf') {
    const blob = generarPdf(logoBase64, trabajador, periodo, datosPeriodo);
    return { ok: true, blob: blob, nombreArchivo: nombreArchivoBase + '.pdf', cifrado: false, avisoCifrado: !!cifrarSolicitado };
  }
  const blob = generarExcel(trabajador, periodo, datosPeriodo);
  return { ok: true, blob: blob, nombreArchivo: nombreArchivoBase + '.xlsx', cifrado: false, avisoCifrado: false };
}

function generarPdf(logoBase64, trabajador, periodo, datos) {
  const jsPDFCtor = window.jspdf.jsPDF;
  const pdf = new jsPDFCtor({ unit: 'pt', format: 'a4' });

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
      if (y > 780) { pdf.addPage(); y = 40; }
      const linea = (c.fechaSolicitud || '') + ' — ' + c.rolSolicitante + ' (' + c.solicitanteNombre + '): ' + c.tipoRegistro + ' del ' + c.fechaOriginal + ' ' + c.horaOriginal + ' — ' + c.motivo + (c.valorPropuesto ? ' (horario corregido: ' + c.valorPropuesto + ')' : '');
      const lineasPartidas = pdf.splitTextToSize(linea, 515);
      pdf.text(lineasPartidas, 40, y);
      y += 12 * lineasPartidas.length;
    });
  }

  const totalPaginas = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= totalPaginas; i++) {
    pdf.setPage(i);
    pdf.setFontSize(7); pdf.setTextColor(72, 151, 145);
    pdf.text(NOMBRE_ORGANIZACION + ' · Documento generado automáticamente · Página ' + i + ' de ' + totalPaginas, 297, 815, { align: 'center' });
  }

  return pdf.output('blob');
}

function generarExcel(trabajador, periodo, datos) {
  const filas = [
    [NOMBRE_ORGANIZACION + ' — Informe de ' + periodo.etiqueta],
    ['Trabajador: ' + trabajador.nombre + '   DNI/NIE: ' + trabajador.dni + (trabajador.categoria ? '   Categoría: ' + trabajador.categoria : '')],
    ['Horas trabajadas en el periodo: ' + calcularHorasTrabajadas(datos.registros)],
    [],
    ['Fecha', 'Hora', 'Tipo', 'Estado', 'Detalle']
  ];
  datos.registros.forEach(function (r) {
    const estado = estadoDeRegistro(r, datos.correcciones);
    filas.push([r.fecha, r.hora, r.tipo, estado.etiqueta, (r.advertencia || '').replace('ADVERTENCIA: ', '')]);
  });
  if (datos.registros.length === 0) filas.push(['Sin fichajes registrados en este periodo.']);

  if (datos.correcciones.length > 0) {
    filas.push([]);
    filas.push(['Correcciones registradas en el periodo']);
    datos.correcciones.forEach(function (c) {
      filas.push([(c.fechaSolicitud || '') + ' — ' + c.rolSolicitante + ' (' + c.solicitanteNombre + '): ' + c.tipoRegistro + ' del ' + c.fechaOriginal + ' ' + c.horaOriginal + ' — ' + c.motivo + (c.valorPropuesto ? ' (horario corregido: ' + c.valorPropuesto + ')' : '')]);
    });
  }

  const hoja = window.XLSX.utils.aoa_to_sheet(filas);
  hoja['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 45 }];
  const libro = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(libro, hoja, 'Informe');
  const buffer = window.XLSX.write(libro, { bookType: 'xlsx', type: 'array' });
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
