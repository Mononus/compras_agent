// calendario/obtener-token.js — helper de un solo uso para el OAuth de Google.
//
// Corrélo EN TU MÁQUINA (necesita navegador), NO en la EC2. Dos formas:
//
//   node calendario/obtener-token.js ~/Downloads/client_secret_xxx.json   ← recomendada
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node calendario/obtener-token.js
//
// La primera es mejor: el secret no queda en el historial del shell.
// Imprime el GOOGLE_REFRESH_TOKEN y la lista de calendarios con su ID.

import http from "node:http";
import fs from "node:fs";
import { exec } from "node:child_process";
import { google } from "googleapis";

const PUERTO = 5599;
// Los clientes tipo "Desktop app" traen registrado http://localhost. Google
// ignora el PUERTO al comparar, pero NO el path: por eso usamos la raíz.
const REDIRECT = `http://localhost:${PUERTO}`;

let clientId = process.env.GOOGLE_CLIENT_ID;
let clientSecret = process.env.GOOGLE_CLIENT_SECRET;

// Si pasaste el JSON que descargaste de Google, lo leemos de ahí.
const archivo = process.argv[2];
if (archivo) {
  try {
    const json = JSON.parse(fs.readFileSync(archivo, "utf8"));
    const cred = json.installed || json.web;
    if (!cred) throw new Error('el JSON no tiene la clave "installed" ni "web"');
    clientId = cred.client_id;
    clientSecret = cred.client_secret;
    if (json.web) {
      console.log(
        "⚠️  Ese cliente es de tipo 'Aplicación web'. Para este flujo conviene\n" +
          "    uno de tipo 'Aplicación de escritorio', o agregá este redirect\n" +
          `    en la consola de Google: ${REDIRECT}\n`
      );
    }
    console.log(`Credenciales leídas de ${archivo}`);
    console.log(`Proyecto: ${cred.project_id || "(sin project_id)"}\n`);
  } catch (e) {
    console.error(`No pude leer las credenciales de "${archivo}": ${e.message}`);
    process.exit(1);
  }
}

if (!clientId || !clientSecret) {
  console.error("Faltan las credenciales de Google.\n");
  console.error("Opción A (recomendada):");
  console.error("  node calendario/obtener-token.js ~/Downloads/client_secret_xxx.json\n");
  console.error("Opción B:");
  console.error("  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node calendario/obtener-token.js");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: "offline", // imprescindible para recibir refresh_token
  prompt: "consent", // fuerza uno nuevo aunque ya hayas autorizado antes
  scope: ["https://www.googleapis.com/auth/calendar"],
});

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname === "/favicon.ico") return res.writeHead(404).end();

  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(`<h2>Google devolvió: ${error}</h2><p>Mirá la terminal.</p>`);
    console.error(`\n✘ Google rechazó la autorización: ${error}`);
    if (error === "access_denied") {
      console.error("  Si la app está en modo Testing, agregá tu mail en 'Usuarios de prueba'.");
    }
    servidor.close();
    return setTimeout(() => process.exit(1), 300);
  }

  const code = url.searchParams.get("code");
  if (!code) return res.writeHead(400).end("Falta el parámetro code");

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h2>Listo. Volvé a la terminal.</h2>");

    // Verificamos que el token tenga EL scope que pedimos. Si abrís otra URL
    // de autorización mientras este servidor escucha, el código que llega
    // puede ser de otro scope y el token sale inservible ("Insufficient
    // Permission" recién al usar la API, mucho después).
    const scopes = (tokens.scope || "").split(" ");
    const sirve = scopes.some((s) => s.startsWith("https://www.googleapis.com/auth/calendar"));

    if (!sirve) {
      console.error("\n✘ El token NO tiene permiso de Calendar.");
      console.error(`  Scopes recibidos: ${tokens.scope || "(ninguno)"}`);
      console.error("  Abrí SOLO la URL que imprime este script y volvé a intentar.\n");
      servidor.close();
      return setTimeout(() => process.exit(1), 300);
    }

    console.log(`\n✔ Scope correcto: ${tokens.scope}`);
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
