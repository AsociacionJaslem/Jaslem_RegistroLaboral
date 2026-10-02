// ---------- ACCESO A FIRESTORE DESDE EL NAVEGADOR (sin Cloud Functions) ----------
// Sustituye a las antiguas Cloud Functions. Cada función de aquí hace
// directamente lo que antes hacía una función del servidor, usando el SDK
// de cliente de Firestore. La seguridad real la imponen las reglas de
// Firestore (firestore.rules), no este archivo — este archivo asume que
// las reglas rechazarán cualquier operación indebida.

import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, collectionGroup,
  query, where, orderBy, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  sendPasswordResetEmail, confirmPasswordReset, updatePassword
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

import {
  soloDigitos, normalizarDia, formatearFecha, formatearHoraCompleta, formatearHoraCorta,
  obtenerDiaSemana, evaluarPuntualidad, obtenerTramosValidos, MOTIVOS_CORRECCION, MOTIVO_NO_JUSTIFICADO, nombreMes, TOLERANCIA_MIN,
  calcularHashCodigo, codigoValido, calcularHuellaTexto, combinarFechaYHoraCanarias
} from './logica-comun.js';

export { MOTIVOS_CORRECCION, MOTIVO_NO_JUSTIFICADO };

// Perfiles de modalidad de trabajo válidos. "presencial" es el valor por
// defecto para no romper a los trabajadores dados de alta antes de que
// existiera este campo.
const PERFILES_TRABAJO_VALIDOS = ['presencial', 'teletrabajo', 'mixta'];

function mapearTrabajador(dni, datos) {
  const apellidos = String((datos && datos.apellidos) || '').trim();
  const nombrePila = String((datos && datos.nombre) || '').trim();
  const perfilTrabajo = (datos && PERFILES_TRABAJO_VALIDOS.indexOf(datos.perfilTrabajo) !== -1) ? datos.perfilTrabajo : 'presencial';
  return {
    id: dni, dni: dni, apellidos: apellidos, nombrePila: nombrePila,
    nombre: apellidos && nombrePila ? (apellidos + ', ' + nombrePila) : (apellidos || nombrePila),
    categoria: (datos && datos.categoria) || '',
    activo: !datos || datos.activo !== false,
    perfilTrabajo: perfilTrabajo,
    // Objetivo de horas SEMANALES de teletrabajo (100% teletrabajo, o la
    // parte de teletrabajo de un "mixta"). 0/ausente = sin objetivo fijado
    // todavía (no se calculan horas pendientes para ese trabajador).
    horasSemanalesTeletrabajo: Number((datos && datos.horasSemanalesTeletrabajo) || 0)
  };
}

// ¿Debe evaluarse la puntualidad de este fichaje, o el trabajador tiene
// libertad horaria ese día? El perfil "teletrabajo" (100%) siempre tiene
// libertad horaria. El perfil "mixta" depende de la modalidad marcada
// PARA ESE DÍA CONCRETO en su horario ("presencial" = se evalúa como
// siempre; "teletrabajo" o "mixta" ese día = libertad horaria). El perfil
// "presencial" (o cualquier trabajador antiguo sin perfil) se evalúa
// siempre, como hasta ahora.
function tieneLibertadHorariaHoy(perfilTrabajo, horarioHoy) {
  if (perfilTrabajo === 'teletrabajo') return true;
  if (perfilTrabajo === 'mixta') {
    const modalidadHoy = (horarioHoy && horarioHoy.modalidad) || 'presencial';
    return modalidadHoy !== 'presencial';
  }
  return false;
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
// FICHAR / MOTIVOS (trabajador — con su código de 6 dígitos, no con el DNI)
// =====================================================================
// Resuelve un código de 6 dígitos a su trabajador, sin guardar el código
// en ningún sitio: se calcula su huella y se busca esa huella exacta en
// "codigos_fichaje". Si el trabajador aún no ha aceptado su invitación (no
// tiene código todavía), esta búsqueda simplemente no encuentra nada.
async function buscarTrabajadorPorCodigo(db, codigo) {
  if (!codigoValido(codigo)) return null;
  const huella = await calcularHashCodigo(codigo);
  const snap = await getDoc(doc(db, 'codigos_fichaje', huella));
  if (!snap.exists()) return null;
  const dni = snap.data().dni;
  return buscarTrabajadorPorDni(db, dni);
}

export async function fichar(db, codigo, tipo) {
  const trabajador = await buscarTrabajadorPorCodigo(db, codigo);
  if (!trabajador) return { ok: false, mensaje: 'Código no reconocido.' };
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

  const libertadHoraria = tieneLibertadHorariaHoy(trabajador.perfilTrabajo, horarioHoy);
  const evaluacion = libertadHoraria ? { fueraDeTiempo: false } : evaluarPuntualidad(horarioHoy, tipo, ahora);

  const fichajeRef = await addDoc(fichajesRef, {
    trabajadorId: dni, nombre: trabajador.nombre, timestampMs: ahora.getTime(),
    fecha: fechaStr, hora: horaStr, tipo: tipo,
    tipoIncidencia: evaluacion.fueraDeTiempo ? evaluacion.tipo : tipo,
    advertencia: evaluacion.fueraDeTiempo ? ('ADVERTENCIA: ' + evaluacion.detalle) : ''
  });
  const fichajeId = fichajeRef.id;

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
        fichajeId: fichajeId, tipo: evaluacion.tipo, detalle: evaluacion.detalle, minutos: evaluacion.minutos,
        justificada: 'Pendiente', timestampMs: ahora.getTime()
      });
    }
    refJustificacion = { fichajeId: fichajeId, fecha: fechaStr, hora: horaStr, tipoIncidencia: evaluacion.tipo };
  }

  return {
    ok: true, nombre: trabajador.nombre, tipo: tipo, hora: formatearHoraCorta(ahora), fichajeId: fichajeId,
    aviso: evaluacion.fueraDeTiempo ? evaluacion.detalle : null, justificacion: refJustificacion
  };
}

// =====================================================================
// CORRECCIONES DE REGISTROS — cadena de rectificaciones, indefinida
// =====================================================================
// Cada corrección hace referencia al fichaje original por su ID ESTABLE de
// Firestore ("fichajeId"), nunca por fecha/hora/tipo (que podían coincidir
// por casualidad entre dos fichajes distintos). Todas las correcciones de
// un mismo fichaje forman una cadena cronológica que se conserva siempre,
// completa: nunca se borra ni se sustituye nada, solo se añaden entradas
// nuevas. Una entrada puede:
//   - Ser una SOLICITUD (normalmente del trabajador): solo indica un motivo
//     (de la lista cerrada MOTIVOS_CORRECCION), sin valorRectificado.
//   - Ser una RESOLUCIÓN (solo la puede crear un Administrador): indica un
//     motivo Y fija valorRectificado ({fecha, hora}) — ese valor pasa a ser
//     el OFICIAL del fichaje (el que cuenta para horas trabajadas e
//     informes) hasta que, si hace falta, una corrección posterior lo
//     vuelva a rectificar. Así se puede encadenar una rectificación de una
//     rectificación tantas veces como haga falta.
async function registrarCorreccion(db, dni, fichajeId, datos) {
  const ahora = new Date();
  const ref = await addDoc(collection(db, 'trabajadores', dni, 'correcciones'), Object.assign({
    fichajeId: fichajeId,
    fechaSolicitud: formatearFecha(ahora), horaSolicitud: formatearHoraCompleta(ahora),
    timestampMs: ahora.getTime()
  }, datos));
  return ref.id;
}

// Historial completo (ordenado cronológicamente) de correcciones de UN
// fichaje concreto.
async function obtenerCadenaCorrecciones(db, dni, fichajeId) {
  const snap = await getDocs(query(collection(db, 'trabajadores', dni, 'correcciones'), where('fichajeId', '==', fichajeId)));
  const cadena = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  cadena.sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });
  return cadena;
}

// El valor "oficial" de un fichaje: el valorRectificado de la corrección MÁS
// RECIENTE que tenga uno fijado (siempre puesto por un Administrador), o si
// ninguna corrección lo ha fijado todavía, el valor original del fichaje.
function valorOficialDeFichaje(fichaje, cadenaCorrecciones) {
  let oficial = { fecha: fichaje.fecha, hora: fichaje.hora, rectificado: false };
  (cadenaCorrecciones || []).forEach(function (c) {
    if (c.valorRectificado && c.valorRectificado.fecha && c.valorRectificado.hora) {
      oficial = { fecha: c.valorRectificado.fecha, hora: c.valorRectificado.hora, rectificado: true };
    }
  });
  return oficial;
}

// Estado a mostrar de un registro concreto, a partir de su cadena de
// correcciones — lo usan tanto "Mis registros" como "Administración".
//   'correcto'  -> nada pendiente, nunca hizo falta corregirlo
//   'pendiente' -> fuera de horario y todavía nadie ha hecho nada
//   'solicitada'-> el trabajador ha pedido una corrección, sin resolver aún
//   'corregido' -> ya hay un valor oficial rectificado por un administrador
function calcularEstadoRegistro(fichaje, cadenaCorrecciones) {
  const oficial = valorOficialDeFichaje(fichaje, cadenaCorrecciones);
  const ultima = cadenaCorrecciones[cadenaCorrecciones.length - 1];
  let estado = 'correcto';
  if (oficial.rectificado) estado = 'corregido';
  else if (ultima && ultima.rolSolicitante === 'Trabajador' && !ultima.valorRectificado) estado = 'solicitada';
  else if (fichaje.advertencia) estado = 'pendiente';
  return { estado: estado, oficial: oficial };
}

