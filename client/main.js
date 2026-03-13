// signaling server URL 
// ---------------------------
// Gatekeeper Protocol Logic
// ---------------------------

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_URL = isLocal ? 'http://localhost:3000' : window.location.origin;
const SIGNALING_URL = isLocal ? 'ws://localhost:3000' : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

// State
let ws;
let myId;
let myName;
let autoConnectTarget = null; // Target from QR scan
let autoSendPending = false; // Trigger file picker after QR pair
let vaultFiles = []; // All received files
let currentUser = JSON.parse(localStorage.getItem('gatekeeper_session')) || null;
const peers = new Map();
const CHUNK_SIZE = 16384; 

// Audio context and hum state
let audioCtx = null;
let humOsc = null;

// UI View Management
const views = {
    entry: document.getElementById('view-entry'),
    auth: document.getElementById('view-auth'),
    dashboard: document.getElementById('view-dashboard')
};

// ---------------------------
// Initialization
// ---------------------------

document.addEventListener('DOMContentLoaded', () => {
    // Check for auto-connect target in URL
    const params = new URLSearchParams(window.location.search);
    autoConnectTarget = params.get('target');
    
    const dlTarget = params.get('dl');
    if (dlTarget) {
        showDownloadAuthModal(dlTarget);
    }

    initApp();
    
    // Hide Splash Screen after timeout
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) splash.classList.add('fade-out');
    }, 2500);
});

function initApp() {
    // Security Warning for WebRTC
    if (!window.isSecureContext && !isLocal) {
        showToast("SECURITY_BLOCK: HTTPS REQUIRED FOR P2P", "error");
        setTimeout(() => {
            alert("SECURE_CONTEXT_REQUIRED: For laptop-to-laptop transfer on local network, use HTTPS or enable 'Insecure origins treated as secure' in chrome://flags for this IP.");
        }, 1000);
    }

    if (currentUser) {
        showView('dashboard');
        updateAgentBadge();
        connectSignaling();
    } else {
        showView('entry');
    }
}

function showView(viewId) {
    Object.keys(views).forEach(v => {
        if (views[v]) views[v].classList.add('hidden');
    });
    if (views[viewId]) views[viewId].classList.remove('hidden');

    if (viewId === 'dashboard' || viewId === 'auth') {
        document.body.classList.add('crt-on');
    } else {
        document.body.classList.remove('crt-on');
    }

    if (viewId === 'dashboard') {
        triggerProgressiveLoad();
        setupDashboardNav();
        updateBackButtonVisibility('radar-view');
    }
}

function updateBackButtonVisibility(target) {
    const backBtn = document.getElementById('btn-dashboard-back');
    if (!backBtn) return;
    
    if (target === 'radar-view') {
        backBtn.classList.add('hidden');
    } else {
        backBtn.classList.remove('hidden');
    }
}

function setupDashboardNav() {
    const navItems = document.querySelectorAll('.nav-item');
    const contentViews = document.querySelectorAll('.content-view');

    navItems.forEach(item => {
        item.onclick = (e) => {
            const target = item.getAttribute('data-target');
            const id = item.id;

            // Handle Actions
            if (id === 'btn-manual-transfer' || id === 'btn-manual-transfer-mobile') {
                showToast('INITIALIZING_LINK: PREPARING SECURE TUNNELS...', 'info');
                const sInput = document.getElementById('shareFileInput');
                if (sInput) sInput.click();
                return;
            }

            if (id === 'btn-nav-send') {
                handleSendAction();
                return;
            }

            if (!target) return;
            
            if (target === 'vault-view') renderVault();

            // Sync Nav UI
            navItems.forEach(i => {
                i.classList.toggle('active', i.getAttribute('data-target') === target);
            });

            // View Switch with Glitch
            const currentView = document.querySelector('.content-view:not(.hidden)');
            const nextView = document.getElementById(target);

            if (currentView && nextView && currentView !== nextView) {
                performContentGlitch(currentView, nextView);
                updateBackButtonVisibility(target);
            }
        };
    });

    const btnBack = document.getElementById('btn-dashboard-back');
    if (btnBack) {
        btnBack.onclick = () => {
            const radarBtn = document.querySelector('.nav-item[data-target="radar-view"]');
            if (radarBtn) radarBtn.click();
        };
    }

    // Handshake Logic
    const btnGetCode = document.getElementById('btn-get-code');
    const btnJoinCode = document.getElementById('btn-join-code');
    const inputCode = document.getElementById('input-code');

    if (btnGetCode) {
        btnGetCode.onclick = () => {
            sendSignaling({ type: 'create-passcode' });
            btnGetCode.disabled = true;
            setTimeout(() => { btnGetCode.disabled = false; }, 5000);
        };
    }

    if (btnJoinCode) {
        btnJoinCode.onclick = () => {
            const code = inputCode.value.trim();
            if (code.length === 6) {
                sendSignaling({ type: 'use-passcode', code });
                showToast('LINKING_SECTORS...', 'info');
            } else {
                showToast('INVALID_AUTH_CODE', 'error');
            }
        };
    }

    const toggleCompress = document.getElementById('toggle-compress');
    if (toggleCompress) {
        toggleCompress.onchange = (e) => {
            playClick();
            if (e.target.checked) {
                showToast('COMPRESSION_PROTOCOL: ACTIVE', 'success');
            } else {
                showToast('COMPRESSION_PROTOCOL: STANDBY', 'info');
            }
        };
    }
}

// Consolidated Send Action: Decides between P2P and Cloud
function handleSendAction() {
    if (peers.size === 1) {
        // One peer? Direct P2P
        const peerId = Array.from(peers.keys())[0];
        currentTransferTarget = peerId;
        const fInput = document.getElementById('fileInput');
        if (fInput) fInput.click();
    } else if (peers.size > 1) {
        // Multiple peers? Ask them to pick one on Radar
        showToast('SELECT A NODE FROM RADAR FOR DIRECT P2P', 'info');
        const radarBtn = document.querySelector('.nav-item[data-target="radar-view"]');
        if (radarBtn) radarBtn.click();
    } else {
        // No peers? Offer Cloud Bridge
        showToast('NO_LOCAL_NODES: ACCESSING CLOUD_BRIDGE...', 'info');
        const sInput = document.getElementById('shareFileInput');
        if (sInput) sInput.click();
    }
}

