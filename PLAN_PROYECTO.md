# Plan del proyecto: Gemini SIP Bridge

Creado: 2026-10-18
Última actualización: 2026-10-19
Última revisión: 2026-10-19
Zona horaria: America/Bogota
Base de revisión: README, package.json, fuentes LiveKit/Google instaladas, configuración Swarm y módulos compilados activos capturados en privado. Sin llamadas telefónicas ni webhooks de prueba.
Fuente canónica: PLAN_PROYECTO.md para migración; README conserva operación histórica.
Estado del plan: autorizado por el usuario.

## Norte y alcance

Conservar telefonía SIP/LiveKit y voz existente trasladando Gemini al API Proxy con identidad propia. Credencial Google solo en proxy; preservar voz, modelo activo gemini-3.8-live, prompts, herramientas, LiveKit y webhooks. No llamar clientes ni modificar destinatarios, catálogo o prompts.

## Situación verificada

Swarm gemini-sip-bridge_gemini_bridge activo con clave antigua GOOGLE_API_KEY. Imagen fija por digest4f43f6aa, modelo3.8-live; análisis REST por defecto2.5-flash en módulo separado aunque el flujo activo usa sendCallSummary. Fuentes locales conservan modificación previa en lib/livekit-agent.ts y archivos nuevos del usuario. No incluirlos indiscriminadamente: preparar overlay mínimo de dos módulos compilados sobre imagen activa verificada, con helper de configuración nuevo. SDK instalado admite httpOptions.baseUrl/headers. No existe plan anterior.

## Hitos y tareas

| ID | Entregable / aceptación | Dependencia | Estado | Prioridad |
|---|---|---|---|---|
| SIP-01 | Identidad y relay Live/REST propios, sin clave compartida ni acceso cruzado; ledger | Autorización usuario | hecha | Solicitada |
| SIP-02 | Cliente LiveKit y análisis REST por proxy, preservar configuración y cambios previos | SIP-01 | hecha | P1 |
| SIP-03 | Pruebas SDK/relay con proveedor simulado, compilación y overlay mínimo verificado | SIP-02 | hecha | P1 |
| SIP-04 | Respaldo, activación y registro del worker; prueba sintética sin teléfono ni avisos | SIP-03 | hecha | P1 |

Migración SIP-01–SIP-04 completada; rotación LiveKit pendiente de acceso y decisión.

## Riesgos y decisiones

Usuario decide mantener y migrar este puente. Otros proyectos de barreras y WhatsApp son independientes. Restricción por IP permite al VPS completo, no solo al proceso proxy. Límites de sesiones/tokens no equivalen a presupuesto monetario. No considerar registro del worker como prueba telefónica extremo a extremo; la llamada física queda pendiente de prueba humana. Mantener configuraciones y versión anteriores para retorno sin sobrescribir datos.

## Backlog

Prueba humana de llamada y recepción de reportes; mantenimiento de dependencias y revisión separada de proveedores LiveKit.

## Próximo paso

Obtener acceso autorizado a LiveKit Cloud del mismo proyecto, emitir credenciales nuevas, comprobar el worker y retirar las anteriores. Mantener el puente activo.

## Implementación y pruebas locales — 2026-10-18

SIP-01/SIP-02 implementadas localmente: identidad gemini-sip, clave GEMINI_API_KEY_SIP solo en proxy; sipProxyOptions exige URL/token y no acepta GOOGLE_API_KEY de respaldo. Live conserva modelo activo3.8 y análisis2.5 predeterminado. Límites explícitos SIP:4 sesiones simultáneas,30 aperturas/hora,20 minutos/sesión,5 minutos sin tráfico,8192 tokens/salida y128MiB por sentido; Ayni/Onboarding conservan valores anteriores. No son presupuesto monetario.

SIP-03: compilación y prueba SDK real/relay real con proveedor simulado correctas. La prueba construye RealtimeModel con nueva configuración y transmite REST/PCM mediante Google SDK; verifica identidad, no fallback, límite de salida y ledger sin transcripción/credenciales. No es una llamada SIP ni dispara reportes. Cualquier adaptación de prueba local previa del usuario en livekit-agent se conserva fuera de la publicación; overlay utiliza JS del contenedor activo con cambios mínimos equivalentes.

## SIP-04 activado y verificado — 2026-10-19

Overlay mínimo sobre imagen previa activa; no publica modificaciones anteriores locales de audio/persona. Imagenproxy-b29018c, GOOGLE_API_KEY retirada ySIP_PROXY_URL/TOKEN propios. Worker registrado con mismo LiveKit; no había llamadas activas antes de activar. SDK desde contenedor → proxy → Google real devuelve32642bytes de audio, turno completo yuso577tokens observado. Ledger persistente porgemini-sip; ninguna llamada telefónica ni webhook de prueba. SIP-01 aSIP-04 hechos para migración.

Hallazgo de seguridad distinto y pendiente: las credenciales LiveKit activas coinciden con .env.example antiguo. Se dejaron vacías en la rama nueva, pero su historial y ramas anteriores permanecen; requiere par nuevo/registro del worker/revocación anterior en mismo proyecto LiveKit. No apagar teléfono: usuario ordena mantenerlo. No afirmar cierre completo del incidente por migrar Gemini.
