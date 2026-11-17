import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { SmtpEmailProvider } from './smtp-email.provider';

const sendMail = jest.fn().mockResolvedValue({ messageId: 'msg-1' });

jest.mock('nodemailer', () => ({
    createTransport: jest.fn(() => ({ sendMail })),
}));

describe('SmtpEmailProvider', () => {
    const buildProvider = async (configValues: Record<string, string | undefined>) => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                SmtpEmailProvider,
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn(
                            <T = string>(key: string, fallback?: T): T | undefined =>
                                (configValues[key] as T | undefined) ?? fallback,
                        ),
                    },
                },
            ],
        }).compile();

        return moduleRef.get(SmtpEmailProvider);
    };

    const templateFrom = 'Kody from Kodus <noreply@notifications.kodus.io>';
    const send = (provider: SmtpEmailProvider, from: string) =>
        provider.send({
            from,
            to: 'user@example.com',
            subject: 'Test',
            html: '<p>Hi</p>',
        });

    beforeEach(() => sendMail.mockClear());

    it('uses API_SMTP_FROM over the template sender, keeping its display name', async () => {
        const provider = await buildProvider({ API_SMTP_FROM: 'bot@acme.test' });
        await send(provider, templateFrom);

        expect(sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                from: { name: 'Kody from Kodus', address: 'bot@acme.test' },
            }),
        );
    });

    it('uses API_SMTP_FROM as-is when it already carries a display name', async () => {
        const provider = await buildProvider({ API_SMTP_FROM: 'Acme Bot <bot@acme.test>' });
        await send(provider, templateFrom);

        expect(sendMail).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'Acme Bot <bot@acme.test>' }),
        );
    });

    it('uses API_SMTP_FROM alone when the template sender has no display name', async () => {
        const provider = await buildProvider({ API_SMTP_FROM: 'bot@acme.test' });
        await send(provider, 'noreply@notifications.kodus.io');

        expect(sendMail).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'bot@acme.test' }),
        );
    });

    it('keeps the template sender when API_SMTP_FROM is unset or blank', async () => {
        for (const value of [undefined, '', '  ']) {
            sendMail.mockClear();
            const provider = await buildProvider({ API_SMTP_FROM: value });
            await send(provider, templateFrom);

            expect(sendMail).toHaveBeenCalledWith(
                expect.objectContaining({ from: templateFrom }),
            );
        }
    });
});
