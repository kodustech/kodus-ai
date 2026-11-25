// The suggestions and the follow-up edits the cases are built from
// (build-cases.js). Every file is a real file at a public benchmark PR's head,
// read from evals/investigation/datasets. Every edit is written by hand, and its
// expected status is known by construction:
//   fixed      the change the suggestion asked for, as it proposed it
//   different  the problem fixed another way
//   untouched  the same file edited elsewhere, the problem left as it was
//   declined   the suggested lines edited, the problem kept
//   partial    one of the suggestion's two asks done, the other not
//
// A suggestion with `improvedCode: ''` is one the enrichment shipped without a
// fix (fixStatus other than `local`, #1833); `kodyRule` marks a Kody Rules one.

const SUGGESTIONS = {
    'ts-admin-or-owner': {
        dataset: 'add-guest-management-functionality-to-existing-bookings-cal-com',
        file: 'packages/trpc/server/routers/viewer/bookings/addGuests.handler.ts',
        language: 'typescript',
        label: 'bug',
        severity: 'critical',
        lines: [46, 48],
        summary: 'Team admin/owner check requires both roles',
        content:
            'The permission check uses `&&`, so only a user who is both a team admin and a team owner passes. A user who is either one should be allowed to add guests. Use `||` between `isTeamAdmin` and `isTeamOwner`.',
        existingCode:
            '  const isTeamAdminOrOwner =\n    (await isTeamAdmin(user.id, booking.eventType?.teamId ?? 0)) &&\n    (await isTeamOwner(user.id, booking.eventType?.teamId ?? 0));',
        improvedCode:
            '  const isTeamAdminOrOwner =\n    (await isTeamAdmin(user.id, booking.eventType?.teamId ?? 0)) ||\n    (await isTeamOwner(user.id, booking.eventType?.teamId ?? 0));',
        edits: {
            fixed: [
                ['    (await isTeamAdmin(user.id, booking.eventType?.teamId ?? 0)) &&', '    (await isTeamAdmin(user.id, booking.eventType?.teamId ?? 0)) ||'],
            ],
            different: [
                [
                    '  const isTeamAdminOrOwner =\n    (await isTeamAdmin(user.id, booking.eventType?.teamId ?? 0)) &&\n    (await isTeamOwner(user.id, booking.eventType?.teamId ?? 0));',
                    '  const teamId = booking.eventType?.teamId ?? 0;\n  const [teamAdmin, teamOwner] = await Promise.all([\n    isTeamAdmin(user.id, teamId),\n    isTeamOwner(user.id, teamId),\n  ]);\n  const isTeamAdminOrOwner = Boolean(teamAdmin) || Boolean(teamOwner);',
                ],
            ],
            untouched: [
                ['    throw new TRPCError({ code: "BAD_REQUEST", message: "emails_must_be_unique_valid" });', '    throw new TRPCError({ code: "BAD_REQUEST", message: "guest_emails_must_be_unique_and_valid" });'],
            ],
            declined: [
                [
                    '  const isTeamAdminOrOwner =\n    (await isTeamAdmin(user.id, booking.eventType?.teamId ?? 0)) &&\n    (await isTeamOwner(user.id, booking.eventType?.teamId ?? 0));',
                    '  const teamId = booking.eventType?.teamId ?? 0;\n  // Adding guests to a team booking stays restricted to users who are both admin and owner.\n  const isTeamAdminOrOwner = (await isTeamAdmin(user.id, teamId)) && (await isTeamOwner(user.id, teamId));',
                ],
            ],
        },
    },
    'ts-guest-email-case': {
        dataset: 'add-guest-management-functionality-to-existing-bookings-cal-com',
        file: 'packages/trpc/server/routers/viewer/bookings/addGuests.handler.ts',
        language: 'typescript',
        label: 'security',
        severity: 'high',
        lines: [74, 78],
        summary: 'Guest emails are compared case-sensitively',
        content:
            'Guest emails are compared as typed: `Foo@x.com` slips past the lowercased blacklist, and an existing attendee written with different casing is added again. Lowercase each guest email before comparing it with the blacklist, and compare attendee emails case-insensitively.',
        existingCode:
            '  const uniqueGuests = guests.filter(\n    (guest) =>\n      !booking.attendees.some((attendee) => guest === attendee.email) &&\n      !blacklistedGuestEmails.includes(guest)\n  );',
        improvedCode: '',
        edits: {
            fixed: [
                [
                    '      !booking.attendees.some((attendee) => guest === attendee.email) &&\n      !blacklistedGuestEmails.includes(guest)',
                    '      !booking.attendees.some((attendee) => guest.toLowerCase() === attendee.email.toLowerCase()) &&\n      !blacklistedGuestEmails.includes(guest.toLowerCase())',
                ],
            ],
            different: [
                [
                    '  const uniqueGuests = guests.filter(\n    (guest) =>\n      !booking.attendees.some((attendee) => guest === attendee.email) &&\n      !blacklistedGuestEmails.includes(guest)\n  );',
                    '  const attendeeEmails = new Set(booking.attendees.map((attendee) => attendee.email.toLowerCase()));\n  const uniqueGuests = guests\n    .map((guest) => guest.trim().toLowerCase())\n    .filter((guest) => !attendeeEmails.has(guest) && !blacklistedGuestEmails.includes(guest));',
                ],
            ],
            untouched: [
                ['      name: "",', '      name: guest.split("@")[0],'],
            ],
            declined: [
                [
                    '  const uniqueGuests = guests.filter(\n    (guest) =>\n      !booking.attendees.some((attendee) => guest === attendee.email) &&\n      !blacklistedGuestEmails.includes(guest)\n  );',
                    '  // Emails are matched exactly as entered; the input form already normalises them.\n  const uniqueGuests = guests.filter(\n    (guest) => !booking.attendees.some((attendee) => attendee.email === guest) && !blacklistedGuestEmails.includes(guest)\n  );',
                ],
            ],
            partial: [
                ['      !blacklistedGuestEmails.includes(guest)\n', '      !blacklistedGuestEmails.includes(guest.toLowerCase())\n'],
            ],
        },
    },
    'py-sender-keyerror': {
        dataset: 'github-oauth-security-enhancement-sentry',
        file: 'src/sentry/integrations/github/integration.py',
        language: 'python',
        label: 'bug',
        severity: 'high',
        lines: [501, 505],
        summary: 'KeyError when the installation has no sender metadata',
        content:
            '`integration.metadata["sender"]["login"]` raises `KeyError` for installations created before the sender was stored. Read it with `.get` and fail the step with the error page when the sender is missing.',
        existingCode:
            '        if (\n            pipeline.fetch_state("github_authenticated_user")\n            != integration.metadata["sender"]["login"]\n        ):\n            return error(request, self.active_organization)',
        improvedCode:
            '        sender_login = integration.metadata.get("sender", {}).get("login")\n        if (\n            sender_login is None\n            or pipeline.fetch_state("github_authenticated_user") != sender_login\n        ):\n            return error(request, self.active_organization)',
        edits: {
            fixed: [
                [
                    '        if (\n            pipeline.fetch_state("github_authenticated_user")\n            != integration.metadata["sender"]["login"]\n        ):\n            return error(request, self.active_organization)',
                    '        sender_login = integration.metadata.get("sender", {}).get("login")\n        if (\n            sender_login is None\n            or pipeline.fetch_state("github_authenticated_user") != sender_login\n        ):\n            return error(request, self.active_organization)',
                ],
            ],
            different: [
                [
                    '        if (\n            pipeline.fetch_state("github_authenticated_user")\n            != integration.metadata["sender"]["login"]\n        ):\n            return error(request, self.active_organization)',
                    '        try:\n            sender_login = integration.metadata["sender"]["login"]\n        except KeyError:\n            return error(request, self.active_organization)\n        if pipeline.fetch_state("github_authenticated_user") != sender_login:\n            return error(request, self.active_organization)',
                ],
            ],
            untouched: [
                ['        if "login" not in authenticated_user_info:\n            return error(request, self.active_organization)', '        if not authenticated_user_info.get("login"):\n            return error(request, self.active_organization)'],
            ],
            declined: [
                [
                    '        # Check that the authenticated GitHub user is the same as who installed the app.\n        if (\n            pipeline.fetch_state("github_authenticated_user")\n            != integration.metadata["sender"]["login"]\n        ):',
                    '        # Check that the authenticated GitHub user is the same as who installed the app.\n        # Every installation stores its sender at creation, so the key is always present.\n        authenticated_user = pipeline.fetch_state("github_authenticated_user")\n        if authenticated_user != integration.metadata["sender"]["login"]:',
                ],
            ],
        },
    },
    'py-oauth-static-state': {
        dataset: 'github-oauth-security-enhancement-sentry',
        file: 'src/sentry/integrations/github/integration.py',
        language: 'python',
        label: 'kody_rules',
        severity: 'medium',
        lines: [401, 413],
        summary: 'OAuth state is the static pipeline signature',
        content:
            'The OAuth `state` is `pipeline.signature`, the same value for the whole pipeline, so it does not protect this callback against CSRF. Generate a random state per authorization request, bind it to the pipeline, and compare the callback\'s state against it.\n\nKody rule violation: [OAuth state is random per request](https://app.kodus.io/settings/code-review/global/kody-rules/rule-oauth-state)',
        existingCode:
            '        if not request.GET.get("state"):\n            state = pipeline.signature\n',
        improvedCode: '',
        kodyRule: 'rule-oauth-state',
        edits: {
            fixed: [
                ['        if not request.GET.get("state"):\n            state = pipeline.signature\n', '        if not request.GET.get("state"):\n            state = secrets.token_urlsafe(32)\n            pipeline.bind_state("oauth_state", state)\n'],
                ['        if request.GET.get("state") != pipeline.signature:', '        if not constant_time_compare(request.GET.get("state", ""), pipeline.fetch_state("oauth_state") or ""):'],
            ],
            different: [
                ['        if not request.GET.get("state"):\n            state = pipeline.signature\n', '        if not request.GET.get("state"):\n            state = uuid4().hex\n            request.session["github_oauth_state"] = state\n'],
                ['        if request.GET.get("state") != pipeline.signature:', '        if request.GET.get("state") != request.session.pop("github_oauth_state", None):'],
            ],
            untouched: [
                ['        pipeline.bind_state("github_authenticated_user", authenticated_user_info["login"])', '        pipeline.bind_state("github_authenticated_user", authenticated_user_info["login"].lower())'],
            ],
            declined: [
                ['        if not request.GET.get("state"):\n            state = pipeline.signature\n', '        if not request.GET.get("state"):\n            # The pipeline signature is unique per pipeline, which is enough as an OAuth state here.\n            state = str(pipeline.signature)\n'],
            ],
        },
    },
    'java-subgroups-null': {
        dataset: 'fix-concurrent-group-access-to-prevent-nullpointerexception-keycloak',
        file: 'model/infinispan/src/main/java/org/keycloak/models/cache/infinispan/GroupAdapter.java',
        language: 'java',
        label: 'bug',
        severity: 'critical',
        lines: [272, 276],
        summary: 'getSubGroupsCount returns null',
        content:
            '`getSubGroupsCount()` returns `null` when the group was removed concurrently, but the `GroupModel` contract says it never returns null and callers unbox it. Return `0L` when the model is gone.',
        existingCode:
            '    public Long getSubGroupsCount() {\n        if (isUpdated()) return updated.getSubGroupsCount();\n        GroupModel model = modelSupplier.get();\n        return model == null ? null : model.getSubGroupsCount();\n    }',
        improvedCode: '',
        edits: {
            fixed: [
                ['        return model == null ? null : model.getSubGroupsCount();', '        return model == null ? 0L : model.getSubGroupsCount();'],
            ],
            different: [
                [
                    '        GroupModel model = modelSupplier.get();\n        return model == null ? null : model.getSubGroupsCount();',
                    '        GroupModel model = modelSupplier.get();\n        if (model == null) {\n            return Long.valueOf(0);\n        }\n        Long count = model.getSubGroupsCount();\n        return count == null ? Long.valueOf(0) : count;',
                ],
            ],
            untouched: [
                ['        return modelSupplier.get().getSubGroupsStream(search, exact, firstResult, maxResults);', '        GroupModel model = modelSupplier.get();\n        return model == null ? Stream.empty() : model.getSubGroupsStream(search, exact, firstResult, maxResults);'],
            ],
            declined: [
                ['        GroupModel model = modelSupplier.get();\n        return model == null ? null : model.getSubGroupsCount();', '        GroupModel model = modelSupplier.get();\n        // null tells the caller the group no longer exists\n        return (model != null) ? model.getSubGroupsCount() : null;'],
            ],
        },
    },
    'go-rows-not-limit': {
        dataset: 'anonymous-add-configurable-device-limit-grafana-codex',
        file: 'pkg/services/anonymous/anonimpl/anonstore/database.go',
        language: 'go',
        label: 'bug',
        severity: 'low',
        lines: [95, 97],
        summary: 'Zero updated rows reported as device limit reached',
        content:
            'When the update touches no row the device may simply not exist, yet the code returns `ErrDeviceLimitReached`. Return a distinct not-found error so callers can tell the two apart.',
        existingCode: '\t\tif rowsAffected == 0 {\n\t\t\treturn ErrDeviceLimitReached\n\t\t}',
        improvedCode: '\t\tif rowsAffected == 0 {\n\t\t\treturn ErrDeviceNotFound\n\t\t}',
        edits: {
            fixed: [
                ['var ErrDeviceLimitReached = fmt.Errorf("device limit reached")', 'var ErrDeviceLimitReached = fmt.Errorf("device limit reached")\nvar ErrDeviceNotFound = fmt.Errorf("device not found")'],
                ['\t\tif rowsAffected == 0 {\n\t\t\treturn ErrDeviceLimitReached\n\t\t}', '\t\tif rowsAffected == 0 {\n\t\t\treturn ErrDeviceNotFound\n\t\t}'],
            ],
            different: [
                ['\t\tif rowsAffected == 0 {\n\t\t\treturn ErrDeviceLimitReached\n\t\t}', '\t\tif rowsAffected == 0 {\n\t\t\treturn fmt.Errorf("anonymous device %s: %w", device.DeviceID, sql.ErrNoRows)\n\t\t}'],
            ],
            untouched: [
                ['\t\t_, err := dbSession.Exec("DELETE FROM anon_device WHERE device_id = ?", deviceID)', '\t\t_, err := dbSession.Exec("DELETE FROM anon_device WHERE device_id = ? ", deviceID)\n\t\tif err != nil {\n\t\t\ts.log.Debug("failed to delete anonymous device", "device", deviceID, "error", err)\n\t\t}'],
            ],
            declined: [
                ['\t\tif rowsAffected == 0 {\n\t\t\treturn ErrDeviceLimitReached\n\t\t}', '\t\t// No row updated: the device is over the limit window, report it as the limit.\n\t\tif rowsAffected < 1 {\n\t\t\treturn ErrDeviceLimitReached\n\t\t}'],
            ],
        },
    },
    'rb-embed-import': {
        dataset: 'enhance-embed-url-handling-and-validation-system-discourse-cursor',
        file: 'app/models/topic_embed.rb',
        language: 'ruby',
        label: 'security',
        severity: 'medium',
        lines: [13, 13],
        summary: 'Imported-from footer breaks on nil contents and injects the URL',
        content:
            '`contents <<` raises `NoMethodError` when `contents` is nil, and the URL is interpolated into the HTML unescaped, so a crafted feed URL injects markup. Default `contents` to an empty string and escape the URL with `ERB::Util.html_escape`.',
        existingCode:
            '    contents << "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{url}\'>#{url}</a>")}</small>\\n"',
        improvedCode: '',
        edits: {
            fixed: [
                [
                    '    contents << "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{url}\'>#{url}</a>")}</small>\\n"',
                    '    contents ||= \'\'\n    safe_url = ERB::Util.html_escape(url)\n    contents << "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{safe_url}\'>#{safe_url}</a>")}</small>\\n"',
                ],
            ],
            different: [
                [
                    '    contents << "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{url}\'>#{url}</a>")}</small>\\n"',
                    '    link = ActionController::Base.helpers.link_to(url, url)\n    contents = "#{contents}\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: link)}</small>\\n"',
                ],
            ],
            untouched: [
                ['        revisor.revise!(user, absolutize_urls(url, contents), skip_validations: true, bypass_rate_limiter: true)', '        revisor.revise!(user, absolutize_urls(url, contents), skip_validations: true, bypass_rate_limiter: true, skip_revision: true)'],
            ],
            declined: [
                [
                    '    contents << "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{url}\'>#{url}</a>")}</small>\\n"',
                    '    # The URL was already checked against the http(s) pattern above.\n    footer = "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{url}\'>#{url}</a>")}</small>\\n"\n    contents << footer',
                ],
            ],
            partial: [
                [
                    '    contents << "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{url}\'>#{url}</a>")}</small>\\n"',
                    '    contents ||= \'\'\n    contents << "\\n<hr>\\n<small>#{I18n.t(\'embed.imported_from\', link: "<a href=\'#{url}\'>#{url}</a>")}</small>\\n"',
                ],
            ],
        },
    },
    'js-origin-indexof': {
        dataset: 'enhance-embed-url-handling-and-validation-system-discourse-cursor',
        file: 'app/assets/javascripts/embed.js',
        language: 'javascript',
        label: 'kody_rules',
        severity: 'medium',
        lines: [17, 17],
        summary: 'postMessage origin checked with indexOf',
        content:
            '`discourseUrl.indexOf(e.origin)` accepts any origin that is a substring of the Discourse URL, so a prefix origin passes. Compare `e.origin` exactly with the origin of `discourseUrl`.\n\nKody rule violation: [Exact origin match on postMessage](https://app.kodus.io/settings/code-review/global/kody-rules/rule-postmessage-origin)',
        existingCode: '    if (discourseUrl.indexOf(e.origin) === -1) { return; }',
        improvedCode: '    if (e.origin !== new URL(discourseUrl).origin) { return; }',
        kodyRule: 'rule-postmessage-origin',
        edits: {
            fixed: [
                ['    if (discourseUrl.indexOf(e.origin) === -1) { return; }', '    if (e.origin !== new URL(discourseUrl).origin) { return; }'],
            ],
            different: [
                ['  function postMessageReceived(e) {', '  var discourseOrigin = discourseUrl.replace(/^(https?:\\/\\/[^\\/]+).*$/, "$1");\n\n  function postMessageReceived(e) {'],
                ['    if (discourseUrl.indexOf(e.origin) === -1) { return; }', '    if (e.origin !== discourseOrigin) { return; }'],
            ],
            untouched: [
                ['  iframe.scrolling = "no";', '  iframe.scrolling = "no";\n  iframe.title = "Discourse comments";'],
            ],
            declined: [
                ['    if (discourseUrl.indexOf(e.origin) === -1) { return; }', '    if (!e.origin || discourseUrl.indexOf(e.origin) < 0) { return; }'],
            ],
        },
    },
};

