import { GithubService } from './github.service';

describe('GithubService.getGithubAppId', () => {
    function createService(appId: string | undefined): GithubService {
        const svc: any = Object.create(GithubService.prototype);
        svc.configService = { get: jest.fn().mockReturnValue(appId) };
        return svc;
    }

    it('returns the App id this deployment authenticates as', () => {
        expect(createService(' 123456 ').getGithubAppId()).toBe(123456);
    });

    it.each([undefined, '', 'not-a-number'])(
        'returns undefined when the App id is %p',
        (appId) => {
            expect(createService(appId).getGithubAppId()).toBeUndefined();
        },
    );
});