function performContentGlitch(hideEl, showEl) {
    const main = document.getElementById('main-content');
    main.classList.add('glitching');
    playClick();
    setTimeout(() => {
        hideEl.classList.add('hidden');
        showEl.classList.remove('hidden');
        main.classList.remove('glitching');
    }, 200);
}

function triggerProgressiveLoad() {
    const mainContent = document.getElementById('main-content');
    const items = mainContent.querySelectorAll('*');
    items.forEach((item, index) => {
        setTimeout(() => item.classList.add('loaded'), index * 100);
    });
}

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.relay.metered.ca:443' },
        { urls: 'stun:stun.stunprotocol.org:3478' }
    ],
    iceCandidatePoolSize: 10
};

// UI Elements
const getEl = (id) => document.getElementById(id);
const statusIndicator = getEl('connectionStatusIndicator');
const statusText = getEl('connectionStatusText');
const agentDisplayName = getEl('agent-display-name');
const agentDisplayId = getEl('agent-display-id');
const peersContainer = getEl('peersContainer');
const fileInput = getEl('fileInput');
const shareFileInput = getEl('shareFileInput');
const radarContainer = document.querySelector('.radar-container');
const toastContainer = getEl('toastContainer');
const modalOverlay = getEl('modalOverlay');
const modalTitle = getEl('modalTitle');
const modalContent = getEl('modalContent');
const modalActions = getEl('modalActions');

// File transfer state
// File transfer state (Global defaults, but overridden per-peer if possible)
let incomingFile = null;
let receivedChunks = [];
let receivedSize = 0;
let currentTransferTarget = null;
let currentEncryptionKey = null; // Global reference for current active incoming/outgoing
let transferStartTime = null;

// ---------------------------
// Audio System
// ---------------------------

function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playClick() {
    initAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

function playSuccessSynth() {
    initAudio();
    const now = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, now + idx * 0.1);
        gain.gain.setValueAtTime(0.05, now + idx * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.1 + 0.3);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + idx * 0.1);
        osc.stop(now + idx * 0.1 + 0.3);
    });
}

function startHum() {
    initAudio();
    if (humOsc) return;
    humOsc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    humOsc.type = 'sawtooth';
    humOsc.frequency.setValueAtTime(55, audioCtx.currentTime); 
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(150, audioCtx.currentTime);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.05, audioCtx.currentTime + 1);
    humOsc.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);
    humOsc.start();
}

function stopHum() {
    if (humOsc) {
        humOsc.stop();
        humOsc = null;
    }
}

// ---------------------------
// Authentication Logic
// ---------------------------

const btnEnter = document.getElementById('btn-enter');
const btnLogin = document.getElementById('btn-login');
const btnRegister = document.getElementById('btn-register');
const switchToSignup = document.getElementById('switch-to-signup');
const switchToLogin = document.getElementById('switch-to-login');
const btnLogout = document.getElementById('btn-logout');
const btnUpsideDown = document.getElementById('btn-upside-down');

if (btnUpsideDown) {
    btnUpsideDown.onclick = () => {
        document.body.classList.toggle('upside-down');
        playClick();
        if (document.body.classList.contains('upside-down')) {
            showToast('DIMENSIONAL BREACH DETECTED. WEARING HAZMAT SUIT...', 'error');
            startParticles();
        } else {
            showToast('RETURNING TO NORMAL REALITY.', 'success');
            stopParticles();
        }
    };
}

btnEnter.onclick = () => {
    document.body.classList.add('crt-on');
    views.entry.style.opacity = '0';
    setTimeout(() => showView('auth'), 500);
};

switchToSignup.onclick = () => flipAuthCard(true);
switchToLogin.onclick = () => flipAuthCard(false);

function flipAuthCard(showSignup) {
    const authCard = document.getElementById('auth-card');
    const shell = document.querySelector('.auth-center-shell');
    if (!authCard) return;
    
    playClick();
    shell.classList.add('glitching'); // Still use glitch for flavor
    
    if (showSignup) {
        authCard.classList.add('is-flipped');
    } else {
        authCard.classList.remove('is-flipped');
    }
    
    setTimeout(() => shell.classList.remove('glitching'), 300);
}

document.querySelectorAll('.terminal-input').forEach(input => {
    input.oninput = () => playClick();
});

btnLogin.onclick = async () => {
    const username = document.getElementById('login-id').value;
    const password = document.getElementById('login-pass').value;
    
    try {
        const res = await fetch(`${API_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        loginSuccess(data);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

btnRegister.onclick = async () => {
    const fullName = document.getElementById('signup-name').value;
    const username = document.getElementById('signup-id').value;
    const password = document.getElementById('signup-pass').value;

    try {
        const res = await fetch(`${API_URL}/api/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, username, password })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        showToast('ACCOUNT AUTHORIZED. PROCEED TO VERIFICATION.', 'success');
        playSuccessSynth();
        
        // Flip back to Login side for "Verification"
        setTimeout(() => flipAuthCard(false), 1500); 
        
    } catch (e) {
        showToast(e.message, 'error');
    }
};

function loginSuccess(data) {
    currentUser = data;
    localStorage.setItem('gatekeeper_session', JSON.stringify(data));
    playSuccessSynth();
    updateAgentBadge();
    showView('dashboard');
    connectSignaling();
}

function updateAgentBadge() {
    const nameEl = getEl('agent-display-name');
    const idEl = getEl('agent-display-id');
    if (nameEl) nameEl.textContent = `AGENT: ${currentUser.fullName.toUpperCase()}`;
    if (idEl) idEl.textContent = (currentUser.agentId || currentUser.username).toUpperCase();
    
    // Make badge clickable for QR Identification
    const badge = document.querySelector('.agent-badge');
    if (badge) {
        badge.style.cursor = 'pointer';
        badge.onclick = (e) => {
            if (e.target.closest('#btn-logout')) return;
            showQRIdentification();
        };
    }
}

function showQRIdentification() {
    const qrModal = getEl('qrModal');
    const qrContainer = getEl('qrcode');
    const ipDisplay = getEl('local-ip-display');
    if (!qrModal || !qrContainer) return;
    
    qrContainer.innerHTML = '';
    
    // Construct pairing URL
    const url = new URL(window.location.href);
    if (myId) url.searchParams.set('target', myId);
    
    new QRCode(qrContainer, {
        text: url.toString(),
        width: 200,
        height: 200,
        colorDark : "#000000",
        colorLight : "#ffffff",
        correctLevel : QRCode.CorrectLevel.H
    });
    
    if (ipDisplay) ipDisplay.textContent = window.location.hostname;
    qrModal.classList.remove('hidden');
    playClick();
}

