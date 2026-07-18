# 🛒 Bot de lista de compras para WhatsApp

Un bot que vive en un grupo de WhatsApp (vos, tu mujer y quien quieras) para armar
la lista de compras entre todos y consultarla cuando estás en el súper.

## Qué hace

- `!agregar leche, pan, huevos` — suma cosas a la lista
- `!lista` — muestra lo que falta comprar
- `!compre leche` — marca un item como comprado (lo saca de la lista)
- `!borrar pan` — saca algo sin haberlo comprado
- `!vaciar` — limpia toda la lista
- `!ayuda` — muestra los comandos

Si activás la API de Claude (opcional), también entiende lenguaje natural:
`! comprá yogur y ya tengo la leche` → agrega yogur y marca la leche como comprada.

---

## ⚠️ Antes de empezar: sobre WhatsApp y grupos

La **API oficial de WhatsApp (Cloud API) NO soporta grupos**, solo chats 1-a-1 con
un número de empresa. Como vos querés que funcione en un **grupo**, este bot usa
**Baileys**, una librería que se conecta con el protocolo de WhatsApp Web
(vinculás un número escaneando un QR, igual que WhatsApp Web en la compu).

Esto tiene una implicancia importante:

> Usar clientes no oficiales va contra los Términos de Servicio de WhatsApp.
> Es muy común para bots personales/familiares y funciona bien, pero **existe un
> riesgo (bajo pero real) de que el número quede baneado**. Por eso se recomienda
> usar un **número dedicado** (un chip barato o un número secundario), no tu número
> personal principal.

Ese número dedicado es el que va a "ser" el bot dentro del grupo.

---

## Instalación local (para probar)

Requisitos: Node.js 20 o superior.

```bash
cd lista-compras-bot
npm install
cp .env.example .env      # editá el .env si querés (opcional al principio)
npm start
```

Al arrancar, aparece un **código QR en la terminal**. Desde el WhatsApp del número
que va a ser el bot: **Ajustes → Dispositivos vinculados → Vincular un dispositivo**
y escaneá el QR. Listo, queda conectado.

### Configurar el grupo objetivo

1. Con el bot corriendo y `TARGET_GROUP` vacío, escribí cualquier mensaje en el
   grupo donde lo quieras usar.
2. En la terminal vas a ver algo como:
   `📍 Mensaje en grupo con JID: 120363012345678901@g.us`
3. Copiá ese JID a `TARGET_GROUP` en el `.env` y reiniciá (`npm start`).

A partir de ahí el bot solo responde en ese grupo e ignora todo lo demás.

> Asegurate de agregar el número del bot al grupo de WhatsApp.

---

## (Opcional) Lenguaje natural con Claude

Si querés que entienda frases sueltas en vez de solo comandos:

1. Conseguí una API key en https://console.anthropic.com
2. Ponela en `.env` como `ANTHROPIC_API_KEY=...`

Sin esto, el bot funciona igual con los comandos `!`.

---

## Desplegar 24/7

Ver **[DEPLOY-EC2.md](DEPLOY-EC2.md)** para la guía completa en Amazon EC2
(incluye qué instancia necesitás y cómo dejarlo corriendo con systemd).

También funciona en Railway, Render, Fly.io o cualquier VPS. Lo importante en
cualquier caso: que la carpeta `auth/` y el archivo `lista.json` **persistan**
entre reinicios, si no vas a tener que re-escanear el QR y perdés la lista.

---

## Estructura

```
lista-compras-bot/
├── index.js                    # bot: conexión a WhatsApp y comandos
├── store.js                    # persistencia de la lista (JSON)
├── llm.js                      # parseo natural opcional con Claude
├── lista-compras-bot.service   # unit de systemd para EC2
├── package.json
├── .env.example
├── DEPLOY-EC2.md
└── README.md
```

## Notas

- Los datos se guardan en `lista.json` (texto plano). Para varias listas o más
  robustez se puede migrar a SQLite fácil.
- La sesión de WhatsApp queda en `auth/`. Si borrás esa carpeta, hay que re-escanear
  el QR.
- Si el número se desconecta (ej. cerraste sesión desde el celu), el bot intenta
  reconectar solo; si fue logout total, hay que vincular de nuevo.
- `.gitignore` ya excluye `.env`, `auth/` y `lista.json`: nunca subas esos a GitHub.
