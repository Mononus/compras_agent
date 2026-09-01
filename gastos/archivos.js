// gastos/archivos.js — guardado de comprobantes en disco.
//
// Los comprobantes van a COMPROBANTES_DIR/<periodo>/<slug>-<timestamp>.<ext>.
// Guardamos el archivo (no solo el id de WhatsApp) porque los medios de
// WhatsApp caducan: en un par de meses el id ya no baja nada.

import { mkdirSync, writeFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import { normalizar } from "./store.js";

const EXT_POR_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

export function extensionDe(mime = "", nombre = "") {
  const porNombre = (nombre.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  return EXT_POR_MIME[mime.toLowerCase()] || (porNombre ? porNombre.toLowerCase() : "bin");
}

export function slug(texto) {
  return (
    normalizar(texto)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "comprobante"
  );
}

/**
 * Escribe el comprobante y devuelve el registro que se guarda en gastos.json.
 * @param {string} base64  contenido del archivo
 */
export function guardarComprobante({ base64, mime = "application/octet-stream", nombre = "", periodo, etiqueta }) {
  const dir = join(config.comprobantesDir, periodo);
  mkdirSync(dir, { recursive: true });

  const ext = extensionDe(mime, nombre);
  const archivo = join(dir, `${slug(etiqueta)}-${Date.now().toString(36)}.${ext}`);
  const buffer = Buffer.from(base64, "base64");
  writeFileSync(archivo, buffer);

  return {
    archivo,
    mime,
    nombre: nombre || null,
    bytes: buffer.length,
    fecha: new Date().toISOString(),
  };
}

/** Renombra la etiqueta de un comprobante ya guardado (best effort). */
export function existe(comprobante) {
  try {
    return Boolean(comprobante?.archivo) && existsSync(comprobante.archivo) && statSync(comprobante.archivo).size > 0;
  } catch {
    return false;
  }
}

export function excedeLimite(base64) {
  // base64 abulta ~4/3. Convertimos a bytes reales antes de comparar.
  const bytes = Math.floor((base64?.length || 0) * 0.75);
  return bytes > config.maxComprobanteMb * 1024 * 1024;
}
