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

    it('accepts an absent value (the use case applies the default)', async () => {
        const { errors } = await check(MetricsWindowQueryDto, {});

        expect(errors).toEqual([]);
    });
});
