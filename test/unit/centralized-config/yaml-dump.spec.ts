/**
 * Issue #1688 was fixed at one of three `yaml.dump` call sites on the
 * centralized-config pull request path. The other two take
 * `configFileContent`, which is built from request bodies just like the rule
 * payload was, so the same 500 is reachable from saving code review settings
 * or a custom PR message.
 *
 * Why it looks intermittent: `deepMerge` assigns a value by reference when
 * the base config does not already carry that key, so the DTO instance
 * survives only the FIRST time a user sets that field on a given scope. Set
 * it a second time and the merge rebuilds it as a plain object and the crash
 * disappears.
 */
import * as yaml from 'js-yaml';

import { deepMerge } from '@libs/common/utils/deep';
import { dumpCentralizedYaml } from '@libs/centralized-config/utils/yaml-dump';

/** Stands in for any `@Type(() => Dto)` nested class, e.g. SeverityLimitsDto. */
class SeverityLimitsDto {
    high: number;
}

function nestedDto() {
    const dto = new SeverityLimitsDto();
    dto.high = 5;
    return dto;
}

describe('dumpCentralizedYaml', () => {
    it('dumps a payload carrying a nested DTO instance', () => {
        const parsed = yaml.load(
            dumpCentralizedYaml({
                languageResultPrompt: 'en-US',
                severityLimits: nestedDto(),
            }),
        ) as Record<string, any>;

        expect(parsed).toEqual({
            languageResultPrompt: 'en-US',
            severityLimits: { high: 5 },
        });
    });

    it('is what makes that payload dumpable at all', () => {
        // Non-vacuous: the raw dump this replaces is the reported 500.
        expect(() =>
            yaml.dump({ severityLimits: nestedDto() }),
        ).toThrow(/unacceptable kind of an object/);
    });

    it('leaves an already-plain payload byte-for-byte unchanged', () => {
        const plain = {
            languageResultPrompt: 'en-US',
            severityLimits: { high: 5 },
            reviewOptions: { security: true },
            ignorePaths: ['dist/**'],
        };

        expect(dumpCentralizedYaml(plain)).toBe(yaml.dump(plain));
    });

    it('drops undefined exactly like yaml.dump already did', () => {
        expect(dumpCentralizedYaml({ a: undefined, b: 1 })).toBe(
            yaml.dump({ a: undefined, b: 1 }),
        );
    });

    it('survives a circular payload instead of throwing a JSON error', () => {
        const circular: any = { a: 1 };
        circular.self = circular;

        // js-yaml handles cycles with an anchor; the JSON round trip would
        // have thrown a TypeError, which would be a worse error than the one
        // this helper exists to prevent.
        expect(() => dumpCentralizedYaml(circular)).not.toThrow();
    });
});

describe('the reachable path: deepMerge hands the instance straight through', () => {
    it('a first-time field keeps its prototype all the way to the dump', () => {
        const base = { languageResultPrompt: 'en-US' }; // no severityLimits yet
        const merged = deepMerge(base as any, {
            severityLimits: nestedDto(),
        } as any);

        // What the use case builds — a top-level spread does not deep-clone.
        const configFileContent = { ...(merged as any) };

        expect(configFileContent.severityLimits).toBeInstanceOf(
            SeverityLimitsDto,
        );
        expect(() => dumpCentralizedYaml(configFileContent)).not.toThrow();
    });

    it('a field that already existed is rebuilt plain, which is why this hid', () => {
        const base = { severityLimits: { high: 1 } };
        const merged = deepMerge(base as any, {
            severityLimits: nestedDto(),
        } as any);

        expect((merged as any).severityLimits).not.toBeInstanceOf(
            SeverityLimitsDto,
        );
    });
});