// SOLICITUD del propio trabajador: solo indica el motivo (de la lista
// cerrada) sobre CUALQUIER fichaje suyo, no solo los marcados en rojo. La
// hora corregida la decide siempre el administrador, nunca el trabajador.
export async function solicitarCorreccionTrabajador(db, codigo, fichajeId, motivo) {
  const trabajador = await buscarTrabajadorPorCodigo(db, codigo);
  if (!trabajador) return { ok: false, mensaje: 'Código no reconocido.' };
  if (MOTIVOS_CORRECCION.indexOf(motivo) === -1) return { ok: false, mensaje: 'Selecciona un motivo de la lista.' };
  if (!fichajeId) return { ok: false, mensaje: 'No se pudo identificar el registro a corregir.' };

  const fichajeSnap = await getDoc(doc(db, 'trabajadores', trabajador.dni, 'fichajes', fichajeId));
  if (!fichajeSnap.exists()) return { ok: false, mensaje: 'No se encontró ese registro.' };
  const fichaje = fichajeSnap.data();
  const cadena = await obtenerCadenaCorrecciones(db, trabajador.dni, fichajeId);
  const oficial = valorOficialDeFichaje(fichaje, cadena);

  await registrarCorreccion(db, trabajador.dni, fichajeId, {
    solicitanteId: trabajador.dni, solicitanteNombre: trabajador.nombre, rolSolicitante: 'Trabajador',
    afectadoId: trabajador.dni, afectadoNombre: trabajador.nombre,
    tipoRegistro: fichaje.tipoIncidencia || fichaje.tipo, fechaOriginal: fichaje.fecha, horaOriginal: fichaje.hora,
    valorAnterior: { fecha: oficial.fecha, hora: oficial.hora },
    motivo: String(motivo).trim(), valorRectificado: null
  });
  return { ok: true };
}

// Nombre anterior, conservado como alias por compatibilidad (mismo
// comportamiento que solicitarCorreccionTrabajador).
export const indicarMotivoRegistro = solicitarCorreccionTrabajador;

// =====================================================================
// CONSULTA DE REGISTROS DE UN TRABAJADOR (Mis registros / Administración)
// =====================================================================
// Junta los fichajes en bruto de Firestore con su cadena de correcciones
// (agrupadas por fichajeId) para producir la lista de "registros" que
// consumen tanto "Mis registros" como "Administración": cada uno con su id
// estable, su estado actual y su valor oficial (rectificado o no).
function construirRegistrosConCadenas(fichajesDocs, correccionesDocs) {
  const correccionesTodas = correccionesDocs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  const cadenasPorFichaje = {};
  correccionesTodas.forEach(function (c) {
    if (!c.fichajeId) return;
    (cadenasPorFichaje[c.fichajeId] = cadenasPorFichaje[c.fichajeId] || []).push(c);
  });
  Object.keys(cadenasPorFichaje).forEach(function (k) {
    cadenasPorFichaje[k].sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });
  });

  const registros = fichajesDocs.map(function (d) {
    const f = Object.assign({ id: d.id }, d.data());
    const cadena = cadenasPorFichaje[f.id] || [];
    const info = calcularEstadoRegistro(f, cadena);
    let timestampMs = f.timestampMs;
    if (info.oficial.rectificado) {
      try { timestampMs = combinarFechaYHoraCanarias(info.oficial.fecha, info.oficial.hora).getTime(); } catch (e) { /* se deja el original si algo falla */ }
    }
    return {
      id: f.id, fichajeId: f.id, fecha: f.fecha, hora: f.hora, tipo: f.tipo,
      advertencia: f.advertencia || '', tipoIncidencia: f.tipoIncidencia || f.tipo,
      estado: info.estado, oficial: info.oficial, timestampMs: timestampMs, cadena: cadena
    };
  });

  return { registros: registros, correccionesTodas: correccionesTodas };
}

async function obtenerRegistrosPorDni(db, dni, mes, anio) {
  const [fichajesSnap, incidenciasSnap, correccionesSnap] = await Promise.all([
    getDocs(collection(db, 'trabajadores', dni, 'fichajes')),
    getDocs(collection(db, 'trabajadores', dni, 'incidencias')),
    getDocs(collection(db, 'trabajadores', dni, 'correcciones'))
  ]);

  const construido = construirRegistrosConCadenas(fichajesSnap.docs, correccionesSnap.docs);

  const registros = construido.registros
    .filter(function (f) { return partesFechaValidas(f.fecha, mes, anio); })
    .sort(function (a, b) { return (a.fecha + a.hora).localeCompare(b.fecha + b.hora); });

  const incidencias = incidenciasSnap.docs
    .map(function (d) { return d.data(); })
    .filter(function (i) { return partesFechaValidas(i.fecha, mes, anio); })
    .map(function (i) { return { fecha: i.fecha, tipo: i.tipo, detalle: i.detalle, justificada: i.justificada }; });

  const correcciones = construido.correccionesTodas
    .filter(function (c) { return partesFechaValidas(c.fechaOriginal, mes, anio); })
    .map(function (c) {
      return {
        id: c.id, fichajeId: c.fichajeId, fechaSolicitud: c.fechaSolicitud, horaSolicitud: c.horaSolicitud,
        solicitante: c.solicitanteNombre, rolSolicitante: c.rolSolicitante,
        tipoRegistro: c.tipoRegistro, fechaOriginal: c.fechaOriginal, horaOriginal: c.horaOriginal,
        motivo: c.motivo, valorAnterior: c.valorAnterior || null, valorRectificado: c.valorRectificado || null
      };
    });

  return { registros: registros, incidencias: incidencias, correcciones: correcciones };
}

// "Mis registros" ahora es privado: hace falta haber iniciado sesión (con
// el email y el código de 6 dígitos) para ver el propio historial — ya no
// basta con escribir el DNI de otra persona para ver sus datos.
export async function obtenerMisRegistros(db, auth, mes, anio) {
  if (!auth.currentUser) return { ok: false, mensaje: 'Tu sesión ha caducado. Vuelve a iniciar sesión.' };
  const enlaceSnap = await getDoc(doc(db, 'uid_a_dni', auth.currentUser.uid));
  if (!enlaceSnap.exists()) return { ok: false, mensaje: 'Esta cuenta todavía no está vinculada a ningún trabajador.' };
  const trabajador = await buscarTrabajadorPorDni(db, enlaceSnap.data().dni);
  if (!trabajador) return { ok: false, mensaje: 'No se encontró tu ficha de trabajador.' };
  const datos = await obtenerRegistrosPorDni(db, trabajador.dni, mes, anio);

  // Ausencias (festivos, vacaciones, bajas médicas) del mismo mes — el mismo
  // dato que se ve en el informe descargable, para que coincidan siempre.
  const inicioMes = new Date(Number(anio), Number(mes) - 1, 1);
  const finMes = new Date(Number(anio), Number(mes), 0);
  datos.ausencias = await obtenerAusenciasPeriodo(db, trabajador.dni, inicioMes, finMes);

  // Si es teletrabajo/mixta con objetivo de horas semanales, se añade el
  // resumen de horas pendientes del mes consultado (con fecha de corte
  // "hoy" si es el mes en curso, o el último día de ese mes si es uno ya
  // pasado).
  let objetivoTeletrabajo = null;
  if (trabajador.perfilTrabajo === 'teletrabajo' || trabajador.perfilTrabajo === 'mixta') {
    const ahora = new Date();
    const esMesActual = (Number(mes) === ahora.getMonth() + 1) && (Number(anio) === ahora.getFullYear());
    const fechaCorte = esMesActual ? ahora : new Date(Number(anio), Number(mes), 0);
    const iso = fechaCorte.getFullYear() + '-' + String(fechaCorte.getMonth() + 1).padStart(2, '0') + '-' + String(fechaCorte.getDate()).padStart(2, '0');
    const resultado = await calcularHorasPendientesTeletrabajo(db, trabajador.dni, iso);
    if (resultado.ok && resultado.aplica) objetivoTeletrabajo = resultado;
  }

  return Object.assign({ ok: true, nombre: trabajador.nombre, objetivoTeletrabajo: objetivoTeletrabajo }, datos);
}

// =====================================================================
// CUENTA DEL TRABAJADOR: invitación, primer código, recuperar código
// =====================================================================
// Todo esto usa Firebase Authentication de verdad (email + el propio
// código de 6 dígitos como contraseña) — así el código queda cifrado por
// Firebase, nadie (ni el administrador) puede leerlo, y el trabajador
// puede recuperarlo él solo en cualquier momento.

// Vincula la cuenta ya autenticada (uid) con su ficha de trabajador (dni),
// y sincroniza su código de fichaje: borra la huella antigua (si la había)
// y crea la nueva. Se usa tanto al aceptar la invitación por primera vez
// como al recuperar un código olvidado.
async function sincronizarCuentaYCodigo(auth, db, dni, codigoNuevo, email) {
  if (!codigoValido(codigoNuevo)) return { ok: false, mensaje: 'El código debe tener exactamente 6 dígitos.' };
  const uid = auth.currentUser.uid;

  // Vincular uid <-> dni (solo la primera vez; si ya estaba vinculado a
  // este mismo uid, estos dos intentos fallan por permisos y se ignoran
  // a propósito — no es un error real, solo significa "ya estaba hecho").
  try { await updateDoc(doc(db, 'trabajadores_privado', dni), { uid: uid }); } catch (e) { /* ya estaba vinculado */ }
  try { await setDoc(doc(db, 'uid_a_dni', uid), { dni: dni }); } catch (e) { /* ya existía */ }

  await updatePassword(auth.currentUser, codigoNuevo);

  // Se guarda también el email (además del dni) en el propio documento del
  // código: así, para entrar en "Mis registros", el trabajador solo
  // necesita teclear su código — la app resuelve el email ella sola a
  // partir de la huella del código, sin tener que pedírselo. Solo se puede
  // llegar a leer este documento si ya se conoce el código en texto plano
  // (hace falta para calcular su huella), así que no es una exposición
  // nueva: es el mismo nivel de acceso que ya da conocer el código.
  const huellaNueva = await calcularHashCodigo(codigoNuevo);
  // Esta colección es "solo creación": si el trabajador elige el MISMO
  // código que ya tenía (misma huella = mismo documento), intentar volver
  // a guardarlo se interpreta como una modificación de un documento ya
  // existente, y las reglas de seguridad lo rechazan (permission-denied).
  // Por eso se comprueba antes si ya existe exactamente ese documento, y
  // solo se crea si de verdad es nuevo.
  const yaExistiaIgual = (await getDoc(doc(db, 'codigos_fichaje', huellaNueva))).exists();
  if (!yaExistiaIgual) {
    await setDoc(doc(db, 'codigos_fichaje', huellaNueva), { dni: dni, email: email || null });
  }
  try { await updateDoc(doc(db, 'trabajadores_privado', dni), { hashCodigoActual: huellaNueva }); } catch (e) { /* no crítico: solo es un apunte informativo */ }

  // Solo ahora, con el código nuevo ya funcionando, se buscan y se borran
  // TODOS los códigos antiguos de este mismo trabajador (puede haber más de
  // uno, por ejemplo si una recuperación anterior falló a mitad) — así
  // ningún código viejo se queda activo a la vez que el nuevo. Se busca
  // directamente en "codigos_fichaje" por el dni, en vez de fiarse de un
  // único apunte guardado en trabajadores_privado (ese apunte puede faltar
  // o estar desactualizado, y antes eso hacía que el código viejo nunca se
  // borrara).
  try {
    const antiguosSnap = await getDocs(query(collection(db, 'codigos_fichaje'), where('dni', '==', dni)));
    for (const d of antiguosSnap.docs) {
      if (d.id !== huellaNueva) {
        try { await deleteDoc(doc(db, 'codigos_fichaje', d.id)); } catch (e) { /* no pasa nada si ya no existía */ }
      }
    }
  } catch (e) { /* si la búsqueda falla, el código nuevo ya funciona igualmente */ }

  // DIAGNÓSTICO TEMPORAL: justo aquí, con el código recién guardado,
  // probamos a iniciar sesión con ese mismo código (lo mismo que hace
  // "Mis registros") para saber si el fallo ocurre en este mismo instante
  // o solo más tarde, en otra página/sesión.
  let diagnostico = '';
  try {
    await signInWithEmailAndPassword(auth, email, codigoNuevo);
    diagnostico = ' [autocomprobación: inicio de sesión OK justo después de guardar, uid=' + uid + ']';
  } catch (eDiag) {
    diagnostico = ' [autocomprobación: FALLÓ justo después de guardar — ' + (eDiag.code || eDiag.message) + ', uid=' + uid + ', email usado=' + email + ']';
  }

  return { ok: true, mensaje: diagnostico };
}

