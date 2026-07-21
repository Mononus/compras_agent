// calendario/agent.js — núcleo del agente de agenda.
//
// No importa Baileys: recibe un adaptador `wa` con dos métodos, así el mismo
// núcleo sirve montado en este bot o corriendo solo el día que migres a un
// número dedicado.
//
//   wa.enviarTexto(jid, texto)  -> Promise
//   wa.reaccionar(key, emoji)   -> Promise   (opcional)

import * as calendar from "./calendar.js";
import { interpretar } from "./llm.js";
import { hoyYmd, sumarDias, etiquetaDia, ymdDeEvento, horaDeEvento } from "./fechas.js";
import * as formato from "./formato.js";
import { config, claudeDisponible } from "./config.js";

// --- Palabras clave: resuelven lo común sin gastar API -------------------
const RE_HOY = /^\s*(qu[eé] hay hoy|agenda de hoy|hoy|agenda)\s*[?!.]*\s*$/i;
const RE_MANANA = /^\s*(qu[eé] hay ma[ñn]ana|agenda de ma[ñn]ana|ma[ñn]ana)\s*[?!.]*\s*$/i;
const RE_SEMANA = /^\s*(semana|la semana|agenda de la semana|c[oó]mo viene la semana)\s*[?!.]*\s*$/i;
const RE_AYUDA = /^\s*(ayuda|help|comandos)\s*[?!.]*\s*$/i;
const RE_NUMERO = /^\s*([1-9])\s*$/;

// Prefiltro barato. A diferencia del grupo de compras (que es dedicado), el
// grupo familiar tiene mucha charla suelta: si el mensaje no huele a agenda,
// ni llamamos a la API.
const PISTAS =
  /\b(agend|calendario|turno|cita|reuni[oó]n|cumple|evento|recordar|recordatorio|anotar|anot[aá]|acto|m[eé]dico|dentista|pediatra|colegio|escuela|hoy|ma[ñn]ana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|semana|finde|feriado|vacacion|horario)\b|\d{1,2}\s*(hs|hrs|h\b|:\d{2})/i;

