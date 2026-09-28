/**
 * Precision tranche: diffs that LOOK like security findings and are not.
 *
 * The vulnerability tranche measures recall. This measures the failure mode we
 * actually observed: running stock rule packs over 50 real PRs produced 38
 * in-diff findings for 1 true positive, and gitleaks produced 11 findings that
 * were all false — i18n strings, an .env.example, a JWT in a test fixture,
 * Java constants. A tool that scores well here is one we can publish from.
 *
 * Every value below is synthetic. Credential-shaped strings use vendors' own
 * published example values or obvious placeholders — nothing here is, or
 * resembles, a live secret.
 */

/** Builds an added-file patch. Simpler and safer than hand-writing hunks. */
const added = (content) => {
    const lines = content.replace(/\n$/, '').split('\n');
    return [
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
    ].join('\n');
};

const sample = ({ id, trap, language, path, content }) => ({
    id,
    tranche: 'noise',
    language,
    trap,
    summary: trap,
    // Nothing in a noise sample is a real finding; anything reported is a
    // false positive by construction.
    expected: [],
    golden_comments: [],
    files: [{ path, patch: added(content), content }],
});

export const NOISE_SAMPLES = [
    sample({
        id: 'noise-i18n-security-strings',
        trap: 'Translation entries whose keys name credentials and whose values are prose',
        language: 'json',
        path: 'public/locales/en/common.json',
        content: `{
  "disable_2fa": "Disable two-factor authentication",
  "api_key_revoked_toast": "That API key has been revoked",
  "secret_key_help": "Your secret key is shown once and cannot be retrieved later",
  "personal_access_token_label": "Personal access token",
  "webhook_signing_secret_hint": "Use this signing secret to verify payloads"
}`,
    }),

    sample({
        id: 'noise-config-option-registration',
        trap: 'Config registry declaring option NAMES like "secret-key" — no values',
        language: 'python',
        path: 'src/app/options/defaults.py',
        content: `from app.options import FLAG_CREDENTIAL, FLAG_NOSTORE, register

register("system.secret-key", flags=FLAG_CREDENTIAL | FLAG_NOSTORE)
register("system.root-api-key", flags=FLAG_CREDENTIAL | FLAG_NOSTORE)
register("mail.smtp-password", flags=FLAG_CREDENTIAL | FLAG_NOSTORE)
register("system.logging-format", default="human", flags=FLAG_NOSTORE)`,
    }),

    sample({
        id: 'noise-credential-field-names',
        trap: 'Schema listing credential field names for a settings form',
        language: 'typescript',
        path: 'src/settings/integration-fields.ts',
        content: `export const INTEGRATION_FIELDS = [
    { name: 'apiKey', label: 'API key', secret: true },
    { name: 'clientSecret', label: 'Client secret', secret: true },
    { name: 'signingToken', label: 'Signing token', secret: true },
    { name: 'accountRegion', label: 'Region', secret: false },
] as const;`,
    }),

    sample({
        id: 'noise-java-permission-constants',
        trap: 'Long permission-name constants read as an API key',
        language: 'java',
        path: 'src/main/java/com/example/authz/PermissionNames.java',
        content: `package com.example.authz;

public final class PermissionNames {
    public static final String MANAGE_ORGANIZATION_MEMBERSHIP = "manage-organization-membership";
    public static final String VIEW_BILLING_STATEMENTS_HISTORY = "view-billing-statements-history";
    public static final String ADMINISTER_WORKSPACE_INTEGRATIONS = "administer-workspace-integrations";

    private PermissionNames() {}
}`,
    }),

    sample({
        id: 'noise-env-example-placeholders',
        trap: 'An .env.example whose placeholder values are credential-shaped',
        language: 'shell',
        path: '.env.example',
        content: `# Copy to .env and fill in real values before running.
DATABASE_URL=postgresql://user:password@localhost:5432/appdb
SESSION_SECRET=replace-me-with-a-random-32-byte-string
STRIPE_API_KEY=sk_test_your_key_here
WEBHOOK_SIGNING_SECRET=whsec_placeholder_value_goes_here`,
    }),

    sample({
        id: 'noise-hardened-xml-parser',
        trap: 'XML parser that DOES disable doctype declarations',
        language: 'java',
        path: 'src/main/java/com/example/xml/SafeParser.java',
        content: `package com.example.xml;

import javax.xml.parsers.DocumentBuilderFactory;

public final class SafeParser {
    public static DocumentBuilderFactory factory() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        // External entities cannot be declared, so XXE is not reachable.
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        return factory;
    }
}`,
    }),

    sample({
        id: 'noise-innerhtml-static-literal',
        trap: 'Raw HTML assignment whose value is an authored constant',
        language: 'javascript',
        path: 'src/ui/empty-state.js',
        content: `export function renderEmptyState(el) {
    // Authored markup, no interpolation, nothing user-controlled.
    el.innerHTML = "<p class='empty'>Nothing to show yet.</p>";
}`,
    }),

    sample({
        id: 'noise-inline-parameterized-query',
        trap: 'Inline SQL string passed with bind parameters',
        language: 'python',
        path: 'app/repositories/customers.py',
        content: `def find_customer(conn, customer_id):
    with conn.cursor() as cursor:
        cursor.execute("SELECT id, email FROM customers WHERE id = %s", (customer_id,))
        return cursor.fetchone()`,
    }),

    sample({
        id: 'noise-safe-execfile',
        trap: 'Argument-array subprocess call — the safe form of command injection',
        language: 'javascript',
        path: 'src/git/merge-base.js',
        content: `import { execFileSync } from 'node:child_process';

export function gitMergeBase({ base, head }) {
    // Arguments are passed as an array, so no shell is involved and branch
    // names cannot break out into a command.
    return execFileSync('git', ['merge-base', head, base]).toString().trim();
}`,
    }),

    sample({
        id: 'noise-parameterized-sql',
        trap: 'Parameterized query that resembles string-built SQL',
        language: 'python',
        path: 'app/repositories/orders.py',
        content: `def find_orders_for_customer(conn, customer_id, status):
    query = """
        SELECT id, total_cents, status
        FROM orders
        WHERE customer_id = %s AND status = %s
        ORDER BY created_at DESC
    """
    with conn.cursor() as cursor:
        cursor.execute(query, (customer_id, status))
        return cursor.fetchall()`,
    }),

    sample({
        id: 'noise-constant-url-fetch',
        trap: 'Outbound request to a hardcoded internal URL — not user-controlled',
        language: 'ruby',
        path: 'app/services/release_notes_fetcher.rb',
        content: `require 'open-uri'

class ReleaseNotesFetcher
  FEED_URL = 'https://updates.internal.example.com/release-notes.json'.freeze

  # The URL is a frozen constant; no caller-supplied value reaches it.
  def fetch
    URI.parse(FEED_URL).open(read_timeout: 5).read
  end
end`,
    }),

    sample({
        id: 'noise-escaped-template-output',
        trap: 'Template interpolation that is explicitly escaped',
        language: 'ruby',
        path: 'app/views/profiles/_website.html.erb',
        content: `<div class="profile-website">
  <%# ERB escapes by default; the helper escapes the attribute too. %>
  <%= link_to h(profile.website_label), profile.website_url, rel: 'nofollow noopener' %>
</div>`,
    }),

    sample({
        id: 'noise-hash-comparison-constant-time',
        trap: 'Digest comparison that already uses a constant-time helper',
        language: 'python',
        path: 'app/security/webhook_signature.py',
        content: `import hashlib
import hmac


def verify(secret: bytes, payload: bytes, provided_signature: str) -> bool:
    expected = hmac.new(secret, payload, hashlib.sha256).hexdigest()
    # compare_digest is constant time; a plain == here would leak timing.
    return hmac.compare_digest(expected, provided_signature)`,
    }),

    sample({
        id: 'noise-documented-example-key',
        trap: 'Credential-shaped string inside documentation',
        language: 'markdown',
        path: 'docs/integrations/webhooks.md',
        content: `# Verifying webhook signatures

Every request carries an \`X-Signature\` header. Example configuration:

    WEBHOOK_KEY=whsec_0123456789abcdef0123456789abcdef

Replace the example above with the signing key shown in your dashboard.`,
    }),
];