const KINDS = {
    fixed: { expected: 'implemented', checks: 'marks implemented a fix made as suggested' },
    different: { expected: 'implemented', checks: 'marks implemented the problem fixed another way' },
    untouched: { expected: 'not_implemented', checks: 'leaves not implemented when only other code in the file changed' },
    declined: { expected: 'not_implemented', checks: 'leaves not implemented when the lines were edited but the problem kept' },
    partial: { expected: 'partially_implemented', checks: 'marks partially implemented when one of its two asks was done' },
};

// Checks with more than one suggestion, as a push usually brings: each
// suggestion with the edit applied to it, all in one check.
const MULTI = [
    { id: 'multi-same-file', checks: 'judges two suggestions in one file apart: one fixed, one left', parts: [['ts-admin-or-owner', 'fixed'], ['ts-guest-email-case', 'untouched']] },
    { id: 'multi-cross-file', checks: 'judges suggestions in two files apart: one declined, one fixed', parts: [['py-sender-keyerror', 'declined'], ['java-subgroups-null', 'fixed']] },
    { id: 'multi-three-files', checks: 'judges three suggestions in three files: fixed, untouched, declined', parts: [['rb-embed-import', 'fixed'], ['go-rows-not-limit', 'untouched'], ['js-origin-indexof', 'declined']] },
];

// A suggestion already recorded as partially implemented, and a later push
// that leaves its code alone: the record must not go down.
const KEEPS = [
    { id: 'keeps-partial-ts', checks: 'keeps a recorded partial when a later push leaves the code alone', suggestion: 'ts-guest-email-case', stored: 'partially_implemented', base: 'partial', edit: 'untouched' },
    { id: 'keeps-partial-rb', checks: 'keeps a recorded partial when a later push leaves the code alone', suggestion: 'rb-embed-import', stored: 'partially_implemented', base: 'partial', edit: 'untouched' },
];

module.exports = { SUGGESTIONS, KINDS, MULTI, KEEPS };
