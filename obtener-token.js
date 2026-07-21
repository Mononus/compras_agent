// calendario/obtener-token.js — helper de un solo uso para el OAuth de Google.
//
// Corrélo EN TU MÁQUINA (necesita navegador), NO en la EC2:
//
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node calendario/obtener-token.js
//
// Imprime el GOOGLE_REFRESH_TOKEN y la lista de calendarios con su ID.

import http from "node:http";
import { exec } from "node:child_process";
import { google } from "googleapis";

const PUERTO = 5599;
const REDIRECT = `http://localhost:${PUERTO}/oauth2callback`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Falta GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET.");
  console.error("Uso: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node calendario/obtener-token.js");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: "offline", // imprescindible para recibir refresh_token
  prompt: "consent", // fuerza uno nuevo aunque ya hayas autorizado antes
  scope: ["https://www.googleapis.com/auth/calendar"],
});

const servidor = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) return res.writeHead(404).end();

  const code = new URL(req.url, `http://localhost:${PUERTO}`).searchParams.get("code");
  if (!code) return res.writeHead(400).end("Falta el parámetro code");

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h2>Listo. Volvé a la terminal.</h2>");

    console.log("\n=== Pegá esto en el .env ===\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\n============================\n");

    if (!tokens.refresh_token) {
      console.log(
        "⚠️  No vino refresh_token. Revocá el acceso en\n" +
          "    https://myaccount.google.com/permissions y volvé a correr esto.\n"
      );
    }

    oauth2.setCredentials(tokens);
    const cal = google.calendar({ version: "v3", auth: oauth2 });
    const { data } = await cal.calendarList.list();
    console.log("Calendarios disponibles — copiá el ID del familiar:\n");
    for (const c of data.items || []) {
      console.log(`  ${c.summary}${c.primary ? " (principal)" : ""}`);
      console.log(`  GOOGLE_CALENDAR_ID=${c.id}\n`);
    }
  } catch (e) {
    console.error("Error canjeando el código:", e?.message || e);
    res.writeHead(500).end("Error, mirá la terminal");
  } finally {
    servidor.close();
    setTimeout(() => process.exit(0), 500);
  }
});

servidor.listen(PUERTO, () => {
  console.log(`\nAbrí esta URL en el navegador:\n\n${url}\n`);
  const abrir = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${abrir} "${url}"`, () => {});
});