btnLogout.onclick = () => {
    localStorage.removeItem('gatekeeper_session');
    currentUser = null;
    if (ws) ws.close();
    location.reload();
};

// Crypto System (Void-Proof Shielding)
async function generateKey() {
    return await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

async function exportKey(key) {
    const exported = await crypto.subtle.exportKey("raw", key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

async function importKey(keyStr) {
    const rawKey = new Uint8Array(atob(keyStr).split("").map(c => c.charCodeAt(0)));
    return await crypto.subtle.importKey(
        "raw",
        rawKey,
        "AES-GCM",
        true,
        ["encrypt", "decrypt"]
    );
}

async function encryptData(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        data
    );
    // Return IV + Encrypted Data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    return combined;
}

async function decryptData(combinedData, key) {
    const iv = combinedData.slice(0, 12);
    const data = combinedData.slice(12);
    return await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        data
    );
}

// ---------------------------
// Signaling & P2P
// ---------------------------

function connectSignaling() {
    updateStatus('connecting', 'SCANNING_SIGNALS...');
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
        updateStatus('online', 'SIGNAL_ACTIVE');
        // Announce our presence with Identity
        if (currentUser) {
            sendSignaling({
                type: 'register-agent',
                agentId: currentUser.agentId || currentUser.username
            });
        }
    };
    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
            case 'init':
                myId = msg.id;
                myName = msg.name;
                const displayId = getEl('agent-display-id');
                if (displayId) displayId.textContent = myId.substring(0, 8).toUpperCase();

                showToast(`NODE_READY: ${myName}`, 'success');
                msg.peers.forEach(p => addPeer(p.id, p.name, p.agentId));
                
                // If we scanned a QR, initiate discovery override
                if (autoConnectTarget) {
                    autoSendPending = true; // Flag for instant sharing
                    const targetPeer = msg.peers.find(p => p.id === autoConnectTarget);
                    if (targetPeer) {
                        showToast(`PHASING INTO TARGET: ${targetPeer.name}`, 'info');
                        setTimeout(() => startConnection(autoConnectTarget), 1000);
                    } else {
                        // Not in same IP pool, ask server for direct discovery
                        sendSignaling({ type: 'discover', targetId: autoConnectTarget });
                    }
                }
                break;
            case 'peer-joined':
                addPeer(msg.peer.id, msg.peer.name, msg.peer.agentId);
                showToast(`SECURE_LINK_ESTABLISHED: ${msg.peer.name.toUpperCase()}`, 'success');
                
                // Switch to Radar View
                const radarBtn = document.querySelector('.nav-item[data-target="radar-view"]');
                if (radarBtn) {
                   radarBtn.click();
                }

                // AUTO-WARM: Initiate WebRTC Bridge immediately for smooth transfer
                // To avoid "glare" (both sides trying to offer), only one side initiates.
                // We use a simple rule: the peer with the lexicographically smaller ID initiates.
                // OR if it's a join-by-code/QR, we could have a specific flag.
                setTimeout(() => {
                    const isInitiator = myId < msg.peer.id;
                    if (isInitiator) {
                        console.log(`[AUTO_WARM] We are initiator. Pairing with ${msg.peer.id}`);
                        startConnection(msg.peer.id);
                    } else {
                        console.log(`[AUTO_WARM] Waiting for offer from ${msg.peer.id}`);
                    }
                }, 1000);
                break;
            case 'passcode-ready':
                const display = document.getElementById('display-code');
                if (display) display.textContent = msg.code;
                showToast('HANDSHAKE_CODE_GENERATED', 'info');
                break;
            case 'error':
                showToast(`SIGNAL_ERROR: ${msg.message}`, 'error');
                break;
            case 'peer-left':
                removePeer(msg.peerId);
                break;
            case 'peer-updated':
                updatePeerIdentity(msg.peer.id, msg.peer.agentId);
                break;
            case 'offer':
            console.log(`[SIGNALING] INCOMING_OFFER_FROM: ${msg.sender}`);
            handleOffer(msg);
            break;
        case 'answer':
            console.log(`[SIGNALING] INCOMING_ANSWER_FROM: ${msg.sender}`);
            handleAnswer(msg);
            break;
        case 'candidate':
            handleCandidate(msg);
            break;
            case 'file-header': handleIncomingFileRequest(msg); break;
            case 'ping': sendSignaling({ type: 'pong' }); break;
        }
    };

    ws.onclose = () => {
        updateStatus('offline', 'SIGNAL_LOST');
        peers.forEach((_, id) => removePeer(id));
        setTimeout(connectSignaling, 3000); 
    };

    ws.onerror = (err) => {
        ws.close();
    };
}

