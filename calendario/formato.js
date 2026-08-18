// calendario/formato.js — los textos que el bot manda al grupo.

import { etiquetaDia, horaDeEvento, ymdDeEvento, sumarDias } from "./fechas.js";

export function linea(evento) {
  const hora = horaDeEvento(evento.start);
  const titulo = evento.summary || "(sin título)";
  const lugar = evento.location ? ` — ${evento.location}` : "";
  return hora ? `${hora}  ${titulo}${lugar}` : `todo el día  ${titulo}${lugar}`;
}

/** Dentro de UN día: primero los de día completo, después por hora. */
export function ordenar(eventos) {
  return [...eventos].sort((a, b) => {
    const ha = horaDeEvento(a.start);
    const hb = horaDeEvento(b.start);
    if (!ha && !hb) return (a.summary || "").localeCompare(b.summary || "");
    if (!ha) return -1;
    if (!hb) return 1;
    return ha.localeCompare(hb);
  });
}

/** Cronológico real (fecha y después hora), para listas de varios días. */
export function ordenarCronologico(eventos) {
  return [...eventos].sort((a, b) => {
    const fa = ymdDeEvento(a.start) || "";
    const fb = ymdDeEvento(b.start) || "";
    if (fa !== fb) return fa.localeCompare(fb);
    return (horaDeEvento(a.start) || "00:00").localeCompare(horaDeEvento(b.start) || "00:00");
  });
}

export function resumenDia(ymd, eventos, { encabezado } = {}) {
  const titulo = encabezado || `📅 *${capitalizar(etiquetaDia(ymd))}*`;
  if (!eventos.length) return `${titulo}\n\nNada agendado. Día libre 🙌`;
  return `${titulo}\n\n${ordenar(eventos).map((e) => `• ${linea(e)}`).join("\n")}`;
}

export function resumenSemana(desdeYmd, eventos, { dias = 7, encabezado } = {}) {
  const hasta = sumarDias(desdeYmd, dias - 1);
  const titulo =
    encabezado ||
    `🗓️ *Semana del ${etiquetaDia(desdeYmd, { conDiaSemana: false })} al ` +
      `${etiquetaDia(hasta, { conDiaSemana: false })}*`;

  if (!eventos.length) return `${titulo}\n\nSemana sin nada agendado.`;

  const porDia = new Map();
  for (let i = 0; i < dias; i++) porDia.set(sumarDias(desdeYmd, i), []);

  for (const ev of eventos) {
    const ymd = ymdDeEvento(ev.start);
    // Un evento que arrancó antes de la ventana pero sigue vigente se cuelga
    // del primer día, para no perderlo.
    if (porDia.has(ymd)) porDia.get(ymd).push(ev);
    else porDia.get(desdeYmd).push(ev);
  }

  const bloques = [];
  let vacios = 0;
  for (const [ymd, evs] of porDia) {
    if (!evs.length) {
      vacios++;
      continue;
    }
    bloques.push(
      `*${capitalizar(etiquetaDia(ymd))}*\n${ordenar(evs).map((e) => `  • ${linea(e)}`).join("\n")}`
    );
  }

  const pie = vacios ? `\n\n_${vacios} día(s) sin nada agendado._` : "";
  return `${titulo}\n\n${bloques.join("\n\n")}${pie}`;
}

export function confirmacionCreado(evento) {
  const ymd = ymdDeEvento(evento.start);
  const hora = horaDeEvento(evento.start);
  const cuando = hora ? `${etiquetaDia(ymd)} a las ${hora}` : `${etiquetaDia(ymd)} (todo el día)`;
  const repite = textoRecurrencia(evento.recurrence);
  return `✅ Agendado: *${evento.summary}* — ${cuando}${repite ? `\n🔁 ${repite}` : ""}`;
}

const DIA_LARGO = { MO: "lunes", TU: "martes", WE: "miércoles", TH: "jueves", FR: "viernes", SA: "sábados", SU: "domingos" };

/** Traduce el RRULE de Google a algo legible ("se repite todas las semanas..."). */
function textoRecurrencia(recurrence) {
  if (!Array.isArray(recurrence) || !recurrence.length) return "";
  const rule = recurrence.find((r) => r.startsWith("RRULE:")) || "";
  const freq = (rule.match(/FREQ=(\w+)/) || [])[1];
  const byday = (rule.match(/BYDAY=([A-Z,]+)/) || [])[1];
  const hasta = (rule.match(/UNTIL=(\d{4})/) || [])[1];
  const finTxt = hasta ? ` (hasta fin de ${hasta})` : "";

  if (byday) {
    const dias = byday.split(",").map((d) => DIA_LARGO[d] || d).join(" y ");
    return `Se repite los ${dias}${finTxt}`;
  }
  const mapa = { DAILY: "todos los días", WEEKLY: "todas las semanas", MONTHLY: "todos los meses", YEARLY: "todos los años" };
  return freq && mapa[freq] ? `Se repite ${mapa[freq]}${finTxt}` : "";
}

export function listaNumerada(eventos) {
  return ordenarCronologico(eventos)
    .map((e, i) => {
      const h = horaDeEvento(e.start);
      return `${i + 1}. ${e.summary} — ${etiquetaDia(ymdDeEvento(e.start))}${h ? ` ${h}` : ""}`;
    })
    .join("\n");
}

export const AYUDA = `📅 *Agenda familiar*

Escribime normal, sin comandos:

*Agendar*
• \`el martes 18hs turno con el pediatra\`
• \`cumple de Ana el 3 de agosto\`
• \`reunión de padres jueves de 19 a 21 en el colegio\`

*Actividades que se repiten*
• \`todos los martes fútbol 18hs\`
• \`danza lunes y miércoles 17hs\`
  (se repiten hasta fin de año)

*Agendar desde una foto*
• Mandá la invitación/flyer con un epígrafe tipo \`agendá esto\` o \`cumple\`
  y saco fecha, hora y lugar de la imagen.

*Consultar*
• \`qué hay hoy\` / \`agenda de mañana\`
• \`qué tenemos el viernes\`
• \`semana\` — los próximos 7 días

*Borrar*
• \`borrar el turno del dentista\`

*Automático*
• Todas las mañanas les paso los eventos del día
• Los domingos 20hs, el resumen de la semana que viene`;

export function capitalizar(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
