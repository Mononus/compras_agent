# Bot de WhatsApp de casa

Un proceso, un número de WhatsApp, **tres agentes** en tres grupos distintos:

| Agente | Grupo | Qué hace | Detalle |
|---|---|---|---|
| 🛒 **Lista de compras** | `compras` | anotan lo que falta, el bot lo registra; cuando alguien está en el súper pide la lista | acá abajo |
| 📅 **Agenda familiar** | familia | agenda eventos en un Google Calendar compartido, resumen del día y de la semana | [`calendario/README.md`](calendario/README.md) |
| 💸 **Gastos del mes** | gastos | gastos fijos mensuales, recordatorios de vencimiento y comprobantes | [`gastos/README.md`](gastos/README.md) |

Para el estado real del deploy, los bugs ya resueltos y lo que quedó pendiente:
[`ESTADO.md`](ESTADO.md). **Vale la pena leerlo antes de tocar nada.**

---

## Por qué un solo proceso

Una credencial de Baileys = una sesión = **un proceso**. Dos procesos con la
misma carpeta `auth/` se expulsan mutuamente en loop (`conflict: replaced`).
Como los tres agentes usan el mismo número, tienen que compartir proceso.

Lo que sí está separado es el código: cada agente vive en su carpeta e `index.js`
solo rutea por JID de grupo. El acoplamiento son ~30 líneas por módulo.

```
                    index.js  (1 socket de WhatsApp)
                          │
        ┌─────────────────┼─────────────────┐
   grupo compras     grupo familia      grupo gastos
        │                 │                  │
    store.js      calendario/agent.js   gastos/agent.js
```

**Por qué Baileys y no la API oficial:** la WhatsApp Cloud API no soporta grupos,
solo chats 1-a-1. Baileys usa el protocolo de WhatsApp Web (vinculación por QR),
que sí funciona en grupos. Contrapartida: va contra los ToS de WhatsApp.

Los módulos de agenda y gastos están pensados para **fallar solos**: si les falta
configuración arrancan apagados y lo dicen en el log; si una API externa falla, lo
avisan en su grupo sin tirar el proceso. Para apagar uno: vaciar su
`TARGET_GROUP_*` y reiniciar.

## Archivos

```
index.js       conexión a WhatsApp (Baileys), ruteo por grupo, reconexión
store.js       persistencia de la lista de compras en lista.json
llm.js         lenguaje natural de la lista, con la API de Claude
calendario/    módulo de agenda familiar (README propio)
gastos/        módulo de gastos mensuales (README propio)
.env           configuración — NO está en git
```

Datos en disco, ninguno versionado: `lista.json`, `gastos.json`,
`comprobantes/`, `auth/`.

---

## 🛒 Lista de compras

El grupo es **dedicado**: todo mensaje es candidato a comando, sin prefijo.

```
leche, pan                 → los agrego
falta papel higiénico      → lo agrego
ya compré la leche         → la marco comprada
sacá el pan                → lo quito sin comprarlo
qué falta                  → paso la lista
vaciar                     → limpio todo
```

Primero se prueban palabras clave (`agregar`, `lista`, `compre`, `borrar`,
`vaciar`, `ayuda`): instantáneo y sin costo de API. Lo que no matchea va a
Claude, que devuelve la intención como JSON. Los mensajes de más de 300
caracteres se ignoran sin llamar a la API.

Las confirmaciones son **reacciones emoji** (✅ agregado, 🎉 comprado, 🗑️ borrado,
🧹 vaciado) para no inundar el grupo; solo `lista` responde con texto.

## 📅 Agenda familiar

Segundo grupo, Google Calendar compartido. Agenda en lenguaje natural
(`el martes 18hs turno con el pediatra`), lee eventos de una foto de invitación,
responde `hoy` / `mañana` / `semana`, manda los eventos del día cada mañana a las
07:30 y el resumen de la semana entrante los domingos a las 20:00.

Necesita credenciales de Google (service account recomendada) y
`TARGET_GROUP_FAMILIA`. Setup completo, troubleshooting y comandos de prueba en
[`calendario/README.md`](calendario/README.md).

## 💸 Gastos del mes

Tercer grupo. Gastos fijos que se pagan todos los meses.

```
nuevo Luz día 15 monto 40000   → alta del gasto recurrente
gastos                         → qué está pagado y qué falta
historial luz                  → cómo vino los últimos meses
comprobante luz                → devuelve el archivo guardado
cambiar Luz día 20             → edita día, monto o aviso
baja Internet                  → deja de recordarlo (el historial queda)
```

Un cron diario avisa 3 días antes del vencimiento, avisa el día que vence y, si
sigue impago, insiste cada 2 días (3 veces; después una vez por semana).

Para marcar pagado, cualquiera de estas tres:

1. mandar la foto o el PDF del comprobante con el epígrafe `pagado luz 45300`
2. **responder** al recordatorio con el comprobante, sin escribir nada
3. sin comprobante a mano: `pagado luz` en texto

