// ---------- ACCESO A FIRESTORE DESDE EL NAVEGADOR (sin Cloud Functions) ----------
// Sustituye a las antiguas Cloud Functions. Cada función de aquí hace
// directamente lo que antes hacía una función del servidor, usando el SDK
// de cliente de Firestore. La seguridad real la imponen las reglas de
// Firestore (firestore.rules), no este archivo — este archivo asume que
// las reglas rechazarán cualquier operación indebida.

import {
  doc, getDoc, setDoc, updateDoc, addDoc, collection, collectionGroup,
  query, where, orderBy, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

import {
  soloDigitos, normalizarDia, formatearFecha, formatearHoraCompleta, formatearHoraCorta,
  obtenerDiaSemana, evaluarPuntualidad, MOTIVOS_CORRECCION, nombreMes, TOLERANCIA_MIN
} from './logica-comun.js';

function mapearTrabajador(dni, datos) {
  const apellidos = String((datos && datos.apellidos) || '').trim();
  const nombrePila = String((datos && datos.nombre) || '').trim();
  return {
    id: dni, dni: dni, apellidos: apellidos, nombrePila: nombrePila,
    nombre: apellidos && nombrePila ? (apellidos + ', ' + nombrePila) : (apellidos || nombrePila),
    categoria: (datos && datos.categoria) || '',
    activo: !datos || datos.activo !== false
  };
}

async function buscarTrabajadorPorDni(db, dni) {
  const dniDigits = soloDigitos(dni);
  if (!dniDigits) return null;
  const snap = await getDoc(doc(db, 'trabajadores', dniDigits));
  if (!snap.exists()) return null;
  return mapearTrabajador(dniDigits, snap.data());
}

function partesFechaValidas(fechaStr, mes, anio) {
  const partes = String(fechaStr || '').split('/');
  return partes.length === 3 && Number(partes[1]) === Number(mes) && Number(partes[2]) === Number(anio);
}

// =====================================================================
// FICHAR / MOTIVOS (trabajador — sin login, DNI como código de acceso)
// =====================================================================
export async function fichar(db, pin, tipo) {
  const trabajador = await buscarTrabajadorPorDni(db, pin);
  if (!trabajador) return { ok: false, mensaje: 'DNI/NIE no reconocido.' };
  if (!trabajador.activo) return { ok: false, mensaje: 'Este trabajador está dado de baja y no puede fichar.' };
  if (tipo !== 'Entrada' && tipo !== 'Salida') return { ok: false, mensaje: 'Tipo de fichaje no válido.' };

  const dni = trabajador.dni;
  const ahora = new Date();
  const fichajesRef = collection(db, 'trabajadores', dni, 'fichajes');

  const ultimoSnap = await getDocs(query(fichajesRef, orderBy('timestampMs', 'desc'), limit(1)));
  if (!ultimoSnap.empty) {
    const ultimo = ultimoSnap.docs[0].data();
    if (ultimo.tipo === tipo && (ahora.getTime() - ultimo.timestampMs) / 1000 < 60) {
      return { ok: false, mensaje: 'Ya has fichado ' + tipo.toLowerCase() + ' hace menos de un minuto.' };
    }
  }

  const fechaStr = formatearFecha(ahora);
  const horaStr = formatearHoraCompleta(ahora);
  const diaSemana = obtenerDiaSemana(ahora);

  const horarioSnap = await getDoc(doc(db, 'horarios', dni));
  const horarioSemanal = horarioSnap.exists() ? horarioSnap.data() : {};
  const claveDia = Object.keys(horarioSemanal).find(function (d) { return normalizarDia(d) === normalizarDia(diaSemana); });
  const horarioHoy = claveDia ? horarioSemanal[claveDia] : null;

  let primeraEntrada = false;
  if (tipo === 'Entrada') {
    const primeraSnap = await getDocs(query(fichajesRef, where('fecha', '==', fechaStr), where('tipo', '==', 'Entrada'), limit(1)));
    primeraEntrada = primeraSnap.empty;
  }

  const evaluacion = evaluarPuntualidad(horarioHoy, tipo, ahora, primeraEntrada);

  await addDoc(fichajesRef, {
    trabajadorId: dni, nombre: trabajador.nombre, timestampMs: ahora.getTime(),
    fecha: fechaStr, hora: horaStr, tipo: tipo,
    advertencia: evaluacion.fueraDeTiempo ? ('ADVERTENCIA: ' + evaluacion.detalle) : ''
  });

  let refJustificacion = null;
  if (evaluacion.fueraDeTiempo) {
    // Evita incidencias duplicadas: si el trabajador ficha varias veces
    // seguidas (p. ej. por error, doble clic o dos pestañas abiertas a la
    // vez), no se crea una incidencia nueva por cada fichaje si ya hay una
    // "Pendiente" del mismo tipo, mismo día y de hace muy poco (< 5 min).
    // El fichaje en sí SIEMPRE se guarda (es un hecho real); solo se evita
    // la incidencia repetida.
    // Solo se filtra por "fecha" (una única igualdad) para no necesitar un
    // índice compuesto en Firestore; el resto se comprueba en el navegador,
    // que es rápido porque un mismo día nunca tiene muchas incidencias.
    const incidenciasHoySnap = await getDocs(query(
      collection(db, 'trabajadores', dni, 'incidencias'), where('fecha', '==', fechaStr)
    ));
    let ultimaMismaTipoPendienteMs = null;
    incidenciasHoySnap.docs.forEach(function (d) {
      const inc = d.data();
      if (inc.tipo === evaluacion.tipo && inc.justificada === 'Pendiente') {
        if (ultimaMismaTipoPendienteMs === null || inc.timestampMs > ultimaMismaTipoPendienteMs) {
          ultimaMismaTipoPendienteMs = inc.timestampMs;
        }
      }
    });
    const yaHayIncidenciaReciente = ultimaMismaTipoPendienteMs !== null &&
      (ahora.getTime() - ultimaMismaTipoPendienteMs) / 60000 < 5;

    if (!yaHayIncidenciaReciente) {
      await addDoc(collection(db, 'trabajadores', dni, 'incidencias'), {
        trabajadorId: dni, nombre: trabajador.nombre, fecha: fechaStr, hora: horaStr,
        tipo: evaluacion.tipo, detalle: evaluacion.detalle, minutos: evaluacion.minutos,
        justificada: 'Pendiente', timestampMs: ahora.getTime()
      });
    }
    refJustificacion = { fecha: fechaStr, hora: horaStr, tipoIncidencia: evaluacion.tipo };
  }

  return {
    ok: true, nombre: trabajador.nombre, tipo: tipo, hora: formatearHoraCorta(ahora),
    aviso: evaluacion.fueraDeTiempo ? evaluacion.detalle : null, justificacion: refJustificacion
  };
}

async function registrarCorreccion(db, dni, datos) {
  const ahora = new Date();
  await addDoc(collection(db, 'trabajadores', dni, 'correcciones'), Object.assign({
    fechaSolicitud: formatearFecha(ahora), horaSolicitud: formatearHoraCompleta(ahora),
    timestampMs: ahora.getTime()
  }, datos));
}

export async function indicarMotivoRegistro(db, pin, tipoRegistro, fecha, hora, motivo) {
  const trabajador = await buscarTrabajadorPorDni(db, pin);
  if (!trabajador) return { ok: false, mensaje: 'DNI/NIE no reconocido.' };
  if (MOTIVOS_CORRECCION.indexOf(motivo) === -1) return { ok: false, mensaje: 'Selecciona un motivo de la lista.' };

  await registrarCorreccion(db, trabajador.dni, {
    solicitanteId: trabajador.dni, solicitanteNombre: trabajador.nombre, rolSolicitante: 'Trabajador',
    afectadoId: trabajador.dni, afectadoNombre: trabajador.nombre,
    tipoRegistro: tipoRegistro, fechaOriginal: fecha, horaOriginal: hora,
    motivo: String(motivo).trim(), valorPropuesto: ''
  });
  return { ok: true };
}

// =====================================================================
// CONSULTA DE REGISTROS DE UN TRABAJADOR (Mis registros / Administración)
// =====================================================================
async function obtenerRegistrosPorDni(db, dni, mes, anio) {
  const [fichajesSnap, incidenciasSnap, correccionesSnap] = await Promise.all([
    getDocs(collection(db, 'trabajadores', dni, 'fichajes')),
    getDocs(collection(db, 'trabajadores', dni, 'incidencias')),
    getDocs(collection(db, 'trabajadores', dni, 'correcciones'))
  ]);

  const mapaTipoIncidencia = {};
  incidenciasSnap.docs.forEach(function (d) {
    const inc = d.data();
    mapaTipoIncidencia[inc.fecha + '|' + inc.hora] = inc.tipo;
  });

  const registros = fichajesSnap.docs
    .map(function (d) { return d.data(); })
    .filter(function (f) { return partesFechaValidas(f.fecha, mes, anio); })
    .map(function (f) {
      return {
        fecha: f.fecha, hora: f.hora, tipo: f.tipo, advertencia: f.advertencia || '',
        tipoIncidencia: mapaTipoIncidencia[f.fecha + '|' + f.hora] || f.tipo
      };
    })
    .sort(function (a, b) { return (a.fecha + a.hora).localeCompare(b.fecha + b.hora); });

  const incidencias = incidenciasSnap.docs
    .map(function (d) { return d.data(); })
    .filter(function (i) { return partesFechaValidas(i.fecha, mes, anio); })
    .map(function (i) { return { fecha: i.fecha, tipo: i.tipo, detalle: i.detalle, justificada: i.justificada }; });

  const correcciones = correccionesSnap.docs
    .map(function (d) { return d.data(); })
    .filter(function (c) { return partesFechaValidas(c.fechaOriginal, mes, anio); })
    .map(function (c) {
      return {
        fechaSolicitud: c.fechaSolicitud, solicitante: c.solicitanteNombre, rolSolicitante: c.rolSolicitante,
        tipoRegistro: c.tipoRegistro, fechaOriginal: c.fechaOriginal, horaOriginal: c.horaOriginal,
        motivo: c.motivo, valorPropuesto: c.valorPropuesto
      };
    });

  return { registros: registros, incidencias: incidencias, correcciones: correcciones };
}

export async function obtenerMisRegistros(db, pin, mes, anio) {
  const trabajador = await buscarTrabajadorPorDni(db, pin);
  if (!trabajador) return { ok: false, mensaje: 'DNI/NIE no reconocido.' };
  const datos = await obtenerRegistrosPorDni(db, trabajador.dni, mes, anio);
  return Object.assign({ ok: true, nombre: trabajador.nombre }, datos);
}

// =====================================================================
// ADMINISTRACIÓN: login real con Firebase Authentication
// =====================================================================
export async function loginAdmin(auth, db, email, password) {
  try {
    const credencial = await signInWithEmailAndPassword(auth, email, password);
    const uid = credencial.user.uid;
    const perfilSnap = await getDoc(doc(db, 'administradores', uid));
    if (!perfilSnap.exists()) {
      await signOut(auth);
      return { ok: false, mensaje: 'Esta cuenta no está autorizada como administrador.' };
    }
    return { ok: true, nombre: perfilSnap.data().nombre || email, uid: uid };
  } catch (err) {
    return { ok: false, mensaje: 'Email o contraseña incorrectos.' };
  }
}

export function logoutAdmin(auth) {
  return signOut(auth);
}

export function observarSesionAdmin(auth, callback) {
  return onAuthStateChanged(auth, callback);
}

// =====================================================================
// ADMINISTRACIÓN: registros pendientes, agrupados por trabajador
// =====================================================================
export async function obtenerRegistrosPendientes(db) {
  const [incidenciasSnap, correccionesSnap] = await Promise.all([
    getDocs(collectionGroup(db, 'incidencias')),
    getDocs(collectionGroup(db, 'correcciones'))
  ]);

  const motivosPorClave = {};
  correccionesSnap.docs.forEach(function (d) {
    const c = d.data();
    if (c.rolSolicitante !== 'Trabajador') return;
    motivosPorClave[c.afectadoId + '|' + c.fechaOriginal + '|' + c.horaOriginal + '|' + c.tipoRegistro] = c.motivo;
  });

  const dniCache = {};
  const horarioCache = {};
  async function obtenerDniInfo(dni) {
    if (dniCache[dni]) return dniCache[dni];
    const [tSnap, hSnap] = await Promise.all([
      getDoc(doc(db, 'trabajadores', dni)),
      getDoc(doc(db, 'horarios', dni))
    ]);
    dniCache[dni] = tSnap.exists() ? mapearTrabajador(dni, tSnap.data()) : null;
    horarioCache[dni] = hSnap.exists() ? hSnap.data() : {};
    return dniCache[dni];
  }

  const pendientes = [];
  for (const d of incidenciasSnap.docs) {
    const inc = d.data();
    if (inc.justificada === 'Sí' || inc.justificada === 'Resuelto') continue;
    const dni = inc.trabajadorId;
    await obtenerDniInfo(dni);

    const partesFecha = String(inc.fecha).split('/');
    const diaSemana = partesFecha.length === 3
      ? new Date(Number(partesFecha[2]), Number(partesFecha[1]) - 1, Number(partesFecha[0])).toLocaleDateString('es-ES', { weekday: 'long' })
      : '';
    const horarioTrabajador = horarioCache[dni] || {};
    const diaKey = Object.keys(horarioTrabajador).find(function (dd) { return dd.toLowerCase().startsWith(diaSemana.toLowerCase().slice(0, 3)); });
    const horarioEseDia = diaKey ? (horarioTrabajador[diaKey].entrada + ' - ' + horarioTrabajador[diaKey].salida) : '';

    const clave = dni + '|' + inc.fecha + '|' + inc.hora + '|' + inc.tipo;
    pendientes.push({
      trabajadorId: dni, trabajadorNombre: inc.nombre, trabajadorDni: dni, horarioEseDia: horarioEseDia,
      fecha: inc.fecha, hora: inc.hora, tipo: inc.tipo, detalle: inc.detalle,
      estado: inc.justificada || 'Pendiente', motivoTrabajador: motivosPorClave[clave] || '',
      _refPath: d.ref.path
    });
  }

  pendientes.sort(function (a, b) {
    const pa = a.fecha.split('/').map(Number), pb = b.fecha.split('/').map(Number);
    return new Date(pb[2] || 0, (pb[1] || 1) - 1, pb[0] || 1) - new Date(pa[2] || 0, (pa[1] || 1) - 1, pa[0] || 1);
  });

  return { ok: true, pendientes: pendientes };
}

export async function resolverRegistroAdmin(db, auth, trabajadorId, tipoRegistro, fecha, hora, motivo, valorPropuesto) {
  if (!auth.currentUser) return { ok: false, mensaje: 'Tu sesión ha caducado. Vuelve a identificarte.' };
  if (MOTIVOS_CORRECCION.indexOf(motivo) === -1) return { ok: false, mensaje: 'Selecciona un motivo de la lista.' };

  const trabajador = await buscarTrabajadorPorDni(db, trabajadorId);
  if (!trabajador) return { ok: false, mensaje: 'No se encontró ese trabajador.' };

  await registrarCorreccion(db, trabajador.dni, {
    solicitanteId: 'ADMIN', solicitanteNombre: auth.currentUser.email, rolSolicitante: 'Administrador',
    afectadoId: trabajador.dni, afectadoNombre: trabajador.nombre,
    tipoRegistro: tipoRegistro, fechaOriginal: fecha, horaOriginal: hora,
    motivo: String(motivo).trim(), valorPropuesto: valorPropuesto ? String(valorPropuesto).trim() : ''
  });

  // Marcar la incidencia exacta como resuelta.
  const incSnap = await getDocs(query(
    collection(db, 'trabajadores', trabajador.dni, 'incidencias'),
    where('fecha', '==', fecha), where('hora', '==', hora), where('tipo', '==', tipoRegistro), limit(1)
  ));
  if (!incSnap.empty) {
    await updateDoc(incSnap.docs[0].ref, { justificada: 'Resuelto', resueltoPor: auth.currentUser.uid, resueltoEl: formatearFecha(new Date()) });
  }

  return { ok: true };
}

export async function obtenerRegistrosAdmin(db, dniObjetivo, mes, anio) {
  const objetivo = await buscarTrabajadorPorDni(db, dniObjetivo);
  if (!objetivo) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };
  const datos = await obtenerRegistrosPorDni(db, objetivo.dni, mes, anio);
  return Object.assign({ ok: true, nombre: objetivo.nombre }, datos);
}

