"""python3 evals/business-logic-requirements/build-cases.py <repo root>

Writes evals/business-logic-requirements/{cases.json,files/}: one PR per case,
the Jira ticket it closes (and its parent or sub-tasks), files already in the
repository, and the gold state of every requirement. Invented domains only."""
import json, os, sys

ROOT = sys.argv[1]
OUT = os.path.join(ROOT, 'evals/business-logic-requirements')
FILES = os.path.join(OUT, 'files')
os.makedirs(FILES, exist_ok=True)

DONE, GAP = ['met'], ['missing', 'partial']
MANUAL = ['check_manually']


def diff(path, lines, new=True):
    head = [f'diff --git a/{path} b/{path}']
    head += ['new file mode 100644', '--- /dev/null'] if new else [f'--- a/{path}']
    head += [f'+++ b/{path}', f'@@ -0,0 +1,{len(lines)} @@' if new else f'@@ -1,{len(lines)} +1,{len(lines)} @@']
    # Every line of a new file is added, indented ones too: a leading space is
    # code, not a context marker.
    body = [l if l.startswith('+') else '+' + l for l in lines] if new else lines
    return '\n'.join(head + body)


def ticket(title, description, criteria=None, heading='Acceptance criteria'):
    text = f'# Task: {title}\n\n{description.strip()}\n'
    if criteria:
        text += f'\n## {heading}\n' + ''.join(f'- {c}\n' for c in criteria)
    return text


CASES = []


def case(id, checks, key, title, task_md, diffs, gold, related=(), repo=None, only_gold=False, slug=None):
    write = lambda name, content: open(os.path.join(FILES, name), 'w').write(content.rstrip('\n') + '\n')
    write(f'{id}.task.md', task_md)
    write(f'{id}.diff', '\n'.join(diffs))
    rel = []
    for r in related:
        write(f"{id}.{r['key']}.task.md", r['md'])
        rel.append({k: v for k, v in {'key': r['key'], 'task': f"{id}.{r['key']}.task.md", 'parent': r.get('parent'), 'subtasks': r.get('subtasks')}.items() if v})
    repo_files = {}
    for i, (path, content) in enumerate((repo or {}).items()):
        name = f'{id}.repo{i}.txt'
        write(name, content)
        repo_files[path] = name
    c = {
        'id': id,
        'checks': checks,
        'pr': {'number': 300 + len(CASES), 'title': title, 'body': f'Closes {key}.', 'headRef': f'feat/{key}-{slug or id}'},
        'ticket': {'key': key, 'task': f'{id}.task.md'},
        'diff': f'{id}.diff',
        'gold': [{'match': m, 'accept': a, **({'absentOk': True} if o else {})} for m, a, *o in gold],
    }
    if rel:
        c['related'] = rel
    if repo_files:
        c['repoFiles'] = repo_files
    if only_gold:
        c['onlyGold'] = True
    CASES.append(c)


def sub(key, md, parent=None, subtasks=None):
    return {'key': key, 'md': md, 'parent': parent, 'subtasks': subtasks}


