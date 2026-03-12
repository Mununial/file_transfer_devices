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
    
    initApp();
});

function initApp() {
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
    }
}

function setupDashboardNav() {
    const navItems = document.querySelectorAll('.nav-item');
    const contentViews = document.querySelectorAll('.content-view');

    navItems.forEach(item => {
        item.onclick = () => {
            const target = item.getAttribute('data-target');
            if (target === 'initialize-transfer') return; // Handled by separate listener

            // Nav UI
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            // View Switch with Glitch
            const currentView = document.querySelector('.content-view:not(.hidden)');
            const nextView = document.getElementById(target);

            if (currentView && nextView && currentView !== nextView) {
                performContentGlitch(currentView, nextView);
            }
        };
    });
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

// WebRTC Configuration
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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
let incomingFile = null;
let receivedChunks = [];
let receivedSize = 0;
let currentTransferTarget = null;
let encryptionKey = null; // Void-Proof Shielding

// ---------------------------
// Audio System
// ---------------------------

function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playClick() {
    initAudio();
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
                showToast(`PROXIMITY_ALERT: ${msg.peer.name}`, 'success');
                
                // If this joined peer is our QR target, auto-connect now
                if (autoConnectTarget === msg.peer.id) {
                    autoSendPending = true; // Flag for instant sharing
                    showToast(`PHASING INTO TARGET: ${msg.peer.name}`, 'info');
                    setTimeout(() => startConnection(msg.peer.id), 1000);
                    autoConnectTarget = null; // Reset once triggered
                }
                break;
            case 'peer-left':
                removePeer(msg.peerId);
                break;
            case 'peer-updated':
                updatePeerIdentity(msg.peer.id, msg.peer.agentId);
                break;
            case 'offer': await handleOffer(msg); break;
            case 'answer': await handleAnswer(msg); break;
            case 'candidate': await handleCandidate(msg); break;
            case 'file-header': handleIncomingFileRequest(msg); break;
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
        </div>
    `;
    el.onclick = (e) => { 
        e.stopPropagation();
        currentTransferTarget = id; 
        if (fileInput) fileInput.click(); 
    };
    
    if (peersContainer) peersContainer.appendChild(el);
    peers.set(id, { name, el, agentId, connection: null, dataChannel: null });
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

    if (!peer.connection) {
        const pc = new RTCPeerConnection(rtcConfig);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                sendSignaling({ type: 'candidate', target: peerId, candidate: e.candidate });
            }
        };

        pc.ondatachannel = (e) => {
            const dc = e.channel;
            setupDataChannel(peerId, dc);
            peer.dataChannel = dc;
        };

        peer.connection = pc;
    }
    return peer.connection;
}

async function startConnection(peerId) {
    const pc = getOrCreateConnection(peerId);
    const peer = peers.get(peerId);

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

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendSignaling({ type: 'answer', target: msg.sender, answer: answer });
}

async function handleAnswer(msg) {
    const pc = getOrCreateConnection(msg.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
}

async function handleCandidate(msg) {
    const pc = getOrCreateConnection(msg.sender);
    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
}

// ---------------------------
// Data Channel & File Transfer
// ---------------------------

function setupDataChannel(peerId, dc) {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
        console.log(`BRIDGE OPENED WITH NODE_${peerId.substring(0, 4)}`);
        
        // If we came from a QR scan, trigger the file picker immediately
        if (autoSendPending) {
            autoSendPending = false; 
            currentTransferTarget = peerId;
            const fInput = getEl('fileInput');
            if (fInput) {
                showToast('BRIDGE ESTABLISHED. SELECT INTEL TO TRANSMIT.', 'success');
                fInput.click();
            }
        }
    };
    dc.onclose = () => {
        console.log(`BRIDGE CLOSED`);
        stopHum();
    };

    dc.onmessage = async (e) => {
        if (typeof e.data === 'string') {
            const msg = JSON.parse(e.data);
            if (msg.type === 'file-header') {
                handleIncomingFileRequest(msg, peerId);
            } else if (msg.type === 'transfer-accepted') {
                startSendingFile(peerId);
            } else if (msg.type === 'transfer-rejected') {
                showToast('TRANSFER ABORTED BY REMOTE NODE', 'error');
            } else if (msg.type === 'file-complete') {
                finishReceivingFile();
            }
        } else {
            // Binary chunk received (Encrypted)
            const decrypted = await decryptData(new Uint8Array(e.data), encryptionKey);
            receiveChunk(decrypted);
        }
    };
}

async function computeHash(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentTransferTarget) return;

    const peer = peers.get(currentTransferTarget);
    if (!peer.connection || (peer.connection.connectionState !== 'connected' && peer.connection.connectionState !== 'stable')) {
        await startConnection(currentTransferTarget);
        setTimeout(() => sendFileHeader(currentTransferTarget, file), 1500);
    } else {
        sendFileHeader(currentTransferTarget, file);
    }

    fileInput.value = ''; 
});

async function sendFileHeader(peerId, file) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        showToast('BRIDGE NOT ESTABLISHED. RETRYING...', 'error');
        return;
    }

    // Generate Void-Proof Shielding Key
    encryptionKey = await generateKey();
    const keyStr = await exportKey(encryptionKey);
    
    // Compute Integrity Hash (SHA-256)
    const fileBuffer = await file.arrayBuffer();
    const hash = await computeHash(fileBuffer);

    peer.pendingFile = file;

    peer.dataChannel.send(JSON.stringify({
        type: 'file-header',
        name: file.name,
        size: file.size,
        mime: file.type,
        hash: hash, // For Integrity Check
        vpsKey: keyStr // Send the shielding key
    }));

    showToast(`SEARCHING FOR CLEARANCE FROM ${peer.name.toUpperCase()}...`, 'info');
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
            const encrypted = await encryptData(e.target.result, encryptionKey);
            
            dc.send(encrypted);
            offset += e.target.result.byteLength;

            if (offset < file.size) {
                if(dc.bufferedAmount > 1024 * 1024) {
                    setTimeout(() => readSlice(offset), 50);
                } else {
                    readSlice(offset);
                }
            } else {
                dc.send(JSON.stringify({ type: 'file-complete' }));
                showToast('INTEL SECURED. CLOSING THE GATE.', 'success');
                playSuccessSynth();
                stopHum();
                peer.pendingFile = null;
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

        // Import Void-Proof Shielding Key
        encryptionKey = await importKey(msg.vpsKey);

        incomingFile = {
            name: msg.name,
            size: msg.size,
            mime: msg.mime,
            hash: msg.hash, // Integrity Hash
            senderId: senderId
        };
        receivedChunks = [];
        receivedSize = 0;

        const mTitle = getEl('modalTitle');
        const mContent = getEl('modalContent');
        const mActions = getEl('modalActions');
        const mOverlay = getEl('modalOverlay');

        if (mTitle) mTitle.textContent = "THE GATE IS OPEN. ESTABLISHING SECURE TUNNEL.";
        if (mContent) {
            const agentName = sender.agentId ? `AGENT_${sender.agentId.toUpperCase()}` : sender.name;
            mContent.innerHTML = `
                <div class="sender-ident" style="font-size: 0.8rem; color: var(--accent-primary); margin-bottom: 1rem; text-align: center;">
                    [ORIGIN_AGENT: ${agentName}]
                </div>
                <div class="file-info">
                    <i class="ri-folder-shield-2-line"></i>
                    <div class="file-details">
                        <span class="file-name">${msg.name}</span>
                        <span class="file-size">${(msg.size / (1024*1024)).toFixed(2)} MB</span>
                        <span style="color: var(--accent-primary); font-size: 0.7rem; margin-top: 5px;">[VOID-PROOF SHIELDING ACTIVE]</span>
                    </div>
                </div>
                <div class="progress-container hidden" id="receiveProgressContainer">
                    <div class="progress-bar" id="receiveProgressBar"></div>
                    <span class="progress-label" id="progressLabel">ENCRYPTION STRENGTH: 0%</span>
                </div>
            `;
        }

        if (mActions) {
            mActions.innerHTML = `
                <button class="btn btn-secondary" id="btnReject">ABORT</button>
                <button class="btn btn-primary" id="btnAccept">INITIATE TRANSFER</button>
            `;
        }

        if (mOverlay) mOverlay.classList.remove('hidden');

        const btnReject = getEl('btnReject');
        const btnAccept = getEl('btnAccept');

        if (btnReject) {
            btnReject.onclick = () => {
                sender.dataChannel.send(JSON.stringify({ type: 'transfer-rejected' }));
                if (mOverlay) mOverlay.classList.add('hidden');
                incomingFile = null;
            };
        }

        if (btnAccept) {
            btnAccept.onclick = () => {
                const rejectBtn = getEl('btnReject');
                const acceptBtn = getEl('btnAccept');
                if (rejectBtn) rejectBtn.style.display = 'none';
                if (acceptBtn) acceptBtn.style.display = 'none';
                const progContainer = getEl('receiveProgressContainer');
                if (progContainer) progContainer.classList.remove('hidden');
                startHum();
                sender.dataChannel.send(JSON.stringify({ type: 'transfer-accepted' }));
            };
        }
    } catch (err) {
        console.error('TRANSFER_INIT_FAILED:', err);
        showToast('SIGNAL_BREACH: FAILED TO OPEN TUNNEL', 'error');
    }
}

function receiveChunk(data) {
    if (!incomingFile) return;
    receivedChunks.push(data);
    receivedSize += data.byteLength;

    const progress = Math.min(100, (receivedSize / incomingFile.size) * 100);
    const bar = document.getElementById('receiveProgressBar');
    const label = document.getElementById('progressLabel');
    if (bar) bar.style.width = `${progress}%`;
    if (label) label.textContent = `SIGNAL STABILITY: ${progress.toFixed(0)}%`;
}

function finishReceivingFile() {
    if (!incomingFile) return;
    stopHum();
    
    const blob = new Blob(receivedChunks, { type: incomingFile.mime });
    
    // Perform Void-Integrity Check
    blob.arrayBuffer().then(async (buffer) => {
        const receivedHash = await computeHash(buffer);
        
        if (receivedHash === incomingFile.hash) {
            playSuccessSynth();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = incomingFile.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast(`INTEL SECURED. INTEGRITY VERIFIED.`, 'success');
        } else {
            showToast(`VOID CORRUPTION DETECTED. ABORTING.`, 'error');
        }
        
        modalOverlay.classList.add('hidden');
        incomingFile = null;
        receivedChunks = [];
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
        const file = e.target.files[0];
        if (!file) return;
        shareFileInput.value = '';

        if (modalTitle) modalTitle.textContent = 'ESTABLISHING SECURE BRIDGE...';
        if (modalContent) {
            modalContent.innerHTML = `
                <div class="file-info">
                    <i class="ri-upload-cloud-2-line"></i>
                    <div class="file-details">
                        <span class="file-name">${file.name}</span>
                        <span class="file-size">${(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                    </div>
                </div>
                <div class="progress-container" id="uploadProgressContainer">
                    <div class="progress-bar" id="uploadProgressBar"></div>
                </div>
                <p class="upload-status" id="uploadStatus">TUNNELING DATA...</p>
            `;
        }
        if (modalActions) modalActions.innerHTML = '';
        if (modalOverlay) modalOverlay.classList.remove('hidden');
        startHum();

        try {
            const formData = new FormData();
            formData.append('file', file);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_URL}/upload`);

            xhr.upload.onprogress = (evt) => {
                if (evt.lengthComputable) {
                    const pct = (evt.loaded / evt.total) * 100;
                    const bar = getEl('uploadProgressBar');
                    if (bar) bar.style.width = `${pct}%`;
                }
            };

            xhr.onload = () => {
                stopHum();
                if (xhr.status >= 200 && xhr.status < 300) {
                    const data = JSON.parse(xhr.responseText);
                    showShareLinkResult(data);
                    playSuccessSynth();
                } else {
                    showToast('BRIDGE COLLAPSED. SIGNAL INTERFERENCE.', 'error');
                    if (modalOverlay) modalOverlay.classList.add('hidden');
                }
            };

            xhr.onerror = () => {
                stopHum();
                showToast('BRIDGE COLLAPSED.', 'error');
                if (modalOverlay) modalOverlay.classList.add('hidden');
            };

            xhr.send(formData);
        } catch (err) {
            stopHum();
            showToast('BRIDGE COLLAPSED.', 'error');
            if (modalOverlay) modalOverlay.classList.add('hidden');
        }
    });
}

