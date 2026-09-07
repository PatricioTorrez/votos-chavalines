// ============================================================
//  Los Chavalines — script.js
//  Cyberpunk Arcade 80s — GSAP + Web Audio SFX
// ============================================================

const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
    timeout: 20000,
});

// --- ESTADO LOCAL ---
let myRole    = 'user';
let myId      = '';
let myEmoji   = '';
let currentMode        = 'normal';
let misCalificaciones  = {};
let selectedCharId     = '';
let isLoggingIn        = false;
let audioTimeout       = null;
let heartbeatInterval  = null;
let countdownInterval  = null;

// ============================================================
//  REGISTRO DE CONCURSANTES
//  Lo manda el servidor al conectar (evento 'contestants'), leido de
//  data/concursantes.json. El cliente no tiene ningun nombre hardcodeado:
//  el id es la clave, el nombre visible es solo presentacion.
// ============================================================
const ROSTER = new Map();   // id -> { id, nombre, emojis, avatar, display }

function chr(id)      { return ROSTER.get(id) || null; }
function nombreDe(id) { return chr(id)?.display || id; }
function emojiDe(id)  { return chr(id)?.avatar  || '🎮'; }

const STORAGE_KEY = 'chavalines_user';

// Devuelve el id guardado, migrando el formato viejo (que guardaba el nombre
// visible con emojis) al id nuevo.
function idGuardado() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    if (ROSTER.has(raw)) return raw;
    for (const c of ROSTER.values()) {
        if (c.display.trim() === raw.trim()) {
            localStorage.setItem(STORAGE_KEY, c.id);
            return c.id;
        }
    }
    localStorage.removeItem(STORAGE_KEY);
    return null;
}

// ============================================================
//  MOTOR DE SONIDOS 8-BIT (Web Audio API — sin dependencias)
// ============================================================
const SFX = {
    _ctx: null,
    get ctx() {
        if (!this._ctx) {
            try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
        }
        return this._ctx;
    },
    _tone(freq, type, duration, vol, freqEnd) {
        if (!this.ctx) return;
        try {
            const osc  = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.type = type;
            const now = this.ctx.currentTime;
            osc.frequency.setValueAtTime(freq, now);
            if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);
            gain.gain.setValueAtTime(vol, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
            osc.start(now);
            osc.stop(now + duration);
        } catch(e) {}
    },
    blip()    { this._tone(660, 'square', 0.06, 0.18); },
    select()  {
        this._tone(440, 'square', 0.06, 0.15);
        setTimeout(() => this._tone(880, 'square', 0.1, 0.15), 60);
    },
    coin()    {
        this._tone(987,  'square', 0.08, 0.22);
        setTimeout(() => this._tone(1318, 'square', 0.13, 0.22), 90);
    },
    confirm() {
        [440, 554, 659, 880].forEach((f, i) => setTimeout(() => this._tone(f, 'square', 0.09, 0.2), i * 65));
    },
    error()   {
        this._tone(220, 'sawtooth', 0.14, 0.28);
        setTimeout(() => this._tone(150, 'sawtooth', 0.2, 0.28), 110);
    },
    levelUp() {
        [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this._tone(f, 'square', 0.13, 0.25), i * 85));
    },
    warp()    { this._tone(200, 'sawtooth', 0.3, 0.2, 800); },
    tick()    { this._tone(1200, 'square', 0.04, 0.12); },
};

// ============================================================
//  SEGURIDAD — escapa texto antes de insertar en innerHTML
// ============================================================
function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// Confeti
const confettiCanvas = document.getElementById('confetti-canvas');
let myConfetti = null;
if (confettiCanvas && window.confetti) {
    myConfetti = confetti.create(confettiCanvas, { resize: true, useWorker: true });
}

// ============================================================
//  MOTION — helpers
//  Todo el movimiento de GSAP pasa por aca para que
//  prefers-reduced-motion tambien lo alcance (el CSS solo no basta).
// ============================================================
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
function reducedMotion() { return REDUCED_MOTION.matches; }

