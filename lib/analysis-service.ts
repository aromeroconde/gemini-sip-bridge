/**
 * Post-Call Analysis Service
 *
 * Uses Gemini Flash (standard REST API) to analyze conversation logs
 * after a call ends. Generates structured insights and sends them to
 * a webhook for further processing.
 */

import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const ANALYSIS_PROMPT = fs.readFileSync(
    path.join(__dirname, '../../prompts/analysis_prompt.txt'),
    'utf-8'
);

/**
 * Analyze a completed call's conversation log using Gemini Flash.
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
        const ai = new GoogleGenAI({ apiKey });
        const modelName = process.env.ANALYSIS_MODEL || 'gemini-2.5-flash';

        // Format the conversation for analysis
        const transcriptText = conversation
            .map(entry => `[${entry.role === 'user' ? 'CLIENTE' : 'ASISTENTE'}]: ${entry.text}`)
            .join('\n');

        const response = await ai.models.generateContent({
            model: modelName,
            contents: ANALYSIS_PROMPT + transcriptText,
        });

        const responseText = response.text ?? '';

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

/**
 * Send a basic call summary after every call.
 * Includes the full transcript so the receiving workflow can run its own analysis.
 * Configure GEMINI_LIVE_COST_PER_MINUTE to get cost estimates.
 */
export async function sendCallSummary(
    callId: string,
    durationSeconds: number,
    callerPhone: string,
    toolsUsed: string[],
    conversation: ConversationEntry[] = []
): Promise<void> {
    const costPerMinute = parseFloat(process.env.GEMINI_LIVE_COST_PER_MINUTE || '0');
    const durationMinutes = durationSeconds / 60;
    const costEstimate = costPerMinute > 0
        ? Math.round(durationMinutes * costPerMinute * 10000) / 10000
        : null;

    const transcriptText = conversation
        .map(e => `[${e.role === 'user' ? 'CLIENTE' : 'CAROLINA'}]: ${e.text}`)
        .join('\n');

    const summary = {
        event: 'call_ended',
        call_id: callId,
        timestamp: new Date().toISOString(),
        caller_phone: callerPhone,
        duration_seconds: durationSeconds,
        duration_minutes: Math.round(durationMinutes * 100) / 100,
        tools_used: toolsUsed,
        model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview',
        ...(costEstimate !== null && { cost_estimate_usd: costEstimate }),
        transcript: conversation,
        transcript_text: transcriptText,
    };

    console.log(`[Analysis] Call summary — duration: ${durationSeconds}s, phone: ${callerPhone || 'unknown'}, tools: [${toolsUsed.join(', ')}], turns: ${conversation.length}${costEstimate !== null ? `, cost: $${costEstimate}` : ''}`);

    const reportUrl = process.env.REPORT_WEBHOOK_URL;
    if (!reportUrl) return;

    try {
        const response = await fetch(reportUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(summary),
            signal: AbortSignal.timeout(15000),
        });
        if (response.ok) {
            console.log(`[Analysis] Call summary sent for call ${callId}`);
        } else {
            console.error(`[Analysis] Summary webhook returned ${response.status}`);
        }
    } catch (err) {
        console.error('[Analysis] Failed to send call summary:', err);
    }
}