export async function solicitarCorreccionAdmin(db, auth, dniAfectado, tipoRegistro, fechaOriginal, horaOriginal, motivo, valorPropuesto) {
  if (!auth.currentUser) return { ok: false, mensaje: 'Tu sesión ha caducado. Vuelve a identificarte.' };
  const afectado = await buscarTrabajadorPorDni(db, dniAfectado);
  if (!afectado) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };
  if (MOTIVOS_CORRECCION.indexOf(motivo) === -1) return { ok: false, mensaje: 'Selecciona un motivo de la lista.' };

  await registrarCorreccion(db, afectado.dni, {
    solicitanteId: 'ADMIN', solicitanteNombre: auth.currentUser.email, rolSolicitante: 'Administrador',
    afectadoId: afectado.dni, afectadoNombre: afectado.nombre,
    tipoRegistro: tipoRegistro, fechaOriginal: fechaOriginal, horaOriginal: horaOriginal,
    motivo: String(motivo).trim(), valorPropuesto: valorPropuesto ? String(valorPropuesto).trim() : ''
  });
  return { ok: true };
}

// =====================================================================
// GESTIÓN DE TRABAJADORES (alta / baja / reactivar / listado)
// =====================================================================
export async function obtenerListaTrabajadores(db) {
  const snap = await getDocs(collection(db, 'trabajadores'));
  const lista = snap.docs.map(function (d) { return mapearTrabajador(d.id, d.data()); });
  lista.sort(function (a, b) { return String(a.apellidos).localeCompare(String(b.apellidos), 'es'); });
  return { ok: true, trabajadores: lista };
}

