const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require("socket.io");
const historial = require('./lib/historial');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    connectTimeout: 45000,
});

// Fotos y audios se cachean fuerte: pesan y no cambian nunca.
// El codigo (html/js/css) NO: no hay fingerprint en los nombres, asi que
// cachearlo le serviria JS viejo contra un servidor nuevo al que vuelva a entrar.
const CODIGO = /\.(html|js|css)$/i;
// Ruta absoluta a proposito: con 'public' relativo, el server solo funciona si
// se lo arranca parado en la raiz del repo.
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '30d',
    setHeaders: (res, filePath) => {
        if (CODIGO.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    }
}));

// ============================================================
//  CONCURSANTES — se leen de data/concursantes.json
//  El id es la clave de todo el sistema. El nombre visible es solo presentacion.
// ============================================================
const DATA_DIR      = path.join(__dirname, 'data');
const ARCHIVO_DATOS = path.join(DATA_DIR, 'concursantes.json');
const ARCHIVO_ESTADO = path.join(DATA_DIR, 'estado.json');

function cargarConcursantes() {
    const raw = JSON.parse(fs.readFileSync(ARCHIVO_DATOS, 'utf8'));
    const lista = raw.concursantes;

    if (!Array.isArray(lista) || lista.length < 2) {
        throw new Error('data/concursantes.json debe tener al menos 2 concursantes.');
    }
    const vistos = new Set();
    lista.forEach(c => {
        if (!c.id || !/^[a-z0-9_-]+$/.test(c.id)) {
            throw new Error(`id invalido: ${JSON.stringify(c.id)} (solo minusculas, numeros, - y _)`);
        }
        if (vistos.has(c.id)) throw new Error(`id duplicado: ${c.id}`);
        vistos.add(c.id);
        if (!c.nombre) throw new Error(`El concursante ${c.id} no tiene nombre.`);
        if (!Array.isArray(c.audios) || !c.audios.length) {
            throw new Error(`El concursante ${c.id} no tiene audios.`);
        }
    });
    return { lista, audioEmpate: raw.audioEmpate };
}

const { lista: CONCURSANTES, audioEmpate: AUDIO_EMPATE } = cargarConcursantes();
const POR_ID  = new Map(CONCURSANTES.map(c => [c.id, c]));
const IDS     = CONCURSANTES.map(c => c.id);

// Lo que se manda al cliente para que arme la UI. Sin nombres escritos a mano alla.
const CONCURSANTES_PUBLICOS = CONCURSANTES.map(c => ({
    id: c.id,
    nombre: c.nombre,
    emojis: c.emojis || '',
    avatar: c.avatar || '🎮',
    display: [c.nombre, c.emojis].filter(Boolean).join(' '),
}));

function display(id) {
    const c = POR_ID.get(id);
    return c ? [c.nombre, c.emojis].filter(Boolean).join(' ') : id;
}

// ============================================================
//  CONFIGURACIÓN
// ============================================================
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutos
const SUSPENSO_MS        = 4000;          // duración del redoble antes del resultado

// Sin ADMIN_PASSWORD en el entorno se genera una al azar y se imprime al arrancar.
// Antes el default era "admin", sobre una URL de ngrok publica.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
    || crypto.randomBytes(3).toString('hex').toUpperCase();
const PASSWORD_GENERADA = !process.env.ADMIN_PASSWORD;

// ============================================================
//  ESTADO GLOBAL
// ============================================================
let usuarios        = {};  // socketId → { id, role }
let adminSocketId   = null;
let votacionAbierta = false;
let modoJuego       = 'normal'; // 'normal' | 'estrellas'

let votosActuales  = {};  // socketId → id de concursante
let votosEstrellas = {};  // socketId → { idConcursante: puntos }
let puntajeAcumulado = {};

let inactivityTimers = {};
let usuariosActivos  = new Set(); // ids actualmente conectados
let resultadosTimer  = null;      // timeout del suspenso, cancelable

// ============================================================
//  PERSISTENCIA — el acumulado sobrevive a un reinicio del proceso
// ============================================================
function inicializarPuntajes() {
    puntajeAcumulado = {};
    IDS.forEach(id => puntajeAcumulado[id] = 0);
}