// Entrada estandar. Con reduced-motion: solo opacidad, sin desplazamiento ni stagger.
// clearProps borra el transform inline al terminar para no pisar los estados CSS
// (.selected, :active) del elemento.
function animIn(targets, opts = {}) {
    if (!window.gsap) return;
    const { y = 0, x = 0, duration = 0.35, delay = 0, stagger = 0, ease = 'power3.out' } = opts;
    if (reducedMotion()) {
        gsap.fromTo(targets,
            { opacity: 0 },
            { opacity: 1, duration: 0.15, delay: Math.min(delay, 0.08), stagger: 0,
              ease: 'none', clearProps: 'opacity,transform' });
        return;
    }
    gsap.fromTo(targets,
        { opacity: 0, y, x },
        { opacity: 1, y: 0, x: 0, duration, delay, stagger, ease, clearProps: 'opacity,transform' });
}

// --- PANTALLAS ---
const screens = {
    login:    document.getElementById('screen-login'),
    lobby:    document.getElementById('screen-lobby'),
    voting:   document.getElementById('screen-voting'),
    suspense: document.getElementById('screen-suspense'),
    results:  document.getElementById('screen-results'),
};

// Apaga una pantalla de inmediato, matando cualquier tween a medio camino.
function hardHideScreen(el) {
    if (window.gsap) gsap.killTweensOf(el);
    el.classList.remove('active');
    el.style.display = 'none';
    if (window.gsap) gsap.set(el, { clearProps: 'all' });
}

// Pantalla a la que se quiere llegar. Si llegan dos cambios seguidos
// (pre_results -> round_ended -> return_to_lobby, o el usuario vuelve de otra
// app y los tweens congelados se descongelan todos juntos), la transicion vieja
// se descarta en vez de terminar mostrando su propia pantalla.
let pendingScreen = null;

// Deja visible SOLO esta pantalla. Es el unico lugar que enciende una pantalla,
// asi que el invariante "exactamente una visible" se sostiene siempre.
function revealScreen(target, animar = true) {
    Object.values(screens).forEach(s => { if (s !== target) hardHideScreen(s); });
    if (window.gsap) gsap.killTweensOf(target);
    target.style.display = 'flex';
    void target.offsetWidth;
    target.classList.add('active');
    if (animar) {
        // Solo opacity + transform: animar 'filter' sobre la pantalla completa
        // repinta todo el arbol en cada frame y tira los FPS en movil.
        animIn(target, { y: 18, duration: 0.32 });
    } else if (window.gsap) {
        gsap.set(target, { clearProps: 'all' });
    }
}

function showScreen(name) {
    const target = screens[name];
    if (!target) return;

    const current = document.querySelector('.screen.active');
    pendingScreen = target;

    // Ya estamos aca: solo garantizar que quedo visible y limpia
    // (un tween congelado pudo dejarla a medio opacar).
    if (current === target) return revealScreen(target, false);

    const finish = () => {
        // Mientras corria la salida llego otro showScreen: este quedo viejo.
        if (pendingScreen !== target) return;
        revealScreen(target);
    };

    if (current && window.gsap) {
        // overwrite mata cualquier salida ya en curso sobre la misma pantalla:
        // sin esto quedaban dos tweens vivos y cada onComplete encendia la suya.
        gsap.killTweensOf(current);
        gsap.to(current, {
            opacity: 0,
            y: reducedMotion() ? 0 : -12,
            duration: reducedMotion() ? 0.12 : 0.18,
            ease: 'power3.out',
            overwrite: true,
            onComplete: finish,
        });
    } else {
        finish();
    }
}

// --- UTILIDADES ---
function show(id) { const el = document.getElementById(id); if (el) { el.classList.remove('hidden'); el.style.display = ''; } }
function hide(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

// --- TOAST ---
function showToast(message, type = 'info') {
    if (type === 'error') SFX.error();
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    // Dos frames: garantiza que el estado inicial se pinto antes de transicionar.
    // setTimeout(…, 10) puede dispararse antes del paint en un frame cargado.
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 3500);
}

// --- CONEXIÓN ---
function updateConnectionStatus(state) {
    const el = document.getElementById('connection-indicator');
    if (!el) return;
    el.className = `connection-indicator ${state}`;
    const label = el.querySelector('.conn-label');
    if (label) {
        if (state === 'connected')         label.textContent = 'ONLINE';
        else if (state === 'reconnecting') label.textContent = 'RECONECTANDO';
        else                               label.textContent = 'OFFLINE';
    }
    el.style.opacity = state === 'connected' ? '0' : '1';
}

