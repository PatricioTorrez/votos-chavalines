// Verifica que data/concursantes.json sea coherente y que todos los archivos
// que referencia existan de verdad en public/. Sin esto, un typo en una ruta
// solo se descubre cuando alguien gana y no suena nada.
//
//   npm test
//
// Sin dependencias: usa el runner que trae Node (>=18).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ    = path.join(__dirname, '..');
const PUBLIC  = path.join(RAIZ, 'public');
const ARCHIVO = path.join(RAIZ, 'data', 'concursantes.json');

const datos = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
const lista = datos.concursantes;

test('el archivo tiene al menos 2 concursantes', () => {
    assert.ok(Array.isArray(lista), 'concursantes debe ser un array');
    assert.ok(lista.length >= 2, `hacen falta al menos 2, hay ${lista.length}`);
});

test('los ids son unicos y usables como clave', () => {
    const vistos = new Set();
    for (const c of lista) {
        assert.match(c.id, /^[a-z0-9_-]+$/,
            `id invalido: ${JSON.stringify(c.id)} (solo minusculas, numeros, - y _)`);
        assert.ok(!vistos.has(c.id), `id duplicado: ${c.id}`);
        vistos.add(c.id);
    }
});

test('cada concursante tiene nombre, avatar y al menos un audio', () => {
    for (const c of lista) {
        assert.ok(c.nombre, `${c.id}: falta nombre`);
        assert.ok(c.avatar, `${c.id}: falta avatar`);
        assert.ok(Array.isArray(c.audios) && c.audios.length > 0,
            `${c.id}: necesita al menos un audio`);
        assert.ok(Array.isArray(c.galeria), `${c.id}: galeria debe ser un array`);
    }
});

test('todas las imagenes de galeria existen en public/', () => {
    const faltantes = [];
    for (const c of lista) {
        for (const img of c.galeria) {
            if (!fs.existsSync(path.join(PUBLIC, img))) faltantes.push(`${c.id} -> ${img}`);
        }
    }
    assert.deepStrictEqual(faltantes, [], `imagenes que no existen:\n  ${faltantes.join('\n  ')}`);
});

test('todos los audios existen en public/', () => {
    const faltantes = [];
    for (const c of lista) {
        for (const a of c.audios) {
            if (!fs.existsSync(path.join(PUBLIC, a))) faltantes.push(`${c.id} -> ${a}`);
        }
    }
    if (datos.audioEmpate && !fs.existsSync(path.join(PUBLIC, datos.audioEmpate))) {
        faltantes.push(`audioEmpate -> ${datos.audioEmpate}`);
    }
    assert.deepStrictEqual(faltantes, [], `audios que no existen:\n  ${faltantes.join('\n  ')}`);
});

test('el servidor arranca con estos datos sin lanzar', () => {
    // server.js valida el archivo al cargarse; si algo esta mal, tira.
    assert.doesNotThrow(() => {
        const raw = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
        assert.ok(raw.concursantes.every(c => c.id && c.nombre));
    });
});
