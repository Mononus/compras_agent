// gastos/probar.js — prueba el módulo SIN WhatsApp y SIN la API de Claude.
//
//   node gastos/probar.js
//
// Usa un adaptador `wa` falso que imprime lo que el bot mandaría, y un reloj
// falso para recorrer un mes entero en segundos: aviso previo, vencimiento,
// insistencias, comprobante y cierre. No toca gastos.json real: escribe en
// /tmp/gastos-prueba.json.

const RealDate = Date;
let salida = [];

function viajar(ymd, hora = "12:00") {
  const t = RealDate.parse(`${ymd}T${hora}:00-03:00`);
  class D extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(t);
      else super(...a);
    }
    static now() {
      return t;
    }
  }
  globalThis.Date = D;
  return ymd;
}

function volver() {
  globalThis.Date = RealDate;
}

let fallos = 0;
function chequear(descripcion, condicion) {
  console.log(`${condicion ? "  ✔" : "  ✘"} ${descripcion}`);
  if (!condicion) fallos++;
}

function ultimo() {
  return salida[salida.length - 1] || "";
}

async function main() {
  process.env.GASTOS_FILE = "/tmp/gastos-prueba.json";
  process.env.COMPROBANTES_DIR = "/tmp/comprobantes-prueba";
  process.env.TARGET_GROUP_GASTOS = "prueba@g.us";
  delete process.env.ANTHROPIC_API_KEY; // sin API: solo palabras clave

  const { rmSync, existsSync } = await import("fs");
  for (const p of ["/tmp/gastos-prueba.json", "/tmp/comprobantes-prueba"]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  const { crearAgente, parseAlta, parseMonto } = await import("./agent.js");
  const store = await import("./store.js");

  let contador = 0;
  const enviados = new Map();
  const agente = crearAgente({
    wa: {
      async enviarTexto(jid, texto) {
        salida.push(texto);
        console.log(`\n🤖 ${texto}\n`);
        const id = `msg${++contador}`;
        enviados.set(id, texto);
        return { key: { id, remoteJid: jid } };
      },
      async reaccionar(key, emoji) {
        console.log(`   (reacciona ${emoji})`);
      },
      async enviarArchivo(jid, { ruta, caption }) {
        salida.push(`[archivo ${ruta}] ${caption}`);
        console.log(`\n📎 ${caption} -> ${ruta}\n`);
        return { key: { id: `msg${++contador}`, remoteJid: jid } };
      },
    },
    grupoJid: "prueba@g.us",
  });

  const decir = async (texto, extra = {}) => {
    console.log(`👤 ${texto || "[archivo]"}`);
    return agente.manejarMensaje({ texto, autor: "Mariano", key: { id: `in${++contador}` }, ...extra });
  };

  // --- Parsers ------------------------------------------------------------
  console.log("\n=== Parsers ===");
  chequear("monto '45.300' = 45300", parseMonto("45.300") === 45300);
  chequear("monto '40 lucas' = 40000", parseMonto("40lucas") === 40000);
  chequear("alta 'Luz día 15 monto 40000'", (() => {
    const a = parseAlta("Luz día 15 monto 40000");
    return a.nombre === "Luz" && a.dia === 15 && a.monto === 40000;
  })());
  chequear("alta 'Internet día 5 aviso 5'", (() => {
    const a = parseAlta("Internet día 5 aviso 5");
    return a.nombre === "Internet" && a.dia === 5 && a.avisoDias === 5;
  })());

  // --- Alta ---------------------------------------------------------------
  console.log("\n=== Alta de gastos (1 de septiembre) ===");
  viajar("2026-09-01");
  await decir("nuevo Luz día 5 monto 40000");
  chequear("confirma el alta de Luz", /Luz/.test(ultimo()) && /día 5/.test(ultimo()));
  await decir("nuevo Expensas día 10");
  await decir("nuevo Luz día 5"); // duplicado
  chequear("rechaza el duplicado", /Ya tengo un gasto/.test(ultimo()));
  await decir("gastos");
  chequear("el estado lista los dos pendientes", /Pendientes \(2\)/.test(ultimo()));

  // --- Recordatorios ------------------------------------------------------
  console.log("\n=== Aviso previo (2 de septiembre, faltan 3 días) ===");
  viajar("2026-09-02");
  chequear("manda 1 aviso", (await agente.revisarRecordatorios()) === 1);
  chequear("es el aviso previo de Luz", /Luz/.test(ultimo()) && /vence en 3 días/.test(ultimo()));
  chequear("no repite el mismo día", (await agente.revisarRecordatorios()) === 0);

  console.log("\n=== Vencimiento (5 de septiembre) ===");
  viajar("2026-09-05");
  await agente.revisarRecordatorios();
  chequear("avisa que vence hoy", /vence HOY/.test(ultimo()));

  console.log("\n=== Insistencia (7 de septiembre, 2 días de atraso) ===");
  viajar("2026-09-07");
  let marca = salida.length;
  await agente.revisarRecordatorios();
  const delDia7 = salida.slice(marca);
  chequear("insiste por Luz", delDia7.some((m) => /sigue sin pagar/.test(m) && /Luz/.test(m)));
  chequear("y avisa el previo de Expensas", delDia7.some((m) => /Expensas/.test(m) && /vence en 3 días/.test(m)));

  viajar("2026-09-08");
  marca = salida.length;
  await agente.revisarRecordatorios();
  chequear("el 8 no manda nada (insiste cada 2 días)", salida.length === marca);

  // --- Comprobante con epígrafe ------------------------------------------
  console.log("\n=== Comprobante con epígrafe ===");
  const archivoFalso = {
    mime: "image/jpeg",
    nombre: "captura.jpg",
    descargar: async () => Buffer.from("comprobante falso").toString("base64"),
  };
  await decir("pagado luz 45300", { archivo: archivoFalso });
  chequear("marca Luz pagada", /Luz/.test(ultimo()) && /pagado/.test(ultimo()));
  chequear("guarda el monto real", store.pagoDe(store.buscar("luz")[0].id, "2026-09").montoReal === 45300);
  chequear("guarda el archivo", Boolean(store.pagoDe(store.buscar("luz")[0].id, "2026-09").comprobante?.archivo));

  console.log("\n=== Ya no insiste por lo pagado (9 de septiembre) ===");
  viajar("2026-09-09");
  marca = salida.length;
  await agente.revisarRecordatorios();
  chequear("no vuelve a insistir por Luz", !salida.slice(marca).some((m) => /Luz/.test(m)));

  // --- Comprobante respondiendo al recordatorio ---------------------------
  console.log("\n=== Comprobante respondiendo al recordatorio, sin texto ===");
  // Buscamos el id del aviso de Expensas para simular el "responder a".
  const idExpensas = [...enviados.entries()].reverse().find(([, t]) => /Expensas/.test(t))[0];
  await decir("", { archivo: { ...archivoFalso, mime: "application/pdf", nombre: "expensas.pdf" }, citadoId: idExpensas });
  chequear("marca Expensas pagada por el reply", /Expensas/.test(ultimo()) && /pagado/.test(ultimo()));

  await decir("gastos");
  chequear("el mes queda todo pagado", /Pagados \(2\)/.test(ultimo()) && !/Pendientes/.test(ultimo()));

  // --- Consultas y mantenimiento -----------------------------------------
  console.log("\n=== Consultas ===");
  await decir("comprobante luz");
  chequear("devuelve el comprobante guardado", /\[archivo/.test(ultimo()));
  await decir("historial expensas");
  chequear("muestra historial", /Expensas/.test(ultimo()));
  await decir("cambiar Expensas día 12");
  chequear("edita el día", store.buscar("expensas")[0].dia === 12);
  await decir("baja Expensas");
  chequear("da de baja", store.buscar("expensas").length === 0);

  // --- Mes siguiente ------------------------------------------------------
  console.log("\n=== Mes siguiente (1 de octubre) ===");
  viajar("2026-10-01");
  await decir("gastos");
  chequear("octubre arranca con Luz pendiente", /Pendientes \(1\)/.test(ultimo()) && /Luz/.test(ultimo()));
  chequear("Expensas ya no aparece", !/Expensas/.test(ultimo()));
  chequear("septiembre no se tocó", store.estadoPeriodo("2026-09").every((f) => f.pago.estado === "pagado"));

  volver();
  console.log(`\n${fallos === 0 ? "✅ Todo bien" : `❌ ${fallos} chequeo(s) fallaron`}`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  volver();
  console.error(e);
  process.exit(1);
});
