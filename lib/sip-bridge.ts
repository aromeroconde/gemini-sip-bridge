import { GoogleGenAI, Modality, Session, LiveServerMessage, LiveServerToolCall } from '@google/genai';
import { muLawToPcm, resample8To16, pcmToMuLaw, resample24To8 } from './audio-utils';
import { getToolDeclarations, executeTool } from './tool-manager';
import { analyzeCall, ConversationEntry } from './analysis-service';
import { WebSocket } from 'ws';
import crypto from 'crypto';

export function setupSipBridge(ws: WebSocket) {
    const apiKey = process.env.GOOGLE_API_KEY;

    if (!apiKey) {
        console.error('GOOGLE_API_KEY is not set');
        ws.close(1011, 'Server configuration error');
        return;
    }

    // ─── Per-call state ─────────────────────────────────────────────────
    const callId = crypto.randomUUID();
    const callStartTime = Date.now();
    const conversationLog: ConversationEntry[] = [];
    const toolsUsed: string[] = [];

    const ai = new GoogleGenAI({ apiKey });
    let session: Session | null = null;

    // ─── Tool Call Handler ───────────────────────────────────────────────

    async function handleToolCall(toolCall: LiveServerToolCall) {
        const functionCalls = toolCall.functionCalls || [];

        for (const fc of functionCalls) {
            console.log(`[Call ${callId}] Tool call: ${fc.name}`, JSON.stringify(fc.args));
            toolsUsed.push(fc.name!);

            const result = await executeTool(fc.name!, fc.args || {}, callId);

            session?.sendToolResponse({
                functionResponses: [{
                    id: fc.id,
                    name: fc.name,
                    response: result
                }]
            });
            console.log(`[Call ${callId}] Tool response sent: ${fc.name}`);
        }
    }

    // ─── Post-Call Analysis ──────────────────────────────────────────────

    async function runPostCallAnalysis() {
        const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
        console.log(`[Call ${callId}] Call ended. Duration: ${durationSeconds}s. Messages: ${conversationLog.length}. Tools: ${toolsUsed.length}`);

        if (conversationLog.length > 0) {
            try {
                await analyzeCall(callId, conversationLog, toolsUsed, durationSeconds);
            } catch (err) {
                console.error(`[Call ${callId}] Post-call analysis failed:`, err);
            }
        }
    }

    // ─── Connect to Gemini Live API ──────────────────────────────────

    const MODEL_ID = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
    // Buffer audio packets that arrive before the Gemini session is ready
    const preSessionAudioBuffer: string[] = [];

    console.log(`[Call ${callId}] Connecting to Gemini Live API with model: ${MODEL_ID}`);

    ai.live.connect({
        model: MODEL_ID,
        config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: process.env.VOICE_NAME || 'Zephyr'
                    }
                }
            },
            systemInstruction: {
                parts: [{ text: process.env.VOICE_PROMPT || 'Eres QuantumIA, el consultor de IA de élite. Responde de forma profesional, amable y concisa. Habla siempre en español de Colombia.' }]
            },
            tools: getToolDeclarations(),
        },
        callbacks: {
            onopen: () => {
                console.log(`[Call ${callId}] Connected to Gemini Live API`);
            },
            onmessage: (message: LiveServerMessage) => {
                try {
                    // Debug: log message types received
                    const msgTypes: string[] = [];
                    if (message.setupComplete) msgTypes.push('setupComplete');
                    if (message.serverContent) msgTypes.push('serverContent');
                    if (message.toolCall) msgTypes.push('toolCall');
                    if (message.toolCallCancellation) msgTypes.push('toolCallCancellation');
                    if (msgTypes.length > 0) {
                        console.log(`[Call ${callId}] Gemini message: ${msgTypes.join(', ')}`);
                    }
                    // ─── Setup Complete ────────────────────────────────
                    if (message.setupComplete) {
                        console.log(`[Call ${callId}] Gemini Setup Complete. Buffered audio packets: ${preSessionAudioBuffer.length}`);
                        return;
                    }

                    // ─── Handle Interruption ───────────────────────────
                    if (message.serverContent?.interrupted) {
                        console.log(`[Call ${callId}] Gemini detected interruption. Clearing SIP Gateway buffers.`);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ event: 'clear' }));
                        }
                        return;
                    }

                    // ─── Handle Tool Calls ─────────────────────────────
                    if (message.toolCall && message.toolCall.functionCalls?.length) {
                        handleToolCall(message.toolCall);
                        return;
                    }

                    // ─── Handle Audio + Text ───────────────────────────
                    if (message.serverContent) {
                        const content = message.serverContent;

                        // Log transcriptions
                        if (content.inputTranscription?.text) {
                            conversationLog.push({
                                role: 'user',
                                text: content.inputTranscription.text,
                                timestamp: Date.now()
                            });
                        }

                        if (content.modelTurn?.parts) {
                            for (const part of content.modelTurn.parts) {
                                // Audio: transcode and send to SIP
                                if (part.inlineData && part.inlineData.mimeType?.includes('audio')) {
                                    const audioBuffer = Buffer.from(part.inlineData.data!, 'base64');
                                    if (conversationLog.length <= 1) {
                                        console.log(`[Call ${callId}] Gemini sent audio chunk: ${audioBuffer.length} bytes`);
                                    }
                                    const resampled = resample24To8(audioBuffer);
                                    const mulaw = pcmToMuLaw(resampled);

                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            event: 'audio',
                                            data: mulaw.toString('base64')
                                        }));
                                    }
                                }

                                // Text: log to conversation
                                if (part.text) {
                                    conversationLog.push({
                                        role: 'model',
                                        text: part.text,
                                        timestamp: Date.now()
                                    });
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[Call ${callId}] Error processing Gemini message:`, err);
                }
            },
            onerror: (e) => {
                console.error(`[Call ${callId}] Gemini session error:`, JSON.stringify(e));
                if (e.error) console.error(`[Call ${callId}] Error detail:`, JSON.stringify(e.error));
            },
            onclose: (e) => {
                console.log(`[Call ${callId}] Gemini session closed: code=${e.code} reason=${e.reason} wasClean=${e.wasClean}`);
                session = null;
            }
        }
    }).then((s) => {
        session = s;
        // Flush any audio that arrived before the session was ready
        if (preSessionAudioBuffer.length > 0) {
            console.log(`[Call ${callId}] Flushing ${preSessionAudioBuffer.length} buffered audio packets to Gemini`);
            for (const base64Audio of preSessionAudioBuffer) {
                const payload = Buffer.from(base64Audio, 'base64');
                const pcm = muLawToPcm(payload);
                const resampled = resample8To16(pcm);
                session.sendRealtimeInput({
                    audio: {
                        mimeType: 'audio/pcm;rate=16000',
                        data: resampled.toString('base64')
                    }
                });
            }
            preSessionAudioBuffer.length = 0;
        }
    }).catch((err) => {
        console.error(`[Call ${callId}] Failed to connect to Gemini:`, err);
        ws.close(1011, 'Failed to connect to Gemini');
    });

    // ─── Receive audio from SIP Gateway → Gemini ────────────────────────

    let sipAudioPackets = 0;
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            if ((data.event === 'audio' || data.event === 'media')) {
                const audioPayload = data.audio || (data.media ? data.media.payload : null);

                if (audioPayload) {
                    sipAudioPackets++;
                    if (sipAudioPackets === 1) {
                        console.log(`[Call ${callId}] First audio packet received from SIP Gateway`);
                    }

                    if (!session) {
                        // Buffer audio until session is ready
                        preSessionAudioBuffer.push(audioPayload);
                        return;
                    }

                    const payload = Buffer.from(audioPayload, 'base64');
                    const pcm = muLawToPcm(payload);
                    const resampled = resample8To16(pcm);

                    session.sendRealtimeInput({
                        audio: {
                            mimeType: 'audio/pcm;rate=16000',
                            data: resampled.toString('base64')
                        }
                    });
                }
            } else if (data.event && data.event !== 'audio' && data.event !== 'media') {
                console.log(`[Call ${callId}] Unknown event from SIP Gateway: ${data.event}`);
            }
        } catch (err) {
            console.error(`[Call ${callId}] Error processing SIP Gateway message:`, err);
        }
    });

    ws.on('close', () => {
        console.log(`[Call ${callId}] SIP Gateway WebSocket connection closed`);
        if (session) session.close();
        // Run analysis asynchronously after the call ends
        runPostCallAnalysis();
    });
}
