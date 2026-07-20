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
    "Failed to decrypt",
    "Bad MAC",
    "verifyMAC",
    "session_cipher.js",
    "queue_job.js",
    "MessageCounterError",
    "PreKeyError",
  ];
  const logOriginal = console.log;
  const warnOriginal = console.warn;
  const errorOriginal = console.error;

  // El ruido puede venir como string o como Error (stack traces de libsignal).
  const esRuido = (args) => {
    for (const a of args) {
      const s = typeof a === "string" ? a : a?.message || a?.stack || "";
      if (typeof s === "string" && RUIDO.some((r) => s.includes(r))) return true;
    }
    return false;
  };

  console.log = (...args) => {
    if (!esRuido(args)) logOriginal(...args);
  };
  console.warn = (...args) => {
    if (!esRuido(args)) warnOriginal(...args);
  };
  // libsignal usa console.error para el ruido de sesiones. Nuestros mensajes
  // propios (💥, ⚠️, ❌) no matchean los patrones, así que pasan igual.
  console.error = (...args) => {
    if (!esRuido(args)) errorOriginal(...args);
  };
}

const PREFIX = process.env.BOT_PREFIX || "!";
const TARGET_GROUP = process.env.TARGET_GROUP || "";
// Por defecto NO se exige prefijo: el grupo es dedicado a compras.
const REQUIERE_PREFIJO = process.env.REQUIERE_PREFIJO === "true";
// Mensajes más largos que esto no se consideran comandos (evita gastar API).
const LARGO_MAXIMO = 300;
const logger = pino({ level: process.env.LOG_BAILEYS || "silent" });

// ---------- Formato de respuestas ----------

function formatearLista(items) {
  if (items.length === 0) return "🛒 La lista está vacía.";
  const lineas = items.map((i, n) => `${n + 1}. ${i.texto}`);
  return `🛒 *Lista de compras* (${items.length})\n\n${lineas.join("\n")}`;
}

const AYUDA = `🛒 *Bot de lista de compras*

Escribí normalmente y yo me encargo:
• \`leche, pan\` — los agrego a la lista
• \`falta papel higiénico\` — lo agrego
• \`ya compré la leche\` — la marco como comprada
• \`sacá el pan\` — lo quito sin comprarlo
• \`qué falta\` — te muestro la lista
• \`vaciar\` — limpio toda la lista

Cuando agrego o marco algo reacciono con un emoji en vez de escribir, así no lleno el grupo.`;

// ---------- Comandos explícitos (rápidos, sin gastar API) ----------

