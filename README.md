# GATEKEEPER PROTOCOL: HAWKINS NATIONAL LABORATORY SECURE NODE

**CLASSIFIED // LEVEL 4 ACCESS REQUIRED**

This is a high-security, peer-to-peer data transfer node designed for the secure transmission of sensitive intel between proximity agents. It bypasses all public cloud infrastructure, utilizing direct WebRTC tunnels protected by "Void-Proof Shielding" (AES-GCM encryption).

## Mission Parameters
- **Aesthetic**: CRT-emulated terminal interface with a grainy texture and subtle flicker.
- **Spectrum**: Warning Red (#FF3131) and Terminal Green (#39FF14).
- **Discovery**: Pulsing radar-style detection of proximity signals.
- **Shielding**: 256-bit AES-GCM encryption (Void-Proof Shielding).
- **Feedback**: Atmospheric gate hum during active bridging and synth-confirmation chimes.

## Technical Foundation
- **Architecture**: WebRTC Data Channels (Native browser-to-browser).
- **Offline First**: Operates seamlessly over local laboratory networks (LAN/Wi-Fi).
- **Crypto**: Web Crypto API for end-to-end data encryption.

## Deployment Instructions

### 1. Initializing the Module (Local)
Ensure you have Node.js version 14+ installed on your terminal.

```bash
cd server
npm install
npm start
```
The node will be active at `http://localhost:3000`.

### 2. Bridging the Gap (Production)
To deploy this module to a public sector (e.g., Render, Railway):
1. Push the code to your GitHub Repository.
2. Link the repository to your hosting provider.
3. Use the following build command: `cd server && npm install`
4. Use the following start command: `node server/index.js`
5. Ensure the environment variable `EXTERNAL_URL` is set to your deployed address.

---
**HAWKINS NATIONAL LABORATORY // DEPT OF ENERGY [ESTABLISHED 1983]**
**INTEL SECURED. CLOSING THE GATE.**
