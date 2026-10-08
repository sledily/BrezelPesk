# Browser notifications and maintenance wake-up

This is review-branch implementation, not evidence of live delivery. No VAPID
credentials, scheduler secrets, domain, live subscription or paid service has been
created. The existing host address can be used; a custom domain is optional.

## Player behavior

Notifications are opt-in for each game and controlling browser. The permission
prompt runs only after pressing Enable notifications. Disabling a game does not
unsubscribe the browser from its other games. Recovery replaces control and
invalidates the former session's subscription; the recovered browser must opt in.
Denied/unsupported permission and unconfigured delivery leave ordinary play usable.
The browser may display the human-readable game name on its lock screen.

Events are limited to a newly gained action period or required Ransom, Quarter,
Conquest or resignation-voting decision; a terminal game while away; and the host's
full Free choice/Host chooses lobby. Random produces no ready alert. There are no
email, invitation, public-update or repeated inactivity reminders. Signing up does
not replay historical alerts.

Only generic decision text, game name, room link and opaque event identifiers are
sent. No Court contents, cards, RNG, seat credentials or recovery codes are included.
Subscription endpoints and keys are operational data outside participant exports
and the public room view. Administrator inspection exposes job status/attempts,
not subscription keys.

## Persistence and delivery

The current opportunity's job is saved atomically with its room transition. Each
participant has at most one retained job; obsolete jobs are replaced or discarded.
A failed gameplay save cannot send an uncommitted alert. Retried mutations don't
create another job. Rename, ordinary private drafting, polling and vote changes
that retain the same opportunity don't generate another alert.

Workers claim a durable 60-second lease, send outside the room transaction with a
10-second socket timeout, and record success. Failure retries with bounded backoff;
404/410 removes the subscription. Work is validated against current control and the
current opportunity before sending. A notification already in flight cannot be
recalled after recovery or opt-out. Pending jobs older than 30 days are discarded.
Foreground room views suppress already-seen opportunities. The service worker also
checks for a focused matching window, refreshes it and avoids a system alert.

A transport timeout or lost acknowledgement can cause another send of the same
opaque event ID. The push topic, stable browser tag and IndexedDB receipts coalesce
or suppress duplicates. This is not a guarantee of exactly-once OS display: browser
crashes, cleared site storage, permission revocation or platform behavior can still
lose or repeat a presentation. Provider acceptance is not proof that the person saw
an alert. A short five-minute push TTL avoids retaining stale decisions on an offline
device. Opening the game always fetches authoritative state.

The endpoint allowlist currently accepts FCM, Mozilla's updates push service,
Apple Web Push and Windows notification subdomains over standard HTTPS. Invalid
keys and arbitrary destinations are rejected to prevent server-side requests to
private infrastructure. Other push services require explicit review/support.

## Deployment configuration — not yet activated

Set these server environment variables through the deployment secret manager:

- `DENDARV_PUBLIC_ORIGIN`: the exact public HTTPS origin, e.g. the existing host's
  address. No path, query or fragment. Browser opt-in requires this same origin.
- `DENDARV_VAPID_PUBLIC_KEY` and `DENDARV_VAPID_PRIVATE_KEY`: one persistent VAPID
  keypair. Generate once with `npx web-push generate-vapid-keys --json` in a trusted
  administrative environment. Keep the private key out of Git and logs.
- `DENDARV_VAPID_SUBJECT`: a valid administrator contact, such as `mailto:…`.
- `DENDARV_MAINTENANCE_TOKEN`: a separate random secret of at least 32 characters,
  used only for the maintenance endpoint. Do not reuse administrator credentials.

Do not generate new VAPID keys on each boot. Preserve them alongside deployment
secrets for disaster recovery; replacing them can require fresh subscriptions.
Changing the website origin also requires fresh browser permission/subscriptions.
Service workers and Push APIs require an appropriate secure browser context.
Actual browser/OS support must be checked on the intended devices; simulated tests
do not establish Android/iOS or closed-browser delivery.

## Independent wake-up

`POST /api/maintenance` accepts the maintenance token as a Bearer header. It kicks
or runs deadline, archive and notification processing; it exposes no game data and
has a short request throttle. Its `accepted` response does not promise all retries
succeeded. Inspect administrator job status for outstanding attempts.

An optional GitHub Actions workflow is supplied in `.github/workflows/maintenance.yml`.
It is inert until the workflow is on the default branch and the repository variable
`DENDARV_MAINTENANCE_ENABLED` is set to `true`. No variable or secret has been set.
To activate after deployment review:

1. Set repository variable `DENDARV_MAINTENANCE_URL` to the deployed HTTPS
   `/api/maintenance` endpoint and repository secret `DENDARV_MAINTENANCE_TOKEN`
   to the matching server secret.
2. Enable the repository variable, then use the manual workflow once to verify a
   real authenticated request. Verify server-side reconciliation/delivery too.
3. The supplied schedule requests maintenance at minutes 7, 22, 37 and 52. Disable
   it by clearing the enable variable. The same Node script can be used by another
   approved external scheduler.

GitHub scheduled workflows run from the default branch, can be delayed or dropped
under load, and are disabled in public repositories after 60 days without activity.
This is a best-effort candidate, not a precise or indefinite always-on service.
Confirm current hosting/scheduler terms and ongoing operation before release. No
paid worker is required by this implementation, but no free scheduler guarantee is
claimed. If stronger timeliness is required, select a suitable scheduler separately.

Local background timers process work while the server runs; they cannot wake a
sleeping host themselves. On every relevant request and before accepting gameplay,
expired ballots still reconcile against their original deadline. Thus a delayed
wake-up does not extend the voting period or permit late votes.

## Verification and release checks

Automated tests use synthetic subscriptions and an injected sender; they send no
real notifications. They cover file/PostgreSQL persistence, single job creation,
worker races, failure retry, recovery, opt-out, obsolete alerts, terminal privacy,
foreground suppression, service-worker receipt/click behavior and maintenance auth.
The existing game rules, archive and whole-database backup suites also run.

Before enabling this publicly, perform HTTPS device tests: opt-in/denial/opt-out,
foreground/background/closed-tab delivery, restart/recovery, new turn/required
response, game ending, worker upgrade and notification click. Verify a real cold-start
maintenance request and the chosen scheduler. Browser/OS delivery and deployed
wake-up have not been verified here.

Primary references checked during implementation:
- https://github.com/web-push-libs/web-push
- https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
