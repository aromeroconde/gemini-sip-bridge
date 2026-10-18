// Backend-only configuration. Never fall back to a Google API key.
export function sipProxyOptions(env: NodeJS.ProcessEnv = process.env) {
    if (!env.SIP_PROXY_URL || !env.SIP_PROXY_TOKEN) throw new Error('Configura SIP_PROXY_URL y SIP_PROXY_TOKEN en el servidor.');
    const url = new URL(env.SIP_PROXY_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('El proxy SIP requiere HTTPS; HTTP solo en loopback.');
    return { apiKey: 'proxy', httpOptions: { baseUrl: `${url.origin}/proxy/gemini-sip`, apiVersion: 'v1beta', headers: { 'x-proxy-token': env.SIP_PROXY_TOKEN } } };
}
export function sipProxyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    try { sipProxyOptions(env); return true; } catch { return false; }
}