function guardarEstado() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify({
            puntajeAcumulado,
            guardadoEn: new Date().toISOString(),
        }, null, 2));
    } catch (err) {
        console.error('⚠️  No se pudo guardar el estado:', err.message);
    }
}

function cargarEstado() {
    inicializarPuntajes();
    if (!fs.existsSync(ARCHIVO_ESTADO)) return;
    try {
        const guardado = JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, 'utf8'));
        const puntajes = guardado.puntajeAcumulado || {};
        let recuperados = 0;
        // Solo se restauran ids que sigan existiendo en concursantes.json
        for (const [id, pts] of Object.entries(puntajes)) {
            if (puntajeAcumulado[id] !== undefined && Number.isFinite(pts)) {
                puntajeAcumulado[id] = pts;
                if (pts > 0) recuperados++;
            }
        }
        if (recuperados) {
            console.log(`💾 Torneo recuperado de ${guardado.guardadoEn || 'una sesion previa'}`);
            IDS.forEach(id => console.log(`     ${display(id)}: ${puntajeAcumulado[id]} pts`));
        }
    } catch (err) {
        console.error('⚠️  data/estado.json ilegible, se arranca de cero:', err.message);
        inicializarPuntajes();
    }
}
cargarEstado();

// Sin credenciales devuelve false y la app funciona igual, sin historial.
historial.iniciar();

// ============================================================
//  HELPERS
// ============================================================
function resetInactivityTimer(socketId) {
    clearInactivityTimer(socketId);
    if (usuarios[socketId]?.role === 'user' && votacionAbierta) {
        inactivityTimers[socketId] = setTimeout(() => handleInactiveUser(socketId), INACTIVITY_TIMEOUT);
    }
}

function handleInactiveUser(socketId) {
    const usuario = usuarios[socketId];
    if (!usuario) return;
    console.log(`⏰ Inactivo: ${display(usuario.id)}`);

    if (modoJuego === 'normal' && !votosActuales[socketId]) {
        votosActuales[socketId] = null;
        io.to(socketId).emit('vote_error', '⏰ Tiempo agotado. Voto omitido.');
    } else if (modoJuego === 'estrellas' && !votosEstrellas[socketId]) {
        const votoMinimo = {};
        IDS.forEach(id => { if (id !== usuario.id) votoMinimo[id] = 1; });
        votosEstrellas[socketId] = votoMinimo;
        io.to(socketId).emit('vote_error', '⏰ Tiempo agotado. Voto mínimo registrado.');
    }
    actualizarAdmin();
    checkRoundCompletion();
}

function clearInactivityTimer(socketId) {
    if (inactivityTimers[socketId]) {
        clearTimeout(inactivityTimers[socketId]);
        delete inactivityTimers[socketId];
    }
}

function clearAllInactivityTimers() {
    Object.keys(inactivityTimers).forEach(id => clearTimeout(inactivityTimers[id]));
    inactivityTimers = {};
}

function cancelarResultadosPendientes() {
    if (resultadosTimer) { clearTimeout(resultadosTimer); resultadosTimer = null; }
}

function todosVotaron() {
    const users = Object.values(usuarios).filter(u => u.role === 'user');
    if (users.length === 0) return false;
    const votos = modoJuego === 'normal' ? votosActuales : votosEstrellas;
    const votedCount = Object.keys(votos).filter(id => usuarios[id]).length;
    return votedCount >= users.length;
}

let adminUpdateTimer = null;
function actualizarAdmin() {
    if (!adminSocketId) return;
    clearTimeout(adminUpdateTimer);
    adminUpdateTimer = setTimeout(_doActualizarAdmin, 50);
}

function _doActualizarAdmin() {
    if (!adminSocketId) return;
    const users = Object.entries(usuarios).filter(([_, u]) => u.role === 'user');
    const players = users.map(([sid, u]) => ({
        id: u.id,
        hasVoted: (modoJuego === 'normal' ? votosActuales[sid] : votosEstrellas[sid]) !== undefined
    }));
    const totalUsers  = users.length;
    const votedCount  = players.filter(p => p.hasVoted).length;
    const canProceed  = totalUsers > 0 && totalUsers === votedCount;

    io.to(adminSocketId).emit('admin_update_status', {
        players,
        votacionAbierta,
        modoJuego,
        canProceed,
        puntajeAcumulado
    });
}