# ── Late fee (D1 explicit, rule, list) and its broken twin ──────────────────
FEE = ticket('Late fee on overdue loans', 'Members return books late and nothing happens. Charge a late fee.', [
    'A loan returned after its due date is charged 0.50 per day late',
    'The late fee is capped at 10.00',
    'A loan returned on time is charged nothing',
    'The late fee is printed on the return receipt',
])
case('late-fee', 'Calls three fee rules met where the diff codes them, and the receipt line missing', 'PROJ-201', 'Charge a late fee on overdue loans', FEE, [
    diff('src/loans/lateFee.ts', [
        'export const FEE_PER_DAY = 0.5;', 'export const MAX_FEE = 10;',
        'export function lateFee(dueDate: Date, returnedAt: Date): number {',
        '  const days = Math.ceil((returnedAt.getTime() - dueDate.getTime()) / 86_400_000);',
        '  if (days <= 0) return 0;', '  return Math.min(days * FEE_PER_DAY, MAX_FEE);', '}',
    ]),
    diff('src/loans/returnLoan.ts', [
        " import { db } from '../db';", "+import { lateFee } from './lateFee';",
        ' export async function returnLoan(loanId: string, returnedAt = new Date()) {',
        '   const loan = await db.loans.get(loanId);',
        '+  const fee = lateFee(loan.dueDate, returnedAt);',
        '-  await db.loans.update(loanId, { returnedAt });',
        '+  await db.loans.update(loanId, { returnedAt, fee });', ' }',
    ], new=False),
], [('per day|0[.,]50', DONE), ('cap|10[.,]00|maximum', DONE), ('on time', DONE), ('receipt', GAP)], slug='late-fee')
case('late-fee-uncapped', 'Calls the cap missing when the fee grows without a limit (control for late-fee)', 'PROJ-201', 'Charge a late fee on overdue loans', FEE, [
    diff('src/loans/lateFee.ts', [
        'export const FEE_PER_DAY = 0.5;',
        'export function lateFee(dueDate: Date, returnedAt: Date): number {',
        '  const days = Math.ceil((returnedAt.getTime() - dueDate.getTime()) / 86_400_000);',
        '  return days > 0 ? days * FEE_PER_DAY : 0;', '}',
    ]),
    diff('src/loans/returnLoan.ts', [
        " import { db } from '../db';", "+import { lateFee } from './lateFee';",
        ' export async function returnLoan(loanId: string, returnedAt = new Date()) {',
        '   const loan = await db.loans.get(loanId);',
        '+  const fee = lateFee(loan.dueDate, returnedAt);',
        '-  await db.loans.update(loanId, { returnedAt });',
        '+  await db.loans.update(loanId, { returnedAt, fee });', ' }',
    ], new=False),
], [('per day|0[.,]50', DONE), ('cap|10[.,]00|maximum', GAP), ('on time', DONE), ('receipt', GAP)], slug='late-fee')

# ── Loan limit (D1 other name, rule, prose) and twin ────────────────────────
LIMIT = ticket('Members cannot borrow more than five books at once',
    'A member with five active loans must not be able to borrow another book. They should see the error "Loan limit reached".')
LIMIT_ERR = diff('src/loans/errors.ts', [
    'export class LoanLimitError extends Error {', "  constructor() { super('Loan limit reached'); }", '}'])
case('loan-limit', 'Calls the limit and its message met though the code names neither "five" nor the task', 'PROJ-202', 'Cap active loans per member', LIMIT, [
    LIMIT_ERR,
    diff('src/loans/borrow.ts', [
        " import { db } from '../db';", "+import { LoanLimitError } from './errors';", '+const MAX_ACTIVE_LOANS = 5;',
        ' export async function borrow(memberId: string, bookId: string) {',
        "+  const active = await db.loans.count({ memberId, returnedAt: null });",
        '+  if (active >= MAX_ACTIVE_LOANS) throw new LoanLimitError();',
        '   return db.loans.create({ memberId, bookId, borrowedAt: new Date() });', ' }'], new=False),
], [('five|5|limit|more than', DONE), ('loan limit reached|error|message', DONE)], slug='loan-limit')
case('loan-limit-off-by-one', 'Calls the limit not met when a sixth loan still goes through (control for loan-limit)', 'PROJ-202', 'Cap active loans per member', LIMIT, [
    LIMIT_ERR,
    diff('src/loans/borrow.ts', [
        " import { db } from '../db';", "+import { LoanLimitError } from './errors';", '+const MAX_ACTIVE_LOANS = 5;',
        ' export async function borrow(memberId: string, bookId: string) {',
        "+  const active = await db.loans.count({ memberId, returnedAt: null });",
        '+  if (active > MAX_ACTIVE_LOANS) throw new LoanLimitError();',
        '   return db.loans.create({ memberId, bookId, borrowedAt: new Date() });', ' }'], new=False),
], [('five|5|limit|more than', GAP), ('loan limit reached|error|message', ['met', 'partial'])], slug='loan-limit')

# ── Renewal (D1 outside the diff, rule, list) and twin ──────────────────────
RENEW = ticket('Renew a loan', 'Members ask at the desk to keep a book longer.', [
    'A member can renew a loan once, for 14 more days',
    'A loan another member has reserved cannot be renewed',
    'Renewing a loan that is already overdue is refused',
])
RENEW_DIFF = diff('src/loans/renew.ts', [
    "import { db } from '../db';", "import { assertRenewable } from './loanRules';",
    'export async function renewLoan(loanId: string) {',
    '  const loan = await db.loans.get(loanId);',
    "  if (loan.renewals >= 1) throw new Error('This loan was already renewed');",
    '  await assertRenewable(loan);',
    '  const dueDate = new Date(loan.dueDate.getTime() + 14 * 86_400_000);',
    '  return db.loans.update(loanId, { dueDate, renewals: loan.renewals + 1 });', '}'])