export async function anadirTrabajador(db, datos) {
  const apellidos = String(datos.apellidos || '').trim();
  const nombre = String(datos.nombre || '').trim();
  const dni = soloDigitos(datos.dni);

  if (!apellidos || !nombre) return { ok: false, mensaje: 'Indica los apellidos y el nombre.' };
  if (!dni) return { ok: false, mensaje: 'Indica un DNI/NIE válido.' };

  const ref = doc(db, 'trabajadores', dni);
  const existente = await getDoc(ref);
  if (existente.exists()) return { ok: false, mensaje: 'Ya existe un trabajador con ese DNI/NIE (activo o de baja).' };

  await setDoc(ref, { apellidos: apellidos, nombre: nombre, categoria: String(datos.categoria || '').trim(), activo: true });
  await setDoc(doc(db, 'trabajadores_privado', dni), { nss: String(datos.nss || '').trim(), email: String(datos.email || '').trim() });

  let diasGuardados = 0;
  if (datos.horarioSemanal && typeof datos.horarioSemanal === 'object') {
    const horarioLimpio = {};
    Object.keys(datos.horarioSemanal).forEach(function (dia) {
      const h = datos.horarioSemanal[dia];
      if (h && h.entrada && h.salida) { horarioLimpio[dia] = { entrada: h.entrada, salida: h.salida }; diasGuardados++; }
    });
    if (diasGuardados > 0) await setDoc(doc(db, 'horarios', dni), horarioLimpio);
  }

  return { ok: true, id: dni, nombre: apellidos + ', ' + nombre, diasHorario: diasGuardados };
}

