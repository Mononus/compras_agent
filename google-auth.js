// calendario/google-auth.js — cliente OAuth2 de Google con refresh token.
//
// El refresh token no vence, salvo dos casos:
//   1. revocás el acceso a mano
//   2. el proyecto sigue en modo "Testing" en la consola de Google → caduca a
//      los 7 días. Hay que PUBLICAR la app (ver calendario/README.md).

import { google } from "googleapis";
import { config } from "./config.js";

let cliente = null;

export function obtenerCliente() {
  if (cliente) return cliente;

  cliente = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    "http://localhost:5599/oauth2callback"
  );
  cliente.setCredentials({ refresh_token: config.google.refreshToken });

  cliente.on("tokens", (tokens) => {
    if (tokens.refresh_token) {
      console.log(
        "📅 Google devolvió un refresh token NUEVO. Guardalo en el .env:\n" +
          `   GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`
      );
    }
  });

  return cliente;
}

export function obtenerCalendar() {
  return google.calendar({ version: "v3", auth: obtenerCliente() });
}

/** Chequeo de arranque: confirma que las credenciales sirven. */
export async function verificar() {
  const { data } = await obtenerCalendar().calendars.get({
    calendarId: config.google.calendarId,
  });
  return data.summary || config.google.calendarId;
}