case('renew-rules-outside-diff', 'Calls the reservation and overdue rules met: they are in loanRules.ts, which the PR calls but does not change', 'PROJ-203', 'Let members renew a loan', RENEW, [RENEW_DIFF],
    [('once|14', DONE), ('reserv', DONE), ('overdue', DONE)], repo={'src/loans/loanRules.ts': '\n'.join([
        "import { db } from '../db';",
        'export async function assertRenewable(loan: { id: string; bookId: string; dueDate: Date }) {',
        "  if (loan.dueDate.getTime() < Date.now()) throw new Error('Overdue loans cannot be renewed');",
        '  const reservation = await db.reservations.findFirst({ bookId: loan.bookId, active: true });',
        "  if (reservation) throw new Error('Another member reserved this book');", '}'])}, slug='renew')
case('renew-rules-outside-diff-no-reservation', 'Calls the reservation rule missing when loanRules.ts checks only overdue (control for renew-rules-outside-diff)', 'PROJ-203', 'Let members renew a loan', RENEW, [RENEW_DIFF],
    [('once|14', DONE), ('reserv', GAP), ('overdue', DONE)], repo={'src/loans/loanRules.ts': '\n'.join([
        'export async function assertRenewable(loan: { id: string; dueDate: Date }) {',
        "  if (loan.dueDate.getTime() < Date.now()) throw new Error('Overdue loans cannot be renewed');", '}'])}, slug='renew')

# ── E-mail validation in Portuguese (D1 outside the diff, validation) and twin ─
EMAIL = ticket('Validar e-mail no cadastro de leitor', 'Leitores estão se cadastrando com e-mails inválidos ou repetidos.', [
    'O cadastro recusa e-mail sem "@" com a mensagem "E-mail inválido"',
    'O e-mail é salvo em letras minúsculas',
    'Um e-mail já cadastrado é recusado com a mensagem "E-mail já cadastrado"',
], heading='Critérios de aceite')
EMAIL_REPO = {'src/readers/validateEmail.ts': '\n'.join([
    'export function validateEmail(email: string) {',
    "  if (!email.includes('@')) throw new Error('E-mail inválido');", '}'])}
case('reader-email-pt', 'Calls the three e-mail rules met in a Portuguese ticket, one of them in a helper outside the diff', 'PROJ-204', 'Validar e-mail no cadastro de leitor', EMAIL, [
    diff('src/readers/createReader.ts', [
        "import { db } from '../db';", "import { validateEmail } from './validateEmail';",
        'export async function createReader(input: { name: string; email: string }) {',
        '  validateEmail(input.email);', '  const email = input.email.trim().toLowerCase();',
        "  if (await db.readers.findFirst({ email })) throw new Error('E-mail já cadastrado');",
        '  return db.readers.create({ ...input, email });', '}']),
], [('@|inv[aá]lid', DONE), ('min[uú]scul|lower', DONE), ('j[aá] cadastrad|duplicad|already|repetid', DONE)], repo=EMAIL_REPO, slug='email')
case('reader-email-pt-case-kept', 'Calls the lowercase rule missing when the e-mail is saved as typed (control for reader-email-pt)', 'PROJ-204', 'Validar e-mail no cadastro de leitor', EMAIL, [
    diff('src/readers/createReader.ts', [
        "import { db } from '../db';", "import { validateEmail } from './validateEmail';",
        'export async function createReader(input: { name: string; email: string }) {',
        '  validateEmail(input.email);',
        "  if (await db.readers.findFirst({ email: input.email })) throw new Error('E-mail já cadastrado');",
        '  return db.readers.create(input);', '}']),
], [('@|inv[aá]lid', DONE), ('min[uú]scul|lower', GAP), ('j[aá] cadastrad|duplicad|already|repetid', DONE)], repo=EMAIL_REPO, slug='email')