// El enlace del correo (invitación o "he olvidado mi código") apunta a
// "crear-codigo.html", una página aparte y mínima que SOLO sirve para
// elegir el código de 6 dígitos — nunca a index.html (la aplicación de
// fichar/Mis registros/Administración), que está pensada para la tablet
// de la oficina, no para el móvil del trabajador.
function enlaceInvitacion() {
  const url = new URL('./crear-codigo.html', window.location.href);
  url.search = ''; url.hash = '';
  return { url: url.toString(), handleCodeInApp: true };
}

// Enlace para "he olvidado mi código". Usa el MISMO mecanismo que la
// invitación (signInWithEmailLink), no el de "restablecer contraseña" de
// Firebase: ese segundo tipo de correo SIEMPRE abre primero una pantalla
// genérica de Firebase (fuera de nuestro control, en inglés salvo que el
// proyecto la tenga traducida, y que no sabe nada de nuestro código de 6
// dígitos) antes de redirigir — en la práctica, nunca llega a nuestra
// página con el código intacto. El enlace de "signIn" sí va siempre
// directo a nuestra página, así que reutilizamos ese mismo camino, que es
// exactamente igual de seguro (la comprobación real está en
// sincronizarCuentaYCodigo, idéntica para ambos casos).
function enlaceRecuperacion() {
  const url = new URL('./crear-codigo.html', window.location.href);
  url.search = '?origen=recuperacion'; url.hash = '';
  return { url: url.toString(), handleCodeInApp: true };
}

// La manda el ADMINISTRADOR, cuando él quiere — nunca en automático.
export async function enviarInvitacionTrabajador(auth, db, dni) {
  if (!auth.currentUser) return { ok: false, mensaje: 'Tu sesión ha caducado. Vuelve a identificarte.' };
  const privSnap = await getDoc(doc(db, 'trabajadores_privado', dni));
  if (!privSnap.exists() || !privSnap.data().email) return { ok: false, mensaje: 'Este trabajador no tiene un email guardado.' };
  const email = privSnap.data().email;
  auth.languageCode = 'es'; // El correo que envía Firebase debe salir en español
  await sendSignInLinkToEmail(auth, email, enlaceInvitacion());
  window.localStorage.setItem('jaslem_email_invitacion', email);
  return { ok: true, email: email };
}

// ¿La página se ha abierto desde un enlace de invitación o de recuperación?
export function esEnlaceDeAccesoTrabajador(auth) {
  return isSignInWithEmailLink(auth, window.location.href);
}

// Paso 1 de la invitación: el trabajador confirma su email (para completar
// el enlace) y su DNI/NIE (para saber a qué ficha pertenece).
export async function aceptarInvitacion(auth, db, email, dni, codigoNuevo) {
  let credencial;
  try {
    credencial = await signInWithEmailLink(auth, email, window.location.href);
  } catch (e) {
    return { ok: false, mensaje: 'El enlace no es válido o ha caducado. Pide al administrador que te mande uno nuevo.' };
  }
  const dniDigits = soloDigitos(dni);
  const resultado = await sincronizarCuentaYCodigo(auth, db, dniDigits, codigoNuevo, email);
  if (!resultado.ok) { await signOut(auth); return resultado; }
  await signOut(auth); // el kiosk no debe quedarse con nadie con la sesión abierta
  return { ok: true, mensajeDiagnostico: resultado.mensaje || '' };
}

// "He olvidado mi código" — lo pide el propio trabajador, sin que el
// administrador tenga que hacer nada. Usa el enlace de tipo "invitación"
// (ver enlaceRecuperacion arriba) para que vaya directo a crear-codigo.html.
export async function solicitarRecuperarCodigo(auth, email) {
  try {
    auth.languageCode = 'es'; // El correo que envía Firebase debe salir en español
    await sendSignInLinkToEmail(auth, email, enlaceRecuperacion());
    window.localStorage.setItem('jaslem_email_invitacion', email);
    return { ok: true };
  } catch (e) {
    // Diagnóstico temporal: se muestra el código real del error (p.ej.
    // "auth/missing-email", "auth/invalid-email", "auth/unauthorized-continue-uri")
    // en vez de ocultarlo, mientras se depura este fallo nuevo.
    return { ok: false, mensaje: 'No se pudo enviar el correo. Comprueba el email. [' + (e.code || e.message) + ']' };
  }
}

// Paso 2 de "he olvidado mi código": llega desde el enlace del correo, con
// un código de un solo uso (oobCode) en la dirección web.
export async function confirmarNuevoCodigo(auth, db, oobCode, email, dni, codigoNuevo) {
  if (!codigoValido(codigoNuevo)) return { ok: false, mensaje: 'El código debe tener exactamente 6 dígitos.' };
  try {
    await confirmPasswordReset(auth, oobCode, codigoNuevo);
  } catch (e) {
    return { ok: false, mensaje: 'El enlace no es válido o ha caducado. Pide uno nuevo desde "He olvidado mi código".' };
  }
  try {
    await signInWithEmailAndPassword(auth, email, codigoNuevo);
  } catch (e) {
    return { ok: false, mensaje: 'Tu código se ha cambiado, pero no se pudo terminar de guardar. Inténtalo otra vez.' };
  }
  const dniDigits = soloDigitos(dni);
  const resultado = await sincronizarCuentaYCodigo(auth, db, dniDigits, codigoNuevo, email);
  await signOut(auth);
  return resultado;
}

// Inicio de sesión del propio TRABAJADOR en "Mis registros" — con su email
// y el código de 6 dígitos que él eligió (nunca con su DNI). Se mantiene
// por si algo más la usa, pero la pantalla de "Mis registros" ya usa
// loginTrabajadorConCodigo (más abajo), que no pide el email.
export async function loginTrabajador(auth, email, codigo) {
  if (!codigoValido(codigo)) return { ok: false, mensaje: 'El código debe tener 6 dígitos.' };
  try {
    await signInWithEmailAndPassword(auth, String(email || '').trim(), codigo);
    return { ok: true };
  } catch (e) {
    return { ok: false, mensaje: 'Email o código incorrectos.' };
  }
}

// Inicio de sesión del trabajador SOLO con su código de 6 dígitos (sin
// pedirle el email): se busca su huella en "codigos_fichaje" (el mismo
// documento que ya usa "Fichar" para reconocer el código), se recupera el
// email que quedó guardado ahí al crear el código, y con eso se hace el
// inicio de sesión real de Firebase por debajo — de forma transparente
// para el trabajador. El email sigue existiendo por dentro (Firebase
// Authentication lo necesita), pero el trabajador nunca tiene que
// escribirlo para entrar en "Mis registros".
export async function loginTrabajadorConCodigo(db, auth, codigo) {
  if (!codigoValido(codigo)) return { ok: false, mensaje: 'El código debe tener 6 dígitos.' };
  const huella = await calcularHashCodigo(codigo);
  let snap;
  try {
    snap = await getDoc(doc(db, 'codigos_fichaje', huella));
  } catch (e) {
    // Diagnóstico temporal: se muestra el código real del error (p.ej.
    // "permission-denied") en vez de ocultarlo, mientras se depura el
    // fallo de "Mis registros" tras recuperar código.
    return { ok: false, mensaje: 'Código no reconocido. [lectura: ' + (e.code || e.message) + ']' };
  }
  if (!snap.exists()) return { ok: false, mensaje: 'Código no reconocido. [sin documento para esa huella]' };
  if (!snap.data().email) return { ok: false, mensaje: 'Código no reconocido. [documento sin email guardado]' };
  try {
    await signInWithEmailAndPassword(auth, snap.data().email, codigo);
    return { ok: true };
  } catch (e) {
    return { ok: false, mensaje: 'Código no reconocido. [acceso: ' + (e.code || e.message) + ' / email: ' + snap.data().email + ']' };
  }
}

