import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { setupSipBridge } from './lib/sip-bridge';
import { startSipGateway, makeOutboundCall } from './lib/sip-gateway';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Basic health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'gemini-sip-bridge', version: '2.0.0' });
});

// ─── Outbound Call API ──────────────────────────────────────────────────
app.post('/api/make-call', async (req, res) => {
    const { target } = req.body;

    if (!target) {
        return res.status(400).json({ error: 'Missing "target" field (SIP URI or phone number)' });
    }

    // If target looks like a phone number, wrap it in sip: URI format
    let sipUri = target;
    if (/^\+?\d+$/.test(target)) {
        const sipProxy = process.env.SIP_OUTBOUND_PROXY;
        if (!sipProxy) {
            return res.status(400).json({ error: 'SIP_OUTBOUND_PROXY not configured for phone number dialing' });
        }
        sipUri = `sip:${target}@${sipProxy}`;
    }

    console.log(`[API] Initiating outbound call to: ${sipUri}`);
    const result = await makeOutboundCall(sipUri);
    res.json(result);
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/sip-bridge') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            setupSipBridge(ws);
        });
    } else {
        socket.destroy();
    }
});

server.listen(port, () => {
    // Running version v2.0.2
    console.log(`Gemini SIP Bridge v2.0.2 running on port ${port}`);
    startSipGateway();
});