# ── Archive confirmation look-alike (D1 look-alike, validation, list) ────────
case('archive-confirm-look-alike', 'Calls the archive confirmation missing when the PR confirms deleting instead', 'PROJ-205', 'Confirm before archiving an invoice',
    ticket('Confirm before archiving an invoice', 'Accountants archive invoices by mistake.', [
        'Archiving an invoice asks "Archive invoice <number>?" before doing it',
        'An archived invoice no longer shows in the open invoices list',
    ]), [
    diff('src/invoices/InvoiceActions.tsx', [
        " export function InvoiceActions({ invoice, api }: Props) {",
        '   const onDelete = async () => {',
        '+    if (!window.confirm(`Delete invoice ${invoice.number}?`)) return;',
        '     await api.delete(`/invoices/${invoice.id}`);', '   };',
        '   const onArchive = async () => {', '     await api.post(`/invoices/${invoice.id}/archive`);', '   };', ' }'], new=False),
    diff('src/invoices/openInvoices.ts', [
        ' export function openInvoices(invoices: Invoice[]) {',
        "-  return invoices.filter((i) => i.status !== 'paid');",
        "+  return invoices.filter((i) => i.status !== 'paid' && !i.archivedAt);", ' }'], new=False),
], [('archiv.*(ask|confirm)|confirm.*archiv|before', GAP), ('open invoices|list|no longer', DONE)], slug='archive')

# ── Discount code, half done (D1 half, validation, list) ────────────────────
case('discount-code-half', 'Calls expiry met, the minimum-order message partial and once-per-customer missing', 'PROJ-206', 'Validate discount codes at checkout',
    ticket('Validate discount codes at checkout', 'Customers reuse codes and apply them to tiny orders.', [
        'An expired code is refused with "This code has expired"',
        'A code can be used only once per customer',
        'A code on an order below its minimum value is refused with "Order below the minimum for this code"',
    ]), [
    diff('src/checkout/applyCode.ts', [
        "import { db } from '../db';",
        'export async function applyCode(code: string, order: { total: number; customerId: string }) {',
        '  const discount = await db.codes.get(code);',
        "  if (discount.expiresAt < new Date()) throw new Error('This code has expired');",
        "  if (order.total < discount.minOrder) throw new Error('Invalid code');",
        '  return { ...order, total: order.total - discount.amount };', '}']),
], [('expired', DONE), ('once', GAP), ('minimum|below', GAP)], slug='discount')

# ── Reminder sub-task (D1 absent, rule, sub-task) ───────────────────────────
REMINDERS_PARENT = ticket('Appointment reminders', 'Patients miss appointments; remind them by SMS.', [
    'A patient gets an SMS 24 hours before the appointment',
    'A cancelled appointment sends no reminder',
    'A patient can turn reminders off in their profile',
])
case('reminder-subtask-skips-cancelled', 'Judges a sub-task by its parent: the 24h SMS met, the cancelled check missing, the profile switch not this PR\'s work', 'PROJ-207', 'Send the 24h reminder SMS',
    '# Task: Send the 24h reminder SMS\n\nThe SMS part of the parent story.\n', [
    diff('src/reminders/scheduleReminder.ts', [
        "import { queue } from '../queue';",
        'export async function scheduleReminder(appointment: { id: string; startsAt: Date; phone: string }) {',
        '  const at = new Date(appointment.startsAt.getTime() - 24 * 3_600_000);',
        "  await queue.add('sms', { to: appointment.phone, appointmentId: appointment.id }, { at });", '}']),
], [('24', DONE), ('cancel', GAP), ('profile|turn.*off|opt', MANUAL, True)],
    related=[sub('PROJ-200', REMINDERS_PARENT)], slug='reminder')
CASES[-1]['ticket']['parent'] = 'PROJ-200'

# ── Due date in the API (D1 absent, API field, list) ────────────────────────
case('due-date-api-list-missing', 'Calls the single-loan field met, and the list endpoint and the OpenAPI entry missing', 'PROJ-208', 'Expose the loan due date in the API',
    ticket('Expose the loan due date in the API', 'The mobile app needs the due date to show reminders.', [
        'GET /loans/:id returns dueDate as an ISO-8601 string',
        'GET /loans returns dueDate on every item',
        'The OpenAPI spec documents dueDate',
    ]), [
    diff('src/api/loans/loanDetail.serializer.ts', [
        ' export function serializeLoanDetail(loan: Loan) {',
        '   return {', '     id: loan.id,', '     bookId: loan.bookId,',
        '+    dueDate: loan.dueDate.toISOString(),', '   };', ' }'], new=False),
], [(':id|single|detail', DONE), ('get /loans returns|every item|each item|list', GAP), ('openapi|spec|document', GAP)],
    repo={'src/api/loans/loanList.serializer.ts': '\n'.join([
        'export function serializeLoanListItem(loan: Loan) {', '  return { id: loan.id, bookId: loan.bookId };', '}']),
        'docs/openapi.yaml': '\n'.join(['components:', '  schemas:', '    Loan:', '      properties:', '        id: { type: string }', '        bookId: { type: string }'])},
    slug='due-date')

