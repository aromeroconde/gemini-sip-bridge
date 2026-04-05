# **ARQUITECTURA GENERAL**

\!\[Diagrama de flujo: Llamada telefónica \-\> Zadarma/Netelip (SIP) \-\> LiveKit Cloud (SIP ↔ WebRTC) \-\> https://www.google.com/search?q=Modal.com Worker (WebSocket) \-\> Gemini Live API (WebSocket)\]

Cuando alguien llama al número, la voz viaja por **SIP hasta LiveKit**, que la convierte a **WebRTC** y la entrega al worker Python en **Modal**, que la procesa con **Gemini en tiempo real** y devuelve voz por el mismo camino.

## **1\. LiveKit Cloud · El puente SIP ↔ WebRTC**

LiveKit actúa de puente entre el mundo SIP (teléfonos) y el mundo WebSocket (Gemini). Crea un proyecto en **cloud.livekit.io** y obtén estas 3 credenciales:

**CREDENCIALES**

LIVEKIT\_URL —\> wss://tu-proyecto.livekit.cloud

LIVEKIT\_API\_KEY —\> tu clave API

LIVEKIT\_API\_SECRET —\> tu secreto API

## **2\. SIP Inbound Trunk en LiveKit · Conexión con tu operador telefónico**

El trunk es la conexión entre tu operador (Zadarma / Netelip) y LiveKit. Ve a **LiveKit** \-\> **SIP** \-\> **Inbound Trunks** \-\> **New Trunk** y rellena:

**CONFIGURACIÓN LIVEKIT**

**Name:** Mi trunk Zadarma

**Numbers:** \+34936940352 (\<- tu número de Zadarma/Netelip)

**Allowed IPs:** (dejar vacío \= acepta todos)

LiveKit te dará una **SIP URI de entrada**, por ejemplo:

xn7ivyolfp4.sip.livekit.cloud

**"Guarda esta URI"** — la necesitarás en el paso siguiente para configurar tu operador telefónico.

## **3\. Configurar el operador SIP · Zadarma / Netelip \-\> LiveKit**

En el panel de **Zadarma** (o Netelip), abre la configuración del número o troncal SIP y apunta todas las llamadas entrantes a la URI de LiveKit:

**ZADARMA / NETELIP**

**SIP destino:** \+34936940352@xn7ivyolfp4.sip.livekit.cloud

**"A partir de este momento"** las llamadas al número viajan automáticamente por SIP hasta LiveKit.

## **4\. Dispatch Rule en LiveKit · ¿A qué agente va cada llamada?**

Una dispatch rule le dice a LiveKit qué hacer cuando llega una llamada: a qué sala asignarla y qué agente llamar. Ve a **LiveKit** \-\> **SIP** \-\> **Dispatch Rules** \-\> **New Rule**:

**JSON**

{  
  "agent\_name": "gemini-sip-agent",  
  "metadata": "{\\"agent\_id\\": \\"TU\_UUID\_DEL\_AGENTE\\"}"  
}

**"agent\_name"** debe coincidir EXACTAMENTE con el nombre del worker Python.

**"metadata"** pasa el ID del agente para cargar su config desde Supabase.

## **5\. Worker Python en https://www.google.com/search?q=Modal.com · El cerebro del sistema**

Modal permite ejecutar código Python sin servidor, activo 24h gracias a **min\_containers=1**. Crea el archivo **sip-agent/agent.py** con esta estructura:

**■ Imagen con dependencias:**

PYTHON  
image \= (  
    modal.Image.debian\_slim(python\_version='3.11')  
    .pip\_install(  
        'livekit-agents\[google\]\>=1.0',  
        'livekit-plugins-google\>=1.0',  
        'supabase\>=2.0',  
        'google-generativeai\>=0.8',  
    )  
)

**■ Entrypoint de cada llamada:**

PYTHON  
async def entrypoint(ctx):  
    await ctx.connect()  
    agent\_id \= json.loads(ctx.job.metadata).get('agent\_id')  
    config \= get\_agent\_config(agent\_id)      \# carga desde Supabase  
    session \= AgentSession(  
        llm=google.beta.realtime.RealtimeModel(  
            model='gemini-1.5-flash-live-preview',  
            api\_key=config\['google\_api\_key'\],  
            voice=config\['voice\_id'\],  
        )  
    )  
    await session.start(room=ctx.room, agent=VoiceAgent())  
    await session.wait\_for\_disconnect()  
    save\_session(...) \# guarda transcript en Supabase

**■ Worker persistente (24 horas):**

PYTHON  
@app.function(  
    secrets=\['supabase-credentials', 'livekit-credentials', 'google-api-key'\],  
    timeout=86400,  
    min\_containers=1,    \# \<- CRÍTICO: siempre hay 1 instancia activa  
)  
def run\_worker():  
    sys.argv \= \['agent', 'start',  
        '--url',        os.environ\['LIVEKIT\_URL'\],  
        '--api-key',    os.environ\['LIVEKIT\_API\_KEY'\],  
        '--api-secret', os.environ\['LIVEKIT\_API\_SECRET'\],  
    \]  
    cli.run\_app(WorkerOptions(  
        entrypoint\_fnc=entrypoint,  
        agent\_name='gemini-sip-agent',   \# debe \= dispatch rule  
    ))

**■ Secrets en Modal — crea estos 3 en https://www.google.com/search?q=modal.com/secrets:**

| Secret name | Variables |
| :---- | :---- |
| **supabase-credentials** | SUPABASE\_URL, SUPABASE\_SERVICE\_KEY |
| **livekit-credentials** | LIVEKIT\_URL, LIVEKIT\_API\_KEY, LIVEKIT\_API\_SECRET |
| **google-api-key** | GOOGLE\_API\_KEY (fallback si el agente no tiene su propia key) |

**■ Despliegue:**

BASH  
pip install modal  
modal setup             \# autenticar con tu cuenta  
modal deploy agent.py   \# despliega y queda corriendo permanentemente

## **6\. Configuración por agente en Supabase · Tabla agents**

Cada agente en la plataforma tiene en la tabla **agents** de Supabase:

**TABLA AGENTS**

* google\_api\_key \-\> su propia API key de Google AI Studio  
* voice\_id \-\> voz de Gemini: Puck, Charon, Kore, Fenrir, Aoede...  
* system\_prompt \-\> instrucciones del agente  
* initial\_greeting \-\> saludo automático al conectar  
* user\_id \-\> propietario del agente

El worker carga esta configuración al inicio de cada llamada usando el **agent\_id** recibido en el metadata de la dispatch rule.

## **FLUJO COMPLETO DE UNA LLAMADA**

1. **Usuario llama al \+34936940352**  
2. **Zadarma envía INVITE** \-\> xn7ivyolfp4.sip.livekit.cloud  
3. **LiveKit crea sala** y busca worker con agent\_name='gemini-sip-agent'  
4. **Modal recibe el job** con metadata={'agent\_id': 'uuid'}  
5. **Worker llama a ctx.connect()** y entra en la sala LiveKit  
6. **Carga configuración** del agente desde Supabase  
7. **Abre WebSocket** con Gemini Live API  
8. **El audio fluye:** SIP \-\> LiveKit \-\> WebSocket \-\> Gemini  
9. **Gemini responde en voz:** Gemini \-\> WebSocket \-\> LiveKit \-\> SIP \-\> teléfono  
10. **Al colgar:** guarda transcript, duración, número y resumen en Supabase

## **■ PUNTOS CLAVE QUE NO SON OBVIOS**

**"min\_containers=1 es CRÍTICO":** sin esto Modal apaga el worker y las llamadas llegan sin nadie escuchando (tarda 10-15s en arrancar en frío, el teléfono ya colgó).

**"agent\_name idéntico":** el nombre en el worker Python y en la dispatch rule deben ser EXACTAMENTE iguales — así LiveKit sabe a qué worker enviar la llamada.

**"sys.argv injection":** cli.run\_app espera argumentos de línea de comandos. En Modal no hay CLI, así que los inyectamos manualmente en sys.argv.

**"agent\_id en metadata":** viaja en ctx.job.metadata (del dispatch rule), no en ctx.room.metadata. El código comprueba ambos por seguridad.

**"API key por agente":** cada usuario pone su propia API key de Google en su agente. El worker la carga de Supabase; si no hay ninguna, usa la key global de Modal.