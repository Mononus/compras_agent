// calendario/llm.js — interpretación de lenguaje natural para la agenda.
// Usa fetch directo contra la API de Claude, igual que el llm.js de la lista
// (así no sumamos el SDK de Anthropic como dependencia).

import { config, claudeDisponible } from "./config.js";
import { partes, DIAS } from "./fechas.js";

const ACCIONES = ["crear", "ver_dia", "ver_semana", "buscar", "borrar", "ayuda", "nada"];

const ESQUEMA = `Recibís un mensaje de un grupo familiar de WhatsApp y devolvés SOLO un JSON, sin texto adicional:

{"accion":"crear","titulo":str,"fecha":"YYYY-MM-DD","hora":"HH:MM"|null,"duracionMin":int|null,"fechaFin":"YYYY-MM-DD"|null,"lugar":str|null,"notas":str|null,"repetir":{"freq":"DAILY|WEEKLY|MONTHLY|YEARLY","dias":["MO","TU","WE","TH","FR","SA","SU"]|null}|null}
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
- REPETICIÓN: si el mensaje indica que algo se repite ("todos los martes",
  "cada semana", "los lunes y miércoles", "todos los días", "el 3 de cada mes",
  "cada año"), completá "repetir". La "fecha" es SIEMPRE la primera ocurrencia
  (la más próxima). Ejemplos:
  · "todos los martes fútbol 18hs" → fecha = próximo martes, hora "18:00",
    repetir {"freq":"WEEKLY","dias":null}  (el día sale de la fecha)
  · "danza lunes y miércoles 17hs" → fecha = próximo lunes o miércoles,
    repetir {"freq":"WEEKLY","dias":["MO","WE"]}
  · "todos los días tomar la pastilla 9am" → repetir {"freq":"DAILY","dias":null}
  · "el 3 de cada mes pagar expensas" → repetir {"freq":"MONTHLY","dias":null}
  Sin repetición, repetir:null. NO inventes repetición si el mensaje no la pide.

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

/**
 * Igual que interpretar(), pero a partir de una IMAGEN (invitación, flyer,
 * captura). El caption es contexto opcional. Claude Haiku lee la imagen y
 * devuelve el mismo JSON de acciones (en la práctica, "crear" o "nada").
 *
 * @param {string} base64  imagen ya codificada en base64 (sin el prefijo data:)
 * @param {string} mime    ej. "image/jpeg"
 * @param {string} caption texto que acompañó a la foto
 */
export async function interpretarImagen(base64, mime, caption, { autor } = {}) {
  if (!claudeDisponible) return null;

  const p = partes();
  const ahora =
    `${DIAS[p.diaSemana]} ${p.ymd}, ` +
    `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")} (${config.tz})`;

  const mediaType = /png/i.test(mime)
    ? "image/png"
    : /webp/i.test(mime)
      ? "image/webp"
      : /gif/i.test(mime)
        ? "image/gif"
        : "image/jpeg";

  const system =
    `Sos el cerebro de un bot de agenda familiar en un grupo de WhatsApp argentino.\n` +
    `Fecha y hora actual: ${ahora}.\n\n` +
    `Te paso una IMAGEN (invitación de cumpleaños, flyer, captura, etc.) y quizás un texto.\n` +
    `Extraé el evento y devolvé la acción "crear". Prestá atención a fecha, hora, lugar y de qué es.\n` +
    `Si el año no figura, asumí el más cercano en el futuro. Si no hay hora clara, hora:null.\n` +
    `Si la imagen NO tiene un evento con fecha (es un meme, una foto cualquiera), devolvé {"accion":"nada"}.\n\n` +
    ESQUEMA;

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
        system,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              {
                type: "text",
                text: caption
                  ? `Contexto de quien la mandó${autor ? ` [${autor}]` : ""}: ${caption}`
                  : "Agendá el evento que aparece en esta imagen.",
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`⚠️  Claude (agenda/imagen) respondió ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    return parsearJson(data?.content?.[0]?.text || "");
  } catch (e) {
    console.error("⚠️  Error llamando a Claude (agenda/imagen):", e?.message || e);
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
