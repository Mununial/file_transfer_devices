const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'HAWKINS_SECRET_GATE_KEY';
const USERS_FILE = path.join(__dirname, 'users.json');

const admin = require('firebase-admin');

// IMPORTANT: Download your serviceAccountKey.json from Firebase Console 
// (Project Settings > Service Accounts) and place it in this 'server' folder.
let db;
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('[FIREBASE_READY] CONNECTED TO HAWKINS_VAULT_REMOTE');
} catch (error) {
    console.error('[FIREBASE_ERROR]', error.message);
    console.log('Falling back to local storage (Offline Protocol)...');
}

const usersCol = db ? db.collection('users') : null;

// Simple low-tech user store (Offline First / Fallback)
function loadUsersLocal() {
    if (!fs.existsSync(USERS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveUsersLocal(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint for Koyeb/Render/Railway
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- AUTHENTICATION ---

app.post('/api/signup', async (req, res) => {
    const { username, password, fullName } = req.body;
    if (!username || !password || !fullName) {
        return res.status(400).json({ error: 'Incomplete credentials.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { username, password: hashedPassword, fullName, createdAt: new Date() };

    if (usersCol) {
        try {
            const userDoc = await usersCol.doc(username).get();
            if (userDoc.exists) {
                return res.status(400).json({ error: 'Agent ID already deployed.' });
            }
            await usersCol.doc(username).set(newUser);
        } catch (e) {
            return res.status(500).json({ error: 'Firebase synchronization failed.' });
        }
    } else {
        // Fallback
        const users = loadUsersLocal();
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Agent ID already deployed.' });
        }
        users.push(newUser);
        saveUsersLocal(users);
    }

    const token = jwt.sign({ username: newUser.username, fullName: newUser.fullName }, JWT_SECRET);
    res.json({ token, agentId: username, fullName });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    let user;

    if (usersCol) {
        try {
            const userDoc = await usersCol.doc(username).get();
            if (userDoc.exists) user = userDoc.data();
        } catch (e) {
            return res.status(500).json({ error: 'Firebase connection lost.' });
        }
    } else {
        const users = loadUsersLocal();
        user = users.find(u => u.username === username);
    }

    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid clearance level.' });
    }

    const token = jwt.sign({ username: user.username, fullName: user.fullName }, JWT_SECRET);
    res.json({ token, agentId: username, fullName: user.fullName });
});

// --- STATIC FILES ---
app.use(express.static(path.join(__dirname, '..', 'client')));

// ---------------------------
// File Upload & Shareable Links
// ---------------------------

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FILE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory metadata store: id -> { originalName, mimeType, filePath, expiresAt }
const uploadedFiles = new Map();

// Multer config: store in uploads/ with unique filenames
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE }
});

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
    }

    const fileId = uuidv4();
    const expiresAt = Date.now() + FILE_EXPIRY_MS;

    uploadedFiles.set(fileId, {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        filePath: req.file.path,
        size: req.file.size,
        expiresAt
    });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const downloadUrl = `${protocol}://${host}/download/${fileId}`;

    res.json({
        id: fileId,
        url: downloadUrl,
        name: req.file.originalname,
        size: req.file.size,
        expiresIn: '24 hours'
    });
});

// Download endpoint
app.get('/download/:id', (req, res) => {
    const fileId = req.params.id;
    const meta = uploadedFiles.get(fileId);

    if (!meta) {
        return res.status(404).send('File not found or has expired.');
    }

    if (Date.now() > meta.expiresAt) {
        // Clean up expired file
        fs.unlink(meta.filePath, () => {});
        uploadedFiles.delete(fileId);
        return res.status(410).send('File has expired.');
    }

    if (!fs.existsSync(meta.filePath)) {
        uploadedFiles.delete(fileId);
        return res.status(404).send('File not found.');
    }

    res.download(meta.filePath, meta.originalName);
});

// Periodic cleanup of expired files (every 30 minutes)
setInterval(() => {
    const now = Date.now();
    uploadedFiles.forEach((meta, id) => {
        if (now > meta.expiresAt) {
            fs.unlink(meta.filePath, () => {});
            uploadedFiles.delete(id);
        }
    });
}, 30 * 60 * 1000);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map to store connected clients
// Key: WebSocket instance
// Value: { id, name, ip, socket }
const clients = new Map();

// Helper functions for names
const ADJECTIVES = ['Classified', 'Radiant', 'Psychic', 'Subdimensional', 'Quantum', 'Forbidden', 'Experimental', 'Void', 'Psionic', 'Omega'];
const ANIMALS = ['Specimen', 'Node', 'Entity', 'Ghost', 'Sentinel', 'Relay', 'Echo', 'Drift', 'Pulse', 'Vector'];

function generateName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    return `LAB_${adj.toUpperCase()}_${animal.toUpperCase()}`;
}

// Extract IP, handling proxies
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress;
}

// Get all clients with the same IP (same network)
function getPeers(ip, excludeId) {
    const peers = [];
    clients.forEach((client) => {
        if (client.ip === ip && client.id !== excludeId) {
            peers.push({
                id: client.id,
                name: client.name,
                agentId: client.agentId || null
            });
        }
    });
    return peers;
}

