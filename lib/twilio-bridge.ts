import { WebSocket } from 'ws';
import { muLawToPcm, resample8To16, pcmToMuLaw, resample24To8 } from './audio-utils';

export function setupTwilioBridge(ws: WebSocket) {
    let geminiWs: WebSocket | null = null;
    let streamSid: string | null = null;
    let isSetupComplete = false;
    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
        console.error('GOOGLE_API_KEY is not set');
        ws.close(1011, 'Server configuration error');
        return;
    }

    const host = 'generativelanguage.googleapis.com';
    const url = `wss://${host}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    const connectToGemini = () => {
        console.log('Connecting to Gemini Multimodal Live API (v2.5)...');
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Connected to Gemini Live API');
            
            const setupMessage = {
                setup: {
                    model: process.env.GEMINI_MODEL || "models/gemini-2.0-flash-exp",
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: process.env.VOICE_NAME || "Puck"
                                }
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{
                            text: process.env.VOICE_PROMPT || "Eres QuantumIA, el consultor de IA de élite. Responde de forma profesional, amable y concisa. Habla siempre en español de Colombia."
                        }]
                    }
                }
            };
            geminiWs?.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data.toString());
                
                if (response.setupComplete) {
                    console.log('Gemini Setup Complete (v2.5).');
                    isSetupComplete = true;
                    const initialTurn = {
                        clientContent: {
                            turns: [{
                                role: "user",
                                parts: [{ text: "Hola" }]
                            }],
                            turnComplete: true
                        }
                    };
                    geminiWs?.send(JSON.stringify(initialTurn));
                    return;
                }

                if (response.serverContent) {
                    const parts = response.serverContent.modelTurn?.parts || response.serverContent.modelDraft?.parts;
                    if (parts) {
                        for (const part of parts) {
                            if (part.inlineData && part.inlineData.mimeType.includes('audio')) {
                                const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                                const resampled = resample24To8(audioBuffer);
                                const mulaw = pcmToMuLaw(resampled);
                                
                                if (ws.readyState === WebSocket.OPEN && streamSid) {
                                    ws.send(JSON.stringify({
                                        event: 'media',
                                        streamSid: streamSid,
                                        media: { payload: mulaw.toString('base64') }
                                    }));
                                }
                            }
                        }
                    }
                }

                if (response.error) {
                    console.error('Gemini API Error:', JSON.stringify(response.error));
                }

            } catch (err) {
                console.error('Error parsing Gemini message:', err);
            }
        });

        geminiWs.on('error', (err) => {
            console.error('Gemini WebSocket error:', err);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`Gemini connection closed: ${code} ${reason}`);
            isSetupComplete = false;
        });
    };

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log(`Twilio Stream started: ${streamSid}`);
                    connectToGemini();
                    break;

                case 'media':
                    if (geminiWs && geminiWs.readyState === WebSocket.OPEN && isSetupComplete) {
                        const payload = Buffer.from(data.media.payload, 'base64');
                        const pcm = muLawToPcm(payload);
                        const resampled = resample8To16(pcm);
                        
                        const inputMessage = {
                            realtime_input: {
                                media_chunks: [{
                                    mime_type: "audio/pcm;rate=16000",
                                    data: resampled.toString('base64')
                                }]
                            }
                        };
                        geminiWs.send(JSON.stringify(inputMessage));
                    }
                    break;

                case 'stop':
                    console.log(`Twilio Stream stopped: ${streamSid}`);
                    if (geminiWs) geminiWs.close();
                    break;
            }
        } catch (err) {
            console.error('Error processing Twilio message:', err);
        }
    });

    ws.on('close', () => {
        console.log('Twilio WebSocket connection closed');
        if (geminiWs) geminiWs.close();
    });
}