# ── CPF in Portuguese (D1 explicit, API field) and twin ─────────────────────
CPF = ticket('Adicionar CPF opcional ao paciente', 'A clínica precisa do CPF para emitir recibos.', [
    'O paciente tem um campo cpf opcional',
    'O CPF é salvo só com os dígitos, sem pontos nem traço',
    'O GET /patients/:id devolve o cpf',
], heading='Critérios de aceite')
CPF_ENTITY = diff('src/patients/patient.entity.ts', [
    ' export class Patient {', '   id: string;', '   name: string;', '+  cpf?: string | null;', ' }'], new=False)
CPF_API = diff('src/patients/patient.serializer.ts', [
    ' export function serializePatient(p: Patient) {', '-  return { id: p.id, name: p.name };', '+  return { id: p.id, name: p.name, cpf: p.cpf ?? null };', ' }'], new=False)
case('patient-cpf-pt', 'Calls the three CPF criteria met in a Portuguese ticket', 'PROJ-209', 'Adicionar CPF opcional ao paciente', CPF, [
    CPF_ENTITY, CPF_API,
    diff('src/patients/updatePatient.ts', [
        'export function normalizeCpf(cpf?: string | null) {', "  return cpf ? cpf.replace(/\\D/g, '') : null;", '}',
        'export async function updatePatient(id: string, input: { name?: string; cpf?: string | null }) {',
        '  return db.patients.update(id, { ...input, cpf: normalizeCpf(input.cpf) });', '}']),
], [('opcional|optional|campo', DONE), ('d[ií]gitos|digits|pontos', DONE), ('get|devolve|returns', DONE)], slug='cpf')
case('patient-cpf-pt-masked', 'Calls the digits-only rule missing when the CPF is saved as typed (control for patient-cpf-pt)', 'PROJ-209', 'Adicionar CPF opcional ao paciente', CPF, [
    CPF_ENTITY, CPF_API,
    diff('src/patients/updatePatient.ts', [
        'export async function updatePatient(id: string, input: { name?: string; cpf?: string | null }) {',
        '  return db.patients.update(id, input);', '}']),
], [('opcional|optional|campo', DONE), ('d[ií]gitos|digits|pontos', GAP), ('get|devolve|returns', DONE)], slug='cpf')

# ── Remember the branch (D1 other name, persisted, prose) and twin ──────────
BRANCH = ticket('Remember the library branch a librarian picked',
    'When a librarian picks a branch in the header, remember it, so the same branch is selected the next time they log in.')
BRANCH_SAVE = diff('src/header/BranchPicker.tsx', [
    ' export function BranchPicker({ branches, api }: Props) {',
    '   const onPick = async (branchId: string) => {', '     setBranch(branchId);',
    "+    await api.patch('/me/preferences', { defaultBranchId: branchId });", '   };', ' }'], new=False)
case('branch-preference', 'Calls both halves met: the choice is stored as a preference and read back when the session starts', 'PROJ-210', 'Remember the picked branch', BRANCH, [
    BRANCH_SAVE,
    diff('src/session/bootstrap.ts', [
        ' export async function bootstrapSession(api: Api) {',
        "   const me = await api.get('/me');",
        '+  if (me.preferences?.defaultBranchId) setBranch(me.preferences.defaultBranchId);', '   return me;', ' }'], new=False),
], [('remember|store|save|persist', DONE), ('log in|login|next time|selected', DONE)], slug='branch')
case('branch-preference-never-read', 'Calls the next-login half missing when the preference is saved but never read (control for branch-preference)', 'PROJ-210', 'Remember the picked branch', BRANCH, [BRANCH_SAVE],
    [('remember|store|save|persist', ['met', 'partial']), ('log in|login|next time|selected', GAP)], slug='branch')

# ── Invoice currency (D1 half, persisted, list) ─────────────────────────────
case('invoice-currency-no-backfill', 'Calls the field met, the backfill of existing invoices missing and the PDF line missing', 'PROJ-211', 'Store the invoice currency',
    ticket('Store the invoice currency', 'We are starting to bill in euros.', [
        'Each invoice stores its currency as an ISO 4217 code',
        'Existing invoices get the currency "USD"',
        'The invoice PDF shows the currency code next to the total',
    ]), [
    diff('migrations/1730000000000-invoice-currency.ts', [
        'export class InvoiceCurrency1730000000000 {', '  async up(q: QueryRunner) {',
        "    await q.query('ALTER TABLE invoices ADD COLUMN currency char(3)');", '  }', '}']),
    diff('src/invoices/invoice.entity.ts', [' export class Invoice {', '   total: number;', "+  currency: string; // ISO 4217", ' }'], new=False),
], [('iso|4217|stores', DONE), ('existing|usd', GAP), ('pdf', GAP)], slug='currency')

