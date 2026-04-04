import Srf from 'drachtio-srf';
import WebSocket from 'ws';
import dgram from 'dgram';
import os from 'os';

const srf = new Srf();

// Configuración desde .env o valores por defecto
const DRACHTIO_HOST = process.env.DRACHTIO_HOST || 'localhost';
const DRACHTIO_PORT = parseInt(process.env.DRACHTIO_PORT || '9022');
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';
const BRIDGE_WS_URL = process.env.BRIDGE_WS_URL || 'ws://localhost:3001/sip-bridge';

// Puertos para RTP local (UDP)
const RTP_PORT_START = 10000;
const RTP_PORT_END = 10019;
let nextRtpPort = RTP_PORT_START;

function getNextRtpPort() {
    const port = nextRtpPort;
    nextRtpPort += 2;
    if (nextRtpPort > RTP_PORT_END) nextRtpPort = RTP_PORT_START;
    return port;
}

function getLocalIp(): string {
    if (process.env.SIP_EXTERNAL_IP) return process.env.SIP_EXTERNAL_IP;
    
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            // Skip loopback and non-ipv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * Helper: sets up the RTP+WebSocket bridge for a call dialog.
 * Used by both inbound (UAS) and outbound (UAC) calls.
 */
function bridgeCallToGemini(
    dialog: any,
    rtpSocket: ReturnType<typeof dgram.createSocket>,
    ws: WebSocket,
    rtpPort: number,
    remoteInfo: { address: string; port: number } | null,
    label: string
) {
    let sequenceNumber = Math.floor(Math.random() * 65535);
    let timestamp = Math.floor(Math.random() * 4294967295);
    const ssrc = Math.floor(Math.random() * 4294967295);
    let audioBufferQueue: Buffer[] = [];
    let playbackInterval: NodeJS.Timeout | null = null;

    // Receive RTP from remote → forward to Gemini bridge
    let rtpPacketCount = 0;
    rtpSocket.on('message', (msg) => {
        if (msg.length <= 12) return;
        rtpPacketCount++;
        if (rtpPacketCount === 1) {
            console.log(`[${label}] First RTP packet received (${msg.length} bytes) from remote`);
        }
        if (rtpPacketCount % 500 === 0) {
            console.log(`[${label}] RTP packets received: ${rtpPacketCount}`);
        }
        const payload = msg.slice(12);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                event: 'audio',
                audio: payload.toString('base64')
            }));
        }
    });

    // Playback interval: send audio from Gemini → RTP at constant 20ms
    let sentPackets = 0;
    playbackInterval = setInterval(() => {
        const playbackPayload = audioBufferQueue.shift();
        if (playbackPayload) {
            if (!remoteInfo) return;

            // Build RTP header
            const rtpPacket = Buffer.alloc(12 + playbackPayload.length);
            rtpPacket[0] = 0x80; // Version 2
            rtpPacket[1] = 0x00; // Payload type 0 (PCMU)
            rtpPacket.writeUInt16BE(sequenceNumber++, 2);
            rtpPacket.writeUInt32BE(timestamp, 4);
            rtpPacket.writeUInt32BE(ssrc >>> 0, 8); // Use the ssrc defined earlier
            // rtpPacket.writeUInt32BE(0x12345678, 8); // SSRC - original diff had this, but ssrc is already defined

            playbackPayload.copy(rtpPacket, 12);
            rtpSocket.send(rtpPacket, remoteInfo.port, remoteInfo.address, (err) => {
                if (err) console.error(`[${label}] Error sending RTP: ${err.message}`);
            });

            timestamp += 160;
            sentPackets++;

            if (sentPackets % 100 === 0) {
                console.log(`[${label}] RTP packets sent: ${sentPackets}, queue size: ${audioBufferQueue.length}`);
            }
        }
    }, 20);

    // Receive audio from Gemini bridge → queue for RTP playback
    let geminiAudioChunks = 0;
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
                if (message.event === 'audio') {
                    geminiAudioChunks++;
                    if (geminiAudioChunks === 1) {
                        console.log(`[${label}] First audio chunk from Gemini bridge`);
                    }
                    const newAudio = Buffer.from(message.data, 'base64');
                    if (geminiAudioChunks === 1) { // Log for first audio data received
                        console.log(`[${label}] First audio data received from bridge, size: ${newAudio.length} bytes`);
                    }
                    for (let i = 0; i < newAudio.length; i += 160) {
                        audioBufferQueue.push(newAudio.slice(i, i + 160));
                    }
                } else if (message.event === 'clear') {
                    console.log(`[${label}] Clearing audio buffer due to interruption signal`);
                    audioBufferQueue.splice(0, audioBufferQueue.length);
                }
        } catch (e) {
            console.error(`[${label}] Error processing bridge message:`, e);
        }
    });

    // Cleanup on call end
    dialog.on('destroy', () => {
        console.log(`[${label}] Call ended`);
        if (playbackInterval) clearInterval(playbackInterval);
        rtpSocket.close();
        ws.close();
    });

    return { audioBufferQueue, playbackInterval };
}

