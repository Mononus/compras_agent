// gastos/formato.js — los textos que el bot manda al grupo.

import { config } from "./config.js";
import { etiquetaDia, etiquetaPeriodo, diffDias, hoyYmd } from "./fechas.js";

const fmtPlata = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: config.moneda || "ARS",
  maximumFractionDigits: 0,
});

export function plata(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  try {
    return fmtPlata.format(Number(n));
  } catch {
    return `$ ${Number(n).toLocaleString("es-AR")}`;
  }
}

export function capitalizar(s) {
  return (s || "").charAt(0).toUpperCase() + (s || "").slice(1);
}

/** "en 3 días" / "hoy" / "hace 2 días" */
function cuando(vence, hoy = hoyYmd()) {
  const d = diffDias(hoy, vence);
  if (d === 0) return "vence hoy";
  if (d === 1) return "vence mañana";
  if (d > 1) return `vence en ${d} días`;
  if (d === -1) return "venció ayer";
  return `venció hace ${-d} días`;
}

function montoDe(fila) {
  const { gasto, pago } = fila;
  if (pago.montoReal != null) return plata(pago.montoReal);
  if (gasto.monto != null) return `${plata(gasto.monto)} aprox.`;
  return null;
}

export function lineaGasto(fila, { conEstado = true } = {}) {
  const { gasto, pago, vence } = fila;
  const m = montoDe(fila);
  const dia = vence.slice(8);
  const izq = `*${gasto.nombre}* — día ${Number(dia)}${m ? ` · ${m}` : ""}`;
  if (!conEstado) return izq;
  if (pago.estado === "pagado") {
    const quien = pago.pagadoPor ? ` por ${pago.pagadoPor}` : "";
    const compro = pago.comprobante ? " 🧾" : "";
    return `✅ ${izq}${compro}\n   pagado el ${etiquetaDia(pago.fechaPago || vence, { conDiaSemana: false })}${quien}`;
  }
  const d = diffDias(hoyYmd(), vence);
  const icono = d < 0 ? "🔴" : d <= 2 ? "🟡" : "⚪";
  return `${icono} ${izq}\n   ${cuando(vence)}`;
}

export function estadoMes(periodo, filas) {
  const titulo = `💸 *Gastos de ${etiquetaPeriodo(periodo)}*`;
  if (!filas.length) {
    return `${titulo}\n\nNo hay gastos cargados. Escribí \`nuevo Luz día 15\` para empezar.`;
  }
  const pendientes = filas.filter((f) => f.pago.estado === "pendiente");
  const pagados = filas.filter((f) => f.pago.estado === "pagado");

  const bloques = [];
  if (pendientes.length) {
    bloques.push(`*Pendientes (${pendientes.length})*\n${pendientes.map((f) => lineaGasto(f)).join("\n")}`);
  }
  if (pagados.length) {
    bloques.push(`*Pagados (${pagados.length})*\n${pagados.map((f) => lineaGasto(f)).join("\n")}`);
  }

  const totalPagado = pagados.reduce((s, f) => s + (f.pago.montoReal ?? f.gasto.monto ?? 0), 0);
  const pie = totalPagado ? `\n\n_Pagado este mes: ${plata(totalPagado)}_` : "";

  return `${titulo}\n\n${bloques.join("\n\n")}${pie}`;
}

export function resumenMensual(periodo, filas) {
  const estimado = filas.reduce((s, f) => s + (f.gasto.monto ?? 0), 0);
  const cab = `📅 *Arranca ${etiquetaPeriodo(periodo)}* — esto es lo que hay que pagar:`;
  if (!filas.length) return `${cab}\n\nNada cargado todavía.`;
  const lista = filas.map((f) => `• *${f.gasto.nombre}* — día ${Number(f.vence.slice(8))}${f.gasto.monto != null ? ` · ${plata(f.gasto.monto)} aprox.` : ""}`).join("\n");
  return `${cab}\n\n${lista}${estimado ? `\n\n_Estimado del mes: ${plata(estimado)}_` : ""}`;
}