export function logoutTrabajador(auth) {
  return signOut(auth);
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
// Registros que necesitan atención del administrador: fichajes con una
// incidencia automática sin resolver, Y/O fichajes sobre los que el
// trabajador ha pedido una corrección (esté o no marcado en rojo) que
// todavía no tiene una rectificación oficial del administrador.
export async function obtenerRegistrosPendientes(db) {
  const [incidenciasSnap, correccionesSnap] = await Promise.all([
    getDocs(collectionGroup(db, 'incidencias')),
    getDocs(collectionGroup(db, 'correcciones'))
  ]);

  // Agrupa todas las correcciones por (dni, fichajeId) para poder calcular
  // el estado actual de la cadena de cada fichaje.
  const cadenasPorClave = {};
  correccionesSnap.docs.forEach(function (d) {
    const c = d.data();
    if (!c.fichajeId || !c.afectadoId) return;
    const clave = c.afectadoId + '|' + c.fichajeId;
    (cadenasPorClave[clave] = cadenasPorClave[clave] || []).push(c);
  });
  Object.keys(cadenasPorClave).forEach(function (clave) {
    cadenasPorClave[clave].sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });
  });

  const dniCache = {};
  async function obtenerDniInfo(dni) {
    if (dniCache[dni]) return dniCache[dni];
    const tSnap = await getDoc(doc(db, 'trabajadores', dni));
    dniCache[dni] = tSnap.exists() ? mapearTrabajador(dni, tSnap.data()) : null;
    return dniCache[dni];
  }

  // Horario previsto (semanal) de cada trabajador, para poder mostrarle al
  // administrador qué tocaba ese día concreto al lado del fichaje real.
  const horarioCache = {};
  async function obtenerHorarioSemanal(dni) {
    if (horarioCache[dni] !== undefined) return horarioCache[dni];
    const hSnap = await getDoc(doc(db, 'horarios', dni));
    horarioCache[dni] = hSnap.exists() ? hSnap.data() : {};
    return horarioCache[dni];
  }
  function diaSemanaDeFechaStr_(fechaStr) {
    const p = String(fechaStr).split('/').map(Number);
    const d = new Date(p[2] || 1970, (p[1] || 1) - 1, p[0] || 1);
    return ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'][d.getDay()];
  }
  function tramosDelDia_(horarioSemanal, fechaStr) {
    const diaSemana = diaSemanaDeFechaStr_(fechaStr);
    const claveDia = Object.keys(horarioSemanal || {}).find(function (d) { return normalizarDia(d) === normalizarDia(diaSemana); });
    return obtenerTramosValidos(claveDia ? horarioSemanal[claveDia] : null);
  }
  function horarioTextoDelDia_(horarioSemanal, fechaStr) {
    const tramos = tramosDelDia_(horarioSemanal, fechaStr);
    if (tramos.length === 0) return 'Sin horario fijo asignado ese día';
    return tramos.map(function (t) { return t.entrada + '–' + t.salida; }).join(' y ');
  }

  const pendientes = [];
  const clavesYaAnadidas = {};

  // 1) Fichajes con una incidencia automática todavía sin resolver.
  for (const d of incidenciasSnap.docs) {
    const inc = d.data();
    if (inc.justificada === 'Sí' || inc.justificada === 'Resuelto') continue;
    const dni = inc.trabajadorId;
    await obtenerDniInfo(dni);
    const horarioSemanal = await obtenerHorarioSemanal(dni);

    const fichajeId = inc.fichajeId || null;
    const clave = fichajeId ? (dni + '|' + fichajeId) : null;
    const cadena = clave ? (cadenasPorClave[clave] || []) : [];
    const ultima = cadena[cadena.length - 1];
    if (ultima && ultima.valorRectificado) continue; // ya tiene un valor oficial rectificado

    pendientes.push({
      trabajadorId: dni, trabajadorNombre: inc.nombre, trabajadorDni: dni, fichajeId: fichajeId,
      fecha: inc.fecha, hora: inc.hora, tipo: inc.tipo, detalle: inc.detalle,
      horarioTexto: horarioTextoDelDia_(horarioSemanal, inc.fecha),
      horarioTramos: tramosDelDia_(horarioSemanal, inc.fecha),
      origen: 'Automática', motivoTrabajador: (ultima && !ultima.valorRectificado) ? ultima.motivo : ''
    });
    if (clave) clavesYaAnadidas[clave] = true;
  }

  // 2) Solicitudes de corrección del trabajador sobre CUALQUIER registro
  // (esté marcado en rojo o no) que todavía no tienen respuesta.
  for (const clave of Object.keys(cadenasPorClave)) {
    if (clavesYaAnadidas[clave]) continue;
    const cadena = cadenasPorClave[clave];
    const ultima = cadena[cadena.length - 1];
    if (!ultima || ultima.valorRectificado) continue; // ya resuelta
    if (ultima.rolSolicitante !== 'Trabajador') continue; // una nota propia del admin no es "pendiente"
    const horarioSemanal = await obtenerHorarioSemanal(ultima.afectadoId);
    pendientes.push({
      trabajadorId: ultima.afectadoId, trabajadorNombre: ultima.afectadoNombre, trabajadorDni: ultima.afectadoId,
      fichajeId: ultima.fichajeId, fecha: ultima.fechaOriginal, hora: ultima.horaOriginal, tipo: ultima.tipoRegistro,
      horarioTexto: horarioTextoDelDia_(horarioSemanal, ultima.fechaOriginal),
      horarioTramos: tramosDelDia_(horarioSemanal, ultima.fechaOriginal),
      detalle: 'Solicitud de corrección del trabajador', origen: 'Solicitud del trabajador', motivoTrabajador: ultima.motivo
    });
  }

  pendientes.sort(function (a, b) {
    const pa = String(a.fecha).split('/').map(Number), pb = String(b.fecha).split('/').map(Number);
    return new Date(pb[2] || 0, (pb[1] || 1) - 1, pb[0] || 1) - new Date(pa[2] || 0, (pa[1] || 1) - 1, pa[0] || 1);
  });

  return { ok: true, pendientes: pendientes };
}

// RESOLUCIÓN de un administrador sobre un fichaje concreto (identificado
// por su fichajeId estable): fija el motivo Y el valor rectificado
// (fecha+hora), que pasa a ser el oficial de ese fichaje a partir de ahora.
// Sirve tanto para responder a una solicitud del trabajador (confirmando su
// motivo o poniendo el que el administrador considere correcto) como para
// que el administrador corrija un registro por iniciativa propia, sin que
// nadie se lo haya pedido — es la misma operación en ambos casos, y se
// puede repetir tantas veces como haga falta sobre el mismo fichaje
// (rectificación de una rectificación, indefinidamente).
export async function resolverCorreccionAdmin(db, auth, dniTrabajador, fichajeId, motivo, fechaRectificada, horaRectificada) {
  if (!auth.currentUser) return { ok: false, mensaje: 'Tu sesión ha caducado. Vuelve a identificarte.' };
  if (MOTIVOS_CORRECCION.indexOf(motivo) === -1) return { ok: false, mensaje: 'Selecciona un motivo de la lista.' };
  if (!fechaRectificada || !horaRectificada) return { ok: false, mensaje: 'Indica la fecha y la hora correctas.' };
  if (!fichajeId) return { ok: false, mensaje: 'No se pudo identificar el registro a corregir.' };

  const trabajador = await buscarTrabajadorPorDni(db, dniTrabajador);
  if (!trabajador) return { ok: false, mensaje: 'No se encontró ese trabajador.' };

  const fichajeRef = doc(db, 'trabajadores', trabajador.dni, 'fichajes', fichajeId);
  const fichajeSnap = await getDoc(fichajeRef);
  if (!fichajeSnap.exists()) return { ok: false, mensaje: 'No se encontró ese registro.' };
  const fichaje = fichajeSnap.data();

  const cadena = await obtenerCadenaCorrecciones(db, trabajador.dni, fichajeId);
  const oficialAntes = valorOficialDeFichaje(fichaje, cadena);

  await registrarCorreccion(db, trabajador.dni, fichajeId, {
    solicitanteId: 'ADMIN', solicitanteNombre: auth.currentUser.email, rolSolicitante: 'Administrador',
    afectadoId: trabajador.dni, afectadoNombre: trabajador.nombre,
    tipoRegistro: fichaje.tipoIncidencia || fichaje.tipo, fechaOriginal: fichaje.fecha, horaOriginal: fichaje.hora,
    valorAnterior: { fecha: oficialAntes.fecha, hora: oficialAntes.hora },
    motivo: String(motivo).trim(),
    valorRectificado: { fecha: String(fechaRectificada).trim(), hora: String(horaRectificada).trim() }
  });

  // Si había una incidencia automática pendiente sobre este mismo fichaje,
  // se marca como resuelta (no crítico si falla: la corrección ya quedó
  // registrada de todas formas).
  try {
    const incSnap = await getDocs(query(collection(db, 'trabajadores', trabajador.dni, 'incidencias'), where('fichajeId', '==', fichajeId)));
    for (const d of incSnap.docs) {
      if (d.data().justificada === 'Pendiente') {
        await updateDoc(d.ref, { justificada: 'Resuelto', resueltoPor: auth.currentUser.uid, resueltoEl: formatearFecha(new Date()) });
      }
    }
  } catch (e) { /* no crítico */ }

  return { ok: true };
}

// Las AUSENCIAS son un caso especial dentro de "pendientes": no hay ningún
// fichaje que rectificar (el trabajador no fichó ese día), así que no
// tienen fichajeId. Aquí simplemente se registra el motivo alegado y se
// marca la ausencia como justificada.
export async function resolverAusenciaAdmin(db, auth, trabajadorId, fecha, motivo) {
  if (!auth.currentUser) return { ok: false, mensaje: 'Tu sesión ha caducado. Vuelve a identificarte.' };
  if (MOTIVOS_CORRECCION.indexOf(motivo) === -1) return { ok: false, mensaje: 'Selecciona un motivo de la lista.' };

  const trabajador = await buscarTrabajadorPorDni(db, trabajadorId);
  if (!trabajador) return { ok: false, mensaje: 'No se encontró ese trabajador.' };

  const incSnap = await getDocs(query(
    collection(db, 'trabajadores', trabajador.dni, 'incidencias'),
    where('fecha', '==', fecha), where('tipo', '==', 'Ausencia'), limit(1)
  ));
  if (incSnap.empty) return { ok: false, mensaje: 'No se encontró esa ausencia ese día.' };

  await registrarCorreccion(db, trabajador.dni, null, {
    solicitanteId: 'ADMIN', solicitanteNombre: auth.currentUser.email, rolSolicitante: 'Administrador',
    afectadoId: trabajador.dni, afectadoNombre: trabajador.nombre,
    tipoRegistro: 'Ausencia', fechaOriginal: fecha, horaOriginal: '—',
    valorAnterior: null, motivo: String(motivo).trim(), valorRectificado: null
  });
  await updateDoc(incSnap.docs[0].ref, { justificada: 'Sí', resueltoPor: auth.currentUser.uid, resueltoEl: formatearFecha(new Date()) });

  return { ok: true };
}

