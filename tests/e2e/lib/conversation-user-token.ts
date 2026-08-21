import type { ProviderName } from "./types.js";

export interface ConversationUserToken {
    token: string | undefined;
    missingEnvHint: string;
}

// Resolves the "non-kody/kodus" second-identity credential the conversation
// scenarios need to post the `@kody <question>` trigger comment as — Kody
// ignores any comment whose author name/login contains "kody"/"kodus"
// (isKodyComment). Only GitHub's e2e driver account (GH_TEST_TOKEN =
// kodus-e2e-bot-N) is actually branded like that, which is why it alone
// needs a dedicated CONVERSATION_USER_TOKEN. GitLab/Bitbucket/Azure DevOps's
// existing driver credentials (GL_TEST_TOKEN, BB_TEST_USER/APP_PASSWORD,
// AZ_TEST_TOKEN) are already a plain human account (verified: "Gabriel
// Malinosqui" on all three) — no "kody"/"kodus" substring, so they already
// pass isKodyComment and can be reused as-is. No new secrets needed there.
export function resolveConversationUserToken(
    providerName: ProviderName,
): ConversationUserToken {
    switch (providerName) {
        case "gitlab":
            return {
                token: process.env.GL_TEST_TOKEN,
                missingEnvHint: "GL_TEST_TOKEN",
            };
        case "bitbucket":
            return {
                token: process.env.BB_TEST_APP_PASSWORD,
                missingEnvHint: "BB_TEST_APP_PASSWORD",
            };
        case "azure-devops":
            return {
                token: process.env.AZ_TEST_TOKEN,
                missingEnvHint: "AZ_TEST_TOKEN",
            };
        default:
            return {
                token: process.env.CONVERSATION_USER_TOKEN,
                missingEnvHint: "CONVERSATION_USER_TOKEN",
            };
    }
}
