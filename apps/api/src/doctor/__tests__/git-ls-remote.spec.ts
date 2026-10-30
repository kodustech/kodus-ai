import { gitLsRemoteInvocation } from '../self-hosted-doctor.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('gitLsRemoteInvocation', () => {
    it('keeps the credential out of argv (ps, /proc/<pid>/cmdline)', () => {
        const token = 'ghp_planted_token_1234567890';
        const { args, env } = gitLsRemoteInvocation({
            url: 'https://github.com/acme/api',
            provider: 'GITHUB',
            auth: { token },
        });
        const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
        expect(args.join(' ')).not.toContain(token);
        expect(args.join(' ')).not.toContain(basic);
        expect(args).toEqual([
            '-c',
            'credential.helper=',
            'ls-remote',
            '--heads',
            'https://github.com/acme/api',
        ]);
        expect(env.GIT_CONFIG_COUNT).toBe('1');
        expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
        expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
        expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it('no credential → no auth header', () => {
        const { env } = gitLsRemoteInvocation({
            url: 'https://github.com/acme/api',
            provider: 'GITHUB',
        });
        expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    });

    it("keeps the admin's git config sources, drops injected entries", () => {
        const saved = { ...process.env };
        process.env.GIT_CONFIG_GLOBAL = '/etc/kodus/gitconfig';
        process.env.GIT_CONFIG_NOSYSTEM = '1';
        process.env.GIT_CONFIG_COUNT = '2';
        process.env.GIT_CONFIG_KEY_1 = 'http.extraHeader';
        process.env.GIT_CONFIG_VALUE_1 = 'Authorization: Basic someone-elses';
        process.env.GIT_CONFIG_PARAMETERS = "'http.proxy'='x'";
        try {
            const { env } = gitLsRemoteInvocation({
                url: 'https://github.com/acme/api',
                provider: 'GITHUB',
            });
            expect(env.GIT_CONFIG_GLOBAL).toBe('/etc/kodus/gitconfig');
            expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
            expect(env.GIT_CONFIG_COUNT).toBeUndefined();
            expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
            expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
            expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
        } finally {
            process.env = saved;
        }
    });
});
