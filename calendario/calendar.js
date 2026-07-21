// calendario/calendar.js — operaciones sobre el calendario familiar compartido.
// Todo pasa por acá; el resto del módulo no habla con googleapis directamente.

import { obtenerCalendar } from "./google-auth.js";
import { config } from "./config.js";
import { rangoDia, rangoDias, aISO, sumarDias, hoyYmd } from "./fechas.js";

const CAL = () => config.google.calendarId;

/** Lista eventos ordenados por hora, expandiendo los recurrentes. */
export async function listar({ timeMin, timeMax, q, max = 50 }) {
  const { data } = await obtenerCalendar().events.list({
    calendarId: CAL(),
    timeMin,
    timeMax,
    q,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: max,
    timeZone: config.tz,
  });
  return data.items || [];
}

export async function eventosDelDia(ymd) {
  return listar(rangoDia(ymd));
}

export async function eventosDeRango(ymdInicio, dias = 7) {
  return listar(rangoDias(ymdInicio, dias));
}

/**
 * Crea un evento.
 *   titulo, fecha ("YYYY-MM-DD")            obligatorios
 *   hora ("HH:MM")     si falta → evento de día completo
 *   duracionMin        default 60
 *   fechaFin           para eventos de varios días
 *   lugar, notas, creadoPor
 */
export async function crear(e) {
  let start;
  let end;

  if (e.hora) {
    const dur = Number(e.duracionMin) > 0 ? Number(e.duracionMin) : 60;
    const inicio = new Date(aISO(e.fecha, e.hora));
    const fin = new Date(inicio.getTime() + dur * 60000);
    start = { dateTime: inicio.toISOString(), timeZone: config.tz };
    end = { dateTime: fin.toISOString(), timeZone: config.tz };
  } else {
    // En Google, el end.date de un evento de día completo es EXCLUSIVO.
    start = { date: e.fecha };
    end = { date: sumarDias(e.fechaFin || e.fecha, 1) };
  }

  const descripcion = [e.notas, e.creadoPor ? `Agendado por ${e.creadoPor} vía WhatsApp` : null]
    .filter(Boolean)
    .join("\n\n");

  const { data } = await obtenerCalendar().events.insert({
    calendarId: CAL(),
    requestBody: {
      summary: e.titulo,
      location: e.lugar || undefined,
      description: descripcion || undefined,
      start,
      end,
    },
  });
  return data;
}

export async function borrar(eventId) {
  await obtenerCalendar().events.delete({ calendarId: CAL(), eventId });
}

/** Busca por texto en una ventana amplia (7 días atrás, 90 adelante). */
export async function buscar(texto, { desdeDias = -7, hastaDias = 90 } = {}) {
  const hoy = hoyYmd();
  return listar({
    timeMin: aISO(sumarDias(hoy, desdeDias), "00:00"),
    timeMax: aISO(sumarDias(hoy, hastaDias), "00:00"),
    q: texto,
    max: 25,
  });
}
