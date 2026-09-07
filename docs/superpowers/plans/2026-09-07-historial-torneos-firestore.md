# Historial de torneos en Firestore — Plan de implementación

> **Para agentes ejecutores:** SUB-SKILL REQUERIDA: usar
> `superpowers:subagent-driven-development` (recomendado) o
> `superpowers:executing-plans` para ejecutar tarea por tarea. Los pasos usan
> checkbox (`- [ ]`) para seguimiento.

**Goal:** Guardar cada torneo y cada ronda terminada en Cloud Firestore, y
mostrar en el panel de admin quién ganó más veces y cuándo.

**Architecture:** El servidor Node es el único que habla con Firestore, vía
`firebase-admin`, porque es el único que calcula el ganador de forma
autoritativa y porque la app se sirve por una URL pública sin autenticación.
Todo Firestore vive aislado en `lib/historial.js`; el navegador nunca lo toca y
recibe el historial por el canal de Socket.IO que ya existe.

**Tech Stack:** Node.js ≥18 (CommonJS), Express 5, Socket.IO 4,
`firebase-admin`, runner de tests nativo de Node (`node --test`).

**Spec:** `docs/superpowers/specs/2026-09-07-historial-torneos-firestore-design.md`

## Global Constraints

- **CommonJS** (`require` / `module.exports`). No hay build step ni bundler.
- **Sin dependencias de test.** `npm test` es `node --test` y debe correr
  **offline y sin credenciales de Firebase**. Nada que testeemos puede tocar la
  red.
- **El id es la clave.** Nunca guardar ni indexar por nombre visible. Los
  nombres viven en `data/concursantes.json` y son presentación.
- **Cero Firebase en el navegador.** Ni SDK, ni config, ni claves en
  `public/`.
- **El historial nunca puede degradar la partida.** Ninguna escritura se
  `await`ea en el camino del juego; ningún fallo de Firestore puede demorar o
  romper la pantalla de resultados.
- **NO hacer commits automáticos.** El usuario los hace. Cada tarea termina en
  un paso de verificación, no en `git commit`.
- Comentarios y mensajes de usuario en **español**, siguiendo el código
  existente.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `lib/historial.js` | **nuevo.** Todo Firestore: conexión, escritura, lectura, y las dos funciones puras (armar documento, calcular ranking). Único lugar que importa `firebase-admin`. |
| `test/historial.test.js` | **nuevo.** Tests de las funciones puras. Sin red. |
| `test/inactividad.test.js` | **nuevo.** Test de regresión del crash del timer. |
| `server.js` | Funciones de juego al ámbito de módulo; llamada a `guardar()`; handler `admin_get_history`; línea del banner. |
| `public/index.html` | Botón y panel de historial dentro de `#admin-panel`. |
| `public/script.js` | Pedir y renderizar el historial. |
| `public/style.css` | Estilos del panel, reutilizando tokens existentes. |
| `.gitignore` | `serviceAccountKey.json`. |
| `package.json` | Dependencia `firebase-admin`. |
| `README.md` | Configuración de Firebase y reglas de seguridad. |

---

## Task 1: Sacar las funciones de juego al módulo (arregla un crash real)

**Contexto — esto no es cosmético.** `handleInactiveUser()` está en el ámbito
de módulo (`server.js:159`) y llama a `checkRoundCompletion()`
(`server.js:174`), pero esa función está declarada **dentro** de
`io.on('connection', ...)` (`server.js:412`). No está en su alcance.

Reproducido en esta máquina:

```
⏰ Inactivo: Claudio 🍑🃏
ReferenceError: checkRoundCompletion is not defined
    at handleInactiveUser (server.js:174:5)
```

Es una excepción no capturada dentro de un `setTimeout`, así que **mata el
proceso**: si alguien pasa 5 minutos sin votar con una ronda abierta, se cae el
servidor y se desconectan todos. Está desde el commit inicial.

**Files:**
- Modify: `server.js` (mover `server.js:298-311` y `server.js:412-473` al
  ámbito de módulo; guardar `server.listen`; agregar `module.exports`)
- Test: `test/inactividad.test.js` (crear)

**Interfaces:**
- Consumes: nada.
- Produces: `server.js` pasa a exportar
  `{ handleInactiveUser, checkRoundCompletion, enviarResultados, __test }`.
  `__test` expone `{ registrarUsuario(sid, id), abrirVotacion(modo), reset(), cerrar() }`.
  Las tareas 4 y 5 modifican `enviarResultados` y agregan handlers en el mismo
  archivo.

