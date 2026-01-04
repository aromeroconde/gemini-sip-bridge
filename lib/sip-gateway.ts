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

export function startSipGateway() {
    console.log(`Connecting to drachtio-server at ${DRACHTIO_HOST}:${DRACHTIO_PORT}...`);

    srf.connect({
        host: DRACHTIO_HOST,
        port: DRACHTIO_PORT,
        secret: DRACHTIO_SECRET
    });

    srf.on('connect', (err, hostport) => {
        if (err) return console.error(`Error connecting to drachtio: ${err}`);
        console.log(`Connected to drachtio-server at ${hostport}`);
    });

    // Manejo REGISTER y OPTIONS
    (srf as any).register((req: any, res: any) => res.send(200));
    (srf as any).options((req: any, res: any) => res.send(200));

    srf.invite((req, res) => {
        console.log(`Incoming call from ${req.get('From')}`);

        const rtpPort = getNextRtpPort();
        const rtpSocket = dgram.createSocket('udp4');
        const ws = new WebSocket(BRIDGE_WS_URL);

        const remoteInfo = parseSdp(req.body);

        const localIp = process.env.SIP_EXTERNAL_IP || '127.0.0.1';
        const localSdp = `v=0
o=- 123456 123456 IN IP4 ${localIp}
s=Gemini SIP Gateway
c=IN IP4 ${localIp}
t=0 0
m=audio ${rtpPort} RTP/AVP 0
a=rtpmap:0 PCMU/8000
a=sendrecv`;

        // Estado RTP
        let sequenceNumber = Math.floor(Math.random() * 65535);
        let timestamp = Math.floor(Math.random() * 4294967295);
        const ssrc = Math.floor(Math.random() * 4294967295);

        // Buffer para suavizar el audio de Gemini (Jitter Buffer simple de salida)
        let audioBufferQueue: Buffer[] = [];
        let playbackInterval: NodeJS.Timeout | null = null;

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

        rtpSocket.bind(rtpPort);

        ws.on('open', () => {
            console.log('Connected to Gemini Bridge WebSocket');

            srf.createUAS(req, res, { localSdp: localSdp })
                .then((dialog) => {
                    console.log(`Call established. Listening RTP on port ${rtpPort}`);

                    dialog.on('ack', () => {
                        console.log('SIP ACK received - signaling confirmed.');
                    });

                    // Empezamos un intervalo constante de 20ms para enviar audio (pacing)
                    // Esto es CRUCIAL para evitar que el audio se escuche entrecortado
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
                            timestamp += 160; // 160 samples per 20ms
                        }
                    }, 20);

                    ws.on('message', (data) => {
                        try {
                            const message = JSON.parse(data.toString());
                            if (message.event === 'audio') {
                                const newAudio = Buffer.from(message.data, 'base64');

                                // Dividimos el audio de Gemini en trozos de 160 bytes (20ms)
                                // El bridge envía chunks de tamaño variable, pero SIP requiere 20ms estrictos
                                for (let i = 0; i < newAudio.length; i += 160) {
                                    audioBufferQueue.push(newAudio.slice(i, i + 160));
                                }
                            }
                        } catch (e) {
                            console.error('Error processing bridge message:', e);
                        }
                    });

                    dialog.on('destroy', () => {
                        console.log('Call ended');
                        if (playbackInterval) clearInterval(playbackInterval);
                        rtpSocket.close();
                        ws.close();
                    });
                })
                .catch((err) => {
                    console.error(`Error creating UAS: ${err}`);
                    if (playbackInterval) clearInterval(playbackInterval);
                    rtpSocket.close();
                    ws.close();
                });
        });

        ws.on('error', (err) => {
            console.error(`Bridge WebSocket error: ${err}`);
            res.send(500);
            if (playbackInterval) clearInterval(playbackInterval);
            rtpSocket.close();
        });
    });
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
