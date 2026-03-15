/**
 * Tool Manager: Defines tools for Gemini Live API and handles execution via webhooks.
 * 
 * Tools allow Gemini to take real-world actions during a phone conversation,
 * such as scheduling appointments, querying databases, or sending notifications.
 */

export interface ToolDeclaration {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: Record<string, { type: string; description: string; enum?: string[] }>;
        required: string[];
    };
}

export interface ToolCallRequest {
    functionCalls: Array<{
        id: string;
        name: string;
        args: Record<string, any>;
    }>;
}

export interface ToolCallResult {
    id: string;
    name: string;
    response: Record<string, any>;
}

// ─── Default Tool Definitions ───────────────────────────────────────────────

const defaultTools: ToolDeclaration[] = [
    {
        name: "schedule_appointment",
        description: "Agenda una cita o reserva para el usuario. Usa esta herramienta cuando el usuario pida reservar, agendar, o programar algo.",
        parameters: {
            type: "OBJECT",
            properties: {
                client_name: {
                    type: "STRING",
                    description: "Nombre completo del cliente"
                },
                date: {
                    type: "STRING",
                    description: "Fecha de la cita en formato YYYY-MM-DD"
                },
                time: {
                    type: "STRING",
                    description: "Hora de la cita en formato HH:MM (24h)"
                },
                service: {
                    type: "STRING",
                    description: "Tipo de servicio o motivo de la cita"
                },
                notes: {
                    type: "STRING",
                    description: "Notas o comentarios adicionales"
                }
            },
            required: ["client_name", "date", "time"]
        }
    },
    {
        name: "lookup_information",
        description: "Busca información en la base de datos del negocio. Usa esta herramienta para consultar disponibilidad, precios, horarios u otra información del negocio.",
        parameters: {
            type: "OBJECT",
            properties: {
                query_type: {
                    type: "STRING",
                    description: "Tipo de consulta",
                    enum: ["availability", "pricing", "hours", "services", "general"]
                },
                query: {
                    type: "STRING",
                    description: "La consulta o pregunta específica"
                }
            },
            required: ["query_type", "query"]
        }
    },
    {
        name: "transfer_to_human",
        description: "Transfiere la llamada a un agente humano. Usa esta herramienta cuando el usuario insista en hablar con una persona real o cuando no puedas resolver su problema.",
        parameters: {
            type: "OBJECT",
            properties: {
                reason: {
                    type: "STRING",
                    description: "Motivo de la transferencia"
                },
                department: {
                    type: "STRING",
                    description: "Departamento sugerido",
                    enum: ["sales", "support", "billing", "management"]
                }
            },
            required: ["reason"]
        }
    }
];

// ─── Gemini Setup Format ────────────────────────────────────────────────────

/**
 * Returns the tools array formatted for Gemini Live API setup message.
 */
export function getToolDeclarations(): object[] {
    return [{
        functionDeclarations: defaultTools
    }];
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

/**
 * Execute a tool call by dispatching to the configured WEBHOOK_URL.
 * Falls back to a local mock response if no webhook is configured.
 */
export async function executeTool(
    functionName: string,
    functionArgs: Record<string, any>,
    callId: string
): Promise<Record<string, any>> {
    const webhookUrl = process.env.WEBHOOK_URL;

    const payload = {
        tool: functionName,
        args: functionArgs,
        call_id: callId,
        timestamp: new Date().toISOString()
    };

    if (webhookUrl) {
        try {
            console.log(`[ToolManager] Calling webhook: ${functionName}`, JSON.stringify(functionArgs));
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000) // 10s timeout
            });

            if (!response.ok) {
                console.error(`[ToolManager] Webhook returned ${response.status}`);
                return { success: false, error: `Webhook error: ${response.status}` };
            }

            const result = await response.json();
            console.log(`[ToolManager] Webhook response:`, JSON.stringify(result));
            return result;
        } catch (err) {
            console.error(`[ToolManager] Webhook call failed:`, err);
            return { success: false, error: 'No se pudo conectar con el sistema externo' };
        }
    }

    // Local mock responses when no webhook is configured
    console.log(`[ToolManager] No WEBHOOK_URL set, using mock response for: ${functionName}`);
    return getMockResponse(functionName, functionArgs);
}

function getMockResponse(name: string, args: Record<string, any>): Record<string, any> {
    switch (name) {
        case 'schedule_appointment':
            return {
                success: true,
                message: `Cita agendada para ${args.client_name} el ${args.date} a las ${args.time}.`,
                confirmation_code: 'MOCK-' + Math.random().toString(36).substring(2, 8).toUpperCase()
            };
        case 'lookup_information':
            return {
                success: true,
                data: `Resultado simulado para consulta de tipo "${args.query_type}": ${args.query}`
            };
        case 'transfer_to_human':
            return {
                success: true,
                message: `Transferencia solicitada al departamento ${args.department || 'general'}. Motivo: ${args.reason}`
            };
        default:
            return { success: false, error: `Tool desconocida: ${name}` };
    }
}