- [x] **Step 1: Escribir el test que falla**

Crear `test/inactividad.test.js`:

```js
// El timer de inactividad llama a handleInactiveUser a los 5 minutos.
// Si esa función no puede ver checkRoundCompletion, la excepcion no capturada
// dentro del setTimeout mata el proceso entero y desconecta a todos.
const test = require('node:test');
const assert = require('node:assert');

const servidor = require('../server.js');

test.after(() => servidor.__test.cerrar());

test('handleInactiveUser no lanza con una ronda normal abierta', () => {
    servidor.__test.reset();
    servidor.__test.registrarUsuario('socket-1', 'claudio');
    servidor.__test.abrirVotacion('normal');

    assert.doesNotThrow(() => servidor.handleInactiveUser('socket-1'));
});

test('handleInactiveUser no lanza con una ronda de estrellas abierta', () => {
    servidor.__test.reset();
    servidor.__test.registrarUsuario('socket-2', 'bombo');
    servidor.__test.abrirVotacion('estrellas');

    assert.doesNotThrow(() => servidor.handleInactiveUser('socket-2'));
});

test('handleInactiveUser sale sin hacer nada si el socket no existe', () => {
    servidor.__test.reset();
    assert.doesNotThrow(() => servidor.handleInactiveUser('socket-inexistente'));
});
```

- [x] **Step 2: Correr el test para verificar que falla**

Ejecutar: `node --test test/inactividad.test.js`

Esperado: FALLA. Primero por `servidor.__test is undefined` (todavía no hay
`module.exports`). Después de agregar los exports pero antes de mover las
funciones, falla con `ReferenceError: checkRoundCompletion is not defined`.
**Hay que ver ese ReferenceError al menos una vez** — es la prueba de que el
test captura el bug real.

- [x] **Step 3: Guardar el arranque del servidor detrás de `require.main`**

En `server.js`, reemplazar el bloque final:

```js
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
```

por:

```js
const PORT = process.env.PORT || 3000;

// Solo se levanta el servidor cuando se ejecuta directamente (`npm start`).
// Al requerirlo desde un test no se ocupa ningun puerto.
if (require.main === module) {
    server.listen(PORT, () => {
```

y cerrar el `if` agregando una llave extra al final de ese bloque:

```js
        console.log(`🔑 Clave de admin: la de la variable ADMIN_PASSWORD\n`);
    }
    });
}
```

- [x] **Step 4: Mover las funciones de juego al ámbito de módulo**

Estas siete funciones están declaradas dentro de `io.on('connection', ...)` y
**ninguna usa la variable `socket`** (verificado). Se mueven **tal cual, sin
cambiar una línea de su cuerpo**, desde adentro del handler hasta el ámbito de
módulo, justo antes de `io.on('connection', (socket) => {`:

| Función | Líneas actuales |
|---|---|
| `iniciarRonda(modo)` | `server.js:298-311` |
| `checkRoundCompletion()` | `server.js:412-416` |
| `acumularLogicaInterna()` | `server.js:417-427` |
| `acumularPuntos()` | `server.js:428-435` |
| `cerrarTorneoFinal()` | `server.js:436-441` |
| `cerrarRondaNormal()` | `server.js:442-450` |
| `enviarResultados(datos, modo)` | `server.js:451-473` |

Quitar los 4 espacios de indentación de cada una. Cierran sobre estado de
módulo (`usuarios`, `votosActuales`, `votacionAbierta`, `modoJuego`,
`puntajeAcumulado`, `io`), que sigue siendo visible desde el ámbito de módulo.

No tocar los `socket.on(...)` — se quedan donde están y siguen llamando a estas
funciones por nombre.

- [x] **Step 5: Agregar los exports para test al final de `server.js`**

Después del bloque `if (require.main === module) { ... }`:

```js
// Exportado unicamente para los tests. La app se arranca con `npm start`.
module.exports = {
    handleInactiveUser,
    checkRoundCompletion,
    enviarResultados,
    __test: {
        registrarUsuario(sid, id) { usuarios[sid] = { id, role: 'user' }; },
        abrirVotacion(modo) { votacionAbierta = true; modoJuego = modo; },
        reset() {
            usuarios = {};
            votosActuales = {};
            votosEstrellas = {};
            votacionAbierta = false;
            adminSocketId = null;
            clearAllInactivityTimers();
            cancelarResultadosPendientes();
        },
        cerrar() {
            clearAllInactivityTimers();
            cancelarResultadosPendientes();
            io.close();
        },
    },
};
```

