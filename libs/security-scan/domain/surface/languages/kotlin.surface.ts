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
    auth,
    commonSinks,
    entry,
    logsSensitive,
    sink,
    sqlConcat,
    sqlInString,
    timingCompare,
} from './shared';

/** Kotlin string templates: `"$x"` / `"${x}"` (`$1` is a SQL placeholder, not a template). */
const TEMPLATE = String.raw`\$\{?[a-zA-Z_]`;
const VAR_ARG = String.raw`(?:[a-z]\w*(?:\.\w+)*\s*[,)+]|"[^"]*${TEMPLATE}|"[^"]*"\s*\+)`;

export const KOTLIN_SURFACE: LanguageSurface = {
    language: 'kotlin',
    glob: '*.{kt,kts}',
    patterns: [
        ...springEntries('kt'),
        entry(
            'kt.ktor.route',
            String.raw`^\s*(?:get|post|put|patch|delete|head|options|route)\(\s*"/|\brouting\s*\{`,
            'ktor',
        ),
        entry(
            'kt.cli.main',
            String.raw`\bfun\s+main\s*\(\s*args\s*:\s*Array<String>|:\s*CliktCommand\(`,
            'cli',
        ),

        springAuth('kt'),
        auth(
            'kt.ktor.auth',
            String.raw`\bauthenticate\(\s*(?:"[^"]*"\s*(?:,\s*"[^"]*"\s*)*)?\)\s*\{|\binstall\(\s*Authentication\s*\)|\.principal<`,
            'ktor',
        ),

        sink(
            'kt.sql.string-built',
            'injection',
            'CWE-89',
            any(sqlConcat(), sqlInString('"', TEMPLATE)),
        ),
        sink(
            'kt.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\.(?:executeQuery|executeUpdate|execute|addBatch|exec)\(\s*[a-z]\w*\s*\)|\.(?:createQuery|createNativeQuery|prepareStatement)\(\s*"[^"]*(?:${TEMPLATE}|"\s*\+)`,
        ),
        sink(
            'kt.exec',
            'injection',
            'CWE-78',
            String.raw`Runtime\.getRuntime\(\)\.exec\(\s*(?:[a-z]\w*\s*[)+]|"[^"]*(?:${TEMPLATE}|"\s*\+))|\bProcessBuilder\(\s*(?:listOf\(\s*)?(?:"(?:sh|bash|/bin/sh|/bin/bash|cmd|cmd\.exe|powershell)"|[a-z]\w*\s*\))`,
        ),
        sink(
            'kt.eval',
            'injection',
            'CWE-94',
            String.raw`\b\w*[Ee]ngine\.eval\(|\.getEngineByName\(|\.parseExpression\(\s*[a-z]|\bObjectInputStream\(`,
        ),
        sink(
            'kt.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\bFile\(\s*(?:"[^"]*${TEMPLATE}|[^)]*\bcall\.(?:parameters|request)|[^)]*getOriginalFilename\(\))|\bcall\.respondFile\(\s*[^)]*\bcall\.parameters`,
        ),
        sink(
            'kt.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\bURL\(\s*${VAR_ARG}|\b(?:client|httpClient)\.(?:get|post|put|delete|patch|request)\(\s*${VAR_ARG}|\brestTemplate\.(?:getForObject|getForEntity|postForObject|exchange)\(\s*${VAR_ARG}|\.(?:uri|url)\(\s*${VAR_ARG}`,
        ),
        sink(
            'kt.orm.by-id-only',
            'authz',
            'CWE-639',
            any(
                JPA_BY_ID_ONLY,
                String.raw`\{\s*\w+\.id\s+eq\s+[\w.]+\s*\}`,
                String.raw`\b[A-Z]\w*\.findById\(\s*[\w.()]+\s*\)`,
            ),
            'spring-data/exposed',
        ),
        sink(
            'kt.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:log|logger|LOG|LOGGER)\.(?:info|debug|warn|error|trace)\b|\bprintln\(`,
            ),
        ),
        sink(
            'kt.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\.printStackTrace\(\)|\.stackTraceToString\(\)|\bcall\.respond\w*\([^)]*\b(?:e|ex|cause|exception)\.(?:message|localizedMessage)`,
        ),
        sink(
            'kt.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\bcall\.respond\(\s*(?:user|users|account)\s*\)|\bResponseEntity\.ok\(\s*(?:user|users|account|\w*[Rr]epository\.find\w*\()`,
        ),
        ...jcaCrypto('kt'),
        timingCompare('kt', JVM_EQUALS_COMPARE),
        ...commonSinks('kt', { nosql: true }),
    ],
};