export async function obtenerRegistrosAdmin(db, dniObjetivo, mes, anio) {
  const objetivo = await buscarTrabajadorPorDni(db, dniObjetivo);
  if (!objetivo) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };
  const datos = await obtenerRegistrosPorDni(db, objetivo.dni, mes, anio);
  return Object.assign({ ok: true, nombre: objetivo.nombre }, datos);
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

  const perfilTrabajo = PERFILES_TRABAJO_VALIDOS.indexOf(datos.perfilTrabajo) !== -1 ? datos.perfilTrabajo : 'presencial';
  const horasSemanalesTeletrabajo = (perfilTrabajo === 'teletrabajo' || perfilTrabajo === 'mixta') ? (Number(datos.horasSemanalesTeletrabajo) || 0) : 0;

  await setDoc(ref, {
    apellidos: apellidos, nombre: nombre, categoria: String(datos.categoria || '').trim(), activo: true,
    perfilTrabajo: perfilTrabajo, horasSemanalesTeletrabajo: horasSemanalesTeletrabajo
  });
  await setDoc(doc(db, 'trabajadores_privado', dni), { nss: String(datos.nss || '').trim(), email: String(datos.email || '').trim() });

  const diasGuardados = await guardarHorarioSemanal(db, dni, perfilTrabajo, datos.horarioSemanal);

  return { ok: true, id: dni, nombre: apellidos + ', ' + nombre, diasHorario: diasGuardados };
}

// El administrador puede editar los datos básicos de un trabajador YA dado
// de alta (apellidos, nombre, categoría, NSS, email). El DNI/NIE NUNCA se
// puede cambiar desde aquí, porque es el identificador del documento en
// Firestore — si se escribió mal al darlo de alta, la única forma de
// corregirlo es dar de baja esa ficha y crear una nueva con el DNI correcto.
export async function actualizarDatosTrabajador(db, dni, datos) {
  const dniDigits = soloDigitos(dni);
  if (!dniDigits) return { ok: false, mensaje: 'DNI/NIE no válido.' };

  const ref = doc(db, 'trabajadores', dniDigits);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };

  const apellidos = String(datos.apellidos || '').trim();
  const nombre = String(datos.nombre || '').trim();
  if (!apellidos || !nombre) return { ok: false, mensaje: 'Indica los apellidos y el nombre.' };

  await updateDoc(ref, { apellidos: apellidos, nombre: nombre, categoria: String(datos.categoria || '').trim() });
  await setDoc(doc(db, 'trabajadores_privado', dniDigits), {
    nss: String(datos.nss || '').trim(), email: String(datos.email || '').trim()
  }, { merge: true });

  return { ok: true, nombre: apellidos + ', ' + nombre };
}

// Guarda (sustituyendo por completo) el horario semanal de un trabajador,
// con soporte de horario partido: cada día puede tener varias franjas
// horarias ("tramos"), no solo una entrada/salida. Si su modalidad es
// "mixta", cada día guarda también qué modalidad le corresponde ESE día
// (presencial/teletrabajo); si no, ese dato no hace falta guardarlo (ya lo
// dice el perfil general del trabajador). Un día de TELETRABAJO dentro de
// un "mixta" funciona exactamente como un trabajador 100% teletrabajo ESE
// día: se ficha libremente (entrada/salida), sin comparar con ningún
// horario — por eso no guarda tramos ni horas, solo la modalidad. Admite,
// por compatibilidad, que un día presencial llegue todavía en el formato
// antiguo (una única entrada/salida, con pausa opcional).
async function guardarHorarioSemanal(db, dni, perfilTrabajo, horarioSemanal) {
  const horarioLimpio = {};
  let diasGuardados = 0;
  if (horarioSemanal && typeof horarioSemanal === 'object') {
    Object.keys(horarioSemanal).forEach(function (dia) {
      const h = horarioSemanal[dia];
      if (!h) return;

      // Día de TELETRABAJO dentro de un perfil "mixta": libertad horaria
      // total ese día, igual que un 100% teletrabajo — no hace falta
      // definir tramos ni horas, solo marcar la modalidad.
      if (perfilTrabajo === 'mixta' && h.modalidad === 'teletrabajo') {
        horarioLimpio[dia] = { modalidad: 'teletrabajo' };
        diasGuardados++;
        return;
      }

      // Día presencial (o cualquier día de un perfil no-mixta): horario
      // partido de varias franjas, igual que hasta ahora.
      let tramos = [];
      if (Array.isArray(h.tramos)) {
        tramos = h.tramos.filter(function (t) { return t && t.entrada && t.salida; });
      } else if (h.entrada && h.salida) {
        tramos = (h.pausaInicio && h.pausaFin)
          ? [{ entrada: h.entrada, salida: h.pausaInicio }, { entrada: h.pausaFin, salida: h.salida }]
          : [{ entrada: h.entrada, salida: h.salida }];
      }
      if (tramos.length === 0) return;

      const fila = { tramos: tramos };
      if (perfilTrabajo === 'mixta') fila.modalidad = 'presencial';
      horarioLimpio[dia] = fila;
      diasGuardados++;
    });
  }
  // Siempre se reemplaza el documento entero (aunque quede vacío), para
  // que un día que se borre en el formulario de edición desaparezca
  // también de Firestore y no quede fichando "libre" de casualidad.
  await setDoc(doc(db, 'horarios', dni), horarioLimpio);
  return diasGuardados;
}

// =====================================================================
// TELETRABAJO: objetivo de horas SEMANALES y "horas pendientes"
// =====================================================================
// Aplica a los perfiles "teletrabajo" (100%) y a la parte de teletrabajo
// de un "mixta" (los días de su horario marcados como tal). En ambos
// casos el trabajador ficha libremente (entrada/salida, sin comparar con
// ningún horario) y sus horas REALES van descontando un objetivo de horas
// semanales fijado por el administrador. Sin Cloud Functions no hay nada
// que guarde un contador aparte: se recalcula cada vez, repasando semana a
// semana (lunes a domingo) desde el día 1 del mes hasta la fecha de
// referencia. El déficit o exceso de una semana se arrastra a la
// siguiente, pero SOLO dentro del mismo mes natural: cada mes empieza
// siempre con el objetivo completo, sin arrastre del mes anterior.
function lunesDeSemana(fecha) {
  const diaISO = (fecha.getDay() + 6) % 7; // 0 = lunes ... 6 = domingo
  return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() - diaISO);
}

// ¿Ese día concreto cuenta para el objetivo de teletrabajo de este
// trabajador? Para un 100% teletrabajo, cualquier día que le toque
// trabajar (todos). Para un "mixta", solo los días de su horario marcados
// como modalidad "teletrabajo".
function diaCuentaComoTeletrabajo(perfilTrabajo, horarioSemanal, fecha) {
  if (perfilTrabajo === 'teletrabajo') return true;
  if (perfilTrabajo !== 'mixta' || !horarioSemanal) return false;
  const diaSemana = obtenerDiaSemana(fecha);
  const claveDia = Object.keys(horarioSemanal).find(function (d) { return normalizarDia(d) === normalizarDia(diaSemana); });
  if (!claveDia) return false;
  const h = horarioSemanal[claveDia];
  return !!(h && h.modalidad === 'teletrabajo');
}

// Fechas (en formato DD/MM/YYYY) dentro de [inicio, fin] en las que este
// trabajador tiene un día justificado (festivo de todo el equipo,
// vacaciones o baja médica propias) según el calendario laboral.
async function obtenerFechasAusenciaEnRango(db, dni, inicio, fin) {
  const [festivosSnap, propiosSnap] = await Promise.all([
    getDocs(query(collection(db, 'calendario'), where('tipo', '==', 'Festivo'))),
    getDocs(query(collection(db, 'calendario'), where('trabajadorId', '==', dni)))
  ]);
  const fechas = new Set();
  festivosSnap.forEach(function (d) { fechas.add(d.data().fecha); });
  // Cualquier día propio registrado en el calendario (Vacaciones, Baja
  // médica, Paternidad, Maternidad, etc. — cualquier motivo justificado de
  // MOTIVOS_CORRECCION) cuenta como ausencia justificada de todo el día:
  // como estos documentos siempre tienen trabajadorId === dni (a
  // diferencia de "Festivo", que siempre lo tiene a null), no hace falta
  // comprobar el tipo concreto.
  propiosSnap.forEach(function (d) { fechas.add(d.data().fecha); });
  const resultado = [];
  fechas.forEach(function (fechaStr) { if (fechaEnRango(fechaStr, inicio, fin)) resultado.push(fechaStr); });
  return resultado;
}