- [x] **Step 6: Correr el test y verificar que pasa**

Ejecutar: `node --test test/inactividad.test.js`
Esperado: PASS, 3 tests.

Si el proceso queda colgado sin terminar, es que `io.close()` no liberó todo:
agregar `server.close()` dentro de `__test.cerrar()`.

- [x] **Step 7: Verificar que no se rompió nada**

```bash
npm test          # los 6 tests de concursantes + los 3 nuevos
npm start         # debe imprimir el banner completo y quedar escuchando
```

Además, probar a mano que una partida sigue funcionando de punta a punta:
entrar como admin, iniciar una ronda normal con un jugador, votar, y ver que
sale la pantalla de resultados. Este paso no cambia comportamiento observable:
si algo cambió, es un error.

---

## Task 2: `lib/historial.js` — las dos funciones puras

**Files:**
- Create: `lib/historial.js`
- Test: `test/historial.test.js` (crear)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `construirRegistro({ puntajes, modo, jugadores })` → objeto documento **sin
    campo `fecha`**, con forma
    `{ tipo, ganadores, empate, puntajes, unidad, jugadores }`.
  - `calcularRanking(registros, ids)` → array de
    `{ id, torneos, rondas, ultimaVictoria }` ordenado.
  - Las tareas 3, 4 y 5 usan ambas.

- [x] **Step 1: Escribir los tests que fallan**

Crear `test/historial.test.js`:

```js
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
    { tipo: 'estrellas', ganadores: ['ferchos'],            fecha: '2026-09-01T20:00:00.000Z' },
    { tipo: 'estrellas', ganadores: ['ferchos'],            fecha: '2026-09-05T20:00:00.000Z' },
    { tipo: 'normal',    ganadores: ['claudio'],            fecha: '2026-09-05T21:00:00.000Z' },
    { tipo: 'normal',    ganadores: ['claudio', 'bombo'],   fecha: '2026-09-06T22:00:00.000Z' },
];

test('calcularRanking cuenta torneos y rondas por separado', () => {
    const r = calcularRanking(REGISTROS, IDS);
    const porId = Object.fromEntries(r.map(f => [f.id, f]));
    assert.strictEqual(porId.ferchos.torneos, 2);
    assert.strictEqual(porId.ferchos.rondas, 0);
    assert.strictEqual(porId.claudio.torneos, 0);
    assert.strictEqual(porId.claudio.rondas, 2);
});

test('calcularRanking cuenta un empate como victoria para cada ganador', () => {
    const r = calcularRanking(REGISTROS, IDS);
    const porId = Object.fromEntries(r.map(f => [f.id, f]));
    assert.strictEqual(porId.bombo.rondas, 1);
});

test('calcularRanking incluye en cero a quien nunca gano', () => {
    const r = calcularRanking(REGISTROS, IDS);
    const pitrisio = r.find(f => f.id === 'pitrisio');
    assert.strictEqual(pitrisio.torneos, 0);
    assert.strictEqual(pitrisio.rondas, 0);
    assert.strictEqual(pitrisio.ultimaVictoria, null);
});

test('calcularRanking ordena por torneos, luego rondas, luego id', () => {
    const r = calcularRanking(REGISTROS, IDS);
    assert.deepStrictEqual(r.map(f => f.id), ['ferchos', 'claudio', 'bombo', 'pitrisio']);
});

test('calcularRanking guarda la fecha de la ultima victoria', () => {
    const r = calcularRanking(REGISTROS, IDS);
    const porId = Object.fromEntries(r.map(f => [f.id, f]));
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
```

- [x] **Step 2: Correr los tests para verificar que fallan**

Ejecutar: `node --test test/historial.test.js`
Esperado: FALLA con `Cannot find module '../lib/historial.js'`.

- [x] **Step 3: Escribir la implementación mínima**

Crear `lib/historial.js`:

