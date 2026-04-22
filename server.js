const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    connectTimeout: 45000,
});

app.use(express.static('public'));

// --- CONFIGURACIÓN ---
const CONCURSANTES = [
    "Claudio 🍑🃏",
    "Ferchos 🙈🐵 ",
    "Bombo 🐷🐷",
    "Pitrisio 😭😭"
];

const GALERIA = {
    "Claudio 🍑🃏":  ["claudio.png",  "claudio_2.jpeg",  "claudio_3.jpeg",  "claudio_4.jpeg"],
    "Ferchos 🙈🐵 ": ["ferchos.png",  "ferchos_2.jpeg",  "ferchos_3.jpeg",  "ferchos_4.jpeg", "ferchos_6.jpeg"],
    "Bombo 🐷🐷":    ["bombo.png",    "bombo_2.jpeg",    "bombo_3.jpeg",    "bombo_4.jpeg"],
    "Pitrisio 😭😭": ["pitrisio.png", "pitrisio_2.jpeg", "pitrisio_3.jpeg", "pitrisio_4.jpeg"]
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutos

// --- ESTADO GLOBAL ---
let usuarios        = {};  // socketId → { name, role }
let adminSocketId   = null;
let votacionAbierta = false;
let modoJuego       = 'normal'; // 'normal' | 'estrellas'

let votosActuales  = {};  // socketId → candidato
let votosEstrellas = {};  // socketId → { candidato: puntos }
let puntajeAcumulado = {};

let inactivityTimers = {};
let usuariosActivos  = new Set(); // nombres actualmente conectados

// --- HELPERS ---
function inicializarPuntajes() {
    CONCURSANTES.forEach(c => puntajeAcumulado[c] = 0);
}
inicializarPuntajes();

function resetInactivityTimer(socketId) {
    clearInactivityTimer(socketId);
    if (usuarios[socketId]?.role === 'user' && votacionAbierta) {
        inactivityTimers[socketId] = setTimeout(() => handleInactiveUser(socketId), INACTIVITY_TIMEOUT);
    }
}

function handleInactiveUser(socketId) {
    const usuario = usuarios[socketId];
    if (!usuario) return;
    console.log(`⏰ Inactivo: ${usuario.name}`);

    if (modoJuego === 'normal' && !votosActuales[socketId]) {
        votosActuales[socketId] = null;
        io.to(socketId).emit('vote_error', '⏰ Tiempo agotado. Voto omitido.');
    } else if (modoJuego === 'estrellas' && !votosEstrellas[socketId]) {
        const votoMinimo = {};
        CONCURSANTES.forEach(c => { if (c !== usuario.name) votoMinimo[c] = 1; });
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
    const players = users.map(([id, u]) => ({
        name: u.name,
        hasVoted: (modoJuego === 'normal' ? votosActuales[id] : votosEstrellas[id]) !== undefined
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


// --- CONEXIONES ---
io.on('connection', (socket) => {
    console.log(`🔌 Conexión: ${socket.id}`);

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
            usuarios[socket.id] = { name: "ADMIN", role: 'admin' };
            socket.emit('login_success', { name: "ADMIN", role: 'admin' });
            actualizarAdmin();
            return;
        }

        // --- Usuario normal ---
        const name = data.name;
        if (!CONCURSANTES.includes(name)) {
            return socket.emit('login_failed', 'Nombre no reconocido.');
        }

        // Reemplazar sesión previa del mismo usuario
        if (usuariosActivos.has(name)) {
            const oldId = Object.keys(usuarios).find(id => usuarios[id].name === name);
            if (oldId && oldId !== socket.id) {
                io.to(oldId).emit('session_replaced', 'Tu sesión fue reemplazada en otro dispositivo.');
                // Transferir votos
                if (votosActuales[oldId])  { votosActuales[socket.id]  = votosActuales[oldId];  delete votosActuales[oldId]; }
                if (votosEstrellas[oldId]) { votosEstrellas[socket.id] = votosEstrellas[oldId]; delete votosEstrellas[oldId]; }
                clearInactivityTimer(oldId);
                delete usuarios[oldId];
            }
        }

        usuarios[socket.id] = { name, role: 'user' };
        usuariosActivos.add(name);

        // Estado actual al reconectar
        const yaVotoNormal   = modoJuego === 'normal'    && votosActuales[socket.id]  !== undefined;
        const yaVotoEstrellas = modoJuego === 'estrellas' && votosEstrellas[socket.id] !== undefined;

        socket.emit('login_success', { name, role: 'user' });

        if (yaVotoNormal || yaVotoEstrellas) {
            socket.emit('vote_success');
            socket.emit('round_started', { mode: modoJuego, candidates: CONCURSANTES, alreadyVoted: true });
        } else if (votacionAbierta) {
            socket.emit('round_started', { mode: modoJuego, candidates: CONCURSANTES, alreadyVoted: false });
            resetInactivityTimer(socket.id);
        }

        actualizarAdmin();
    });

    // RONDAS
    socket.on('admin_start_voting', () => { if (socket.id === adminSocketId) iniciarRonda('normal'); });
    socket.on('admin_start_stars',  () => { if (socket.id === adminSocketId) iniciarRonda('estrellas'); });

    function iniciarRonda(modo) {
        modoJuego       = modo;
        votacionAbierta = true;
        votosActuales   = {};
        votosEstrellas  = {};
        if (modo === 'estrellas') inicializarPuntajes();
        clearAllInactivityTimers();
        Object.keys(usuarios).forEach(id => { if (usuarios[id].role === 'user') resetInactivityTimer(id); });
        io.emit('round_started', { mode: modo, candidates: CONCURSANTES, alreadyVoted: false });
        actualizarAdmin();
    }

    // VOTOS
    socket.on('cast_vote', (candidato) => {
        if (!votacionAbierta || modoJuego !== 'normal') return;
        const u = usuarios[socket.id];
        if (!u) return;
        if (u.name === candidato) return socket.emit('vote_error', 'No puedes votarte a ti mismo.');
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
        CONCURSANTES.forEach(c => {
            if (c === u.name) return;
            const val = parseInt(calificaciones[c]);
            if (!isNaN(val)) votosLimpios[c] = Math.max(1, Math.min(5, val));
        });
        // Verificar que calificó a todos (los que no son él mismo)
        const debeCalificar = CONCURSANTES.filter(c => c !== u.name);
        if (debeCalificar.some(c => votosLimpios[c] === undefined || votosLimpios[c] < 1)) {
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
        io.emit('notification', '🏆 Puntuaciones reiniciadas a 0');
        actualizarAdmin();
    });

    socket.on('admin_reset_lobby', () => {
        if (socket.id !== adminSocketId) return;
        votacionAbierta = false;
        clearAllInactivityTimers();
        io.emit('return_to_lobby');
        actualizarAdmin();
    });

    // DESCONEXIÓN
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Desconexión: ${socket.id} — ${reason}`);
        clearInactivityTimer(socket.id);
        if (socket.id === adminSocketId) adminSocketId = null;
        if (usuarios[socket.id]) {
            usuariosActivos.delete(usuarios[socket.id].name);
            delete usuarios[socket.id];
        }
        actualizarAdmin();
        if (votacionAbierta && modoJuego === 'normal') checkRoundCompletion();
    });

    // --- LÓGICA INTERNA ---
    function checkRoundCompletion() {
        if (modoJuego === 'normal' && todosVotaron()) cerrarRondaNormal();
        else actualizarAdmin();
    }

    function acumularLogicaInterna() {
        Object.values(votosEstrellas).forEach(boleta => {
            for (const [nombre, puntos] of Object.entries(boleta)) {
                if (puntajeAcumulado[nombre] !== undefined) puntajeAcumulado[nombre] += parseInt(puntos) || 0;
            }
        });
        clearAllInactivityTimers(); // Limpiar primero para evitar votos tardíos en ronda nueva
        votosEstrellas = {};
    }

    function acumularPuntos() {
        acumularLogicaInterna(); // ya limpia timers internamente
        Object.keys(usuarios).forEach(id => { if (usuarios[id].role === 'user') resetInactivityTimer(id); });
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
        CONCURSANTES.forEach(c => conteo[c] = 0);
        Object.values(votosActuales).forEach(voto => { if (voto && conteo[voto] !== undefined) conteo[voto]++; });
        enviarResultados(conteo, 'normal');
    }

    function enviarResultados(datos, modo) {
        const ranking     = Object.entries(datos).sort((a, b) => b[1] - a[1]);
        const maxScore    = ranking[0][1];
        const winners     = ranking.filter(r => r[1] === maxScore);
        const winnerName  = winners[0][0];
        const imgs        = GALERIA[winnerName] || [];
        const imagenGanadora = imgs.length > 0 ? imgs[Math.floor(Math.random() * imgs.length)] : "";
        const audioVersion   = Math.random() < 0.5 ? 2 : 1;

        io.emit('pre_results');
        setTimeout(() => {
            io.emit('round_ended', { mode: modo, votes: datos, audioVariant: audioVersion, winnerImage: imagenGanadora });
        }, 4000);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor activo: http://localhost:${PORT}`);
    console.log(`⚙️  Timeout de inactividad: ${INACTIVITY_TIMEOUT / 1000}s`);
});