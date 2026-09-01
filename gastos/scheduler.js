// gastos/scheduler.js — recordatorios automáticos.
//
// Mismas dos guardas que calendario/scheduler.js:
//   1. iniciar() es idempotente: frena las tareas viejas antes de crear nuevas,
//      así una reconexión de WhatsApp no duplica los avisos.
//   2. Sello por día (acá vive en gastos.json, por gasto y tipo de aviso), para
//      que un reinicio cerca del horario no repita el mensaje.

import cron from "node-cron";
import { config } from "./config.js";
import { hoyYmd } from "./fechas.js";

let tareas = [];
const ultimaEjecucion = { diario: null, mensual: null };

export function iniciar(agente) {
  detener();

  if (!config.recordatoriosActivos) {
    console.log("💸 Recordatorios de gastos desactivados (RECORDATORIOS_GASTOS=off)");
    return;
  }

  const opciones = { timezone: config.tz };

  tareas.push(
    cron.schedule(config.cronDiario, () => correr("diario", () => agente.revisarRecordatorios()), opciones)
  );

  if (config.resumenMensual) {
    tareas.push(
      cron.schedule(
        config.cronMensual,
        () =>
          correr("mensual", async () => {
            await agente.arrastreMesAnterior();
            return agente.resumenMensual();
          }),
        opciones
      )
    );
  }

  console.log(
    `💸 Recordatorios de gastos: "${config.cronDiario}" | ${config.tz} | ` +
      `aviso ${config.avisoDiasDefault}d antes, insiste cada ${config.insistirCada}d` +
      `${config.resumenMensual ? ` | resumen mensual "${config.cronMensual}"` : ""}`
  );
}

async function correr(nombre, fn) {
  const hoy = hoyYmd();
  if (ultimaEjecucion[nombre] === hoy) {
    console.log(`💸 La corrida ${nombre} ya salió hoy (${hoy}), la salteo.`);
    return;
  }
  ultimaEjecucion[nombre] = hoy;
  try {
    const r = await fn();
    console.log(`💸 Recordatorios ${nombre} ok${typeof r === "number" ? ` (${r} aviso/s)` : ""}`);
  } catch (e) {
    ultimaEjecucion[nombre] = null; // permitir reintento
    console.error(`❌ Recordatorios ${nombre} falló:`, e?.message || e);
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
