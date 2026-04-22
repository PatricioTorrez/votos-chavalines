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
node server.js
```
El servidor queda corriendo en `http://localhost:3000`

### 3. Exponer a internet con ngrok (para que otros se conecten)
```bash
ngrok http 3000
```
ngrok genera una URL pública como `https://abc123.ngrok.io`. Esa URL es la que comparten los demás para entrar desde sus celulares.

> **Flujo completo en dos terminales:**
> ```
> Terminal 1 → node server.js
> Terminal 2 → ngrok http 3000
> ```

### Contraseña de admin
Por defecto es `admin`. Se puede cambiar con una variable de entorno:
```bash
ADMIN_PASSWORD=miClave node server.js
```

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
└── public/                ← Todo lo que el navegador puede ver
    ├── index.html         ← Estructura HTML de la app
    ├── style.css          ← Estilos y diseño responsive
    ├── script.js          ← Lógica del cliente (Socket.IO + UI)
    │
    ├── tambores.mp3       ← Audio de suspenso
    ├── claudio.mp3        ← Audio victoria Claudio (v1)
    ├── claudio2.mp3       ← Audio victoria Claudio (v2)
    ├── ferchos.mp3
    ├── ferchos2.mp3
    ├── bombo.mp3
    ├── bombo2.mp3
    ├── pitrisio.mp3
    ├── pitrisio2.mp3
    ├── empate_.mp3        ← Audio de empate
    │
    ├── claudio.png        ← Fotos de cada concursante
    ├── claudio_2.jpeg
    ├── claudio_3.jpeg
    ├── claudio_4.jpeg
    ├── ferchos.png
    ├── ferchos_2.jpeg
    ├── ... (misma estructura para bombo y pitrisio)
```

---

## 🖥️ server.js — Servidor

Escrito en **Node.js**. Es el cerebro del juego: guarda el estado de todos los jugadores, recibe votos, calcula resultados y los manda a todos los clientes en tiempo real via WebSocket.

### Configuración inicial

```js
const CONCURSANTES = ["Claudio 🍑🃏", "Ferchos 🙈🐵 ", "Bombo 🐷🐷", "Pitrisio 😭😭"]
```
Lista fija de jugadores válidos. Si alguien intenta conectarse con un nombre que no esté aquí, el servidor lo rechaza.

```js
const GALERIA = { "Claudio 🍑🃏": ["claudio.png", "claudio_2.jpeg", ...], ... }
```
Mapa de fotos por concursante. Al mostrar resultados, el servidor elige una foto aleatoria del ganador.

### Variables de estado global

| Variable | Tipo | Qué guarda |
|---|---|---|
| `usuarios` | Objeto | `{ socketId: { name, role } }` — todos los conectados |
| `adminSocketId` | String | ID del socket del admin actual |
| `votacionAbierta` | Boolean | Si hay una ronda en curso |
| `modoJuego` | String | `'normal'` o `'estrellas'` |
| `votosActuales` | Objeto | `{ socketId: candidato }` — votos en modo normal |
| `votosEstrellas` | Objeto | `{ socketId: { candidato: puntos } }` — votos en modo estrellas |
| `puntajeAcumulado` | Objeto | `{ candidato: total }` — puntos acumulados entre rondas |
| `inactivityTimers` | Objeto | Timers de 5 min por usuario inactivo |
| `usuariosActivos` | Set | Nombres de usuarios conectados (previene sesiones duplicadas) |

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
| `join_game` | Cliente | Login de usuario o admin. Valida nombre/contraseña, transfiere votos si reconecta |
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
| `login_success` | Cliente | `{ name, role }` |
| `login_failed` | Cliente | Mensaje de error |
| `session_replaced` | Cliente viejo | Aviso de que su sesión fue tomada |
| `round_started` | Todos | `{ mode, candidates, alreadyVoted }` |
| `vote_success` | Usuario | Confirma que el voto fue aceptado |
| `vote_error` | Usuario | Mensaje de error de voto |
| `admin_update_status` | Admin | Estado completo: jugadores, votos, puntajes |
| `pre_results` | Todos | Señal para mostrar pantalla de suspenso |
| `round_ended` | Todos | `{ mode, votes, audioVariant, winnerImage }` |
| `force_new_round_ui` | Todos | Resetea la UI para nueva ronda en modo estrellas |
| `notification` | Todos | Mensaje tipo toast informativo |
| `return_to_lobby` | Todos | Regresa a todos al lobby |
| `heartbeat_ack` | Usuario | Confirmación de heartbeat |

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
| `myName` | Nombre del jugador actual |
| `myEmoji` | Emoji del personaje actual |
| `currentMode` | Modo de la ronda activa (`'normal'` o `'estrellas'`) |
| `misCalificaciones` | `{ candidato: estrellas }` — calificaciones actuales del usuario |
| `selectedCharName` | Nombre del personaje seleccionado en el login |
| `isLoggingIn` | Bandera para evitar doble-login durante reconexión |
| `heartbeatInterval` | Referencia al intervalo del heartbeat |
| `ASSETS` | Mapa de emoji y nombre de audio por concursante |

### Funciones principales

#### Navegación de pantallas
```js
showScreen('login' | 'lobby' | 'voting' | 'suspense' | 'results')
```
Oculta todas las pantallas y activa la pedida con una transición de fade.

#### Login y sesión
```js
selectChar(btn)       // Selecciona un personaje en el login, habilita el botón de entrar
loginUser()           // Guarda el nombre en localStorage y emite join_game
loginAdmin()          // Emite join_game con contraseña
logout()              // Borra localStorage y recarga la página
attemptAutoLogin()    // Se ejecuta al conectar el socket; lee localStorage y reconecta automáticamente
```

#### Reconexión robusta
El auto-login está enganchado al evento `connect` del socket, no al `window.onload`. Esto evita la condición de carrera donde el socket aún no estaba listo cuando la página terminaba de cargar.

```js
socket.on('connect', () => {
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

## 🗒️ Notas para agregar nuevos jugadores

Para añadir un concursante nuevo hay que editar **3 lugares** en `server.js`:

```js
// 1. Agregar a la lista de concursantes
const CONCURSANTES = [
    "Claudio 🍑🃏",
    "Ferchos 🙈🐵 ",
    "Bombo 🐷🐷",
    "Pitrisio 😭😭",
    "NuevoJugador 🎮"   // ← aquí
];

// 2. Agregar sus fotos
const GALERIA = {
    ...
    "NuevoJugador 🎮": ["nuevo.png", "nuevo_2.jpeg"]   // ← aquí
};
```

Y en `script.js`:
```js
// 3. Agregar su emoji y nombre de audio
const ASSETS = {
    ...
    "NuevoJugador 🎮": { emoji: "🎮", baseName: "nuevo" }   // ← aquí
};
```

También agregar el botón en `index.html` dentro de `#character-grid` y subir las fotos y audios a la carpeta `public/`.