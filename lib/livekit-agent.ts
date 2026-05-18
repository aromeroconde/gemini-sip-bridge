/**
 * LiveKit Agent Worker — Gemini Live + SIP Bridge
 *
 * Connects LiveKit Cloud SIP ingress to Gemini 3.1 Flash Live.
 * Audio pipeline is fully handled by the LiveKit Agents SDK:
 *   SIP (G.711/Opus) → LiveKit SFU → AgentSession → Gemini Live (PCM 16kHz in / 24kHz out)
 */
import {
    type JobContext,
    type JobProcess,
    defineAgent,
    llm,
    voice,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { RoomServiceClient } from 'livekit-server-sdk';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadVoicePrompt(): string {
    if (process.env.VOICE_PROMPT) return process.env.VOICE_PROMPT;
    const file = path.join(__dirname, '../../prompts/voice_prompt.txt');
    return fs.readFileSync(file, 'utf-8').trim();
}

function extractCallerPhone(sipUri: string): string {
    // Handles: "+573001234567" or "sip:+573001234567@domain.com"
    const match = sipUri.match(/(?:sip:)?([+\d]+)(?:@.*)?/);
    return match ? match[1] : sipUri;
}

// ─── Tool Definitions ────────────────────────────────────────────────────

const datosCliente = llm.tool({
    description: 'Obtiene los datos del cliente que está llamando: nombre, dirección, ciudad, departamento, tipo de pago, historial de compras y contexto. Llamar SIEMPRE al inicio de la llamada, antes del saludo.',
    parameters: z.object({}),
    execute: async () => {
        const callId = (globalThis as any).__currentCallId || 'unknown';
        ((globalThis as any).__toolsCalledThisCall ??= []).push('datos_cliente');
        console.log(`[Call ${callId}] Tool: datos_cliente`);
        const url = process.env.DATOS_CLIENTE_WEBHOOK_URL;
        if (!url) {
            console.warn(`[Call ${callId}] DATOS_CLIENTE_WEBHOOK_URL no configurada`);
            return JSON.stringify({});
        }
        const phone = (globalThis as any).__callerPhone || '';
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: phone, call_id: callId }),
                signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) {
                console.error(`[Call ${callId}] datos_cliente error: ${resp.status}`);
                return JSON.stringify({ tiene_datos: false });
            }
            const raw = await resp.json();
            const vars = raw?.[0]?.call_inbound?.dynamic_variables ?? {};
            const data = {
                tiene_datos: vars.tiene_datos === 'true',
                nombre_cliente: vars.nombre_cliente || '',
                primer_nombre: vars.primer_nombre || '',
                direccion: vars.direccion || '',
                ciudad: vars.ciudad || '',
                departamento: vars.departamento || '',
                tipo_pago: vars.tipo_pago || '',
                fecha_ultima_compra: vars.fecha_ultima_compra || '',
                producto_ultima_compra: vars.producto_ultima_compra || '',
            };
            console.log(`[Call ${callId}] datos_cliente:`, data);
            return JSON.stringify(data);
        } catch (err) {
            console.error(`[Call ${callId}] datos_cliente falló:`, err);
            return JSON.stringify({ tiene_datos: false });
        }
    },
});

const precio = llm.tool({
    description: 'Devuelve la mejor promoción disponible para el producto. OBLIGATORIO: ANTES de llamar esta herramienta, di en voz alta "Deme un segundito que le busco el mejor precio..." para no dejar silencio. Luego llama la herramienta. Siempre indica si el envío es gratuito.',
    parameters: z.object({
        producto: z.string().describe('Nombre del producto: Collagen Peptides, Fibra Gudd o Detox Gudd'),
    }),
    execute: async ({ producto }) => {
        const callId = (globalThis as any).__currentCallId || 'unknown';
        ((globalThis as any).__toolsCalledThisCall ??= []).push('precio');
        console.log(`[Call ${callId}] Tool: precio`, { producto });
        const url = process.env.PRECIO_WEBHOOK_URL;
        if (!url) {
            console.warn(`[Call ${callId}] PRECIO_WEBHOOK_URL no configurada`);
            return JSON.stringify({ error: 'Precio no disponible en este momento' });
        }
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ producto, call_id: callId }),
                signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) {
                console.error(`[Call ${callId}] precio error: ${resp.status}`);
                return JSON.stringify({ error: `Error consultando precio: ${resp.status}` });
            }
            const text = await resp.text();
            let content: string;
            try {
                const raw = JSON.parse(text);
                content = raw?.[0]?.message?.content ?? '';
            } catch {
                // Webhook devuelve texto plano directamente
                content = text.trim();
            }
            if (!content) {
                console.error(`[Call ${callId}] precio: respuesta vacía`);
                return JSON.stringify({ error: 'No se pudo obtener el precio en este momento' });
            }
            console.log(`[Call ${callId}] precio:`, content.substring(0, 100));
            return JSON.stringify({ promocion: content });
        } catch (err) {
            console.error(`[Call ${callId}] precio falló:`, err);
            return JSON.stringify({ error: 'No se pudo consultar el precio en este momento' });
        }
    },
});

