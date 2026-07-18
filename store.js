// store.js — persistencia simple de la lista en un archivo JSON.
// Cada item: { id, texto, comprado, agregadoPor, fecha }

import { readFileSync, writeFileSync, existsSync } from "fs";

const FILE = process.env.DATA_FILE || "./lista.json";

function cargar() {
  if (!existsSync(FILE)) return { items: [] };
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { items: [] };
  }
}

function guardar(data) {
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function normalizar(texto) {
  return texto.trim().toLowerCase();
}

// Agrega uno o varios items. Ignora duplicados que sigan pendientes.
export function agregar(textos, agregadoPor = "") {
  const data = cargar();
  const agregados = [];
  for (const t of textos) {
    const texto = t.trim();
    if (!texto) continue;
    const yaEsta = data.items.find(
      (i) => !i.comprado && normalizar(i.texto) === normalizar(texto)
    );
    if (yaEsta) continue;
    const item = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      texto,
      comprado: false,
      agregadoPor,
      fecha: new Date().toISOString(),
    };
    data.items.push(item);
    agregados.push(item);
  }
  guardar(data);
  return agregados;
}

// Devuelve solo los pendientes.
export function pendientes() {
  return cargar().items.filter((i) => !i.comprado);
}

// Marca como comprado por texto (match parcial). Devuelve los items afectados.
export function marcarComprado(textos) {
  const data = cargar();
  const afectados = [];
  for (const t of textos) {
    const q = normalizar(t);
    if (!q) continue;
    for (const item of data.items) {
      if (!item.comprado && normalizar(item.texto).includes(q)) {
        item.comprado = true;
        afectados.push(item);
      }
    }
  }
  guardar(data);
  return afectados;
}

// Borra items pendientes por texto (match parcial). Devuelve los borrados.
export function borrar(textos) {
  const data = cargar();
  const borrados = [];
  for (const t of textos) {
    const q = normalizar(t);
    if (!q) continue;
    data.items = data.items.filter((item) => {
      const match = !item.comprado && normalizar(item.texto).includes(q);
      if (match) borrados.push(item);
      return !match;
    });
  }
  guardar(data);
  return borrados;
}

// Vacia toda la lista (o solo los comprados si soloComprados = true).
export function vaciar(soloComprados = false) {
  const data = cargar();
  if (soloComprados) {
    data.items = data.items.filter((i) => !i.comprado);
  } else {
    data.items = [];
  }
  guardar(data);
}
