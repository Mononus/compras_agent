# Estado del proyecto — Bot de WhatsApp de casa

> Documento de traspaso. Resume qué se construyó, qué decisiones se tomaron, qué
> bugs se encontraron y qué quedó pendiente. Última actualización: 21/07/2026.

---

## 1. Qué es

Un proceso, un número de WhatsApp, **dos agentes** en dos grupos distintos:

1. **Lista de compras** (grupo `compras`). Los integrantes escriben lo que
   falta y el bot lo registra; cuando alguien está en el súper, pide la lista.
2. **Agenda familiar** (grupo familiar, módulo `calendario/`). Agenda eventos
   en un Google Calendar compartido, manda los eventos del día cada mañana y
   el resumen de la semana entrante los domingos a las 20. Ver
   `calendario/README.md`.

Comparten proceso por obligación, no por gusto: una credencial de Baileys = una
sesión = un proceso. Dos procesos con la misma carpeta `auth/` se expulsan en
loop. Ver sección 5, `conflict: replaced`.

## 2. Dónde corre

| | |
|---|---|
| Servidor | EC2 Ubuntu, `ubuntu@ip-172-31-36-40` |
| Ruta | `/home/ubuntu/compras_agent` |
| Repo | `github.com/Mononus/compras_agent` |
| Servicio | `systemd` → `lista-compras-bot.service` |
| Número vinculado | **5491153870378 (número personal de Mariano)** |
| Grupo compras | `compras` → JID `120363429159326223@g.us` |
| Grupo agenda | (completar `TARGET_GROUP_FAMILIA` en el `.env`) |

Deploy: subir archivos a GitHub por la web → `git pull` en la EC2 → `systemctl restart`.

## 3. Arquitectura

```
index.js       conexión a WhatsApp (Baileys), ruteo por grupo, reconexión
store.js       persistencia de la lista en lista.json
llm.js         interpretación de lenguaje natural con la API de Claude
calendario/    módulo de agenda familiar (ver su propio README)
.env           configuración (NO está en git)
```

`index.js` rutea por JID: si el mensaje viene del grupo familiar se lo pasa a
`calendario/agent.js` y sigue de largo; si no, entra al flujo de la lista.

El módulo de agenda está pensado para **fallar solo**. Si le falta
configuración de Google arranca deshabilitado y lo avisa en el log; si la API
de Google falla, lo reporta en el grupo sin tirar el proceso. Para apagarlo:
vaciar `TARGET_GROUP_FAMILIA` y reiniciar.

**Por qué Baileys y no la API oficial:** la WhatsApp Cloud API **no soporta grupos**,
solo chats 1-a-1. Baileys usa el protocolo de WhatsApp Web (vinculación por QR), que
sí funciona en grupos. Contrapartida: va contra los ToS de WhatsApp.

## 4. Comportamiento actual

Modo **sin prefijo**: en el grupo objetivo, todo mensaje es candidato a comando.

1. Primero se prueban palabras clave (`agregar`, `lista`, `compre`, `borrar`,
   `vaciar`, `ayuda`) — instantáneo y sin costo de API.
2. Lo que no matchea va a Claude, que devuelve un JSON con la intención.
3. Confirmaciones por **reacción emoji** (✅ agregado, 🎉 comprado, 🗑️ borrado,
   🧹 vaciado) para no inundar el grupo. Solo `lista` responde con texto.

Mensajes de más de 300 caracteres se ignoran sin llamar a la API.

## 5. Bugs encontrados y resueltos

Esta es la parte valiosa: cada uno costó varias iteraciones de diagnóstico.

### `type="append"` vs `"notify"` — el que rompía todo
El handler descartaba todo lo que no fuera `type === "notify"`. Pero WhatsApp
entrega los mensajes que **vos mismo enviás** con `type="append"` (se agregan al
historial), no `"notify"` (que es para mensajes entrantes de terceros). Como el bot
está vinculado al número personal de Mariano, sus propios comandos nunca llegaban.
**Fix:** aceptar ambos tipos.

### `fromMe` descartado
El código ignoraba `msg.key.fromMe`. Con el número personal vinculado, eso
significaba que Mariano nunca podía usar su propio bot.
**Fix:** procesar también los `fromMe`.

### Loop infinito potencial (modo sin prefijo)
Sin prefijo, el bot leería sus propias respuestas como comandos.
**Fix:** `Set` con los IDs de los mensajes enviados; se ignoran al volver.

