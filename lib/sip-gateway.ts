import Srf from 'drachtio-srf';
import WebSocket from 'ws';
import dgram from 'dgram';

const srf = new Srf();

// Configuración desde .env o valores por defecto
const DRACHTIO_HOST = process.env.DRACHTIO_HOST || 'localhost';
const DRACHTIO_PORT = parseInt(process.env.DRACHTIO_PORT || '9022');
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';
const BRIDGE_WS_URL = process.env.BRIDGE_WS_URL || 'ws://localhost:3001/sip-bridge';

// Puertos para RTP local (UDP)
const RTP_PORT_START = 10000;
let nextRtpPort = RTP_PORT_START;

function getNextRtpPort() {
    const port = nextRtpPort;
    nextRtpPort += 2;
    if (nextRtpPort > 11000) nextRtpPort = RTP_PORT_START;
    return port;
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
    rtpSocket.on('message', (msg) => {
        if (msg.length <= 12) return;
        const payload = msg.slice(12);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                event: 'audio',
                audio: payload.toString('base64')
            }));
        }
    });

    // Playback interval: send audio from Gemini → RTP at constant 20ms
    playbackInterval = setInterval(() => {
        if (audioBufferQueue.length > 0 && remoteInfo) {
            const chunk = audioBufferQueue.shift()!;
            const rtpPacket = Buffer.alloc(12 + chunk.length);
            rtpPacket[0] = 0x80;
            rtpPacket[1] = 0x00;
            rtpPacket.writeUInt16BE(sequenceNumber & 0xFFFF, 2);
            rtpPacket.writeUInt32BE(timestamp >>> 0, 4);
            rtpPacket.writeUInt32BE(ssrc >>> 0, 8);
            chunk.copy(rtpPacket, 12);
            rtpSocket.send(rtpPacket, remoteInfo.port, remoteInfo.address);
            sequenceNumber++;
            timestamp += 160;
        }
    }, 20);

    // Receive audio from Gemini bridge → queue for RTP playback
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.event === 'audio') {
                const newAudio = Buffer.from(message.data, 'base64');
                for (let i = 0; i < newAudio.length; i += 160) {
                    audioBufferQueue.push(newAudio.slice(i, i + 160));
                }
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
        console.error(`Drachtio connection error: ${err}`);
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

        const localIp = process.env.SIP_EXTERNAL_IP || '127.0.0.1';
        const localSdp = buildSdp(localIp, rtpPort);

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
    const localIp = process.env.SIP_EXTERNAL_IP || '127.0.0.1';
    const rtpPort = getNextRtpPort();
    const rtpSocket = dgram.createSocket('udp4');

    rtpSocket.bind(rtpPort);

    const localSdp = buildSdp(localIp, rtpPort);

    console.log(`[Outbound] Dialing ${targetUri}...`);

    try {
        const dialog = await (srf as any).createUAC(targetUri, {
            localSdp,
            headers: {
                'From': `<sip:gemini@${localIp}>`,
                'User-Agent': 'Gemini-SIP-Bridge/1.0'
            }
        });

        console.log(`[Outbound] Call answered by ${targetUri}`);

        const remoteSdp = dialog.remote.sdp;
        const remoteInfo = parseSdp(remoteSdp);

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