// --- HEARTBEAT ---
function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (socket.connected && myRole === 'user') socket.emit('heartbeat');
    }, 30000);
}
function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ============================================================
//  RECONEXIÓN ROBUSTA
// ============================================================
socket.on('connect', () => {
    console.log('✅ Socket conectado:', socket.id);
    updateConnectionStatus('connected');
    // El auto-login espera al roster: sin el no se puede validar el id guardado.
});

// El servidor manda esto apenas conecta, tambien al reconectar.
socket.on('contestants', (lista) => {
    ROSTER.clear();
    lista.forEach(c => ROSTER.set(c.id, c));
    renderCharacterGrid();
    attemptAutoLogin();
});

socket.on('disconnect', (reason) => {
    console.warn('❌ Socket desconectado:', reason);
    updateConnectionStatus('disconnected');
    stopHeartbeat();
    isLoggingIn = false;
});

socket.on('connect_error', (err) => {
    console.error('⚠️ Error de conexión:', err.message);
    updateConnectionStatus('disconnected');
});

socket.on('reconnect_attempt', () => updateConnectionStatus('reconnecting'));
socket.on('reconnect', () => {
    console.log('✅ Reconectado');
    updateConnectionStatus('connected');
});

function attemptAutoLogin() {
    if (isLoggingIn || myId || !ROSTER.size) return;
    const saved = idGuardado();
    if (saved) {
        isLoggingIn = true;
        console.log('🔄 Auto-login como:', nombreDe(saved));
        socket.emit('join_game', { role: 'user', id: saved });
    }
}

// ============================================================
//  UI DE LOGIN
// ============================================================
let selectedCharBtn = null;

// Arma los botones a partir del roster y restaura la seleccion guardada.
function renderCharacterGrid() {
    const grid = document.getElementById('character-grid');
    if (!grid) return;

    const guardado = idGuardado();
    grid.innerHTML = '';
    selectedCharBtn = null;

    ROSTER.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'char-btn';
        btn.dataset.id = c.id;
        btn.innerHTML = `<span class="char-emoji">${escapeHtml(c.avatar)}</span>
            <span class="char-name">${escapeHtml(c.nombre)}</span>`;
        btn.addEventListener('click', () => selectChar(btn));
        grid.appendChild(btn);

        if (c.id === guardado) {
            btn.classList.add('saved', 'selected');
            selectedCharBtn = btn;
            selectedCharId  = c.id;
        }
    });

    const loginBtn = document.getElementById('btn-login-user');
    if (loginBtn) loginBtn.disabled = !selectedCharId;
}

function selectChar(btn) {
    SFX.select();
    if (selectedCharBtn) selectedCharBtn.classList.remove('selected');
    selectedCharBtn = btn;
    btn.classList.add('selected');
    selectedCharId = btn.dataset.id;
    // El feedback de pulsacion lo da .char-btn:active en CSS; un tween de scale
    // encima dejaba un transform inline que anulaba el translateY de .selected.

    const loginBtn = document.getElementById('btn-login-user');
    if (loginBtn) loginBtn.disabled = false;
}

window.addEventListener('DOMContentLoaded', () => {
    // La grilla y la seleccion guardada las arma renderCharacterGrid() cuando
    // llega el roster del servidor.
    const passInput = document.getElementById('adminPass');
    if (passInput) passInput.addEventListener('keypress', e => { if (e.key === 'Enter') loginAdmin(); });

    // Animación de entrada inicial con GSAP
    if (window.gsap) {
        const shell = document.querySelector('.app-shell');
        if (reducedMotion()) {
            gsap.fromTo(shell, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: 'none' });
        } else {
            gsap.fromTo(shell,
                { opacity: 0, scale: 0.96 },
                { opacity: 1, scale: 1, duration: 0.45, ease: 'power3.out', clearProps: 'transform' });
        }
    }
});

function toggleAdmin() {
    SFX.blip();
    const area = document.getElementById('admin-login-area');
    if (!area) return;
    area.classList.toggle('hidden');
    if (!area.classList.contains('hidden')) {
        document.getElementById('adminPass')?.focus();
    }
}

function loginUser() {
    if (!selectedCharId) return showToast('Elige tu personaje primero', 'error');
    if (isLoggingIn) return;
    SFX.coin();
    isLoggingIn = true;
    localStorage.setItem(STORAGE_KEY, selectedCharId);
    socket.emit('join_game', { role: 'user', id: selectedCharId });
}