function updateStatus(status, text) {
    const indicator = document.getElementById('connectionStatusIndicator');
    const statusText = document.getElementById('connectionStatusText');
    if (indicator) indicator.className = `status-indicator ${status}`;
    if (statusText) statusText.textContent = text;
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'ri-shield-check-line' : 'ri-error-warning-line';
    toast.innerHTML = `<i class="${icon}"></i> <span>${message}</span>`;
    document.getElementById('toastContainer').appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// ---------------------------
// Peer UI Management
// ---------------------------

// Peer Management
function addPeer(id, name, agentId = null) {
    if (peers.has(id)) return;

    const radar = document.querySelector('.radar-container');
    const width = radar ? radar.offsetWidth : 600;
    const height = radar ? radar.offsetHeight : 600;
    const containerSize = Math.min(width || 600, height || 600);
    
    const angle = Math.random() * Math.PI * 2;
    const dist = (containerSize * 0.35) * (0.6 + Math.random() * 0.4);
    
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist;

    const el = document.createElement('div');
    el.className = 'peer-node';
    el.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    el.innerHTML = `
        <div class="avatar">
            <i class="ri-broadcast-line"></i>
        </div>
        <div class="peer-details">
            <div class="peer-name">${name}</div>
            <div class="peer-id-label">${agentId ? `[ID: ${agentId}]` : '[ANONYMOUS]'}</div>
            <button class="btn-peer-stabilize" title="RE-CONNECT_SIGNAL">
                <i class="ri-refresh-line"></i>
                STABILIZE
            </button>
        </div>
    `;

    const stabilizeBtn = el.querySelector('.btn-peer-stabilize');
    stabilizeBtn.onclick = (e) => {
        e.stopPropagation();
        showToast('RE-ESTABLISHING SECURE BRIDGE...', 'info');
        startConnection(id);
    };

    el.onclick = async (e) => { 
        e.stopPropagation();
        currentTransferTarget = id; 
        const agentName = agentId ? `AGENT_${agentId.toUpperCase()}` : name;
        
        // Ask for optional P2P password
        promptP2PPassword(id, agentName);
    };
    
    if (peersContainer) peersContainer.appendChild(el);
    peers.set(id, { 
        name, 
        el, 
        agentId, 
        connection: null, 
        dataChannel: null, 
        fileQueue: [],
        pendingFile: null,
        incomingFile: null,
        receivedChunks: [],
        receivedSize: 0,
        encryptionKey: null,
        transferStartTime: null,
        iceQueue: [], // Queue for ICE candidates before remote description is set
        messageQueue: [],
        isProcessingQueue: false
    });
}

function updatePeerIdentity(id, agentId) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.agentId = agentId;
    const label = peer.el.querySelector('.peer-id-label');
    if (label) label.textContent = `[ID: ${agentId}]`;
}

function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;

    if (peer.connection) peer.connection.close();
    peer.el.remove();
    peers.delete(id);
    showToast(`SIGNAL_LOST: ${peer.name}`, 'info');
}

// ---------------------------
// WebRTC Logic
// ---------------------------

function getOrCreateConnection(peerId) {
    let peer = peers.get(peerId);
    if (!peer) return null;

    // Check if current connection is unusable
    const isUnusable = peer.connection && (
        peer.connection.connectionState === 'failed' || 
        peer.connection.connectionState === 'closed'
    );

    if (!peer.connection || isUnusable) {
        if (isUnusable) {
            console.log(`[CLEAN_UP] Dropping unusable connection to ${peer.name}`);
            peer.connection.close();
        }
        
        const pc = new RTCPeerConnection(rtcConfig);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                console.log(`[ICE_SENT] Candidate found for ${peerId}`);
                sendSignaling({ type: 'candidate', target: peerId, candidate: e.candidate });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`[CONN_STATE] ${pc.connectionState} for ${peer.name}`);
            if (pc.connectionState === 'connected') {
                showToast(`SECURE BRIDGE STABILIZED WITH ${peer.name.toUpperCase()}`, 'success');
            } else if (pc.connectionState === 'failed') {
                showToast(`SIGNAL_FAILED WITH ${peer.name.toUpperCase()}. ATTEMPTING_RECOVERY...`, 'error');
            } else if (pc.connectionState === 'disconnected') {
                showToast(`SIGNAL_DROPPED WITH ${peer.name.toUpperCase()}.`, 'info');
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`[ICE_STATE] ${pc.iceConnectionState} for ${peer.name}`);
            if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
                console.warn('[ICE_RECOVERY] Attempting aggressive restart...');
                pc.restartIce();
                // If we are the primary node for this connection, re-offer if stale
                setTimeout(() => {
                    if (pc.signalingState === 'stable' && pc.iceConnectionState !== 'connected') {
                        if (myId < peerId) startConnection(peerId);
                    }
                }, 3000);
            }
        };

        pc.ondatachannel = (e) => {
            const dc = e.channel;
            console.log(`[DC_RECEIVED] Channel incoming from ${peerId}`);
            setupDataChannel(peerId, dc);
            peer.dataChannel = dc;
        };

        peer.connection = pc;
    }
    return peer.connection;
}

async function startConnection(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;

    // Reuse existing stable bridge if possible
    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        console.log(`[REUSING_BRIDGE] Node ${peerId.substring(0, 4)} already has an active link.`);
        if (peer.fileQueue.length > 0 && !peer.pendingFile) {
            sendFileHeader(peerId, peer.fileQueue[0]);
        }
        return;
    }

    const pc = getOrCreateConnection(peerId);
    const dc = pc.createDataChannel('fileTransfer');
    setupDataChannel(peerId, dc);
    peer.dataChannel = dc;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    sendSignaling({ type: 'offer', target: peerId, offer: offer });
}

async function handleOffer(msg) {
    const pc = getOrCreateConnection(msg.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
    processIceQueue(msg.sender);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendSignaling({ type: 'answer', target: msg.sender, answer: answer });
}

async function handleAnswer(msg) {
    const pc = getOrCreateConnection(msg.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
    processIceQueue(msg.sender);
}

async function handleCandidate(msg) {
    const peer = peers.get(msg.sender);
    const pc = getOrCreateConnection(msg.sender);
    if (!pc || !peer) return;

    if (pc.remoteDescription && pc.remoteDescription.type) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(e => console.warn("ICE_CANDIDATE_ERR", e));
    } else {
        peer.iceQueue.push(msg.candidate);
    }
}

async function processIceQueue(peerId) {
    const peer = peers.get(peerId);
    if (!peer || !peer.connection) return;
    while (peer.iceQueue.length > 0) {
        const candidate = peer.iceQueue.shift();
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn("ICE_QUEUED_ERR", e));
    }
}

// ---------------------------
// Data Channel & File Transfer
// ---------------------------

function setupDataChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
        console.log(`BRIDGE OPENED WITH NODE_${peerId.substring(0, 4)}`);
        
        const peer = peers.get(peerId);
        if (!peer) return;

        // Priority Handshake: Trigger file picker if auto-send is pending
        if (autoSendPending) {
            autoSendPending = false; 
            currentTransferTarget = peerId;
            const fInput = getEl('fileInput');
            if (fInput) {
                showToast('BRIDGE ESTABLISHED. SELECT INTEL.', 'success');
                fInput.click();
            }
        } 
        // Process mission queue if files were selected before the bridge opened
        else if (peer.fileQueue.length > 0) {
            showToast(`TRANSMITTING ${peer.fileQueue.length} INTEL PACKETS...`, 'info');
            sendFileHeader(peerId, peer.fileQueue[0]);
        }
    };
    dc.onclose = () => {
        console.log(`BRIDGE CLOSED`);
        stopHum();
    };

    dc.onmessage = (e) => {
        const peer = peers.get(peerId);
        if (!peer) return;

        // Push all messages to a queue to ensure strict order of processing,
        // especially important when binary chunks require async decryption.
        peer.messageQueue.push(e.data);
        processPeerMessageQueue(peerId);
    };
}