// --- Avisos automáticos ---------------------------------------------------

export function avisoPrevio(fila) {
  const m = montoDe(fila);
  return (
    `⏰ *${fila.gasto.nombre}* ${cuando(fila.vence)} ` +
    `(${etiquetaDia(fila.vence, { conDiaSemana: false })})${m ? `\nMonto: ${m}` : ""}\n\n` +
    `_Cuando lo pagues, mandá el comprobante acá respondiendo a este mensaje._`
  );
}

export function avisoVencimiento(fila) {
  const m = montoDe(fila);
  return (
    `🔔 *${fila.gasto.nombre}* vence HOY${m ? ` · ${m}` : ""}\n\n` +
    `_Mandá el comprobante respondiendo a este mensaje y lo marco pagado._`
  );
}

export function avisoAtraso(fila, atraso) {
  const m = montoDe(fila);
  return (
    `🔴 *${fila.gasto.nombre}* sigue sin pagar — venció hace ${atraso} día${atraso === 1 ? "" : "s"}` +
    `${m ? ` · ${m}` : ""}`
  );
}

// --- Confirmaciones -------------------------------------------------------

export function confirmacionPago(fila, { comprobante = false } = {}) {
  const m = fila.pago.montoReal != null ? ` · ${plata(fila.pago.montoReal)}` : "";
  const c = comprobante ? " con comprobante 🧾" : " (sin comprobante)";
  return `✅ *${fila.gasto.nombre}* pagado${m}${c}. Queda tachado de ${etiquetaPeriodo(fila.periodo)}.`;
}

export function confirmacionAlta(gasto) {
  const partes = [`día ${gasto.dia} de cada mes`];
  if (gasto.monto != null) partes.push(plata(gasto.monto));
  const aviso = gasto.avisoDias ?? config.avisoDiasDefault;
  partes.push(`aviso ${aviso} día${aviso === 1 ? "" : "s"} antes`);
  return `✅ Agendado: *${gasto.nombre}* — ${partes.join(" · ")}`;
}

export function listaNumerada(filas) {
  return filas
    .map((f, i) => `${i + 1}. ${f.gasto.nombre} — día ${Number(f.vence.slice(8))}`)
    .join("\n");
}

export function historialTexto(gasto, items) {
  if (!items.length) return `No tengo historial de *${gasto.nombre}* todavía.`;
  const lineas = items.map(({ periodo, pago }) => {
    if (pago.estado !== "pagado") return `• ${etiquetaPeriodo(periodo)} — pendiente`;
    const m = pago.montoReal != null ? ` · ${plata(pago.montoReal)}` : "";
    return `• ${etiquetaPeriodo(periodo)} — pagado${m}${pago.comprobante ? " 🧾" : ""}`;
  });
  return `📜 *${gasto.nombre}*\n\n${lineas.join("\n")}`;
}

export const AYUDA = `💸 *Gastos del mes*

*Ver*
• \`gastos\` — qué está pagado y qué falta
• \`historial luz\` — cómo vino ese gasto los últimos meses

*Cargar un gasto que se repite todos los meses*
• \`nuevo Luz día 15 monto 40000\`
• \`nuevo Expensas día 10\` (sin monto, si varía)
• \`nuevo Internet día 5 aviso 5\` (avisa 5 días antes)

*Marcar pagado*
• Mandá la foto o el PDF del comprobante con el epígrafe \`pagado luz\`
• O respondé al recordatorio con el comprobante, sin escribir nada
• Podés sumar el monto real: \`pagado luz 45300\`
• Sin comprobante a mano: \`pagado luz\` en texto

*Mantenimiento*
• \`comprobante luz\` — te devuelvo el que está guardado
• \`baja Internet\` — deja de recordarlo (el historial queda)
• \`cambiar Luz día 20\` / \`cambiar Luz monto 52000\`

*Automático*
• Aviso unos días antes de cada vencimiento
• Aviso el día que vence
• Si sigue sin pagar, insisto cada 2 días (y después una vez por semana)`;