Si el epígrafe no alcanza para identificar el gasto, Claude lee el comprobante y
lo asocia solo (Edenor → luz, AySA → agua); si tampoco, pregunta con una lista
numerada. Los comprobantes se archivan en disco, en `comprobantes/<mes>/`.

Solo necesita `TARGET_GROUP_GASTOS`. Todo lo demás tiene defaults; el detalle
está en [`gastos/README.md`](gastos/README.md).

---

## Puesta en marcha

```bash
git clone https://github.com/Mononus/compras_agent.git
cd compras_agent
npm install
cp .env.example .env      # completar
npm start                 # escanear el QR con el celular la primera vez
```

### Averiguar el JID de un grupo

Agregá el bot al grupo y arrancá con `LISTAR_GRUPOS=true`: al conectar imprime
cada grupo con su `TARGET_GROUP=120363...@g.us`. (Con `TARGET_GROUP` vacío
también los lista, pero ojo: el bot queda respondiendo en **todos** los chats.)

### Variables

| Variable | Para qué |
|---|---|
| `TARGET_GROUP` | grupo de la lista de compras |
| `TARGET_GROUP_FAMILIA` | grupo de la agenda — vacío = agenda apagada |
| `TARGET_GROUP_GASTOS` | grupo de gastos — vacío = gastos apagado |
| `ANTHROPIC_API_KEY` | lenguaje natural en los tres agentes (opcional) |
| `CLAUDE_MODEL` | default `claude-haiku-4-5-20251001` |
| `BOT_PREFIX` / `REQUIERE_PREFIJO` | exigir prefijo en el grupo de compras |
| `LOG_BAILEYS` | `warn` para ver el ruido interno de Baileys |

Cada módulo suma las suyas: ver `.env.example`, que las trae todas comentadas.

### Deploy

Corre en una EC2 Ubuntu bajo systemd (`lista-compras-bot.service`). El flujo es
subir los archivos a GitHub → `git pull` en la EC2 → reiniciar:

```bash
cd ~/compras_agent
git pull
npm install                                  # solo si hay dependencias nuevas
sudo systemctl restart lista-compras-bot
journalctl -u lista-compras-bot -f
```

Al conectar tiene que aparecer algo así:

```
✅ Conectado a WhatsApp.
   Modo: sin prefijo | Claude: activo
📅 Agenda familiar: activa en 120363...@g.us
💸 Gastos del mes: activo en 120363...@g.us
💸 Recordatorios de gastos: "0 9 * * *" | America/Argentina/Buenos_Aires
```

Detalle de la instancia y del servicio en [`DEPLOY-EC2.md`](DEPLOY-EC2.md).

> **Nunca corras `npm start` con el servicio activo.** Dos procesos con las
> mismas credenciales se expulsan en loop (`conflict: replaced`).

## Probar sin WhatsApp

```bash
npm run gastos:probar    # recorre un mes de gastos con reloj falso
npm run agenda:probar    # lee el calendario e imprime los resúmenes
npm run agenda:parse     # qué devuelve Claude para frases de ejemplo
```

## Comandos operativos

```bash
sudo systemctl status lista-compras-bot      # estado
sudo systemctl restart lista-compras-bot     # reiniciar
journalctl -u lista-compras-bot -f           # logs en vivo
LOG_BAILEYS=warn npm start                   # ruido interno (con el servicio parado)
cat lista.json                               # datos crudos de la lista
cat gastos.json                              # datos crudos de los gastos
ls comprobantes/                             # comprobantes archivados por mes
```

## Si algo sale mal

| Síntoma | Causa probable |
|---|---|
| No responde en un grupo | ¿el `TARGET_GROUP_*` es el JID correcto? |
| `📅 Agenda familiar: apagada (falta ...)` | justamente eso, en el `.env` |
| `💸 Gastos del mes: apagado (falta ...)` | falta `TARGET_GROUP_GASTOS` |
| Respuestas duplicadas | dos procesos corriendo (`systemctl status`) |
| `conflict: replaced` en el log | ídem: el proceso se cierra a propósito en vez de pelear |
| `Bad MAC`, `PreKeyError`, `Timed Out` en `init queries` | ruido cosmético de libsignal, inofensivo |
| No entiende lenguaje natural | falta `ANTHROPIC_API_KEY`, o el prefiltro regex del módulo lo descartó |
| Sesión cerrada desde el celular | borrar `auth/` y re-escanear el QR |

El troubleshooting específico de cada agente está en su README. Los falsos
sospechosos que ya se persiguieron una vez están listados en `ESTADO.md`, sección
6: **conviene mirar ahí antes de diagnosticar de cero.**

## Costo de API

Los tres agentes comparten `ANTHROPIC_API_KEY` y modelo (Haiku). El grupo de
compras es dedicado, así que casi todo mensaje va a Claude; los de agenda y
gastos tienen charla suelta, y por eso sus agentes filtran con una regex
(`PISTAS`) antes de llamar a la API. Si ves pedidos que se le escapan a un
agente, ampliá esa regex antes de tocar otra cosa.

Sin API key los tres siguen funcionando con palabras clave; lo único que se
pierde es el lenguaje natural (y, en gastos, la lectura automática del
comprobante).
