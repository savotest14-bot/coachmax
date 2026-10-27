# Audit fixes: release procedure

These source changes require MongoDB transactions (a replica set), reviewed data backfills, and explicit indexes. Startup disables automatic index creation and checks integrity before listening. Do not deploy the API before completing the migration rehearsal below.

## Configuration

- Supply secrets through deployment configuration. `.env` and the service account are now excluded from version control; credentials previously committed to Git history still require provider-side rotation and session invalidation.
- Set `JWT_SECRET` to a new strong value of at least 32 characters; set `MONGO_URI` to the intended replica set. Do not reuse test keys.
- Set `APP_DEFAULT_TIMEZONE` explicitly; the compatibility default is `Australia/Sydney`. Display calendar dates as DD/MM/YYYY; API calendar values remain YYYY-MM-DD. UTC timestamps remain timestamps.
- Set `ALLOWED_ORIGINS`, `FRONTEND_URL`, and `PARENT_APP_URL` to trusted HTTPS destinations. The parent application must support its password setup/Forgot Password route. No request Origin/Referer is used to construct account links.
- Set `TRUST_PROXY_HOPS` for the actual reverse proxy topology; default zero is suitable for direct connections. Prevent direct access around a trusted proxy.
- Set an absolute durable `UPLOAD_ROOT`. Back up the files with the database. Configure the reverse proxy to forward private uploads through this API; do not expose their folders through another public static route.
- Configure `EMAIL_USER`/`EMAIL_PASS` plus optional `EMAIL_HOST`/`EMAIL_PORT`; otherwise the Gmail transport compatibility setting applies. Configure Firebase credentials if push delivery is used. Email/provider delivery is separate from successful queuing.
- Optional initial administrator creation requires all three of `ADMIN_EMAIL`, `ADMIN_MOBILE`, `ADMIN_PASSWORD`. Omit all three when seeding is not needed.

## Rehearse on a restored staging database

1. Verify a database-and-media backup can be restored. Keep the old deployment artifacts and record their versions.
2. Stop application writers, scheduled jobs and old API instances during apply. Preserve exported reports and the operator/backup identifiers.
3. Supply `INTEGRITY_MIGRATION_URI` through secure operator configuration. It is deliberately separate from the application's `MONGO_URI`; the CLI never loads `.env`. Run a read-only inventory:

   ```text
   node scripts/migrate-integrity.js --uri-env INTEGRITY_MIGRATION_URI --database RESTORED_DATABASE
   ```

4. Resolve every reported conflict deliberately: missing term identity, same-term duplicate normalized names, invalid fixtures, duplicate round participation, field overlaps, existing duplicate invoice/order/cart/medical identities, or obsolete indexes. Do not assign terms or merge historical records by name alone. Legacy date offsets are not guessed or bulk-shifted.
5. After review and a restore-tested backup, apply the plan explicitly:

   ```text
   node scripts/migrate-integrity.js --uri-env INTEGRITY_MIGRATION_URI --database RESTORED_DATABASE --apply --actor OPERATOR --backup-reference RESTORE_ID --confirm-backup --maintenance-confirmed
   ```

   If the dry run identifies an obsolete global team-name unique index, its removal also requires `--drop-obsolete-team-name-indexes`. The migration stores backfill before/after audit data, creates indexes, verifies readiness and is repeatable. Index DDL is not transactional; keep maintenance mode until the gate passes. A rerun resumes safe completed work.
6. Supply `VERIFICATION_MIGRATION_URI` explicitly, pointing to the restored database. Run `node scripts/reconcileVerification.js` without flags first. It reports orphan requests, exact negative medical text, known alerts and records needing human review. It does not create collections/indexes in dry-run mode or print medical text.
7. Review that report. To apply, set `VERIFICATION_MIGRATION_ACTOR` to the verified administrator's ObjectId and run `node scripts/reconcileVerification.js --apply`. Ambiguous conditions and allergies are preserved for review. Repeat the dry run to verify convergence.
8. Start the new API, check `/health/live` and `/health/ready`, and run the staging acceptance scenarios. Missing critical indexes/backfills deliberately prevent startup.
9. Build the frontend from this source and test with the same API/media origins. Deploy coordinated clients: password reset requires the returned one-use `resetToken`; private attachments use short-lived signed URLs; date-only fields use ISO strings.
10. Verify actual multipart upload/download, SMTP, push, proxy size limits, TLS, socket logout/revocation, backup recovery and parent/mobile compatibility. Browser mocks and disposable Mongo tests do not establish these deployment facts.

## Business behavior used by these fixes

- U group = selected term year minus birth year; general lists use the organization's current year. Birthdays do not change a U group within that year.
- Term metadata remains editable. Date changes cannot exclude recorded attendance or scheduled fixtures. Historical date repairs require source evidence.
- Team identity is a separate ID per term; same normalized name is allowed across different terms. Term moves are rejected. Deletion archives historical teams/leagues.
- One team participates once per league round. Field-time conflicts are enforced within a league. Shared physical fields across separate leagues need an agreed venue/field identity before cross-league validation can be added safely.
- Save Final Result completes even 0–0. Live scores remain live. Corrections/reopening reverse previous derived totals, and recorded activity cannot be silently deleted/regenerated.
- Admin verification combines class/program and coach-temporary requests. Team-only guest subdocuments stay separate. Approval allocates selected classes and completes only the chosen request. Capacity and eligibility checks apply; exceptions require a logged reason.
- Payment status must be explicit; PAID cannot be invented by an allocation request. Transfers charge a positive price difference transactionally; no automatic credit for a cheaper class is invented. Checkout calculations use integer minor units; historical monetary amounts are not silently converted.
- Attendance has one editable staff note per player/session with revisions. Notes can exist without a marked status; clearing status preserves the note. Staff notes are not exposed in parent schedule responses. Parent absence reason and reporter metadata remain separate.
- Medical YES requires meaningful details. NO removes the current alert only when there is no known allergy; removing a recorded allergy requires an explicit medical update. Prior values remain in restricted revisions.
- New temporary-parent accounts receive password setup instructions using the OTP flow. Reusable passwords are never emailed. Email/notification intents are committed with the relevant operation and retried separately. Delivery is at least once; providers may deliver duplicates after an uncertain acknowledgement.
- Expired events are completed/closed rather than purged. Retention/purge periods, refunds/credits, proration, shared-venue rules and parent note visibility remain organization policy decisions.

## Verification commands

```text
npm ci
npm run check
npm test
npm audit --omit=dev --audit-level=moderate
```

Automated tests create disposable local Mongo replica sets under `.test-tmp`, do not load application `.env`, and do not send real email/push. The old manual holiday-camp script is excluded from the runner, does not load `.env`, and refuses any URI outside an explicitly named disposable loopback database.

## Recovery

Keep maintenance mode while recovering from a migration or readiness failure. Restore the reviewed database/media backup together if data repair must be undone; schema and index changes cannot be safely reversed by simply deploying old code. Preserve committed invoices, orders, attendance and migration audit records. A code-only rollback may reintroduce the vulnerabilities addressed here and may not understand new request states; validate it against the restored snapshot before use.
