// llm.js — parseo opcional en lenguaje natural con la API de Claude.
// Si no hay ANTHROPIC_API_KEY, el bot igual funciona con comandos simples.

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

export const claudeDisponible = Boolean(API_KEY);

// Interpreta un mensaje libre y devuelve una intencion estructurada.
// Retorna: { accion: "agregar"|"listar"|"comprado"|"borrar"|"vaciar"|"ninguna", items: string[] }
export async function interpretar(mensaje) {
  if (!API_KEY) return null;

  const system = `Sos el cerebro de un bot de lista de compras para un grupo familiar de WhatsApp.
Recibis un mensaje y devolves SOLO un JSON con la intencion. Formato:
{"accion":"agregar|listar|comprado|borrar|vaciar|ninguna","items":["..."]}
Reglas:
- "agregar": el usuario quiere sumar cosas a la lista (ej "compra leche y pan", "falta papel", "anota huevos").
- "comprado": el usuario ya compro algo (ej "compre la leche", "ya tengo el pan", "listo los huevos").
- "borrar": quiere sacar algo de la lista sin haberlo comprado (ej "sacá la leche", "borra el pan").
- "listar": pide ver la lista (ej "que falta", "pasame la lista", "que compro").
- "vaciar": quiere limpiar toda la lista.
- "ninguna": el mensaje no tiene que ver con la lista de compras. En ese caso items vacio.
- Normaliza cada item a singular y minuscula, sin cantidades salvo que sean relevantes.
Devolve UNICAMENTE el JSON, sin texto adicional.`;

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
        system,
        messages: [{ role: "user", content: mensaje }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const texto = data?.content?.[0]?.text?.trim() || "";
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.accion) return null;
    parsed.items = Array.isArray(parsed.items) ? parsed.items : [];
    return parsed;
  } catch {
    return null;
  }
}
