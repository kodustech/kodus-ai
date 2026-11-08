import { LanguageSurface } from '../surface.types';
import {
    jcaCrypto,
    JPA_BY_ID_ONLY,
    JVM_EQUALS_COMPARE,
    springAuth,
    springEntries,
} from './jvm.shared';
import {
    any,
    commonSinks,
    entry,
    logsSensitive,
    sink,
    sqlConcat,
    SQL_SHAPE,
    timingCompare,
} from './shared';

/** Non-literal first argument: lowercase variable or a concatenation. */
const VAR_ARG = String.raw`(?:[a-z]\w*(?:\.\w+\(\))?\s*[,)+]|"[^"]*"\s*\+)`;

export const JAVA_SURFACE: LanguageSurface = {
    language: 'java',
    glob: '*.java',
    patterns: [
        ...springEntries('java'),
        entry(
            'java.servlet',
            String.raw`\bextends\s+HttpServlet\b|\bvoid\s+do(?:Get|Post|Put|Delete)\(|@WebServlet\(`,
            'servlet',
        ),
        entry(
            'java.cli.main',
            String.raw`\bpublic\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String|@CommandLine\.Command\b`,
            'cli',
        ),

        springAuth('java'),

        sink(
            'java.sql.string-built',
            'injection',
            'CWE-89',
            any(
                sqlConcat(),
                String.raw`\bString\.format\(\s*"[^"]*${SQL_SHAPE}`,
            ),
        ),
        sink(
            'java.sql.raw-call',
            'injection',
            'CWE-89',
            // A plain Statement takes the SQL at execute time; a
            // PreparedStatement's execute*() takes no argument.
            String.raw`\.(?:executeQuery|executeUpdate|execute|addBatch|prepareStatement|createQuery|createNativeQuery|createSQLQuery|queryForObject|queryForList)\(\s*(?:"[^"]*"\s*\+|[a-z]\w*\s*\+|String\.format\()|\.(?:executeQuery|executeUpdate|execute|addBatch)\(\s*[a-z]\w*\s*\)`,
        ),
        sink(
            'java.exec',
            'injection',
            'CWE-78',
            String.raw`Runtime\.getRuntime\(\)\.exec\(\s*(?:[a-z]\w*\s*[)+]|"[^"]*"\s*\+)|\bnew\s+ProcessBuilder\(\s*(?:"(?:sh|bash|/bin/sh|/bin/bash|cmd|cmd\.exe|powershell)"|[a-z]\w*\s*\))`,
        ),
        sink(
            'java.eval',
            'injection',
            'CWE-94',
            String.raw`\b\w*[Ee]ngine\.eval\(|\.getEngineByName\(|\bnew\s+GroovyShell\(|\.parseExpression\(\s*[a-z]|\bOgnl\.getValue\(|\bMVEL\.eval\(`,
        ),
        sink(
            'java.deserialize',
            'injection',
            'CWE-502',
            String.raw`\bnew\s+ObjectInputStream\(|\bnew\s+XMLDecoder\(|\.enableDefaultTyping\(|\bnew\s+Yaml\(\)\.load\(`,
        ),
        sink(
            'java.template.injection',
            'injection',
            'CWE-1336',
            String.raw`\b(?:Velocity|velocityEngine|ve)\.evaluate\(|\bnew\s+Template\([^)]*\bnew\s+StringReader\(|\.createTemplate\(\s*[a-z]`,
        ),
        sink(
            'java.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\bnew\s+File(?:InputStream|OutputStream|Reader|Writer)?\([^)]*(?:request\.get\w+\(|getOriginalFilename\(\))|\bPaths\.get\([^)]*(?:request\.get\w+\(|getOriginalFilename\(\))|\bgetOriginalFilename\(\)`,
        ),
        sink(
            'java.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\bnew\s+URL\(\s*${VAR_ARG}|\bURI\.create\(\s*${VAR_ARG}|\brestTemplate\.(?:getForObject|getForEntity|postForObject|postForEntity|exchange|execute)\(\s*${VAR_ARG}|\.uri\(\s*${VAR_ARG}|\bnew\s+Http(?:Get|Post|Put|Delete)\(\s*${VAR_ARG}|\.url\(\s*${VAR_ARG}`,
        ),
        sink(
            'java.orm.by-id-only',
            'authz',
            'CWE-639',
            JPA_BY_ID_ONLY,
            'spring-data/jpa',
        ),
        sink(
            'java.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:log|logger|LOG|LOGGER|Log)\.(?:info|debug|warn|error|trace|fine|severe|warning)\(|\bSystem\.(?:out|err)\.print\w*\(`,
            ),
        ),
        sink(
            'java.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\.printStackTrace\(\)|\.getStackTrace\(\)|\bResponseEntity\b[^;]*\b(?:e|ex|exception|err)\.(?:getMessage|toString)\(\)|\bgetWriter\(\)\.(?:print|println|write)\([^)]*\b(?:e|ex|exception)\b`,
        ),
        sink(
            'java.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\bResponseEntity\.ok\(\s*(?:user|users|account|\w*[Rr]epository\.find\w*\()`,
        ),
        ...jcaCrypto('java'),
        timingCompare('java', JVM_EQUALS_COMPARE),
        ...commonSinks('java', { nosql: true }),
    ],
};
