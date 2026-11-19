import { LanguageSurface } from '../surface.types';
import {
    any,
    auth,
    commonSinks,
    entry,
    logsSensitive,
    randomForSecret,
    sink,
    sqlConcat,
    sqlInString,
    SQL_SHAPE,
    timingCompare,
} from './shared';

const REQ = String.raw`\brequest\.(?:args|form|GET|POST|query_params|data|files|FILES|json|values|path_params|view_args)\b`;
/** Non-constant first argument: lowercase name, f-string, or `%`/`+` formatting. */
const VAR_ARG = String.raw`(?:[a-z_][\w.\[\]'"]*\s*[,)+]|[fF]["']|["'][^"']*["']\s*[%+])`;

export const PYTHON_SURFACE: LanguageSurface = {
    language: 'python',
    glob: '*.py',
    extraGlobs: [
        {
            glob: 'urls.py',
            patterns: [
                entry(
                    'py.django.urlconf',
                    String.raw`\b(?:path|re_path|url)\(\s*r?['"]`,
                    'django',
                ),
            ],
        },
    ],
    patterns: [
        entry('py.flask.route', String.raw`@\w+\.route\(`, 'flask'),
        entry(
            'py.fastapi.route',
            String.raw`@\w+\.(?:get|post|put|patch|delete|api_route|websocket)\(\s*['"]`,
            'fastapi',
        ),
        entry(
            'py.django.view',
            String.raw`\bdef\s+\w+\s*\(\s*(?:self\s*,\s*)?request\b|\bclass\s+\w+\([^)]*(?:APIView|ViewSet|View)\s*[,)]`,
            'django',
        ),
        entry(
            'py.graphql.resolver',
            String.raw`\bdef\s+resolve_\w+\s*\(|@strawberry\.(?:mutation|field)\b`,
            'graphql',
        ),
        entry(
            'py.queue.consumer',
            String.raw`@(?:\w+\.)?(?:task|shared_task)\b|\.basic_consume\(|\bKafkaConsumer\(|@\w+\.(?:subscriber|consumer)\(`,
            'celery/pika/kafka',
        ),
        entry(
            'py.cli.argv',
            String.raw`\bsys\.argv\b|\bargparse\.ArgumentParser\(|@click\.(?:command|argument|option)\b|\btyper\.Typer\(`,
            'cli',
        ),

        auth(
            'py.django.auth',
            String.raw`@(?:login_required|permission_required|user_passes_test|staff_member_required)\b|\b(?:LoginRequiredMixin|PermissionRequiredMixin|UserPassesTestMixin)\b|\bpermission_classes\s*=\s*\[\s*(?:permissions\.)?(?:IsAuthenticated(?:OrReadOnly)?|IsAdminUser|DjangoModelPermissions|DjangoObjectPermissions)\b|\bauthentication_classes\s*=\s*\[\s*(?:\w+\.)?\w+Authentication\b|\bdef\s+has_(?:object_)?permission\(`,
            'django',
        ),
        auth(
            'py.flask.auth',
            String.raw`@(?:\w+\.)?(?:login_required|jwt_required|roles_required|roles_accepted|requires_auth|token_required)\b|\bcurrent_user\.is_authenticated\b|\bverify_jwt_in_request\(`,
            'flask',
        ),
        auth(
            'py.fastapi.auth',
            String.raw`\b(?:Depends|Security)\(\s*(?:get_current_\w+|\w*auth\w*|oauth2_scheme|verify_\w+|require_\w+)`,
            'fastapi',
        ),

        sink(
            'py.sql.string-built',
            'injection',
            'CWE-89',
            any(
                sqlConcat(),
                String.raw`\b[fF][rR]?${sqlInString('"', String.raw`\{`)}`,
                String.raw`\b[fF][rR]?${sqlInString("'", String.raw`\{`)}`,
                sqlInString('"', String.raw`%s[^"]*"\s*%`),
                sqlInString("'", String.raw`%s[^']*'\s*%`),
                String.raw`["'][^"']*${SQL_SHAPE}[^"']*\{\w*\}[^"']*["']\.format\(`,
            ),
        ),
        sink(
            'py.sql.raw-call',
            'injection',
            'CWE-89',
            String.raw`\.(?:execute|executemany|executescript|raw|extra)\(\s*(?:[fF]["']|"[^"]*"\s*(?:%|\+|\.format\()|'[^']*'\s*(?:%|\+|\.format\())|\b(?:text|RawSQL)\(\s*[fF]["']`,
        ),
        sink(
            'py.exec.shell',
            'injection',
            'CWE-78',
            String.raw`\bos\.(?:system|popen)\(|\bsubprocess\.\w+\([^)]*\bshell\s*=\s*True|\bcommands\.getoutput\(|\bos\.exec\w*\(|\bpty\.spawn\(`,
        ),
        sink(
            'py.eval',
            'injection',
            'CWE-94',
            String.raw`(?:^|[^.\w])(?:eval|exec)\(\s*[^'"\s)]|\bcompile\(\s*[a-z_]\w*\s*,`,
        ),
        sink(
            'py.deserialize',
            'injection',
            'CWE-502',
            String.raw`\b(?:pickle|cPickle|dill|marshal|shelve)\.loads?\(|\byaml\.unsafe_load\(|\byaml\.load\(\s*[^,)]+\)|\bjsonpickle\.decode\(`,
        ),
        sink(
            'py.template.injection',
            'injection',
            'CWE-1336',
            String.raw`\brender_template_string\(\s*(?:[^'"\s)]|[fF]["'])|\b(?:jinja2\.)?Template\(\s*(?:request\.|[fF]["']|[a-z_]\w*\s*\))|\.from_string\(\s*(?:[^'"\s)]|[fF]["'])|\bmako\.template\.Template\(`,
        ),
        sink(
            'py.nosql.operator-injection',
            'injection',
            'CWE-943',
            String.raw`\.(?:find|find_one|update_one|update_many|delete_one|delete_many|count_documents|aggregate)\(\s*(?:request\.(?:json|get_json\(\)|args|form|data)|json\.loads\()`,
            'pymongo',
        ),
        sink(
            'py.path.traversal',
            'injection',
            'CWE-22',
            String.raw`\b(?:open|send_file|send_from_directory|FileResponse|os\.remove|os\.unlink|shutil\.rmtree|os\.path\.join)\([^)]*${REQ}|\bopen\(\s*[fF]["'][^"']*\{[a-z_]*(?:request|file_?name|path|name)\b|\bsend_file\(\s*[a-z_]\w*\s*[,)]`,
        ),
        sink(
            'py.http.variable-url',
            'ssrf',
            'CWE-918',
            String.raw`\b(?:requests|httpx|urllib3|aiohttp)\.(?:get|post|put|patch|delete|head|request|stream|urlopen)\(\s*(?:["'][A-Z]+["']\s*,\s*)?${VAR_ARG}|\burlopen\(\s*(?:[a-z_]|[fF]["'])|\burllib\.request\.Request\(\s*(?:[a-z_]|[fF]["'])|\b(?:session|client)\.(?:get|post|put|delete|request)\(\s*(?:url\b|[fF]["'])`,
        ),
        sink(
            'py.orm.by-id-only',
            'authz',
            'CWE-639',
            // A lookup whose ONLY filter is the id: no `owner=request.user` alongside.
            String.raw`\.objects\.(?:get|filter)\(\s*(?:pk|id)\s*=\s*[\w.\[\]'"]+\s*\)|\bget_object_or_404\(\s*\w+\s*,\s*(?:pk|id)\s*=\s*[\w.\[\]'"]+\s*\)|\bsession\.get\(\s*[A-Z]\w*\s*,\s*[\w.\[\]'"]+\s*\)|\.query\(\s*\w+\s*\)\.get\(|\.filter_by\(\s*id\s*=\s*[\w.\[\]'"]+\s*\)\.(?:first|one)`,
            'django/sqlalchemy',
        ),
        sink(
            'py.log.sensitive',
            'data_exposure',
            'CWE-532',
            logsSensitive(
                String.raw`\b(?:logging|logger|log|_logger|LOGGER|LOG)\.(?:debug|info|warning|warn|error|exception|critical)\(|\bprint\(`,
            ),
        ),
        sink(
            'py.response.error-detail',
            'data_exposure',
            'CWE-209',
            String.raw`\btraceback\.format_exc\(\)|\b(?:return|jsonify\(|JSONResponse\(|Response\()[^#]*\bstr\(\s*(?:e|ex|exc|err|error)\s*\)|^\s*DEBUG\s*=\s*True\b`,
        ),
        sink(
            'py.response.whole-entity',
            'data_exposure',
            'CWE-200',
            String.raw`\bfields\s*=\s*['"]__all__['"]|\bmodel_to_dict\(|\.__dict__\s*\)`,
            'django/drf',
        ),
        sink(
            'py.crypto.weak-hash',
            'secret_identity',
            'CWE-328',
            String.raw`\bhashlib\.(?:md5|sha1)\(|\bhashlib\.new\(\s*['"](?:md5|sha1)['"]|\b(?:MD5|SHA)\.new\(`,
        ),
        sink(
            'py.crypto.weak-cipher',
            'secret_identity',
            'CWE-327',
            String.raw`\b(?:DES|DES3|ARC4|ARC2|Blowfish)\.new\(|\bMODE_ECB\b|\balgorithms\.(?:TripleDES|Blowfish|ARC4)\(|\bmodes\.ECB\(`,
        ),
        sink(
            'py.crypto.insecure-random',
            'secret_identity',
            'CWE-338',
            any(
                randomForSecret(
                    String.raw`\brandom\.(?:random|randint|choice|choices|getrandbits|randrange|sample)\(`,
                ),
                String.raw`\brandom\.choices?\(\s*string\.`,
            ),
        ),
        timingCompare('py'),
        sink(
            'py.jwt.unverified',
            'secret_identity',
            'CWE-347',
            String.raw`\bjwt\.decode\([^)]*\bverify\s*=\s*False|["']verify_signature["']\s*:\s*False|\bjwt\.get_unverified_claims\(`,
        ),
        sink(
            'py.tls.verification-disabled',
            'secret_identity',
            'CWE-295',
            String.raw`\bverify\s*=\s*False\b|\bssl\._create_unverified_context\(|\bCERT_NONE\b|\bcheck_hostname\s*=\s*False`,
        ),
        sink(
            'py.config.debug',
            'misconfiguration',
            'CWE-489',
            String.raw`\b\w+\.run\([^)]*\bdebug\s*=\s*True|^\s*DEBUG\s*=\s*True\b|['"]DEBUG['"]\s*\]\s*=\s*True\b|\.debug\s*=\s*True\b|\bDebuggedApplication\(`,
        ),
        sink(
            'py.config.csrf-off',
            'misconfiguration',
            'CWE-352',
            String.raw`@csrf_exempt\b|\b(?:WTF_)?CSRF_(?:ENABLED|CHECK_DEFAULT)['"]?\s*\]?\s*=\s*False`,
        ),
        sink(
            'py.config.cookie-flags',
            'misconfiguration',
            'CWE-1004',
            String.raw`\b(?:SESSION|CSRF)_COOKIE_(?:SECURE|HTTPONLY)['"]?\s*\]?\s*=\s*False|\bset_cookie\([^)]*\b(?:httponly|secure)\s*=\s*False|\bset_cookie\(\s*['"][^'"]+['"]\s*,\s*[^,)]+\)`,
        ),
        sink(
            'py.config.cors-open',
            'misconfiguration',
            'CWE-942',
            String.raw`\bCORS\(\s*app\s*\)|\bCORS_(?:ORIGIN_)?ALLOW_ALL(?:_ORIGINS)?\s*=\s*True|\bsupports_credentials\s*=\s*True|allow_origins\s*=\s*\[\s*['"]\*['"]`,
        ),
        ...commonSinks('py', { nosql: true }),
    ],
};
