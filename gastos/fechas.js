// gastos/fechas.js — fechas y períodos, sin dependencias.
//
// Un "período" es un mes: "2026-09". Un gasto recurrente tiene un día de
// vencimiento (1-31) que se recorta al último día del mes cuando hace falta:
// día 31 en febrero vence el 28.

import { config } from "./config.js";

const TZ = config.tz;

export const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
export const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** Partes de un Date tal como se ven en la timezone configurada. */
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

export function hoyYmd(tz = TZ) {
  return partes(new Date(), tz).ymd;
}

/** "2026-09-14" -> "2026-09" */
export function periodoDe(ymd = hoyYmd()) {
  return ymd.slice(0, 7);
}

export function periodoActual() {
  return periodoDe(hoyYmd());
}

/** Suma meses a un período: ("2026-12", 1) -> "2027-01" */
export function sumarMeses(periodo, n) {
  const [a, m] = periodo.split("-").map(Number);
  const total = a * 12 + (m - 1) + n;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

export function diasDelMes(periodo) {
  const [a, m] = periodo.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/** Fecha de vencimiento de un gasto en un período, recortada al fin de mes. */
export function vencimientoYmd(periodo, dia) {
  const d = Math.min(Math.max(Number(dia) || 1, 1), diasDelMes(periodo));
  return `${periodo}-${String(d).padStart(2, "0")}`;
}

/** Días entre dos "YYYY-MM-DD" (hasta - desde). Positivo = falta. */
export function diffDias(desdeYmd, hastaYmd) {
  const a = Date.parse(`${desdeYmd}T12:00:00Z`);
  const b = Date.parse(`${hastaYmd}T12:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function sumarDias(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "lunes 14 de septiembre" */
export function etiquetaDia(ymd, { conDiaSemana = true } = {}) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const txt = `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
  return conDiaSemana ? `${DIAS[d.getUTCDay()]} ${txt}` : txt;
}

/** "septiembre 2026" */
export function etiquetaPeriodo(periodo) {
  const [a, m] = periodo.split("-").map(Number);
  return `${MESES[m - 1]} ${a}`;
}

export { TZ };
