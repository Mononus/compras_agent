# Módulo de agenda familiar

Segundo agente dentro del mismo proceso: atiende **otro grupo** de WhatsApp y
maneja un Google Calendar compartido.

- agenda eventos escritos en lenguaje natural
- **agenda desde una foto** (invitación, flyer) con visión de Claude
- responde consultas (`hoy`, `mañana`, `semana`, `qué tenemos el viernes`)
- todas las mañanas 07:30 manda los eventos del día
- los domingos 20:00 manda el resumen de la semana entrante

## Agendar desde una imagen

Si mandás una foto (invitación de cumpleaños, flyer, captura) con un epígrafe
que incluya una palabra clave —`agendá`, `anotá`, `cumple`, `invitación`,
`evento`, `turno`, `calendario`…— el bot baja la imagen, se la pasa a Claude
Haiku con visión y agenda el evento que encuentre (fecha, hora, lugar).

Una foto **sin** ese epígrafe se ignora, para no bajar ni mandar a la API cada
imagen del grupo. La descarga es *lazy*: `index.js` solo la baja si `agent.js`
decidió que el epígrafe dispara. Como la lectura puede fallar, la confirmación
aclara "_leído de la imagen, revisá que esté bien_". Imágenes de más de ~5 MB se
rechazan con un aviso.

## Por qué vive acá adentro y no en su propio repo

Una credencial de Baileys = una sesión = **un proceso**. Dos procesos con la
misma carpeta `auth/` se expulsan mutuamente en loop (`conflict: replaced`).
Como queremos usar el mismo número que la lista de compras, tiene que ser el
mismo proceso.

Lo que sí está separado es el código: todo el módulo vive en `calendario/` y
`index.js` solo lo llama. El acoplamiento son ~30 líneas.

```
        index.js  (1 socket de WhatsApp)
              │
      ┌───────┴────────┐
 grupo compras    grupo familia
      │                │
   store.js      calendario/agent.js
```

## Archivos

| | |
|---|---|
| `config.js` | variables de entorno. **Nunca tira excepción al importarse** |
| `agent.js` | núcleo: mensaje → intención → acción. No sabe de Baileys |
| `calendar.js` | Google Calendar: listar / crear / borrar / buscar |
| `google-auth.js` | cliente OAuth2 con refresh token |
| `llm.js` | interpretación con Claude (fetch directo, sin SDK) |
| `fechas.js` | timezone, fechas relativas, ISO con offset. Sin dependencias |
| `formato.js` | los textos que se mandan al grupo |
| `scheduler.js` | los cron de los resúmenes |
| `obtener-token.js` | helper de un solo uso para el OAuth |
| `probar.js` | verificación sin tocar WhatsApp |

## Autenticación: por qué service account y no OAuth

`https://www.googleapis.com/auth/calendar` es un scope **sensible** para
Google. Con OAuth de usuario eso te deja dos caminos, los dos malos para un
bot que corre solo:

| | |
|---|---|
| App en *Testing* | anda, pero el refresh token **caduca a los 7 días** |
| App *In production* | Google bloquea el scope hasta que verifiques la app — para Calendar, con video demostrativo incluido |

Una **service account** no pasa por nada de eso: es una identidad propia, sin
pantalla de consentimiento, y su acceso no vence. Compartís el calendario con
su email como si fuera una persona más.

Lo que una service account **no** puede hacer (y no nos importa acá): invitar
asistentes externos sin Google Workspace, ni acceder a tu calendario personal
si no se lo compartiste.

El módulo soporta los dos modos y elige según lo que haya en el `.env`.
`node calendario/probar.js quien` te dice cuál está usando.

## Setup

### 1. Calendario compartido

En calendar.google.com → *Otros calendarios* → **Crear calendario**.
Compartilo con la familia dándoles *Hacer cambios en los eventos*.

### 2. Service account

