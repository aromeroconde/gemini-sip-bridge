/**
 * Catálogo de precios
 *
 * Mantiene una copia en memoria del catálogo de precios y promociones,
 * persistida en data/precios.md. Se refresca desde el webhook de n8n
 * (PRECIO_WEBHOOK_URL) cada 10 minutos, o al arrancar el worker.
 *
 * El tool `precio` lee desde memoria — acceso instantáneo, sin HTTP.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '../../data/precios.md');
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

let catalog: string = '';

export function getCatalog(): string {
    return catalog;
}

async function refreshCatalog(): Promise<void> {
    const url = process.env.PRECIO_WEBHOOK_URL;
    if (!url) {
        console.warn('[Catalog] PRECIO_WEBHOOK_URL no configurada — usando seed local');
        return;
    }
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'catalog_refresh' }),
            signal: AbortSignal.timeout(20000),
        });
        if (!resp.ok) {
            console.error(`[Catalog] Refresh fallido: ${resp.status}`);
            return;
        }
        const text = await resp.text();
        let data: any;
        try { data = JSON.parse(text); } catch { data = text.trim(); }
        const content = Array.isArray(data) && data[0]?.['Precios y Promociones']
            ? data[0]['Precios y Promociones']
            : (typeof data === 'string' ? data : JSON.stringify(data));
        if (content && content !== catalog) {
            catalog = content;
            try {
                fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
                fs.writeFileSync(CATALOG_FILE, content, 'utf-8');
                console.log(`[Catalog] Refrescado y persistido (${content.length} chars)`);
            } catch (err) {
                console.error('[Catalog] No se pudo persistir a disco:', err);
            }
        }
    } catch (err) {
        console.error('[Catalog] Error refrescando:', err);
    }
}

// Carga inicial desde disco (seed o último refresh persistido)
try {
    if (fs.existsSync(CATALOG_FILE)) {
        catalog = fs.readFileSync(CATALOG_FILE, 'utf-8');
        console.log(`[Catalog] Cargado desde disco (${catalog.length} chars)`);
    } else {
        console.warn('[Catalog] No existe seed en disco — se cargará al primer refresh');
    }
} catch (err) {
    console.error('[Catalog] Error leyendo disco:', err);
}

// Refresh inicial (no bloqueante) + refresh periódico cada 10 min
refreshCatalog();
setInterval(refreshCatalog, REFRESH_INTERVAL_MS);