export function crearAgente({ wa, grupoJid = config.grupoJid }) {
  // Candidatos a borrar esperando que alguien conteste con un número. TTL 5 min.
  let pendiente = null;

  const responder = (texto) => wa.enviarTexto(grupoJid, texto);

  async function reaccionar(key, emoji) {
    if (!key || !wa.reaccionar) return;
    try {
      await wa.reaccionar(key, emoji);
    } catch (e) {
      console.error("⚠️  No pude reaccionar (agenda):", e?.message || e);
    }
  }

  /**
   * Punto de entrada. Devuelve true si el agente actuó.
   * Nunca propaga excepciones: los errores los avisa en el grupo y los loguea.
   */
  async function manejarMensaje({ texto, autor, key }) {
    const t = (texto || "").trim();
    if (!t || t.length > config.largoMaximo) return false;

    try {
      // 1) ¿Está contestando a un "¿cuál borro?"
      const num = t.match(RE_NUMERO);
      if (num && pendiente && Date.now() - pendiente.ts < 5 * 60 * 1000) {
        const ev = pendiente.eventos[Number(num[1]) - 1];
        pendiente = null;
        if (!ev) {
          await responder("Ese número no está en la lista.");
          return true;
        }
        await calendar.borrar(ev.id);
        await reaccionar(key, "🗑️");
        await responder(`🗑️ Borrado: *${ev.summary}*`);
        return true;
      }

      // 2) Palabras clave (gratis)
      if (RE_AYUDA.test(t)) {
        await responder(formato.AYUDA);
        return true;
      }
      if (RE_HOY.test(t)) {
        await mostrarDia(hoyYmd());
        return true;
      }
      if (RE_MANANA.test(t)) {
        await mostrarDia(sumarDias(hoyYmd(), 1));
        return true;
      }
      if (RE_SEMANA.test(t)) {
        await mostrarSemana(hoyYmd());
        return true;
      }

      // 3) Prefiltro + Claude
      if (!claudeDisponible || !PISTAS.test(t)) return false;

      const intencion = await interpretar(t, { autor });
      if (!intencion) return false;
      return await ejecutar(intencion, { autor, key });
    } catch (e) {
      console.error(`❌ Error de agenda con "${t.slice(0, 40)}":`, e?.message || e);
      await responder(`⚠️ Se me complicó con eso: ${mensajeAmigable(e)}`).catch(() => {});
      return true;
    }
  }

  async function ejecutar(intencion, { autor, key } = {}) {
    switch (intencion.accion) {
      case "crear": {
        if (!intencion.titulo || !intencion.fecha) return false;
        const ev = await calendar.crear({ ...intencion, creadoPor: autor || null });
        await reaccionar(key, "✅");
        await responder(formato.confirmacionCreado(ev));
        return true;
      }

      case "ver_dia":
        await mostrarDia(intencion.fecha || hoyYmd());
        return true;

      case "ver_semana":
        await mostrarSemana(intencion.desde || hoyYmd());
        return true;

      case "buscar": {
        const evs = await calendar.buscar(intencion.texto || "");
        await responder(
          evs.length
            ? `🔎 Resultados para "${intencion.texto}":\n\n` +
                formato
                  .ordenarCronologico(evs)
                  .map((e) => {
                    const h = horaDeEvento(e.start);
                    return `• ${e.summary} — ${etiquetaDia(ymdDeEvento(e.start))}${h ? ` ${h}` : ""}`;
                  })
                  .join("\n")
            : `No encontré nada con "${intencion.texto}".`
        );
        return true;
      }

      case "borrar": {
        const evs = await calendar.buscar(intencion.texto || "");
        if (!evs.length) {
          await responder(`No encontré ningún evento con "${intencion.texto}".`);
          return true;
        }
        if (evs.length === 1) {
          await calendar.borrar(evs[0].id);
          await reaccionar(key, "🗑️");
          await responder(`🗑️ Borrado: *${evs[0].summary}*`);
          return true;
        }
        const cortos = formato.ordenarCronologico(evs).slice(0, 9);
        pendiente = { eventos: cortos, ts: Date.now() };
        await responder(
          `Encontré varios. ¿Cuál borro? Respondé con el número:\n\n${formato.listaNumerada(cortos)}`
        );
        return true;
      }

      case "ayuda":
        await responder(formato.AYUDA);
        return true;

      default:
        return false;
    }
  }

  async function mostrarDia(ymd) {
    await responder(formato.resumenDia(ymd, await calendar.eventosDelDia(ymd)));
  }

  async function mostrarSemana(desde) {
    await responder(formato.resumenSemana(desde, await calendar.eventosDeRango(desde, 7)));
  }

  // --- Resúmenes automáticos (los dispara scheduler.js) -----------------

  async function resumenDiario() {
    const hoy = hoyYmd();
    const evs = await calendar.eventosDelDia(hoy);
    // Día vacío = silencio. Nadie quiere un "no hay nada" cada mañana.
    if (!evs.length) return false;
    await responder(
      formato.resumenDia(hoy, evs, { encabezado: `☀️ *Buen día. Hoy, ${etiquetaDia(hoy)}:*` })
    );
    return true;
  }

  async function resumenSemanal() {
    // Corre el domingo 20hs: la "semana que viene" arranca mañana.
    const manana = sumarDias(hoyYmd(), 1);
    const evs = await calendar.eventosDeRango(manana, 7);
    await responder(
      formato.resumenSemana(manana, evs, {
        encabezado:
          `🗓️ *La semana que viene* (${etiquetaDia(manana, { conDiaSemana: false })} al ` +
          `${etiquetaDia(sumarDias(manana, 6), { conDiaSemana: false })})`,
      })
    );
    return true;
  }

  return { grupoJid, manejarMensaje, ejecutar, resumenDiario, resumenSemanal, mostrarDia, mostrarSemana };
}

function mensajeAmigable(e) {
  const m = e?.message || String(e);
  if (/invalid_grant/i.test(m)) return "se venció el acceso a Google Calendar, hay que re-autorizar";
  if (/notFound/i.test(m)) return "no encuentro el calendario configurado";
  if (/forbidden|insufficient/i.test(m)) return "no tengo permiso de escritura en el calendario";
  return m.slice(0, 120);
}