function separarItems(texto) {
  return texto
    .split(/,|\by\b|\n/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const COMANDOS = {
  ayuda: ["ayuda", "help", "comandos"],
  listar: ["lista", "l", "ver"],
  agregar: ["agregar", "add", "sumar", "sumá", "suma", "anotar", "anota", "+"],
  comprado: ["compre", "compré", "listo", "hecho", "-"],
  borrar: ["borrar", "quitar", "sacar", "sacá", "saca", "eliminar"],
  vaciar: ["vaciar", "limpiar", "reset"],
};

// Resultados posibles:
//   { tipo: "texto", texto }      → responde con un mensaje
//   { tipo: "reaccion", emoji }   → reacciona al mensaje con un emoji
//   null                          → no hace nada
function ejecutar(accion, items, autor) {
  switch (accion) {
    case "ayuda":
      return { tipo: "texto", texto: AYUDA };

    case "listar":
      return { tipo: "texto", texto: formatearLista(store.pendientes()) };

    case "agregar": {
      if (items.length === 0) return null;
      const nuevos = store.agregar(items, autor);
      // Si ya estaba todo, igual confirmamos con un emoji distinto.
      return { tipo: "reaccion", emoji: nuevos.length > 0 ? "✅" : "👍" };
    }

    case "comprado": {
      if (items.length === 0) return null;
      const afectados = store.marcarComprado(items);
      return { tipo: "reaccion", emoji: afectados.length > 0 ? "🎉" : "🤔" };
    }

    case "borrar": {
      if (items.length === 0) return null;
      const borrados = store.borrar(items);
      return { tipo: "reaccion", emoji: borrados.length > 0 ? "🗑️" : "🤔" };
    }

    case "vaciar":
      store.vaciar(false);
      return { tipo: "reaccion", emoji: "🧹" };

    default:
      return null;
  }
}

// Intenta resolver el mensaje con las palabras clave, sin llamar a la API.
function comandoExplicito(texto, autor) {
  const [comandoRaw, ...resto] = texto.split(/\s+/);
  const comando = comandoRaw.toLowerCase().replace(/[¿?¡!.,]/g, "");
  const args = resto.join(" ").trim();

  for (const [accion, alias] of Object.entries(COMANDOS)) {
    if (!alias.includes(comando)) continue;
    // "lista", "vaciar" y "ayuda" no necesitan argumentos.
    if (["ayuda", "listar", "vaciar"].includes(accion)) {
      return ejecutar(accion, [], autor);
    }
    const items = separarItems(args);
    if (items.length === 0) {
      return { tipo: "texto", texto: `Decime qué, ej: \`${comandoRaw} leche, pan\`` };
    }
    return ejecutar(accion, items, autor);
  }
  return undefined; // undefined = no matcheó ningún comando explícito
}

async function procesar(textoCrudo, autor) {
  let texto = (textoCrudo || "").trim();
  if (!texto) return null;

  const tienePrefijo = texto.startsWith(PREFIX);
  if (REQUIERE_PREFIJO && !tienePrefijo) return null;
  if (tienePrefijo) {
    texto = texto.slice(PREFIX.length).trim();
    if (!texto) return { tipo: "texto", texto: AYUDA };
  }

  // 1) Palabras clave: instantáneo y gratis.
  const explicito = comandoExplicito(texto, autor);
  if (explicito !== undefined) return explicito;

  // Mensajes muy largos difícilmente sean comandos: no gastamos API.
  if (texto.length > LARGO_MAXIMO) return null;

  // 2) Claude interpreta el lenguaje natural.
  if (claudeDisponible) {
    const intent = await interpretar(texto);
    if (!intent || intent.accion === "ninguna") return null;
    const accion = intent.accion === "listar" ? "listar" : intent.accion;
    return ejecutar(accion, intent.items || [], autor);
  }

  // Sin Claude y sin comando reconocido: si venía con prefijo avisamos, si no callamos.
  return tienePrefijo
    ? { tipo: "texto", texto: `No entendí. Escribí \`${PREFIX}ayuda\`.` }
    : null;
}

// ---------- Utilidades de mensajes ----------

const MAX_ANTIGUEDAD_SEG = 90;

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

let reconectando = false;
let intentosReconexion = 0;

function programarReconexion(motivo) {
  if (reconectando) return;
  reconectando = true;
  intentosReconexion++;
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

  // IDs de mensajes que enviamos nosotros. Sin prefijo, el bot vería sus propias
  // respuestas como comandos y entraría en loop. Esto lo corta de raíz.
  const idsPropios = new Set();
  function recordarPropio(id) {
    if (!id) return;
    idsPropios.add(id);
    // Evitamos que el Set crezca sin límite.
    if (idsPropios.size > 200) {
      idsPropios.delete(idsPropios.values().next().value);
    }
  }

  async function listarGrupos() {
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const grupos = await sock.groupFetchAllParticipating();
        const entradas = Object.values(grupos);
        if (entradas.length === 0) {
          console.log("\n📭 El bot no está en ningún grupo todavía.\n");
          return;
        }
        console.log("\n📋 Grupos donde está el bot:\n");
        for (const g of entradas) {
          console.log(`   ${g.subject}`);
          console.log(`   TARGET_GROUP=${g.id}\n`);
        }
        return;
      } catch {
        if (intento < 3) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    console.log("\n⚠️  No pude listar los grupos.\n");
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
        console.log("\n🚪 Sesión cerrada desde el celular. Borrá auth/ y re-escaneá el QR.\n");
        process.exit(1);
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.log(
          "\n⛔ Otra instancia tomó la sesión. Solo puede correr una a la vez.\n" +
            "   Revisá: sudo systemctl status lista-compras-bot\n"
        );
        process.exit(1);
      }
      programarReconexion(`conexión cerrada (código ${code})`);
    } else if (connection === "open") {
      intentosReconexion = 0;
      console.log("✅ Conectado a WhatsApp.");
      console.log(
        `   Modo: ${REQUIERE_PREFIJO ? `con prefijo "${PREFIX}"` : "sin prefijo"} | ` +
          `Claude: ${claudeDisponible ? "activo" : "no configurado"}`
      );
      if (!TARGET_GROUP) {
        console.log("⚠️  TARGET_GROUP vacío: el bot responde en cualquier chat.");
        setTimeout(listarGrupos, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Solo el grupo objetivo.
      if (TARGET_GROUP && jid !== TARGET_GROUP) continue;

      // Nunca procesamos nuestras propias respuestas (protección anti-loop).
      if (idsPropios.has(msg.key.id)) continue;

      const texto = textoDelMensaje(msg);
      if (!texto) continue;

      // Descartamos historial viejo, no comandos en vivo.
      const ts = timestampDe(msg);
      if (ts && Math.floor(Date.now() / 1000) - ts > MAX_ANTIGUEDAD_SEG) continue;

      const autor = (msg.key.participant || jid).split("@")[0];

      try {
        const r = await procesar(texto, autor);
        if (!r) continue;

        if (r.tipo === "reaccion") {
          await sock.sendMessage(jid, { react: { text: r.emoji, key: msg.key } });
          console.log(`${r.emoji} "${texto.slice(0, 50)}" (de ${autor})`);
        } else if (r.tipo === "texto") {
          const enviado = await sock.sendMessage(jid, { text: r.texto }, { quoted: msg });
          recordarPropio(enviado?.key?.id);
          console.log(`💬 respondido a "${texto.slice(0, 50)}" (de ${autor})`);
        }
      } catch (err) {
        console.error(`❌ Error con "${texto.slice(0, 40)}":`, err?.message || err);
      }
    }
  });
}

process.on("unhandledRejection", (e) => {
  const msg = e?.output?.payload?.message || e?.message || e;
  console.error("⚠️  Promesa rechazada sin manejar:", msg);
});

process.on("uncaughtException", (e) => {
  console.error("\n💥 EXCEPCIÓN NO CAPTURADA — el proceso se reinicia:");
  console.error(e?.stack || e);
  process.exit(1);
});

process.on("exit", (code) => {
  console.error(`\n🔚 Proceso terminando con código ${code} — ${new Date().toISOString()}`);
});

iniciar().catch((e) => {
  console.error("Fallo al iniciar:", e);
  process.exit(1);
});