function showShareLinkResult(data) {
    if (modalTitle) modalTitle.textContent = 'SECURE BRIDGE ESTABLISHED';
    if (modalContent) {
        modalContent.innerHTML = `
            <div class="file-info">
                <i class="ri-check-double-line"></i>
                <div class="file-details">
                    <span class="file-name">${data.name}</span>
                    <span class="file-size">${(data.size / (1024 * 1024)).toFixed(2)} MB</span>
                </div>
            </div>
            <div class="share-link-box">
                <input type="text" id="shareLinkInput" value="${data.url}" readonly />
                <button class="btn-copy" id="copyLinkBtn" title="Copy link">
                    <i class="ri-file-copy-line"></i>
                </button>
            </div>
            <p class="share-link-note">ACCESS EXPIRES IN ${data.expiresIn.toUpperCase()}</p>
        `;
    }
    if (modalActions) {
        modalActions.innerHTML = `
            <button class="btn btn-primary" id="btnCloseShare">DONE</button>
        `;
    }

    const btnClose = getEl('btnCloseShare');
    if (btnClose) {
        btnClose.onclick = () => {
            if (modalOverlay) modalOverlay.classList.add('hidden');
        };
    }

    const btnCopy = getEl('copyLinkBtn');
    if (btnCopy) {
        btnCopy.onclick = () => {
            const input = getEl('shareLinkInput');
            if (input) {
                navigator.clipboard.writeText(input.value).then(() => {
                    showToast('ACCESS TOKEN COPIED TO CLIPBOARD', 'success');
                });
            }
        };
    }
}

// Start
// connectSignaling(); // This is now called by initApp() after login.
