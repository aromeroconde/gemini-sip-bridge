/**
 * Agent Worker Entry Point
 *
 * Run with: npx tsx agent.ts dev
 * Or built: node dist/agent.js dev
 */
import { cli, WorkerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

dotenv.config();

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error('CRITICAL: Missing LiveKit credentials!');
    console.error('Please ensure LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set in your environment.');
    process.exit(1);
}

console.log(`Starting agent worker on ${LIVEKIT_URL || 'ws://localhost:7880'}...`);

// Resolve agent file path dynamically
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if we are running from dist or source
let agentFile = path.join(__dirname, 'lib', 'livekit-agent.js');
if (!fs.existsSync(agentFile)) {
    agentFile = path.join(__dirname, 'lib', 'livekit-agent.ts');
}

console.log(`Loading agent from: ${agentFile}`);

cli.runApp(new WorkerOptions({ agent: agentFile, agentName: 'gemini-sip-bridge' }));