```js
// Historial de torneos en Cloud Firestore.
//
// Este es el UNICO archivo que conoce Firestore. server.js no importa
// firebase-admin ni sabe como se llaman las colecciones.
//
// Las dos funciones de abajo son puras: sin red, sin reloj, sin Firestore.
// Son el nucleo testeable y por eso `npm test` corre offline.

// Arma el documento a partir de lo que ya calculo el servidor.
// NO incluye `fecha`: esa la pone Firestore al escribir (ver guardar()).
//   puntajes   { id: numero }
//   modo       'normal' | 'estrellas'
//   jugadores  [id] de los conectados al cerrar
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
//   ids        todos los ids de data/concursantes.json (para incluir los que
//              nunca ganaron)
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

module.exports = { construirRegistro, calcularRanking };
```

- [x] **Step 4: Correr los tests y verificar que pasan**

Ejecutar: `node --test test/historial.test.js`
Esperado: PASS, 12 tests.

- [x] **Step 5: Verificar la suite completa**

Ejecutar: `npm test`
Esperado: PASS, 21 tests (6 concursantes + 3 inactividad + 12 historial).

---

## Task 3: `lib/historial.js` — conexión a Firestore

**Files:**
- Modify: `lib/historial.js`
- Modify: `.gitignore`
- Modify: `package.json` (dependencia)
- Modify: `README.md`

**Interfaces:**
- Consumes: `construirRegistro`, `calcularRanking` de la Task 2.
- Produces:
  - `iniciar()` → `boolean`. No lanza nunca.
  - `disponible()` → `boolean`.
  - `guardar(registro)` → `Promise<void>`. Nunca rechaza.
  - `obtenerHistorial(ids)` → `Promise<{ ranking, registros }>`. **Puede lanzar.**
  - Las tareas 4 y 5 las llaman desde `server.js`.

- [x] **Step 1: Blindar el `.gitignore` ANTES de nada**

La clave de servicio da acceso completo al proyecto de Firebase. Se ignora
primero para que no exista una ventana en la que se pueda commitear por error.

En `.gitignore`, después del bloque `# Entorno`:

```
# Clave de servicio de Firebase — NUNCA al repo
serviceAccountKey.json
```

Verificar: `git check-ignore -v serviceAccountKey.json` debe responder con la
regla. (El archivo todavía no existe; el comando igual valida la regla si se
crea un archivo vacío de prueba y después se borra.)

- [x] **Step 2: Instalar la dependencia**

```bash
npm install firebase-admin --save
```

Verificar que `package.json` quedó con `firebase-admin` en `dependencies` y que
`npm test` sigue pasando (21 tests) — la dependencia todavía no se usa.

> **Corregido al ejecutar (2026-09-07):** este plan se escribió con la API de
> `firebase-admin` v11/v12 (`admin.firestore()`, `admin.credential.cert()`).
> La versión instalada es la **v14**, que es modular y ya no expone eso en el
> export por defecto. Los bloques de abajo ya están corregidos:
> `require('firebase-admin/app')` y `require('firebase-admin/firestore')`.

- [x] **Step 3: Agregar la capa de Firestore a `lib/historial.js`**

Al principio del archivo, antes de `construirRegistro`:

```js
const fs = require('node:fs');
const path = require('node:path');

const COLECCION = 'torneos';
const TOPE_LECTURA = 500;   // red de contencion; ver spec seccion 5

let db = null;
let proyecto = null;
```

Y antes de `module.exports`:

```js
// Busca credenciales en dos lugares, en orden:
//   1. GOOGLE_APPLICATION_CREDENTIALS (forma estandar de Google)
//   2. serviceAccountKey.json en la raiz del proyecto
// Sin credenciales NO es un error: la app funciona igual, solo que sin historial.
function iniciar() {
    if (db) return true;

    const rutaEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const rutaLocal = path.join(__dirname, '..', 'serviceAccountKey.json');
    const ruta = rutaEnv || rutaLocal;

    if (!fs.existsSync(ruta)) return false;

    try {
        const credencial = JSON.parse(fs.readFileSync(ruta, 'utf8'));
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

function disponible() { return db !== null; }
function proyectoActual() { return proyecto; }

// Fire-and-forget: NUNCA rechaza. Un registro perdido es aceptable; que un
// problema de red demore la pantalla de resultados, no.
async function guardar(registro) {
    if (!db) return;
    try {
        const { FieldValue } = require('firebase-admin/firestore');
        await db.collection(COLECCION).add({
            ...registro,
            fecha: FieldValue.serverTimestamp(),
        });
    } catch (err) {
        console.error('⚠️  No se pudo guardar el registro del torneo:', err.message);
    }
}

// Lee los registros y calcula el ranking. A diferencia de guardar(), esta SI
// lanza: el que llama decide que mostrarle al admin.
// El orderBy de un solo campo usa los indices automaticos de Firestore, asi que
// no hay que crear ningun indice a mano.
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
```

