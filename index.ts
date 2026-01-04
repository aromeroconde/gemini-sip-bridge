import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { setupTwilioBridge } from './lib/twilio-bridge';
import { setupSipBridge } from './lib/sip-bridge';
import { startSipGateway } from './lib/sip-gateway';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Basic health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'gemini-sip-bridge' });
});

// Twilio Voice Webhook
app.post('/api/twilio/voice', (req, res) => {
    const host = req.get('host');
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${host}/twilio-bridge" />
    </Connect>
</Response>`);
});

// Twilio Status Callback
app.post('/api/twilio/status', (req, res) => {
    console.log('Call Status Change:', req.body?.CallStatus || 'unknown');
    res.sendStatus(200);
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/twilio-bridge') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            setupTwilioBridge(ws);
        });
    } else if (pathname === '/sip-bridge') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            setupSipBridge(ws);
        });
    } else {
        socket.destroy();
    }
});

server.listen(port, () => {
    console.log(`Gemini SIP Bridge running on port ${port}`);
    startSipGateway();
});
