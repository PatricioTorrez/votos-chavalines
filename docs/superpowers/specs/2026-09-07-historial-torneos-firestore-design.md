# Historial de torneos en Cloud Firestore

**Fecha:** 2026-09-07
**Estado:** aprobado, pendiente de plan de implementación
**Proyecto:** votos-chavalines

---

## 1. Objetivo

Guardar un registro permanente de cada torneo y cada ronda que termina, para
poder responder dos preguntas desde el panel de admin:

- **¿Quién ganó más veces?**
- **¿Cuándo ganó cada uno?**

Hoy el único estado que sobrevive a un reinicio es `data/estado.json`, que
guarda el acumulado del torneo *en curso* y se pisa en cuanto empieza otro. No
hay memoria histórica.

## 2. Por qué Firestore y no un archivo local

`data/estado.json` ya demuestra que un archivo local alcanza para estado
efímero. Para un historial no alcanza: vive en la máquina del anfitrión, y el
sentido de un registro de "quién ganó más veces **históricamente**" es
justamente que sobreviva a esa máquina, a un formateo y a un cambio de
anfitrión. Esa durabilidad es el único motivo por el que se agrega una
dependencia externa.

## 3. Decisión de arquitectura: escribe el servidor, no el navegador

La documentación de Cloud Firestore ofrece dos caminos. **Se usa el de las
bibliotecas cliente de servidor (`firebase-admin` sobre Node.js).** El SDK Web
queda descartado por dos razones concretas:

1. **La app se sirve por una URL pública de ngrok.** El "modo de prueba" de
   Firestore permite que cualquiera lea y reemplace los datos. Cualquier
   persona con el link podría borrar o falsificar el historial.

2. **La app no tiene autenticación.** Los jugadores tocan un botón con un
   emoji; no hay `uid`. El conjunto de reglas seguras que documenta Firebase
   (`request.auth.uid == uid`) no es aplicable sin montar Firebase
   Authentication encima, que es un proyecto aparte y no está pedido.

Ventajas del camino elegido, además de la seguridad:

- `server.js` ya calcula el ganador de forma autoritativa en
  `enviarResultados()`. Es el único punto del sistema que lo sabe con certeza.
- El navegador no incorpora el SDK de Firebase (~300 KB que bajarían al celular
  de cada jugador por ngrok).
- No hay claves ni configuración de Firebase en el HTML.
- Las reglas de seguridad quedan en deny-all; el Admin SDK las evita por diseño
  porque autentica vía IAM.

### Dependencia

Se usa `firebase-admin`. Es más pesado que `@google-cloud/firestore` (que es lo
que envuelve por dentro), pero es el paquete que describen la documentación y
el flujo de la consola de Firebase, y deja la puerta abierta a sumar Auth o
Storage más adelante sin cambiar de librería.

## 4. Modelo de datos

Una colección, `torneos`. Un documento por evento terminado, con id
autogenerado.

```js
{
  tipo:      "estrellas" | "normal",
  fecha:     Timestamp,                       // serverTimestamp()
  ganadores: ["ferchos"],                     // array, ver empates
  empate:    false,
  puntajes:  { claudio: 2, ferchos: 5, bombo: 0, pitrisio: 4 },
  unidad:    "pts" | "votos",
  jugadores: ["claudio", "ferchos", "bombo", "pitrisio"]
}
```

**`ganadores` es un array, siempre**, incluso con un solo ganador. Un empate se
guarda como `["claudio", "bombo"]` con `empate: true`. Esto permite decidir más
adelante cómo contar los empates sin migrar los datos.

**`tipo`** distingue las dos cosas que terminan con ganador en la app: la ronda
de modo normal (cierra sola cuando votaron todos) y el torneo de estrellas
(cierra cuando el admin toca TERMINAR TORNEO).

**`jugadores`** son los ids que estaban **conectados como jugadores en el
momento de cerrar** (de `usuarios`, filtrando `role === 'user'`), no la lista
completa de `concursantes.json`. Sin esa precisión el campo no sería
interpretable: si Pitrisio no jugó esa noche, no debería contar como que perdió.

No hace falta para lo pedido, pero permite calcular después "ganó 3 de las 5 que
jugó" y **no se puede reconstruir a posteriori**, que es la razón por la que se
incluye ahora.