async function processPeerMessageQueue(peerId) {
    const peer = peers.get(peerId);
    if (!peer || peer.isProcessingQueue || peer.messageQueue.length === 0) return;

    peer.isProcessingQueue = true;

    while (peer.messageQueue.length > 0) {
        const data = peer.messageQueue.shift();

        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'file-header') {
                    await handleIncomingFileRequest(msg, peerId);
                } else if (msg.type === 'transfer-accepted') {
                    startSendingFile(peerId);
                } else if (msg.type === 'transfer-rejected') {
                    showToast('TRANSFER ABORTED BY REMOTE NODE', 'error');
                } else if (msg.type === 'file-complete') {
                    finishReceivingFile(peerId);
                } else if (msg.type === 'transfer-finished-ack') {
                    if (peer.fileQueue.length > 0) {
                        sendFileHeader(peerId, peer.fileQueue[0]);
                    }
                }
            } catch (err) {
                console.error('JSON_PARSE_ERR', err);
            }
        } else {
            // Binary chunk received (Encrypted)
            try {
                // Ensure peer has encryption key before decrypting
                if (peer.encryptionKey) {
                    const decrypted = await decryptData(new Uint8Array(data), peer.encryptionKey);
                    receiveChunk(decrypted, peerId);
                } else {
                    console.warn('RECEIVED_BINARY_WITHOUT_KEY');
                }
            } catch (err) {
                console.error('DECRYPTION_FAILED', err);
            }
        }
    }

    peer.isProcessingQueue = false;
}

async function computeHash(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0 || !currentTransferTarget) return;

    const peer = peers.get(currentTransferTarget);
    if (!peer) return;

    // Password was set by promptP2PPassword
    const password = peer.transferPassword || null;
    const passwordHash = password ? await computeHash(new TextEncoder().encode(password)) : null;

    // Add all files to the mission queue (with optional compression)
    for (const file of files) {
        const processedFile = await maybeCompressFile(file);
        // Attach the hash to the file object for the header
        processedFile.authHash = passwordHash;
        peer.fileQueue.push(processedFile);
    }

    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        if (!peer.pendingFile) {
            sendFileHeader(currentTransferTarget, peer.fileQueue[0]);
        } else {
            showToast(`QUEUED: ${files.length} FILES ADDED TO TUNNEL.`, 'info');
        }
    } else {
        showToast('ESTABLISHING SECURE BRIDGE...', 'info');
        if (!peer.connection || peer.connection.connectionState === 'disconnected') {
            await startConnection(currentTransferTarget);
        }
    }

    fileInput.value = ''; 
});

function promptP2PPassword(peerId, agentName) {
    if (modalTitle) modalTitle.textContent = 'SECURE BRIDGE PROTOCOL';
    if (modalContent) {
        modalContent.innerHTML = `
            <div style="width: 100%; text-align: center;">
                <p style="font-size: 0.8rem; color: var(--text-main);">ESTABLISHING ENCRYPTED TUNNEL TO: ${agentName}</p>
                <div class="field-row" style="margin: 1.5rem 0;">
                    <label>ACCESS_CODE (OPTIONAL):</label>
                    <input type="password" id="p2p-password" class="terminal-input" placeholder="ENTER TO PROTECT OR LEAVE BLANK">
                </div>
                <div style="display: flex; gap: 10px;">
                    <button id="btn-cancel-p2p" class="btn btn-secondary" style="flex: 1;">ABORT</button>
                    <button id="btn-proceed-p2p" class="btn btn-primary" style="flex: 2;">PROCEED</button>
                </div>
            </div>
        `;
    }
    if (modalActions) modalActions.innerHTML = '';
    if (modalOverlay) modalOverlay.classList.remove('hidden');

    document.getElementById('btn-cancel-p2p').onclick = () => {
        if (modalOverlay) modalOverlay.classList.add('hidden');
    };

    document.getElementById('btn-proceed-p2p').onclick = () => {
        const peer = peers.get(peerId);
        if (peer) {
            peer.transferPassword = document.getElementById('p2p-password').value;
        }
        if (modalOverlay) modalOverlay.classList.add('hidden');
        if (fileInput) fileInput.click();
    };
}

async function sendFileHeader(peerId, file) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        showToast('BRIDGE NOT ESTABLISHED.', 'error');
        return;
    }

    // Generate Key for this peer
    peer.encryptionKey = await generateKey();
    const keyStr = await exportKey(peer.encryptionKey);
    
    // Hash file (Quick hash for progress - only using metadata for speed on large files)
    const quickHash = `${file.name}-${file.size}-${file.lastModified}`;

    peer.pendingFile = file;

    peer.dataChannel.send(JSON.stringify({
        type: 'file-header',
        name: file.name,
        size: file.size,
        mime: file.type,
        hash: quickHash, 
        authHash: file.authHash || null,
        vpsKey: keyStr
    }));

    showToast(`REQUESTING CLEARANCE FROM ${peer.name.toUpperCase()}...`, 'info');
}

