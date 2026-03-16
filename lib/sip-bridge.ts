import { muLawToPcm, resample8To16, pcmToMuLaw, resample24To8 } from './audio-utils';
import { getToolDeclarations, executeTool } from './tool-manager';
import { analyzeCall, ConversationEntry } from './analysis-service';
import { WebSocket } from 'ws';
import crypto from 'crypto';

export function setupSipBridge(ws: WebSocket) {
    let geminiWs: WebSocket | null = null;
    let isSetupComplete = false;
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

    const host = 'generativelanguage.googleapis.com';
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    const connectToGemini = () => {
        console.log(`[Call ${callId}] Connecting to Gemini Multimodal Live API...`);
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log(`[Call ${callId}] Connected to Gemini Live API`);

            const setupMessage: Record<string, any> = {
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
                    },
                    tools: getToolDeclarations(),
                    turnDetection: {
                        threshold: 0.5
                    }
                }
            };
            console.log(`[Call ${callId}] Sending setup message...`);
            geminiWs?.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data.toString());

                if (response.setupComplete) {
                    console.log(`[Call ${callId}] Gemini Setup Complete.`);
                    isSetupComplete = true;
                    return;
                }

                // ─── Handle Interruption ────────────────────────────────
                if (response.serverContent?.interrupted) {
                    console.log(`[Call ${callId}] Gemini detected interruption. Clearing SIP Gateway buffers.`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ event: 'clear' }));
                    }
                    return;
                }

                // ─── Handle Tool Calls ──────────────────────────────────
                if (response.toolCall) {
                    handleToolCall(response.toolCall);
                    return;
                }

                // ─── Handle Audio + Text ────────────────────────────────
                if (response.serverContent) {
                    const modelTurn = response.serverContent.modelTurn;
                    if (modelTurn && modelTurn.parts) {
                        for (const part of modelTurn.parts) {
                            // Audio: transcode and send to SIP
                            if (part.inlineData && part.inlineData.mimeType.includes('audio')) {
                                const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                                if (conversationLog.length === 0 || toolsUsed.length === 0) {
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

                if (response.error) {
                    console.error(`[Call ${callId}] Gemini API Error:`, JSON.stringify(response.error));
                }

            } catch (err) {
                console.error(`[Call ${callId}] Error parsing Gemini message:`, err);
            }
        });

        geminiWs.on('error', (err) => {
            console.error(`[Call ${callId}] Gemini WebSocket error:`, err);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`[Call ${callId}] Gemini connection closed: ${code} ${reason}`);
            isSetupComplete = false;
        });
    };

    // ─── Tool Call Handler ───────────────────────────────────────────────

    async function handleToolCall(toolCall: any) {
        const functionCalls = toolCall.functionCalls || [];
        const functionResponses = [];

        for (const fc of functionCalls) {
            console.log(`[Call ${callId}] Tool call: ${fc.name}`, JSON.stringify(fc.args));
            toolsUsed.push(fc.name);

            const result = await executeTool(fc.name, fc.args || {}, callId);

            functionResponses.push({
                id: fc.id,
                name: fc.name,
                response: result
            });
        }

        if (geminiWs && geminiWs.readyState === WebSocket.OPEN && functionResponses.length > 0) {
            const toolResponse = {
                toolResponse: {
                    functionResponses: functionResponses
                }
            };
            geminiWs.send(JSON.stringify(toolResponse));
            console.log(`[Call ${callId}] Tool responses sent: ${functionResponses.map(r => r.name).join(', ')}`);
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

    // ─── Connect & Listen ────────────────────────────────────────────────

    connectToGemini();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.event === 'audio' || data.event === 'media') {
                const audioPayload = data.audio || (data.media ? data.media.payload : null);

                if (audioPayload && geminiWs && geminiWs.readyState === WebSocket.OPEN && isSetupComplete) {
                    const payload = Buffer.from(audioPayload, 'base64');
                    const pcm = muLawToPcm(payload);
                    const resampled = resample8To16(pcm);

                    const inputMessage = {
                        realtimeInput: {
                            mediaChunks: [{
                                mimeType: "audio/pcm;rate=16000",
                                data: resampled.toString('base64')
                            }]
                        }
                    };
                    geminiWs.send(JSON.stringify(inputMessage));
                }
            }
        } catch (err) {
            console.error(`[Call ${callId}] Error processing SIP Gateway message:`, err);
        }
    });

    ws.on('close', () => {
        console.log(`[Call ${callId}] SIP Gateway WebSocket connection closed`);
        if (geminiWs) geminiWs.close();
        // Run analysis asynchronously after the call ends
        runPostCallAnalysis();
    });
}
