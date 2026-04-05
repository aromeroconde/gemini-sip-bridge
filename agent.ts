/**
 * Agent Worker Entry Point
 *
 * Run with: npx tsx agent.ts dev
 * Or built: node dist/agent.js dev
 */
import { cli, WorkerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error('CRITICAL: Missing LiveKit credentials!');
    console.error('Please ensure LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set in your environment.');
    process.exit(1);
}

console.log(`Starting agent worker on ${LIVEKIT_URL || 'ws://localhost:7880'}...`);

const agentFile = fileURLToPath(new URL('./lib/livekit-agent.ts', import.meta.url).href);

cli.runApp(new WorkerOptions({ agent: agentFile, agentName: 'gemini-sip-bridge' }));
