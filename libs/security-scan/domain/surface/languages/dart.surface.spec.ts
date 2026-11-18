import { describeSurfaceCases } from '../testing/surface-cases';
import { DART_SURFACE } from './dart.surface';

describeSurfaceCases(DART_SURFACE, 'lib/server.dart', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'dart.shelf.route',
        code: "  router.get('/users/<id>', getUser);",
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'dart.shelf.route',
        code: "  @Route.post('/orders')",
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'dart.shelf.handler',
        code: 'Future<Response> getUser(Request request, String id) async {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'dart.frog.handler',
        file: 'routes/users/[id].dart',
        code: 'Future<Response> onRequest(RequestContext context, String id) async {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'dart.flutter.deep-link',
        code: '  _sub = uriLinkStream.listen((uri) => handle(uri));',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'dart.cli.args',
        code: 'void main(List<String> arguments) {',
    },
    { role: 'entry_point', match: false, code: 'int helper(int x) => x + 1;' },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'dart.auth',
        code: '  final claims = JWT.verify(token, SecretKey(secret));',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'dart.auth',
        code: '  return handler.use(bearerAuthentication<User>(authenticator: auth));',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'dart.sql.string-built',
        code: '  final rows = await db.rawQuery(\'SELECT * FROM users WHERE name = "$name"\');',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'dart.sql.raw-call',
        code: '  final rows = await db.rawQuery(sql);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: "  final rows = await db.rawQuery('SELECT * FROM users WHERE id = ?', [id]);",
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'dart.exec',
        code: "  final r = await Process.run('sh', ['-c', cmd]);",
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'dart.exec',
        code: '  final r = await Process.run(command, args, runInShell: true);',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: "  final r = await Process.run('git', ['clone', '--', repoUrl]);",
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'dart.webview.eval',
        code: '  controller.runJavaScript(\'setUser("$name")\');',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'dart.path.traversal',
        code: "  final file = File(p.join(uploadDir, request.url.queryParameters['name']));",
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'dart.http.variable-url',
        code: '  final res = await http.get(Uri.parse(callbackUrl));',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'dart.http.variable-url',
        code: "  final res = await dio.get('https://$host/status');",
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: "  final res = await http.get(Uri.parse('https://api.example.com/health'));",
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'dart.lookup.by-route-id',
        code: "  final rows = await db.query('invoices', where: 'id = ?', whereArgs: [id]);",
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: "  final rows = await db.query('invoices', where: 'id = ? AND owner_id = ?', whereArgs: [id, uid]);",
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'dart.log.sensitive',
        code: "  print('login $email password=$password');",
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'dart.storage.plaintext-secret',
        code: "  await prefs.setString('accessToken', token);",
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'dart.response.error-detail',
        code: "    return Response.internalServerError(body: '$e\\n$st');",
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: "  print('login ok for ${user.id}');",
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'dart.common.hardcoded-secret',
        code: "const apiKey = 'AIzaSyD-example-123456';",
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'dart.crypto.weak-hash',
        code: '  final digest = md5.convert(utf8.encode(password));',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'dart.crypto.weak-cipher',
        code: '  final enc = Encrypter(AES(key, mode: AESMode.ecb));',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'dart.crypto.insecure-random',
        code: '  final token = List.generate(32, (_) => chars[Random().nextInt(chars.length)]).join();',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'dart.crypto.timing-unsafe-compare',
        code: '  if (provided == expectedSignature) return true;',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'dart.jwt.unverified',
        code: '  final jwt = JWT.decode(token);',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'dart.tls.verification-disabled',
        code: '  client.badCertificateCallback = (cert, host, port) => true;',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '  final token = List.generate(32, (_) => chars[Random.secure().nextInt(chars.length)]).join();',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: "  final apiKey = Platform.environment['API_KEY'];",
    },
]);