function loginAdmin() {
    const pass = document.getElementById('adminPass')?.value;
    if (!pass) return showToast('Escribe la contraseña', 'error');
    if (isLoggingIn) return;
    SFX.coin();
    isLoggingIn = true;
    localStorage.removeItem(STORAGE_KEY);
    socket.emit('join_game', { role: 'admin', password: pass });
}

function logout() {
    localStorage.removeItem(STORAGE_KEY);
    stopHeartbeat();
    isLoggingIn = false;
    myId = '';
    location.reload();
}

// ============================================================
//  EVENTOS DEL SERVIDOR
// ============================================================

socket.on('login_success', ({ id, role }) => {
    isLoggingIn = false;
    myId   = id || '';
    myRole = role;

    myEmoji = role === 'admin' ? '🎮' : emojiDe(id);

    const dispEl   = document.getElementById('my-name-display');
    const avatarEl = document.getElementById('lobby-avatar');
    if (dispEl)   dispEl.textContent   = role === 'admin' ? 'ADMIN' : nombreDe(id);
    if (avatarEl) avatarEl.textContent = myEmoji;

    if (role === 'admin') {
        show('admin-panel');
        show('admin-voting-view');
        show('admin-reset');
        hide('waiting-badge');
    } else {
        hide('admin-panel');
        hide('admin-voting-view');
        hide('admin-reset');
        startHeartbeat();
    }

    SFX.levelUp();
    showScreen('lobby');
});

socket.on('login_failed', (msg) => {
    isLoggingIn = false;
    localStorage.removeItem(STORAGE_KEY);
    showToast(msg, 'error');
    showScreen('login');
    if (selectedCharBtn) selectedCharBtn.classList.remove('selected');
    selectedCharBtn = null;
    selectedCharId  = '';
    const loginBtn = document.getElementById('btn-login-user');
    if (loginBtn) loginBtn.disabled = true;
});

socket.on('session_replaced', (msg) => {
    showToast(msg, 'warning');
    setTimeout(() => logout(), 2000);
});

socket.on('heartbeat_ack', () => {});

// --- ADMIN STATUS ---
// Reconcilia una lista de jugadores por nombre, creando solo las filas nuevas y
// actualizando el resto, para que los cambios de estado puedan transicionar.
function syncPlayerRows(list, players, build, apply) {
    if (!list) return;

    if (!players.length) {
        if (!list.querySelector('.muted-text')) {
            list.innerHTML = '<p class="muted-text">Esperando jugadores…</p>';
        }
        return;
    }
    const placeholder = list.querySelector('.muted-text');
    if (placeholder) placeholder.remove();

    const existing = new Map(
        [...list.children].map(el => [el.dataset.player, el])
    );

    players.forEach((p, i) => {
        let row = existing.get(p.id);
        if (!row) {
            row = build(p);
            row.dataset.player = p.id;
            list.appendChild(row);
            animIn(row, { y: 8, duration: 0.25 });
        } else {
            existing.delete(p.id);
        }
        apply(row, p);
        if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
    });

    existing.forEach(row => row.remove());
}

function buildLobbyRow(p) {
    const row = document.createElement('div');
    row.className = 'lobby-player-card';
    row.innerHTML = `<span class="player-emoji">${escapeHtml(emojiDe(p.id))}</span>
        <span class="player-name-sm">${escapeHtml(nombreDe(p.id))}</span>
        <span class="player-status">·</span>`;
    return row;
}
function applyLobbyRow(row, p) {
    const status = row.querySelector('.player-status');
    if (!status) return;
    status.classList.toggle('voted', p.hasVoted);
    const text = p.hasVoted ? '✓' : '·';
    if (status.textContent !== text) status.textContent = text;
}

function buildLiveRow(p) {
    const row = document.createElement('div');
    row.className = 'live-row';
    row.innerHTML = `<span>${escapeHtml(emojiDe(p.id))} ${escapeHtml(nombreDe(p.id))}</span>
        <span class="live-status"></span>`;
    return row;
}
function applyLiveRow(row, p) {
    row.classList.toggle('voted', p.hasVoted);
    row.classList.toggle('waiting', !p.hasVoted);
    const status = row.querySelector('.live-status');
    if (!status) return;
    const text = p.hasVoted ? 'LISTO ✓' : 'PENSANDO…';
    if (status.textContent !== text) status.textContent = text;
}

