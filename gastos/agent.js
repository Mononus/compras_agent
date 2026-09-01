// gastos/agent.js — núcleo del agente de gastos mensuales.
//
// Igual que calendario/agent.js: no importa Baileys. Recibe un adaptador `wa`:
//
//   wa.enviarTexto(jid, texto)                    -> Promise<mensaje enviado>
//   wa.reaccionar(key, emoji)                     -> Promise           (opcional)
//   wa.enviarArchivo(jid, {ruta, mime, nombre, caption}) -> Promise    (opcional)
//
// enviarTexto DEBE devolver el mensaje enviado (con key.id): así recordamos qué
// aviso corresponde a qué gasto y podemos marcar pagado cuando alguien responde
// a ese aviso con el comprobante.

import * as store from "./store.js";
import * as formato from "./formato.js";
import { guardarComprobante, existe, excedeLimite } from "./archivos.js";
import { interpretar, leerComprobante } from "./llm.js";
import { config, claudeDisponible } from "./config.js";
import { hoyYmd, periodoActual, periodoDe, vencimientoYmd, diffDias, sumarMeses } from "./fechas.js";

// --- Palabras clave: resuelven lo común sin gastar API --------------------
const RE_AYUDA = /^\s*(ayuda|help|comandos)\s*[?!.]*\s*$/i;
const RE_ESTADO = /^\s*(gastos|estado|pendientes|qu[eé] falta( pagar)?|c[oó]mo venimos)\s*[?!.]*\s*$/i;
const RE_ALTA = /^\s*(nuevo|nueva|alta|agregar|agreg[aá]|sumar|sum[aá])\s+(.+)$/i;
const RE_BAJA = /^\s*(baja|borrar|borr[aá]|sacar|sac[aá]|eliminar|quitar)\s+(.+)$/i;
const RE_PAGADO = /^\s*(pagad[oa]|pagu[eé]|pago|list[oa]|abon[eé])\s*(.*)$/i;
const RE_COMPROBANTE = /^\s*(comprobante|factura|recibo)\s+(.+)$/i;
const RE_HISTORIAL = /^\s*(historial|hist[oó]rico)\s+(.+)$/i;
const RE_EDITAR = /^\s*(cambiar|cambi[aá]|editar|edit[aá]|modificar)\s+(.+)$/i;
const RE_NUMERO = /^\s*([1-9])\s*$/;

// Prefiltro barato antes de gastar API.
const PISTAS =
  /\b(gasto|gastos|pagar|pagu[eé]|pagad|pago|vence|vencimiento|factura|comprobante|expensas|alquiler|luz|gas|agua|internet|cable|prepaga|colegio|cuota|tarjeta|abl|arba|monotributo|seguro|impuesto|recibo|transferencia|debito|d[eé]bito|plata|mes)\b/i;

// Un epígrafe con alguna de estas palabras marca "esto es un comprobante".
const RE_PISTA_COMPROBANTE = /\b(pagad|pagu[eé]|pago|abon[eé]|comprobante|transferencia|factura|recibo|list[oa])\b/i;

const MAX_RECORDATORIOS = 300;