**`puntajes`** se guarda tal cual lo calculó el servidor, indexado por id.

Las claves son siempre **ids** (`"ferchos"`), nunca nombres visibles. Esto
sigue la decisión ya tomada en `data/concursantes.json`: el id es la clave del
sistema, el nombre es presentación. Un jugador renombrado no rompe su historial.

## 5. Módulo `lib/historial.js`

Toda la interacción con Firestore vive acá, aislada. `server.js` no importa
`firebase-admin` ni conoce nombres de colecciones.

```js
// Inicializa. Devuelve true si quedó operativo, false si no hay credenciales.
// No lanza: la falta de credenciales es un estado válido.
iniciar(): boolean

// True si hay conexión configurada.
disponible(): boolean

// Construye el documento a partir de lo que ya calculó el servidor.
// FUNCIÓN PURA: sin red, sin reloj, sin Timestamp. Es el núcleo testeable.
//   puntajes   { id: numero }  — el conteo tal cual lo calculó el servidor
//   modo       'normal' | 'estrellas'
//   jugadores  [id]            — conectados al cerrar (ver sección 4)
// Devuelve el documento SIN el campo `fecha`.
construirRegistro({ puntajes, modo, jugadores }): object

// Escribe. Agrega `fecha: FieldValue.serverTimestamp()` — la fecha la pone
// Firestore, no el proceso, para no depender del reloj del anfitrión.
// Fire-and-forget: nunca lanza hacia arriba, loguea y sigue.
guardar(registro): Promise<void>

// Lee los registros y calcula el ranking. `ids` se pasa a calcularRanking.
// Lanza si Firestore falla; el llamador decide qué mostrar.
obtenerHistorial(ids): Promise<{ ranking, registros }>

// FUNCIÓN PURA sobre los registros leídos. El núcleo testeable de la lectura.
//   registros  documentos leídos, con `fecha` ya como string ISO
//   ids        todos los ids de concursantes.json, para incluir a los que
//              nunca ganaron. El módulo no lee ese archivo: se los pasa server.js.
calcularRanking(registros, ids): array
```

### Forma del ranking

```js
[
  { id: "ferchos", torneos: 3, rondas: 7, ultimaVictoria: "2026-09-07T20:15:00.000Z" },
  ...
]
```

- **Un empate cuenta como victoria para cada uno de los `ganadores`.** Es la
  lectura más natural de "veces que ganó" y evita que un empate desaparezca del
  registro.
- **`torneos` y `rondas` se cuentan por separado y se muestran por separado.**
  Mezclarlos haría que las rondas normales, que son muchas por noche, tapen los
  torneos de estrellas, que son pocos y significativos.
- **Orden:** `torneos` desc, luego `rondas` desc, luego `id` alfabético. Se
  desempata por `id` y no por nombre visible porque el módulo no conoce los
  nombres — y el resultado es el mismo, porque cada id deriva de su nombre.
- Todos los concursantes de `data/concursantes.json` aparecen en el ranking,
  aunque tengan cero victorias.

### Volumen y consultas

El ranking se calcula en el servidor leyendo los documentos, no con contadores
ni consultas agregadas. A este volumen (unos cientos de registros en años) es
trivial, y evita índices compuestos, colecciones de contadores y la
complejidad de mantenerlos sincronizados.

La consulta es `orderBy('fecha', 'desc').limit(500)`. Un `orderBy` de campo
único usa los índices automáticos de Firestore: **no hay que crear ningún
índice a mano**. El tope de 500 es una red de contención; si alguna vez se
alcanza, hay que revisar este diseño.

## 6. Integración en `server.js`

Un solo punto de escritura: `enviarResultados(datos, modo)`, en
`server.js:451`. Es la función por la que pasan tanto `cerrarRondaNormal()`
como `cerrarTorneoFinal()`, y ya tiene calculados los ganadores y el empate.

La escritura ocurre **en el momento en que se decide el resultado**, no cuando
se muestra: no se cuelga del `setTimeout` del suspenso, que es cancelable.

```
enviarResultados()
  ├── calcula ranking / winners / esEmpate      (ya existe)
  ├── historial.guardar(...)   ← NUEVO, fire-and-forget, no se espera
  ├── io.emit('pre_results')                     (ya existe)
  └── setTimeout → io.emit('round_ended')        (ya existe)
```

