// gastos/config.js — configuración del módulo de gastos mensuales.
//
// MISMA REGLA DE ORO que calendario/config.js: este archivo NUNCA tira una
// excepción al importarse. Sin TARGET_GROUP_GASTOS el módulo queda apagado y
// el resto del bot arranca igual.

const env = (n, def = "") => (process.env[n] || def).trim();
const num = (n, def) => {
  const v = Number(env(n, String(def)));
  return Number.isFinite(v) ? v : def;
};

export const config = {
  grupoJid: env("TARGET_GROUP_GASTOS"),

  archivo: env("GASTOS_FILE", "./gastos.json"),
  comprobantesDir: env("COMPROBANTES_DIR", "./comprobantes"),
  maxComprobanteMb: num("MAX_COMPROBANTE_MB", 20),

  apiKey: env("ANTHROPIC_API_KEY"),
  modelo: env("CLAUDE_MODEL", "claude-haiku-4-5-20251001"),

  tz: env("TZ_GASTOS", env("TZ_AGENDA", "America/Argentina/Buenos_Aires")),
  largoMaximo: num("LARGO_MAXIMO_GASTOS", 300),

  // Un solo cron: cada corrida evalúa TODOS los gastos del mes y decide a quién
  // le toca aviso. No hay un cron por gasto.
  cronDiario: env("CRON_GASTOS", "0 9 * * *"),
  recordatoriosActivos: env("RECORDATORIOS_GASTOS") !== "off",

  // Cuántos días antes del vencimiento sale el primer aviso (por gasto se puede
  // pisar con su propio avisoDias).
  avisoDiasDefault: num("AVISO_DIAS", 3),
  // Vencido y sin pagar: insistir cada N días...
  insistirCada: num("INSISTIR_CADA", 2),
  // ...hasta este tope; después pasa a una insistencia semanal.
  maxInsistencias: num("MAX_INSISTENCIAS", 3),

  // Resumen del mes el día 1. Apagado por defecto: los avisos por gasto ya
  // alcanzan y este suma ruido.
  resumenMensual: env("RESUMEN_MENSUAL") === "on",
  cronMensual: env("CRON_GASTOS_MENSUAL", "0 9 1 * *"),

  moneda: env("MONEDA", "ARS"),
};

export const claudeDisponible = Boolean(config.apiKey);

/** Qué falta para habilitar el módulo. Array vacío = todo listo. */
export function faltantes() {
  const f = [];
  if (!config.grupoJid) f.push("TARGET_GROUP_GASTOS");
  return f;
}

export const gastosHabilitado = faltantes().length === 0;
