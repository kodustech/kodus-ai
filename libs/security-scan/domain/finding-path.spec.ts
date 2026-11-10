import { admitFindingPath } from './finding-path';

const FILES = new Set([
    'app/views.py',
    'views.py',
    'tests/test_views.py',
    'static/js/jquery.min.js',
]);

describe('admitFindingPath', () => {
    it('keeps a tracked file, however the model prefixed it', () => {
        expect(admitFindingPath('app/views.py', FILES)).toEqual({
            file: 'app/views.py',
        });
        expect(admitFindingPath('./app/views.py', FILES)).toEqual({
            file: 'app/views.py',
        });
        expect(admitFindingPath('/app/views.py', FILES)).toEqual({
            file: 'app/views.py',
        });
    });

    it('matches a path carrying the checkout prefix by its longest tail', () => {
        expect(admitFindingPath('/tmp/repo-1/app/views.py', FILES)).toEqual({
            file: 'app/views.py',
        });
    });

    it('drops a path no tracked file matches', () => {
        expect(admitFindingPath('app/controllers.py', FILES)).toEqual({
            rejected: 'missing',
        });
        expect(admitFindingPath(undefined, FILES)).toEqual({
            rejected: 'missing',
        });
    });

    it('drops tests and vendored files, which the map never gives a lens', () => {
        expect(admitFindingPath('tests/test_views.py', FILES)).toEqual({
            rejected: 'not_app_code',
        });
        expect(admitFindingPath('static/js/jquery.min.js', FILES)).toEqual({
            rejected: 'not_app_code',
        });
    });
});