### `conflict: replaced` — dos instancias peleando
Correr `npm start` con el servicio de systemd activo hace que dos procesos usen las
mismas credenciales. WhatsApp expulsa a uno, ese reconecta y expulsa al otro, en loop.
**Fix:** ante `DisconnectReason.connectionReplaced` el proceso se cierra con un
mensaje claro en vez de pelear.
**Regla operativa: NUNCA correr `npm start` con el servicio activo.**

### Reconexión sin control
`if (reconectar) iniciar()` apilaba sockets superpuestos y un error 428 sin capturar
mataba el proceso.
**Fix:** guarda de reentrada, backoff exponencial (3s→60s), manejo explícito de
`loggedOut` y `connectionReplaced`, handlers de `unhandledRejection` y
`uncaughtException`.

### Ruido de libsignal tapando los logs
libsignal escribe stack traces de `Bad MAC` / `PreKeyError` con `console.log`,
`console.warn` **y `console.error`**. El primer filtro solo parcheaba los dos
primeros, así que el journal se inundaba igual.
**Fix:** filtro sobre los tres, que además inspecciona objetos `Error`, no solo strings.

### Diagnóstico a ciegas por correr en primer plano
Correr `npm start` sobre SSH hacía perder los logs al desconectarse, dos veces.
**Lección: usar systemd desde temprano** — `journalctl` persiste los logs.

## 6. Falsos sospechosos (no perseguir de nuevo)

- **`Timed Out` en `init queries` / `fetchProps` (408):** aparece en cada arranque y
  es inofensivo. Se confirmó porque `groupFetchAllParticipating()` funciona igual.
- **`Bad MAC`, `PreKeyError`, `MessageCounterError`:** sesiones Signal
  desincronizadas, secuela del episodio de instancias duplicadas. Ruido cosmético.
  Se curan re-vinculando (`rm -rf auth`).

## 7. Pendiente

1. **Confirmar que la API key de Claude se está leyendo.** La key está cargada en
   `.env` (108 caracteres) pero nunca se llegó a ver la línea
   `Modo: sin prefijo | Claude: activo` porque el ruido tapaba el journal. Verificar:
   ```bash
   journalctl -u lista-compras-bot --no-pager | grep -E "Modo:|Conectado" | tail -5
   ```
2. **Validar la key contra la API** (una sola línea, no partir al pegar):
   ```bash
   CLAVE=$(grep '^ANTHROPIC_API_KEY=' ~/compras_agent/.env | cut -d= -f2) && curl -s -X POST https://api.anthropic.com/v1/messages -H "x-api-key: $CLAVE" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d '{"model":"claude-haiku-4-5-20251001","max_tokens":20,"messages":[{"role":"user","content":"deci ok"}]}'
   ```
3. **Re-vincular** para limpiar las sesiones Signal degradadas (opcional).
4. **Migrar a un número dedicado.** Hoy corre sobre el número personal con ~200
   grupos. Si WhatsApp detecta el cliente no oficial, el baneo cae sobre la cuenta
   personal.
5. **Terminar de configurar la agenda familiar** (21/07). El código está puesto y
   probado con mocks, falta la configuración real: credenciales OAuth de Google,
   `TARGET_GROUP_FAMILIA` y `npm install` en la EC2 (`googleapis`, `node-cron`
   son dependencias nuevas). Paso a paso en `calendario/README.md`.
   **Sin configurar, el módulo arranca apagado y no molesta a nadie.**
6. **Vigilar la RAM.** Ahora el proceso hace dos cosas. Si más adelante se
   separan en dos procesos (número dedicado), chequear `free -m` antes: cada
   instancia de Baileys anda en 150–250 MB y el número personal tiene ~200
   grupos.

## 8. Ideas no implementadas

**Lista de compras**

- Ordenar la lista por pasillo/categoría del súper
- Aprender items recurrentes y sugerir reposición
- Historial de compras / frecuencia
- Migrar `lista.json` a SQLite si crece

**Agenda**

- Recordatorio 1h antes de cada evento
- Editar eventos ("corré el turno del dentista a las 5")
- Recurrencias ("todos los martes fútbol")

## 9. Comandos operativos

```bash
sudo systemctl status lista-compras-bot      # estado
sudo systemctl restart lista-compras-bot     # reiniciar
journalctl -u lista-compras-bot -f           # logs en vivo
LOG_BAILEYS=warn npm start                   # ver el ruido interno (con el servicio parado)
cat ~/compras_agent/lista.json               # datos crudos
```

**Recordatorio:** nunca `npm start` y el servicio a la vez.
