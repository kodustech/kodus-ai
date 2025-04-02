import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { faker } from '@faker-js/faker';
import { ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';

import { DatabaseModule } from '../../../src/modules/database.module';
import { AuthModule } from '../../../src/modules/auth.module';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';

let app: NestExpressApplication;

describe('User Login', () => {
    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [DatabaseModule, AuthModule],
        }).compile();

        app = moduleRef.createNestApplication<NestExpressApplication>();
        app.useGlobalPipes(new ValidationPipe({ transform: true }));

        await app.init();
        await app.listen(0);
    });

    afterAll(async () => {
        await app.close();
    });

    // it('Should login a user with valid credentials', async () => {
    //     // const userRegister = {
    //     //     email: 'akalitemakinho@mail.com',
    //     //     password: 'Password!123',
    //     //     organizationName: faker.company.name(),
    //     // };

    //     // const create = await request(app.getHttpServer())
    //     //     .post('/auth/signUp')
    //     //     .send(userRegister);

    //     const response = await request(app.getHttpServer())
    //         .post('/auth/login')
    //         .send({
    //             email: 'akalitemakinho@mail.com',
    //             password: 'Password!123',
    //         });

    //     expect(response.status).toBe(201);
    //     expect(response.body).toHaveProperty('accessToken');
    //     expect(response.body).toHaveProperty('refreshToken');
    // });

    it('Should not login a user with empty email', async () => {
        const response = await request(app.getHttpServer())
            .post('/auth/login')
            .send({
                email: '',
                password: 'Password!123',
            });
        expect(response.status).toBe(401);
    });

    it('Should not login a user with empty password', async () => {
        const response = await request(app.getHttpServer())
            .post('/auth/login')
            .send({
                email: faker.internet.email(),
                password: '',
            });
        expect(response.status).toBe(401);
    });

    it('Should not login a user with incorrect credentials', async () => {
        const response = await request(app.getHttpServer())
            .post('/auth/login')
            .send({
                email: faker.internet.email(),
                password: '123!@PPAssss',
            });
        expect(response.status).toBe(401);
    });

    it('Should login in through oauth', async () => {
        const response = await request(app.getHttpServer())
            .post('/auth/oauth')
            .send({
                name: faker.person.fullName(),
                email: faker.internet.email(),
                refreshToken: faker.string.alphanumeric(20),
                authProvider: AuthProvider.GOOGLE,
            });
        expect(response.status).toBe(201);
    });
});
