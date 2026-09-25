// ---------- LÓGICA COMPARTIDA (fechas/horas de Canarias, puntualidad, motivos) ----------
// Idéntica a la que tenían las Cloud Functions (functions/src/utils.js y
// functions/src/logica.js) — se ha convertido a módulo ES para poder
// usarse directamente en el navegador, ya que ahora no hay servidor.

export const ZONA_HORARIA = 'Atlantic/Canary';
export const TOLERANCIA_MIN = 10;

// Lista cerrada de motivos (orden alfabético). Debe coincidir EXACTAMENTE
// con MOTIVOS_CORRECCION en el resto del código.
export const MOTIVOS_CORRECCION = [
  'Asistencia a consulta médica',
  'Baja médica',
  'Citaciones judiciales o renovación DNI',
  'Exámenes prenatales',
  'Fallecimiento de familiar, accidente o enfermedad grave',
  'Gestión Externa (labores realizadas fuera del centro de trabajo)',
  'Lactancia',
  'Maternidad',
  'Matrimonio o registro de pareja de hecho',
  'Mudanza o traslado de municipio',
  'Paternidad'
];

export function soloDigitos(valor) {
  return String(valor || '').replace(/[^0-9]/g, '');
}

export function normalizarDia(valor) {
  return String(valor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function partesEnCanarias(fecha) {
  const formateador = new Intl.DateTimeFormat('es-ES', {
    timeZone: ZONA_HORARIA,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'long'
  });
  const partes = {};
  formateador.formatToParts(fecha).forEach(function (p) { partes[p.type] = p.value; });
  const diaSemanaMap = {
    'domingo': 'Domingo', 'lunes': 'Lunes', 'martes': 'Martes', 'miércoles': 'Miercoles',
    'jueves': 'Jueves', 'viernes': 'Viernes', 'sábado': 'Sabado'
  };
  return {
    anio: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour === '24' ? '00' : partes.hour),
    minuto: Number(partes.minute),
    segundo: Number(partes.second),
    diaSemana: diaSemanaMap[String(partes.weekday).toLowerCase()] || partes.weekday
  };
}

export function formatearFecha(fecha) {
  const p = partesEnCanarias(fecha);
  return String(p.dia).padStart(2, '0') + '/' + String(p.mes).padStart(2, '0') + '/' + p.anio;
}

export function formatearHoraCompleta(fecha) {
  const p = partesEnCanarias(fecha);
  return String(p.hora).padStart(2, '0') + ':' + String(p.minuto).padStart(2, '0') + ':' + String(p.segundo).padStart(2, '0');
}

export function formatearHoraCorta(fecha) {
  const p = partesEnCanarias(fecha);
  return String(p.hora).padStart(2, '0') + ':' + String(p.minuto).padStart(2, '0');
}

export function obtenerDiaSemana(fecha) {
  return partesEnCanarias(fecha).diaSemana;
}

export function combinarFechaHoraCanarias(ahora, horaStr) {
  const p = partesEnCanarias(ahora);
  const partesHora = String(horaStr).split(':').map(Number);
  const horas = partesHora[0] || 0;
  const minutos = partesHora[1] || 0;
  const candidatoUTC = new Date(Date.UTC(p.anio, p.mes - 1, p.dia, horas, minutos, 0));
  const offsetMin = obtenerOffsetMinutosCanarias(candidatoUTC);
  return new Date(candidatoUTC.getTime() - offsetMin * 60000);
}

function obtenerOffsetMinutosCanarias(fecha) {
  const formateador = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA_HORARIA, timeZoneName: 'shortOffset'
  });
  const parte = formateador.formatToParts(fecha).find(function (p) { return p.type === 'timeZoneName'; });
  const match = /GMT([+-]\d+)/.exec(parte ? parte.value : 'GMT+0');
  return match ? Number(match[1]) * 60 : 0;
}

export function nombreMes(mes) {
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return meses[mes - 1];
}

// Evalúa si un fichaje cae dentro o fuera de la jornada laboral. La
// PRIMERA entrada del día se evalúa de forma estricta (con el margen de
// tolerancia). Las entradas siguientes (p. ej. al volver de un descanso)
// son libres mientras caigan dentro de la ventana completa de la jornada.
// Las salidas siempre se evalúan contra la ventana completa.
export function evaluarPuntualidad(horario, tipo, ahora, esPrimeraEntradaDelDia) {
  if (!horario || !horario.entrada || !horario.salida) return { fueraDeTiempo: false };

  const horaEntradaEsperada = combinarFechaHoraCanarias(ahora, horario.entrada);
  const horaSalidaEsperada = combinarFechaHoraCanarias(ahora, horario.salida);
  const inicioVentana = new Date(horaEntradaEsperada.getTime() - TOLERANCIA_MIN * 60000);
  const finVentana = new Date(horaSalidaEsperada.getTime() + TOLERANCIA_MIN * 60000);

  if (tipo === 'Entrada') {
    if (esPrimeraEntradaDelDia) {
      const diffMin = Math.round((ahora - horaEntradaEsperada) / 60000);
      if (diffMin > TOLERANCIA_MIN) {
        return { fueraDeTiempo: true, tipo: 'Retraso', detalle: 'Entrada con ' + diffMin + ' min de retraso (prevista ' + horario.entrada + ')', minutos: diffMin };
      }
      return { fueraDeTiempo: false };
    }
    if (ahora >= inicioVentana && ahora <= finVentana) return { fueraDeTiempo: false };
    const diffMin = Math.round((ahora - horaEntradaEsperada) / 60000);
    return { fueraDeTiempo: true, tipo: 'Retraso', detalle: 'Entrada con ' + diffMin + ' min de retraso, fuera de la jornada prevista (' + horario.entrada + ' - ' + horario.salida + ')', minutos: diffMin };
  }

  if (ahora >= inicioVentana && ahora <= finVentana) return { fueraDeTiempo: false };
  if (ahora > finVentana) {
    const diffMin = Math.round((ahora - horaSalidaEsperada) / 60000);
    return { fueraDeTiempo: true, tipo: 'Posibles horas extra', detalle: 'Salida ' + diffMin + ' min más tarde de lo previsto (prevista ' + horario.salida + ')', minutos: diffMin };
  }
  const diffMin = Math.round((horaSalidaEsperada - ahora) / 60000);
  return { fueraDeTiempo: true, tipo: 'Salida anticipada', detalle: 'Salida ' + diffMin + ' min antes de lo previsto (prevista ' + horario.salida + ')', minutos: -diffMin };
}
