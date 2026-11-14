import { describeSurfaceCases } from '../testing/surface-cases';
import { PHP_SURFACE } from './php.surface';

describeSurfaceCases(
    PHP_SURFACE,
    'app/Http/Controllers/InvoiceController.php',
    [
        // entry points
        {
            role: 'entry_point',
            match: true,
            patternId: 'php.laravel.route',
            file: 'routes/web.php',
            code: "Route::get('/invoices/{invoice}', [InvoiceController::class, 'show']);",
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'php.symfony.route',
            code: "    #[Route('/users/{id}', methods: ['GET'])]",
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'php.slim.route',
            code: "$app->get('/hello/{name}', function ($request, $response, $args) {",
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'php.controller.action',
            code: '    public function store(StoreInvoiceRequest $request)',
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'php.superglobal',
            file: 'public/search.php',
            code: "$q = $_GET['q'];",
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'php.wordpress.hook',
            file: 'wp-content/plugins/acme/acme.php',
            code: "add_action('wp_ajax_nopriv_acme_save', 'acme_save');",
        },
        {
            role: 'entry_point',
            match: true,
            patternId: 'php.cli',
            file: 'bin/import.php',
            code: '$file = $argv[1];',
        },
        {
            role: 'entry_point',
            match: false,
            code: '    private function helper($x) { return $x + 1; }',
        },

        // auth checks
        {
            role: 'auth_check',
            match: true,
            patternId: 'php.auth',
            file: 'routes/web.php',
            code: "Route::middleware(['auth'])->group(function () {\n    Route::get('/a', A::class);\n})->middleware('auth');",
        },
        {
            role: 'auth_check',
            match: true,
            patternId: 'php.auth',
            code: "        $this->authorize('update', $invoice);",
        },

        // injection
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.sql.string-built',
            code: '$sql = "SELECT * FROM users WHERE name = \'$name\'";',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.sql.raw-call',
            code: "$r = mysqli_query($conn, 'SELECT * FROM users WHERE id = ' . $_GET['id']);",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: '$stmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: "$users = DB::select('select * from users where id = ?', [$id]);",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.exec',
            code: "system('ping -c 1 ' . $host);",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.exec',
            code: '$out = shell_exec("convert $file out.png");',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: "exec('ls ' . escapeshellarg($dir), $out);",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.eval',
            code: "eval($_POST['code']);",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.deserialize',
            code: "$obj = unserialize($_COOKIE['state']);",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.include',
            code: "include $_GET['page'] . '.php';",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: false,
            code: "require_once __DIR__ . '/../vendor/autoload.php';",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.template.injection',
            code: '$tpl = $twig->createTemplate($request->input("tpl"));',
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.path.traversal',
            code: "readfile('/var/uploads/' . $_GET['file']);",
        },
        {
            role: 'sink',
            vulnClass: 'injection',
            match: true,
            patternId: 'php.nosql.operator-injection',
            code: '$user = $collection->findOne($_POST);',
        },

        // ssrf
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'php.http.variable-url',
            code: '$body = file_get_contents($url);',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: true,
            patternId: 'php.http.variable-url',
            code: '$res = Http::withToken($t)->get($request->input("callback"));',
        },
        {
            role: 'sink',
            vulnClass: 'ssrf',
            match: false,
            code: "$res = Http::get('https://api.example.com/health');",
        },

        // authz
        {
            role: 'sink',
            vulnClass: 'authz',
            match: true,
            patternId: 'php.orm.by-id-only',
            code: '        $invoice = Invoice::findOrFail($id);',
        },
        {
            role: 'sink',
            vulnClass: 'authz',
            match: true,
            patternId: 'php.route-model-binding',
            code: '    public function show(Invoice $invoice)',
        },
        {
            role: 'sink',
            vulnClass: 'authz',
            match: false,
            code: '        $invoice = $request->user()->invoices()->findOrFail($id);',
        },

        // data exposure
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'php.log.sensitive',
            code: "Log::info('login', ['email' => $email, 'password' => $password]);",
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'php.response.error-detail',
            code: "ini_set('display_errors', '1');",
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: true,
            patternId: 'php.response.whole-entity',
            code: '        return response()->json($user);',
        },
        {
            role: 'sink',
            vulnClass: 'data_exposure',
            match: false,
            code: "Log::info('login ok', ['id' => $user->id]);",
        },

        // secret / identity
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'php.common.hardcoded-secret',
            code: "$password = 'hunter2hunter2';",
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'php.crypto.weak-hash',
            code: '$hash = md5($password);',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'php.crypto.weak-cipher',
            code: "$c = openssl_encrypt($data, 'aes-128-ecb', $key);",
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'php.crypto.insecure-random',
            code: '$token = md5(uniqid(mt_rand(), true));',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'php.crypto.timing-unsafe-compare',
            code: "if ($_SERVER['HTTP_X_SIGNATURE'] == $expectedSignature) {",
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'php.jwt.unverified',
            code: '$claims = $parser->parse($jwt)->claims();',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: true,
            patternId: 'php.tls.verification-disabled',
            code: 'curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: 'if (hash_equals($expected, $signature)) {',
        },
        {
            role: 'sink',
            vulnClass: 'secret_identity',
            match: false,
            code: '$token = bin2hex(random_bytes(32));',
        },
    ],
);
