import { LanguageSurface } from '../surface.types';
import {
    any,
    auth,
    commonSinks,
    entry,
    randomForSecret,
    sink,
    sqlInString,
} from './shared';

const VAR = String.raw`\$\{?[a-zA-Z_]`;
const SECRET_VAR = String.raw`\$\{?\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)`;

export const BASH_SURFACE: LanguageSurface = {
    language: 'bash',
    glob: '*.{sh,bash,zsh,ksh}',
    patterns: [
        entry('sh.args', String.raw`\$\{?[1-9@*]`, 'posix'),
        entry(
            'sh.read',
            String.raw`(?:^\s*|[;|&]\s*|\bwhile\s+(?:IFS=\S*\s+)?)read\s+-?\w|\bgetopts\b`,
            'posix',
        ),
        entry(
            'sh.cgi',
            String.raw`\$\{?(?:QUERY_STRING|REQUEST_METHOD|REQUEST_URI|PATH_INFO|HTTP_(?:USER_AGENT|COOKIE|REFERER|HOST|AUTHORIZATION|X_\w+))\b`,
            'cgi',
        ),

        // Shell scripts rarely authenticate; root/user checks are what gates them.
        auth(
            'sh.auth.privilege-check',
            String.raw`\$\{?E?UID\b|\bid\s+-u\b|\bsudo\s+-[nlv]\b`,
            'posix',
        ),

        sink(
            'sh.eval',
            'injection',
            'CWE-94',
            // `eval` as a command, not `--eval` flags of other tools.
            String.raw`(?:^|[;&|(]|\bthen|\bdo|\belse)\s*eval\s`,
        ),
        sink(
            'sh.exec.dynamic',
            'injection',
            'CWE-78',
            String.raw`\b(?:ba)?sh\s+-c\s+"[^"]*${VAR}|^\s*\$\{?[a-zA-Z_]\w*\}?\s+[\w-]|\bxargs\s+(?:-\S+\s+)*(?:ba)?sh\s+-c\b`,
        ),
        sink(
            'sh.sql.string-built',
            'injection',
            'CWE-89',
            sqlInString('"', VAR),
        ),
        sink(
            'sh.path.rm-variable',
            'injection',
            'CWE-22',
            String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+"?\$\{?\w+\}?"?/`,
        ),
        sink(
            'sh.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\b(?:curl|wget)\b.*${VAR}`,
        ),
        sink(
            'sh.log.secret',
            'data_exposure',
            'CWE-532',
            any(
                String.raw`\bset\s+-[a-wyz]*x`,
                String.raw`\b(?:echo|printf)\b.*${SECRET_VAR}`,
            ),
        ),
        sink(
            'sh.secret.unquoted',
            'secret_identity',
            'CWE-798',
            String.raw`\b\w*(?:PASSWORD|PASSWD|SECRET|API_?KEY|ACCESS_?TOKEN)\w*=[A-Za-z0-9_/+=-]{12,}`,
        ),
        sink(
            'sh.crypto.weak',
            'secret_identity',
            'CWE-327',
            String.raw`\bopenssl\s+passwd\s+-1\b|\bopenssl\s+enc\s+-(?:des|rc4|bf)\w*|\bopenssl\s+(?:md5|sha1)\b`,
        ),
        sink(
            'sh.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            randomForSecret(String.raw`\$RANDOM\b`),
        ),
        sink(
            'sh.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\bcurl\b.*\s(?:-k|--insecure)\b|\bwget\b.*--no-check-certificate|\bhttp\.sslVerify=false|\bGIT_SSL_NO_VERIFY\b`,
        ),
        ...commonSinks('sh', { ldap: false, xpath: false, sqlById: false }),
    ],
};