// Passcode system for cross-network (Laptop-Laptop) pairing
const passcodes = new Map(); // code -> { senderId, expiresAt }

function cleanupPasscodes() {
    const now = Date.now();
    passcodes.forEach((data, code) => {
        if (now > data.expiresAt) passcodes.delete(code);
    });
}
setInterval(cleanupPasscodes, 60000);

// Send a message to a specific client
function sendToClient(targetId, message) {
    clients.forEach((client) => {
        if (client.id === targetId && client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify(message));
        }
    });
}

// Broadcast a message to all users on the same network (excluding sender)
function broadcastToNetwork(ip, excludeId, message) {
    clients.forEach((client) => {
        if (client.ip === ip && client.id !== excludeId && client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', (ws, req) => {
    const id = uuidv4();
    const name = generateName();
    const ip = getClientIp(req);

// Register client
    clients.set(ws, { id, name, ip, socket: ws, lastSeen: Date.now() });

    console.log(`[SECURE_NODE_CONN] NODE_ID: ${id.substring(0,8)} | ALIAS: ${name} | FIELD_IP: ${ip}`);

    // Send the client their own info and the list of current peers on their network
    ws.send(JSON.stringify({
        type: 'init',
        id: id,
        name: name,
        peers: getPeers(ip, id)
    }));

    // Notify other peers on the network that a new device joined
    broadcastToNetwork(ip, id, {
        type: 'peer-joined',
        peer: { id, name }
    });

    ws.on('message', (messageAsString) => {
        let message;
        try {
            const client = clients.get(ws);
            if (client) client.lastSeen = Date.now();
            message = JSON.parse(messageAsString);
        } catch (e) {
            console.error('PROTOCOL_ERR: INVALID_PACKET', e);
            return;
        }

        if (message.type === 'pong') return;

        const sender = clients.get(ws);
        if (!sender) return;

        // Routing WebRTC signaling messages
        switch (message.type) {
            case 'register-agent':
                sender.agentId = message.agentId;
                // Notify others that this peer now has an identity
                broadcastToNetwork(sender.ip, sender.id, {
                    type: 'peer-updated',
                    peer: { id: sender.id, name: sender.name, agentId: sender.agentId }
                });
                break;
            case 'discover':
                // Client is looking for a specific node (from QR)
                if (message.targetId) {
                    const targetNode = Array.from(clients.values()).find(c => c.id === message.targetId);
                    if (targetNode) {
                        // Notify both about each other regardless of IP
                        ws.send(JSON.stringify({
                            type: 'peer-joined',
                            peer: { id: targetNode.id, name: targetNode.name, agentId: targetNode.agentId }
                        }));
                        targetNode.socket.send(JSON.stringify({
                            type: 'peer-joined',
                            peer: { id: sender.id, name: sender.name, agentId: sender.agentId }
                        }));
                    }
                }
                break;
            case 'offer':
            case 'answer':
            case 'candidate':
                // The client should provide the target peer's ID
                if (message.target) {
                    sendToClient(message.target, {
                        ...message,
                        sender: sender.id
                    });
                }
                break;
            case 'create-passcode':
                const code = Math.floor(100000 + Math.random() * 900000).toString();
                passcodes.set(code, { 
                    senderId: sender.id, 
                    name: sender.name, 
                    agentId: sender.agentId,
                    expiresAt: Date.now() + 120000 // 2 min expiry
                });
                ws.send(JSON.stringify({ type: 'passcode-ready', code }));
                break;
            case 'use-passcode':
                const entry = passcodes.get(message.code);
                if (entry && entry.senderId !== sender.id) {
                    const targetNode = Array.from(clients.values()).find(c => c.id === entry.senderId);
                    if (targetNode) {
                        // Link them both ways
                        ws.send(JSON.stringify({
                            type: 'peer-joined',
                            peer: { id: targetNode.id, name: targetNode.name, agentId: targetNode.agentId }
                        }));
                        targetNode.socket.send(JSON.stringify({
                            type: 'peer-joined',
                            peer: { id: sender.id, name: sender.name, agentId: sender.agentId }
                        }));
                        passcodes.delete(message.code);
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'TARGET_OFFLINE' }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'INVALID_CODE' }));
                }
                break;
            default:
                console.log('SIGNAL_UNKNOWN:', message.type);
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        if (client) {
            console.log(`[SECURE_NODE_DISCONN] NODE_ID: ${client.id.substring(0,8)} | ALIAS: ${client.name}`);
            clients.delete(ws);

            // Notify others on the network
            broadcastToNetwork(client.ip, client.id, {
                type: 'peer-left',
                peerId: client.id
            });
        }
    });
});

// Heartbeat cleanup for ghost nodes
setInterval(() => {
    const now = Date.now();
    clients.forEach((client, ws) => {
        if (now - client.lastSeen > 35000) {
            console.log(`[TIMEOUT_KICK] Node ${client.id.substring(0,8)} timed out.`);
            ws.terminate();
        } else {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
            }
        }
    });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[GATEKEEPER_READY] HAWKINS_SIGNAL_SERVER ACTIVE ON PORT ${PORT}`);
});