socket.on('admin_update_status', (data) => {
    if (myRole !== 'admin') return;

    // Se parchea en sitio en vez de rehacer el innerHTML: al recrear los nodos en
    // cada update ninguna transicion CSS llegaba a correr, y esta pantalla existe
    // justamente para ver quien va votando.
    syncPlayerRows(document.getElementById('lobby-list'), data.players, buildLobbyRow, applyLobbyRow);
    syncPlayerRows(document.getElementById('live-voting-list'), data.players, buildLiveRow, applyLiveRow);

    if (data.modoJuego === 'estrellas') {
        hide('admin-controls-normal');
        show('admin-controls-stars');

        const btnNext = document.getElementById('btn-next-round');
        const btnEnd  = document.getElementById('btn-finish-tour');
        if (btnNext && btnEnd) {
            btnNext.disabled = !data.canProceed;
            btnEnd.disabled  = !data.canProceed;
            btnNext.style.opacity = data.canProceed ? '1' : '0.4';
            btnEnd.style.opacity  = data.canProceed ? '1' : '0.4';
            btnNext.querySelector('span:last-child').textContent = data.canProceed ? 'ACUMULAR Y SEGUIR' : 'ESPERANDO VOTOS…';
        }

        if (data.puntajeAcumulado) {
            const scoresEl = document.getElementById('accumulated-scores');
            if (scoresEl) {
                const sorted = Object.entries(data.puntajeAcumulado).sort((a, b) => b[1] - a[1]);
                scoresEl.innerHTML = `<p class="scores-label">ACUMULADO ACTUAL</p>` +
                    sorted.map(([id, pts]) => {
                        return `<div class="score-row"><span>${escapeHtml(emojiDe(id))} ${escapeHtml(nombreDe(id))}</span><span class="score-pts">${pts} pts</span></div>`;
                    }).join('');
            }
        }
    } else {
        show('admin-controls-normal');
        hide('admin-controls-stars');
    }
});

// --- RONDAS ---
socket.on('round_started', (data) => {
    currentMode = data.mode;
    SFX.warp();
    showScreen('voting');

    hide('waiting-msg');
    hide('round-wait-msg');
    hide('ui-normal');
    hide('ui-stars');

    const instruction = document.getElementById('voting-instruction');
    const modeBadge   = document.getElementById('mode-badge');

    if (currentMode === 'normal') {
        if (modeBadge) { modeBadge.textContent = 'MODO NORMAL'; modeBadge.className = 'mode-badge normal'; }
        if (instruction) instruction.textContent = 'VOTA POR EL MEJOR';
        show('ui-normal');

        const container = document.getElementById('cards-container');
        if (container && myRole === 'user') {
            container.innerHTML = '';
            data.candidates.forEach((cand, i) => {
                if (cand === myId) return;
                const card = document.createElement('div');
                card.className = 'vote-card';
                card.innerHTML = `
                    <div class="vote-card-emoji">${escapeHtml(emojiDe(cand))}</div>
                    <div class="vote-card-name">${escapeHtml(nombreDe(cand))}</div>
                    <div class="vote-card-check material-icons-round">check_circle</div>
                `;
                card.onclick = () => {
                    SFX.select();
                    document.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected'));
                    card.classList.add('selected');
                    // El estado .selected ya transiciona en CSS (borde, glow, check,
                    // translateX) y :active da la pulsacion. Sin tween encima.
                    socket.emit('cast_vote', cand);
                };

                container.appendChild(card);
                animIn(card, { x: -20, duration: 0.32, delay: i * 0.06, ease: 'power2.out' });
            });
        }

        if (data.alreadyVoted) {
            hide('ui-normal');
            show('waiting-msg');
        }

    } else {
        if (modeBadge) { modeBadge.textContent = 'MODO ESTRELLAS'; modeBadge.className = 'mode-badge stars'; }
        if (instruction) instruction.textContent = 'CALIFICA A TODOS (MÍN. 1 ★)';
        show('ui-stars');

        if (myRole === 'user') renderStarVoting(data.candidates);

        if (data.alreadyVoted) {
            hide('ui-stars');
            show('waiting-msg');
        }
    }
});

