// The dedup's embedder, as an eval runs it. Production builds it from the
// platform's OpenAI key alone (libs/common/utils/document.ts,
// buildPlatformEmbedder), so a self-hosted install without that key has none
// (#2170). `--embedder=none` runs the eval that way: the key is removed from
// this process before the review code reads it, and the result records both
// what was asked and what the embedder did.
const EMBEDDERS = ['platform', 'none'];

/** Reads `--embedder` (default `platform`); throws on any other value. */
function parseEmbedder(value) {
    const embedder =
        value === undefined || value === true ? 'platform' : String(value);
    if (!EMBEDDERS.includes(embedder)) {
        throw new Error(
            `unknown --embedder=${embedder}: ${EMBEDDERS.join(' or ')}`,
        );
    }
    return embedder;
}

/** Removes the platform key for `none`. Call it after the eval's model route
 *  is set up: applyPlatformEnv (tier0-models.js) writes that key. */
function applyEmbedder(embedder) {
    if (embedder === 'none') delete process.env.API_OPEN_AI_API_KEY;
}

// Whether the platform embedder answered: the dedup's semantic tier needs it,
// and without it the guard decides differently.
function watchEmbeddings(requested) {
    const seen = { calls: 0, failed: 0 };
    const inner = globalThis.fetch;
    globalThis.fetch = async function fetchWatchingEmbeddings(url, init) {
        const embedding = /\/embeddings\b/.test(String(url?.url || url));
        try {
            const response = await inner(url, init);
            if (embedding) {
                seen.calls += 1;
                if (!response.ok) seen.failed += 1;
            }
            return response;
        } catch (error) {
            if (embedding) {
                seen.calls += 1;
                seen.failed += 1;
            }
            throw error;
        }
    };
    return () => ({
        embedderRequested: requested,
        embedder: !seen.calls
            ? 'not called'
            : seen.failed === seen.calls
              ? 'failed'
              : seen.failed
                ? 'partly failed'
                : 'answered',
        embeddingCalls: seen.calls,
        embeddingFailures: seen.failed,
    });
}

module.exports = { EMBEDDERS, parseEmbedder, applyEmbedder, watchEmbeddings };
