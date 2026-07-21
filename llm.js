// calendario/llm.js — interpretación de lenguaje natural para la agenda.
// Usa fetch directo contra la API de Claude, igual que el llm.js de la lista
// (así no sumamos el SDK de Anthropic como dependencia).

import { config, claudeDisponible } from "./config.js";
import { partes, DIAS } from "./fechas.js";

const ACCIONES = ["crear", "ver_dia", "ver_semana", "buscar", "borrar", "ayuda", "nada"];

const ESQUEMA = `Recibís un mensaje de un grupo familiar de WhatsApp y devolvés SOLO un JSON, sin texto adicional:

{"accion":"crear","titulo":str,"fecha":"YYYY-MM-DD","hora":"HH:MM"|null,"duracionMin":int|null,"fechaFin":"YYYY-MM-DD"|null,"lugar":str|null,"notas":str|null}
{"accion":"ver_dia","fecha":"YYYY-MM-DD"}
{"accion":"ver_semana","desde":"YYYY-MM-DD"|null}
{"accion":"buscar","texto":str}
{"accion":"borrar","texto":str}
{"accion":"ayuda"}
{"accion":"nada"}

Reglas:
- Este grupo NO es exclusivo de la agenda: la mayoría de los mensajes son charla familiar.
  Ante la duda, "nada". Solo actuá cuando el pedido de agenda es claro.
  "jajaja", "dale", "gracias", "ya salgo" → {"accion":"nada"}
- Sin hora explícita ("el viernes es feriado", "cumple de Ana el 3") → hora:null,
  queda como evento de día completo.
- Resolvé fechas relativas ("mañana", "el jueves", "el finde", "en 15 días") contra
  la fecha actual que te doy. "El jueves" a secas = el próximo jueves; si hoy es
  jueves y el horario todavía no pasó, es hoy.
- Horas ambiguas: sentido común familiar. "acto a las 8" = 08:00; "cena a las 9" = 21:00.
- "de 3 a 5" → hora "15:00", duracionMin 120.
- titulo corto y sin la fecha adentro: "Turno pediatra de Mati", no
  "turno con el pediatra de Mati el martes a las 4".
- En "borrar", el texto es lo mínimo que sirva para encontrar el evento ("dentista").

Devolvé ÚNICAMENTE el JSON.`;

export async function interpretar(mensaje, { autor } = {}) {
  if (!claudeDisponible) return null;

  const p = partes();
  const ahora =
    `${DIAS[p.diaSemana]} ${p.ymd}, ` +
    `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")} (${config.tz})`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.modelo,
        max_tokens: 400,
        system: `Sos el cerebro de un bot de agenda familiar en un grupo de WhatsApp argentino.\nFecha y hora actual: ${ahora}.\n\n${ESQUEMA}`,
        messages: [{ role: "user", content: autor ? `[${autor}] ${mensaje}` : mensaje }],
      }),
    });

    if (!res.ok) {
      console.error(`⚠️  Claude (agenda) respondió ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    return parsearJson(data?.content?.[0]?.text || "");
  } catch (e) {
    console.error("⚠️  Error llamando a Claude (agenda):", e?.message || e);
    return null;
  }
}

/** Tolera que el modelo devuelva el JSON envuelto en texto o backticks. */
export function parsearJson(texto) {
  const m = (texto || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return ACCIONES.includes(parsed?.accion) ? parsed : null;
  } catch {
    return null;
  }
}