// ============================================================
//  CONEXIONES
// ============================================================
// ============================================================
//  LÓGICA DE JUEGO
//  Viven en el ambito de modulo, no dentro de io.on(connection):
//  handleInactiveUser() las llama desde el timer de inactividad y antes
//  no podia verlas, lo que tumbaba el proceso a los 5 minutos.
//  Ninguna usa `socket`; operan sobre el estado de modulo y sobre `io`.
// ============================================================
function iniciarRonda(modo) {
    cancelarResultadosPendientes();
    modoJuego       = modo;
    votacionAbierta = true;
    votosActuales   = {};
    votosEstrellas  = {};
    if (modo === 'estrellas') { inicializarPuntajes(); guardarEstado(); }
    clearAllInactivityTimers();
    Object.keys(usuarios).forEach(sid => { if (usuarios[sid].role === 'user') resetInactivityTimer(sid); });
    io.emit('round_started', { mode: modo, candidates: IDS, alreadyVoted: false });
    actualizarAdmin();
}

// --- LÓGICA INTERNA ---
function checkRoundCompletion() {
    if (modoJuego === 'normal' && todosVotaron()) cerrarRondaNormal();
    else actualizarAdmin();
}

function acumularLogicaInterna() {
    Object.values(votosEstrellas).forEach(boleta => {
        for (const [id, puntos] of Object.entries(boleta)) {
            if (puntajeAcumulado[id] !== undefined) puntajeAcumulado[id] += parseInt(puntos) || 0;
        }
    });
    clearAllInactivityTimers(); // Limpiar primero para evitar votos tardíos en ronda nueva
    votosEstrellas = {};
    guardarEstado();
}

function acumularPuntos() {
    acumularLogicaInterna(); // ya limpia timers y guarda internamente
    Object.keys(usuarios).forEach(sid => { if (usuarios[sid].role === 'user') resetInactivityTimer(sid); });
    io.emit('force_new_round_ui');
    io.emit('notification', '✅ Ronda guardada. ¡A votar de nuevo!');
    actualizarAdmin();
}

function cerrarTorneoFinal() {
    votacionAbierta = false;
    clearAllInactivityTimers();
    enviarResultados(puntajeAcumulado, 'estrellas');
}

function cerrarRondaNormal() {
    votacionAbierta = false;
    clearAllInactivityTimers();
    const conteo = {};
    IDS.forEach(id => conteo[id] = 0);
    Object.values(votosActuales).forEach(voto => { if (voto && conteo[voto] !== undefined) conteo[voto]++; });
    enviarResultados(conteo, 'normal');
}

function enviarResultados(datos, modo) {
    const ranking    = Object.entries(datos).sort((a, b) => b[1] - a[1]);
    const maxScore   = ranking[0][1];
    const winners    = ranking.filter(r => r[1] === maxScore);
    const esEmpate   = winners.length > 1;

    let winnerImage = '';
    let audio       = AUDIO_EMPATE;

    if (!esEmpate) {
        const ganador = POR_ID.get(winners[0][0]);
        const imgs    = ganador?.galeria || [];
        if (imgs.length)          winnerImage = imgs[Math.floor(Math.random() * imgs.length)];
        if (ganador?.audios?.length) audio = ganador.audios[Math.floor(Math.random() * ganador.audios.length)];
    }

    // Historial: se registra cuando se DECIDE el resultado, no cuando se
    // muestra, asi no depende del setTimeout del suspenso (que es cancelable).
    // Fire-and-forget a proposito: no se await-ea y guardar() no rechaza, asi
    // un problema de red no puede demorar la pantalla de resultados.
    if (historial.disponible()) {
        const jugadores = Object.values(usuarios)
            .filter(u => u.role === 'user')
            .map(u => u.id);
        historial.guardar(
            historial.construirRegistro({ puntajes: datos, modo, jugadores })
        );
    }

    io.emit('pre_results');
    cancelarResultadosPendientes();
    resultadosTimer = setTimeout(() => {
        resultadosTimer = null;
        io.emit('round_ended', { mode: modo, votes: datos, audio, winnerImage });
    }, SUSPENSO_MS);
}

