# 🏆 Los Chavalines — Documentación del Proyecto

Plataforma de votación en tiempo real para torneos entre amigos. Permite votar de forma secreta, ver resultados en vivo con animaciones, y jugar en dos modos distintos. Diseñada para usarse desde celular.

---

## ⚡ Cómo ejecutar el proyecto

### 1. Instalar dependencias (solo la primera vez)
```bash
npm install
```

### 2. Iniciar el servidor
```bash
npm start
```
El servidor queda corriendo en `http://localhost:3000`

### 3. Exponer a internet con ngrok (para que otros se conecten)
```bash
ngrok http 3000
```
ngrok genera una URL pública como `https://abc123.ngrok.io`. Esa URL es la que comparten los demás para entrar desde sus celulares.

> **Flujo completo en dos terminales:**
> ```
> Terminal 1 → npm start
> Terminal 2 → ngrok http 3000
> ```

### 4. Deploy en Render (opcional, para tener una URL fija)

Alternativa a ngrok: una URL que no cambia y no depende de tu máquina prendida.
El repo ya trae `render.yaml`, así que Render se configura solo.

1. Subí el repo a GitHub (si no está).
2. En [Render](https://dashboard.render.com) → **New** → **Blueprint** → elegí
   el repo. Render lee `render.yaml` y arma el servicio.
3. Te va a pedir el valor de `FIREBASE_SERVICE_ACCOUNT`: pegá **todo** el
   contenido de `serviceAccountKey.json`. Si lo dejás vacío, el juego funciona
   igual pero no guarda historial.
4. Queda en `https://votos-chavalines.onrender.com` (el nombre puede variar si
   ya está tomado). Esa URL es la que comparten.

Para cambiar la clave de admin en el server desplegado: **Environment** → agregar
`ADMIN_PASSWORD`. Sin eso, sigue siendo `12345678`.

**Dos cosas del plan gratis** que conviene saber antes de la noche de torneo:

- El servicio **se duerme a los 15 minutos** sin visitas. La primera persona que
  entre después va a esperar ~1 minuto a que despierte. Abrí la URL un rato
  antes de que lleguen los demás.
- El disco es **efímero**: al dormirse o al hacer un deploy se borra
  `data/estado.json`, o sea que los puntajes del torneo en curso arrancan de
  cero. El historial no se pierde: eso vive en Firestore.

> **Por qué no Vercel:** el juego necesita un proceso vivo con estado en memoria
> (quién es el admin, los votos de la ronda) y un WebSocket abierto con cada
> celular. Las funciones serverless de Vercel no sostienen ninguna de las dos
> cosas: cada request puede caer en un proceso distinto, y de ahí el
> `FUNCTION_INVOCATION_FAILED`.

### Contraseña de admin
La clave es fija: **`12345678`**. El servidor la imprime al arrancar:
```
🔑 Clave de admin: 12345678
```
Para usar otra, sin tocar el código:
```bash
ADMIN_PASSWORD=miClave npm start
```

### Tests
```bash
npm test
```
Verifica que `data/concursantes.json` sea coherente, que todas las fotos y audios
que referencia existan de verdad en `public/`, y que la lógica del historial
cuente bien las victorias. Corre **offline y sin credenciales de Firebase**.

### Historial de torneos (Firebase)

El historial de quién ganó y cuándo se guarda en Cloud Firestore. Es opcional:
**sin configurar, la app funciona igual**, solo que no guarda registros.

Para activarlo:

1. En [Firebase Console](https://console.firebase.google.com), entrá a tu
   proyecto → ⚙️ **Configuración del proyecto** → **Cuentas de servicio** →
   **Generar nueva clave privada**. Te baja un JSON.
2. Guardalo como `serviceAccountKey.json` en la raíz del proyecto.
   Ya está en `.gitignore`: **nunca lo subas al repo**. Da acceso completo al
   proyecto de Firebase; si se te filtra, revocala desde la misma pantalla.
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
   una URL pública y no tiene login, esta es la configuración correcta — el
   "modo de prueba" de Firestore dejaría que cualquiera con el link te borre el
   historial.

4. `npm start`. El banner te dice si quedó activo:

   ```
   📜 Historial: activo (proyecto votos-chavalines)
   ```

Dos alternativas a los pasos 1-2, por si el archivo no te sirve:

```bash
# apuntar la variable estándar de Google a otra ruta
GOOGLE_APPLICATION_CREDENTIALS=/ruta/al/key.json npm start

# o pegar el JSON entero en una variable (así se configura en Render)
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}' npm start
```

`FIREBASE_SERVICE_ACCOUNT` también acepta el mismo JSON en base64, para paneles
que no dejan pegar saltos de línea.

Una vez configurado, el admin ve el botón **HISTORIAL** en su panel:

- **Ranking histórico** — 🏆 torneos ganados y 🎵 rondas ganadas, contados por
  separado. Se cuentan aparte a propósito: las rondas normales son muchas por
  noche y taparían a los torneos, que son pocos y significativos.
- **Últimos torneos** — fecha, tipo, ganador y puntaje, del más reciente al más
  viejo. Los empates se marcan con 🤝 y cuentan como victoria para cada uno.

Se registra tanto el cierre de un torneo de estrellas como el de cada ronda
normal, diferenciados por el campo `tipo`. El registro se escribe en el momento
en que se decide el resultado y **nunca bloquea la partida**: si Firestore falla,
se pierde ese registro, se loguea en consola y el juego sigue igual.

---

## 🧰 Tecnologías utilizadas

| Tecnología | Rol en el proyecto |
|---|---|
| **Node.js** | Entorno de ejecución del servidor |
| **Express.js** | Servidor HTTP y servir archivos estáticos |
| **Socket.IO** | Comunicación en tiempo real (WebSocket) |
| **HTML5** | Estructura de la interfaz |
| **CSS3** | Estilos, animaciones, diseño responsive |
| **JavaScript (Vanilla)** | Lógica del cliente, manejo de eventos |
| **canvas-confetti** | Efecto de confeti en pantalla de resultados |
| **ngrok** | Túnel para exponer el servidor local a internet |

**Lenguaje principal:** JavaScript (tanto servidor como cliente)

---

## 📁 Estructura de archivos

```
proyecto/
│
├── server.js              ← Servidor principal (Node.js + Socket.IO)
│
├── data/
│   ├── concursantes.json  ← FUENTE ÚNICA de los concursantes (ver más abajo)
│   └── estado.json        ← Puntajes acumulados. Se genera solo, no se commitea
│
├── test/
│   └── concursantes.test.js  ← npm test
│
└── public/                ← Todo lo que el navegador puede ver
    ├── index.html         ← Estructura HTML de la app
    ├── style.css          ← Estilos y diseño responsive
    ├── script.js          ← Lógica del cliente (Socket.IO + UI)
    │
    ├── media/             ← Fotos optimizadas que sirve la app (máx 600px, ~35 KB)
    │   ├── claudio.jpg
    │   ├── claudio_2.jpg
    │   └── ...
    │
    ├── claudio.png        ← Originales. No se sirven; quedan como fuente
    ├── claudio_2.jpeg     ←   para regenerar media/ si hace falta
    ├── ...
    │
    ├── tambores.mp3       ← Audio de suspenso
    ├── empate_.mp3        ← Audio de empate
    ├── claudio.mp3        ← Audios de victoria (algunos tienen 2 variantes)
    ├── claudio2.mp3
    └── ...
```

> Para regenerar `public/media/` desde los originales (requiere ffmpeg):
> ```bash
> cd public
> for f in *.png *.jpeg; do
>   ffmpeg -y -i "$f" -vf "scale=w='min(600,iw)':h='min(600,ih)':force_original_aspect_ratio=decrease" -q:v 4 "media/${f%.*}.jpg"
> done
> ```

---

## 🖥️ server.js — Servidor

Escrito en **Node.js**. Es el cerebro del juego: guarda el estado de todos los jugadores, recibe votos, calcula resultados y los manda a todos los clientes en tiempo real via WebSocket.

### Configuración inicial

Los concursantes **no están escritos en el código**: se leen de `data/concursantes.json`.
El servidor valida el archivo al arrancar (ids únicos y válidos, nombre, al menos un audio)
y se lo manda al cliente, que arma la grilla de personajes con eso.

```json
{
  "id": "claudio",              // ← la clave de TODO el sistema
  "nombre": "Claudio",          // ← lo que se ve debajo del emoji
  "emojis": "🍑🃏",             // ← decoración que acompaña al nombre
  "avatar": "🍑",               // ← el emoji grande
  "galeria": ["media/claudio.jpg", "..."],
  "audios": ["claudio.mp3", "claudio2.mp3"]
}
```

Al mostrar resultados el servidor elige una foto y un audio al azar de los que
el ganador tenga declarados. Como solo puede elegir archivos listados ahí,
no puede pedir uno que no exista.

### Persistencia

`puntajeAcumulado` se guarda en `data/estado.json` cada vez que cambia (acumular
ronda, cerrar torneo, reiniciar puntajes) y se recupera al arrancar. Si el proceso
se cae a mitad de un torneo, el acumulado sobrevive.

### Variables de estado global

| Variable | Tipo | Qué guarda |
|---|---|---|
| `usuarios` | Objeto | `{ socketId: { id, role } }` — todos los conectados |
| `adminSocketId` | String | ID del socket del admin actual |
| `votacionAbierta` | Boolean | Si hay una ronda en curso |
| `modoJuego` | String | `'normal'` o `'estrellas'` |
| `votosActuales` | Objeto | `{ socketId: candidato }` — votos en modo normal |
| `votosEstrellas` | Objeto | `{ socketId: { candidato: puntos } }` — votos en modo estrellas |
| `puntajeAcumulado` | Objeto | `{ candidato: total }` — puntos acumulados entre rondas |
| `inactivityTimers` | Objeto | Timers de 5 min por usuario inactivo |
| `usuariosActivos` | Set | Ids de usuarios conectados (previene sesiones duplicadas) |
| `resultadosTimer` | Timeout | Timer del suspenso, cancelable si el admin vuelve al lobby |

### Funciones del servidor

#### `inicializarPuntajes()`
Pone todos los puntajes en 0. Se llama al iniciar el servidor y al comenzar el modo estrellas.

#### `resetInactivityTimer(socketId)`
Reinicia el contador de 5 minutos de inactividad para un usuario. Se llama cada vez que el usuario hace una acción (votar, heartbeat). Si el tiempo se agota, activa `handleInactiveUser`.

#### `handleInactiveUser(socketId)`
Se ejecuta si un usuario no votó en 5 minutos. En modo normal marca su voto como nulo. En modo estrellas le asigna 1 estrella a todos automáticamente. Así el juego no se queda trabado esperando a alguien.

#### `clearInactivityTimer(socketId)` / `clearAllInactivityTimers()`
Limpia timers individuales o todos. Se usan al cerrar una ronda o al desconectar un usuario.

#### `todosVotaron()`
Revisa si el número de votos registrados es igual al número de usuarios conectados. Retorna `true` o `false`.

#### `actualizarAdmin()`
Manda al admin el estado completo en tiempo real: qué jugadores están conectados, quién ya votó, si puede proceder, y los puntajes acumulados.

### Eventos Socket.IO que escucha el servidor

| Evento | Quién lo manda | Qué hace |
|---|---|---|
| `join_game` | Cliente | Login. Usuario manda `{ role:'user', id }`; admin `{ role:'admin', password }`. Transfiere votos si reconecta |
| `cast_vote` | Usuario | Registra un voto en modo normal. Valida que no se vote a sí mismo |
| `cast_star_vote` | Usuario | Registra calificaciones de estrellas. Valida que nadie tenga 0 |
| `heartbeat` | Usuario | Señal de vida cada 30s para resetear el timer de inactividad |
| `admin_start_voting` | Admin | Inicia una ronda en modo normal |
| `admin_start_stars` | Admin | Inicia una ronda en modo estrellas |
| `admin_accumulate_round` | Admin | Suma los votos actuales al acumulado y abre nueva ronda |
| `admin_finish_tournament` | Admin | Suma votos y muestra resultados finales del torneo |
| `admin_force_finish` | Admin | Fuerza el cierre de una ronda normal aunque no todos hayan votado |
| `admin_reset_scores` | Admin | Reinicia todos los puntajes a 0 |
| `admin_reset_lobby` | Admin | Regresa a todos al lobby |
| `disconnect` | Sistema | Limpia al usuario desconectado, transfiere su estado si vuelve |

### Eventos que emite el servidor

| Evento | A quién | Qué contiene |
|---|---|---|
| `login_success` | Cliente | `{ id, role }` (`id` es `null` para el admin) |
| `login_failed` | Cliente | Mensaje de error |
| `session_replaced` | Cliente viejo | Aviso de que su sesión fue tomada |
| `round_started` | Todos | `{ mode, candidates, alreadyVoted }` |
| `vote_success` | Usuario | Confirma que el voto fue aceptado |
| `vote_error` | Usuario | Mensaje de error de voto |
| `admin_update_status` | Admin | Estado completo: jugadores, votos, puntajes |
| `pre_results` | Todos | Señal para mostrar pantalla de suspenso |
| `round_ended` | Todos | `{ mode, votes, audio, winnerImage }` — `votes` va indexado por id; `audio` ya viene resuelto |
| `force_new_round_ui` | Todos | Resetea la UI para nueva ronda en modo estrellas |
| `notification` | Todos | Mensaje tipo toast informativo |
| `return_to_lobby` | Todos | Regresa a todos al lobby |
| `heartbeat_ack` | Usuario | Confirmación de heartbeat |
| `contestants` | Cliente | Lista de concursantes al conectar. El cliente arma la UI con esto |

---

## 🌐 index.html — Estructura

Contiene 5 pantallas dentro de un mismo `div.app-shell`. Solo una está visible a la vez, controlada por JavaScript.

| ID de pantalla | Nombre | Cuándo se muestra |
|---|---|---|
| `#screen-login` | Login | Al entrar a la página por primera vez |
| `#screen-lobby` | Lobby | Tras hacer login, mientras espera al admin |
| `#screen-voting` | Votación | Cuando el admin inicia una ronda |
| `#screen-suspense` | Suspenso | Cuenta regresiva antes de mostrar resultados |
| `#screen-results` | Resultados | Muestra ganador, score y podio |

### Elementos clave del HTML

- `#character-grid` — Botones de selección de personaje en el login
- `#admin-panel` — Panel de control (solo visible para admin en el lobby)
- `#cards-container` — Tarjetas de votación en modo normal
- `#stars-container` — Tarjetas de calificación en modo estrellas
- `#live-voting-list` — Estado en vivo de quién ya votó (solo admin)
- `#countdown-display` — Número de cuenta regresiva en suspenso
- `#winner-section` — Muestra al ganador o empate
- `#podium` — Tabla de posiciones
- `#toast-container` — Notificaciones flotantes
- `#connection-indicator` — Indicador de estado de conexión
- `#confetti-canvas` — Canvas del efecto confeti

---

## 🎨 style.css — Estilos

Diseño **mobile-first** con mejoras progresivas para pantallas grandes. Usa glassmorphism (vidrio esmerilado) como estética principal.

### Sistema de colores (variables CSS)

| Variable | Color | Uso |
|---|---|---|
| `--bg` | `#07070A` | Fondo general oscuro |
| `--surface` | `rgba(18,18,24,0.75)` | Panel principal con transparencia |
| `--red` | `#E63946` | Color primario, botones, acentos |
| `--orange` | `#F4A261` | Color secundario, modo estrellas |
| `--teal` | `#2EC4B6` | Confirmaciones, estado "listo" |
| `--gold` | `#FFD166` | Estrellas activas |
| `--text` | `#F0F0F0` | Texto principal |
| `--text-muted` | `#8A8A9A` | Texto secundario/etiquetas |

### Clases principales

| Clase | Qué hace |
|---|---|
| `.app-shell` | Contenedor principal con blur y borde vidriado |
| `.screen` | Pantalla oculta por defecto (`display:none`) |
| `.screen.active` | Pantalla visible con fade-in |
| `.char-btn` | Botón de selección de personaje en login |
| `.char-btn.selected` | Estado seleccionado (borde rojo) |
| `.char-btn.saved` | Marca el personaje guardado en cookies |
| `.vote-card` | Tarjeta de candidato en modo normal |
| `.vote-card.selected` | Tarjeta elegida (resaltada) |
| `.star-card` | Tarjeta de calificación en modo estrellas |
| `.star-card.card-error` | Tarjeta con error (sin calificar) |
| `.star-icon.active` | Estrella encendida (dorada) |
| `.admin-panel` | Panel del admin en el lobby |
| `.live-row` | Fila de estado por jugador en votación |
| `.live-row.voted` | Jugador que ya terminó de votar |
| `.toast` | Notificación flotante |
| `.toast-info / .toast-error / .toast-warning` | Variantes de color del toast |
| `.connection-indicator` | Indicador de conexión (arriba a la derecha) |
| `.blob` | Círculos difusos del fondo animado |
| `.podium-row` | Fila del ranking en resultados |
| `.winner-showcase` | Contenedor del ganador con foto y nombre |

### Breakpoints responsive

| Ancho | Cambios |
|---|---|
| Default (móvil) | 1 columna, personajes en cuadrícula 2×2 |
| `≥ 600px` (tablet) | Personajes en fila de 4, tarjetas de voto en 2 columnas |
| `≥ 900px` (desktop) | Panel más ancho, mejor aprovechamiento del espacio |
| `≤ 360px` (pequeño) | Padding reducido, estrellas y avatar más compactos |

---

## ⚙️ script.js — Lógica del cliente

Escrito en **JavaScript Vanilla**. Maneja toda la interfaz de usuario y la comunicación con el servidor via Socket.IO.

### Variables globales del cliente

| Variable | Qué guarda |
|---|---|
| `myRole` | `'user'` o `'admin'` |
| `myId` | Id del jugador actual (`'bombo'`, no `'Bombo 🐷🐷'`) |
| `myEmoji` | Emoji del personaje actual |
| `currentMode` | Modo de la ronda activa (`'normal'` o `'estrellas'`) |
| `misCalificaciones` | `{ id: estrellas }` — calificaciones actuales del usuario |
| `selectedCharId` | Id del personaje seleccionado en el login |
| `isLoggingIn` | Bandera para evitar doble-login durante reconexión |
| `heartbeatInterval` | Referencia al intervalo del heartbeat |
| `ROSTER` | `Map` de concursantes que mandó el servidor. Se consulta con `nombreDe(id)` y `emojiDe(id)` |
| `pendingScreen` | Pantalla a la que se quiere llegar; descarta transiciones que quedaron viejas |

### Funciones principales

#### Navegación de pantallas
```js
showScreen('login' | 'lobby' | 'voting' | 'suspense' | 'results')
```
Oculta todas las pantallas y activa la pedida con una transición de fade.

#### Login y sesión
```js
renderCharacterGrid() // Arma los botones de personaje con lo que mandó el servidor
selectChar(btn)       // Selecciona un personaje en el login, habilita el botón de entrar
loginUser()           // Guarda el id en localStorage y emite join_game
loginAdmin()          // Emite join_game con contraseña
logout()              // Borra localStorage y recarga la página
attemptAutoLogin()    // Lee el id de localStorage y reconecta automáticamente
idGuardado()          // Devuelve el id guardado, migrando el formato viejo (nombre con emojis)
```

#### Reconexión robusta
El auto-login está enganchado al evento `contestants` del socket, no al `window.onload` ni al `connect`: hace falta el roster para poder validar el id guardado.

```js
socket.on('contestants', (lista) => {
    lista.forEach(c => ROSTER.set(c.id, c));
    renderCharacterGrid();
    attemptAutoLogin(); // Un solo punto de verdad para el auto-login
});
```

#### Votación normal
Al recibir `round_started` con `mode: 'normal'`, se generan dinámicamente las tarjetas `.vote-card` para cada candidato (excluyendo al propio jugador). Al hacer clic en una, emite `cast_vote`.

#### Votación por estrellas
```js
renderStarVoting(candidates)   // Genera las tarjetas con 5 estrellas por candidato
rateUser(candidato, valor)     // Actualiza la UI de estrellas y guarda en misCalificaciones
submitStarVotes()              // Valida que todos tengan ≥1 estrella y emite cast_star_vote
```

#### Notificaciones
```js
showToast(message, type)   // Muestra un mensaje flotante tipo 'info', 'error' o 'warning'
```
Reemplaza a los `alert()` para no interrumpir la experiencia de uso.

#### Audio
```js
playAudio(filename)   // Carga y reproduce el audio del ganador con límite de 7 segundos
stopAudio()           // Detiene el audio actual
```
Si falla la versión 2 de un audio (ej: `claudio2.mp3`), automáticamente intenta la versión 1 (`claudio.mp3`).

#### Heartbeat
```js
startHeartbeat()   // Inicia un intervalo de 30s que emite 'heartbeat' al servidor
stopHeartbeat()    // Detiene el intervalo (al desconectar o al cerrar sesión)
```
Mantiene viva la sesión para que el servidor no marque al usuario como inactivo.

#### Conexión
```js
updateConnectionStatus('connected' | 'disconnected' | 'reconnecting')
```
Actualiza el indicador visual de conexión en la esquina superior derecha.

---

## 🔄 Flujo completo de una partida

```
1. Admin abre la URL y entra con contraseña
2. Jugadores abren la URL en sus celulares y eligen su personaje
3. Admin ve la lista de conectados en el lobby
4. Admin presiona "Modo Normal" o "Modo Estrellas"
   └─ El servidor emite round_started a todos
5. Jugadores ven la pantalla de votación y votan
   └─ Al votar, el servidor recibe el voto y notifica al admin quién ya votó
6. Cuando todos votaron (o el admin fuerza el final):
   └─ Servidor emite pre_results → pantalla de suspenso con cuenta regresiva
   └─ 4 segundos después emite round_ended → pantalla de resultados
7. Confeti, audio del ganador, foto y podio de posiciones
8. Admin presiona "Volver al lobby" para jugar otra vez
```

### Flujo de reconexión
```
Usuario sale del navegador → socket se desconecta en el servidor
Usuario vuelve a abrir la URL → socket emite 'connect'
  └─ Client lee localStorage → emite join_game automáticamente
     └─ Servidor encuentra el nombre, registra el nuevo socket
        └─ Si había votación abierta y ya había votado → muestra "esperando"
        └─ Si había votación abierta y no había votado → muestra pantalla de voto
```

---

## 🔒 Seguridad y validaciones

| Validación | Dónde |
|---|---|
| Nombre de usuario debe estar en la lista `CONCURSANTES` | Servidor |
| No puedes votarte a ti mismo | Servidor |
| Todos deben tener ≥1 estrella en modo estrellas | Servidor y cliente |
| Solo el admin puede iniciar/terminar rondas | Servidor (verifica `adminSocketId`) |
| Sesión duplicada: la nueva reemplaza a la anterior | Servidor |
| Contraseña de admin configurable por variable de entorno | Servidor |
| Timer de inactividad de 5 minutos por usuario | Servidor |

---

## 🗒️ Cómo agregar un jugador nuevo

**Un solo lugar:** `data/concursantes.json`.

1. Copiá las fotos y los audios a `public/` (y generá las versiones optimizadas en `public/media/`, ver arriba).
2. Agregá el objeto al array:

```json
{
  "id": "nuevo",
  "nombre": "NuevoJugador",
  "emojis": "🎮",
  "avatar": "🎮",
  "galeria": ["media/nuevo.jpg", "media/nuevo_2.jpg"],
  "audios": ["nuevo.mp3"]
}
```

3. `npm test` — falla si alguna foto o audio no existe.
4. `npm start`.

No hay que tocar `server.js`, `index.html` ni `script.js`. El `id` es la clave interna
(minúsculas, sin espacios ni emojis); `nombre` + `emojis` es solo lo que se muestra.

> **Antes** el nombre completo con emojis era la clave, escrito a mano en 3 archivos.
> Uno de ellos (`"Ferchos 🙈🐵 "`) tenía un espacio final invisible que había que
> replicar exactamente en cada sitio o el jugador no podía entrar.

También agregar el botón en `index.html` dentro de `#character-grid` y subir las fotos y audios a la carpeta `public/`.