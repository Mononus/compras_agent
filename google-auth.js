// calendario/google-auth.js — autenticación con Google Calendar.
//
// Soporta dos modos y elige solo según lo que haya en el .env:
//
// A) SERVICE ACCOUNT (recomendado para el bot)
//    GOOGLE_SERVICE_ACCOUNT_FILE=/home/ubuntu/compras_agent/service-account.json
//    No caduca nunca, no necesita pantalla de consentimiento ni verificación
//    de Google. Requiere compartir el calendario con el email de la cuenta.
//
// B) OAUTH DE USUARIO
//    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//    Ojo: Calendar es un scope "sensible". En modo Testing el refresh token
//    caduca a los 7 días; en producción Google exige verificación del app.
//    Sirve para probar, no lo recomiendo para el servicio.

import fs from "node:fs";
import { google } from "googleapis";
import { config, modoAuth } from "./config.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

let auth = null;

export function obtenerCliente() {
  if (auth) return auth;

  if (modoAuth === "service_account") {
    const ruta = config.google.serviceAccountFile;
    if (!fs.existsSync(ruta)) {
      throw new Error(`No encuentro el archivo de service account en "${ruta}"`);
    }
    const clave = JSON.parse(fs.readFileSync(ruta, "utf8"));
    if (clave.type !== "service_account") {
      throw new Error(
        `El archivo "${ruta}" no es una clave de service account (type="${clave.type}"). ` +
          "¿No será el client_secret de OAuth?"
      );
    }
    auth = new google.auth.JWT({
      email: clave.client_email,
      key: clave.private_key,
      scopes: SCOPES,
    });
    return auth;
  }

  if (modoAuth === "oauth") {
    auth = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      "http://localhost:5599" // solo se usa al canjear el código, no al refrescar
    );
    auth.setCredentials({ refresh_token: config.google.refreshToken });
    auth.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        console.log(
          "📅 Google devolvió un refresh token NUEVO. Guardalo en el .env:\n" +
            `   GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`
        );
      }
    });
    return auth;
  }

  throw new Error(
    "Google Calendar sin configurar: definí GOOGLE_SERVICE_ACCOUNT_FILE " +
      "o las tres variables de OAuth."
  );
}

export function obtenerCalendar() {
  return google.calendar({ version: "v3", auth: obtenerCliente() });
}

/** El email de la service account, para saber con quién compartir el calendario. */
export function emailServiceAccount() {
  if (modoAuth !== "service_account") return null;
  const clave = JSON.parse(fs.readFileSync(config.google.serviceAccountFile, "utf8"));
  return clave.client_email;
}

/** Chequeo de arranque: confirma que las credenciales sirven. */
export async function verificar() {
  try {
    const { data } = await obtenerCalendar().calendars.get({
      calendarId: config.google.calendarId,
    });
    return data.summary || config.google.calendarId;
  } catch (e) {
    // El error típico de service account es "Not Found": el calendario existe
    // pero no fue compartido con ella, así que para Google no existe.
    if (modoAuth === "service_account" && /not found/i.test(e.message)) {
      const mail = emailServiceAccount();
      throw new Error(
        `No veo el calendario. Compartilo con ${mail} ` +
          "(Configuración del calendario → Compartir con determinadas personas → " +
          '"Hacer cambios en los eventos") y esperá un minuto.'
      );
    }
    throw e;
  }
}
