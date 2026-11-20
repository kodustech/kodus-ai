import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
    MetricsHoursQueryDto,
    MetricsWindowQueryDto,
} from '../metrics-query.dto';

// Query strings reach the controller as text: the DTO turns a whole number
// into a number and rejects anything else before a use case runs.
describe('metrics query DTOs', () => {
    const check = async (dto: any, query: Record<string, string>) => {
        const instance = plainToInstance(dto, query) as any;
        return { instance, errors: await validate(instance) };
    };

    it.each([
        [MetricsWindowQueryDto, 'window'],
        [MetricsHoursQueryDto, 'hours'],
    ])('%p turns a whole number into a number', async (dto, key) => {
        const { instance, errors } = await check(dto, { [key]: '60' });

        expect(errors).toEqual([]);
        expect(instance[key]).toBe(60);
    });

    it.each([
        [MetricsWindowQueryDto, 'window'],
        [MetricsHoursQueryDto, 'hours'],
    ])('%p rejects a value that is not a whole number', async (dto, key) => {
        for (const value of ['abc', '1.5']) {
            const { errors } = await check(dto, { [key]: value });
            expect(errors).not.toEqual([]);
        }
    });

    // As before this change: 0 or a blank value fall back to the default and a
    // negative one is clamped to the minimum, both in the use case. The DTO
    // lets these whole numbers through untouched.
    it.each([
        [MetricsWindowQueryDto, 'window'],
        [MetricsHoursQueryDto, 'hours'],
    ])(
        '%p hands 0, a blank value and a negative one to the use case',
        async (dto, key) => {
            for (const [value, expected] of [
                ['0', 0],
                ['', 0],
                ['-5', -5],
            ] as const) {
                const { instance, errors } = await check(dto, { [key]: value });
                expect(errors).toEqual([]);
                expect(instance[key]).toBe(expected);
            }
        },
    );

    it('accepts an absent value (the use case applies the default)', async () => {
        const { errors } = await check(MetricsWindowQueryDto, {});

        expect(errors).toEqual([]);
    });
});
