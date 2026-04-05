import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'gemini-sip-bridge', version: '3.0.0', runtime: 'livekit-cloud' });
});

app.listen(port, () => {
    console.log(`Gemini SIP Bridge v3.0.0 (LiveKit Cloud) running on port ${port}`);
    console.log('Start the agent worker separately: npm run agent');
});
