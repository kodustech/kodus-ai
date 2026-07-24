#!/usr/bin/env node
/**
 * One-off probe: confirm the KIMI key works against Moonshot's OpenAI-compatible
 * endpoint and list the available model ids so the judge points at a real model
 * (a wrong model id 404s and wastes a review cycle). Prints only model ids — the
 * key is never echoed.
 */
require('dotenv').config();

const KEY = process.env.KIMI;
const BASE = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';

if (!KEY) {
    console.error('KIMI not set in .env');
    process.exit(1);
}

(async () => {
    const OpenAI = require('openai');
    const client = new OpenAI.default({ apiKey: KEY, baseURL: BASE });
    try {
        const res = await client.models.list();
        const ids = (res.data || []).map((m) => m.id).sort();
        console.log('OK — base:', BASE);
        console.log('models (' + ids.length + '):');
        for (const id of ids) console.log('  ' + id);
    } catch (err) {
        console.error('probe failed:', err?.status || '', String(err?.message || err).slice(0, 200));
        // surface the base host on auth/404 so we know if it's endpoint vs key
        console.error('base was:', BASE);
        process.exit(2);
    }
})();
