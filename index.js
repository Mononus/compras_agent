// index.js — Bot de lista de compras para un grupo de WhatsApp.
// Usa Baileys (protocolo de WhatsApp Web) para poder funcionar en grupos.

import "dotenv/config";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { readFileSync } from "fs";
import qrcode from "qrcode-terminal";
import pino from "pino";

import * as store from "./store.js";
import { interpretar, claudeDisponible } from "./llm.js";

// Módulo de agenda familiar. Vive en calendario/ y atiende OTRO grupo.
// Si le falta configuración se deshabilita solo: nunca rompe la lista de compras.
import { crearAgente } from "./calendario/agent.js";
import * as agenda from "./calendario/scheduler.js";
import { calendarioHabilitado, faltantes } from "./calendario/config.js";

// Módulo de gastos mensuales. Vive en gastos/ y atiende un TERCER grupo.
// Misma regla que la agenda: si le falta configuración se apaga solo.
import { crearAgente as crearAgenteGastos } from "./gastos/agent.js";
import * as gastosCron from "./gastos/scheduler.js";
import { gastosHabilitado, faltantes as faltantesGastos } from "./gastos/config.js";

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
// Grupo de la agenda familiar. Vacío = módulo apagado.
const TARGET_GROUP_FAMILIA = process.env.TARGET_GROUP_FAMILIA || "";
// Grupo de los gastos del mes. Vacío = módulo apagado.
const TARGET_GROUP_GASTOS = process.env.TARGET_GROUP_GASTOS || "";
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
    m.ephemeralMessage?.message?.imageMessage?.caption ||
    m.viewOnceMessageV2?.message?.imageMessage?.caption ||
    ""
  );
}

// Devuelve el imageMessage si el mensaje es (o envuelve) una foto. Contempla
// mensajes efímeros y "ver una vez", que anidan el contenido real.
function imagenDelMensaje(msg) {
  const m = msg.message || {};
  return (
    m.imageMessage ||
    m.ephemeralMessage?.message?.imageMessage ||
    m.viewOnceMessage?.message?.imageMessage ||
    m.viewOnceMessageV2?.message?.imageMessage ||
    null
  );
}

// Igual que imagenDelMensaje pero incluye documentos (los comprobantes suelen
// venir en PDF). Devuelve { nodo, mime, nombre } o null.
function archivoDelMensaje(msg) {
  const m = msg.message || {};
  const interno = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || {};
  const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage || interno.documentMessage;
  if (doc) {
    return { mime: doc.mimetype || "application/pdf", nombre: doc.fileName || "" };
  }
  const img = imagenDelMensaje(msg);
  if (img) return { mime: img.mimetype || "image/jpeg", nombre: "" };
  return null;
}

