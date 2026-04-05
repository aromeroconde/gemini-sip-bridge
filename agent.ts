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

const agentFile = fileURLToPath(new URL('./lib/livekit-agent.ts', import.meta.url).href);

cli.runApp(new WorkerOptions({ agent: agentFile, agentName: 'gemini-sip-bridge' }));
