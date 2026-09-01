// gastos/store.js — persistencia de los gastos en un archivo JSON.
//
// Forma del archivo:
// {
//   "gastos": [ { id, nombre, alias[], monto, dia, avisoDias, activo, creadoPor, fecha } ],
//   "pagos":  { "2026-09": { "<gastoId>": {
//        estado: "pendiente"|"pagado", montoReal, pagadoPor, fechaPago,
//        comprobante: { archivo, mime, nombre, fecha } | null,
//        avisos: { previo, vencimiento, insistencia },   // sellos "YYYY-MM-DD"
//        insistencias: 0
//   } } }
// }
//
// El período se crea perezosamente: la primera vez que alguien pregunta por un
// mes se generan los pagos pendientes de los gastos activos. Así un gasto dado
// de alta a mitad de mes entra igual, y los meses viejos no se tocan.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { config } from "./config.js";
import { periodoActual, vencimientoYmd, hoyYmd } from "./fechas.js";

const FILE = config.archivo;

function vacio() {
  return { gastos: [], pagos: {} };
}

export function cargar() {
  if (!existsSync(FILE)) return vacio();
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    return { gastos: data.gastos || [], pagos: data.pagos || {} };
  } catch (e) {
    console.error("⚠️  gastos.json ilegible, arranco vacío:", e?.message || e);
    return vacio();
  }
}