export function startSipGateway() {
    console.log(`Connecting to drachtio-server at ${DRACHTIO_HOST}:${DRACHTIO_PORT}...`);

    let lastErrorLog = 0;

    try {
        srf.connect({
            host: DRACHTIO_HOST,
            port: DRACHTIO_PORT,
            secret: DRACHTIO_SECRET
        });
    } catch (err) {
        console.error(`Failed to initiate connection to drachtio-server: ${err}`);
        console.log('SIP Gateway will be disabled for now.');
        return;
    }

    srf.on('connect', (err, hostport) => {
        if (err) {
            console.error(`Error connecting to drachtio: ${err}`);
            console.log('SIP Gateway disabled.');
            return;
        }
        console.log(`Connected to drachtio-server at ${hostport}`);
    });

    srf.on('error', (err) => {
        // Log connection errors at most once every 10 seconds
        const now = Date.now();
        if (now - lastErrorLog > 10000) {
            console.log(`[SIP Gateway] Waiting for drachtio-server at ${DRACHTIO_HOST}:${DRACHTIO_PORT}...`);
            lastErrorLog = now;
        }
    });

    // Manejo REGISTER y OPTIONS
    (srf as any).register((req: any, res: any) => res.send(200));
    (srf as any).options((req: any, res: any) => res.send(200));

    // ─── Inbound Calls (UAS) ────────────────────────────────────────────
    srf.invite((req, res) => {
        console.log(`[Inbound] Incoming call from ${req.get('From')}`);

        const rtpPort = getNextRtpPort();
        const rtpSocket = dgram.createSocket('udp4');
        const ws = new WebSocket(BRIDGE_WS_URL);
        const remoteInfo = parseSdp(req.body);

        const localIp = getLocalIp();
        const localSdp = buildSdp(localIp, rtpPort);
        console.log(`[Inbound] Advertising RTP at ${localIp}:${rtpPort}`);

        rtpSocket.bind(rtpPort);

        ws.on('open', () => {
            console.log('[Inbound] Connected to Gemini Bridge WebSocket');

            srf.createUAS(req, res, { localSdp })
                .then((dialog) => {
                    console.log(`[Inbound] Call established. RTP on port ${rtpPort}`);
                    dialog.on('ack', () => console.log('[Inbound] SIP ACK received.'));
                    bridgeCallToGemini(dialog, rtpSocket, ws, rtpPort, remoteInfo, 'Inbound');
                })
                .catch((err) => {
                    console.error(`[Inbound] Error creating UAS: ${err}`);
                    rtpSocket.close();
                    ws.close();
                });
        });

        ws.on('error', (err) => {
            console.error(`[Inbound] Bridge WebSocket error: ${err}`);
            res.send(500);
            rtpSocket.close();
        });
    });
}

// ─── Outbound Calls (UAC) ───────────────────────────────────────────────

/**
 * Initiate an outbound call to a target SIP URI.
 * The call connects to the Gemini bridge once the remote party answers.
 */
export async function makeOutboundCall(targetUri: string): Promise<{ success: boolean; message: string }> {
    const localIp = getLocalIp();
    const rtpPort = getNextRtpPort();
    const rtpSocket = dgram.createSocket('udp4');

    rtpSocket.bind(rtpPort);

    const localSdp = buildSdp(localIp, rtpPort);

    console.log(`[Outbound] Dialing ${targetUri}...`);
    console.log(`[Outbound] Local SDP IP: ${localIp}, RTP port: ${rtpPort}`);

    const sipUser = process.env.SIP_USER;
    const sipPassword = process.env.SIP_PASSWORD;
    const sipProxy = process.env.SIP_OUTBOUND_PROXY || 'sip.zadarma.com';

    console.log(`[Outbound] Using proxy: ${sipProxy}, user: ${sipUser}`);

    try {
        // Detailed logging for authentication
        console.log(`[Outbound] Using credentials - User: ${sipUser}, Proxy: ${sipProxy}`);

        const dialog = await (srf as any).createUAC(targetUri, {
            localSdp,
            proxy: `sip:${sipProxy}`,
            auth: {
                username: sipUser,
                password: sipPassword
            },
            headers: {
                'From': `<sip:${sipUser}@${sipProxy}>`,
                'User-Agent': 'Gemini-SIP-Bridge/1.0'
            }
        });

        console.log(`[Outbound] Call answered by ${targetUri}`);

        const remoteSdp = dialog.remote.sdp;
        console.log(`[Outbound] Remote SDP received:`, remoteSdp?.substring(0, 200));
        const remoteInfo = parseSdp(remoteSdp);
        console.log(`[Outbound] Remote RTP target:`, remoteInfo);

        const ws = new WebSocket(BRIDGE_WS_URL);

        await new Promise<void>((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        console.log('[Outbound] Connected to Gemini Bridge WebSocket');
        bridgeCallToGemini(dialog, rtpSocket, ws, rtpPort, remoteInfo, 'Outbound');

        return { success: true, message: `Call connected to ${targetUri}` };
    } catch (err: any) {
        console.error(`[Outbound] Failed to reach ${targetUri}:`, err?.message || err);
        rtpSocket.close();
        return { success: false, message: `Failed to connect: ${err?.message || 'Unknown error'}` };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function buildSdp(ip: string, port: number): string {
    return `v=0
o=- 123456 123456 IN IP4 ${ip}
s=Gemini SIP Gateway
c=IN IP4 ${ip}
t=0 0
m=audio ${port} RTP/AVP 0
a=rtpmap:0 PCMU/8000
a=sendrecv`;
}

function parseSdp(sdp: string) {
    try {
        const connectionMatch = sdp.match(/c=IN IP4 ([0-9.]+)/);
        const mediaMatch = sdp.match(/m=audio ([0-9]+)/);
        if (connectionMatch && mediaMatch) {
            return {
                address: connectionMatch[1],
                port: parseInt(mediaMatch[1])
            };
        }
    } catch (e) {
        console.error('Error parsing SDP:', e);
    }
    return null;
}
