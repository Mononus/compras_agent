// index.js — Bot de lista de compras para un grupo de WhatsApp.
// Usa Baileys (protocolo de WhatsApp Web) para poder funcionar en grupos.

import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";

import * as store from "./store.js";
import { interpretar, claudeDisponible } from "./llm.js";

// libsignal escribe ruido de sesiones con console.log directo (no pasa por pino).
// Lo filtramos para poder leer la consola. Con LOG_BAILEYS=warn se muestra todo.
if (!process.env.LOG_BAILEYS) {
  const RUIDO = [
    "Closing open session",
    "Closing session",
    "SessionEntry",
    "Invalid PreKey",
    "Key used already",
    "Session error",
  ];
  const logOriginal = console.log;
  const warnOriginal = console.warn;
  const esRuido = (args) =>
    typeof args[0] === "string" && RUIDO.some((r) => args[0].includes(r));
  console.log = (...args) => {
    if (!esRuido(args)) logOriginal(...args);
  };
  console.warn = (...args) => {
    if (!esRuido(args)) warnOriginal(...args);
  };
}

const PREFIX = process.env.BOT_PREFIX || "!";
const TARGET_GROUP = process.env.TARGET_GROUP || ""; // JID del grupo, ej "12036...@g.us"
// Baileys es muy ruidoso: timeouts de init queries, fallos de descifrado de
// mensajes viejos, etc., casi todo inofensivo. Por defecto lo silenciamos.
// Para ver su salida interna: LOG_BAILEYS=warn npm start
const logger = pino({ level: process.env.LOG_BAILEYS || "silent" });

// ---------- Formato de respuestas ----------

function formatearLista(items) {
  if (items.length === 0) return "🛒 La lista está vacía. ¡Todo comprado!";
  const lineas = items.map((i, n) => `${n + 1}. ${i.texto}`);
  return `🛒 *Lista de compras* (${items.length})\n\n${lineas.join("\n")}`;
}

const AYUDA = `🛒 *Bot de lista de compras*

Comandos (empezá con \`${PREFIX}\`):
• \`${PREFIX}agregar leche, pan, huevos\` — suma cosas
• \`${PREFIX}lista\` — muestra lo que falta
• \`${PREFIX}compre leche\` — marca como comprado
• \`${PREFIX}borrar pan\` — saca algo sin comprarlo
• \`${PREFIX}vaciar\` — limpia toda la lista
• \`${PREFIX}ayuda\` — muestra esto${
  claudeDisponible
    ? `\n\nTambién entiendo lenguaje natural: \`${PREFIX} falta papel y comprá yogur\``
    : ""
}`;

// ---------- Parseo de comandos explícitos ----------

function separarItems(texto) {
  return texto
    .split(/,|\by\b|\n/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Devuelve el texto de respuesta o null si no reconoce el comando.
async function procesar(textoCrudo, autor) {
  const texto = textoCrudo.trim();
  if (!texto.startsWith(PREFIX)) return null;

  const sinPrefix = texto.slice(PREFIX.length).trim();
  if (!sinPrefix) return AYUDA;

  const [comandoRaw, ...resto] = sinPrefix.split(/\s+/);
  const comando = comandoRaw.toLowerCase();
  const args = resto.join(" ").trim();

  // Comandos explícitos (rápidos, sin llamar a la API)
  if (["ayuda", "help", "?"].includes(comando)) return AYUDA;

  if (["lista", "l", "ver", "que", "qué"].includes(comando)) {
    return formatearLista(store.pendientes());
  }

  if (["agregar", "add", "sumar", "sumá", "suma", "anotar", "anota", "+"].includes(comando)) {
    const items = separarItems(args);
    if (items.length === 0) return `Decime qué agregar, ej: \`${PREFIX}agregar leche, pan\``;
    const nuevos = store.agregar(items, autor);
    if (nuevos.length === 0) return "Eso ya estaba en la lista 👍";
    return `✅ Agregado: ${nuevos.map((i) => i.texto).join(", ")}\n\n${formatearLista(store.pendientes())}`;
  }

  if (["compre", "compré", "listo", "ok", "hecho", "-"].includes(comando)) {
    const items = separarItems(args);
    if (items.length === 0) return `Decime qué compraste, ej: \`${PREFIX}compre leche\``;
    const afectados = store.marcarComprado(items);
    if (afectados.length === 0) return "No encontré eso en la lista 🤔";
    return `🎉 Comprado: ${afectados.map((i) => i.texto).join(", ")}\n\n${formatearLista(store.pendientes())}`;
  }

  if (["borrar", "quitar", "sacar", "sacá", "saca", "eliminar"].includes(comando)) {
    const items = separarItems(args);
    if (items.length === 0) return `Decime qué borrar, ej: \`${PREFIX}borrar pan\``;
    const borrados = store.borrar(items);
    if (borrados.length === 0) return "No encontré eso en la lista 🤔";
    return `🗑️ Borrado: ${borrados.map((i) => i.texto).join(", ")}\n\n${formatearLista(store.pendientes())}`;
  }

  if (["vaciar", "limpiar", "reset"].includes(comando)) {
    store.vaciar(false);
    return "🧹 Lista vaciada.";
  }

  // Si no matcheó ningún comando explícito, probamos con Claude (si está)
  if (claudeDisponible) {
    const intent = await interpretar(sinPrefix);
    if (intent && intent.accion !== "ninguna") {
      switch (intent.accion) {
        case "agregar": {
          const nuevos = store.agregar(intent.items, autor);
          if (nuevos.length === 0) return "Eso ya estaba en la lista 👍";
          return `✅ Agregado: ${nuevos.map((i) => i.texto).join(", ")}\n\n${formatearLista(store.pendientes())}`;
        }
        case "comprado": {
          const afectados = store.marcarComprado(intent.items);
          if (afectados.length === 0) return "No encontré eso en la lista 🤔";
          return `🎉 Comprado: ${afectados.map((i) => i.texto).join(", ")}\n\n${formatearLista(store.pendientes())}`;
        }
        case "borrar": {
          const borrados = store.borrar(intent.items);
          if (borrados.length === 0) return "No encontré eso en la lista 🤔";
          return `🗑️ Borrado: ${borrados.map((i) => i.texto).join(", ")}\n\n${formatearLista(store.pendientes())}`;
        }
        case "listar":
          return formatearLista(store.pendientes());
        case "vaciar":
          store.vaciar(false);
          return "🧹 Lista vaciada.";
      }
    }
  }

  return `No entendí. Escribí \`${PREFIX}ayuda\` para ver los comandos.`;
}

