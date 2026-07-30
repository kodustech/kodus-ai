import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import {
    githubAppToken,
    resetGithubAppTokenCache,
} from "../github-app-token.js";

/**
 * The refresh margin is a contract with the SCENARIOS, not a round number.
 *
 * The runner resolves one token per scenario, so a token handed out with
 * `margin - 1ms` left has to survive that entire scenario. When the margin was
 * 10min and command-review polls for 1502s, a review that never arrived kept
 * the scenario alive past the token's death: GitHub then answered 401 and the
 * failure read as a credential bug instead of "no review arrived" (QA matrix,
 * 2026-07-14).
 */
const LONGEST_SCENARIO_MS = 1502 * 1000; // command-review's own poll window

// Both encodings are required by the overload — omitting publicKeyEncoding
// falls through to the x448 signature and fails typecheck.
const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("githubAppToken refresh margin", () => {
    let server: Server;
    let apiBase: string;
    let mints: number;
    let expiresAt: string;

    const env = () => ({
        GH_APP_ID: "12345",
        GH_APP_PRIVATE_KEY: privateKey as string,
        GH_APP_INSTALLATION_ID: "67890",
    });

    before(async () => {
        server = createServer((req, res) => {
            mints += 1;
            res.writeHead(201, { "content-type": "application/json" });
            res.end(
                JSON.stringify({ token: `ghs-token-${mints}`, expires_at: expiresAt }),
            );
        });
        await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", () => resolve()),
        );
        apiBase = `http://127.0.0.1:${(server.address() as any).port}`;
    });

    after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        mints = 0;
        resetGithubAppTokenCache();
    });

    it("re-mints a token that could not outlive the longest scenario", async () => {
        // A token with just over 25min left: enough to pass a 10min margin,
        // NOT enough to carry command-review's 1502s poll to the end.
        expiresAt = new Date(Date.now() + LONGEST_SCENARIO_MS + 60_000).toISOString();
        const first = await githubAppToken(env(), apiBase);
        assert.equal(mints, 1);

        // The next scenario asks again. The cached token is still "valid", but
        // it would expire mid-scenario — it must NOT be reused.
        const second = await githubAppToken(env(), apiBase);

        assert.equal(mints, 2, "expected a re-mint, got the soon-to-expire token");
        assert.notEqual(second, first);
    });

    it("reuses a token that comfortably outlives the longest scenario", async () => {
        expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
        const first = await githubAppToken(env(), apiBase);
        const second = await githubAppToken(env(), apiBase);

        assert.equal(mints, 1, "a fresh 1h token must not be re-minted");
        assert.equal(second, first);
    });

    it("returns undefined when the App is not configured", async () => {
        assert.equal(await githubAppToken({}, apiBase), undefined);
        assert.equal(mints, 0);
    });
});
