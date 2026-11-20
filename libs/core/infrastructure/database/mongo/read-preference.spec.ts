// The tag sets are a constant: the env key that used to override them is
// gone, so a value left in a deployment's environment changes nothing.
describe('ANALYTICS_READ_PREFERENCE', () => {
    const load = () => {
        let preference: any;
        jest.isolateModules(() => {
            preference = require('./read-preference').ANALYTICS_READ_PREFERENCE;
        });
        return preference;
    };

    afterEach(() => {
        delete process.env.MONGO_ANALYTICS_READ_TAGS;
    });

    it('reads the analytics member first, then any secondary', () => {
        const preference = load();

        expect(preference.mode).toBe('secondaryPreferred');
        expect(preference.tags).toEqual([{ workload: 'analytics' }, {}]);
        expect(preference.maxStalenessSeconds).toBe(90);
    });

    it('ignores a MONGO_ANALYTICS_READ_TAGS value left in the environment', () => {
        process.env.MONGO_ANALYTICS_READ_TAGS = 'dc:east,workload:bi';

        expect(load().tags).toEqual([{ workload: 'analytics' }, {}]);
    });
});
