// calendario/config.js — configuración del módulo de agenda familiar.
//
// REGLA DE ORO: este archivo NUNCA tira una excepción al importarse.
// Si falta configuración de Google, el módulo queda deshabilitado y el bot de
// compras arranca igual. Un error acá no puede tumbar la lista de compras.

const env = (n, def = "") => (process.env[n] || def).trim();

export const config = {
  grupoJid: env("TARGET_GROUP_FAMILIA"),

  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_REFRESH_TOKEN"),
    calendarId: env("GOOGLE_CALENDAR_ID"),
  },

  apiKey: env("ANTHROPIC_API_KEY"),
  modelo: env("CLAUDE_MODEL", "claude-haiku-4-5-20251001"),

  tz: env("TZ_AGENDA", "America/Argentina/Buenos_Aires"),
  largoMaximo: Number(env("LARGO_MAXIMO_AGENDA", "300")),
  cronDiario: env("CRON_DIARIO", "30 7 * * *"),
  cronSemanal: env("CRON_SEMANAL", "0 20 * * 0"),
  resumenesActivos: env("RESUMENES") !== "off",
};

export const claudeDisponible = Boolean(config.apiKey);

/** Qué falta para poder habilitar el módulo. Array vacío = todo listo. */
export function faltantes() {
  const f = [];
  if (!config.grupoJid) f.push("TARGET_GROUP_FAMILIA");
  if (!config.google.clientId) f.push("GOOGLE_CLIENT_ID");
  if (!config.google.clientSecret) f.push("GOOGLE_CLIENT_SECRET");
  if (!config.google.refreshToken) f.push("GOOGLE_REFRESH_TOKEN");
  if (!config.google.calendarId) f.push("GOOGLE_CALENDAR_ID");
  return f;
}

export const calendarioHabilitado = faltantes().length === 0;
