// ---------- LÓGICA COMPARTIDA (fechas/horas de Canarias, puntualidad, motivos) ----------
// Idéntica a la que tenían las Cloud Functions (functions/src/utils.js y
// functions/src/logica.js) — se ha convertido a módulo ES para poder
// usarse directamente en el navegador, ya que ahora no hay servidor.

export const ZONA_HORARIA = 'Atlantic/Canary';
export const TOLERANCIA_MIN = 10;

// ---------- CÓDIGO DE FICHAJE DEL TRABAJADOR (6 dígitos, elegido por él) ----------
// Nunca se guarda el código en texto plano en ningún sitio — ni en
// Firestore ni en Firebase Authentication se puede leer luego el valor
// original, solo comprobar si uno coincide. Aquí se calcula su huella
// digital (SHA-256, con el "crypto" que trae el propio navegador, sin
// librerías externas) para poder encontrar de quién es un código sin
// tener que guardar el código en sí.
export async function calcularHashCodigo(codigo) {
  const texto = String(codigo || '').trim();
  const bytes = new TextEncoder().encode('jaslem-codigo-fichaje:' + texto);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

export function codigoValido(codigo) {
  return /^[0-9]{6}$/.test(String(codigo || '').trim());
}

// ---------- CÓDIGO DE VERIFICACIÓN DE INFORMES DESCARGADOS ----------
// Huella (SHA-256) del CONTENIDO de un informe (los datos, no el archivo
// final ya maquetado). Sirve para comprobar más tarde si un PDF/Excel
// descargado se corresponde exactamente con lo que había en ese momento en
// el sistema: si alguien cambia una sola coma del documento, esta huella ya
// no coincidirá con la guardada en "descargas_certificadas".
export async function calcularHuellaTexto(texto) {
  const bytes = new TextEncoder().encode(String(texto));
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

export function formatearCodigoVerificacion(huellaHex) {
  return String(huellaHex || '').toUpperCase().match(/.{1,4}/g).join('-');
}

// Lista cerrada de motivos (orden alfabético), para uso del ADMINISTRADOR
// (ve y puede usar todos). Debe coincidir EXACTAMENTE con MOTIVOS_CORRECCION
// en el resto del código (hay una copia idéntica, codificada a mano, en
// index.html).
//
// Política de la organización: TODOS los motivos de esta lista se
// consideran justificados y cuentan como tiempo trabajado (no generan
// descuento), EXCEPTO "Falta de asistencia no justificada", que es el
// único que sí resta del cómputo del mes. Por eso este último motivo
// tiene su propia constante (MOTIVO_NO_JUSTIFICADO), para que el resto
// del código pueda reconocerlo sin tener que repetir el texto literal.
export const MOTIVOS_CORRECCION = [
  'Asistencia a consulta médica',
  'Baja médica',
  'Citaciones judiciales o renovación DNI',
  'Fallecimiento de familiar, accidente o enfermedad grave',
  'Falta de asistencia no justificada',
  'Gestión Externa (labores realizadas fuera del centro de trabajo)',
  'Lactancia',
  'Maternidad',
  'Matrimonio o registro de pareja de hecho',
  'Olvidó fichar en su franja horaria',
  'Otros motivos solicitados',
  'Paternidad'
];

// Subconjunto que puede ver y elegir el propio TRABAJADOR (al fichar fuera
// de horario o al solicitar la corrección de uno de sus registros). Orden
// fijo, no alfabético (decidido así a propósito, no cambiar el orden sin
// que lo pidan): "Olvidó fichar en su franja horaria" el primero (el motivo
// más habitual), luego el resto de motivos frecuentes, "Otros motivos
// solicitados" como comodín para cualquier caso no listado, y "Falta de
// asistencia no justificada" siempre al final, como opción honesta para
// que el propio trabajador pueda reconocer una ausencia no justificada.
export const MOTIVOS_CORRECCION_TRABAJADOR = [
  'Olvidó fichar en su franja horaria',
  'Asistencia a consulta médica',
  'Citaciones judiciales o renovación DNI',
  'Fallecimiento de familiar, accidente o enfermedad grave',
  'Gestión Externa (labores realizadas fuera del centro de trabajo)',
  'Lactancia',
  'Otros motivos solicitados',
  'Falta de asistencia no justificada'
];

export const MOTIVO_NO_JUSTIFICADO = 'Falta de asistencia no justificada';

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

// Igual que combinarFechaHoraCanarias, pero para cuando la FECHA tampoco es
// "ahora" (p. ej. al calcular el instante real de una hora rectificada por
// un administrador, con su propia fecha en formato "DD/MM/AAAA").
export function combinarFechaYHoraCanarias(fechaStr, horaStr) {
  const partesFecha = String(fechaStr).split('/').map(Number);
  const dia = partesFecha[0] || 1, mes = partesFecha[1] || 1, anio = partesFecha[2] || 1970;
  const partesHora = String(horaStr).split(':').map(Number);
  const horas = partesHora[0] || 0;
  const minutos = partesHora[1] || 0;
  const segundos = partesHora[2] || 0;
  const candidatoUTC = new Date(Date.UTC(anio, mes - 1, dia, horas, minutos, segundos));
  const offsetMin = obtenerOffsetMinutosCanarias(candidatoUTC);
  return new Date(candidatoUTC.getTime() - offsetMin * 60000);
}

export function nombreMes(mes) {
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return meses[mes - 1];
}

function dentroDeMargen(momento, esperado) {
  return Math.abs(momento.getTime() - esperado.getTime()) / 60000 <= TOLERANCIA_MIN;
}

// ---------- HORARIO PARTIDO (varias franjas / "tramos" horarios al día) ----------
// El horario de un día puede guardarse de dos formas:
//   - Formato nuevo:  { tramos: [ {entrada:'08:00', salida:'13:00'}, {entrada:'15:00', salida:'18:00'} ], modalidad? }
//     Admite CUALQUIER número de tramos (uno, dos, tres o más franjas al día).
//   - Formato antiguo (compatibilidad con datos ya guardados):
//       { entrada:'08:00', salida:'17:00', pausaInicio?:'13:00', pausaFin?:'14:00' }
// obtenerTramosValidos() traduce cualquiera de los dos formatos a una lista
// de tramos {entrada, salida} en orden, para que el resto del código (aquí y
// en firestore-datos.js) no tenga que preocuparse de cuál se usó al guardar.
export function obtenerTramosValidos(horarioDia) {
  if (!horarioDia) return [];
  if (Array.isArray(horarioDia.tramos)) {
    return horarioDia.tramos.filter(function (t) { return t && t.entrada && t.salida; });
  }
  // Formato antiguo: un único entrada/salida, con pausa opcional que lo
  // parte en dos tramos.
  if (horarioDia.entrada && horarioDia.salida) {
    if (horarioDia.pausaInicio && horarioDia.pausaFin) {
      return [
        { entrada: horarioDia.entrada, salida: horarioDia.pausaInicio },
        { entrada: horarioDia.pausaFin, salida: horarioDia.salida }
      ];
    }
    return [{ entrada: horarioDia.entrada, salida: horarioDia.salida }];
  }
  return [];
}

// Evalúa si un fichaje cae dentro o fuera de la jornada laboral prevista,
// con un margen de tolerancia de TOLERANCIA_MIN minutos EN CADA SENTIDO
// (antes y después) alrededor de cada hora prevista concreta — nunca se
// compara contra "toda la jornada de golpe".
//
// Un día puede tener varios tramos (horario partido: mañana, tarde, o más
// franjas). Una ENTRADA se acepta si coincide con la entrada prevista de
// CUALQUIER tramo de ese día; una SALIDA se acepta si coincide con la salida
// prevista de CUALQUIER tramo. Si no coincide con ninguno, se compara contra
// el tramo cuya hora prevista tenga más cerca, para dar un mensaje útil.
export function evaluarPuntualidad(horarioDia, tipo, ahora) {
  const tramos = obtenerTramosValidos(horarioDia);
  if (tramos.length === 0) return { fueraDeTiempo: false };

  const campo = tipo === 'Entrada' ? 'entrada' : 'salida';
  const candidatos = tramos.map(function (tramo, indice) {
    return { indice: indice, horaStr: tramo[campo], esperado: combinarFechaHoraCanarias(ahora, tramo[campo]) };
  });

  for (let i = 0; i < candidatos.length; i++) {
    if (dentroDeMargen(ahora, candidatos[i].esperado)) return { fueraDeTiempo: false };
  }

  // Ninguna coincide: nos quedamos con la más cercana para el mensaje.
  let masCercano = candidatos[0];
  for (let i = 1; i < candidatos.length; i++) {
    if (Math.abs(ahora - candidatos[i].esperado) < Math.abs(ahora - masCercano.esperado)) {
      masCercano = candidatos[i];
    }
  }
  const diffMin = Math.round((ahora - masCercano.esperado) / 60000);
  const esTarde = diffMin > 0;

  if (tipo === 'Entrada') {
    if (masCercano.indice === 0) {
      return {
        fueraDeTiempo: true, tipo: esTarde ? 'Retraso' : 'Entrada anticipada',
        detalle: 'Entrada con ' + Math.abs(diffMin) + ' min de ' + (esTarde ? 'retraso' : 'antelación') + ' (prevista ' + masCercano.horaStr + ')',
        minutos: diffMin
      };
    }
    return {
      fueraDeTiempo: true, tipo: 'Entrada fuera de horario',
      detalle: 'Entrada con ' + Math.abs(diffMin) + ' min de diferencia sobre la entrada prevista del tramo (' + masCercano.horaStr + ')',
      minutos: diffMin
    };
  }

  // Salida
  if (masCercano.indice === tramos.length - 1 && esTarde) {
    return {
      fueraDeTiempo: true, tipo: 'Posibles horas extra',
      detalle: 'Salida ' + diffMin + ' min más tarde de lo previsto (prevista ' + masCercano.horaStr + ')',
      minutos: diffMin
    };
  }
  return {
    fueraDeTiempo: true, tipo: 'Salida anticipada',
    detalle: 'Salida con ' + Math.abs(diffMin) + ' min de diferencia sobre la salida prevista (' + masCercano.horaStr + ')',
    minutos: diffMin
  };
}