Actualizar el export:

```js
module.exports = {
    construirRegistro,
    calcularRanking,
    iniciar,
    disponible,
    proyectoActual,
    guardar,
    obtenerHistorial,
};
```

- [x] **Step 4: Verificar que los tests siguen pasando sin credenciales**

Ejecutar: `npm test`
Esperado: PASS, 21 tests. Requerir `lib/historial.js` **no** debe intentar
conectarse: `firebase-admin` solo se hace `require` adentro de `iniciar()` y
`guardar()`, nunca al cargar el módulo.

- [x] **Step 5: Verificar a mano que `iniciar()` degrada bien**

```bash
node -e "const h=require('./lib/historial.js'); console.log('iniciar:', h.iniciar(), '| disponible:', h.disponible())"
```

Esperado sin `serviceAccountKey.json`: `iniciar: false | disponible: false`,
sin excepciones ni stack traces.

- [x] **Step 6: Documentar la configuración en el README**

Agregar una sección después de "### Tests":

````markdown
### Historial de torneos (Firebase)

El historial de quién ganó y cuándo se guarda en Cloud Firestore. Es opcional:
**sin configurar, la app funciona igual**, solo que no guarda registros.

Para activarlo:

1. En [Firebase Console](https://console.firebase.google.com), entrá a tu
   proyecto → ⚙️ **Configuración del proyecto** → **Cuentas de servicio** →
   **Generar nueva clave privada**. Te baja un JSON.
2. Guardalo como `serviceAccountKey.json` en la raíz del proyecto.
   Ya está en `.gitignore`: **nunca lo subas al repo**.
3. En la consola, pestaña **Firestore Database → Reglas**, pegá esto:

   ```
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if false;
       }
     }
   }
   ```

   Esto bloquea todo acceso desde navegadores. El servidor no pasa por las
   reglas: autentica con la clave de servicio vía IAM. Como la app se sirve por
   una URL pública de ngrok y no tiene login, esta es la configuración correcta.

4. `npm start`. El banner te dice si quedó activo.

Alternativa a los pasos 1-2: apuntar la variable estándar de Google a otra ruta.

```bash
GOOGLE_APPLICATION_CREDENTIALS=/ruta/al/key.json npm start
```
````

---

## Task 4: Guardar el registro cuando termina un torneo o ronda

**Files:**
- Modify: `server.js` (`enviarResultados`, el banner de arranque)

**Interfaces:**
- Consumes: `historial.iniciar()`, `historial.disponible()`,
  `historial.proyectoActual()`, `historial.construirRegistro()`,
  `historial.guardar()` de las tareas 2 y 3; `enviarResultados` ya en el ámbito
  de módulo por la Task 1.
- Produces: documentos en la colección `torneos`. La Task 5 los lee.

- [x] **Step 1: Importar e iniciar el historial**

En `server.js`, junto a los otros `require` de arriba:

```js
const historial = require('./lib/historial');
```

Y después de `cargarEstado();`:

```js
historial.iniciar();
```

- [x] **Step 2: Escribir el registro en `enviarResultados`**

En `enviarResultados(datos, modo)`, **antes** de `io.emit('pre_results')`:

```js
        // Historial: se registra cuando se DECIDE el resultado, no cuando se
        // muestra, asi no depende del setTimeout del suspenso (que es cancelable).
        // Fire-and-forget a proposito: no se await-ea y guardar() no rechaza,
        // asi un problema de red no puede demorar la pantalla de resultados.
        if (historial.disponible()) {
            const jugadores = Object.values(usuarios)
                .filter(u => u.role === 'user')
                .map(u => u.id);
            historial.guardar(
                historial.construirRegistro({ puntajes: datos, modo, jugadores })
            );
        }
```

Queda así:

```js
function enviarResultados(datos, modo) {
    const ranking    = Object.entries(datos).sort((a, b) => b[1] - a[1]);
    const maxScore   = ranking[0][1];
    const winners    = ranking.filter(r => r[1] === maxScore);
    const esEmpate   = winners.length > 1;

    let winnerImage = '';
    let audio       = AUDIO_EMPATE;

    if (!esEmpate) { /* ... sin cambios ... */ }

    // ← el bloque del historial va aca

    io.emit('pre_results');
    cancelarResultadosPendientes();
    resultadosTimer = setTimeout(() => { /* ... sin cambios ... */ }, SUSPENSO_MS);
}
```

- [x] **Step 3: Agregar la línea al banner de arranque**

Dentro del `server.listen`, después de la línea del timeout de inactividad:

```js
    if (historial.disponible()) {
        console.log(`📜 Historial: activo (proyecto ${historial.proyectoActual()})`);
    } else {
        console.log(`📜 Historial: sin configurar — se juega igual, no se guardan registros`);
    }
```

- [x] **Step 4: Verificar sin credenciales**

```bash
npm test          # 21 tests, siguen pasando
npm start
```

Esperado: el banner muestra `📜 Historial: sin configurar`. Jugar una ronda
normal completa (admin + un jugador) y confirmar que los resultados salen
exactamente igual que antes.

- [ ] **Step 5: Verificar con credenciales** ⏳ PENDIENTE — falta serviceAccountKey.json

Requiere `serviceAccountKey.json` (ver Task 3, Step 6).

```bash
npm start
```

Esperado: `📜 Historial: activo (proyecto <tu-proyecto>)`. Jugar una ronda
normal hasta el resultado y después revisar en Firebase Console → Firestore
Database que apareció un documento en `torneos` con `tipo: "normal"`,
`ganadores`, `unidad: "votos"` y una `fecha` puesta por el servidor.

Repetir con un torneo de estrellas (TERMINAR TORNEO) y confirmar
`tipo: "estrellas"` y `unidad: "pts"`.

---

## Task 5: Servir el historial al admin por Socket.IO

**Files:**
- Modify: `server.js` (nuevo handler dentro de `io.on('connection', ...)`)

**Interfaces:**
- Consumes: `historial.disponible()`, `historial.obtenerHistorial(ids)` de la
  Task 3; `IDS` (ya existe en `server.js`).
- Produces: evento `history_data` con
  `{ disponible: boolean, ranking: [...], registros: [...], error: string|null }`.
  La Task 6 lo consume.

- [x] **Step 1: Agregar el handler**

Dentro de `io.on('connection', (socket) => { ... })`, junto a los otros
handlers de admin (por ejemplo después de `admin_reset_lobby`):

```js
    socket.on('admin_get_history', async () => {
        if (socket.id !== adminSocketId) return;

        if (!historial.disponible()) {
            return socket.emit('history_data', {
                disponible: false, ranking: [], registros: [], error: null,
            });
        }
        try {
            const { ranking, registros } = await historial.obtenerHistorial(IDS);
            socket.emit('history_data', {
                disponible: true, ranking, registros, error: null,
            });
        } catch (err) {
            console.error('⚠️  No se pudo leer el historial:', err.message);
            socket.emit('history_data', {
                disponible: true, ranking: [], registros: [], error: err.message,
            });
        }
    });
```

- [x] **Step 2: Verificar el caso sin credenciales**

`npm start` sin `serviceAccountKey.json`, entrar como admin y en la consola del
navegador:

```js
socket.emit('admin_get_history');
socket.on('history_data', d => console.log(d));
```

Esperado: `{ disponible: false, ranking: [], registros: [], error: null }`.

- [x] **Step 3: Verificar el caso con credenciales** — cubierto con stub (datos + error); falta contra Firestore real

Lo mismo con el JSON de servicio en su lugar y al menos un torneo ya guardado.

Esperado: `disponible: true`, `ranking` con las 4 filas (una por concursante,
las que no ganaron en cero) y `registros` con los torneos, el más reciente
primero y `fecha` como string ISO.

- [x] **Step 4: Verificar que un no-admin no puede pedirlo**

Entrar como jugador normal y emitir `admin_get_history`.
Esperado: **no llega ningún `history_data`** (el handler corta por
`socket.id !== adminSocketId`).

---

## Task 6: Panel de historial en la UI de admin

**Files:**
- Modify: `public/index.html` (dentro de `#admin-panel`, `public/index.html:95`)
- Modify: `public/script.js`
- Modify: `public/style.css`
- Modify: `README.md`

**Interfaces:**
- Consumes: evento `history_data` de la Task 5; helpers `emojiDe(id)` y
  `nombreDe(id)` que ya existen en `script.js`.
- Produces: nada que consuman otras tareas.

- [x] **Step 1: Agregar el markup**

En `public/index.html`, dentro de `#admin-panel`, entre el
`div.admin-actions-grid` y el botón REINICIAR PUNTUACIONES:

```html
            <button type="button" id="btn-historial" onclick="toggleHistorial()" class="btn-ghost historial-toggle">
                <span class="material-icons-round">history</span>
                HISTORIAL
            </button>

            <div id="historial-panel" class="historial-panel hidden">
                <p class="scores-label">RANKING HISTÓRICO</p>
                <div id="historial-ranking" class="podium-list"></div>

                <p class="scores-label historial-sub">ÚLTIMOS TORNEOS</p>
                <div id="historial-lista" class="historial-lista"></div>
            </div>
```

- [x] **Step 2: Agregar la lógica de cliente**

En `public/script.js`, junto a las otras acciones de admin:

```js
// ============================================================
//  HISTORIAL (solo admin)
// ============================================================
let historialAbierto = false;

function toggleHistorial() {
    SFX.blip();
    const panel = document.getElementById('historial-panel');
    if (!panel) return;

    historialAbierto = !historialAbierto;
    panel.classList.toggle('hidden', !historialAbierto);

    if (historialAbierto) {
        // Se pide al abrir, no al cargar la pagina.
        document.getElementById('historial-ranking').innerHTML =
            '<p class="muted-text">Cargando…</p>';
        document.getElementById('historial-lista').innerHTML = '';
        socket.emit('admin_get_history');
        animIn(panel, { y: 10, duration: 0.28 });
    }
}

function fechaCorta(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yy} ${hh}:${mi}`;
}