export async function cambiarEstadoActivo(db, dni, activo) {
  const dniDigits = soloDigitos(dni);
  if (!dniDigits) return { ok: false, mensaje: 'DNI/NIE no válido.' };
  const ref = doc(db, 'trabajadores', dniDigits);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };
  await updateDoc(ref, { activo: !!activo });
  return { ok: true, nombre: mapearTrabajador(dniDigits, snap.data()).nombre, activo: !!activo };
}

// =====================================================================
// CALENDARIO LABORAL
// =====================================================================
function parsearFechaISO(iso) {
  const partes = String(iso).split('-').map(Number);
  return new Date(partes[0], partes[1] - 1, partes[2]);
}

export async function anadirPeriodoCalendario(db, fechaInicioISO, fechaFinISO, tipo, dniTrabajador, nota) {
  if (!fechaInicioISO || !tipo) return { ok: false, mensaje: 'Indica al menos la fecha de inicio y el tipo de día.' };
  if (['Festivo', 'Vacaciones', 'BajaMedica'].indexOf(tipo) === -1) return { ok: false, mensaje: 'Tipo de día no válido.' };

  let trabajadorId = null, trabajadorNombre = 'Todo el equipo';
  if (tipo !== 'Festivo') {
    if (!dniTrabajador) return { ok: false, mensaje: 'Indica el trabajador para vacaciones o baja médica.' };
    const t = await buscarTrabajadorPorDni(db, dniTrabajador);
    if (!t) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };
    trabajadorId = t.dni; trabajadorNombre = t.nombre;
  }

  let inicio = parsearFechaISO(fechaInicioISO);
  let fin = fechaFinISO ? parsearFechaISO(fechaFinISO) : inicio;
  if (fin < inicio) { const tmp = inicio; inicio = fin; fin = tmp; }

  const diasTotales = Math.round((fin - inicio) / 86400000) + 1;
  if (diasTotales > 366) return { ok: false, mensaje: 'El periodo es demasiado largo (máximo 366 días).' };

  const notaLimpia = nota ? String(nota).trim() : '';
  const registradoEl = formatearFecha(new Date());
  const cursor = new Date(inicio);
  let contador = 0;
  while (cursor <= fin) {
    await addDoc(collection(db, 'calendario'), {
      fecha: formatearFecha(cursor), tipo: tipo, trabajadorId: trabajadorId,
      nota: notaLimpia, fechaRegistro: registradoEl
    });
    cursor.setDate(cursor.getDate() + 1);
    contador++;
  }

  return { ok: true, diasAnadidos: contador, fechaInicio: formatearFecha(inicio), fechaFin: formatearFecha(fin), trabajadorNombre: trabajadorNombre };
}

