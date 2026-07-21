// calendario/scheduler.js — resúmenes automáticos.
//
// Dos guardas importantes:
//   1. iniciar() es idempotente: frena las tareas viejas antes de crear nuevas.
//      Sin esto, cada reconexión de WhatsApp duplicaría el resumen matutino
//      (el clásico "me lo mandó 3 veces").
//   2. Sello por día: si el proceso reinicia cerca del horario, no repite envío.

import cron from "node-cron";
import { config } from "./config.js";
import { hoyYmd } from "./fechas.js";

let tareas = [];
const ultimaEjecucion = { diario: null, semanal: null };

export function iniciar(agente) {
  detener();

  if (!config.resumenesActivos) {
    console.log("📅 Resúmenes automáticos desactivados (RESUMENES=off)");
    return;
  }

  const opciones = { timezone: config.tz };
  tareas.push(cron.schedule(config.cronDiario, () => correr("diario", () => agente.resumenDiario()), opciones));
  tareas.push(cron.schedule(config.cronSemanal, () => correr("semanal", () => agente.resumenSemanal()), opciones));

  console.log(
    `📅 Resúmenes: diario "${config.cronDiario}" | semanal "${config.cronSemanal}" | ${config.tz}`
  );
}

async function correr(nombre, fn) {
  const hoy = hoyYmd();
  if (ultimaEjecucion[nombre] === hoy) {
    console.log(`📅 El resumen ${nombre} ya salió hoy (${hoy}), lo salteo.`);
    return;
  }
  ultimaEjecucion[nombre] = hoy;
  try {
    const enviado = await fn();
    console.log(`📅 Resumen ${nombre} ok${enviado === false ? " (día vacío, no envié)" : ""}`);
  } catch (e) {
    ultimaEjecucion[nombre] = null; // permitir reintento manual
    console.error(`❌ Resumen ${nombre} falló:`, e?.message || e);
  }
}

export function detener() {
  for (const t of tareas) {
    try {
      t.stop();
    } catch {
      /* ignorar */
    }
  }
  tareas = [];
}
