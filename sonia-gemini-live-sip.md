# Conexión de Gemini 3.1 Live a una Línea SIP (Guía de Sonia)

Esta guía detalla el proceso técnico para conectar el modelo **Gemini 3.1 Live** (que funciona nativamente sobre WebSockets) a una línea telefónica convencional (**SIP**), utilizando **LiveKit** como puente de integración.

---

## 🏗️ Arquitectura del Sistema

La conexión sigue el siguiente flujo de datos:

1.  **Proveedor SIP (Netelip):** Recibe la llamada telefónica y la desvía.
2.  **Intermediario (LiveKit):** Recibe el tráfico SIP y lo convierte en un formato compatible con agentes de IA (WebRTC/WebSockets).
3.  **Agente (Gemini 3.1 Live):** Procesa el audio en tiempo real y genera respuestas instantáneas.
4.  **Worker (Python):** Un script que corre en un servidor (ej. `modal.com`) y orquesta la conexión entre LiveKit y Gemini.

---

## 🛠️ Configuración Paso a Paso

### 1. Preparación en LiveKit
- Accede a tu cuenta de **LiveKit**.
- Crea un nuevo **SIP Trunk**:
    - Nombre: `Sonia-SIP-Agent`
    - Tipo: **Inbound** (para llamadas entrantes).
    - Introduce el número de teléfono que usarás.
- Copia la **SIP URI** generada (ej: `sip:sonia-123.livekit.cloud`).

### 2. Desvío desde Netelip
- En el panel de **Netelip**, dirígete a la configuración de tu número.
- Configura el desvío de llamadas hacia la **SIP URI** que copiaste de LiveKit.

### 3. Reglas de Despacho (Dispatch Rules)
En LiveKit, crea una regla para que el sistema sepa a qué agente enviar la llamada:
- Nombre: `Gemini Dispatch Rule`
- **Metadata**: Pasa el ID del agente de Gemini en formato JSON:
  ```json
  { "agent_id": "sonia_gemini_live_v1" }
  ```
- Asocia esta regla al Trunk creado en el paso 1.

### 4. Implementación del Worker
Necesitas un servidor escuchando las peticiones de LiveKit. Sonia utiliza un worker basado en el SDK de Python de LiveKit:
- El worker detecta la entrada de un participante SIP.
- Abre una sesión con la API de **Gemini 3.1 Live**.
- Mapea el flujo de audio bidireccional entre la llamada y el modelo.

---

## 🎭 La Persona: Sonia
**Sonia** está configurada con un *System Prompt* diseñado para la interacción por voz en tiempo real:

- **Modelo**: `gemini-3.1-live`
- **Tono**: Profesional, empático y resolutivo.
- **Capacidades**:
    - **Google Search**: Para consultas de información actualizada.
    - **Baja Latencia**: Respuestas en menos de 500ms para una sensación natural.
    - **Acento**: Configurable según la región (ej. Colombia/Bogotá).

---

## 🚀 Pruebas
Una vez configurado, cualquier llamada al número de Netelip será atendida por Sonia en tiempo real, permitiendo interrupciones y cambios de tono dinámicos.