socket.on('history_data', ({ disponible, ranking, registros, error }) => {
    const elRanking = document.getElementById('historial-ranking');
    const elLista   = document.getElementById('historial-lista');
    if (!elRanking || !elLista) return;

    if (!disponible) {
        elRanking.innerHTML = '<p class="muted-text">Historial no configurado. Ver el README.</p>';
        elLista.innerHTML = '';
        return;
    }
    if (error) {
        elRanking.innerHTML = `<p class="muted-text">No se pudo leer el historial: ${escapeHtml(error)}</p>`;
        elLista.innerHTML = '<button type="button" class="btn-ghost" onclick="socket.emit(\'admin_get_history\')">REINTENTAR</button>';
        return;
    }
    if (!registros.length) {
        elRanking.innerHTML = '<p class="muted-text">Todavía no hay torneos registrados.</p>';
        elLista.innerHTML = '';
        return;
    }

    elRanking.innerHTML = ranking.map((f, i) => `
        <div class="podium-row">
            <div class="podium-left">
                <span class="podium-rank">${i + 1}°</span>
                <span class="podium-emoji">${escapeHtml(emojiDe(f.id))}</span>
                <span class="podium-name">${escapeHtml(nombreDe(f.id))}</span>
            </div>
            <span class="podium-score">${f.torneos} 🏆 · ${f.rondas} 🎵</span>
        </div>`).join('');

    elLista.innerHTML = registros.map(r => {
        const nombres = r.ganadores.map(id => escapeHtml(nombreDe(id))).join(' + ');
        // Object.values({}) da [] y Math.max() daria -Infinity: se cubre el caso.
        const valores = Object.values(r.puntajes || {});
        const puntos  = valores.length ? Math.max(...valores) : 0;
        const badge   = r.tipo === 'estrellas' ? 'stars' : 'normal';
        const etiqueta = r.tipo === 'estrellas' ? 'TORNEO' : 'RONDA';
        return `
            <div class="historial-row">
                <span class="historial-fecha">${fechaCorta(r.fecha)}</span>
                <span class="mode-badge ${badge}">${etiqueta}</span>
                <span class="historial-ganador">${r.empate ? '🤝 ' : ''}${nombres}</span>
                <span class="historial-puntos">${puntos} ${escapeHtml(r.unidad || '')}</span>
            </div>`;
    }).join('');

    animIn(elLista.children, { y: 8, duration: 0.25, stagger: 0.03 });
});
```

- [x] **Step 3: Agregar los estilos**

En `public/style.css`, después del bloque `.scores-preview`:

```css
/* --- HISTORIAL (admin) --- */
.historial-toggle { width: 100%; margin-bottom: 10px; }