socket.on('force_new_round_ui', () => {
    if (myRole !== 'user') return;
    misCalificaciones = {};
    hide('waiting-msg');
    show('ui-stars');
    // Se vacian en cascada de derecha a izquierda: explica que la ronda se reinicio
    // en vez de teletransportar las 15 estrellas a cero.
    const icons = [...document.querySelectorAll('.star-icon')].reverse();
    icons.forEach((s, i) => {
        const clear = () => {
            s.classList.remove('active');
            s.dataset.active = '0';
            s.textContent = 'star_rate';   // faltaba: el glifo relleno se quedaba pegado
        };
        if (reducedMotion() || !window.gsap) clear();
        else setTimeout(clear, i * 22);
    });
    document.querySelectorAll('.star-card').forEach(c => c.classList.remove('card-error'));
    document.querySelector('.app-shell')?.scrollTo(0, 0);
});

socket.on('vote_success', () => {
    SFX.confirm();
    hide('ui-normal');
    hide('ui-stars');
    show('waiting-msg');
    // El voto es el momento con mas carga de la ronda: que la confirmacion
    // entre en vez de aparecer de golpe.
    animIn(document.getElementById('waiting-msg'), { y: 12, duration: 0.28 });
});

socket.on('vote_error', (msg) => {
    showToast(msg, 'error');
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
});

socket.on('notification', (msg) => showToast(msg, 'info'));

socket.on('return_to_lobby', () => {
    SFX.blip();
    showScreen('lobby');
    stopAudio();
    if (confettiFrame) { cancelAnimationFrame(confettiFrame); confettiFrame = null; }
    myConfetti?.reset();
});

// --- SUSPENSO ---
socket.on('pre_results', () => {
    showScreen('suspense');
    stopAudio();
    const drum = document.getElementById('drum-sound');
    if (drum) { drum.currentTime = 0; drum.play().catch(() => {}); }

    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

    let count = 3;
    const disp = document.getElementById('countdown-display');
    if (!disp) return;
    disp.textContent = count;
    SFX.tick();

    countdownInterval = setInterval(() => {
        count--;
        if (count > 0) {
            disp.textContent = count;
            SFX.tick();

            if (window.gsap && !reducedMotion()) {
                // Se asienta bien antes del siguiente tick (1s); 0.75s se sentia blando.
                gsap.fromTo(disp,
                    { scale: 1.4, opacity: 0.6 },
                    { scale: 1, opacity: 1, duration: 0.45, ease: 'power3.out', clearProps: 'transform' }
                );
            } else if (window.gsap) {
                gsap.fromTo(disp, { opacity: 0.6 }, { opacity: 1, duration: 0.15, ease: 'none' });
            } else {
                disp.classList.remove('pop');
                void disp.offsetWidth;
                disp.classList.add('pop');
            }
        } else {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }, 1000);
});

// --- RESULTADOS ---
let confettiFrame = null;

socket.on('round_ended', (data) => {
    showScreen('results');
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    const drum = document.getElementById('drum-sound');
    if (drum) drum.pause();

    // Confeti en colores neon
    if (myConfetti) {
        if (confettiFrame) { cancelAnimationFrame(confettiFrame); confettiFrame = null; }
        const end = Date.now() + 3500;
        const colors = ['#FF0080', '#00FFFF', '#FFE600', '#9D00FF', '#ffffff'];
        (function frame() {
            myConfetti({
                particleCount: 6,
                angle: 90,
                spread: 85,
                startVelocity: 48,
                origin: { x: 0.5, y: 0.15 },
                colors,
                scalar: 1.1,
                ticks: 300,
                zIndex: 10000
            });
            if (Date.now() < end) confettiFrame = requestAnimationFrame(frame);
            else confettiFrame = null;
        }());
    }

    const { votes: puntosObj, audio, winnerImage, mode } = data;
    const label = mode === 'estrellas' ? 'pts' : 'votos';

    const resultsArr = Object.entries(puntosObj)
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count);

    const maxScore = resultsArr[0].count;
    const winners  = resultsArr.filter(r => r.count === maxScore);
    const isTie    = winners.length > 1;

    // El servidor ya resolvio que archivo suena (existe, y contempla el empate).
    if (audio) playAudio(audio);

    const winSection = document.getElementById('winner-section');
    if (winSection) {
        if (isTie) {
            winSection.innerHTML = `
                <div class="tie-header">¡EMPATE!</div>
                <div class="tie-winners">
                    ${winners.map(w => {
                        return `<div class="tie-winner-card">
                            <div class="tie-emoji">${escapeHtml(emojiDe(w.id))}</div>
                            <div class="tie-name">${escapeHtml(nombreDe(w.id))}</div>
                            <div class="tie-score">${w.count} ${label}</div>
                        </div>`;
                    }).join('')}
                </div>
            `;
        } else {
            const w = winners[0];
            const imgTag = winnerImage
                ? `<img src="${escapeHtml(winnerImage)}" class="winner-img" width="150" height="150"
                        decoding="async" alt="${escapeHtml(nombreDe(w.id))}">`
                : `<div class="winner-emoji-fallback">${escapeHtml(emojiDe(w.id))}</div>`;

            winSection.innerHTML = `
                <div class="winner-showcase">
                    <div class="winner-crown">🏆</div>
                    <div class="winner-avatar-ring">
                        ${imgTag}
                        <div class="winner-badge-emoji">${escapeHtml(emojiDe(w.id))}</div>
                    </div>
                    <div class="winner-name">${escapeHtml(nombreDe(w.id))}</div>
                    <div class="winner-score">${w.count} ${label}</div>
                </div>
            `;

            // Animación GSAP para el ganador
            if (window.gsap) {
                setTimeout(() => {
                    const showcase = winSection.querySelector('.winner-showcase');
                    if (showcase) {
                        animIn(showcase.children, { y: 30, duration: 0.5, stagger: 0.08, ease: 'back.out(1.5)' });
                    }
                }, 100);
            }
        }
    }

    const podium = document.getElementById('podium');
    if (podium) {
        podium.innerHTML = resultsArr.slice(isTie ? 0 : 1).map((p, i) => {
            const rank = isTie ? i + 1 : i + 2;
            return `<div class="podium-row" style="opacity:0;transform:translateY(15px)">
                <div class="podium-left">
                    <span class="podium-rank">${rank}°</span>
                    <span class="podium-emoji">${escapeHtml(emojiDe(p.id))}</span>
                    <span class="podium-name">${escapeHtml(nombreDe(p.id))}</span>
                </div>
                <span class="podium-score">${p.count} ${label}</span>
            </div>`;
        }).join('');

        if (window.gsap) {
            animIn(podium.querySelectorAll('.podium-row'), { y: 15, duration: 0.35, stagger: 0.07, delay: 0.5, ease: 'power2.out' });
        } else {
            podium.querySelectorAll('.podium-row').forEach(r => {
                r.style.opacity = '1';
                r.style.transform = 'none';
            });
        }
    }
});