// =====================================================================
// INFORMES: cálculo de periodos (idéntico al que tenían las Cloud Functions)
// =====================================================================
export const TIPOS_PERIODO_VALIDOS = ['diario', 'semanal', 'mensual', 'trimestral', 'semestral', 'anual'];

function ordinalTrimestre(n) { return { 1: '1er', 2: '2º', 3: '3er', 4: '4º' }[n] || (n + 'º'); }

export function calcularPeriodo(tipoPeriodo, fechaReferenciaISO) {
  const ref = fechaReferenciaISO ? parsearFechaISO(fechaReferenciaISO) : new Date();
  let inicio, fin, etiqueta;
  switch (tipoPeriodo) {
    case 'diario':
      inicio = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      fin = new Date(inicio);
      etiqueta = formatearFecha(inicio);
      break;
    case 'semanal': {
      const diaSemanaISO = (ref.getDay() + 6) % 7;
      inicio = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - diaSemanaISO);
      fin = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + 6);
      etiqueta = 'Semana del ' + formatearFecha(inicio) + ' al ' + formatearFecha(fin);
      break;
    }
    case 'mensual':
      inicio = new Date(ref.getFullYear(), ref.getMonth(), 1);
      fin = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
      etiqueta = nombreMes(ref.getMonth() + 1) + ' de ' + ref.getFullYear();
      break;
    case 'trimestral': {
      const trimestre = Math.floor(ref.getMonth() / 3);
      inicio = new Date(ref.getFullYear(), trimestre * 3, 1);
      fin = new Date(ref.getFullYear(), trimestre * 3 + 3, 0);
      etiqueta = ordinalTrimestre(trimestre + 1) + ' trimestre de ' + ref.getFullYear();
      break;
    }
    case 'semestral': {
      const semestre = ref.getMonth() < 6 ? 0 : 1;
      inicio = new Date(ref.getFullYear(), semestre * 6, 1);
      fin = new Date(ref.getFullYear(), semestre * 6 + 6, 0);
      etiqueta = (semestre + 1) + 'º semestre de ' + ref.getFullYear();
      break;
    }
    case 'anual':
      inicio = new Date(ref.getFullYear(), 0, 1);
      fin = new Date(ref.getFullYear(), 11, 31);
      etiqueta = 'Año ' + ref.getFullYear();
      break;
    default:
      return null;
  }
  return { inicio: inicio, fin: fin, etiqueta: etiqueta };
}

