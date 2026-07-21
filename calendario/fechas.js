// calendario/fechas.js — utilidades de fecha con timezone, sin dependencias.
//
// Todo lo que sale hacia Google Calendar va como ISO con offset explícito
// (ej. 2026-07-21T18:00:00-03:00) para que no haya ambigüedad de zona.

import { config } from "./config.js";

const TZ = config.tz;

export const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
export const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Descompone un Date en sus partes tal como se ven en la timezone dada. */
export function partes(fecha = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(fecha)) p[type] = value;
  const hora = p.hour === "24" ? "00" : p.hour;
  return {
    anio: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(hora),
    minuto: Number(p.minute),
    ymd: `${p.year}-${p.month}-${p.day}`,
    diaSemana: new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay(),
  };
}

/** Offset de la timezone en ese instante, como "-03:00". */
export function offset(fecha = new Date(), tz = TZ) {
  const nombre = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(fecha)
    .find((p) => p.type === "timeZoneName").value; // "GMT-03:00"
  const m = nombre.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "+00:00";
}

/** "2026-07-21" + "18:00" -> "2026-07-21T18:00:00-03:00" */
export function aISO(ymd, hhmm = "00:00") {
  const [h, m] = String(hhmm).split(":");
  const base = `${ymd}T${String(h).padStart(2, "0")}:${String(m || "00").padStart(2, "0")}:00`;
  // Offset vigente en esa fecha concreta, no en la de hoy (soporta DST).
  return `${base}${offset(new Date(`${base}Z`))}`;
}

/** Suma días a un "YYYY-MM-DD" sin tocar timezones. */
export function sumarDias(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Rango [inicio, fin) de un día completo. */
export function rangoDia(ymd) {
  return { timeMin: aISO(ymd, "00:00"), timeMax: aISO(sumarDias(ymd, 1), "00:00") };
}

/** Rango de N días desde ymd. */
export function rangoDias(ymd, n = 7) {
  return { timeMin: aISO(ymd, "00:00"), timeMax: aISO(sumarDias(ymd, n), "00:00") };
}

export function hoyYmd(tz = TZ) {
  return partes(new Date(), tz).ymd;
}

/** "lunes 21 de julio" */
export function etiquetaDia(ymd, { conDiaSemana = true } = {}) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const txt = `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
  return conDiaSemana ? `${DIAS[d.getUTCDay()]} ${txt}` : txt;
}

/** Hora "18:00" de un punto de evento de Google (null si es de día completo). */
export function horaDeEvento(punto, tz = TZ) {
  if (!punto?.dateTime) return null;
  const p = partes(new Date(punto.dateTime), tz);
  return `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" de un punto de evento, sea de día completo o con hora. */
export function ymdDeEvento(punto, tz = TZ) {
  if (!punto) return null;
  if (punto.date) return punto.date;
  return partes(new Date(punto.dateTime), tz).ymd;
}

export { TZ };
