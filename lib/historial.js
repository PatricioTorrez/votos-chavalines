// Historial de torneos en Cloud Firestore.
//
// Este es el UNICO archivo que conoce Firestore. server.js no importa
// firebase-admin ni sabe como se llaman las colecciones.
//
// Las dos funciones de abajo son puras: sin red, sin reloj, sin Firestore.
// Son el nucleo testeable y por eso `npm test` corre offline y sin credenciales.

const fs = require('node:fs');
const path = require('node:path');

const COLECCION    = 'torneos';
const TOPE_LECTURA = 500;   // red de contencion; si se alcanza, revisar el diseño

let db = null;
let proyecto = null;

// Arma el documento a partir de lo que ya calculo el servidor.
// NO incluye `fecha`: esa la pone Firestore al escribir (ver guardar()).
//   puntajes   { id: numero }  — el conteo tal cual lo calculo el servidor
//   modo       'normal' | 'estrellas'
//   jugadores  [id]            — los conectados al cerrar, no todos los
//                                concursantes: si alguien no jugo esa noche,
//                                no deberia contar como que perdio
function construirRegistro({ puntajes, modo, jugadores }) {
    const entradas = Object.entries(puntajes);
    if (!entradas.length) {
        throw new Error('construirRegistro necesita al menos un puntaje');
    }

    const max = Math.max(...entradas.map(([, n]) => n));
    const ganadores = entradas.filter(([, n]) => n === max).map(([id]) => id);
    const esEstrellas = modo === 'estrellas';

    return {
        tipo: esEstrellas ? 'estrellas' : 'normal',
        ganadores,
        empate: ganadores.length > 1,
        puntajes: { ...puntajes },
        unidad: esEstrellas ? 'pts' : 'votos',
        jugadores: [...jugadores],
    };
}

// Cuenta victorias por concursante.
//   registros  los documentos leidos, con `fecha` ya como string ISO
//   ids        todos los ids de data/concursantes.json, para incluir tambien a
//              los que nunca ganaron
//
// Un empate cuenta como victoria para cada uno de los ganadores.
// Torneos y rondas se cuentan por separado a proposito: las rondas normales son
// muchas por noche y taparian a los torneos, que son pocos y significativos.
function calcularRanking(registros, ids) {
    const filas = new Map(
        ids.map(id => [id, { id, torneos: 0, rondas: 0, ultimaVictoria: null }]),
    );

    for (const registro of registros) {
        for (const id of registro.ganadores || []) {
            const fila = filas.get(id);
            if (!fila) continue;   // gano alguien que ya no esta en concursantes.json
            if (registro.tipo === 'estrellas') fila.torneos++;
            else fila.rondas++;
            // Fechas ISO: comparar como string ordena cronologicamente.
            if (!fila.ultimaVictoria || registro.fecha > fila.ultimaVictoria) {
                fila.ultimaVictoria = registro.fecha;
            }
        }
    }

    return [...filas.values()].sort((a, b) =>
        b.torneos - a.torneos ||
        b.rondas - a.rondas ||
        a.id.localeCompare(b.id),
    );
}

// ============================================================
//  FIRESTORE
//  firebase-admin se require adentro de las funciones, nunca al cargar el
//  modulo: asi `npm test` no lo carga y corre rapido, offline y sin claves.
//  API modular de firebase-admin v14 (en v11/v12 era admin.firestore()).
// ============================================================

// Busca credenciales en tres lugares, en orden:
//   1. FIREBASE_SERVICE_ACCOUNT — el JSON entero en una variable de entorno.
//      Es la forma de configurarlo en un host como Render, donde no se puede
//      dejar un archivo con la clave.
//   2. GOOGLE_APPLICATION_CREDENTIALS (forma estandar de Google)
//   3. serviceAccountKey.json en la raiz del proyecto
// Devuelve el objeto parseado, o null si no hay credencial en ningun lado.
function leerCredencial() {
    const inline = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
    if (inline) {
        // Hay paneles que no dejan pegar saltos de linea, asi que tambien se
        // acepta el mismo JSON en base64.
        const texto = inline.startsWith('{')
            ? inline
            : Buffer.from(inline, 'base64').toString('utf8');
        if (!texto.trimStart().startsWith('{')) {
            // Sin este chequeo, un valor mal pegado sale como un error de JSON
            // sobre bytes ilegibles y no se entiende de donde viene.
            throw new Error('FIREBASE_SERVICE_ACCOUNT no es el JSON de la clave de servicio (ni ese JSON en base64)');
        }
        return JSON.parse(texto);
    }

    const ruta = process.env.GOOGLE_APPLICATION_CREDENTIALS
        || path.join(__dirname, '..', 'serviceAccountKey.json');

    if (!fs.existsSync(ruta)) return null;
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
}

// No tener credenciales NO es un error: la app funciona igual, sin historial.
function iniciar() {
    if (db) return true;

    try {
        const credencial = leerCredencial();
        if (!credencial) return false;

        const { initializeApp, cert, getApps } = require('firebase-admin/app');
        const { getFirestore } = require('firebase-admin/firestore');

        const app = getApps().length
            ? getApps()[0]
            : initializeApp({ credential: cert(credencial) });

        db = getFirestore(app);
        proyecto = credencial.project_id || null;
        return true;
    } catch (err) {
        console.error('⚠️  No se pudo iniciar Firestore:', err.message);
        db = null;
        return false;
    }
}

function disponible()     { return db !== null; }
function proyectoActual() { return proyecto; }

// Fire-and-forget: NUNCA rechaza. Un registro perdido es aceptable; que un
// problema de red demore la pantalla de resultados, no.
async function guardar(registro) {
    if (!db) return;
    try {
        const { FieldValue } = require('firebase-admin/firestore');
        await db.collection(COLECCION).add({
            ...registro,
            // La fecha la pone Firestore, no el reloj del anfitrion.
            fecha: FieldValue.serverTimestamp(),
        });
    } catch (err) {
        console.error('⚠️  No se pudo guardar el registro del torneo:', err.message);
    }
}

// A diferencia de guardar(), esta SI lanza: el que llama decide que mostrarle
// al admin. El orderBy de un solo campo usa los indices automaticos de
// Firestore, asi que no hay que crear ningun indice a mano.
async function obtenerHistorial(ids) {
    if (!db) throw new Error('Firestore no esta configurado');

    const snap = await db.collection(COLECCION)
        .orderBy('fecha', 'desc')
        .limit(TOPE_LECTURA)
        .get();

    const registros = snap.docs.map(doc => {
        const d = doc.data();
        return {
            id: doc.id,
            tipo: d.tipo,
            ganadores: d.ganadores || [],
            empate: !!d.empate,
            puntajes: d.puntajes || {},
            unidad: d.unidad,
            jugadores: d.jugadores || [],
            // A string ISO: el cliente no necesita nada de Firebase.
            fecha: d.fecha?.toDate?.().toISOString() || null,
        };
    });

    return { ranking: calcularRanking(registros, ids), registros };
}

module.exports = {
    construirRegistro,
    calcularRanking,
    iniciar,
    disponible,
    proyectoActual,
    guardar,
    obtenerHistorial,
};