// ---------- Extraer texto de un mensaje de WhatsApp ----------

// Antigüedad máxima de un mensaje para que el bot lo procese (segundos).
// Evita que la sincronización de historial re-ejecute comandos viejos al reconectar.
const MAX_ANTIGUEDAD_SEG = 90;

// El timestamp puede venir como number, string o Long de protobuf.
function timestampDe(msg) {
  const t = msg.messageTimestamp;
  if (!t) return 0;
  if (typeof t === "number") return t;
  if (typeof t === "string") return parseInt(t, 10) || 0;
  if (typeof t.toNumber === "function") return t.toNumber();
  if (typeof t.low === "number") return t.low;
  return 0;
}

function textoDelMensaje(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  );
}

// ---------- Conexión a WhatsApp ----------

// Evita que se apilen sockets superpuestos si llegan varios "close" seguidos.
let reconectando = false;
let intentosReconexion = 0;

function programarReconexion(motivo) {
  if (reconectando) {
    console.log(`   (ya hay una reconexión en curso, se ignora: ${motivo})`);
    return;
  }
  reconectando = true;
  intentosReconexion++;
  // Backoff: 3s, 6s, 12s, 24s… con techo de 60s.
  const espera = Math.min(3000 * 2 ** (intentosReconexion - 1), 60000);
  console.log(`🔄 Reconectando en ${espera / 1000}s (intento ${intentosReconexion}) — ${motivo}`);
  setTimeout(() => {
    reconectando = false;
    iniciar().catch((e) => {
      console.error("Error al reconectar:", e?.message || e);
      programarReconexion("falló el intento anterior");
    });
  }, espera);
}