// ID del mensaje al que se está respondiendo (para asociar un comprobante al
// recordatorio que lo pidió).
function citadoDelMensaje(msg) {
  const m = msg.message || {};
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.ephemeralMessage?.message?.extendedTextMessage?.contextInfo;
  return ctx?.stanzaId || null;
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

  // ---------- Agenda familiar ----------
  // El agente no sabe de Baileys: le pasamos un adaptador. Ojo con
  // recordarPropio() en enviarTexto — sin eso el bot leería sus propios
  // resúmenes como si fueran comandos.
  const agenteCalendario = calendarioHabilitado
    ? crearAgente({
        wa: {
          async enviarTexto(jid, texto) {
            const enviado = await sock.sendMessage(jid, { text: texto });
            recordarPropio(enviado?.key?.id);
            return enviado;
          },
          async reaccionar(key, emoji) {
            await sock.sendMessage(key.remoteJid, { react: { text: emoji, key } });
          },
        },
        grupoJid: TARGET_GROUP_FAMILIA,
      })
    : null;

  // ---------- Gastos del mes ----------
  // enviarTexto devuelve el mensaje enviado a propósito: el agente guarda el id
  // de cada recordatorio para reconocer el comprobante que le responden.
  const agenteGastos = gastosHabilitado
    ? crearAgenteGastos({
        wa: {
          async enviarTexto(jid, texto) {
            const enviado = await sock.sendMessage(jid, { text: texto });
            recordarPropio(enviado?.key?.id);
            return enviado;
          },
          async reaccionar(key, emoji) {
            await sock.sendMessage(key.remoteJid, { react: { text: emoji, key } });
          },
          async enviarArchivo(jid, { ruta, mime, nombre, caption }) {
            const enviado = await sock.sendMessage(jid, {
              document: readFileSync(ruta),
              mimetype: mime || "application/octet-stream",
              fileName: nombre || "comprobante",
              caption,
            });
            recordarPropio(enviado?.key?.id);
            return enviado;
          },
        },
        grupoJid: TARGET_GROUP_GASTOS,
      })
    : null;

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

      // Los cron de la agenda se paran junto con la conexión; iniciar() los
      // vuelve a crear al reconectar. Es idempotente, no duplica envíos.
      agenda.detener();
      gastosCron.detener();

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
      } else if (process.env.LISTAR_GRUPOS === "true") {
        // Para averiguar el JID de un grupo nuevo sin tener que vaciar
        // TARGET_GROUP (que haría al bot responder en los ~200 grupos).
        setTimeout(listarGrupos, 5000);
      }

      if (agenteCalendario) {
        console.log(`📅 Agenda familiar: activa en ${TARGET_GROUP_FAMILIA}`);
        // En try/catch a propósito: una TZ_AGENDA mal escrita hace que
        // cron.schedule tire, y una excepción acá adentro llegaría a
        // uncaughtException y mataría el bot de compras.
        try {
          agenda.iniciar(agenteCalendario);
        } catch (e) {
          console.error("❌ No pude programar los resúmenes:", e?.message || e);
          console.error("   El resto de la agenda sigue funcionando. Revisá TZ_AGENDA y los CRON_*.");
        }
      } else {
        console.log(`📅 Agenda familiar: apagada (falta ${faltantes().join(", ")})`);
      }

      if (agenteGastos) {
        console.log(`💸 Gastos del mes: activo en ${TARGET_GROUP_GASTOS}`);
        // Mismo cuidado que con la agenda: un cron mal escrito no puede
        // llevarse puesto el resto del bot.
        try {
          gastosCron.iniciar(agenteGastos);
        } catch (e) {
          console.error("❌ No pude programar los recordatorios de gastos:", e?.message || e);
          console.error("   Los comandos del grupo siguen funcionando. Revisá TZ_GASTOS y CRON_GASTOS.");
        }
      } else {
        console.log(`💸 Gastos del mes: apagado (falta ${faltantesGastos().join(", ")})`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const esFamilia = Boolean(agenteCalendario) && jid === TARGET_GROUP_FAMILIA;
      const esGastos = Boolean(agenteGastos) && jid === TARGET_GROUP_GASTOS;

      // Solo los grupos objetivo. Ojo: los grupos de agenda y gastos tienen que
      // pasar este filtro aunque no sean TARGET_GROUP.
      if (!esFamilia && !esGastos && TARGET_GROUP && jid !== TARGET_GROUP) continue;

      // Nunca procesamos nuestras propias respuestas (protección anti-loop).
      if (idsPropios.has(msg.key.id)) continue;

      const texto = textoDelMensaje(msg);
      // En gastos un comprobante puede venir sin una sola letra de epígrafe.
      const adjunto = esGastos ? archivoDelMensaje(msg) : null;
      if (!texto && !adjunto) continue;

      // Descartamos historial viejo, no comandos en vivo.
      const ts = timestampDe(msg);
      if (ts && Math.floor(Date.now() / 1000) - ts > MAX_ANTIGUEDAD_SEG) continue;

      const autor = (msg.key.participant || jid).split("@")[0];

      // ---- Rama gastos: el módulo se encarga y responde por su cuenta ----
      if (esGastos) {
        // Descargador lazy: el agente solo baja el archivo si decidió que es un
        // comprobante. Una foto suelta en el grupo no se descarga.
        const archivo = adjunto
          ? {
              mime: adjunto.mime,
              nombre: adjunto.nombre,
              descargar: async () => {
                const buffer = await downloadMediaMessage(
                  msg,
                  "buffer",
                  {},
                  { logger, reuploadRequest: sock.updateMediaMessage }
                );
                return buffer.toString("base64");
              },
            }
          : null;

        try {
          const actuo = await agenteGastos.manejarMensaje({
            texto,
            autor: msg.pushName || autor,
            key: msg.key,
            archivo,
            citadoId: citadoDelMensaje(msg),
          });
          if (actuo) console.log(`💸 "${(texto || "[archivo]").slice(0, 50)}" (de ${autor})`);
        } catch (err) {
          console.error(`❌ Error de gastos:`, err?.message || err);
        }
        continue;
      }

      // ---- Rama agenda: el módulo se encarga y responde por su cuenta ----
      if (esFamilia) {
        // Descargador lazy: solo se ejecuta si el agente decide leer la imagen
        // (epígrafe con palabra clave). Así una foto suelta no se baja.
        const im = imagenDelMensaje(msg);
        const imagen = im
          ? {
              mime: im.mimetype || "image/jpeg",
              descargar: async () => {
                const buffer = await downloadMediaMessage(
                  msg,
                  "buffer",
                  {},
                  { logger, reuploadRequest: sock.updateMediaMessage }
                );
                return buffer.toString("base64");
              },
            }
          : null;

        try {
          const actuo = await agenteCalendario.manejarMensaje({
            texto,
            autor: msg.pushName || autor,
            key: msg.key,
            imagen,
          });
          if (actuo) console.log(`📅 "${(texto || "[imagen]").slice(0, 50)}" (de ${autor})`);
        } catch (err) {
          // manejarMensaje ya captura lo suyo; esto es el cinturón de seguridad
          // para que un error de agenda jamás tumbe el bot de compras.
          console.error(`❌ Error de agenda:`, err?.message || err);
        }
        continue;
      }

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
