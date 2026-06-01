import { extractGitlabHost } from './gitlabPullRequest.handler';

describe('extractGitlabHost', () => {
    it('extracts host from project.git_http_url (real Ikatec payload shape)', () => {
        const payload = {
            project: {
                id: 93,
                git_http_url:
                    'https://gitlab.ikatec.cloud/agnus/agnuscloud.git',
                web_url: 'https://gitlab.ikatec.cloud/agnus/agnuscloud',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.ikatec.cloud');
    });

    it('extracts host from project.git_http_url for the colliding Omar Herrera payload', () => {
        const payload = {
            project: {
                id: 93,
                git_http_url:
                    'https://vcs.789.com.mx/omar.herrera/reune-clientes.git',
            },
        };

        expect(extractGitlabHost(payload)).toBe('vcs.789.com.mx');
    });

    it('lowercases the host', () => {
        const payload = {
            project: {
                git_http_url: 'https://GitLab.IKATEC.cloud/x/y.git',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.ikatec.cloud');
    });

    it('falls back to project.web_url when git_http_url is missing', () => {
        const payload = {
            project: {
                web_url: 'https://gitlab.example.com/a/b',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.example.com');
    });

    it('falls back to project.url when web_url is missing', () => {
        const payload = {
            project: {
                url: 'https://gitlab.example.com/a/b',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.example.com');
    });

    it('falls back to repository.url for older payload shapes', () => {
        const payload = {
            repository: {
                url: 'https://gitlab.example.com/a/b.git',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.example.com');
    });

    it('falls back to repository.homepage as last resort', () => {
        const payload = {
            repository: {
                homepage: 'https://gitlab.example.com/a/b',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.example.com');
    });

    it('handles SSH-style URLs by skipping them and using the next valid source', () => {
        // git_ssh_url isn't in the source list, but if someone replaces
        // git_http_url with an ssh URL the parser should fail and the next
        // candidate (web_url) should win.
        const payload = {
            project: {
                git_http_url: 'git@gitlab.example.com:a/b.git',
                web_url: 'https://gitlab.example.com/a/b',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.example.com');
    });

    it('returns undefined when no URL field is present', () => {
        const payload = { project: { id: 93 } };

        expect(extractGitlabHost(payload)).toBeUndefined();
    });

    it('returns undefined when payload is empty / null / undefined', () => {
        expect(extractGitlabHost(null)).toBeUndefined();
        expect(extractGitlabHost(undefined)).toBeUndefined();
        expect(extractGitlabHost({})).toBeUndefined();
    });

    it('returns undefined when all URL fields are non-string (corrupt payload)', () => {
        const payload = {
            project: {
                git_http_url: 12345,
                web_url: null,
                url: { not: 'a string' },
            },
            repository: {
                url: [],
                homepage: false,
            },
        };

        expect(extractGitlabHost(payload)).toBeUndefined();
    });

    it('skips empty strings and uses the first non-empty valid URL', () => {
        const payload = {
            project: {
                git_http_url: '',
                web_url: '',
                url: 'https://gitlab.example.com/a/b',
            },
        };

        expect(extractGitlabHost(payload)).toBe('gitlab.example.com');
    });

    it('strips port number from host (URL parser keeps it but we want the bare hostname)', () => {
        const payload = {
            project: {
                git_http_url: 'https://gitlab.example.com:8443/a/b.git',
            },
        };

        // URL.hostname does not include the port — covers the case where a
        // self-hosted GitLab listens on a non-standard port.
        expect(extractGitlabHost(payload)).toBe('gitlab.example.com');
    });
});