`guardar()` no se `await`ea y no puede lanzar. Si Firestore está caído o lento,
la pantalla de resultados sale igual, a tiempo. El historial es un registro
lateral: **nunca puede degradar la partida en curso**.

### La estructura actual esconde un crash

`enviarResultados`, `cerrarRondaNormal`, `checkRoundCompletion` y las demás
funciones de lógica están definidas **dentro** de `io.on('connection', ...)`,
así que se redefinen en cada conexión.

Al planificar esto apareció que no es solo desprolijo: **hay un bug que mata el
proceso**. `handleInactiveUser()` está en el ámbito de módulo
(`server.js:159`) y llama a `checkRoundCompletion()` (`server.js:174`), que
está declarada dentro del handler de conexión (`server.js:412`) y por lo tanto
no está en su alcance. Reproducido:

```
⏰ Inactivo: Claudio 🍑🃏
ReferenceError: checkRoundCompletion is not defined
    at handleInactiveUser (server.js:174:5)
```

Es una excepción no capturada dentro de un `setTimeout`, así que **tumba el
servidor y desconecta a todos**. Se dispara cuando alguien pasa 5 minutos sin
votar con una ronda abierta — el escenario de que uno se distraiga o vaya al
baño. Está desde el commit inicial (`4d6fe13`).

Sacar las funciones al ámbito de módulo arregla esto y, de paso, deja el nuevo
punto de escritura en un lugar más claro.

**Decisión (2026-09-07): el refactor entra.** Es el **primer paso del plan**,
antes de tocar nada de Firestore, y se verifica por separado: sacar las
funciones al ámbito de módulo no debe cambiar ningún comportamiento
observable. Recién con eso verde se agrega el historial, de modo que si algo se
rompe se sabe cuál de los dos cambios fue.

## 7. Protocolo Socket.IO

Dos eventos nuevos. Ambos exigen `socket.id === adminSocketId`, igual que el
resto de acciones de admin.

| Evento | Dirección | Contenido |
|---|---|---|
| `admin_get_history` | admin → servidor | (sin payload) |
| `history_data` | servidor → admin | `{ disponible, ranking, registros, error }` |

- `disponible: false` → no hay credenciales configuradas.
- `error: "..."` → hay credenciales pero la consulta falló.
- En ambos casos `ranking` y `registros` van vacíos y la UI muestra el motivo.

Las fechas viajan como string ISO (`Timestamp.toDate().toISOString()`), no como
objetos `Timestamp`, para que el cliente no necesite nada de Firebase.

## 8. UI del admin

Sección nueva dentro de `#admin-panel` (`public/index.html:95`), debajo de los
botones de modo y encima de REINICIAR PUNTUACIONES: un botón **📜 HISTORIAL**
que despliega un panel colapsable. Se pide al servidor al abrirlo, no al cargar
la página.

El panel tiene dos partes:

1. **Ranking** — una fila por concursante: emoji, nombre, torneos ganados,
   rondas ganadas. El primero destacado, igual que `.podium-row:first-child`.
2. **Cronología** — los registros más recientes primero: fecha (formato
   `DD/MM/YY HH:mm`), badge de tipo, ganador o ganadores, y el puntaje con su
   unidad. Los empates se marcan explícitamente.

Estados vacíos: "Todavía no hay torneos registrados" cuando no hay datos;
"Historial no configurado" cuando `disponible: false`.

Se reutilizan las clases y tokens que ya existen (`.podium-row`, `.score-row`,
`.mode-badge`, `--dur-*`, `--ease-*`). El panel colapsable usa una transición de
`opacity` + `transform`, sin animar `height`, y respeta el bloque
`prefers-reduced-motion` que ya está en `style.css`.

## 9. Configuración y credenciales

`lib/historial.js` busca credenciales en este orden:

1. `GOOGLE_APPLICATION_CREDENTIALS` — ruta al JSON (forma estándar de Google).
2. `serviceAccountKey.json` en la raíz del proyecto.
3. Ninguna → `disponible() === false`, la app arranca igual.

