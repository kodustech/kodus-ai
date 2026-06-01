import * as React from 'react';
import {
    Body,
    Container,
    Head,
    Hr,
    Html,
    Img,
    Link,
    Preview,
    Section,
    Text,
} from 'react-email';

// Brand tokens — mirror apps/web design system (`globals.css`).
//   --color-primary-light: #f8b76d   (button background, accents)
//   --color-primary-dark:  #443024   (button text on primary-light)
//   --color-background:    #101019   (dark header banner)
const PRIMARY_LIGHT = '#f8b76d';
const PRIMARY_DARK = '#443024';
const HEADER_BG = '#101019';

const TEXT_COLOR = '#1F2937';
const MUTED_COLOR = '#6B7280';
const PAGE_BG = '#F4F4F5';
const CARD_BG = '#FFFFFF';
const DIVIDER_COLOR = '#E5E7EB';

// White-on-dark wordmark, displayed against the dark header banner.
const LOGO_URL =
    'https://kodus.io/wp-content/uploads/2023/11/Kodus-logo-light.png';

const main: React.CSSProperties = {
    backgroundColor: PAGE_BG,
    fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif',
    margin: 0,
    padding: '24px 0',
};

const container: React.CSSProperties = {
    borderRadius: 8,
    margin: '0 auto',
    maxWidth: 560,
    overflow: 'hidden',
};

const header: React.CSSProperties = {
    backgroundColor: HEADER_BG,
    padding: '20px 40px',
};

const card: React.CSSProperties = {
    backgroundColor: CARD_BG,
    padding: '32px 40px',
};

const logo: React.CSSProperties = {
    height: 36,
    width: 'auto',
};

const footer: React.CSSProperties = {
    color: MUTED_COLOR,
    fontSize: 12,
    lineHeight: '18px',
    margin: 0,
    paddingTop: 16,
    textAlign: 'center',
};

const footerLink: React.CSSProperties = {
    color: MUTED_COLOR,
    textDecoration: 'underline',
};

const divider: React.CSSProperties = {
    borderColor: DIVIDER_COLOR,
    marginTop: 32,
    marginBottom: 16,
};

type Props = {
    preview: string;
    children: React.ReactNode;
};

export function BrandLayout({ preview, children }: Props) {
    return (
        <Html lang="en">
            <Head />
            <Preview>{preview}</Preview>
            <Body style={main}>
                <Container style={container}>
                    <Section style={header}>
                        <Img src={LOGO_URL} alt="Kodus" style={logo} />
                    </Section>
                    <Section style={card}>
                        {children}
                        <Hr style={divider} />
                        <Text style={footer}>
                            Kodus, LLC ·{' '}
                            <Link href="https://kodus.io" style={footerLink}>
                                kodus.io
                            </Link>
                        </Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
}

export const brandStyles = {
    PRIMARY_LIGHT,
    PRIMARY_DARK,
    TEXT_COLOR,
    MUTED_COLOR,
};

export const baseText: React.CSSProperties = {
    color: TEXT_COLOR,
    fontSize: 16,
    lineHeight: '24px',
    margin: '0 0 16px',
};

export const baseHeading: React.CSSProperties = {
    color: TEXT_COLOR,
    fontSize: 24,
    fontWeight: 600,
    lineHeight: '32px',
    margin: '0 0 16px',
};

export const baseButton: React.CSSProperties = {
    backgroundColor: PRIMARY_LIGHT,
    borderRadius: 6,
    color: PRIMARY_DARK,
    display: 'inline-block',
    fontSize: 15,
    fontWeight: 600,
    padding: '12px 24px',
    textDecoration: 'none',
};

export const mutedText: React.CSSProperties = {
    color: MUTED_COLOR,
    fontSize: 13,
    lineHeight: '20px',
    margin: '16px 0 0',
};
