import { MailerSend, EmailParams, Sender, Recipient } from 'mailersend';

const sendInvite = async (user, adminUserEmail, invite) => {
    try {
        const mailersend = new MailerSend({
            apiKey: process.env.API_MAILSEND_API_TOKEN,
        });

        const recipients = [new Recipient(user.email, user.teamMember.name)];
        const sentFrom = new Sender(
            'kody@notifications.kodus.io',
            'Kody from Kodus',
        );

        const personalization = [
            {
                email: user.email,
                data: {
                    organizationName: user.organization.name,
                    invitingUser: {
                        email: adminUserEmail,
                    },
                    teamName: user.teamMember[0].team.name,
                    invitedUser: {
                        name: user.teamMember[0].name,
                        invite,
                    },
                },
            },
        ];

        const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject(
                `You've been invited to join ${user.teamMember[0].team.name}`,
            )
            .setTemplateId('351ndgwnvy5gzqx8')
            .setPersonalization(personalization);

        return await mailersend.email.send(emailParams);
    } catch (error) {
        console.log(error);
    }
};

export { sendInvite };
