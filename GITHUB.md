# Subir el proyecto a GitHub

Para este proyecto, subirlo **desde la web de GitHub** alcanza y sobra: no necesitás
terminal ni configurar autenticación. Al final está también la opción con git.

---

# Opción rápida — subir desde la web

## 1. Abrí la carpeta del proyecto en el Finder

Los archivos están en tu carpeta **Descargas**, dentro de `lista 2`.

## 2. Mostrá los archivos ocultos

Dos archivos empiezan con punto (`.gitignore` y `.env.example`) y el Finder los
esconde. Con la ventana del Finder abierta apretá:

**`Cmd` + `Shift` + `.`**

Ahora los vas a ver (aparecen medio transparentes).

## 3. Subilos a GitHub

1. Entrá a tu repositorio vacío en github.com.
2. Clic en **"uploading an existing file"** (link en el medio de la página), o en
   **Add file → Upload files**.
3. Seleccioná y arrastrá al navegador **estos 10 archivos** (los archivos sueltos,
   NO la carpeta que los contiene):

   ```
   index.js
   store.js
   llm.js
   package.json
   README.md
   DEPLOY-EC2.md
   GITHUB.md
   lista-compras-bot.service
   .gitignore
   .env.example
   ```

4. Abajo escribí un mensaje tipo `Bot de lista de compras para WhatsApp` y clic en
   **Commit changes**.

Listo. Si algún archivo oculto no se sube al arrastrarlo, podés crearlo a mano en
GitHub con **Add file → Create new file**, poniéndole el nombre con el punto adelante
y pegando el contenido.

## ⚠️ Qué NO subir

Estos archivos no existen todavía, pero van a aparecer cuando corras el bot. Nunca
los subas:

| No subir        | Por qué |
|-----------------|---------|
| `.env`          | Va a tener tu API key |
| `auth/`         | Es la sesión de WhatsApp — con eso cualquiera entra a tu cuenta |
| `lista.json`    | Los datos de tu lista |
| `node_modules/` | Pesa muchísimo y se regenera con `npm install` |
| `.DS_Store`     | Basura de macOS |

Ojo con la diferencia: subí `.env.example` (la plantilla vacía), **nunca** `.env`.
El `.gitignore` ya los excluye para el futuro.

## 4. Después, en la EC2

```bash
git clone https://github.com/TU_USUARIO/lista-compras-bot.git
```

## Para cambios futuros

Desde la web podés editar cualquier archivo con el ícono del lápiz, o volver a
**Add file → Upload files**. Y en la EC2:

```bash
cd ~/lista-compras-bot
git pull
sudo systemctl restart lista-compras-bot
```

---

# Opción con terminal (git)

Más trabajo la primera vez, pero después actualizar es un solo `git push`.

## 1. Inicializá el repo

```bash
cd ~/Downloads/lista\ 2
git init -b main
git add .
git commit -m "Bot de lista de compras para WhatsApp"
```

Si es tu primera vez con git en esta compu:

```bash
git config --global user.name "Mariano"
git config --global user.email "cmdozo@gmail.com"
```

Chequeá que no se cuelen archivos sensibles:

```bash
git ls-files
```

## 2. Conectá el repositorio y pusheá

```bash
git remote add origin https://github.com/TU_USUARIO/lista-compras-bot.git
git push -u origin main
```

## 3. Autenticarte

GitHub ya no acepta tu contraseña en la terminal. Opciones:

### A — GitHub CLI (la más fácil)

```bash
brew install gh      # si no tenés Homebrew: https://brew.sh
gh auth login
```

Elegí `GitHub.com` → `HTTPS` → `Login with a web browser`. Después el push sale solo.

### B — Personal Access Token

1. GitHub → perfil → **Settings** → **Developer settings** →
   **Personal access tokens** → **Tokens (classic)** → **Generate new token**.
2. Marcá el scope **`repo`**, generá y copiá el token (se muestra una sola vez).
3. En el `git push`: usuario = tu usuario de GitHub, password = **el token**.

Para que no lo pida cada vez: `git config --global credential.helper osxkeychain`

### C — Clave SSH

```bash
ssh-keygen -t ed25519 -C "cmdozo@gmail.com"     # Enter en todo
cat ~/.ssh/id_ed25519.pub                        # copiá la salida
```

Pegala en GitHub → Settings → **SSH and GPG keys** → New SSH key. Después:

```bash
git remote set-url origin git@github.com:TU_USUARIO/lista-compras-bot.git
git push -u origin main
```
