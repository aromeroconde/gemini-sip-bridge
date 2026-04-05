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

// ─── Tool Definitions ────────────────────────────────────────────────────

const scheduleAppointment = llm.tool({
    description: 'Agenda una cita o reserva para el usuario. Usa esta herramienta cuando el usuario pida reservar, agendar, o programar algo.',
    parameters: z.object({
        client_name: z.string().describe('Nombre completo del cliente'),
        date: z.string().describe('Fecha de la cita en formato YYYY-MM-DD'),
        time: z.string().describe('Hora de la cita en formato HH:MM (24h)'),
        service: z.string().optional().describe('Tipo de servicio o motivo de la cita'),
        notes: z.string().optional().describe('Notas o comentarios adicionales'),
    }),
    execute: async ({ client_name, date, time, service, notes }) => {
        const callId = (globalThis as any).__currentCallId || 'unknown';
        console.log(`[Call ${callId}] Tool: schedule_appointment`, { client_name, date, time });
        const result = await executeWebhook('schedule_appointment', { client_name, date, time, service, notes }, callId);
        return JSON.stringify(result);
    },
});

const lookupInformation = llm.tool({
    description: 'Busca información en la base de datos del negocio. Usa esta herramienta para consultar disponibilidad, precios, horarios u otra información del negocio.',
    parameters: z.object({
        query_type: z.enum(['availability', 'pricing', 'hours', 'services', 'general']).describe('Tipo de consulta'),
        query: z.string().describe('La consulta o pregunta específica'),
    }),
    execute: async ({ query_type, query }) => {
        const callId = (globalThis as any).__currentCallId || 'unknown';
        console.log(`[Call ${callId}] Tool: lookup_information`, { query_type, query });
        const result = await executeWebhook('lookup_information', { query_type, query }, callId);
        return JSON.stringify(result);
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
        case 'schedule_appointment':
            return { success: true, message: `Cita agendada para ${args.client_name} el ${args.date} a las ${args.time}.`, confirmation_code: 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase() };
        case 'lookup_information':
            return { success: true, data: `Resultado simulado para "${args.query_type}": ${args.query}` };
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

        const model = new google.beta.realtime.RealtimeModel({
            model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview',
            voice: process.env.VOICE_NAME || 'Zephyr',
            instructions: process.env.VOICE_PROMPT || 'Eres QuantumIA, el consultor de IA de élite. Responde de forma profesional, amable y concisa. Habla siempre en español de Colombia.',
            apiKey: process.env.GOOGLE_API_KEY,
        });

        const agent = new voice.Agent({
            instructions: process.env.VOICE_PROMPT || 'Eres QuantumIA, el consultor de IA de élite. Responde de forma profesional, amable y concisa. Habla siempre en español de Colombia.',
            tools: {
                schedule_appointment: scheduleAppointment,
                lookup_information: lookupInformation,
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
                        text: '¡HOLA! (Saluda ahora mismo como QuantumIA, de forma muy breve)'
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
