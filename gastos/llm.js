// gastos/llm.js — interpretación de lenguaje natural para el bot de gastos.
// Mismo patrón que calendario/llm.js: fetch directo contra la API de Claude.

import { config, claudeDisponible } from "./config.js";
import { partes, DIAS } from "./fechas.js";

const ACCIONES = ["crear", "ver_mes", "pagado", "baja", "editar", "historial", "comprobante", "ayuda", "nada"];

const ESQUEMA = `Recibís un mensaje de un grupo de WhatsApp donde se organizan los gastos fijos del mes y devolvés SOLO un JSON, sin texto adicional:

{"accion":"crear","nombre":str,"dia":int,"monto":num|null,"avisoDias":int|null,"alias":[str]|null}
{"accion":"ver_mes"}
{"accion":"pagado","texto":str,"monto":num|null}
{"accion":"baja","texto":str}
{"accion":"editar","texto":str,"dia":int|null,"monto":num|null,"avisoDias":int|null}
{"accion":"historial","texto":str}
{"accion":"comprobante","texto":str}
{"accion":"ayuda"}
{"accion":"nada"}

Reglas:
- Ante la duda, "nada". El grupo tiene charla suelta: "gracias", "dale", "ahí lo veo" → nada.
- "crear" es para gastos que se repiten TODOS los meses (luz, gas, expensas, alquiler,
  internet, colegio, prepaga, tarjeta). "nombre" corto y en singular: "Luz", "Expensas".
  "dia" es el día del mes en que vence (1-31). Si dicen "a fin de mes" → 30.
  Si no dicen día, devolvé "nada": el día es obligatorio.
- "monto": solo el número, sin símbolos ni puntos de miles. "40 lucas" = 40000,
  "$52.300" = 52300, "45,5 mil" = 45500. Si no lo dicen, null.
- "avisoDias": cuántos días antes quieren el aviso, si lo aclaran ("avisame una semana antes" = 7).
- "pagado": ya lo pagaron. "texto" es lo mínimo para identificar el gasto ("luz").
  "ya pagué la luz" → {"accion":"pagado","texto":"luz","monto":null}
  "pagué expensas 132000" → {"accion":"pagado","texto":"expensas","monto":132000}
- "baja": dejar de recordarlo ("sacá internet", "ya no pagamos el gimnasio").
- "editar": cambia día, monto o aviso de un gasto existente ("la luz ahora vence el 20").
- "historial": quieren ver meses anteriores de un gasto.
- "comprobante": piden que devuelvas el comprobante guardado de un gasto.
- "ver_mes": "cómo venimos", "qué falta pagar", "gastos", "estado del mes".

Devolvé ÚNICAMENTE el JSON.`;

function ahoraTexto() {
  const p = partes();
  return (
    `${DIAS[p.diaSemana]} ${p.ymd}, ` +
    `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")} (${config.tz})`
  );
}

async function pedir(body, etiqueta) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`⚠️  Claude (${etiqueta}) respondió ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return data?.content?.[0]?.text || "";
  } catch (e) {
    console.error(`⚠️  Error llamando a Claude (${etiqueta}):`, e?.message || e);
    return null;
  }
}

export async function interpretar(mensaje, { autor } = {}) {
  if (!claudeDisponible) return null;
  const texto = await pedir(
    {
      model: config.modelo,
      max_tokens: 400,
      system: `Sos el cerebro de un bot de gastos mensuales en un grupo de WhatsApp argentino.\nFecha y hora actual: ${ahoraTexto()}.\n\n${ESQUEMA}`,
      messages: [{ role: "user", content: autor ? `[${autor}] ${mensaje}` : mensaje }],
    },
    "gastos"
  );
  return parsearJson(texto || "");
}

/**
 * Lee un comprobante (foto o PDF) y trata de decir A CUÁL de los gastos
 * pendientes corresponde y por cuánto. Solo se usa cuando el epígrafe no
 * alcanzó para identificarlo, así no gastamos API de más.
 *
 * @param {string[]} nombres nombres exactos de los gastos pendientes
 * @returns {{gasto:string|null, monto:number|null}|null}
 */
export async function leerComprobante(base64, mime, { nombres = [], caption = "" } = {}) {
  if (!claudeDisponible || !nombres.length) return null;

  const esPdf = /pdf/i.test(mime);
  const mediaType = /png/i.test(mime)
    ? "image/png"
    : /webp/i.test(mime)
      ? "image/webp"
      : /gif/i.test(mime)
        ? "image/gif"
        : "image/jpeg";

  const contenido = esPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  const system =
    `Te paso un comprobante de pago (transferencia, factura, ticket) de Argentina.\n` +
    `Los gastos pendientes del mes son exactamente estos: ${nombres.map((n) => `"${n}"`).join(", ")}.\n\n` +
    `Devolvé SOLO un JSON: {"gasto": <uno de esos nombres EXACTOS o null>, "monto": <número o null>}\n` +
    `- Elegí el gasto por el destinatario/empresa/concepto del comprobante (Edenor/Edesur→luz, ` +
    `Metrogas/Naturgy→gas, AySA→agua, administración/consorcio→expensas, Fibertel/Telecentro/Movistar→internet).\n` +
    `- Si no podés asociarlo con confianza a uno de esos nombres, "gasto": null. No adivines.\n` +
    `- "monto": el importe total pagado, solo el número.\n\nDevolvé ÚNICAMENTE el JSON.`;

  const texto = await pedir(
    {
      model: config.modelo,
      max_tokens: 200,
      system,
      messages: [
        {
          role: "user",
          content: [
            contenido,
            { type: "text", text: caption ? `Lo mandaron con este texto: ${caption}` : "¿A qué gasto corresponde?" },
          ],
        },
      ],
    },
    "gastos/comprobante"
  );

  const m = (texto || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const gasto = nombres.includes(parsed?.gasto) ? parsed.gasto : null;
    const monto = Number.isFinite(Number(parsed?.monto)) ? Number(parsed.monto) : null;
    return { gasto, monto };
  } catch {
    return null;
  }
}

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