function guardar(data) {
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function normalizar(texto) {
  return (texto || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function nuevoId() {
  return `g${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function pagoVacio() {
  return {
    estado: "pendiente",
    montoReal: null,
    pagadoPor: null,
    fechaPago: null,
    comprobante: null,
    avisos: {},
    insistencias: 0,
  };
}

// ---------- Gastos recurrentes ----------

export function listarGastos({ soloActivos = true } = {}) {
  const { gastos } = cargar();
  return soloActivos ? gastos.filter((g) => g.activo !== false) : gastos;
}

export function obtener(id) {
  return cargar().gastos.find((g) => g.id === id) || null;
}

/**
 * Alta de un gasto recurrente. `dia` es el día del mes en que vence (1-31).
 * Devuelve el gasto creado, o null si ya existía uno activo con ese nombre.
 */
export function crear({ nombre, alias = [], monto = null, dia = 1, avisoDias = null, creadoPor = "" }) {
  const data = cargar();
  const n = normalizar(nombre);
  if (!n) return null;
  if (data.gastos.some((g) => g.activo !== false && normalizar(g.nombre) === n)) return null;

  const gasto = {
    id: nuevoId(),
    nombre: nombre.trim(),
    alias: [...new Set(alias.map((a) => a.trim()).filter(Boolean))],
    monto: monto == null ? null : Number(monto),
    dia: Math.min(Math.max(Number(dia) || 1, 1), 31),
    avisoDias: avisoDias == null ? null : Number(avisoDias),
    activo: true,
    creadoPor,
    fecha: new Date().toISOString(),
  };
  data.gastos.push(gasto);
  guardar(data);
  return gasto;
}

export function editar(id, cambios = {}) {
  const data = cargar();
  const g = data.gastos.find((x) => x.id === id);
  if (!g) return null;
  if (cambios.nombre) g.nombre = String(cambios.nombre).trim();
  if (cambios.alias) g.alias = [...new Set(cambios.alias.map((a) => a.trim()).filter(Boolean))];
  if (cambios.monto !== undefined) g.monto = cambios.monto == null ? null : Number(cambios.monto);
  if (cambios.dia !== undefined) g.dia = Math.min(Math.max(Number(cambios.dia) || 1, 1), 31);
  if (cambios.avisoDias !== undefined) {
    g.avisoDias = cambios.avisoDias == null ? null : Number(cambios.avisoDias);
  }
  guardar(data);
  return g;
}

/** Baja lógica: el historial de meses anteriores se conserva. */
export function darDeBaja(id) {
  const data = cargar();
  const g = data.gastos.find((x) => x.id === id);
  if (!g) return null;
  g.activo = false;
  g.bajaFecha = new Date().toISOString();
  guardar(data);
  return g;
}

/**
 * Busca gastos activos por nombre o alias. Ordena por calidad del match:
 * exacto > empieza con > contiene. Devuelve [] si no hay nada.
 */
export function buscar(texto) {
  const q = normalizar(texto);
  if (!q) return [];
  const puntaje = (g) => {
    const candidatos = [g.nombre, ...(g.alias || [])].map(normalizar);
    let mejor = 0;
    for (const c of candidatos) {
      if (!c) continue;
      if (c === q) mejor = Math.max(mejor, 3);
      else if (c.startsWith(q) || q.startsWith(c)) mejor = Math.max(mejor, 2);
      else if (c.includes(q) || q.includes(c)) mejor = Math.max(mejor, 1);
    }
    return mejor;
  };
  return listarGastos()
    .map((g) => ({ g, p: puntaje(g) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p)
    .map((x) => x.g);
}

// ---------- Pagos del mes ----------

/** Crea los pagos pendientes que falten para ese período. Idempotente. */
export function asegurarPeriodo(periodo = periodoActual()) {
  const data = cargar();
  const mes = (data.pagos[periodo] = data.pagos[periodo] || {});
  let cambio = false;
  for (const g of data.gastos) {
    if (g.activo === false) continue;
    if (!mes[g.id]) {
      mes[g.id] = pagoVacio();
      cambio = true;
    }
  }
  if (cambio) guardar(data);
  return mes;
}

export function pagoDe(gastoId, periodo = periodoActual()) {
  const data = cargar();
  return data.pagos[periodo]?.[gastoId] || null;
}

/**
 * Estado del mes: una fila por gasto activo (más los gastos dados de baja que
 * hayan tenido movimiento en ese período). Ordenado por día de vencimiento.
 */
export function estadoPeriodo(periodo = periodoActual()) {
  // Solo el mes en curso (o uno futuro) genera pendientes nuevos: si no, mirar
  // un mes viejo le inventaría deudas a gastos dados de alta después.
  if (periodo >= periodoActual()) asegurarPeriodo(periodo);
  const data = cargar();
  const mes = data.pagos[periodo] || {};
  const filas = [];
  for (const g of data.gastos) {
    const pago = mes[g.id];
    if (!pago) continue;
    if (g.activo === false && pago.estado === "pendiente") continue;
    filas.push({ gasto: g, pago, vence: vencimientoYmd(periodo, g.dia), periodo });
  }
  return filas.sort((a, b) => a.vence.localeCompare(b.vence));
}

export function pendientesDe(periodo = periodoActual()) {
  return estadoPeriodo(periodo).filter((f) => f.pago.estado === "pendiente");
}

/** Marca pagado. `comprobante` es opcional: se puede pagar sin adjuntar nada. */
export function marcarPagado(
  gastoId,
  periodo = periodoActual(),
  { pagadoPor = "", monto = null, comprobante = null } = {}
) {
  const data = cargar();
  const mes = (data.pagos[periodo] = data.pagos[periodo] || {});
  const pago = (mes[gastoId] = mes[gastoId] || pagoVacio());
  pago.estado = "pagado";
  pago.pagadoPor = pagadoPor || pago.pagadoPor;
  pago.fechaPago = hoyYmd();
  if (monto != null) pago.montoReal = Number(monto);
  if (comprobante) pago.comprobante = comprobante;
  guardar(data);
  return pago;
}

/** Vuelve un pago a pendiente (por si alguien marcó de más). */
export function desmarcar(gastoId, periodo = periodoActual()) {
  const data = cargar();
  const pago = data.pagos[periodo]?.[gastoId];
  if (!pago) return null;
  pago.estado = "pendiente";
  pago.pagadoPor = null;
  pago.fechaPago = null;
  guardar(data);
  return pago;
}

/** Adjunta un comprobante a un pago ya existente. */
export function adjuntarComprobante(gastoId, periodo, comprobante) {
  const data = cargar();
  const mes = (data.pagos[periodo] = data.pagos[periodo] || {});
  const pago = (mes[gastoId] = mes[gastoId] || pagoVacio());
  pago.comprobante = comprobante;
  guardar(data);
  return pago;
}

/** Sello anti-duplicado: deja registrado que hoy ya salió un aviso de ese tipo. */
export function registrarAviso(gastoId, periodo, tipo, ymd = hoyYmd()) {
  const data = cargar();
  const mes = (data.pagos[periodo] = data.pagos[periodo] || {});
  const pago = (mes[gastoId] = mes[gastoId] || pagoVacio());
  pago.avisos = pago.avisos || {};
  pago.avisos[tipo] = ymd;
  if (tipo === "insistencia") pago.insistencias = (pago.insistencias || 0) + 1;
  guardar(data);
  return pago;
}

/** Últimos N períodos con movimiento de un gasto, del más nuevo al más viejo. */
export function historial(gastoId, n = 6) {
  const data = cargar();
  return Object.keys(data.pagos)
    .filter((p) => data.pagos[p][gastoId])
    .sort((a, b) => b.localeCompare(a))
    .slice(0, n)
    .map((p) => ({ periodo: p, pago: data.pagos[p][gastoId] }));
}
