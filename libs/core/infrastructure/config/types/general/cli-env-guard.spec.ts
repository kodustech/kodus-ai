import {
    cliBinaryExposureProblem,
    cliEnvExposureProblem,
    cliPrefixExposureProblem,
    cliSecretReferenceProblem,
} from './cli-env-guard';

describe('cli env guard', () => {
    it.each([
        'printenv',
        'env',
        'set',
        'export',
        'declare -x',
        'run printenv',
        'show /proc/self/environ',
        'read ../../proc/1/environ',
        'auth token',
        'auth status --show-token',
        'auth status -t',
        'auth:token',
        'config get //registry.npmjs.org/:_authToken',
        'configure get aws_secret_access_key',
        'auth print-access-token',
        'account get-access-token',
    ])('refuses the prefix "%s"', (prefix) => {
        expect(cliPrefixExposureProblem(prefix)).not.toBeNull();
    });

    it.each([
        'check --format json',
        'deploy --env production',
        'helm --set image=1',
        'scan src/',
        'environment list',
        'auth status',
        'config list',
    ])('accepts the prefix "%s"', (prefix) => {
        expect(cliPrefixExposureProblem(prefix)).toBeNull();
    });

    it('matches whole tokens, case-insensitively', () => {
        expect(cliEnvExposureProblem(['PrintEnv'])).not.toBeNull();
        expect(cliEnvExposureProblem(['Auth', 'TOKEN'])).not.toBeNull();
        expect(cliEnvExposureProblem(['envoy', 'settings'])).toBeNull();
    });

    it.each(['bash', 'sh', 'node', 'python3', 'env', 'npx', 'awk', 'Perl'])(
        'refuses %s as the binary of a CLI with secrets',
        (binary) => {
            expect(cliBinaryExposureProblem(binary)).not.toBeNull();
        },
    );

    it('accepts a CLI binary of its own', () => {
        expect(cliBinaryExposureProblem('ledgerctl')).toBeNull();
    });

    it('refuses an argument that names a secret for expansion', () => {
        for (const arg of [
            '$LEDGER_TOKEN',
            'x=${LEDGER_TOKEN}',
            '${LEDGER_TOKEN:-x}',
        ]) {
            expect(
                cliSecretReferenceProblem([arg], ['LEDGER_TOKEN']),
            ).not.toBeNull();
        }
        expect(
            cliSecretReferenceProblem(
                ['$LEDGER_TOKENS', 'LEDGER_TOKEN'],
                ['LEDGER_TOKEN'],
            ),
        ).toBeNull();
    });
});