async function startSendingFile(peerId) {
    const peer = peers.get(peerId);
    const file = peer.pendingFile;
    const dc = peer.dataChannel;

    if (!file || !dc) return;

    showToast(`INITIATING TRANSFER: BRIDGE THE GAP...`, 'info');
    startHum();

    let offset = 0;

    const readSlice = (o) => {
        const slice = file.slice(offset, o + CHUNK_SIZE);
        const reader = new FileReader();
        reader.onload = async (e) => {
            if (dc.readyState !== 'open') return;

            // Encrypt Chunk (Void-Proof Shielding)
            const encrypted = await encryptData(e.target.result, peer.encryptionKey);
            
            dc.send(encrypted);
            offset += e.target.result.byteLength;

            if (offset < file.size) {
                // High-performance backpressure: 1MB threshold
                if (dc.bufferedAmount > 1024 * 1024) {
                    // Use onbufferedamountlow for even better performance if supported,
                    // but for now, a short delay is robust across all browsers.
                    setTimeout(() => readSlice(offset), 50);
                } else {
                    // Micro-task yield to keep UI responsive
                    setTimeout(() => readSlice(offset), 0);
                }
            } else {
                dc.send(JSON.stringify({ type: 'file-complete' }));
                showToast(`INTEL TRANSMITTED: ${file.name.toUpperCase()}`, 'info');
                playSuccessSynth();
                stopHum();
                
                peer.pendingFile = null;
                peer.fileQueue.shift(); // Remove the completed file
                // Wait for 'transfer-finished-ack' before sending next
            }
        };
        reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
}

// Receiving
async function handleIncomingFileRequest(msg, senderId) {
    try {
        const sender = peers.get(senderId);
        if (!sender) return;

        // Import Key for this peer
        sender.encryptionKey = await importKey(msg.vpsKey);

        sender.incomingFile = {
            name: msg.name,
            size: msg.size,
            mime: msg.mime,
            hash: msg.hash,
            senderId: senderId
        };
        sender.receivedChunks = [];
        sender.receivedSize = 0;
        sender.transferStartTime = Date.now();

        const mTitle = getEl('modalTitle');
        const mContent = getEl('modalContent');
        const mActions = getEl('modalActions');
        const mOverlay = getEl('modalOverlay');

        if (mTitle) mTitle.textContent = "THE GATE IS OPEN. ESTABLISHING SECURE TUNNEL.";
        if (mContent) {
            const agentName = sender.agentId ? `AGENT_${sender.agentId.toUpperCase()}` : sender.name;
            mContent.innerHTML = `
                <div class="sender-ident" style="font-size: 0.8rem; color: var(--accent-primary); margin-bottom: 1rem; text-align: center;">
                    [RECEIVING FROM: ${agentName}]
                </div>
                <div class="file-info">
                    <i class="ri-folder-shield-2-line"></i>
                    <div class="file-details">
                        <span class="file-name">${msg.name}</span>
                        <span class="file-size">${(msg.size / (1024*1024)).toFixed(2)} MB</span>
                        <span id="transferRate" style="color: var(--text-main); font-size: 0.7rem; margin-top: 5px;">[STABILIZING TUNNEL...]</span>
                    </div>
                </div>
                <div class="progress-container" id="receiveProgressContainer">
                    <div class="progress-bar" id="receiveProgressBar"></div>
                    <span class="progress-label" id="progressLabel">CONNECTING...</span>
                </div>
            `;
        }

        if (mActions) {
            mActions.innerHTML = `
                <button id="btn-reject-transfer" class="btn btn-secondary">REJECT</button>
                <button id="btn-accept-transfer" class="btn btn-primary">ACCEPT</button>
            `;

            document.getElementById('btn-reject-transfer').onclick = () => {
                sender.dataChannel.send(JSON.stringify({ type: 'transfer-rejected' }));
                if (mOverlay) mOverlay.classList.add('hidden');
                stopHum();
                showToast('TRANSFER_REJECTED', 'error');
            };

            document.getElementById('btn-accept-transfer').onclick = async () => {
                // If the file is protected, ask for password
                if (msg.authHash) {
                    showP2PPasswordChallenge(senderId, msg.authHash);
                } else {
                    startP2PTransfer(senderId);
                }
            };
        }

        if (mOverlay) mOverlay.classList.remove('hidden');
    } catch (err) {
        console.error('TRANSFER_INIT_FAILED:', err);
        showToast('SIGNAL_BREACH: FAILED TO OPEN TUNNEL', 'error');
    }
}

function showP2PPasswordChallenge(senderId, authHash) {
    if (modalTitle) modalTitle.textContent = 'ACCESS_CODE_REQUIRED';
    if (modalContent) {
        modalContent.innerHTML = `
            <div style="width: 100%; text-align: center;">
                <p style="font-size: 0.8rem; color: var(--accent-primary);">THIS INTEL IS PROTECTED BY A CLEARANCE CODE.</p>
                <div class="field-row" style="margin: 1.5rem 0;">
                    <label>ENTER_CLEARANCE_CODE:</label>
                    <input type="password" id="p2p-challenge-pass" class="terminal-input" placeholder="...">
                    <p id="p2p-auth-error" class="hidden" style="color: var(--accent-primary); font-size: 0.7rem; margin-top: 5px;">[INVALID_CODE_TRY_AGAIN]</p>
                </div>
                <button id="btn-verify-p2p" class="btn btn-primary" style="width: 100%;">VERIFY_CLEARANCE</button>
            </div>
        `;
    }

    document.getElementById('btn-verify-p2p').onclick = async () => {
        const input = document.getElementById('p2p-challenge-pass').value;
        const inputHash = await computeHash(new TextEncoder().encode(input));
        
        if (inputHash === authHash) {
            startP2PTransfer(senderId);
        } else {
            const err = document.getElementById('p2p-auth-error');
            if (err) err.classList.remove('hidden');
            playClick();
        }
    };
}

function startP2PTransfer(senderId) {
    const sender = peers.get(senderId);
    if (!sender || !sender.dataChannel || sender.dataChannel.readyState !== 'open') {
        showToast('BRIDGE_STABILITY_ERROR: RETRYING...', 'error');
        startConnection(senderId); // Force re-stabilize
        return;
    }

    const mActions = getEl('modalActions');
    if (mActions) mActions.innerHTML = '';
    
    startHum();
    try {
        sender.dataChannel.send(JSON.stringify({ type: 'transfer-accepted' }));
        sender.transferStartTime = Date.now();
        showToast('ESTABLISHING_TUNNEL...', 'info');
    } catch (err) {
        console.error('TRANSFER_ACCEPT_SEND_FAILED', err);
        showToast('TUNNEL_FAILED: RETRYING...', 'error');
        startConnection(senderId);
    }
}

function showDownloadAuthModal(fileId) {
    if (modalTitle) modalTitle.textContent = 'REMOTE_DOWNLOAD_CONFIG';
    if (modalContent) {
        modalContent.innerHTML = `
            <div style="width: 100%; text-align: center;">
                <p style="font-size: 0.8rem; color: var(--text-main);">ACCESSING REMOTE INTEL: NODE_${fileId.substring(0,4)}</p>
                <div class="field-row" style="margin: 1.5rem 0;">
                    <label>ACCESS_CODE (IF PROTECTED):</label>
                    <input type="password" id="dl-password" class="terminal-input" placeholder="LEAVE BLANK IF NO PASSWORD">
                </div>
                <button id="btn-start-dl" class="btn btn-primary" style="width: 100%;">START_DOWNLOAD</button>
            </div>
        `;
    }
    if (modalActions) modalActions.innerHTML = '';
    if (modalOverlay) modalOverlay.classList.remove('hidden');

    document.getElementById('btn-start-dl').onclick = () => {
        const password = document.getElementById('dl-password').value;
        window.location.href = `${API_URL}/download/${fileId}?p=${encodeURIComponent(password)}`;
        
        // Minor delay to let the download start before hiding modal
        setTimeout(() => {
            if (modalOverlay) modalOverlay.classList.add('hidden');
            // Remove the URL param to clean up
            const newUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, newUrl);
        }, 3000);
    };
}

