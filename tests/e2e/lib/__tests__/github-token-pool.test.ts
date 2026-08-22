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

test("ignores obsolete token-pool variables", () => {
    assert.deepEqual(
        githubTokenPool(
            env({
                GH_TEST_TOKEN: "a",
                GH_TEST_TOKEN_2: "b",
                GH_TEST_TOKEN_3: "c",
                GH_TEST_TOKENS: "x,y,z",
            }),
        ),
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

test("picker always returns the single human author token", () => {
    const pick = makeGithubTokenPicker(
        env({ GH_TEST_TOKEN: "a", GH_TEST_TOKEN_2: "b", GH_TEST_TOKEN_3: "c" }),
    );
    assert.deepEqual(
        [pick(), pick(), pick(), pick()].map((a) => `${a.token}:${a.slot}/${a.size}`),
        ["a:1/1", "a:1/1", "a:1/1", "a:1/1"],
    );
});
