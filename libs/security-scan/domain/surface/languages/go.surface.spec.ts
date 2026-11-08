import { describeSurfaceCases } from '../testing/surface-cases';
import { GO_SURFACE } from './go.surface';

describeSurfaceCases(GO_SURFACE, 'internal/api/handler.go', [
    // entry points
    {
        role: 'entry_point',
        match: true,
        patternId: 'go.nethttp.route',
        code: '\thttp.HandleFunc("/login", loginHandler)',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'go.router.route',
        code: '\tr.GET("/users/:id", getUser)',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'go.router.route',
        code: '\tapp.Post("/orders", createOrder)',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'go.handler.signature',
        code: 'func getUser(w http.ResponseWriter, r *http.Request) {',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'go.grpc.server',
        code: '\tpb.RegisterUserServiceServer(s, &server{})',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'go.queue.consumer',
        code: '\tmsgs, err := ch.Consume(q.Name, "", true, false, false, false, nil)',
    },
    {
        role: 'entry_point',
        match: true,
        patternId: 'go.cli.argv',
        code: '\tpath := os.Args[1]',
    },
    { role: 'entry_point', match: false, code: 'func helper(a int) int {' },

    // auth checks
    {
        role: 'auth_check',
        match: true,
        patternId: 'go.auth.middleware',
        code: '\tapi.Use(AuthMiddleware())',
    },
    {
        role: 'auth_check',
        match: true,
        patternId: 'go.auth.middleware',
        code: '\tr.Use(jwtauth.Verifier(tokenAuth))',
    },

    // injection
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'go.sql.string-built',
        code: '\tq := fmt.Sprintf("SELECT * FROM users WHERE name = \'%s\'", name)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'go.sql.raw-call',
        code: '\trows, err := db.Query("SELECT * FROM users WHERE id = " + id)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '\trows, err := db.Query("SELECT * FROM users WHERE id = $1", id)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '\tdb.Where("name = ?", name).First(&user)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'go.exec.command',
        code: '\tout, _ := exec.Command("sh", "-c", "ping "+host).Output()',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'go.exec.command',
        code: '\tcmd := exec.Command(userCmd, args...)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: false,
        code: '\tcmd := exec.Command("git", "clone", "--", repoURL, dir)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'go.template.injection',
        code: '\tt, _ := template.New("page").Parse(userTemplate)',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'go.path.traversal',
        code: '\tdata, _ := os.ReadFile(filepath.Join(baseDir, c.Param("name")))',
    },
    {
        role: 'sink',
        vulnClass: 'injection',
        match: true,
        patternId: 'go.common.ldap-filter',
        code: '\tfilter := fmt.Sprintf("(uid=%s)", username)',
    },

    // ssrf
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'go.http.variable-url',
        code: '\tresp, err := http.Get(target)',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: true,
        patternId: 'go.http.variable-url',
        code: '\treq, _ := http.NewRequestWithContext(ctx, "GET", webhookURL, nil)',
    },
    {
        role: 'sink',
        vulnClass: 'ssrf',
        match: false,
        code: '\tresp, err := http.Get("https://api.example.com/health")',
    },

    // authz
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'go.orm.by-id-only',
        code: '\tdb.First(&invoice, id)',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: true,
        patternId: 'go.common.sql-by-id-only',
        code: '\trow := db.QueryRow("SELECT * FROM invoices WHERE id = $1", id)',
    },
    {
        role: 'sink',
        vulnClass: 'authz',
        match: false,
        code: '\tdb.Where("id = ? AND owner_id = ?", id, userID).First(&invoice)',
    },

    // data exposure
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'go.log.sensitive',
        code: '\tlog.Printf("login user=%s password=%s", u, password)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'go.response.error-detail',
        code: '\t\thttp.Error(w, err.Error(), http.StatusInternalServerError)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: true,
        patternId: 'go.response.whole-entity',
        code: '\tjson.NewEncoder(w).Encode(user)',
    },
    {
        role: 'sink',
        vulnClass: 'data_exposure',
        match: false,
        code: '\t\thttp.Error(w, "internal error", http.StatusInternalServerError)',
    },

    // secret / identity
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'go.common.hardcoded-secret',
        code: '\tconst apiKey = "a1b2c3d4e5f6g7h8"',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'go.crypto.weak-hash',
        code: '\tsum := md5.Sum([]byte(password))',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'go.crypto.weak-cipher',
        code: '\tblock, _ := des.NewCipher(key)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'go.crypto.insecure-random',
        code: '\t\tb[i] = letterBytes[rand.Intn(len(letterBytes))]',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'go.crypto.timing-unsafe-compare',
        code: '\tif !bytes.Equal(sig, expectedMAC) {',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'go.jwt.unverified',
        code: '\ttoken, _, err := parser.ParseUnverified(raw, claims)',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: true,
        patternId: 'go.tls.verification-disabled',
        code: '\ttr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '\tif subtle.ConstantTimeCompare(sig, expected) != 1 {',
    },
    {
        role: 'sink',
        vulnClass: 'secret_identity',
        match: false,
        code: '\tapiKey := os.Getenv("API_KEY")',
    },
]);
