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
import { obtenerCliente, emailServiceAccount } from "./google-auth.js";
import { modoAuth } from "./config.js";
import { google } from "googleapis";

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
  // Para probar el calendario NO hace falta el grupo de WhatsApp todavía.
  const falta = faltantes().filter((f) => f.startsWith("GOOGLE_"));
  if (falta.length) {
    console.error(`✘ Falta configurar: ${falta.join(", ")}`);
    process.exit(1);
  }

  console.log(`Autenticación: ${modoAuth}`);

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

/** Lista los calendarios a los que tenés acceso, con su ID. */
async function listarCalendarios() {
  const cal = google.calendar({ version: "v3", auth: obtenerCliente() });
  const { data } = await cal.calendarList.list();
  const items = data.items || [];

  if (!items.length) {
    console.log("La cuenta no ve ningún calendario todavía.");
    if (modoAuth === "service_account") {
      console.log(`\nCompartí el calendario familiar con:\n\n  ${emailServiceAccount()}\n`);
      console.log("En Google Calendar: Configuración del calendario → Compartir con");
      console.log('determinadas personas → Añadir → permiso "Hacer cambios en los eventos".');
      console.log("\nEl ID del calendario está en esa misma pantalla, más abajo,");
      console.log('en "Integrar calendario" → "ID de calendario".');
    }
    return;
  }

  console.log("Calendarios disponibles:\n");
  for (const c of items) {
    const rol =
      c.accessRole === "owner" || c.accessRole === "writer" ? "✏️  escritura" : "👁  solo lectura";
    console.log(`  ${c.summary}${c.primary ? " (principal)" : ""}   ${rol}`);
    console.log(`  GOOGLE_CALENDAR_ID=${c.id}\n`);
  }
  console.log("Copiá al .env el ID del calendario FAMILIAR (no el principal).");
}

/** Muestra con qué identidad se está conectando el bot. */
async function mostrarIdentidad() {
  console.log(`Modo de autenticación: ${modoAuth || "SIN CONFIGURAR"}`);
  if (modoAuth === "service_account") {
    console.log(`Archivo : ${config.google.serviceAccountFile}`);
    console.log(`Email   : ${emailServiceAccount()}`);
    console.log("\n☝️  Con ESE email hay que compartir el calendario familiar.");
  } else if (modoAuth === "oauth") {
    console.log("⚠️  OAuth de usuario: el refresh token caduca a los 7 días si la");
    console.log("    app está en modo Testing. Para el servicio conviene service account.");
  }
  console.log(`Calendario configurado: ${config.google.calendarId || "(vacío)"}`);
}

const TAREAS = {
  parse: probarParser,
  calendarios: listarCalendarios,
  quien: mostrarIdentidad,
};

const tarea = (TAREAS[modo] || probarCalendario)();
tarea.catch((e) => {
  console.error("✘ Falló:", e?.message || e);
  process.exit(1);
});