// Calcula, semana a semana desde el día 1 del mes de "fechaReferenciaISO"
// (o de hoy, si no se indica) hasta esa fecha, el objetivo ajustado, las
// horas ya trabajadas en días de teletrabajo, y las horas pendientes al
// cierre de cada semana (puede ser negativo = se ha hecho de más).
export async function calcularHorasPendientesTeletrabajo(db, dni, fechaReferenciaISO) {
  const dniDigits = soloDigitos(dni);
  if (!dniDigits) return { ok: false, mensaje: 'DNI/NIE no válido.' };
  const trabajadorSnap = await getDoc(doc(db, 'trabajadores', dniDigits));
  if (!trabajadorSnap.exists()) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };
  const trabajador = mapearTrabajador(dniDigits, trabajadorSnap.data());

  if (trabajador.perfilTrabajo !== 'teletrabajo' && trabajador.perfilTrabajo !== 'mixta') {
    return { ok: true, aplica: false };
  }
  const horasSemanales = Number(trabajador.horasSemanalesTeletrabajo) || 0;
  if (horasSemanales <= 0) return { ok: true, aplica: false, nombre: trabajador.nombre };

  const horarioSnap = await getDoc(doc(db, 'horarios', dniDigits));
  const horarioSemanal = horarioSnap.exists() ? horarioSnap.data() : {};

  const hoy = fechaReferenciaISO ? parsearFechaISO(fechaReferenciaISO) : new Date();
  const hastaFecha = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const inicioMes = new Date(hastaFecha.getFullYear(), hastaFecha.getMonth(), 1);
  const finMes = new Date(hastaFecha.getFullYear(), hastaFecha.getMonth() + 1, 0);

  const ausencias = await obtenerFechasAusenciaEnRango(db, dniDigits, inicioMes, finMes);

  const fichajesSnap = await getDocs(query(
    collection(db, 'trabajadores', dniDigits, 'fichajes'),
    where('timestampMs', '>=', inicioMes.getTime()),
    where('timestampMs', '<=', hastaFecha.getTime() + 86399999),
    orderBy('timestampMs', 'asc')
  ));
  const fichajes = fichajesSnap.docs.map(function (d) { return d.data(); });

  const semanas = [];
  let arrastre = 0;
  let cursorLunes = lunesDeSemana(inicioMes);
  let guardas = 0;
  while (cursorLunes <= hastaFecha && guardas < 60) {
    guardas++;
    const finSemana = new Date(cursorLunes.getFullYear(), cursorLunes.getMonth(), cursorLunes.getDate() + 6);
    const diasSemanaEnMesHastaHoy = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursorLunes.getFullYear(), cursorLunes.getMonth(), cursorLunes.getDate() + i);
      if (d >= inicioMes && d <= finMes && d <= hastaFecha) diasSemanaEnMesHastaHoy.push(d);
    }
    if (diasSemanaEnMesHastaHoy.length === 0) {
      cursorLunes = new Date(cursorLunes.getFullYear(), cursorLunes.getMonth(), cursorLunes.getDate() + 7);
      continue;
    }

    const diasAusenciaSemana = diasSemanaEnMesHastaHoy.filter(function (d) {
      return d.getDay() !== 0 && d.getDay() !== 6 && ausencias.indexOf(formatearFecha(d)) !== -1;
    }).length;
    const objetivoAjustado = Math.max(0, horasSemanales - diasAusenciaSemana * (horasSemanales / 5)) + arrastre;

    let minutosTrabajados = 0;
    let entradaAbierta = null;
    fichajes.forEach(function (f) {
      const partes = String(f.fecha || '').split('/').map(Number);
      if (partes.length !== 3) return;
      const fechaFichaje = new Date(partes[2], partes[1] - 1, partes[0]);
      if (fechaFichaje < cursorLunes || fechaFichaje > finSemana || fechaFichaje > hastaFecha) return;
      if (!diaCuentaComoTeletrabajo(trabajador.perfilTrabajo, horarioSemanal, fechaFichaje)) return;
      if (f.tipo === 'Entrada') {
        entradaAbierta = f.timestampMs || null;
      } else if (f.tipo === 'Salida' && entradaAbierta) {
        if (f.timestampMs && f.timestampMs > entradaAbierta) minutosTrabajados += Math.round((f.timestampMs - entradaAbierta) / 60000);
        entradaAbierta = null;
      }
    });
    const horasTrabajadas = minutosTrabajados / 60;
    const pendiente = Math.round((objetivoAjustado - horasTrabajadas) * 100) / 100;

    semanas.push({
      inicio: formatearFecha(cursorLunes),
      fin: formatearFecha(finSemana <= finMes ? finSemana : finMes),
      objetivo: Math.round(objetivoAjustado * 100) / 100,
      horasTrabajadas: Math.round(horasTrabajadas * 100) / 100,
      pendiente: pendiente,
      esSemanaActual: hastaFecha >= cursorLunes && hastaFecha <= finSemana
    });

    arrastre = pendiente; // se arrastra a la semana siguiente, solo dentro del mismo mes
    cursorLunes = new Date(cursorLunes.getFullYear(), cursorLunes.getMonth(), cursorLunes.getDate() + 7);
  }

  const ultima = semanas.length > 0 ? semanas[semanas.length - 1] : null;
  return {
    ok: true, aplica: true, nombre: trabajador.nombre, horasSemanales: horasSemanales,
    semanas: semanas, pendienteActual: ultima ? ultima.pendiente : horasSemanales
  };
}

// Perfil (modalidad de trabajo) y horario actuales de un trabajador — para
// precargar el formulario de edición.
export async function obtenerPerfilYHorario(db, dni) {
  const dniDigits = soloDigitos(dni);
  const [tSnap, hSnap] = await Promise.all([
    getDoc(doc(db, 'trabajadores', dniDigits)),
    getDoc(doc(db, 'horarios', dniDigits))
  ]);
  if (!tSnap.exists()) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };
  const t = mapearTrabajador(dniDigits, tSnap.data());
  return {
    ok: true, perfilTrabajo: t.perfilTrabajo, nombre: t.nombre,
    horasSemanalesTeletrabajo: t.horasSemanalesTeletrabajo,
    horarioSemanal: hSnap.exists() ? hSnap.data() : {}
  };
}

// El administrador puede cambiar en cualquier momento la modalidad de
// trabajo de un trabajador (y su horario) — por ejemplo, si pasa de
// presencial a teletrabajo, o cambia qué días son cuáles en modalidad mixta.
// horasSemanalesTeletrabajo solo se guarda (y solo tiene sentido) para los
// perfiles "teletrabajo" y "mixta" — es el objetivo de horas semanales que
// se van descontando según el trabajador ficha libremente.
export async function actualizarPerfilYHorario(db, dni, perfilTrabajo, horarioSemanal, horasSemanalesTeletrabajo) {
  const dniDigits = soloDigitos(dni);
  if (!dniDigits) return { ok: false, mensaje: 'DNI/NIE no válido.' };
  if (PERFILES_TRABAJO_VALIDOS.indexOf(perfilTrabajo) === -1) return { ok: false, mensaje: 'Modalidad de trabajo no válida.' };

  const ref = doc(db, 'trabajadores', dniDigits);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };

  const horasSemanales = (perfilTrabajo === 'teletrabajo' || perfilTrabajo === 'mixta') ? (Number(horasSemanalesTeletrabajo) || 0) : 0;
  await updateDoc(ref, { perfilTrabajo: perfilTrabajo, horasSemanalesTeletrabajo: horasSemanales });
  const diasGuardados = await guardarHorarioSemanal(db, dniDigits, perfilTrabajo, horarioSemanal);

  return { ok: true, nombre: mapearTrabajador(dniDigits, snap.data()).nombre, diasHorario: diasGuardados };
}

export async function cambiarEstadoActivo(db, dni, activo) {
  const dniDigits = soloDigitos(dni);
  if (!dniDigits) return { ok: false, mensaje: 'DNI/NIE no válido.' };
  const ref = doc(db, 'trabajadores', dniDigits);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, mensaje: 'No se encontró ningún trabajador con ese DNI/NIE.' };

  await updateDoc(ref, { activo: !!activo });

  // Al dar de baja: se elimina su código de fichaje (deja de poder fichar
  // y de poder entrar a "Mis registros" al instante). Sus fichajes,
  // incidencias y correcciones NO se tocan — se conservan, como exige la
  // ley (mínimo 4 años).
  if (!activo) {
    try {
      const privSnap = await getDoc(doc(db, 'trabajadores_privado', dniDigits));
      const hashActual = privSnap.exists() ? privSnap.data().hashCodigoActual : null;
      if (hashActual) await deleteDoc(doc(db, 'codigos_fichaje', hashActual));
    } catch (e) { /* si no tenía código todavía, no hay nada que borrar */ }
  }

  return { ok: true, nombre: mapearTrabajador(dniDigits, snap.data()).nombre, activo: !!activo };
}

// Trabajadores dados de baja: la "Gestión de trabajadores" los oculta por
// defecto (siguen existiendo en Firestore, solo dejan de aparecer en el
// día a día). Esta función es la que alimenta esa vista de archivo, para
// cuando de verdad haga falta consultarlos (p. ej. una inspección).
export async function obtenerListaTrabajadoresBaja(db) {
  const snap = await getDocs(collection(db, 'trabajadores'));
  const lista = snap.docs.map(function (d) { return mapearTrabajador(d.id, d.data()); }).filter(function (t) { return !t.activo; });
  lista.sort(function (a, b) { return String(a.apellidos).localeCompare(String(b.apellidos), 'es'); });
  return { ok: true, trabajadores: lista };
}

// =====================================================================
// CALENDARIO LABORAL
// =====================================================================
function parsearFechaISO(iso) {
  const partes = String(iso).split('-').map(Number);
  return new Date(partes[0], partes[1] - 1, partes[2]);
}

// dnisTrabajadores: para cualquier tipo propio (Vacaciones, BajaMedica,
// Paternidad, etc.), una lista de DNI/NIE (uno o varios trabajadores a la
// vez — por ejemplo, todo un equipo que coincide de vacaciones). Para
// "Festivo" se ignora: siempre afecta a todo el equipo (trabajadorId
// null), como hasta ahora — así se usa igual para
// un cierre por puente que para un festivo oficial, marcando el rango de
// fechas que haga falta.
// Tipos válidos para un periodo PROPIO de un trabajador (no "Festivo", que
// es aparte y siempre afecta a todo el equipo): cualquier motivo
// justificado de la lista cerrada, salvo "Falta de asistencia no
// justificada" (eso no es algo que se planifique de antemano en el
// calendario, se gestiona fichaje a fichaje desde "Pendientes").
const TIPOS_CALENDARIO_PROPIO = MOTIVOS_CORRECCION.filter(function (m) { return m !== MOTIVO_NO_JUSTIFICADO; });

