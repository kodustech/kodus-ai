import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { SignUpDTO } from '@libs/identity/dtos/create-user-organization.dto';

// Same options as the global pipe in apps/api/src/main.ts.
const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
});

const run = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: SignUpDTO });

describe('SignUpDTO', () => {
    const signUp = {
        name: 'Jane',
        email: 'jane@example.com',
        password: 'Str0ngP@ssw0rd!',
    };

    it('accepts a plain signup', async () => {
        await expect(run(signUp)).resolves.toMatchObject(signUp);
    });

    it('rejects an organizationId: signup never joins an existing organization', async () => {
        await expect(
            run({ ...signUp, organizationId: 'org-1' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