async function iniciar() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // Lista todos los grupos donde está el bot, con su JID.
  // Sirve para configurar TARGET_GROUP sin tener que esperar un mensaje.
  async function listarGrupos() {
    // Las "init queries" de Baileys a veces tardan; reintentamos un par de veces.
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const grupos = await sock.groupFetchAllParticipating();
        const entradas = Object.values(grupos);
        if (entradas.length === 0) {
          console.log(
            "\n📭 El bot no está en ningún grupo todavía.\n" +
              "   Agregá este número al grupo de compras y reiniciá.\n"
          );
          return;
        }
        console.log("\n📋 Grupos donde está el bot:\n");
        for (const g of entradas) {
          console.log(`   ${g.subject}`);
          console.log(`   TARGET_GROUP=${g.id}\n`);
        }
        console.log(
          "👉 Copiá la línea TARGET_GROUP= del grupo que quieras al archivo .env y reiniciá.\n"
        );
        return;
      } catch (err) {
        if (intento === 3) {
          console.log(
            "\n⚠️  No pude listar los grupos (WhatsApp tardó en responder).\n" +
              "   Alternativa: que alguien MÁS (no el número del bot) escriba en el grupo\n" +
              "   y el JID va a aparecer acá abajo.\n"
          );
        } else {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\nEscaneá este QR con WhatsApp (Ajustes > Dispositivos vinculados):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        console.log(
          "\n🚪 La sesión fue cerrada desde el celular.\n" +
            "   Borrá la carpeta auth/ y volvé a escanear el QR:\n" +
            "   rm -rf auth && npm start\n"
        );
        process.exit(1);
      }

      if (code === DisconnectReason.connectionReplaced) {
        console.log(
          "\n⛔ OTRA INSTANCIA DEL BOT TOMÓ LA SESIÓN.\n" +
            "   Solo puede correr una a la vez con las mismas credenciales.\n" +
            "   Revisá si quedó el servicio de systemd corriendo:\n" +
            "     sudo systemctl status lista-compras-bot\n" +
            "   Este proceso se cierra para no pelear por la sesión.\n"
        );
        process.exit(1);
      }

      programarReconexion(`conexión cerrada (código ${code})`);
    } else if (connection === "open") {
      intentosReconexion = 0; // reset del backoff
      console.log("✅ Conectado a WhatsApp.");
      if (!TARGET_GROUP) {
        console.log(
          "⚠️  TARGET_GROUP no está configurado: el bot responderá en cualquier chat."
        );
        // Esperamos unos segundos a que WhatsApp termine de sincronizar
        setTimeout(listarGrupos, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // DIAGNÓSTICO: mostramos todo lo que llega, antes de cualquier filtro.
    console.log(`\n📥 messages.upsert — type="${type}", ${messages.length} mensaje(s)`);

    for (const msg of messages) {
      const jid = msg.key.remoteJid || "(sin jid)";
      const texto = textoDelMensaje(msg);
      console.log(
        `   jid="${jid}" fromMe=${msg.key.fromMe} ` +
          `tipo=${Object.keys(msg.message || {}).join(",") || "(vacío)"} ` +
          `texto="${texto.slice(0, 60)}"`
      );
      if (TARGET_GROUP) {
        console.log(
          `   ¿coincide con TARGET_GROUP? ${jid === TARGET_GROUP ? "SÍ ✅" : "NO ❌"}` +
            (jid !== TARGET_GROUP ? `  (esperado: "${TARGET_GROUP}")` : "")
        );
      }
    }

    // "notify" = mensaje entrante de otro.
    // "append" = mensaje enviado desde el propio celu vinculado (y sync de historial).
    if (type !== "notify" && type !== "append") {
      console.log(`   ↳ ignorado: type "${type}" no procesable`);
      return;
    }

    for (const msg of messages) {
      if (!msg.message) continue;
      // Nota: NO descartamos fromMe. El bot está vinculado al número personal,
      // así que los mensajes propios también tienen que poder dar órdenes.
      // No hay riesgo de loop: las respuestas del bot nunca empiezan con el prefijo.
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const esGrupo = jid.endsWith("@g.us");
      // Log del JID de grupo para facilitar la configuración inicial
      if (esGrupo && !TARGET_GROUP) {
        console.log(`📍 Mensaje en grupo con JID: ${jid}`);
      }

      // Si hay grupo objetivo, ignoramos todo lo demás
      if (TARGET_GROUP && jid !== TARGET_GROUP) continue;

      const texto = textoDelMensaje(msg);
      if (!texto) continue;

      // Descartamos mensajes viejos (sync de historial), no comandos en vivo.
      const ts = timestampDe(msg);
      const antiguedad = ts ? Math.floor(Date.now() / 1000) - ts : 0;
      if (antiguedad > MAX_ANTIGUEDAD_SEG) {
        console.log(`   ↳ ignorado: mensaje de hace ${antiguedad}s (sync de historial)`);
        continue;
      }

      const autor = (msg.key.participant || jid).split("@")[0];

      try {
        const respuesta = await procesar(texto, autor);
        console.log(`   ↳ procesar("${texto.slice(0, 40)}") → ${respuesta ? "respuesta generada" : "null (sin prefijo)"}`);
        if (respuesta) {
          await sock.sendMessage(jid, { text: respuesta }, { quoted: msg });
          console.log(`   ↳ ✅ respuesta enviada a ${jid}`);
        }
      } catch (err) {
        console.error("   ↳ ❌ Error procesando/enviando:", err);
      }
    }
  });
}

// Baileys lanza rechazos transitorios (ej. 428 "Connection Closed") desde su
// lógica interna de reconexión. Los logueamos en vez de dejar morir el proceso.
process.on("unhandledRejection", (e) => {
  const msg = e?.output?.payload?.message || e?.message || e;
  console.error("⚠️  Promesa rechazada sin manejar (se ignora):", msg);
});

// Si algo revienta de forma sincrónica, lo dejamos registrado y salimos limpio.
// systemd (Restart=always) levanta el proceso de nuevo en 10s.
process.on("uncaughtException", (e) => {
  console.error("\n💥 EXCEPCIÓN NO CAPTURADA — el proceso se reinicia:");
  console.error(e?.stack || e);
  process.exit(1);
});

// Deja constancia de cualquier salida, para poder diagnosticar caídas.
process.on("exit", (code) => {
  console.error(`\n🔚 Proceso terminando con código ${code} — ${new Date().toISOString()}`);
});

iniciar().catch((e) => {
  console.error("Fallo al iniciar:", e);
  process.exit(1);
});
