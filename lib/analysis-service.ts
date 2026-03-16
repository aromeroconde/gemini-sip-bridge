/**
 * Post-Call Analysis Service
 * 
 * Uses Gemini 3 Flash (standard REST API) to analyze conversation logs
 * after a call ends. Generates structured insights and sends them to
 * a webhook for further processing.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

export interface ConversationEntry {
    role: 'user' | 'model';
    text: string;
    timestamp: number;
}

export interface CallAnalysis {
    call_id: string;
    duration_seconds: number;
    summary: string;
    sentiment: 'positive' | 'neutral' | 'negative';
    key_topics: string[];
    action_items: string[];
    extracted_data: Record<string, string>;
    tools_used: string[];
    resolution_status: 'resolved' | 'unresolved' | 'transferred' | 'unknown';
    transcript: string;
}

const ANALYSIS_PROMPT = `Eres un analista de calidad de llamadas telefónicas. Analiza la siguiente transcripción de una llamada entre un asistente de IA y un cliente.

Responde EXCLUSIVAMENTE con un JSON válido (sin markdown, sin bloques de código) con esta estructura exacta:
{
  "summary": "Resumen breve de la conversación en 2-3 oraciones",
  "sentiment": "positive | neutral | negative",
  "key_topics": ["tema1", "tema2"],
  "action_items": ["acción pendiente 1", "acción pendiente 2"],
  "extracted_data": {
    "nombre_cliente": "si se mencionó",
    "telefono": "si se mencionó",
    "email": "si se mencionó",
    "empresa": "si se mencionó"
  },
  "resolution_status": "resolved | unresolved | transferred | unknown"
}

Si no hay datos para un campo, usa un array vacío [] o un objeto vacío {}.

TRANSCRIPCIÓN:
`;

/**
 * Analyze a completed call's conversation log using Gemini 3 Flash.
 */
export async function analyzeCall(
    callId: string,
    conversation: ConversationEntry[],
    toolsUsed: string[],
    durationSeconds: number
): Promise<CallAnalysis | null> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.error('[Analysis] GOOGLE_API_KEY not set');
        return null;
    }

    if (conversation.length === 0) {
        console.log('[Analysis] No conversation to analyze for call:', callId);
        return null;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: process.env.ANALYSIS_MODEL || 'gemini-2.0-flash'
        });

        // Format the conversation for analysis
        const transcriptText = conversation
            .map(entry => `[${entry.role === 'user' ? 'CLIENTE' : 'ASISTENTE'}]: ${entry.text}`)
            .join('\n');

        const result = await model.generateContent(ANALYSIS_PROMPT + transcriptText);
        const responseText = result.response.text();

        // Parse the JSON response
        const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const analysis = JSON.parse(cleanJson);

        const callAnalysis: CallAnalysis = {
            call_id: callId,
            duration_seconds: durationSeconds,
            summary: analysis.summary || '',
            sentiment: analysis.sentiment || 'neutral',
            key_topics: analysis.key_topics || [],
            action_items: analysis.action_items || [],
            extracted_data: analysis.extracted_data || {},
            tools_used: toolsUsed,
            resolution_status: analysis.resolution_status || 'unknown',
            transcript: transcriptText
        };

        console.log(`[Analysis] Call ${callId} analyzed:`, callAnalysis.summary);

        // Send to report webhook if configured
        await sendReport(callAnalysis);

        return callAnalysis;

    } catch (err) {
        console.error('[Analysis] Error analyzing call:', err);
        return null;
    }
}

/**
 * Send the analysis report to the configured webhook.
 */
async function sendReport(analysis: CallAnalysis): Promise<void> {
    const reportUrl = process.env.REPORT_WEBHOOK_URL;
    if (!reportUrl) {
        console.log('[Analysis] No REPORT_WEBHOOK_URL set. Report stored locally only.');
        console.log('[Analysis] Full report:', JSON.stringify(analysis, null, 2));
        return;
    }

    try {
        const response = await fetch(reportUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(analysis),
            signal: AbortSignal.timeout(15000)
        });

        if (response.ok) {
            console.log(`[Analysis] Report sent to webhook for call ${analysis.call_id}`);
        } else {
            console.error(`[Analysis] Webhook returned ${response.status}`);
        }
    } catch (err) {
        console.error('[Analysis] Failed to send report:', err);
    }
}