// ============================================================
//  ESTRELLAS
// ============================================================
function renderStarVoting(candidates) {
    const container = document.getElementById('stars-container');
    if (!container) return;
    container.innerHTML = '';
    misCalificaciones = {};

    candidates.forEach((cand, idx) => {
        if (cand === myId) return;
        misCalificaciones[cand] = 0;

        const card = document.createElement('div');
        card.className = 'star-card';
        card.dataset.candidate = cand;
        card.dataset.idx = idx;

        const ratingId = `stars-idx-${idx}`;
        const starRating = document.createElement('div');
        starRating.className = 'star-rating';
        starRating.id = ratingId;

        for (let i = 1; i <= 5; i++) {
            const btn = document.createElement('button');
            btn.className = 'star-btn';
            btn.dataset.value = i;
            btn.setAttribute('aria-label', `${i} estrella${i > 1 ? 's' : ''}`);
            btn.innerHTML = `<span class="material-icons-round star-icon">star_rate</span>`;
            btn.addEventListener('click', () => rateUser(cand, i));
            starRating.appendChild(btn);
        }

        const leftDiv = document.createElement('div');
        leftDiv.className = 'star-card-left';
        leftDiv.innerHTML = `
            <div class="star-card-emoji">${escapeHtml(emojiDe(cand))}</div>
            <div class="star-card-name">${escapeHtml(nombreDe(cand))}</div>
        `;

        card.appendChild(leftDiv);
        card.appendChild(starRating);

        container.appendChild(card);
        animIn(card, { y: 15, duration: 0.32, delay: idx * 0.06, ease: 'power2.out' });
    });
}

function rateUser(candidato, valor) {
    SFX.blip();
    misCalificaciones[candidato] = valor;
    const card = document.querySelector(`.star-card[data-candidate="${CSS.escape(candidato)}"]`);
    if (card) {
        card.querySelectorAll('.star-icon').forEach((s, idx) => {
            const wasActive = s.classList.contains('active');
            const isNowActive = idx < valor;
            s.textContent = isNowActive ? 'star' : 'star_rate';
            s.classList.toggle('active', isNowActive);
            if (isNowActive && !wasActive && window.gsap && !reducedMotion()) {
                gsap.fromTo(s, { scale: 1.25 }, { scale: 1, duration: 0.2, ease: 'back.out(2)', clearProps: 'transform' });
            }
        });
        card.classList.remove('card-error');
    }
}