export async function anadirPeriodoCalendario(db, fechaInicioISO, fechaFinISO, tipo, dnisTrabajadores, nota) {
  if (!fechaInicioISO || !tipo) return { ok: false, mensaje: 'Indica al menos la fecha de inicio y el tipo de día.' };
  if (tipo !== 'Festivo' && TIPOS_CALENDARIO_PROPIO.indexOf(tipo) === -1) return { ok: false, mensaje: 'Tipo de día no válido.' };

  let trabajadores = [{ dni: null, nombre: 'Todo el equipo' }];
  if (tipo !== 'Festivo') {
    const dnisLimpios = (Array.isArray(dnisTrabajadores) ? dnisTrabajadores : [dnisTrabajadores])
      .map(function (d) { return soloDigitos(d); }).filter(Boolean);
    if (dnisLimpios.length === 0) return { ok: false, mensaje: 'Indica al menos un trabajador.' };

    trabajadores = [];
    for (const dniLimpio of dnisLimpios) {
      const t = await buscarTrabajadorPorDni(db, dniLimpio);
      if (!t) return { ok: false, mensaje: 'No se encontró ningún trabajador con el DNI/NIE ' + dniLimpio + '.' };
      trabajadores.push({ dni: t.dni, nombre: t.nombre });
    }
  }

  let inicio = parsearFechaISO(fechaInicioISO);
  let fin = fechaFinISO ? parsearFechaISO(fechaFinISO) : inicio;
  if (fin < inicio) { const tmp = inicio; inicio = fin; fin = tmp; }

  const diasTotales = Math.round((fin - inicio) / 86400000) + 1;
  if (diasTotales > 366) return { ok: false, mensaje: 'El periodo es demasiado largo (máximo 366 días).' };
  if (diasTotales * trabajadores.length > 3000) return { ok: false, mensaje: 'Demasiados días × trabajadores de una vez. Hazlo en varios pasos más pequeños.' };

  const notaLimpia = nota ? String(nota).trim() : '';
  const registradoEl = formatearFecha(new Date());
  let contador = 0;
  for (const trabajador of trabajadores) {
    const cursor = new Date(inicio);
    while (cursor <= fin) {
      await addDoc(collection(db, 'calendario'), {
        fecha: formatearFecha(cursor), tipo: tipo, trabajadorId: trabajador.dni,
        nota: notaLimpia, fechaRegistro: registradoEl
      });
      cursor.setDate(cursor.getDate() + 1);
      contador++;
    }
  }

  const nombresTrabajadores = trabajadores.map(function (t) { return t.nombre; }).join(', ');
  return {
    ok: true, diasAnadidos: contador, fechaInicio: formatearFecha(inicio), fechaFin: formatearFecha(fin),
    trabajadorNombre: nombresTrabajadores, numTrabajadores: trabajadores.length
  };
}

function parsearFechaDDMMAAAA_(fechaStr) {
  const p = String(fechaStr || '').split('/').map(Number);
  return new Date(p[2] || 0, (p[1] || 1) - 1, p[0] || 1).getTime();
}

// Agrupa días sueltos de "calendario" (uno por fecha, por trabajador) en
// RANGOS legibles: fechas consecutivas con la misma clave (tipo +
// trabajador + nota) se muestran como un solo periodo "del ... al ...",
// en vez de una fila por cada día suelto. Los rangos más recientes van
// primero.
function agruparDiasCalendarioEnRangos(dias, claveDe) {
  // Se agrupa PRIMERO por clave (nota, o trabajador+tipo+nota) y solo
  // DESPUÉS se buscan días consecutivos dentro de cada grupo. Si se
  // ordenara por fecha para todos los días a la vez, dos trabajadores con
  // el mismo día (u días próximos) podrían intercalarse y romper la unión
  // de días consecutivos de un mismo grupo.
  const porClave = new Map();
  dias.forEach(function (d) {
    const clave = claveDe(d);
    if (!porClave.has(clave)) porClave.set(clave, []);
    porClave.get(clave).push(d);
  });
  const rangos = [];
  porClave.forEach(function (lista, clave) {
    const ordenados = lista.slice().sort(function (a, b) { return parsearFechaDDMMAAAA_(a.fecha) - parsearFechaDDMMAAAA_(b.fecha); });
    ordenados.forEach(function (d) {
      const ms = parsearFechaDDMMAAAA_(d.fecha);
      const ultimo = rangos.length ? rangos[rangos.length - 1] : null;
      if (ultimo && ultimo._clave === clave && ms - ultimo._finMs === 86400000) {
        ultimo.fin = d.fecha; ultimo._finMs = ms; ultimo.dias++;
      } else {
        rangos.push({ inicio: d.fecha, fin: d.fecha, _finMs: ms, _clave: clave, dias: 1, nota: d.nota || '', trabajadorId: d.trabajadorId || null, tipo: d.tipo });
      }
    });
  });
  rangos.sort(function (a, b) { return b._finMs - a._finMs; });
  return rangos.map(function (r) { return { inicio: r.inicio, fin: r.fin, dias: r.dias, nota: r.nota, trabajadorId: r.trabajadorId, tipo: r.tipo }; });
}

// Listado de festivos/cierres ya registrados (afectan a todo el equipo),
// agrupados en rangos, más recientes primero — para que el administrador
// vea de un vistazo lo que ya hay guardado, no solo pueda añadir más.
export async function obtenerCalendarioFestivos(db) {
  const snap = await getDocs(query(collection(db, 'calendario'), where('tipo', '==', 'Festivo')));
  const dias = snap.docs.map(function (d) { return d.data(); });
  const rangos = agruparDiasCalendarioEnRangos(dias, function (d) { return d.nota || ''; });
  return { ok: true, rangos: rangos };
}

// Igual que la anterior, pero para los periodos PROPIOS de cada
// trabajador (vacaciones, bajas médicas, paternidad, maternidad, etc. —
// cualquier motivo salvo "Festivo", que es aparte): agrupa por trabajador
// además de por fecha/tipo/nota, y añade el nombre de cada trabajador (a
// partir de la lista de trabajadores, ya que "calendario" solo guarda el
// DNI). Se piden TODOS los documentos con trabajadorId != null en vez de
// filtrar por una lista fija de tipos, para que cualquier motivo nuevo que
// se añada a MOTIVOS_CORRECCION aparezca aquí sin tener que tocar esta
// función.
export async function obtenerCalendarioVacacionesBajas(db) {
  const snap = await getDocs(query(collection(db, 'calendario'), where('trabajadorId', '!=', null)));
  const dias = snap.docs.map(function (d) { return d.data(); });
  const rangos = agruparDiasCalendarioEnRangos(dias, function (d) { return d.tipo + '|' + d.trabajadorId + '|' + (d.nota || ''); });

  const dnis = Array.from(new Set(rangos.map(function (r) { return r.trabajadorId; }).filter(Boolean)));
  const nombresPorDni = {};
  for (const dni of dnis) {
    const t = await buscarTrabajadorPorDni(db, dni);
    nombresPorDni[dni] = t ? t.nombre : ('DNI ' + dni);
  }
  rangos.forEach(function (r) { r.trabajadorNombre = r.trabajadorId ? (nombresPorDni[r.trabajadorId] || ('DNI ' + r.trabajadorId)) : ''; });

  return { ok: true, rangos: rangos };
}

// =====================================================================
// INFORMES: cálculo de periodos (idéntico al que tenían las Cloud Functions)
// =====================================================================
// "historico_completo" es un caso especial: no tiene fechas de inicio/fin
// fijas (calcularPeriodo no lo entiende), se resuelve aparte en
// informes-cliente.js con obtenerDatosHistoricoCompleto. Es el que se debe
// ofrecer obligatoriamente antes de dar de baja a un trabajador.
export const TIPOS_PERIODO_VALIDOS = ['diario', 'semanal', 'mensual', 'trimestral', 'semestral', 'anual', 'historico_completo'];

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
  let totalMin = 0;
  let entradaAbierta = null;
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

function minutosATexto_(totalMin) {
  const horas = Math.floor(totalMin / 60), min = totalMin % 60;
  return horas + 'h ' + String(min).padStart(2, '0') + 'min';
}

function diaSemanaDeDate_(d) {
  return ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'][d.getDay()];
}

function minutosDeTramos_(tramos) {
  return (tramos || []).reduce(function (total, t) {
    const e = String(t.entrada || '').split(':').map(Number);
    const s = String(t.salida || '').split(':').map(Number);
    return total + Math.max(0, ((s[0] || 0) * 60 + (s[1] || 0)) - ((e[0] || 0) * 60 + (e[1] || 0)));
  }, 0);
}

