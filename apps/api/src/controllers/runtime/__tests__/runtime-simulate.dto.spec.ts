import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RuntimeEnvironmentsController } from '../runtime-environments.controller';
import { SimulateRunDto } from '../runtime.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } });
const parse = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SimulateRunDto });

describe('Runtime simulation selection DTO and controller', () => {
    it('accepts a bounded PR array and forwards it unchanged to the use case', async () => {
        const body = await parse({ prNumbers: [4, 7, 9, 10, 11] });
        const execute = jest.fn(async () => ({ runs: [] }));
        const unused = undefined as never;
        const controller = new RuntimeEnvironmentsController(unused, unused, unused, unused, unused, unused, unused, unused, unused, unused, { execute } as never, unused, unused, unused, unused);
        await controller.simulateRun({ user: { uuid: 'fixture-user' } } as any, 'fixture-env', body);
        expect(execute).toHaveBeenCalledWith({ user: { uuid: 'fixture-user' }, environmentId: 'fixture-env', body: expect.objectContaining({ prNumbers: [4, 7, 9, 10, 11] }) });
    });

    it('preserves a single PR selection', async () => {
        expect(await parse({ prNumber: 42 })).toMatchObject({ prNumber: 42 });
    });

    it.each([
        {}, { prNumber: 1, prNumbers: [2] }, { prNumbers: [] }, { prNumbers: [1, 2, 3, 4, 5, 6] },
        { prNumbers: [1, 1] }, { prNumbers: [0] }, { prNumbers: [1.5] }, { prNumbers: ['1'] },
        { prNumbers: [1], unknown: true }, { prNumbers: null }, { prNumber: null },
    ])('refuses ambiguous, unknown or invalid selection %j', async (body) => {
        await expect(parse(body)).rejects.toBeInstanceOf(BadRequestException);
    });
});
