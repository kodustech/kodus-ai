import { describeSurfaceCases } from '../testing/surface-cases';
import { BASH_SURFACE } from './bash.surface';

describeSurfaceCases(BASH_SURFACE, 'scripts/deploy.sh', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'sh.args',
        code: 'TARGET="$1"',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'sh.args',
        code: 'for f in "$@"; do',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'sh.read',
        code: 'read -r -p "Branch: " BRANCH',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'sh.cgi',
        file: 'cgi-bin/search.sh',
        code: 'q=$(echo "$QUERY_STRING" | cut -d= -f2)',
    },
    { role: 'entry_point', match: false, code: 'echo "done"' },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'sh.auth.privilege-check',
        code: 'if [ "$EUID" -ne 0 ]; then echo "run as root"; exit 1; fi',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'sh.eval',
        code: 'eval "$CMD"',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'sh.exec.dynamic',
        code: 'bash -c "git checkout $BRANCH"',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'sh.exec.dynamic',
        code: '$RUNNER --config "$CONFIG"',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'sh.sql.string-built',
        code: 'psql -c "SELECT * FROM users WHERE name = \'$NAME\'"',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'sh.path.rm-variable',
        code: 'rm -rf "$BUILD_DIR"/',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: 'git checkout -- "$BRANCH"',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: 'printf \'%s\\n\' "$1"',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'sh.http.variable-url',
        code: 'curl -fsSL "$WEBHOOK_URL" -d @payload.json',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: 'curl -fsSL https://example.com/health',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'sh.log.secret',
        code: 'set -euxo pipefail',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'sh.log.secret',
        code: 'echo "using token $GITHUB_TOKEN"',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: 'set -euo pipefail',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'sh.common.hardcoded-secret',
        code: 'DB_PASSWORD="s3cr3tP@ssw0rd"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'sh.secret.unquoted',
        code: 'export API_KEY=abcdef0123456789',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'sh.crypto.weak',
        code: 'HASH=$(openssl passwd -1 "$PASS")',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'sh.crypto.insecure-random',
        code: 'TOKEN=$RANDOM$RANDOM',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'sh.tls.verification-disabled',
        code: 'curl -k https://internal.example.com/api',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: 'DB_PASSWORD="${DB_PASSWORD:?missing}"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: 'TOKEN=$(openssl rand -hex 32)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'sh.tls.verification-disabled',
        code: 'curl -sS --insecure https://internal.example.com/api',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'sh.tls.verification-disabled',
        code: 'wget --no-check-certificate https://internal.example.com/a.tgz',
    },
    {
        // Another option that only starts like --insecure.
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: 'curl --insecure-skip-tls-verify=false https://example.com',
    },
]);