// ---------- HORAS DEBIDAS vs HORAS TRABAJADAS (para los informes) ----------
// "Horas debidas en el periodo": la suma de las horas de su horario semanal
// para cada día del periodo que sea laborable para él (tiene tramos
// asignados ese día de la semana) y no sea un festivo/cierre de todo el
// equipo. Es el objetivo — no depende de lo que hiciera ese día.
//
// "Horas trabajadas en el periodo": las horas realmente fichadas
// (entrada/salida, ya con cualquier corrección aplicada) MÁS las horas
// previstas de cada día en el que no fichó nada pero el motivo es un
// permiso retribuido (vacaciones, baja médica, o cualquier motivo de
// MOTIVOS_CORRECCION salvo "Falta de asistencia no justificada") — política
// de la organización: eso cuenta como trabajado, así que iguala a las horas
// debidas de ese día. Una falta no justificada, en cambio, no suma nada
// ahí, así que se ve como un déficit frente a las horas debidas.
export async function calcularHorasDebidasYTrabajadas(db, dni, inicio, fin, datosPeriodo) {
  const horarioSnap = await getDoc(doc(db, 'horarios', dni));
  const horarioSemanal = horarioSnap.exists() ? horarioSnap.data() : {};

  const [festivosSnap, propiosSnap] = await Promise.all([
    getDocs(query(collection(db, 'calendario'), where('tipo', '==', 'Festivo'))),
    getDocs(query(collection(db, 'calendario'), where('trabajadorId', '==', dni)))
  ]);
  const festivosPorDia = {};
  festivosSnap.forEach(function (d) {
    const c = d.data();
    if (fechaEnRango(c.fecha, inicio, fin)) festivosPorDia[c.fecha] = true;
  });
  const ausenciaPropiaPorDia = {};
  propiosSnap.forEach(function (d) {
    const c = d.data();
    if (fechaEnRango(c.fecha, inicio, fin)) ausenciaPropiaPorDia[c.fecha] = c.tipo;
  });

  // Ausencias de un día concreto (sin fichaje ese día) ya resueltas por el
  // administrador con un motivo — misma política que arriba.
  const motivoAusenciaPuntualPorDia = {};
  (datosPeriodo.correcciones || []).forEach(function (c) {
    if (c.tipoRegistro === 'Ausencia' && c.fechaOriginal) motivoAusenciaPuntualPorDia[c.fechaOriginal] = c.motivo;
  });

  // 1) Horas realmente fichadas (timestampMs ya refleja el valor oficial).
  let trabajadasMin = 0;
  let entradaAbierta = null;
  (datosPeriodo.registros || []).forEach(function (r) {
    if (r.tipo === 'Entrada') {
      entradaAbierta = r.timestampMs || null;
    } else if (r.tipo === 'Salida' && entradaAbierta) {
      if (r.timestampMs && r.timestampMs > entradaAbierta) trabajadasMin += Math.round((r.timestampMs - entradaAbierta) / 60000);
      entradaAbierta = null;
    }
  });

  // 2) Recorre cada día del periodo para las horas debidas y los permisos/faltas de día completo.
  let debidasMin = 0;
  const diasConFaltaNoJustificada = [];
  // Se avanza día a día con setDate (nunca sumando milisegundos fijos), para
  // que un periodo que incluya el cambio de hora de invierno/verano en
  // Canarias no salte ni repita ningún día.
  const finSinHora = new Date(fin.getFullYear(), fin.getMonth(), fin.getDate());
  for (let d = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate()); d.getTime() <= finSinHora.getTime(); d.setDate(d.getDate() + 1)) {
    const fechaStr = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    if (festivosPorDia[fechaStr]) continue; // festivo de todo el equipo: no cuenta ni como debido

    const diaSemana = diaSemanaDeDate_(d);
    const claveDia = Object.keys(horarioSemanal || {}).find(function (k) { return normalizarDia(k) === normalizarDia(diaSemana); });
    const tramos = obtenerTramosValidos(claveDia ? horarioSemanal[claveDia] : null);
    if (tramos.length === 0) continue; // no es día laborable para este trabajador

    const minutosDia = minutosDeTramos_(tramos);
    debidasMin += minutosDia;

    const tipoAusenciaPropia = ausenciaPropiaPorDia[fechaStr];
    const motivoAusenciaPuntual = motivoAusenciaPuntualPorDia[fechaStr];

    if (tipoAusenciaPropia) {
      trabajadasMin += minutosDia; // vacaciones/baja/permiso planificado: cuenta como trabajado
    } else if (motivoAusenciaPuntual && motivoAusenciaPuntual !== MOTIVO_NO_JUSTIFICADO) {
      trabajadasMin += minutosDia; // ausencia puntual con motivo justificado: cuenta como trabajado
    } else if (motivoAusenciaPuntual === MOTIVO_NO_JUSTIFICADO) {
      diasConFaltaNoJustificada.push(fechaStr); // falta no justificada: no suma nada, queda el déficit
    }
  }

  return {
    debidasMin: debidasMin, trabajadasMin: trabajadasMin,
    debidasTexto: minutosATexto_(debidasMin), trabajadasTexto: minutosATexto_(trabajadasMin),
    diasConFaltaNoJustificada: diasConFaltaNoJustificada
  };
}

// El estado de un registro ahora viene ya calculado (campo "estado") desde
// construirRegistrosConCadenas — esta función se deja como envoltorio fino
// por compatibilidad con quien todavía la llame, traduciendo el nuevo
// estado a los mismos colores/etiquetas de siempre. corrAdmin/corrTrabajador
// aquí son la última entrada de la cadena de ese fichajeId (no una búsqueda
// por fecha/hora/tipo, que ya no es fiable con horario partido).
export function estadoDeRegistro(r, correcciones) {
  const cadena = (correcciones || []).filter(function (c) { return c.fichajeId === r.fichajeId || c.fichajeId === r.id; })
    .sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });
  const corrAdmin = cadena.slice().reverse().find(function (c) { return c.rolSolicitante === 'Administrador'; }) || null;
  const corrTrabajador = cadena.slice().reverse().find(function (c) { return c.rolSolicitante === 'Trabajador'; }) || null;
  const estado = r.estado || (r.advertencia ? 'pendiente' : 'correcto');
  if (estado === 'corregido') return { color: '#B9770E', etiqueta: 'Corregido', corrAdmin: corrAdmin, corrTrabajador: corrTrabajador };
  if (estado === 'solicitada') return { color: '#6B3FA0', etiqueta: 'Solicitada', corrAdmin: null, corrTrabajador: corrTrabajador };
  if (estado === 'pendiente') return { color: '#C0392B', etiqueta: 'Pendiente', corrAdmin: null, corrTrabajador: null };
  return { color: '#1F6F63', etiqueta: 'Correcto', corrAdmin: null, corrTrabajador: null };
}

// Datos de un trabajador para un rango de fechas (no solo un mes) — se
// reutiliza la misma lógica que obtenerRegistrosPorDni pero sin el filtro
// de mes/año exacto. El timestampMs de cada registro ya refleja el valor
// OFICIAL (rectificado o no), para que calcularHorasTrabajadas cuente
// siempre las horas correctas en los informes.
// Ausencias (festivos de todo el equipo, y vacaciones/bajas médicas propias)
// de UN trabajador dentro de un rango de fechas, agrupadas en rangos legibles
// — para mostrarlas junto al fichaje, tanto en "Mis registros" como en los
// informes descargables (siempre el mismo dato, en los dos sitios).
async function obtenerAusenciasPeriodo(db, dni, inicio, fin) {
  const [festivosSnap, propiosSnap] = await Promise.all([
    getDocs(query(collection(db, 'calendario'), where('tipo', '==', 'Festivo'))),
    getDocs(query(collection(db, 'calendario'), where('trabajadorId', '==', dni)))
  ]);
  const dias = [];
  festivosSnap.forEach(function (d) {
    const c = d.data();
    if (fechaEnRango(c.fecha, inicio, fin)) dias.push(c);
  });
  propiosSnap.forEach(function (d) {
    // Cualquier motivo justificado de MOTIVOS_CORRECCION es válido aquí
    // (no solo Vacaciones/BajaMedica): ver la nota en
    // obtenerFechasAusenciaEnRango.
    const c = d.data();
    if (fechaEnRango(c.fecha, inicio, fin)) dias.push(c);
  });
  return agruparDiasCalendarioEnRangos(dias, function (d) { return d.tipo + '|' + (d.nota || ''); });
}

export async function obtenerDatosPeriodo(db, dni, inicio, fin) {
  const [fichajesSnap, incidenciasSnap, correccionesSnap, ausencias] = await Promise.all([
    getDocs(collection(db, 'trabajadores', dni, 'fichajes')),
    getDocs(collection(db, 'trabajadores', dni, 'incidencias')),
    getDocs(collection(db, 'trabajadores', dni, 'correcciones')),
    obtenerAusenciasPeriodo(db, dni, inicio, fin)
  ]);

  const construido = construirRegistrosConCadenas(fichajesSnap.docs, correccionesSnap.docs);
  const registros = construido.registros
    .filter(function (f) { return fechaEnRango(f.fecha, inicio, fin); })
    .sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });

  const incidencias = incidenciasSnap.docs.map(function (d) { return d.data(); }).filter(function (i) { return fechaEnRango(i.fecha, inicio, fin); });
  const correcciones = construido.correccionesTodas.filter(function (c) { return fechaEnRango(c.fechaOriginal, inicio, fin); });

  return { registros: registros, incidencias: incidencias, correcciones: correcciones, ausencias: ausencias };
}

// Todo el historial de un trabajador, sin límite de fechas — lo necesita el
// informe "histórico completo" que se debe poder descargar obligatoriamente
// antes de dar de baja a alguien (la ley exige poder entregarle TODO su
// registro, desde el primer día que fichó, no solo un periodo concreto).
export async function obtenerDatosHistoricoCompleto(db, dni) {
  const [fichajesSnap, incidenciasSnap, correccionesSnap, ausencias] = await Promise.all([
    getDocs(collection(db, 'trabajadores', dni, 'fichajes')),
    getDocs(collection(db, 'trabajadores', dni, 'incidencias')),
    getDocs(collection(db, 'trabajadores', dni, 'correcciones')),
    obtenerAusenciasPeriodo(db, dni, new Date(1970, 0, 1), new Date(2100, 0, 1))
  ]);

  const construido = construirRegistrosConCadenas(fichajesSnap.docs, correccionesSnap.docs);
  const registros = construido.registros.sort(function (a, b) { return (a.timestampMs || 0) - (b.timestampMs || 0); });

  const incidencias = incidenciasSnap.docs.map(function (d) { return d.data(); });
  const correcciones = construido.correccionesTodas;

  const etiqueta = registros.length > 0
    ? 'Histórico completo (del ' + registros[0].fecha + ' al ' + registros[registros.length - 1].fecha + ')'
    : 'Histórico completo (sin fichajes registrados)';

  return { registros: registros, incidencias: incidencias, correcciones: correcciones, etiqueta: etiqueta, ausencias: ausencias };
}

// ---------- AUDITORÍA DE DESCARGAS CERTIFICADAS ----------
// Cada vez que se genera un informe (PDF/Excel) queda un rastro
// independiente e inalterable de quién lo pidió, cuándo, y la huella
// (SHA-256) exacta de los datos que llevaba en ese momento — así se puede
// comprobar más adelante si un documento descargado ha sido manipulado.
// Si este registro falla por lo que sea, la descarga no se bloquea por eso.
export async function registrarDescargaCertificada(db, auth, datos) {
  if (!auth || !auth.currentUser) return { ok: false };
  try {
    const ahora = new Date();
    await addDoc(collection(db, 'descargas_certificadas'), Object.assign({
      generadoPorUid: auth.currentUser.uid,
      generadoPorEmail: auth.currentUser.email || '',
      generadoElMs: ahora.getTime(),
      generadoEl: formatearFecha(ahora) + ' ' + formatearHoraCompleta(ahora)
    }, datos));
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
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
    if (tieneLibertadHorariaHoy(t.perfilTrabajo, horarioHoy)) continue; // libertad horaria: no se puede hablar de "ausencia" por no haber fichado a una hora concreta
    const tramosHoy = obtenerTramosValidos(horarioHoy);
    if (tramosHoy.length === 0) continue; // sin ninguna franja horaria no hay nada que comprobar

    // ¿Ya pasó la hora de entrada de su PRIMERA franja del día (con margen)?
    const [hE, mE] = String(tramosHoy[0].entrada).split(':').map(Number);
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
