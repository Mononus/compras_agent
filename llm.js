// llm.js — interpretación de lenguaje natural con la API de Claude.
// Sin ANTHROPIC_API_KEY el bot sigue funcionando solo con palabras clave.

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

export const claudeDisponible = Boolean(API_KEY);

const SYSTEM = `Sos el cerebro de un bot de lista de compras que vive en un grupo de WhatsApp de una familia.
El grupo es EXCLUSIVO para la lista de compras, así que casi todo lo que se escribe son cosas para comprar.

Recibís un mensaje y devolvés SOLO un JSON, sin texto adicional:
{"accion":"agregar|listar|comprado|borrar|vaciar|ninguna","items":["..."]}

Acciones:
- "agregar": quieren sumar cosas. Incluye mensajes que son SOLO nombres de productos.
  "leche" → {"accion":"agregar","items":["leche"]}
  "falta papel higiénico y azúcar" → {"accion":"agregar","items":["papel higiénico","azúcar"]}
  "comprar 2 kg de tomate" → {"accion":"agregar","items":["tomate"]}
- "comprado": ya lo compraron.
  "ya tengo la leche" → {"accion":"comprado","items":["leche"]}
  "listo el pan" → {"accion":"comprado","items":["pan"]}
- "borrar": sacar de la lista SIN haberlo comprado.
  "sacá el pan de la lista" → {"accion":"borrar","items":["pan"]}
- "listar": quieren ver la lista.
  "qué falta", "pasame la lista", "qué hay que comprar" → {"accion":"listar","items":[]}
- "vaciar": limpiar toda la lista.
- "ninguna": conversación que NO es sobre la lista. Usala para saludos, agradecimientos,
  confirmaciones y charla suelta.
  "gracias", "dale", "ok", "buenísimo", "ahí voy", "jajaja" → {"accion":"ninguna","items":[]}

Reglas para los items:
- Normalizá a minúscula y singular cuando sea natural ("tomates" → "tomate").
- Sacá cantidades y unidades salvo que distingan el producto ("leche descremada" se mantiene).
- Un mensaje puede traer varios items separados por comas, "y" o saltos de línea.

Ante la duda entre "agregar" y "ninguna": si el mensaje nombra algo comprable, es "agregar".
Devolvé ÚNICAMENTE el JSON.`;

export async function interpretar(mensaje) {
  if (!API_KEY) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: "user", content: mensaje }],
      }),
    });

    if (!res.ok) {
      console.error(`⚠️  Claude respondió ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const texto = data?.content?.[0]?.text?.trim() || "";
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const validas = ["agregar", "listar", "comprado", "borrar", "vaciar", "ninguna"];
    if (!validas.includes(parsed.accion)) return null;
    parsed.items = Array.isArray(parsed.items) ? parsed.items.filter(Boolean) : [];
    return parsed;
  } catch (e) {
    console.error("⚠️  Error llamando a Claude:", e?.message || e);
    return null;
  }
}