.historial-panel {
    padding: 12px;
    background: rgba(0,0,0,0.3);
    border: 1px solid rgba(0,255,255,0.1);
    border-radius: var(--radius-sm);
    margin-bottom: 10px;
}
.historial-panel.hidden { display: none; }

.historial-sub { margin-top: 14px; }

.historial-lista {
    display: flex; flex-direction: column; gap: 4px;
    max-height: 240px; overflow-y: auto;
    scrollbar-width: none;
}
.historial-lista::-webkit-scrollbar { display: none; }

.historial-row {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 9px;
    background: rgba(0,0,0,0.3);
    border-radius: var(--radius-xs);
    font-size: 0.78rem;
    /* La fila puede desbordar en pantallas angostas: scrollea ella, no la pagina */
    overflow-x: auto;
    scrollbar-width: none;
}
.historial-row::-webkit-scrollbar { display: none; }

.historial-fecha {
    font-family: var(--font-tech);
    font-size: 0.62rem;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
}
.historial-row .mode-badge {
    margin-bottom: 0;
    font-size: 0.45rem;
    padding: 2px 7px;
    flex-shrink: 0;
}
.historial-ganador {
    flex: 1; font-weight: 700; white-space: nowrap;
}
.historial-puntos {
    font-family: var(--font-tech);
    font-size: 0.68rem; font-weight: 700;
    color: var(--neon-yellow);
    text-shadow: 0 0 8px var(--glow-yellow);
    white-space: nowrap; flex-shrink: 0;
}
```

No hace falta tocar el bloque `prefers-reduced-motion`: el panel se anima con
`animIn()`, que ya respeta la preferencia, y estos estilos no tienen animación
propia.

- [x] **Step 4: Verificar los tres estados vacíos**

`npm start` y entrar como admin.

1. **Sin credenciales** → abrir HISTORIAL. Esperado: "Historial no configurado.
   Ver el README."
2. **Con credenciales y base vacía** → esperado: "Todavía no hay torneos
   registrados."
3. **Con credenciales y datos** → ranking con las 4 filas ordenadas y la lista
   cronológica con el más reciente arriba.

- [x] **Step 5: Verificar en móvil**

Con las DevTools en 390×844 (o desde un celular por ngrok):

- El panel entra sin desbordar horizontalmente **la página**.
- Una fila larga (empate con dos nombres) scrollea dentro de su propia fila.
- La lista scrollea internamente al pasar de ~6 registros.
- El botón HISTORIAL tiene feedback al tap (`.btn-ghost:active`).

- [x] **Step 6: Verificar que no hay regresiones**

```bash
npm test          # 21 tests
```

Jugar una partida completa: ronda normal → resultados → volver al lobby →
torneo de estrellas → acumular → terminar torneo → abrir HISTORIAL y confirmar
que aparecieron los dos registros nuevos, con el tipo correcto.

- [x] **Step 7: Documentar la sección en el README**

En la sección "### Historial de torneos (Firebase)", al final:

```markdown
Una vez configurado, el admin ve el botón **HISTORIAL** en su panel: arriba el
ranking (🏆 torneos ganados · 🎵 rondas ganadas, contados por separado) y abajo
la lista de los últimos torneos con fecha, tipo y ganador. Los empates se
marcan con 🤝 y cuentan como victoria para cada uno.
```

---

## Notas de ejecución

**Orden.** Las tareas son secuenciales: 1 → 2 → 3 → 4 → 5 → 6. La Task 1 es
independiente del resto (arregla un bug preexistente) y se puede revisar y
aceptar sola.

**Punto de corte útil.** Con las tareas 1-4 el historial ya se está guardando
aunque todavía no se pueda ver desde la app; se puede mirar en la consola de
Firebase. Si hay que parar, ese es el mejor lugar.

**Lo que necesita el usuario.** Las tareas 3 (step 6), 4 (step 5), 5 (step 3) y
6 (step 4.2/4.3) requieren el `serviceAccountKey.json`. Sin él las tareas se
completan igual y los tests pasan, pero esas verificaciones quedan pendientes.
