import { describeSurfaceCases } from '../testing/surface-cases';
import { PYTHON_SURFACE } from './python.surface';

describeSurfaceCases(PYTHON_SURFACE, 'app/views.py', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.flask.route',
        code: "@app.route('/login', methods=['POST'])",
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.flask.route',
        code: "@bp.route('/items/<int:item_id>')",
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.fastapi.route',
        code: '@router.post("/items/{item_id}")',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.django.view',
        code: 'def invoice_detail(request, pk):',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.django.view',
        code: 'class InvoiceViewSet(viewsets.ModelViewSet):',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.django.urlconf',
        file: 'app/urls.py',
        code: "    path('invoices/<int:pk>/', views.invoice_detail),",
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.graphql.resolver',
        code: '    def resolve_user(self, info, id):',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.queue.consumer',
        code: '@shared_task\ndef send_email(user_id):',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'py.cli.argv',
        code: 'parser = argparse.ArgumentParser()',
    },
    { role: 'entry_point', match: false, code: 'def helper(data):' },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'py.django.auth',
        code: '@login_required\ndef dashboard(request):',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'py.django.auth',
        code: '    permission_classes = [IsAuthenticated]',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'py.flask.auth',
        code: '@jwt_required()',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'py.fastapi.auth',
        code: 'async def me(user: User = Depends(get_current_user)):',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.sql.string-built',
        code: 'cursor.execute(f"SELECT * FROM users WHERE name = \'{name}\'")',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.sql.string-built',
        code: 'q = "SELECT * FROM users WHERE id = %s" % user_id',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.sql.raw-call',
        code: 'cursor.execute("DELETE FROM t WHERE k = \'" + key + "\'")',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: 'cursor.execute("SELECT * FROM users WHERE name = %s", (name,))',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.exec.shell',
        code: 'subprocess.run(cmd, shell=True)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.exec.shell',
        code: 'os.system("ping " + host)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: 'subprocess.run(["ping", "-c", "1", host], check=True)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.eval',
        code: 'result = eval(request.args["expr"])',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.deserialize',
        code: 'obj = pickle.loads(request.data)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.template.injection',
        code: 'return render_template_string(request.args.get("tpl"))',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.nosql.operator-injection',
        code: 'user = db.users.find_one(request.json)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'py.path.traversal',
        code: 'return send_file(os.path.join(UPLOAD_DIR, request.args["name"]))',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: 'with open("settings.json") as fh:',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'py.http.variable-url',
        code: 'resp = requests.get(url, timeout=5)',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'py.http.variable-url',
        code: 'r = httpx.post(f"https://{host}/hook", json=payload)',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: 'resp = requests.get("https://api.example.com/health")',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: 'resp = requests.get(API_URL, timeout=5)',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'py.orm.by-id-only',
        code: '    invoice = Invoice.objects.get(pk=pk)',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'py.orm.by-id-only',
        code: '    item = session.get(Item, item_id)',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '    invoice = Invoice.objects.get(pk=pk, owner=request.user)',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'py.log.sensitive',
        code: 'logger.info("login %s password=%s", user, password)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'py.response.error-detail',
        code: '    return jsonify({"error": str(e)}), 500',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'py.response.whole-entity',
        code: "        fields = '__all__'",
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: 'logger.info("login ok for %s", user.id)',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'py.common.hardcoded-secret',
        code: 'SECRET_KEY = "django-insecure-abc123xyz"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'py.crypto.weak-hash',
        code: 'digest = hashlib.md5(password.encode()).hexdigest()',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'py.crypto.weak-cipher',
        code: 'cipher = AES.new(key, AES.MODE_ECB)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'py.crypto.insecure-random',
        code: "token = ''.join(random.choices(string.ascii_letters, k=32))",
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'py.crypto.timing-unsafe-compare',
        code: 'if request.headers["X-Signature"] == expected_signature:',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'py.jwt.unverified',
        code: 'claims = jwt.decode(token, options={"verify_signature": False})',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'py.tls.verification-disabled',
        code: 'requests.get(url, verify=False)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: 'SECRET_KEY = os.environ["SECRET_KEY"]',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: 'if hmac.compare_digest(signature, expected):',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: 'token = secrets.token_urlsafe(32)',
    },
]);