function fechaEnRango(fechaStr, inicio, fin) {
  const partes = String(fechaStr || '').split('/').map(Number);
  if (partes.length !== 3) return false;
  const f = new Date(partes[2], partes[1] - 1, partes[0]);
  return f >= inicio && f <= fin;
}

export function calcularHorasTrabajadas(registros) {
  let totalMin = 0, entradaAbierta = null;
  registros.forEach(function (r) {
    if (r.tipo === 'Entrada') {
      entradaAbierta = r.timestampMs || null;
    } else if (r.tipo === 'Salida' && entradaAbierta) {
      if (r.timestampMs && r.timestampMs > entradaAbierta) totalMin += Math.round((r.timestampMs - entradaAbierta) / 60000);
      entradaAbierta = null;
    }
  });
  const horas = Math.floor(totalMin / 60), min = totalMin % 60;
  return horas + 'h ' + String(min).padStart(2, '0') + 'min';
}

export function estadoDeRegistro(r, correcciones) {
  const necesitaCorreccion = !!r.advertencia;
  const corrAdmin = correcciones.find(function (c) { return c.rolSolicitante === 'Administrador' && c.fechaOriginal === r.fecha && c.horaOriginal === r.hora && c.tipoRegistro === r.tipoIncidencia; });
  const corrTrabajador = correcciones.find(function (c) { return c.rolSolicitante === 'Trabajador' && c.fechaOriginal === r.fecha && c.horaOriginal === r.hora && c.tipoRegistro === r.tipoIncidencia; });
  if (corrAdmin) return { color: '#B9770E', etiqueta: 'Corregido', corrAdmin: corrAdmin, corrTrabajador: corrTrabajador };
  if (corrTrabajador) return { color: '#6B3FA0', etiqueta: 'Solicitada', corrAdmin: null, corrTrabajador: corrTrabajador };
  if (necesitaCorreccion) return { color: '#C0392B', etiqueta: 'Pendiente', corrAdmin: null, corrTrabajador: null };
  return { color: '#1F6F63', etiqueta: 'Correcto', corrAdmin: null, corrTrabajador: null };
}

