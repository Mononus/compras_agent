# Desplegar el bot en Amazon EC2

## 1. Qué capacidad necesitás

El bot es un proceso Node.js liviano (Baileys mantiene un websocket a WhatsApp).
No sirve tráfico web ni hace cómputo pesado, así que la instancia más chica alcanza.

| Recurso     | Recomendado                          | Mínimo que funciona      |
|-------------|--------------------------------------|--------------------------|
| Instancia   | **t3.micro** (x86) o **t4g.micro** (ARM/Graviton, más barato) | t3.nano / t4g.nano |
| vCPU        | 2 (burstable, casi siempre en idle)  | 1                        |
| RAM         | **1 GiB**                            | 0.5 GiB (justo, sin margen) |
| Disco       | 8 GiB gp3 (el default sobra)         | 8 GiB                    |
| SO          | Ubuntu 22.04 LTS o Amazon Linux 2023 | —                        |

Consumo real en marcha: **~150–250 MB de RAM** y CPU prácticamente en cero.

**Costo aproximado (on-demand):** t4g.micro ≈ US$6–8/mes; t3.micro ≈ US$8–9/mes.
Si tu cuenta todavía tiene **Free Tier** (primer año), `t2.micro`/`t3.micro` entran
en las 750 hs/mes gratis.

> **Importante:** no necesitás IP fija ni puertos de entrada. El bot solo hace
> conexiones **salientes** (a WhatsApp y, opcional, a la API de Claude). Alcanza con
> el puerto 22 (SSH) abierto solo a tu IP.

---

## 2. Crear la instancia

1. Consola de AWS → **EC2 → Launch instance**.
2. **Nombre:** `lista-compras-bot`.
3. **AMI:** Ubuntu Server 22.04 LTS. Si elegís **t4g.micro**, usá la AMI **ARM
   (64-bit Arm)**; para t3.micro usá **x86_64**.
4. **Instance type:** `t3.micro` (o `t4g.micro`).
5. **Key pair:** creá o elegí una `.pem` para poder entrar por SSH.
6. **Security group:** permití solo **SSH (22)** desde **My IP**.
7. **Storage:** 8 GiB gp3 (default).
8. **Launch instance.**

---

## 3. Conectarte e instalar Node

```bash
ssh -i mi-key.pem ubuntu@LA_IP_PUBLICA
```

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # v20.x
```

> En **Amazon Linux 2023**: `sudo dnf install -y nodejs20 git`.

---

## 4. Traer el proyecto desde GitHub

```bash
git clone https://github.com/TU_USUARIO/lista-compras-bot.git
cd lista-compras-bot
npm install
cp .env.example .env
nano .env          # dejá TARGET_GROUP vacío por ahora
```

> Si el repo es **privado**, el `git clone` te va a pedir credenciales: usá un
> Personal Access Token como contraseña (ver GITHUB.md), o hacé el repo público
> si no te molesta (no hay secretos en el código, están todos en `.env`).

---

## 5. Primer arranque: vincular WhatsApp (QR)

```bash
npm start
```

Aparece el QR en la terminal. En el celu del **número que será el bot**:
**Ajustes → Dispositivos vinculados → Vincular un dispositivo** y escaneá.

Cuando veas `✅ Conectado a WhatsApp`, escribí un mensaje en el grupo objetivo.
En la terminal aparece:

```
📍 Mensaje en grupo con JID: 120363012345678901@g.us
```

`Ctrl+C`, y copiá ese JID al `.env`:

```bash
nano .env    # TARGET_GROUP=120363012345678901@g.us
```

La sesión queda en `auth/`, así que no vas a re-escanear el QR en cada reinicio.

---

## 6. Dejarlo corriendo 24/7 con systemd

```bash
sudo cp ~/lista-compras-bot/lista-compras-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lista-compras-bot
```

Comandos útiles:

```bash
sudo systemctl status lista-compras-bot     # estado
journalctl -u lista-compras-bot -f          # logs en vivo (por si pide QR)
sudo systemctl restart lista-compras-bot    # reiniciar
```

`systemd` lo levanta al bootear la instancia y lo reinicia solo si se cae.

> Si usás Amazon Linux, cambiá en el `.service` el `User` a `ec2-user` y el
> `WorkingDirectory` a `/home/ec2-user/lista-compras-bot`.

---

## 7. Mantenimiento

- **Backups:** lo único importante es la carpeta `auth/` (sesión de WhatsApp) y
  `lista.json` (la lista). Copialos de vez en cuando.
- **Actualizar el código:** `git pull` y `sudo systemctl restart lista-compras-bot`.
- **Se desconectó / pide QR:** mirá `journalctl -u lista-compras-bot -f`; si aparece
  un QR, escaneá de nuevo desde el celu.
