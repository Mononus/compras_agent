// calendario/probar.js — verificación sin tocar WhatsApp.
//
//   node calendario/probar.js          lee el calendario e imprime los resúmenes
//   node calendario/probar.js crear    además crea y borra un evento (valida escritura)
//   node calendario/probar.js parse    prueba el parser de lenguaje natural

import "dotenv/config";
import { config, faltantes, claudeDisponible } from "./config.js";
import { verificar } from "./google-auth.js";
import * as calendar from "./calendar.js";
import * as formato from "./formato.js";
import { interpretar } from "./llm.js";
import { hoyYmd, sumarDias, etiquetaDia, partes, DIAS } from "./fechas.js";

const modo = process.argv[2] || "";

const FRASES = [
  "el martes 18hs turno con el pediatra de Mati",
  "cumple de Ana el 3 de agosto",
  "reunión de padres el jueves de 19 a 21 en el colegio",
  "mañana a las 8 acto en la escuela",
  "qué tenemos el viernes",
  "borrar el turno del dentista",
  "jajaja qué bueno eso",
  "compramos leche?",
];

async function probarParser() {
  const p = partes();
  console.log(`Ahora: ${DIAS[p.diaSemana]} ${p.ymd} ${p.hora}:${p.minuto} (${config.tz})`);
  console.log(`Claude: ${claudeDisponible ? config.modelo : "APAGADO (falta ANTHROPIC_API_KEY)"}\n`);
  for (const f of process.argv.slice(3).length ? process.argv.slice(3) : FRASES) {
    console.log(`"${f}"\n  → ${JSON.stringify(await interpretar(f, { autor: "Mariano" }))}\n`);
  }
}

async function probarCalendario() {
  const falta = faltantes();
  if (falta.length) {
    console.error(`✘ Falta configurar: ${falta.join(", ")}`);
    process.exit(1);
  }

  console.log(`✔ Calendario: "${await verificar()}"\n`);

  const hoy = hoyYmd();
  console.log("--- RESUMEN DIARIO ---");
  console.log(
    formato.resumenDia(hoy, await calendar.eventosDelDia(hoy), {
      encabezado: `☀️ *Buen día. Hoy, ${etiquetaDia(hoy)}:*`,
    })
  );

  const manana = sumarDias(hoy, 1);
  console.log("\n--- RESUMEN SEMANAL ---");
  console.log(formato.resumenSemana(manana, await calendar.eventosDeRango(manana, 7)));

  if (modo === "crear") {
    console.log("\n--- PRUEBA DE ESCRITURA ---");
    const ev = await calendar.crear({
      titulo: "PRUEBA — se borra sola",
      fecha: manana,
      hora: "15:00",
      duracionMin: 30,
      creadoPor: "script de prueba",
    });
    console.log(formato.confirmacionCreado(ev));
    await calendar.borrar(ev.id);
    console.log("🗑️ Evento de prueba borrado — permisos de escritura OK");
  }
}

const tarea = modo === "parse" ? probarParser() : probarCalendario();
tarea.catch((e) => {
  console.error("✘ Falló:", e?.message || e);
  process.exit(1);
});