// Datos de un trabajador para un rango de fechas (no solo un mes) — se
// reutiliza obtenerRegistrosPorDni pero sin el filtro de mes/año exacto.
export async function obtenerDatosPeriodo(db, dni, inicio, fin) {
  const [fichajesSnap, incidenciasSnap, correccionesSnap] = await Promise.all([
    getDocs(collection(db, 'trabajadores', dni, 'fichajes')),
    getDocs(collection(db, 'trabajadores', dni, 'incidencias')),
    getDocs(collection(db, 'trabajadores', dni, 'correcciones'))
  ]);
  const mapaTipoIncidencia = {};
  incidenciasSnap.docs.forEach(function (d) { const i = d.data(); mapaTipoIncidencia[i.fecha + '|' + i.hora] = i.tipo; });

  const registros = fichajesSnap.docs.map(function (d) { return d.data(); })
    .filter(function (f) { return fechaEnRango(f.fecha, inicio, fin); })
    .map(function (f) { return { fecha: f.fecha, hora: f.hora, tipo: f.tipo, advertencia: f.advertencia || '', tipoIncidencia: mapaTipoIncidencia[f.fecha + '|' + f.hora] || f.tipo, timestampMs: f.timestampMs }; })
    .sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });

  const incidencias = incidenciasSnap.docs.map(function (d) { return d.data(); }).filter(function (i) { return fechaEnRango(i.fecha, inicio, fin); });
  const correcciones = correccionesSnap.docs.map(function (d) { return d.data(); }).filter(function (c) { return fechaEnRango(c.fechaOriginal, inicio, fin); });

  return { registros: registros, incidencias: incidencias, correcciones: correcciones };
}