io.on('connection', (socket) => {
    console.log(`🔌 Conexión: ${socket.id}`);

    // El cliente arma toda su UI con esto — no tiene concursantes hardcodeados.
    socket.emit('contestants', CONCURSANTES_PUBLICOS);

    // LOGIN
    socket.on('join_game', (data) => {

        if (data.role === 'admin') {
            if (data.password !== ADMIN_PASSWORD) {
                return socket.emit('login_failed', 'Clave incorrecta');
            }
            if (adminSocketId && adminSocketId !== socket.id) {
                delete usuarios[adminSocketId];
            }
            adminSocketId = socket.id;
            usuarios[socket.id] = { id: null, role: 'admin' };
            socket.emit('login_success', { id: null, role: 'admin' });
            actualizarAdmin();
            return;
        }

        // --- Usuario normal ---
        const id = data.id;
        if (!POR_ID.has(id)) {
            return socket.emit('login_failed', 'Personaje no reconocido.');
        }

        // Reemplazar sesión previa del mismo concursante
        if (usuariosActivos.has(id)) {
            const oldId = Object.keys(usuarios).find(sid => usuarios[sid].id === id);
            if (oldId && oldId !== socket.id) {
                io.to(oldId).emit('session_replaced', 'Tu sesión fue reemplazada en otro dispositivo.');
                // Transferir votos
                if (votosActuales[oldId])  { votosActuales[socket.id]  = votosActuales[oldId];  delete votosActuales[oldId]; }
                if (votosEstrellas[oldId]) { votosEstrellas[socket.id] = votosEstrellas[oldId]; delete votosEstrellas[oldId]; }
                clearInactivityTimer(oldId);
                delete usuarios[oldId];
            }
        }

        usuarios[socket.id] = { id, role: 'user' };
        usuariosActivos.add(id);

        // Estado actual al reconectar
        const yaVotoNormal    = modoJuego === 'normal'    && votosActuales[socket.id]  !== undefined;
        const yaVotoEstrellas = modoJuego === 'estrellas' && votosEstrellas[socket.id] !== undefined;

        socket.emit('login_success', { id, role: 'user' });

        if (yaVotoNormal || yaVotoEstrellas) {
            socket.emit('vote_success');
            socket.emit('round_started', { mode: modoJuego, candidates: IDS, alreadyVoted: true });
        } else if (votacionAbierta) {
            socket.emit('round_started', { mode: modoJuego, candidates: IDS, alreadyVoted: false });
            resetInactivityTimer(socket.id);
        }

        actualizarAdmin();
    });

    // RONDAS
    socket.on('admin_start_voting', () => { if (socket.id === adminSocketId) iniciarRonda('normal'); });
    socket.on('admin_start_stars',  () => { if (socket.id === adminSocketId) iniciarRonda('estrellas'); });

    // VOTOS
    socket.on('cast_vote', (candidato) => {
        if (!votacionAbierta || modoJuego !== 'normal') return;
        const u = usuarios[socket.id];
        if (!u) return;
        if (!POR_ID.has(candidato)) return socket.emit('vote_error', 'Candidato inválido.');
        if (u.id === candidato) return socket.emit('vote_error', 'No puedes votarte a ti mismo.');
        votosActuales[socket.id] = candidato;
        socket.emit('vote_success');
        resetInactivityTimer(socket.id);
        actualizarAdmin();
        checkRoundCompletion();
    });

    socket.on('cast_star_vote', (calificaciones) => {
        if (!votacionAbierta || modoJuego !== 'estrellas') return;
        const u = usuarios[socket.id];
        if (!u) return;
        if (typeof calificaciones !== 'object' || Array.isArray(calificaciones) || calificaciones === null) {
            return socket.emit('vote_error', 'Datos de voto inválidos.');
        }
        // Solo permitir candidatos válidos, excluir al propio usuario, forzar enteros en rango 1-5
        const votosLimpios = {};
        IDS.forEach(id => {
            if (id === u.id) return;
            const val = parseInt(calificaciones[id]);
            if (!isNaN(val)) votosLimpios[id] = Math.max(1, Math.min(5, val));
        });
        // Verificar que calificó a todos (los que no son él mismo)
        const debeCalificar = IDS.filter(id => id !== u.id);
        if (debeCalificar.some(id => votosLimpios[id] === undefined || votosLimpios[id] < 1)) {
            return socket.emit('vote_error', 'Todos deben tener al menos 1 estrella.');
        }
        votosEstrellas[socket.id] = votosLimpios;
        socket.emit('vote_success');
        resetInactivityTimer(socket.id);
        actualizarAdmin();
        checkRoundCompletion();
    });

    // HEARTBEAT
    socket.on('heartbeat', () => {
        if (usuarios[socket.id]?.role === 'user') resetInactivityTimer(socket.id);
        socket.emit('heartbeat_ack');
    });

    // ACCIONES ADMIN
    socket.on('admin_accumulate_round', () => {
        if (socket.id !== adminSocketId) return;
        if (!todosVotaron()) return socket.emit('vote_error', '¡Faltan usuarios por votar!');
        acumularPuntos();
    });

    socket.on('admin_finish_tournament', () => {
        if (socket.id !== adminSocketId) return;
        if (!todosVotaron()) return socket.emit('vote_error', '¡Faltan usuarios por votar!');
        acumularLogicaInterna();
        cerrarTorneoFinal();
    });

    socket.on('admin_force_finish', () => {
        if (socket.id !== adminSocketId) return;
        if (!votacionAbierta || modoJuego !== 'normal') {
            return socket.emit('notification', '⚠️ No hay una ronda normal activa para forzar.');
        }
        cerrarRondaNormal();
    });

    socket.on('admin_reset_scores', () => {
        if (socket.id !== adminSocketId) return;
        inicializarPuntajes();
        guardarEstado();
        io.emit('notification', '🏆 Puntuaciones reiniciadas a 0');
        actualizarAdmin();
    });

    socket.on('admin_reset_lobby', () => {
        if (socket.id !== adminSocketId) return;
        votacionAbierta = false;
        // Sin esto, un resultado agendado seguia disparandose 4s despues
        // aunque el admin ya hubiera vuelto al lobby.
        cancelarResultadosPendientes();
        clearAllInactivityTimers();
        io.emit('return_to_lobby');
        actualizarAdmin();
    });

    // HISTORIAL — solo admin. Se pide al abrir el panel, no en cada update.
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

    // DESCONEXIÓN
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Desconexión: ${socket.id} — ${reason}`);
        clearInactivityTimer(socket.id);
        if (socket.id === adminSocketId) adminSocketId = null;
        if (usuarios[socket.id]) {
            if (usuarios[socket.id].id) usuariosActivos.delete(usuarios[socket.id].id);
            delete usuarios[socket.id];
        }
        actualizarAdmin();
        if (votacionAbierta && modoJuego === 'normal') checkRoundCompletion();
    });

});

const PORT = process.env.PORT || 3000;

// Solo se levanta el servidor cuando se ejecuta directamente (`npm start`).
// Al requerirlo desde un test no se ocupa ningun puerto.
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`\n🚀 Servidor activo: http://localhost:${PORT}`);
        console.log(`👥 Concursantes: ${IDS.map(display).join(' · ')}`);
        console.log(`⚙️  Timeout de inactividad: ${INACTIVITY_TIMEOUT / 1000}s`);
        if (historial.disponible()) {
            console.log(`📜 Historial: activo (proyecto ${historial.proyectoActual()})`);
        } else {
            console.log(`📜 Historial: sin configurar — se juega igual, no se guardan registros`);
        }
        if (PASSWORD_GENERADA) {
            console.log(`\n🔑 Clave de admin (generada para esta sesión): ${ADMIN_PASSWORD}`);
            console.log(`   Para fijarla: ADMIN_PASSWORD=tuClave npm start\n`);
        } else {
            console.log(`🔑 Clave de admin: la de la variable ADMIN_PASSWORD\n`);
        }
    });
}

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
        // Permite levantar el server desde un script que parchea lib/historial
        // para probar las ramas de Firestore sin credenciales reales.
        escuchar(port) { return server.listen(port); },
        cerrar() {
            clearAllInactivityTimers();
            cancelarResultadosPendientes();
            io.close();
            server.close();
        },
    },
};