const endCall = llm.tool({
    description: 'Cuelga la llamada y cierra la sesión. Llamar ÚNICAMENTE cuando el cliente se haya despedido y la conversación haya terminado completamente.',
    parameters: z.object({}),
    execute: async () => {
        const callId = (globalThis as any).__currentCallId || 'unknown';
        ((globalThis as any).__toolsCalledThisCall ??= []).push('end_call');
        console.log(`[Call ${callId}] Tool: end_call — esperando fin de despedida`);
        // Esperar a que el audio de despedida termine antes de disparar el cierre.
        // Mientras el tool está "ejecutando", Gemini no genera nueva respuesta
        // ni interrumpe el audio actual.
        await new Promise(r => setTimeout(r, 5000));
        const trigger = (globalThis as any).__triggerEndCall;
        if (typeof trigger === 'function') {
            trigger();
        } else {
            console.error(`[Call ${callId}] end_call: __triggerEndCall no disponible`);
        }
        return JSON.stringify({ success: true });
    },
});

const transferToHuman = llm.tool({
    description: 'Transfiere la llamada a un agente humano. Usa esta herramienta cuando el usuario insista en hablar con una persona real o cuando no puedas resolver su problema.',
    parameters: z.object({
        reason: z.string().describe('Motivo de la transferencia'),
        department: z.enum(['sales', 'support', 'billing', 'management']).optional().describe('Departamento sugerido'),
    }),
    execute: async ({ reason, department }) => {
        const callId = (globalThis as any).__currentCallId || 'unknown';
        ((globalThis as any).__toolsCalledThisCall ??= []).push('transfer_to_human');
        console.log(`[Call ${callId}] Tool: transfer_to_human`, { reason, department });
        const result = await executeWebhook('transfer_to_human', { reason, department }, callId);
        return JSON.stringify(result);
    },
});

// ─── Webhook Execution ───────────────────────────────────────────────────

async function executeWebhook(toolName: string, args: Record<string, any>, callId: string): Promise<Record<string, any>> {
    const webhookUrl = process.env.WEBHOOK_URL;
    const payload = { tool: toolName, args, call_id: callId, timestamp: new Date().toISOString() };

    if (webhookUrl) {
        try {
            const resp = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) return { success: false, error: `Webhook error: ${resp.status}` };
            const result = await resp.json();
            return typeof result === 'object' ? result : { result };
        } catch (err) {
            console.error(`[ToolManager] Webhook failed:`, err);
            return { success: false, error: 'No se pudo conectar con el sistema externo' };
        }
    }

    // Mock responses
    switch (toolName) {
        case 'transfer_to_human':
            return { success: true, message: `Transferencia a ${args.department || 'general'}. Motivo: ${args.reason}` };
        default:
            return { success: false, error: `Tool desconocida: ${toolName}` };
    }
}

// ─── Lifecycle Constants ─────────────────────────────────────────────────

const HARD_TIMEOUT_MS = 20 * 60 * 1000;     // 20 min max call duration
const SILENCE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min inactivity cutoff
const RECONNECT_DELAYS_MS = [1000, 2000, 4000]; // backoff: 1s → 2s → 4s

// ─── Agent Definition ────────────────────────────────────────────────────