# ── Empty state copy (D1 explicit, UI copy, list) ───────────────────────────
case('reservations-empty-state', 'Calls the copy and the link met from the code, and leaves the illustration to check by hand', 'PROJ-212', 'Empty state for the reservations page',
    ticket('Empty state for the reservations page', 'New members see a blank page.', [
        'With no reservations, the page shows "You have no reservations yet"',
        'The empty state has a "Browse catalog" button that opens /catalog',
        'The illustration matches the design in Figma',
    ]), [
    diff('src/reservations/ReservationsPage.tsx', [
        ' export function ReservationsPage({ reservations }: Props) {',
        '+  if (reservations.length === 0) {', '+    return (', '+      <EmptyState illustration="shelf">',
        '+        <p>You have no reservations yet</p>', '+        <Link to="/catalog"><Button>Browse catalog</Button></Link>',
        '+      </EmptyState>', '+    );', '+  }', '   return <ReservationList items={reservations} />;', ' }'], new=False),
], [('no reservations', ['met', 'check_manually']), ('browse catalog|/catalog', ['met', 'check_manually']), ('illustration|figma', MANUAL)], slug='empty-state')

# ── Rounding with tests (D1 absent test, non-functional) and pt twin ─────────
case('rounding-no-tests', 'Calls the rounding met and the unit tests the ticket asks for missing', 'PROJ-213', 'Round invoice totals to cents',
    ticket('Round invoice totals to cents', 'Totals show 10.004 on some invoices.', [
        'Invoice totals are rounded half-up to 2 decimals',
        'Unit tests cover 0.005 rounding up and 0.004 rounding down',
    ]), [
    diff('src/invoices/total.ts', [
        ' export function invoiceTotal(lines: Line[]) {', '   const raw = lines.reduce((s, l) => s + l.qty * l.price, 0);',
        '-  return raw;', '+  return Math.round((raw + Number.EPSILON) * 100) / 100;', ' }'], new=False),
], [('half-up|2 decimals', DONE), ('unit tests|0[.,]005', GAP)], slug='rounding')
case('cancel-log-pt', 'Calls the log and its test met in a Portuguese ticket', 'PROJ-214', 'Registrar log ao cancelar consulta',
    ticket('Registrar log ao cancelar consulta', 'O suporte não sabe quem cancelou consultas.', [
        'Cancelar uma consulta grava um log com o id da consulta e o motivo',
        'Há um teste cobrindo esse log',
    ], heading='Critérios de aceite'), [
    diff('src/appointments/cancel.ts', [
        ' export async function cancelAppointment(id: string, reason: string) {',
        "   await db.appointments.update(id, { status: 'cancelled' });",
        "+  logger.info({ message: 'appointment cancelled', appointmentId: id, reason });", ' }'], new=False),
    diff('src/appointments/cancel.spec.ts', [
        "import { cancelAppointment } from './cancel';",
        "it('logs the appointment and the reason', async () => {",
        "  await cancelAppointment('a1', 'patient asked');",
        "  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 'a1', reason: 'patient asked' }));", '});']),
], [('grava|motivo|reason|id da consulta', DONE), ('teste|test', DONE)], slug='cancel-log')
case('cancel-log-pt-no-reason', 'Calls the log partial and the test missing when the log drops the reason (control for cancel-log-pt)', 'PROJ-214', 'Registrar log ao cancelar consulta',
    ticket('Registrar log ao cancelar consulta', 'O suporte não sabe quem cancelou consultas.', [
        'Cancelar uma consulta grava um log com o id da consulta e o motivo',
        'Há um teste cobrindo esse log',
    ], heading='Critérios de aceite'), [
    diff('src/appointments/cancel.ts', [
        ' export async function cancelAppointment(id: string, reason: string) {',
        "   await db.appointments.update(id, { status: 'cancelled' });",
        "+  logger.info({ message: 'appointment cancelled', appointmentId: id });", ' }'], new=False),
], [('grava|motivo|reason|id da consulta', GAP), ('teste|test', GAP)], slug='cancel-log')

