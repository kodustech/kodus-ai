/**
 * Secret-leak tranche.
 *
 * The vulnerability tranche is built from published advisories, which never
 * contain credentials — so without these the benchmark scored every secret
 * scanner 0/0 and told us nothing. These are the positives; the credential
 * traps in `noise-samples.mjs` are the matching negatives.
 *
 * Every value here is SYNTHETIC: randomly generated strings shaped like the
 * credential format a detector matches. None is, or ever was, a live secret.
 * Vendors' own published example keys are deliberately avoided — detectors
 * allowlist those, so they would measure nothing.
 */

const added = (content) => {
    const lines = content.replace(/\n$/, '').split('\n');
    return [
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
    ].join('\n');
};

/** `secretLines` are 1-indexed into `content` — any of them counts as found. */
const sample = ({ id, kind, language, path, content, secretLines }) => ({
    id,
    tranche: 'vuln',
    cweLabel: 'hardcoded secret',
    severity: 'high',
    language,
    summary: kind,
    expected: [{ path, lines: secretLines }],
    golden_comments: [{ comment: kind, severity: 'High' }],
    files: [{ path, patch: added(content), content }],
});

export const SECRET_SAMPLES = [
    sample({
        id: 'secret-aws-access-key',
        kind: 'AWS access key id and secret committed in a settings module',
        language: 'python',
        path: 'app/settings/storage.py',
        content: `import boto3

client = boto3.client(
    "s3",
    aws_access_key_id="AKIA4XQ7ZLPMRWD3JK2V",
    aws_secret_access_key="hT2pRq8LmXv4NdYcJ9wEzB6sKfA3gUnQ7iOxVbMe",
)`,
        secretLines: [5, 6],
    }),

    sample({
        id: 'secret-github-pat',
        kind: 'GitHub personal access token in a release script',
        language: 'javascript',
        path: 'scripts/publish-release.js',
        content: `import { Octokit } from "@octokit/rest";

const octokit = new Octokit({
    auth: "ghp_9RmWkQ2xLpD7vTn4ZbJhYs6Fa8CgUe1XoNiV",
});

export default octokit;`,
        secretLines: [4],
    }),

    sample({
        id: 'secret-stripe-live-key',
        kind: 'Stripe live secret key in a payments client',
        language: 'typescript',
        path: 'packages/payments/src/client.ts',
        content: `import Stripe from "stripe";

export const stripe = new Stripe(
    "sk_live_5TqBnWzR8cHdKjMv2YxPeL7A4uGfSoQ9",
);`,
        secretLines: [4],
    }),

    sample({
        id: 'secret-private-key-block',
        kind: 'RSA private key checked into the repository',
        language: 'text',
        path: 'config/signing-key.pem',
        content: `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm
o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k
-----END RSA PRIVATE KEY-----`,
        secretLines: [1],
    }),

    sample({
        id: 'secret-slack-bot-token',
        kind: 'Slack bot token in a notifier',
        language: 'go',
        path: 'internal/notify/slack.go',
        content: `package notify

const slackToken = "xoxb-2947185036172-4period8x7Kq2mVnRzLpTdWc"

func Token() string {
	return slackToken
}`,
        secretLines: [3],
    }),

    sample({
        id: 'secret-generic-api-key-assignment',
        kind: 'High-entropy value assigned to an api key constant',
        language: 'ruby',
        path: 'app/clients/analytics.rb',
        content: `module Analytics
  API_KEY = "b7Kq2xR9mLpT4vZnW8cJdYfHs6AeGu3B"

  def self.key
    API_KEY
  end
end`,
        secretLines: [2],
    }),
];