export default defineAgent({
    prewarm: async (proc: JobProcess) => {
        (proc.userData as any).vad = await silero.VAD.load({
            minSpeechDuration: 0.1,
            minSilenceDuration: 0.2,
            prefixPaddingDuration: 0.1,
        });
    },

    entry: async (ctx: JobContext) => {
        const callId = crypto.randomUUID();
        (globalThis as any).__currentCallId = callId;
        const callStartTime = Date.now();

        console.log(`[Call ${callId}] Agent started. Room: ${ctx.room.name}`);

        const voicePrompt = loadVoicePrompt();

        // ── Timer management ──────────────────────────────────────────────
        let hardTimeout: ReturnType<typeof setTimeout> | null = null;
        let silenceTimeout: ReturnType<typeof setTimeout> | null = null;

        const clearTimers = () => {
            if (hardTimeout) { clearTimeout(hardTimeout); hardTimeout = null; }
            if (silenceTimeout) { clearTimeout(silenceTimeout); silenceTimeout = null; }
        };

        (globalThis as any).__toolsCalledThisCall = [];

        // ── Call-ending signal (resolved by end_call tool) ────────────────
        let callEnding = false;
        let callEndingResolve: () => void = () => {};
        const callEndingPromise = new Promise<void>(r => { callEndingResolve = r; });

        // ── Room done signal ──────────────────────────────────────────────
        let roomClosed = false;
        let roomDoneResolve: () => void = () => {};
        const roomDonePromise = new Promise<void>(r => { roomDoneResolve = r; });

        ctx.room.once('disconnected', () => {
            roomClosed = true;
            const duration = Math.round((Date.now() - callStartTime) / 1000);
            console.log(`[Call ${callId}] Room disconnected after ${duration}s`);
            roomDoneResolve();
        });

        (globalThis as any).__triggerEndCall = () => {
            if (callEnding) return;
            callEnding = true;
            console.log(`[Call ${callId}] end_call: señal de fin recibida`);
            callEndingResolve();
        };

        ctx.addShutdownCallback(async () => {
            console.log(`[Call ${callId}] Shutdown callback`);
            clearTimers();
            callEnding = true; callEndingResolve();
            roomClosed = true; roomDoneResolve();
            delete (globalThis as any).__triggerEndCall;
            delete (globalThis as any).__toolsCalledThisCall;
        });

        hardTimeout = setTimeout(() => {
            const elapsed = Math.round((Date.now() - callStartTime) / 1000);
            console.log(`[Call ${callId}] Hard timeout after ${elapsed}s. Disconnecting.`);
            clearTimers();
            ctx.room.disconnect();
        }, HARD_TIMEOUT_MS);

        const resetSilenceTimer = () => {
            if (silenceTimeout) clearTimeout(silenceTimeout);
            silenceTimeout = setTimeout(() => {
                const elapsed = Math.round((Date.now() - callStartTime) / 1000);
                console.log(`[Call ${callId}] Silence timeout after ${elapsed}s. Disconnecting.`);
                clearTimers();
                ctx.room.disconnect();
            }, SILENCE_TIMEOUT_MS);
        };
        resetSilenceTimer();

        ctx.room.on('activeSpeakersChanged', resetSilenceTimer);
        ctx.room.on('dataReceived', resetSilenceTimer);
        ctx.room.on('participantConnected', (participant) => {
            console.log(`[Call ${callId}] Participant connected: ${participant.identity}`);
            resetSilenceTimer();
        });

        // ── Agent + model factory ─────────────────────────────────────────
        const createModel = () => new google.beta.realtime.RealtimeModel({
            model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview',
            voice: process.env.VOICE_NAME || 'Zephyr',
            instructions: voicePrompt,
            apiKey: process.env.GOOGLE_API_KEY,
        });

        const agent = new voice.Agent({
            instructions: voicePrompt,
            tools: {
                datos_cliente: datosCliente,
                precio: precio,
                transfer_to_human: transferToHuman,
                end_call: endCall,
            },
        });

        // ── SIP caller hangup ────────────────────────────────────────────
        let sipCallerHungUp = false;

        ctx.room.on('participantDisconnected', (participant) => {
            if (participant.attributes?.['sip.phoneNumber']) {
                sipCallerHungUp = true;
                console.log(`[Call ${callId}] SIP caller hung up — closing call`);
                clearTimers();
                callEndingResolve();
            }
        });

        // ── Session runner ────────────────────────────────────────────────
        const runSession = async (isReconnect: boolean): Promise<'reconnect' | 'done'> => {
            const model = createModel();
            const session = new voice.AgentSession({
                vad: (ctx.proc.userData as any).vad,
                llm: model,
                turnHandling: { endpointing: { minDelay: 300 } }
            });

            try {
                await session.start({ agent, room: ctx.room });
            } catch (err) {
                console.error(`[Call ${callId}] session.start failed (reconnect=${isReconnect}):`, err);
                return roomClosed ? 'done' : 'reconnect';
            }

            console.log(`[Call ${callId}] Session started (reconnect=${isReconnect})`);

            if (!isReconnect) {
                const allParticipants = [...ctx.room.remoteParticipants.values()];
                console.log(`[Call ${callId}] Participants: ${allParticipants.length}`);
                allParticipants.forEach(p => {
                    console.log(`[Call ${callId}] Participant ${p.identity} attrs:`, JSON.stringify(p.attributes));
                });
                const sipParticipant = allParticipants.find(p => p.attributes['sip.phoneNumber']);
                const callerPhone = sipParticipant ? sipParticipant.attributes['sip.phoneNumber'] : '';
                (globalThis as any).__callerPhone = callerPhone;
                console.log(`[Call ${callId}] Caller phone: ${callerPhone || '(not available)'}`);
            }

            const triggerText = isReconnect
                ? '[RECONEXIÓN] La sesión fue restaurada. Continúa la conversación de manera natural sin repetir el saludo.'
                : '[INICIO DE LLAMADA] Llama ahora a la función datos_cliente y luego saluda al cliente como Carolina de Advanced Health.';

            setTimeout(() => {
                const realtimeSession = (session as any).activity?.realtimeSession;
                if (realtimeSession?.sendClientEvent) {
                    console.log(`[Call ${callId}] Injecting trigger (reconnect=${isReconnect})...`);
                    (realtimeSession as any).sendClientEvent({
                        type: 'realtime_input',
                        value: { text: triggerText }
                    });
                } else {
                    console.error(`[Call ${callId}] sendClientEvent not found (reconnect=${isReconnect})`);
                }
            }, isReconnect ? 800 : 1200);

            const sessionErrorPromise = new Promise<void>((resolve) => {
                const onClose = (err?: any) => {
                    if (err) console.error(`[Call ${callId}] Session error:`, err);
                    else console.log(`[Call ${callId}] Session closed unexpectedly`);
                    resolve();
                };
                (session as any).once?.('close', () => onClose());
                (session as any).once?.('error', onClose);
            });

            await Promise.race([sessionErrorPromise, roomDonePromise, callEndingPromise]);
            return (roomClosed || sipCallerHungUp || callEnding) ? 'done' : 'reconnect';
        };

        // ── Main execution with reconnect loop ────────────────────────────
        let result = await runSession(false);

        for (let attempt = 0; result === 'reconnect' && attempt < RECONNECT_DELAYS_MS.length; attempt++) {
            const delay = RECONNECT_DELAYS_MS[attempt];
            console.log(`[Call ${callId}] Session dropped. Reconnecting in ${delay}ms (attempt ${attempt + 1}/${RECONNECT_DELAYS_MS.length})...`);

            await Promise.race([
                new Promise<void>(r => setTimeout(r, delay)),
                roomDonePromise,
                callEndingPromise,
            ]);

            if (roomClosed || sipCallerHungUp || callEnding) break;
            result = await runSession(true);
        }

        if (result === 'reconnect' && !roomClosed && !sipCallerHungUp && !callEnding) {
            console.log(`[Call ${callId}] Max reconnect attempts exhausted. Disconnecting room.`);
        }

        // Capturar datos antes de cualquier limpieza
        const callerPhone = (globalThis as any).__callerPhone || '';
        const toolsUsed = [...((globalThis as any).__toolsCalledThisCall || [])];

        clearTimers();

        // Eliminar el room via API — esto cuelga la llamada SIP y desconecta al agente
        await deleteRoom(ctx.room.name ?? '');

        // Enviar webhook (awaited para que complete antes de que el proceso muera)
        await runPostCallAnalysis(callId, callStartTime, callerPhone, toolsUsed);

        // Esperar cierre del room con fallback de 5s
        await Promise.race([
            roomDonePromise,
            new Promise<void>(r => setTimeout(r, 5000)),
        ]);

        console.log(`[Call ${callId}] Agent exiting.`);
    },
});

// ─── Room Deletion (cuelga la llamada SIP) ───────────────────────────────

async function deleteRoom(roomName: string): Promise<void> {
    try {
        const wsUrl = process.env.LIVEKIT_URL ?? '';
        const httpUrl = wsUrl.replace(/^wss?:\/\//, 'https://');
        const apiKey = process.env.LIVEKIT_API_KEY ?? '';
        const apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
        if (!httpUrl || !apiKey || !apiSecret) {
            console.error('[HangUp] Faltan credenciales LiveKit');
            return;
        }
        const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
        await svc.deleteRoom(roomName);
        console.log(`[HangUp] Room ${roomName} eliminado — llamada SIP colgada`);
    } catch (err) {
        console.error('[HangUp] Error eliminando room:', err);
    }
}

// ─── Post-Call Analysis ──────────────────────────────────────────────────

async function runPostCallAnalysis(
    callId: string,
    callStartTime: number,
    callerPhone: string,
    toolsUsed: string[],
) {
    try {
        const { sendCallSummary } = await import('./analysis-service.js');
        const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
        await sendCallSummary(callId, durationSeconds, callerPhone, toolsUsed);
    } catch (err) {
        console.error(`[Call ${callId}] Post-call summary failed:`, err);
    }
}
