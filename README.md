# Gemini SIP Bridge (Twilio + Gemini Multimodal Live)

Este proyecto permite conectar una línea telefónica de Twilio con la API Gemini Multimodal Live de Google, permitiendo conversaciones de voz naturales con IA a través de llamadas telefónicas.

## Requisitos
- Node.js v18+
- Un número de teléfono de Twilio.
- Una Google API Key con acceso a Gemini 2.0.

## Configuración
1. Clona este repositorio o mueve la carpeta.
2. Ejecuta `npm install`.
3. Crea un archivo `.env` basado en `.env.example` y añade tu `GOOGLE_API_KEY`.
4. Inicia el servidor con `npm run dev`.

## Exposición Pública
Para que Twilio pueda conectar, necesitas exponer tu puerto local (3001). 
Recomendamos usar **Cloudflare Tunnel**:
```bash
cloudflared tunnel --url http://localhost:3001
```

## Configuración en Twilio Console
En la configuración de tu número de teléfono:
- **A CALL COMES IN**: `https://<tu-url>/api/twilio/voice`
- **Call status changes**: `https://<tu-url>/api/twilio/status` (Opcional)

## Estructura
- `index.ts`: Servidor Express y manejo de Webhooks.
- `lib/twilio-bridge.ts`: Lógica del puente WebSocket.
- `lib/audio-utils.ts`: Transcoding de audio (Mu-law <-> PCM).

## Personalización de Voz y Prompt
Puedes cambiar la personalidad y la voz del agente editando el archivo `.env`:
- `VOICE_PROMPT`: El sistema de instrucciones para el agente.
- `VOICE_NAME`: El timbre de voz. Opciones: `Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede`.
