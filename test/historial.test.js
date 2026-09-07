// Tests de las dos funciones puras de lib/historial.js.
// Sin red, sin credenciales, sin Firestore: `npm test` corre offline.
const test = require('node:test');
const assert = require('node:assert');

const { construirRegistro, calcularRanking } = require('../lib/historial.js');

const IDS = ['claudio', 'ferchos', 'bombo', 'pitrisio'];

// ---------- construirRegistro ----------

test('construirRegistro marca un ganador unico sin empate', () => {
    const r = construirRegistro({
        puntajes: { claudio: 2, ferchos: 5, bombo: 0, pitrisio: 4 },
        modo: 'estrellas',
        jugadores: IDS,
    });
    assert.deepStrictEqual(r.ganadores, ['ferchos']);
    assert.strictEqual(r.empate, false);
    assert.strictEqual(r.tipo, 'estrellas');
    assert.strictEqual(r.unidad, 'pts');
});

test('construirRegistro guarda todos los ganadores de un empate', () => {
    const r = construirRegistro({
        puntajes: { claudio: 5, ferchos: 5, bombo: 1, pitrisio: 0 },
        modo: 'normal',
        jugadores: IDS,
    });
    assert.deepStrictEqual(r.ganadores.sort(), ['claudio', 'ferchos']);
    assert.strictEqual(r.empate, true);
});

test('construirRegistro usa "votos" en modo normal y "pts" en estrellas', () => {
    const base = { puntajes: { a: 1, b: 0 }, jugadores: ['a', 'b'] };
    assert.strictEqual(construirRegistro({ ...base, modo: 'normal' }).unidad, 'votos');
    assert.strictEqual(construirRegistro({ ...base, modo: 'estrellas' }).unidad, 'pts');
});

test('construirRegistro no incluye fecha: la pone Firestore', () => {
    const r = construirRegistro({ puntajes: { a: 1 }, modo: 'normal', jugadores: ['a'] });
    assert.strictEqual('fecha' in r, false);
});

test('construirRegistro no comparte referencias con la entrada', () => {
    const puntajes = { a: 1, b: 0 };
    const jugadores = ['a', 'b'];
    const r = construirRegistro({ puntajes, modo: 'normal', jugadores });
    puntajes.a = 99;
    jugadores.push('c');
    assert.strictEqual(r.puntajes.a, 1);
    assert.strictEqual(r.jugadores.length, 2);
});

// ---------- calcularRanking ----------

const REGISTROS = [
    { tipo: 'estrellas', ganadores: ['ferchos'],          fecha: '2026-09-01T20:00:00.000Z' },
    { tipo: 'estrellas', ganadores: ['ferchos'],          fecha: '2026-09-05T20:00:00.000Z' },
    { tipo: 'normal',    ganadores: ['claudio'],          fecha: '2026-09-05T21:00:00.000Z' },
    { tipo: 'normal',    ganadores: ['claudio', 'bombo'], fecha: '2026-09-06T22:00:00.000Z' },
];

test('calcularRanking cuenta torneos y rondas por separado', () => {
    const porId = Object.fromEntries(calcularRanking(REGISTROS, IDS).map(f => [f.id, f]));
    assert.strictEqual(porId.ferchos.torneos, 2);
    assert.strictEqual(porId.ferchos.rondas, 0);
    assert.strictEqual(porId.claudio.torneos, 0);
    assert.strictEqual(porId.claudio.rondas, 2);
});

test('calcularRanking cuenta un empate como victoria para cada ganador', () => {
    const porId = Object.fromEntries(calcularRanking(REGISTROS, IDS).map(f => [f.id, f]));
    assert.strictEqual(porId.bombo.rondas, 1);
});

test('calcularRanking incluye en cero a quien nunca gano', () => {
    const pitrisio = calcularRanking(REGISTROS, IDS).find(f => f.id === 'pitrisio');
    assert.strictEqual(pitrisio.torneos, 0);
    assert.strictEqual(pitrisio.rondas, 0);
    assert.strictEqual(pitrisio.ultimaVictoria, null);
});

test('calcularRanking ordena por torneos, luego rondas, luego id', () => {
    assert.deepStrictEqual(
        calcularRanking(REGISTROS, IDS).map(f => f.id),
        ['ferchos', 'claudio', 'bombo', 'pitrisio'],
    );
});

test('calcularRanking guarda la fecha de la ultima victoria', () => {
    const porId = Object.fromEntries(calcularRanking(REGISTROS, IDS).map(f => [f.id, f]));
    assert.strictEqual(porId.ferchos.ultimaVictoria, '2026-09-05T20:00:00.000Z');
    assert.strictEqual(porId.claudio.ultimaVictoria, '2026-09-06T22:00:00.000Z');
});

test('calcularRanking sin registros devuelve todos en cero', () => {
    const r = calcularRanking([], IDS);
    assert.strictEqual(r.length, 4);
    assert.ok(r.every(f => f.torneos === 0 && f.rondas === 0));
});

test('calcularRanking ignora ganadores que ya no estan en concursantes.json', () => {
    const r = calcularRanking(
        [{ tipo: 'normal', ganadores: ['fantasma'], fecha: '2026-09-01T00:00:00.000Z' }],
        IDS,
    );
    assert.strictEqual(r.length, 4);
    assert.ok(r.every(f => f.rondas === 0));
});
