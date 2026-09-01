# Gastos del mes — módulo `gastos/`

Tercer agente del mismo proceso. Vive en un grupo propio de WhatsApp y se ocupa
de los gastos fijos que se pagan todos los meses: los recuerda antes de que
venzan, insiste si no se pagaron y los marca pagados cuando alguien manda el
comprobante.

No usa Google ni base de datos: los gastos van a `gastos.json` y los
comprobantes a `comprobantes/<mes>/`.

---

## Cómo se usa en el grupo

**Cargar un gasto recurrente**

```
nuevo Luz día 15 monto 40000
nuevo Expensas día 10
nuevo Internet día 5 aviso 5
```

`día` es el día del mes en que vence. Si el mes no llega a ese día (31 en
febrero), se recorta al último. `monto` es opcional y es solo una referencia:
el monto real se toma del pago.

**Marcar pagado**

Tres formas, todas equivalentes:

1. Mandar la foto o el PDF del comprobante con el epígrafe `pagado luz`
   (opcionalmente con el monto real: `pagado luz 45300`).
2. **Responder** al recordatorio con el comprobante, sin escribir nada.
3. Sin comprobante a mano: escribir `pagado luz`.

Si el epígrafe no alcanza para saber de qué gasto se trata y hay una API key de
Claude configurada, el bot **lee el comprobante** y lo asocia solo (Edenor → luz,
AySA → agua, etc.). Si tampoco así, pregunta con una lista numerada y se
contesta con el número.

**Consultar**

```
gastos            → qué está pagado y qué falta este mes
historial luz     → cómo vino ese gasto los últimos meses
comprobante luz   → devuelve el archivo guardado
```

**Mantenimiento**

```
cambiar Luz día 20
cambiar Luz monto 52000
baja Internet        → deja de recordarlo; el historial queda
```

Todo esto también funciona en lenguaje natural si hay `ANTHROPIC_API_KEY`
(«ya pagué la luz, 45300», «la luz ahora vence el 20», «qué falta pagar»).

## Recordatorios automáticos

Un solo cron diario (`CRON_GASTOS`, por defecto 9:00) revisa todos los gastos
del mes y manda lo que corresponda:

| Cuándo | Qué manda |
|---|---|
| `AVISO_DIAS` antes del vencimiento (3) | aviso previo con el monto estimado |
| El día del vencimiento | «vence HOY» |
| Vencido y sin pagar | insiste cada `INSISTIR_CADA` días (2), hasta `MAX_INSISTENCIAS` (3) |
| Después de esas insistencias | una vez por semana, hasta que se pague |

Cada aviso queda sellado en `gastos.json` (por gasto, tipo y día), así un
reinicio del proceso cerca del horario no repite el mensaje. Si el bot estuvo
caído justo el día del aviso previo, sale en la primera corrida siguiente
mientras el gasto no haya vencido.

Opcional: `RESUMEN_MENSUAL=on` manda el día 1 el listado del mes que arranca y
lo que quedó sin marcar del mes anterior.

## Configuración

Todo por `.env` (ver `.env.example`). Lo único obligatorio:

```bash
TARGET_GROUP_GASTOS=120363xxxxxxxxxxxx@g.us
```

**Sin esa variable el módulo arranca apagado** y no molesta al bot de compras ni
a la agenda. Para averiguar el JID del grupo: agregar el bot al grupo, poner
`LISTAR_GRUPOS=true`, reiniciar y mirar el log.

El resto tiene defaults razonables:

| Variable | Default | Qué hace |
|---|---|---|
| `GASTOS_FILE` | `./gastos.json` | datos |
| `COMPROBANTES_DIR` | `./comprobantes` | archivos de los comprobantes |
| `MAX_COMPROBANTE_MB` | `20` | tope por archivo |
| `CRON_GASTOS` | `0 9 * * *` | horario de la revisión diaria |
| `TZ_GASTOS` | `America/Argentina/Buenos_Aires` | zona horaria |
| `AVISO_DIAS` | `3` | días de aviso previo |
| `INSISTIR_CADA` | `2` | insistencia tras el vencimiento |
| `MAX_INSISTENCIAS` | `3` | tope antes de pasar a semanal |
| `RECORDATORIOS_GASTOS` | (on) | `off` apaga solo los avisos |
| `RESUMEN_MENSUAL` | (off) | `on` manda el resumen del día 1 |

`ANTHROPIC_API_KEY` y `CLAUDE_MODEL` se comparten con los otros dos agentes. Sin
key, el módulo funciona igual con las palabras clave; lo único que se pierde es
el lenguaje natural y la lectura automática del comprobante.

## Puesta en marcha

```bash
git pull
# no hay dependencias nuevas: usa node-cron, que ya estaba por la agenda
echo 'TARGET_GROUP_GASTOS=120363...@g.us' >> .env
sudo systemctl restart lista-compras-bot
journalctl -u lista-compras-bot -f | grep 💸
```

Al conectar tiene que aparecer:

```
💸 Gastos del mes: activo en 120363...@g.us
💸 Recordatorios de gastos: "0 9 * * *" | America/Argentina/Buenos_Aires | aviso 3d antes, insiste cada 2d
```

## Probar sin WhatsApp

```bash
npm run gastos:probar
```

Recorre un mes entero con un reloj falso: alta, aviso previo, vencimiento,
insistencia, comprobante con epígrafe, comprobante por respuesta, consultas,
baja y arranque del mes siguiente. Escribe en `/tmp`, no toca los datos reales
ni llama a la API.

## Archivos

```
config.js      configuración por env; NUNCA tira excepción al importarse
fechas.js      períodos ("2026-09"), vencimientos con recorte a fin de mes
store.js       gastos.json: gastos recurrentes + un pago por gasto y mes
archivos.js    guardado de comprobantes en disco
formato.js     los textos que salen al grupo
llm.js         lenguaje natural + lectura del comprobante (Claude, opcional)
agent.js       núcleo: comandos, comprobantes, desambiguación, recordatorios
scheduler.js   el cron diario (idempotente ante reconexiones)
probar.js      runner sin WhatsApp
```

## Decisiones

- **Los comprobantes se guardan en disco, no como id de WhatsApp.** Los medios
  de WhatsApp caducan: en un par de meses el id ya no baja nada, y el sentido
  del bot es poder ir a buscar la factura de hace cinco meses.
- **Baja lógica, no borrado.** Dar de baja un gasto no borra los meses ya
  pagados; el historial se conserva.
- **Los meses viejos no se tocan.** Sólo el mes en curso genera pendientes: si
  no, dar de alta un gasto hoy le inventaría deudas en meses pasados.
- **Sin división de gastos entre personas.** El bot registra quién marcó el pago
  (para saber quién lo hizo), pero no lleva saldos ni divide montos.

## Pendiente / ideas

- Recordatorio por privado al responsable de cada gasto (hoy todo va al grupo).
- Gastos con vencimiento no mensual (bimestral, anual).
- Exportar el año a CSV.
- Detectar el aumento respecto del mes anterior («la luz subió 18%»).