En [console.cloud.google.com](https://console.cloud.google.com):

1. Crear proyecto (o usar el que ya tengas)
2. *APIs y servicios* → **Habilitar** → **Google Calendar API**
3. *IAM y administración* → **Cuentas de servicio** → **Crear cuenta de servicio**
   - nombre: `agenda-bot`
   - los pasos de "conceder acceso al proyecto" y "usuarios" se saltean
4. Entrar a la cuenta creada → pestaña **Claves** → *Agregar clave* →
   **Crear clave nueva** → tipo **JSON** → se descarga el archivo

Ese JSON es la credencial. Guardalo en el servidor (nunca en el repo).

### 3. Compartir el calendario con la cuenta

El JSON tiene un campo `client_email`, algo como
`agenda-bot@tu-proyecto.iam.gserviceaccount.com`. Para verlo:

```bash
node calendario/probar.js quien
```

En Google Calendar → calendario familiar → *Configuración y uso compartido* →
**Compartir con determinadas personas** → *Añadir* → pegás ese email →
permiso **Hacer cambios en los eventos**.

En esa misma pantalla, más abajo, *Integrar calendario* → **ID de calendario**:
ese valor va en `GOOGLE_CALENDAR_ID`.

> Si el bot dice "no veo el calendario", es que falta este paso o que Google
> todavía no propagó el permiso. Esperá un minuto y reintentá.

### 4. Variables

Copiá al `.env` de la EC2 el bloque de agenda de `.env.example`. Para el
`TARGET_GROUP_FAMILIA`, mirá el arranque del bot: si `TARGET_GROUP` está vacío
lista todos los grupos con su JID.

### 5. Probar antes de reiniciar

```bash
node calendario/probar.js quien        # con qué identidad se conecta
node calendario/probar.js calendarios  # calendarios visibles y su ID
npm run agenda:probar                  # lee el calendario, imprime los resúmenes
node calendario/probar.js crear        # crea y borra un evento: valida escritura
npm run agenda:parse                   # qué devuelve Claude para frases de ejemplo
```

Si estos pasan, el grueso del riesgo ya está cubierto.

### 6. Deploy

```bash
# en la EC2
cd ~/compras_agent
git pull
npm install            # googleapis y node-cron son nuevos
sudo systemctl restart lista-compras-bot
journalctl -u lista-compras-bot -f | grep -E "📅|Conectado|Modo:"
```

Buscá `📅 Agenda familiar: activa en ...` y
`📅 Resúmenes: diario "30 7 * * *" | semanal "0 20 * * 0"`.

Después, en el grupo familiar, escribí `ayuda`.

## Si algo sale mal

El módulo está diseñado para **fallar solo**, sin llevarse puesta la lista de
compras:

- falta configuración de Google → arranca deshabilitado y lo dice en el log
- error de la API de Google → lo avisa en el grupo, no tira el proceso
- `TZ_AGENDA` mal escrita → los resúmenes no se programan, el resto anda
- para apagarlo del todo: vaciá `TARGET_GROUP_FAMILIA` y reiniciá

| Síntoma | Causa probable |
|---|---|
| `📅 Agenda familiar: apagada (falta ...)` | justamente eso, en el `.env` |
| `Insufficient Permission` | el token no tiene el scope de Calendar |
| `access_denied` al autorizar | scope sensible con OAuth → pasate a service account |
| `Not Found` / "no veo el calendario" | falta compartir el calendario con la service account |
| `invalid_grant` (solo OAuth) | refresh token vencido: modo *Testing* caduca a los 7 días |
| `notFound` | `GOOGLE_CALENDAR_ID` mal copiado |
| Crea eventos y nadie los ve | los está creando en tu calendario personal |
| No llega el resumen matutino | ¿el día estaba vacío? Si no hay eventos no escribe. Chequeá `TZ_AGENDA` |
| Resumen duplicado | dos procesos corriendo (`systemctl status`) |
| No responde en el grupo | ¿`TARGET_GROUP_FAMILIA` es el JID correcto? |

Forzar un resumen a mano:

```bash
node --input-type=module -e "
import 'dotenv/config';
const {crearAgente} = await import('./calendario/agent.js');
const a = crearAgente({ wa: { enviarTexto: (j,t) => console.log(t) } });
await a.resumenDiario();
"
```

## Costo de API

El grupo familiar **no** es dedicado como el de compras: hay mucha charla que
no es agenda. Por eso `agent.js` tiene un prefiltro regex (`PISTAS`): si el
mensaje no menciona días, horarios, turnos ni eventos, ni siquiera llama a
Claude. Si ves pedidos que se le escapan, ampliá esa regex antes de tocar
otra cosa.

## Pendiente

- Recordatorio 1h antes de cada evento
- Editar eventos ("corré el turno del dentista a las 5")
- Recurrencias ("todos los martes fútbol")
- Filtrar por persona ("los eventos de Mati")