/** "45.300" / "$52.300,50" / "40 lucas" -> número */
export function parseMonto(txt) {
  if (!txt) return null;
  const limpio = String(txt).replace(/\s/g, "");
  const luca = limpio.match(/^\$?([\d.,]+)(luca|lucas|mil|k)$/i);
  const crudo = luca ? luca[1] : (limpio.match(/^\$?([\d.,]+)$/) || [])[1];
  if (!crudo) return null;
  // es-AR: el punto es separador de miles y la coma decimal.
  const n = Number(crudo.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return luca ? Math.round(n * 1000) : n;
}

/** Parsea "Luz día 15 monto 40000 aviso 5" -> { nombre, dia, monto, avisoDias } */
export function parseAlta(args) {
  let resto = ` ${args} `;
  const sacar = (re) => {
    const m = resto.match(re);
    if (!m) return null;
    resto = resto.replace(m[0], " ");
    return m;
  };
  const mAviso = sacar(/\bavis[oa]r?\s*(?:con)?\s*(\d{1,2})\s*(?:d[ií]as?)?\s*(?:antes)?/i);
  const mMonto = sacar(/\b(?:monto|por|de)?\s*\$?\s*([\d][\d.,]*)\s*(lucas?|mil|k)\b/i) || sacar(/\bmonto\s*\$?\s*([\d][\d.,]*)/i) || sacar(/\$\s*([\d][\d.,]*)/);
  const mDia =
    sacar(/\b(?:d[ií]a|vence(?:\s*el)?|el)\s*(\d{1,2})\b/i) ||
    sacar(/\bcada\s*(\d{1,2})\b/i);

  const nombre = resto.replace(/\s+/g, " ").trim().replace(/^[,;:-]+|[,;:-]+$/g, "");
  const finDeMes = /\bfin de mes\b/i.test(args);

  return {
    nombre,
    dia: mDia ? Number(mDia[1]) : finDeMes ? 30 : null,
    monto: mMonto ? parseMonto(`${mMonto[1]}${mMonto[2] || ""}`) : null,
    avisoDias: mAviso ? Number(mAviso[1]) : null,
  };
}

export function crearAgente({ wa, grupoJid = config.grupoJid }) {
  // id del aviso -> gasto al que corresponde. Sirve para que responder al
  // recordatorio con el comprobante alcance, sin escribir nada.
  const recordatorios = new Map();
  // Espera de desambiguación ("¿cuál de estos?"). TTL 5 min.
  let pendiente = null;

  function recordar(id, dato) {
    if (!id) return;
    recordatorios.set(id, dato);
    if (recordatorios.size > MAX_RECORDATORIOS) {
      recordatorios.delete(recordatorios.keys().next().value);
    }
  }

  async function responder(texto) {
    return wa.enviarTexto(grupoJid, texto);
  }

  async function avisar(texto, { gastoId, periodo }) {
    const enviado = await responder(texto);
    recordar(enviado?.key?.id, { gastoId, periodo });
    return enviado;
  }

  async function reaccionar(key, emoji) {
    if (!key || !wa.reaccionar) return;
    try {
      await wa.reaccionar(key, emoji);
    } catch (e) {
      console.error("⚠️  No pude reaccionar (gastos):", e?.message || e);
    }
  }

  const filaDe = (gastoId, periodo = periodoActual()) =>
    store.estadoPeriodo(periodo).find((f) => f.gasto.id === gastoId) || null;

  /**
   * Punto de entrada. Devuelve true si el agente actuó.
   * Nunca propaga excepciones.
   */
  async function manejarMensaje({ texto, autor, key, archivo, citadoId } = {}) {
    const t = (texto || "").trim();

    try {
      // 0) Comprobante adjunto: va primero, el texto es solo el epígrafe.
      if (archivo) return await manejarComprobante(archivo, t, { autor, key, citadoId });

      if (!t) return false;

      // 1) ¿Está contestando a un "¿cuál de estos?"
      const num = t.match(RE_NUMERO);
      if (num && vigente(pendiente)) return await resolverPendiente(Number(num[1]), { autor, key });

      // 2) Respuesta a un recordatorio sin adjunto ("listo", "pagado")
      if (citadoId && recordatorios.has(citadoId) && RE_PAGADO.test(t)) {
        const { gastoId, periodo } = recordatorios.get(citadoId);
        const monto = parseMonto(t.replace(RE_PAGADO, "$2").trim());
        return await pagar(gastoId, periodo, { autor, key, monto });
      }

      if (t.length > config.largoMaximo) return false;

      // 3) Palabras clave (gratis)
      const porComando = await comandoExplicito(t, { autor, key });
      if (porComando !== undefined) return porComando;

      // 4) Prefiltro + Claude
      if (!claudeDisponible || !PISTAS.test(t)) return false;
      const intencion = await interpretar(t, { autor });
      if (!intencion) return false;
      return await ejecutar(intencion, { autor, key });
    } catch (e) {
      console.error(`❌ Error de gastos con "${t.slice(0, 40)}":`, e?.message || e);
      await responder(`⚠️ Se me complicó con eso: ${(e?.message || String(e)).slice(0, 120)}`).catch(() => {});
      return true;
    }
  }

  // --- Comandos por palabra clave ----------------------------------------
  // Devuelve undefined si no matcheó ninguno (para que siga con Claude).
  async function comandoExplicito(t, { autor, key }) {
    if (RE_AYUDA.test(t)) {
      await responder(formato.AYUDA);
      return true;
    }
    if (RE_ESTADO.test(t)) {
      await mostrarMes();
      return true;
    }

    let m;
    if ((m = t.match(RE_ALTA))) return await alta(parseAlta(m[2]), { autor, key });
    if ((m = t.match(RE_BAJA))) return await baja(m[2], { key });
    if ((m = t.match(RE_COMPROBANTE))) return await devolverComprobante(m[2]);
    if ((m = t.match(RE_HISTORIAL))) return await mostrarHistorial(m[2]);
    if ((m = t.match(RE_EDITAR))) return await editar(m[2]);
    if ((m = t.match(RE_PAGADO))) {
      const args = (m[2] || "").trim();
      if (!args) return undefined; // "listo" suelto: que lo mire Claude o nadie
      return await pagarPorTexto(args, { autor, key });
    }
    return undefined;
  }

  async function ejecutar(intencion, { autor, key } = {}) {
    switch (intencion.accion) {
      case "crear":
        return await alta(
          {
            nombre: intencion.nombre,
            dia: intencion.dia,
            monto: intencion.monto ?? null,
            avisoDias: intencion.avisoDias ?? null,
            alias: intencion.alias || [],
          },
          { autor, key }
        );

      case "ver_mes":
        await mostrarMes();
        return true;

      case "pagado":
        return await pagarPorTexto(intencion.texto || "", { autor, key, monto: intencion.monto ?? null });

      case "baja":
        return await baja(intencion.texto || "", { key });

      case "editar":
        return await editar(intencion.texto || "", intencion);

      case "historial":
        return await mostrarHistorial(intencion.texto || "");

      case "comprobante":
        return await devolverComprobante(intencion.texto || "");

      case "ayuda":
        await responder(formato.AYUDA);
        return true;

      default:
        return false;
    }
  }

  // --- Acciones -----------------------------------------------------------

  async function alta({ nombre, dia, monto = null, avisoDias = null, alias = [] }, { autor, key } = {}) {
    if (!nombre) {
      await responder("¿Cómo se llama el gasto? Ej: `nuevo Luz día 15 monto 40000`");
      return true;
    }
    if (!dia) {
      await responder(`¿Qué día del mes vence *${nombre}*? Ej: \`nuevo ${nombre} día 15\``);
      return true;
    }
    const gasto = store.crear({ nombre, dia, monto, avisoDias, alias, creadoPor: autor || "" });
    if (!gasto) {
      await responder(`Ya tengo un gasto que se llama *${nombre}*. Si querés cambiarlo: \`cambiar ${nombre} día 20\`.`);
      return true;
    }
    store.asegurarPeriodo(periodoActual());
    await reaccionar(key, "✅");
    await responder(formato.confirmacionAlta(gasto));
    return true;
  }

  async function baja(texto, { key } = {}) {
    const encontrados = store.buscar(texto);
    if (!encontrados.length) {
      await responder(`No encontré ningún gasto con "${texto}".`);
      return true;
    }
    if (encontrados.length > 1) {
      return await preguntarCual(encontrados, { tipo: "baja" });
    }
    store.darDeBaja(encontrados[0].id);
    await reaccionar(key, "🗑️");
    await responder(`🗑️ Listo, dejo de recordar *${encontrados[0].nombre}*. El historial queda guardado.`);
    return true;
  }

  async function editar(texto, intencion = {}) {
    const cambios = {};
    const parsed = parseAlta(texto);
    if (intencion.dia ?? parsed.dia) cambios.dia = intencion.dia ?? parsed.dia;
    if (intencion.monto ?? parsed.monto) cambios.monto = intencion.monto ?? parsed.monto;
    if (intencion.avisoDias ?? parsed.avisoDias) cambios.avisoDias = intencion.avisoDias ?? parsed.avisoDias;

    const nombre = intencion.texto || parsed.nombre;
    const encontrados = store.buscar(nombre);
    if (!encontrados.length) {
      await responder(`No encontré ningún gasto con "${nombre}".`);
      return true;
    }
    if (!Object.keys(cambios).length) {
      await responder("¿Qué le cambio? Ej: `cambiar Luz día 20` o `cambiar Luz monto 52000`");
      return true;
    }
    const g = store.editar(encontrados[0].id, cambios);
    await responder(formato.confirmacionAlta(g).replace("Agendado", "Actualizado"));
    return true;
  }

  async function pagarPorTexto(texto, { autor, key, monto = null } = {}) {
    const periodo = periodoActual();
    const montoTxt = monto ?? parseMonto((texto.match(/([\d][\d.,]*\s*(?:lucas?|mil|k)?)\s*$/i) || [])[1]);
    const nombre = texto.replace(/([\d][\d.,]*\s*(?:lucas?|mil|k)?)\s*$/i, "").trim() || texto;

    const filas = store.pendientesDe(periodo).filter((f) => coincide(f.gasto, nombre));
    if (!filas.length) {
      const yaPago = store
        .estadoPeriodo(periodo)
        .find((f) => f.pago.estado === "pagado" && coincide(f.gasto, nombre));
      await responder(
        yaPago
          ? `*${yaPago.gasto.nombre}* ya figura pagado este mes 👌`
          : `No encontré un gasto pendiente con "${nombre}". Escribí \`gastos\` para ver la lista.`
      );
      return true;
    }
    if (filas.length > 1) {
      return await preguntarCual(filas.map((f) => f.gasto), { tipo: "pago", autor, monto: montoTxt });
    }
    return await pagar(filas[0].gasto.id, periodo, { autor, key, monto: montoTxt });
  }

  async function pagar(gastoId, periodo, { autor, key, monto = null, comprobante = null } = {}) {
    store.marcarPagado(gastoId, periodo, { pagadoPor: autor || "", monto, comprobante });
    const fila = filaDe(gastoId, periodo);
    await reaccionar(key, "✅");
    if (fila) await responder(formato.confirmacionPago(fila, { comprobante: Boolean(comprobante) }));
    return true;
  }

  async function mostrarMes(periodo = periodoActual()) {
    await responder(formato.estadoMes(periodo, store.estadoPeriodo(periodo)));
  }

  async function mostrarHistorial(texto) {
    const encontrados = store.buscar(texto);
    if (!encontrados.length) {
      await responder(`No encontré ningún gasto con "${texto}".`);
      return true;
    }
    await responder(formato.historialTexto(encontrados[0], store.historial(encontrados[0].id)));
    return true;
  }

  async function devolverComprobante(texto) {
    const encontrados = store.buscar(texto);
    if (!encontrados.length) {
      await responder(`No encontré ningún gasto con "${texto}".`);
      return true;
    }
    const gasto = encontrados[0];
    const periodo = periodoActual();
    const pago = store.pagoDe(gasto.id, periodo);
    if (!pago?.comprobante || !existe(pago.comprobante)) {
      await responder(`No tengo comprobante guardado de *${gasto.nombre}* para este mes.`);
      return true;
    }
    if (!wa.enviarArchivo) {
      await responder(`🧾 El comprobante de *${gasto.nombre}* está en \`${pago.comprobante.archivo}\`.`);
      return true;
    }
    await wa.enviarArchivo(grupoJid, {
      ruta: pago.comprobante.archivo,
      mime: pago.comprobante.mime,
      nombre: pago.comprobante.nombre || `${gasto.nombre}-${periodo}`,
      caption: `🧾 ${gasto.nombre} — ${periodo}`,
    });
    return true;
  }

  // --- Comprobantes -------------------------------------------------------

  async function manejarComprobante(archivo, caption, { autor, key, citadoId } = {}) {
    const periodo = periodoActual();
    const pendientes = store.pendientesDe(periodo);

    // ¿A qué gasto apunta? Del más barato al más caro de resolver.
    let objetivo = null;

    // a) Responde a un recordatorio nuestro.
    if (citadoId && recordatorios.has(citadoId)) {
      const dato = recordatorios.get(citadoId);
      objetivo = { gastoId: dato.gastoId, periodo: dato.periodo };
    }

    // b) El epígrafe nombra el gasto.
    const textoEpigrafe = (caption || "").replace(RE_PAGADO, "$2").trim();
    if (!objetivo && textoEpigrafe) {
      const candidatos = pendientes.filter((f) => coincide(f.gasto, textoEpigrafe));
      if (candidatos.length === 1) objetivo = { gastoId: candidatos[0].gasto.id, periodo };
    }

    // c) Hay un solo pendiente y el epígrafe (o el hecho de mandar un archivo
    //    con pista de pago) dice que es un comprobante.
    const pistaDePago = RE_PISTA_COMPROBANTE.test(caption || "");
    if (!objetivo && pendientes.length === 1 && (pistaDePago || !caption)) {
      objetivo = { gastoId: pendientes[0].gasto.id, periodo };
    }

    // Sin objetivo y sin pistas: no es para nosotros, no bajamos nada.
    if (!objetivo && !pistaDePago && !textoEpigrafe) return false;
    if (!pendientes.length && !objetivo) {
      await responder("No tengo gastos pendientes este mes, así que no sé a qué asociar ese comprobante.");
      return true;
    }

    await reaccionar(key, "👀");
    const base64 = await archivo.descargar();
    if (!base64) {
      await responder("No pude bajar el archivo. Probá reenviándolo.");
      return true;
    }
    if (excedeLimite(base64)) {
      await responder(`Ese archivo pesa demasiado (máx ${config.maxComprobanteMb} MB). Mandalo más liviano.`);
      return true;
    }

    const montoCaption = parseMonto((caption || "").match(/([\d][\d.,]*\s*(?:lucas?|mil|k)?)\s*$/i)?.[1]);
    let monto = montoCaption;

    // d) Último recurso: que Claude lea el comprobante y lo asocie.
    if (!objetivo) {
      const leido = await leerComprobante(base64, archivo.mime, {
        nombres: pendientes.map((f) => f.gasto.nombre),
        caption,
      });
      if (leido?.gasto) {
        const f = pendientes.find((x) => x.gasto.nombre === leido.gasto);
        if (f) objetivo = { gastoId: f.gasto.id, periodo };
      }
      if (monto == null && leido?.monto != null) monto = leido.monto;
    }

    const etiqueta = objetivo ? store.obtener(objetivo.gastoId)?.nombre || "comprobante" : "sin-asignar";
    const comprobante = guardarComprobante({
      base64,
      mime: archivo.mime,
      nombre: archivo.nombre,
      periodo,
      etiqueta,
    });

    if (objetivo) {
      return await pagar(objetivo.gastoId, objetivo.periodo, { autor, key, monto, comprobante });
    }

    // No lo pudimos asociar: preguntamos, guardando el archivo ya bajado.
    return await preguntarCual(
      pendientes.map((f) => f.gasto),
      { tipo: "pago", autor, monto, comprobante }
    );
  }

  // --- Desambiguación -----------------------------------------------------

  function vigente(p) {
    return Boolean(p) && Date.now() - p.ts < 5 * 60 * 1000;
  }

  async function preguntarCual(gastos, extra = {}) {
    const periodo = periodoActual();
    const filas = gastos
      .slice(0, 9)
      .map((g) => filaDe(g.id, periodo) || { gasto: g, pago: {}, vence: vencimientoYmd(periodo, g.dia), periodo });
    pendiente = { ...extra, filas, ts: Date.now() };
    await responder(
      `¿Cuál de estos? Respondé con el número:\n\n${formato.listaNumerada(filas)}`
    );
    return true;
  }

  async function resolverPendiente(n, { autor, key } = {}) {
    const p = pendiente;
    pendiente = null;
    const fila = p.filas[n - 1];
    if (!fila) {
      await responder("Ese número no está en la lista.");
      return true;
    }
    if (p.tipo === "baja") {
      store.darDeBaja(fila.gasto.id);
      await responder(`🗑️ Listo, dejo de recordar *${fila.gasto.nombre}*.`);
      return true;
    }
    return await pagar(fila.gasto.id, fila.periodo || periodoActual(), {
      autor: p.autor || autor,
      key,
      monto: p.monto ?? null,
      comprobante: p.comprobante || null,
    });
  }

  function coincide(gasto, texto) {
    return store.buscar(texto).some((g) => g.id === gasto.id);
  }

  // --- Recordatorios automáticos (los dispara scheduler.js) ---------------

  /**
   * Corre una vez por día. Recorre los pendientes del mes y manda el aviso que
   * corresponda. Los sellos en gastos.json evitan repetir si el proceso
   * reinicia varias veces el mismo día.
   */
  async function revisarRecordatorios() {
    const hoy = hoyYmd();
    const periodo = periodoDe(hoy);
    store.asegurarPeriodo(periodo);

    let enviados = 0;
    for (const fila of store.pendientesDe(periodo)) {
      const { gasto, pago, vence } = fila;
      const faltan = diffDias(hoy, vence);
      const avisoDias = gasto.avisoDias ?? config.avisoDiasDefault;

      let tipo = null;
      let texto = null;

      if (faltan > 0 && faltan <= avisoDias && !pago.avisos?.previo) {
        tipo = "previo";
        texto = formato.avisoPrevio(fila);
      } else if (faltan === 0 && !pago.avisos?.vencimiento) {
        tipo = "vencimiento";
        texto = formato.avisoVencimiento(fila);
      } else if (faltan < 0) {
        const atraso = -faltan;
        const hechas = pago.insistencias || 0;
        const tocaInsistir =
          hechas < config.maxInsistencias ? atraso % config.insistirCada === 0 : atraso % 7 === 0;
        if (tocaInsistir && pago.avisos?.insistencia !== hoy) {
          tipo = "insistencia";
          texto = formato.avisoAtraso(fila, atraso);
        }
      }

      if (!tipo) continue;
      await avisar(texto, { gastoId: gasto.id, periodo });
      store.registrarAviso(gasto.id, periodo, tipo, hoy);
      enviados++;
    }
    return enviados;
  }

  /** Resumen del mes que arranca (opcional, RESUMEN_MENSUAL=on). */
  async function resumenMensual() {
    const periodo = periodoActual();
    const filas = store.estadoPeriodo(periodo);
    if (!filas.length) return false;
    await responder(formato.resumenMensual(periodo, filas));
    return true;
  }

  /** Lo que quedó sin pagar del mes anterior, para no perderlo de vista. */
  async function arrastreMesAnterior() {
    const anterior = sumarMeses(periodoActual(), -1);
    const filas = store.pendientesDe(anterior);
    if (!filas.length) return false;
    await responder(
      `⚠️ Del mes pasado quedó sin marcar:\n${filas.map((f) => `• ${f.gasto.nombre}`).join("\n")}`
    );
    return true;
  }

  return {
    grupoJid,
    manejarMensaje,
    ejecutar,
    mostrarMes,
    revisarRecordatorios,
    resumenMensual,
    arrastreMesAnterior,
  };
}
