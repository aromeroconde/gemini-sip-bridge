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
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function loadVoicePrompt(): string {
    if (process.env.VOICE_PROMPT) return process.env.VOICE_PROMPT;
    const file = path.join(__dirname, '../prompts/voice_prompt.txt');
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
    description: 'Devuelve la mejor promoción disponible para el producto que le interesa al cliente. Llamar cuando el cliente pregunte por el precio o quiera comprar. Siempre prioriza las promociones activas e indica si el envío es gratuito.',
    parameters: z.object({
        producto: z.string().describe('Nombre del producto: Collagen Peptides, Fibra Gudd o Detox Gudd'),
    }),
    execute: async ({ producto }) => {
        const callId = (globalThis as any).__currentCallId || 'unknown';
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
            const raw = await resp.json();
            const content = raw?.[0]?.message?.content;
            if (!content) {
                console.error(`[Call ${callId}] precio: respuesta inesperada`, raw);
                return JSON.stringify({ error: 'No se pudo obtener el precio en este momento' });
            }
            console.log(`[Call ${callId}] precio:`, content);
            return JSON.stringify({ promocion: content });
        } catch (err) {
            console.error(`[Call ${callId}] precio falló:`, err);
            return JSON.stringify({ error: 'No se pudo consultar el precio en este momento' });
        }
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

        // Extract caller phone number from SIP participant attributes
        const sipParticipant = [...ctx.room.remoteParticipants.values()]
            .find(p => p.attributes['sip.callFrom']);
        const callerPhone = sipParticipant
            ? extractCallerPhone(sipParticipant.attributes['sip.callFrom'])
            : '';
        (globalThis as any).__callerPhone = callerPhone;
        console.log(`[Call ${callId}] Caller phone: ${callerPhone || '(not available)'}`);

        const voicePrompt = loadVoicePrompt();

        const model = new google.beta.realtime.RealtimeModel({
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
            },
        });

        const session = new voice.AgentSession({
            vad: (ctx.proc.userData as any).vad,
            llm: model,
            turnHandling: {
                endpointing: {
                    minDelay: 300, // Reduce silence wait time
                }
            }
        });

        await session.start({ agent, room: ctx.room });

        console.log(`[Call ${callId}] Agent session started. Waiting for participant to trigger proactive greeting...`);

        // Agent speaks first — greet caller after a short delay
        setTimeout(() => {
            const realtimeSession = (session as any).activity?.realtimeSession;
            if (realtimeSession && typeof (realtimeSession as any).sendClientEvent === 'function') {
                console.log(`[Call ${callId}] Injecting proactive greeting via sendClientEvent (realtime_input)...`);
                (realtimeSession as any).sendClientEvent({
                    type: 'realtime_input',
                    value: {
                        text: '[INICIO DE LLAMADA] Llama ahora a la función datos_cliente y luego saluda al cliente como Carolina de Advanced Health.'
                    }
                });
            } else {
                console.error(`[Call ${callId}] FAILED to trigger proactive greeting: sendClientEvent not found. session.activity: ${!!(session as any).activity}`);
            }
        }, 1200); // 1.2s delay to ensure room/session is fully stabilized

        // Log when a participant connects
        ctx.room.on('participantConnected', (participant) => {
            console.log(`[Call ${callId}] Participant connected: ${participant.identity}`);
        });

        // Run until the room closes
        await new Promise<void>((resolve) => {
            ctx.room.on('disconnected', () => {
                const duration = Math.round((Date.now() - callStartTime) / 1000);
                console.log(`[Call ${callId}] Room disconnected after ${duration}s`);
                resolve();
            });
        });

        // Post-call analysis (fire and forget)
        runPostCallAnalysis(callId, callStartTime);

        console.log(`[Call ${callId}] Agent exiting.`);
    },
});

// ─── Post-Call Analysis ──────────────────────────────────────────────────

async function runPostCallAnalysis(callId: string, callStartTime: number) {
    try {
        const { analyzeCall } = await import('./analysis-service.js');
        const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
        // Note: conversation log tracking would require hooking into session events
        // For now, analysis is based on available data
        await analyzeCall(callId, [], [], durationSeconds);
    } catch (err) {
        console.error(`[Call ${callId}] Post-call analysis failed:`, err);
    }
}
