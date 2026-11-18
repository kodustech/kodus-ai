import { PlannedTestSchema } from './run-plan';

// A planned test runs a repository's test file with a known runner, and nothing
// else: the planner reads the PR's diff, so its command is untrusted text that
// runs in both machines (s1-security-crosscut S1-02).

const test = (path: string, command: string) => ({ id: 't1', path, command, entryPoint: 'POST /login' });
const ok = (path: string, command: string) => PlannedTestSchema.safeParse(test(path, command)).success;

describe('PlannedTestSchema: the command is a known test runner on the file it names', () => {
    it.each([
        ['test/login.spec.ts', 'npx jest test/login.spec.ts'],
        ['test/login.spec.ts', 'jest --runInBand test/login.spec.ts'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts -t login'],
        ['src/login.test.ts', 'pnpm exec vitest run src/login.test.ts'],
        ['src/login.test.ts', 'npx vitest run ./src/login.test.ts'],
        ['test/login.test.js', 'npx mocha test/login.test.js'],
        ['test/login.test.js', 'node --test test/login.test.js'],
        ['e2e/login.spec.ts', 'npx playwright test e2e/login.spec.ts'],
        ['test/login.test.ts', 'bun test test/login.test.ts'],
        ['tests/test_login.py', 'pytest tests/test_login.py -q'],
        ['tests/test_login.py', 'python -m pytest -x tests/test_login.py'],
        ['pkg/api/login_test.go', 'go test ./pkg/api -run TestLogin'],
        ['pkg/api/login_test.go', 'go test -count=1 ./pkg/api'],
        ['spec/login_spec.rb', 'bundle exec rspec spec/login_spec.rb'],
    ])('accepts %s run by `%s`', (path, command) => {
        expect(ok(path, command)).toBe(true);
    });

    it.each([
        // A command that names the file but does not run it.
        ['test/login.spec.ts', 'true test/login.spec.ts'],
        ['test/login.spec.ts', 'echo test/login.spec.ts'],
        ['test/login.spec.ts', 'exit 0 test/login.spec.ts'],
        // Shell: a second command, a pipe, a substitution, a redirect, quotes.
        ['test/login.spec.ts', 'npx jest test/login.spec.ts; true'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts || true'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts | tail -1'],
        ['test/login.spec.ts', 'npx jest $(echo test/login.spec.ts)'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts > /dev/null'],
        ['test/login.spec.ts', "sh -c 'jest test/login.spec.ts'"],
        ['pkg/api/login_test.go', 'go test ./pkg/api -run A|sh'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts -t $HOME'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts &'],
        // A script, a config or a flag the repository's files decide.
        ['test/login.spec.ts', 'npm test -- test/login.spec.ts'],
        ['test/login.spec.ts', 'yarn test test/login.spec.ts'],
        ['test/login.spec.ts', 'npx jest --config=jest.other.js test/login.spec.ts'],
        ['test/login.spec.ts', 'npx jest --passWithNoTests test/login.spec.ts'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts --testPathIgnorePatterns=login'],
        // Another file, or the file twice, or none.
        ['test/login.spec.ts', 'npx jest test/other.spec.ts'],
        ['test/login.spec.ts', 'npx jest test/login.spec.ts.bak'],
        ['test/login.spec.ts', 'npx jest'],
        ['pkg/api/login_test.go', 'go test ./pkg/other -run TestLogin'],
        ['pkg/api/login_test.go', 'go test ./... -run TestLogin'],
        // A path that is not plain: a glob, a segment that walks, spaces.
        ['test/*.spec.ts', 'npx jest test/*.spec.ts'],
        ['test/./login.spec.ts', 'npx jest test/./login.spec.ts'],
        ['test/my login.spec.ts', 'npx jest test/my login.spec.ts'],
    ])('refuses %s run by `%s`', (path, command) => {
        expect(ok(path, command)).toBe(false);
    });
});