function receiveChunk(data, senderId) {
    const peer = peers.get(senderId);
    if (!peer || !peer.incomingFile) return;
    
    peer.receivedChunks.push(data);
    peer.receivedSize += data.byteLength;

    const progress = Math.min(100, (peer.receivedSize / peer.incomingFile.size) * 100);
    const bar = document.getElementById('receiveProgressBar');
    const label = document.getElementById('progressLabel');
    const rateEl = document.getElementById('transferRate');
    
    if (bar) bar.style.width = `${progress}%`;
    if (label) label.textContent = `SYNCING: ${progress.toFixed(1)}%`;
    
    if (rateEl && peer.transferStartTime) {
        const elapsed = (Date.now() - peer.transferStartTime) / 1000;
        const speed = (peer.receivedSize / (1024 * 1024)) / elapsed; // MB/s
        rateEl.textContent = `[SPEED: ${speed.toFixed(2)} MB/S]`;
    }
}

function finishReceivingFile(senderId) {
    const peer = peers.get(senderId);
    if (!peer || !peer.incomingFile) return;
    
    stopHum();
    const blob = new Blob(peer.receivedChunks, { type: peer.incomingFile.mime });
    
    playSuccessSynth();
    
    // Add to Secure Vault
    vaultFiles.push({
        name: peer.incomingFile.name,
        size: peer.incomingFile.size,
        blob: blob,
        sender: peer.name || 'UNKNOWN_NODE',
        timestamp: new Date().toLocaleTimeString()
    });
    
    // Auto-update Vault if visible
    const vaultView = document.getElementById('vault-view');
    if (vaultView && !vaultView.classList.contains('hidden')) {
        renderVault();
    }
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = peer.incomingFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`INTEL_SECURED: ${peer.incomingFile.name.toUpperCase()}`, 'success');

    // Signal clearance for next file
    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
        peer.dataChannel.send(JSON.stringify({ type: 'transfer-finished-ack' }));
    }

    const modal = document.getElementById('modalOverlay');
    if (modal) modal.classList.add('hidden');
    
    peer.incomingFile = null;
    peer.receivedChunks = [];
}

function renderVault() {
    const list = document.getElementById('vaultList');
    const placeholder = document.querySelector('#vault-view .thematic-placeholder');
    if (!list || !placeholder) return;

    if (vaultFiles.length === 0) {
        list.classList.add('hidden');
        placeholder.classList.remove('hidden');
        return;
    }

    list.classList.remove('hidden');
    placeholder.classList.add('hidden');

    list.innerHTML = vaultFiles.map((file, index) => `
        <div class="vault-item">
            <div class="vault-item-info">
                <i class="ri-file-shield-line"></i>
                <div>
                    <div class="vault-filename">${file.name}</div>
                    <div class="vault-filesize">${(file.size / (1024*1024)).toFixed(2)} MB | ${file.timestamp} | FROM: ${file.sender}</div>
                </div>
            </div>
            <button class="btn-vault-download" data-index="${index}" onclick="window.downloadFromVault(${index})">
                <i class="ri-download-2-line"></i>
            </button>
        </div>
    `).join('');
}

window.downloadFromVault = (index) => {
    const file = vaultFiles[index];
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`RE-CONFIGURING CLASSIFIED INTEL...`, 'info');
};

// ---------------------------
// Compression Protocol
// ---------------------------

async function maybeCompressFile(file) {
    const shouldCompress = document.getElementById('toggle-compress')?.checked;
    if (!shouldCompress) return file;

    // Only compress if it's an image and reasonably large (> 1MB)
    if (file.type.startsWith('image/') && file.size > 1024 * 1024) {
        showToast(`COMPRESSING INTEL: ${file.name.toUpperCase()}...`, 'info');
        try {
            const compressed = await compressImage(file);
            const saved = ((file.size - compressed.size) / (1024 * 1024)).toFixed(2);
            showToast(`COMPRESSION_COMPLETE: SAVED ${saved} MB`, 'success');
            return compressed;
        } catch (e) {
            console.error('COMPRESSION_ERR', e);
            return file;
        }
    }
    
    // Video compression is complex in-browser without FFmpeg.wasm, 
    // we notify user that only images are optimized currently.
    if (file.type.startsWith('video/') && file.size > 10 * 1024 * 1024) {
        showToast('VIDEO_COMPRESSION_UNAVAILABLE: SENDING RAW DATA.', 'info');
    }

    return file;
}

async function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Max dimensions for "compressed" view
                const MAX_WIDTH = 1920;
                const MAX_HEIGHT = 1080;

                if (width > height) {
                    if (width > MAX_WIDTH) {
                        height *= MAX_WIDTH / width;
                        width = MAX_WIDTH;
                    }
                } else {
                    if (height > MAX_HEIGHT) {
                        width *= MAX_HEIGHT / height;
                        height = MAX_HEIGHT;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('Canvas toBlob failed'));
                        return;
                    }
                    const compressedFile = new File([blob], file.name, {
                        type: 'image/jpeg',
                        lastModified: Date.now()
                    });
                    
                    // Only return compressed if it's actually smaller
                    resolve(compressedFile.size < file.size ? compressedFile : file);
                }, 'image/jpeg', 0.82); // High-quality but efficient compression
            };
            img.onerror = reject;
        };
        reader.onerror = reject;
    });
}