# ── Parent split into sub-tasks (D1 other sub-task's work) ──────────────────
case('invoice-reminders-parent', 'Calls the scheduling met and the e-mail template, a sub-task not in this PR, not a gap', 'PROJ-215', 'Schedule invoice reminders',
    ticket('Invoice reminders', 'Customers forget to pay.', [
        'An unpaid invoice gets a reminder 7 days after its due date',
        'The reminder e-mail uses the "invoice-reminder" template',
    ]), [
    diff('src/invoices/reminders.ts', [
        "import { queue } from '../queue';",
        'export async function scheduleInvoiceReminder(invoice: { id: string; dueDate: Date; paidAt: Date | null }) {',
        '  if (invoice.paidAt) return;', '  const at = new Date(invoice.dueDate.getTime() + 7 * 86_400_000);',
        "  await queue.add('invoice-reminder', { invoiceId: invoice.id }, { at });", '}']),
], [('7|seven|unpaid', DONE), ('template', MANUAL + ['met'], True)], slug='reminders')
CASES[-1]['ticket']['subtasks'] = [{'key': 'PROJ-217', 'title': 'Reminder e-mail template', 'status': 'To Do'}, {'key': 'PROJ-218', 'title': 'Schedule the reminders', 'status': 'In Progress'}]

# ── Thin task (D3 thin): judges only what it says ───────────────────────────
case('thin-trim-names', 'Calls the one thing the ticket asks met and invents no other requirement (#1725)', 'PROJ-219', 'Trim member names',
    ticket('Trim whitespace in member names', 'Names saved with spaces around them break search. Trim them.'), [
    diff('src/members/saveMember.ts', [
        ' export async function saveMember(input: MemberInput) {',
        '-  return db.members.upsert(input);', '+  return db.members.upsert({ ...input, name: input.name.trim() });', ' }'], new=False),
], [('trim|whitespace|spaces', DONE)], only_gold=True, slug='trim')

# ── Holiday look-alike in Portuguese ────────────────────────────────────────
case('holiday-look-alike-pt', 'Calls the holiday rule missing when the PR blocks weekends instead', 'PROJ-220', 'Bloquear agendamento em feriado',
    ticket('Bloquear agendamento em feriado', 'Pacientes agendam em feriados e ninguém atende.', [
        'Não é possível agendar consulta em feriado nacional',
        'A mensagem mostrada é "Não atendemos em feriados"',
    ], heading='Critérios de aceite'), [
    diff('src/appointments/book.ts', [
        "import { isWeekend } from '../dates';",
        'export async function book(input: { startsAt: Date; patientId: string }) {',
        "  if (isWeekend(input.startsAt)) throw new Error('Não atendemos em feriados');",
        '  return db.appointments.create(input);', '}']),
], [('feriado nacional|holiday|agendar', GAP), ('mensagem|message|n[aã]o atendemos', ['met', 'partial'])], slug='holiday')

# ── Card validation sub-task (D1 other name, validation, sub-task) and twin ──
CHECKOUT_PARENT = ticket('Checkout hardening', 'Payments fail on bad card data.', [
    'The card number is validated with the Luhn check before submitting',
    'An expiry date in the past is refused with "Card expired"',
    'A payment that times out is retried once',
])
case('card-validation-subtask', 'Calls the Luhn check met though the code never says "Luhn", and the retry, another sub-task, not a gap', 'PROJ-221', 'Client-side card validation',
    '# Task: Client-side card validation\n\nThe validation part of the parent story.\n', [
    diff('src/checkout/card.ts', [
        'export function isValidCardNumber(number: string): boolean {',
        "  const digits = number.replace(/\\s/g, '').split('').reverse().map(Number);",
        '  const sum = digits.reduce((s, d, i) => s + (i % 2 ? ((d * 2) % 10) + Math.floor((d * 2) / 10) : d), 0);',
        '  return digits.length >= 12 && sum % 10 === 0;', '}',
        'export function validateCard(card: { number: string; expiry: Date }) {',
        "  if (!isValidCardNumber(card.number)) throw new Error('Invalid card number');",
        "  if (card.expiry < new Date()) throw new Error('Card expired');", '}']),
], [('luhn|card number', DONE), ('expir|past', DONE), ('retr|time', MANUAL, True)],
    related=[sub('PROJ-222', CHECKOUT_PARENT)], slug='card')