export async function obtenerTrabajadorCompleto(db, dni) {
  const dniDigits = soloDigitos(dni);
  const [pubSnap, privSnap] = await Promise.all([
    getDoc(doc(db, 'trabajadores', dniDigits)),
    getDoc(doc(db, 'trabajadores_privado', dniDigits))
  ]);
  if (!pubSnap.exists()) return null;
  const t = mapearTrabajador(dniDigits, pubSnap.data());
  if (privSnap.exists()) { t.nss = privSnap.data().nss || ''; t.email = privSnap.data().email || ''; }
  return t;
}

// =====================================================================
// COMPROBACIÓN DE AUSENCIAS
// =====================================================================
// Sin Cloud Functions no hay nada que compruebe esto solo por la noche.
// En su lugar, se ejecuta automáticamente cada vez que un administrador
// entra en Administración — así que basta con que alguien abra la app en
// algún momento del día (aunque sea a última hora) para que las ausencias
// del día queden registradas.
export async function comprobarAusenciasDeHoy(db) {
  const ahora = new Date();
  const fechaHoy = formatearFecha(ahora);
  const diaSemana = obtenerDiaSemana(ahora);

  const trabajadoresSnap = await getDocs(collection(db, 'trabajadores'));
  let creadas = 0;

  for (const tDoc of trabajadoresSnap.docs) {
    const t = mapearTrabajador(tDoc.id, tDoc.data());
    if (!t.activo) continue;

    const horarioSnap = await getDoc(doc(db, 'horarios', t.dni));
    if (!horarioSnap.exists()) continue;
    const horarioSemanal = horarioSnap.data();
    const claveDia = Object.keys(horarioSemanal).find(function (d) { return normalizarDia(d) === normalizarDia(diaSemana); });
    if (!claveDia) continue; // no le toca trabajar hoy
    const horarioHoy = horarioSemanal[claveDia];

    // ¿Ya pasó su hora de entrada (con margen)?
    const [hE, mE] = String(horarioHoy.entrada).split(':').map(Number);
    const minutosLimite = hE * 60 + mE + TOLERANCIA_MIN;
    const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();
    if (minutosAhora < minutosLimite) continue; // todavía no le toca

    const fichajesRef = collection(db, 'trabajadores', t.dni, 'fichajes');
    const entradaSnap = await getDocs(query(fichajesRef, where('fecha', '==', fechaHoy), where('tipo', '==', 'Entrada'), limit(1)));
    if (!entradaSnap.empty) continue; // ya fichó

    const incidenciasRef = collection(db, 'trabajadores', t.dni, 'incidencias');
    const yaRegistradaSnap = await getDocs(query(incidenciasRef, where('fecha', '==', fechaHoy), where('tipo', '==', 'Ausencia'), limit(1)));
    if (!yaRegistradaSnap.empty) continue; // ya estaba registrada

    await addDoc(incidenciasRef, {
      trabajadorId: t.dni, nombre: t.nombre, fecha: fechaHoy, hora: '—',
      tipo: 'Ausencia', detalle: 'No se ha registrado fichaje de entrada', minutos: 0,
      justificada: 'N/A', timestampMs: ahora.getTime()
    });
    creadas++;
  }

  return { ok: true, ausenciasDetectadas: creadas };
}