function sendSignaling(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// ---------------------------
// Secure Bridge (Upload)
// ---------------------------

// ---------------------------
// Secure Bridge (Upload)
// ---------------------------

const initTransferBtn = document.querySelector('[data-target="initialize-transfer"]');
if (initTransferBtn) {
    initTransferBtn.addEventListener('click', () => {
        if (shareFileInput) shareFileInput.click();
    });
}

if (shareFileInput) {
    shareFileInput.addEventListener('change', async (e) => {
        const rawFiles = Array.from(e.target.files);
        if (rawFiles.length === 0) return;
        shareFileInput.value = '';

        if (modalTitle) modalTitle.textContent = 'SECURE_TUNNEL_CONFIG';
        if (modalContent) {
            modalContent.innerHTML = `
                <div style="width: 100%; text-align: center;">
                    <p style="font-size: 0.8rem; color: var(--text-main);">SET PROTECTION FOR ${rawFiles.length} FILES</p>
                    <div class="field-row" style="margin: 1.5rem 0;">
                        <label>ACCESS_CODE (OPTIONAL):</label>
                        <input type="password" id="share-password" class="terminal-input" placeholder="ENTER TO PROTECT OR LEAVE BLANK">
                    </div>
                    <button id="btn-start-secure-upload" class="btn btn-primary" style="width: 100%;">START_INITIALIZATION</button>
                </div>
            `;
        }
        if (modalActions) modalActions.innerHTML = '';
        if (modalOverlay) modalOverlay.classList.remove('hidden');

        document.getElementById('btn-start-secure-upload').onclick = async () => {
            const password = document.getElementById('share-password').value;
            
            if (modalTitle) modalTitle.textContent = 'INITIALIZING SECURE LINKS...';
            if (modalContent) {
                modalContent.innerHTML = `
                    <div id="multi-upload-container" style="max-height: 300px; overflow-y: auto; width: 100%;">
                        <p class="upload-status" id="uploadStatus">PREPARING ${rawFiles.length} FILES...</p>
                        <div id="upload-list"></div>
                    </div>
                `;
            }

            const results = [];
            const uploadList = document.getElementById('upload-list');

            for (let i = 0; i < rawFiles.length; i++) {
                const rawFile = rawFiles[i];
                const file = await maybeCompressFile(rawFile);
                
                const fileRow = document.createElement('div');
                fileRow.className = 'file-info-row';
                fileRow.style.marginBottom = '10px';
                fileRow.innerHTML = `
                    <div style="display: flex; justify-content: space-between; font-size: 0.75rem;">
                        <span>${file.name}</span>
                        <span id="p-${i}">WAITING...</span>
                    </div>
                    <div class="progress-container">
                        <div class="progress-bar" id="bar-${i}" style="width: 0%"></div>
                    </div>
                `;
                if (uploadList) uploadList.appendChild(fileRow);

                try {
                    const data = await uploadFile(file, password, (pct) => {
                        const bar = document.getElementById(`bar-${i}`);
                        const label = document.getElementById(`p-${i}`);
                        if (bar) bar.style.width = `${pct}%`;
                        if (label) label.textContent = `${Math.round(pct)}%`;
                    });
                    results.push(data);
                    if (document.getElementById(`p-${i}`)) document.getElementById(`p-${i}`).textContent = 'READY';
                } catch (err) {
                    console.error('UPLOAD_ERR', err);
                    if (document.getElementById(`p-${i}`)) document.getElementById(`p-${i}`).textContent = 'FAILED';
                }
            }

            showMultiLinkResults(results);
        };
    });
}

async function uploadFile(file, password, onProgress) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);
        if (password) formData.append('password', password);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/upload`);

        xhr.upload.onprogress = (evt) => {
            if (evt.lengthComputable) {
                onProgress((evt.loaded / evt.total) * 100);
            }
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText));
            } else {
                reject(new Error('SERVER_REJECTED'));
            }
        };

        xhr.onerror = () => reject(new Error('NETWORK_ERROR'));
        xhr.send(formData);
    });
}

function showMultiLinkResults(results) {
    if (modalTitle) modalTitle.textContent = 'INITIALIZED SECURE LINKS';
    if (modalContent) {
        modalContent.innerHTML = `
            <div id="results-list" style="width: 100%; max-height: 400px; overflow-y: auto;">
                ${results.map(data => `
                    <div class="share-result-row" style="margin-bottom: 1.5rem; border-bottom: 1px solid var(--glass-border); padding-bottom: 1rem;">
                        <div class="file-info" style="margin-bottom: 0.5rem;">
                            <i class="ri-check-double-line"></i>
                            <div class="file-details">
                                <span class="file-name">${data.name}</span>
                                <span class="file-size">${(data.size / (1024 * 1024)).toFixed(2)} MB</span>
                            </div>
                        </div>
                        <div class="share-link-box">
                            <input type="text" value="${data.url}" readonly />
                            <button class="btn-copy" onclick="navigator.clipboard.writeText('${data.url}').then(() => showToast('LINK_COPIED', 'success'))" title="Copy link">
                                <i class="ri-file-copy-line"></i>
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
            <p class="share-link-note" style="text-align: center;">ALL LINKS EXPIRE IN 24 HOURS</p>
        `;
    }
    if (modalActions) {
        modalActions.innerHTML = `
            <button class="btn btn-primary" id="btnCloseMulti">SECURE_TERMINAL</button>
        `;
    }

    const btnClose = getEl('btnCloseMulti');
    if (btnClose) {
        btnClose.onclick = () => {
            if (modalOverlay) modalOverlay.classList.add('hidden');
        };
    }
    playSuccessSynth();
}

// Start
// connectSignaling(); // This is now called by initApp() after login.
// ---------------------------
// Particle System (Upside Down)
// ---------------------------
let particleInterval = null;

function startParticles() {
    const container = document.getElementById('particle-container');
    if (!container) return;
    
    particleInterval = setInterval(() => {
        const p = document.createElement('div');
        p.className = 'ash-particle';
        const size = Math.random() * 5 + 2;
        p.style.width = `${size}px`;
        p.style.height = `${size}px`;
        p.style.left = `${Math.random() * 100}vw`;
        p.style.animationDuration = `${Math.random() * 5 + 5}s`;
        p.style.opacity = Math.random();
        container.appendChild(p);
        
        setTimeout(() => p.remove(), 10000);
    }, 200);
}

function stopParticles() {
    if (particleInterval) {
        clearInterval(particleInterval);
        particleInterval = null;
    }
    const container = document.getElementById('particle-container');
    if (container) container.innerHTML = '';
}