function submitStarVotes() {
    let hayErrores = false;
    document.querySelectorAll('.star-card').forEach(c => c.classList.remove('card-error'));

    for (const [nombre, puntos] of Object.entries(misCalificaciones)) {
        if (puntos < 1) {
            hayErrores = true;
            const card = document.querySelector(`.star-card[data-candidate="${CSS.escape(nombre)}"]`);
            if (card) card.classList.add('card-error');
        }
    }

    if (hayErrores) {
        SFX.error();
        if (navigator.vibrate) navigator.vibrate([100, 50, 200]);
        showToast('⚠️ Asigna al menos 1 estrella a todos', 'error');
        const firstError = document.querySelector('.star-card.card-error');
        firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }

    socket.emit('cast_star_vote', misCalificaciones);
    hide('ui-stars');
    show('waiting-msg');
}

// ============================================================
//  ADMIN ACTIONS
// ============================================================
function startRound(mode) {
    SFX.levelUp();
    if (mode === 'estrellas') socket.emit('admin_start_stars');
    else socket.emit('admin_start_voting');
}
function forceFinish()     { SFX.blip(); socket.emit('admin_force_finish'); }
function accumulateRound() { SFX.confirm(); socket.emit('admin_accumulate_round'); }
function finishTournament(){ SFX.levelUp(); socket.emit('admin_finish_tournament'); }
function resetScores()     { if (confirm('¿Borrar todas las puntuaciones?')) { SFX.error(); socket.emit('admin_reset_scores'); } }
function resetLobby()      { socket.emit('admin_reset_lobby'); }

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
        // Se pide al abrir, no en cada update del panel de admin.
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
        elRanking.innerHTML = `<p class="muted-text">No se pudo leer el historial:<br>${escapeHtml(error)}</p>`;
        elLista.innerHTML = '<button type="button" class="btn-ghost" onclick="socket.emit(\'admin_get_history\')">REINTENTAR</button>';
        return;
    }
    if (!registros.length) {
        elRanking.innerHTML = '<p class="muted-text">Todavía no hay torneos registrados.</p>';
        elLista.innerHTML = '';
        return;
    }

    elRanking.innerHTML = ranking.map((f, i) => {
        // Nombre sin los emojis decorativos: el avatar ya va al lado, y en 360px
        // repetirlos obligaba a recortar el nombre hasta dejarlo en "Fe...".
        const nombre = chr(f.id)?.nombre || f.id;
        return `
        <div class="podium-row">
            <div class="podium-left">
                <span class="podium-rank">${i + 1}°</span>
                <span class="podium-emoji">${escapeHtml(emojiDe(f.id))}</span>
                <span class="podium-name">${escapeHtml(nombre)}</span>
            </div>
            <span class="podium-score">${f.torneos}🏆 ${f.rondas}🎵</span>
        </div>`;
    }).join('');

    elLista.innerHTML = registros.map(r => {
        const nombres = r.ganadores.map(id => escapeHtml(nombreDe(id))).join(' + ');
        // Object.values({}) da [] y Math.max() daria -Infinity: se cubre el caso.
        const valores  = Object.values(r.puntajes || {});
        const puntos   = valores.length ? Math.max(...valores) : 0;
        const badge    = r.tipo === 'estrellas' ? 'stars' : 'normal';
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

// ============================================================
//  AUDIO
// ============================================================
function playAudio(filename) {
    const audio = document.getElementById('win-sound');
    if (!audio) return;
    stopAudio();
    audio.src = filename;
    audio.load();
    audio.play().then(() => {
        audioTimeout = setTimeout(() => stopAudio(), 7000);
    }).catch(err => {
        // El servidor solo manda archivos declarados en concursantes.json, asi
        // que un fallo aca es de reproduccion (autoplay bloqueado), no de ruta.
        console.warn('No se pudo reproducir', filename, err?.message || err);
    });
}

function stopAudio() {
    if (audioTimeout) { clearTimeout(audioTimeout); audioTimeout = null; }
    const audio = document.getElementById('win-sound');
    if (audio) { audio.pause(); audio.currentTime = 0; }
}