El JSON lo tiene que bajar el usuario: Firebase Console → ⚙️ Configuración del
proyecto → **Cuentas de servicio** → *Generar nueva clave privada*.

`serviceAccountKey.json` se agrega a `.gitignore` **antes** de escribir nada
más, para que no exista una ventana en la que se pueda commitear por accidente.

Al arrancar, el servidor imprime si el historial quedó activo o no, junto al
resto del banner:

```
📜 Historial: activo (proyecto votos-chavalines)
📜 Historial: sin configurar — la partida funciona, no se guardan registros
```

## 10. Reglas de seguridad

Modo producción, deny-all. El Admin SDK autentica por IAM y no pasa por las
reglas, así que esto no afecta al servidor y cierra la puerta a todo lo demás:

```
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Se documenta en el README para que se peguen en la pestaña Reglas de la consola.

## 11. Manejo de errores

| Situación | Comportamiento |
|---|---|
| Sin credenciales | La app arranca y se juega normal. El panel dice "no configurado". |
| Credenciales inválidas | Se loguea al arrancar. Igual que sin credenciales. |
| Falla una escritura | Se loguea. La partida sigue sin alterarse. Ese registro se pierde. |
| Falla una lectura | El panel muestra el error y un botón para reintentar. |
| JSON de servicio corrupto | Se loguea y se sigue sin historial. No tumba el proceso. |

Un registro perdido es aceptable: es un historial de un juego entre amigos, no
un libro contable. Lo que no es aceptable es que un problema de red arruine la
noche.

## 12. Tests

Se extiende `npm test` (runner nativo de Node, sin dependencias). Todo lo que se
testea es **puro y sin red**, así que `npm test` sigue funcionando offline y sin
credenciales:

- `construirRegistro()` con un ganador único → `ganadores` de largo 1,
  `empate: false`.
- `construirRegistro()` con empate → todos los ganadores, `empate: true`.
- `construirRegistro()` en modo normal → `unidad: "votos"`; en estrellas →
  `"pts"`.
- `calcularRanking()` cuenta torneos y rondas por separado.
- `calcularRanking()` cuenta un empate como victoria para cada ganador.
- `calcularRanking()` incluye con cero a quienes nunca ganaron.
- `calcularRanking()` ordena por torneos, luego rondas, luego nombre.
- `calcularRanking([])` devuelve todos en cero sin romper.

No se testea la escritura ni la lectura reales contra Firestore. Si más
adelante se quiere, el camino es el emulador de Firestore que menciona la
documentación (`firebase emulators:start`), pero queda fuera de alcance.

## 13. Archivos

| Archivo | Cambio |
|---|---|
| `lib/historial.js` | **nuevo** — todo Firestore, aislado |
| `test/historial.test.js` | **nuevo** — tests de las funciones puras |
| `test/inactividad.test.js` | **nuevo** — regresión del crash de la sección 6 |
| `server.js` | llamada a `guardar()` en `enviarResultados`; handler `admin_get_history`; línea del banner |
| `public/index.html` | botón y panel de historial en `#admin-panel` |
| `public/script.js` | pedir y renderizar el historial |
| `public/style.css` | estilos del panel, reutilizando tokens existentes |
| `.gitignore` | `serviceAccountKey.json` |
| `package.json` | dependencia `firebase-admin` |
| `README.md` | sección de configuración de Firebase y reglas |

## 14. Fuera de alcance

- Firebase Authentication.
- Que los jugadores (no admin) vean el historial.
- Borrar o editar registros desde la app.
- Importar torneos jugados antes de esto.
- Estadísticas más allá de "cuántas veces y cuándo" (rachas, head-to-head,
  gráficos de evolución).
- Cloud Functions, Hosting o cualquier otro servicio de Firebase.

## 15. Riesgos

- **La clave de servicio da acceso completo al proyecto.** No va al repo. Si se
  filtra, se revoca desde la consola. El `.gitignore` se agrega primero.
- **`firebase-admin` pesa.** Suma varias decenas de MB en `node_modules`. Como
  `node_modules` ya no se commitea, solo afecta al `npm install` del anfitrión.
- **Escritura fire-and-forget.** Si el proceso muere en el segundo siguiente a
  decidir el resultado, ese registro no llega. Aceptable, ver sección 11.
