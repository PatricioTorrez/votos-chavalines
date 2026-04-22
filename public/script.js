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
let myName    = '';
let myEmoji   = '';
let currentMode        = 'normal';
let misCalificaciones  = {};
let selectedCharName   = '';
let isLoggingIn        = false;
let audioTimeout       = null;
let heartbeatInterval  = null;
let countdownInterval  = null;

// Mapa de assets por nombre de concursante
const ASSETS = {
    "Claudio 🍑🃏":  { emoji: "🍑", baseName: "claudio"  },
    "Ferchos 🙈🐵 ": { emoji: "🙈", baseName: "ferchos"  },
    "Bombo 🐷🐷":    { emoji: "🐷", baseName: "bombo"    },
    "Pitrisio 😭😭": { emoji: "😭", baseName: "pitrisio" },
};

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

// --- PANTALLAS ---
const screens = {
    login:    document.getElementById('screen-login'),
    lobby:    document.getElementById('screen-lobby'),
    voting:   document.getElementById('screen-voting'),
    suspense: document.getElementById('screen-suspense'),
    results:  document.getElementById('screen-results'),
};

function showScreen(name) {
    const target = screens[name];
    if (!target) return;

    const current = document.querySelector('.screen.active');

    const doShow = () => {
        target.style.display = 'flex';
        void target.offsetWidth;
        target.classList.add('active');

        if (window.gsap) {
            gsap.fromTo(target,
                { opacity: 0, y: 18, filter: 'brightness(2) saturate(0.3)' },
                { opacity: 1, y: 0, filter: 'brightness(1) saturate(1)', duration: 0.4, ease: 'power3.out' }
            );
        }
    };

    if (current && current !== target) {
        if (window.gsap) {
            gsap.to(current, {
                opacity: 0, y: -12,
                filter: 'brightness(1.5) saturate(0)',
                duration: 0.25,
                ease: 'power2.in',
                onComplete: () => {
                    current.classList.remove('active');
                    current.style.display = 'none';
                    gsap.set(current, { clearProps: 'all' });
                    doShow();
                }
            });
        } else {
            current.classList.remove('active');
            current.style.display = 'none';
            doShow();
        }
    } else {
        doShow();
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
    setTimeout(() => toast.classList.add('show'), 10);
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
    if (isLoggingIn || myName) return;
    const savedUser = localStorage.getItem('chavalines_user');
    if (savedUser) {
        isLoggingIn = true;
        console.log('🔄 Auto-login como:', savedUser);
        socket.emit('join_game', { role: 'user', name: savedUser });
    }
}

// ============================================================
//  UI DE LOGIN
// ============================================================
let selectedCharBtn = null;

function selectChar(btn) {
    SFX.select();
    if (selectedCharBtn) selectedCharBtn.classList.remove('selected');
    selectedCharBtn = btn;
    btn.classList.add('selected');
    selectedCharName = btn.dataset.name;

    // Animación GSAP de selección
    if (window.gsap) {
        gsap.fromTo(btn,
            { scale: 0.92 },
            { scale: 1, duration: 0.35, ease: 'back.out(2)' }
        );
    }

    const loginBtn = document.getElementById('btn-login-user');
    if (loginBtn) loginBtn.disabled = false;
}

window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('chavalines_user');
    if (saved) {
        const allBtns = document.querySelectorAll('.char-btn');
        allBtns.forEach(b => {
            if (b.dataset.name === saved) {
                b.classList.add('saved', 'selected');
                selectedCharBtn  = b;
                selectedCharName = saved;
                const loginBtn = document.getElementById('btn-login-user');
                if (loginBtn) loginBtn.disabled = false;
            }
        });
    }

    const passInput = document.getElementById('adminPass');
    if (passInput) passInput.addEventListener('keypress', e => { if (e.key === 'Enter') loginAdmin(); });

    // Animación de entrada inicial con GSAP
    if (window.gsap) {
        const shell = document.querySelector('.app-shell');
        gsap.fromTo(shell,
            { opacity: 0, scale: 0.96, filter: 'brightness(2) saturate(0)' },
            { opacity: 1, scale: 1, filter: 'brightness(1) saturate(1)', duration: 0.7, ease: 'power3.out' }
        );
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
    if (!selectedCharName) return showToast('Elige tu personaje primero', 'error');
    if (isLoggingIn) return;
    SFX.coin();
    isLoggingIn = true;
    localStorage.setItem('chavalines_user', selectedCharName);
    socket.emit('join_game', { role: 'user', name: selectedCharName });
}

function loginAdmin() {
    const pass = document.getElementById('adminPass')?.value;
    if (!pass) return showToast('Escribe la contraseña', 'error');
    if (isLoggingIn) return;
    SFX.coin();
    isLoggingIn = true;
    localStorage.removeItem('chavalines_user');
    socket.emit('join_game', { role: 'admin', password: pass });
}

function logout() {
    localStorage.removeItem('chavalines_user');
    stopHeartbeat();
    isLoggingIn = false;
    myName = '';
    location.reload();
}

// ============================================================
//  EVENTOS DEL SERVIDOR
// ============================================================

socket.on('login_success', ({ name, role }) => {
    isLoggingIn = false;
    myName = name;
    myRole = role;

    const asset = ASSETS[name];
    myEmoji = asset ? asset.emoji : '🎮';

    const dispEl   = document.getElementById('my-name-display');
    const avatarEl = document.getElementById('lobby-avatar');
    if (dispEl)   dispEl.textContent   = name;
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
    localStorage.removeItem('chavalines_user');
    showToast(msg, 'error');
    showScreen('login');
    if (selectedCharBtn) selectedCharBtn.classList.remove('selected');
    selectedCharBtn  = null;
    selectedCharName = '';
    const loginBtn = document.getElementById('btn-login-user');
    if (loginBtn) loginBtn.disabled = true;
});

socket.on('session_replaced', (msg) => {
    showToast(msg, 'warning');
    setTimeout(() => logout(), 2000);
});

socket.on('heartbeat_ack', () => {});

// --- ADMIN STATUS ---
socket.on('admin_update_status', (data) => {
    if (myRole !== 'admin') return;

    const lobbyList = document.getElementById('lobby-list');
    if (lobbyList) {
        if (data.players.length === 0) {
            lobbyList.innerHTML = '<p class="muted-text">Esperando jugadores…</p>';
        } else {
            lobbyList.innerHTML = data.players.map(p => {
                const asset = ASSETS[p.name];
                const emoji = asset ? asset.emoji : '🎮';
                return `<div class="lobby-player-card">
                    <span class="player-emoji">${emoji}</span>
                    <span class="player-name-sm">${escapeHtml(p.name)}</span>
                    <span class="player-status ${p.hasVoted ? 'voted' : ''}">${p.hasVoted ? '✓' : '·'}</span>
                </div>`;
            }).join('');
        }
    }

    const liveList = document.getElementById('live-voting-list');
    if (liveList) {
        liveList.innerHTML = data.players.map(p => {
            const asset = ASSETS[p.name];
            const emoji = asset ? asset.emoji : '🎮';
            const statusClass = p.hasVoted ? 'voted' : 'waiting';
            const statusText  = p.hasVoted ? 'LISTO ✓' : 'PENSANDO…';
            return `<div class="live-row ${statusClass}">
                <span>${emoji} ${escapeHtml(p.name)}</span>
                <span class="live-status">${statusText}</span>
            </div>`;
        }).join('');
    }

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
                    sorted.map(([name, pts]) => {
                        const a = ASSETS[name];
                        return `<div class="score-row"><span>${a ? a.emoji : ''} ${escapeHtml(name)}</span><span class="score-pts">${pts} pts</span></div>`;
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
                if (cand === myName) return;
                const asset = ASSETS[cand];
                const card = document.createElement('div');
                card.className = 'vote-card';
                card.innerHTML = `
                    <div class="vote-card-emoji">${asset ? asset.emoji : '🎮'}</div>
                    <div class="vote-card-name">${escapeHtml(cand)}</div>
                    <div class="vote-card-check material-icons-round">check_circle</div>
                `;
                card.onclick = () => {
                    SFX.select();
                    document.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected'));
                    card.classList.add('selected');
                    if (window.gsap) {
                        gsap.fromTo(card, { scale: 0.96 }, { scale: 1, duration: 0.3, ease: 'back.out(2)' });
                    }
                    socket.emit('cast_vote', cand);
                };

                if (window.gsap) {
                    card.style.opacity = '0';
                    card.style.transform = 'translateX(-20px)';
                    container.appendChild(card);
                    gsap.to(card, { opacity: 1, x: 0, duration: 0.35, delay: i * 0.08, ease: 'power2.out' });
                } else {
                    container.appendChild(card);
                }
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
    document.querySelectorAll('.star-icon').forEach(s => {
        s.classList.remove('active');
        s.dataset.active = '0';
    });
    document.querySelectorAll('.star-card').forEach(c => c.classList.remove('card-error'));
    document.querySelector('.app-shell')?.scrollTo(0, 0);
});

socket.on('vote_success', () => {
    SFX.confirm();
    hide('ui-normal');
    hide('ui-stars');
    show('waiting-msg');
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

            if (window.gsap) {
                gsap.fromTo(disp,
                    { scale: 1.7, opacity: 0.6 },
                    { scale: 1, opacity: 1, duration: 0.75, ease: 'power3.out' }
                );
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

    const { votes: puntosObj, audioVariant, winnerImage, mode } = data;
    const label = mode === 'estrellas' ? 'pts' : 'votos';

    const resultsArr = Object.entries(puntosObj)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    const maxScore = resultsArr[0].count;
    const winners  = resultsArr.filter(r => r.count === maxScore);
    const isTie    = winners.length > 1;

    let audioFile = 'empate_.mp3';
    if (!isTie) {
        const wAsset = ASSETS[winners[0].name];
        if (wAsset) {
            audioFile = audioVariant === 2 ? `${wAsset.baseName}2.mp3` : `${wAsset.baseName}.mp3`;
        }
    }
    playAudio(audioFile);

    const winSection = document.getElementById('winner-section');
    if (winSection) {
        if (isTie) {
            winSection.innerHTML = `
                <div class="tie-header">¡EMPATE!</div>
                <div class="tie-winners">
                    ${winners.map(w => {
                        const a = ASSETS[w.name];
                        return `<div class="tie-winner-card">
                            <div class="tie-emoji">${a ? a.emoji : '🏆'}</div>
                            <div class="tie-name">${escapeHtml(w.name)}</div>
                            <div class="tie-score">${w.count} ${label}</div>
                        </div>`;
                    }).join('')}
                </div>
            `;
        } else {
            const w = winners[0];
            const a = ASSETS[w.name];
            const imgTag = winnerImage
                ? `<img src="${escapeHtml(winnerImage)}" class="winner-img" alt="${escapeHtml(w.name)}">`
                : `<div class="winner-emoji-fallback">${a ? a.emoji : '🏆'}</div>`;

            winSection.innerHTML = `
                <div class="winner-showcase">
                    <div class="winner-crown">🏆</div>
                    <div class="winner-avatar-ring">
                        ${imgTag}
                        <div class="winner-badge-emoji">${a ? a.emoji : ''}</div>
                    </div>
                    <div class="winner-name">${escapeHtml(w.name)}</div>
                    <div class="winner-score">${w.count} ${label}</div>
                </div>
            `;

            // Animación GSAP para el ganador
            if (window.gsap) {
                setTimeout(() => {
                    const showcase = winSection.querySelector('.winner-showcase');
                    if (showcase) {
                        const children = showcase.children;
                        gsap.fromTo(children,
                            { y: 30, opacity: 0, scale: 0.85 },
                            { y: 0, opacity: 1, scale: 1, duration: 0.55, stagger: 0.12, ease: 'back.out(1.5)' }
                        );
                    }
                }, 100);
            }
        }
    }

    const podium = document.getElementById('podium');
    if (podium) {
        podium.innerHTML = resultsArr.slice(isTie ? 0 : 1).map((p, i) => {
            const a = ASSETS[p.name];
            const rank = isTie ? i + 1 : i + 2;
            return `<div class="podium-row" style="opacity:0;transform:translateY(15px)">
                <div class="podium-left">
                    <span class="podium-rank">${rank}°</span>
                    <span class="podium-emoji">${a ? a.emoji : ''}</span>
                    <span class="podium-name">${escapeHtml(p.name)}</span>
                </div>
                <span class="podium-score">${p.count} ${label}</span>
            </div>`;
        }).join('');

        if (window.gsap) {
            const rows = podium.querySelectorAll('.podium-row');
            gsap.to(rows, { opacity: 1, y: 0, duration: 0.4, stagger: 0.09, delay: 0.5, ease: 'power2.out' });
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
        if (cand === myName) return;
        misCalificaciones[cand] = 0;
        const asset = ASSETS[cand];

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
            <div class="star-card-emoji">${asset ? asset.emoji : '🎮'}</div>
            <div class="star-card-name">${escapeHtml(cand)}</div>
        `;

        card.appendChild(leftDiv);
        card.appendChild(starRating);

        if (window.gsap) {
            card.style.opacity = '0';
            card.style.transform = 'translateY(15px)';
            container.appendChild(card);
            gsap.to(card, { opacity: 1, y: 0, duration: 0.35, delay: idx * 0.07, ease: 'power2.out' });
        } else {
            container.appendChild(card);
        }
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
            if (isNowActive && !wasActive && window.gsap) {
                gsap.fromTo(s, { scale: 1.5 }, { scale: 1, duration: 0.25, ease: 'back.out(2)' });
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
    }).catch(() => {
        if (filename.includes('2.mp3')) {
            playAudio(filename.replace('2.mp3', '.mp3'));
        }
    });
}

function stopAudio() {
    if (audioTimeout) { clearTimeout(audioTimeout); audioTimeout = null; }
    const audio = document.getElementById('win-sound');
    if (audio) { audio.pause(); audio.currentTime = 0; }
}