CASES[-1]['ticket']['parent'] = 'PROJ-222'
case('card-validation-subtask-length-only', 'Calls the Luhn check missing when only the length is checked, and the expiry message partial (control for card-validation-subtask)', 'PROJ-221', 'Client-side card validation',
    '# Task: Client-side card validation\n\nThe validation part of the parent story.\n', [
    diff('src/checkout/card.ts', [
        'export function validateCard(card: { number: string; expiry: Date }) {',
        "  if (card.number.replace(/\\s/g, '').length < 12) throw new Error('Invalid card number');",
        "  if (card.expiry < new Date()) throw new Error('Invalid card');", '}']),
], [('luhn|card number', GAP), ('expir|past', GAP), ('retr|time', MANUAL, True)],
    related=[sub('PROJ-222', CHECKOUT_PARENT)], slug='card')
CASES[-1]['ticket']['parent'] = 'PROJ-222'

# ── Negative quantities (D1 absent, validation, prose) ──────────────────────
case('negative-quantity-ui-only', 'Calls the server-side rule and its message missing when the PR only adds min="1" to the input', 'PROJ-223', 'Reject negative quantities',
    ticket('Reject negative quantities on invoice lines',
        'Users typed -1 as a quantity and the invoice total went negative. A line with a quantity below 1 must be rejected with "Quantity must be at least 1", and an invoice total must never be negative.'), [
    diff('src/invoices/LineEditor.tsx', [
        ' export function LineEditor({ line, onChange }: Props) {',
        '-  return <input type="number" value={line.qty} onChange={onChange} />;',
        '+  return <input type="number" min={1} value={line.qty} onChange={onChange} />;', ' }'], new=False),
], [('rejected|below 1|at least 1|quantity', GAP), ('never be negative|total', GAP)], slug='quantity')

# ── Appointment DTO outside the diff (D1 outside, API field, sub-task) and twin ─
PORTAL_PARENT = ticket('Patient portal API', 'The portal shows appointment details.', [
    'GET /appointments/:id returns the doctor\'s name',
    'GET /appointments/:id returns the clinic address',
])
DETAIL_ROUTE = diff('src/api/appointments/detail.route.ts', [
    "import { toAppointmentDto } from './appointment.dto';",
    "router.get('/appointments/:id', async (req, res) => {",
    '  const appointment = await db.appointments.get(req.params.id);',
    '  res.json(toAppointmentDto(appointment));', '});'])
case('appointment-dto-outside-diff', 'Calls both fields met: the DTO the new route returns already has them', 'PROJ-224', 'Appointment details endpoint',
    '# Task: Appointment details endpoint\n\nThe details endpoint of the parent story.\n', [DETAIL_ROUTE],
    [('doctor', DONE), ('address', DONE)], related=[sub('PROJ-225', PORTAL_PARENT)],
    repo={'src/api/appointments/appointment.dto.ts': '\n'.join([
        'export function toAppointmentDto(a: Appointment) {',
        '  return { id: a.id, startsAt: a.startsAt.toISOString(), doctorName: a.doctor.name, clinicAddress: a.clinic.address };', '}'])},
    slug='appointment-detail')
CASES[-1]['ticket']['parent'] = 'PROJ-225'
case('appointment-dto-outside-diff-no-address', 'Calls the address missing when the DTO has only the doctor (control for appointment-dto-outside-diff)', 'PROJ-224', 'Appointment details endpoint',
    '# Task: Appointment details endpoint\n\nThe details endpoint of the parent story.\n', [DETAIL_ROUTE],
    [('doctor', DONE), ('address', GAP)], related=[sub('PROJ-225', PORTAL_PARENT)],
    repo={'src/api/appointments/appointment.dto.ts': '\n'.join([
        'export function toAppointmentDto(a: Appointment) {',
        '  return { id: a.id, startsAt: a.startsAt.toISOString(), doctorName: a.doctor.name };', '}'])},
    slug='appointment-detail')
CASES[-1]['ticket']['parent'] = 'PROJ-225'

json.dump(CASES, open(os.path.join(OUT, 'cases.json'), 'w'), indent=2, ensure_ascii=False)
open(os.path.join(OUT, 'cases.json'), 'a').write('\n')
done = sum(1 for c in CASES for g in c['gold'] if 'met' in g['accept'] and not set(g['accept']) & {'missing', 'partial'})
gap = sum(1 for c in CASES for g in c['gold'] if 'met' not in g['accept'] and set(g['accept']) & {'missing', 'partial'})
other = sum(len(c['gold']) for c in CASES) - done - gap
print(f'{len(CASES)} cases · {done} done · {gap} gap · {other} other')
