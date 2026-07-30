import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
    githubTokenPool,
    makeGithubTokenPicker,
} from "../github-token-pool.js";

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

test("collapses to a single token when only GH_TEST_TOKEN is set", () => {
    assert.deepEqual(githubTokenPool(env({ GH_TEST_TOKEN: "a" })), ["a"]);
});

test("collects numbered siblings GH_TEST_TOKEN_2..N in order", () => {
    assert.deepEqual(
        githubTokenPool(
            env({ GH_TEST_TOKEN: "a", GH_TEST_TOKEN_2: "b", GH_TEST_TOKEN_3: "c" }),
        ),
        ["a", "b", "c"],
    );
});

test("GH_TEST_TOKENS list takes precedence and splits on comma/space/newline", () => {
    assert.deepEqual(
        githubTokenPool(
            env({ GH_TEST_TOKENS: "x, y\nz", GH_TEST_TOKEN: "ignored" }),
        ),
        ["x", "y", "z"],
    );
});

test("dedupes repeated tokens (same secret pasted twice)", () => {
    assert.deepEqual(
        githubTokenPool(env({ GH_TEST_TOKEN: "a", GH_TEST_TOKEN_2: "a" })),
        ["a"],
    );
});

test("empty env yields an empty pool (picker returns no token)", () => {
    assert.deepEqual(githubTokenPool(env({})), []);
    assert.deepEqual(makeGithubTokenPicker(env({}))(), {
        token: undefined,
        slot: 0,
        size: 0,
    });
});

test("picker round-robins tokens and reports a 1-based slot", () => {
    const pick = makeGithubTokenPicker(
        env({ GH_TEST_TOKEN: "a", GH_TEST_TOKEN_2: "b", GH_TEST_TOKEN_3: "c" }),
    );
    assert.deepEqual(
        [pick(), pick(), pick(), pick()].map((a) => `${a.token}:${a.slot}/${a.size}`),
        ["a:1/3", "b:2/3", "c:3/3", "a:1/3"],
    );
});
