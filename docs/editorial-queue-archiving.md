# Editorial queue archiving

Editorial queue archiving is a retained disposition, not an editorial or publication status. An intake keeps `UNSUITABLE`, and a candidate keeps `REJECTED`, while nullable `archived_at`, `archived_by_email`, and `archive_reason` fields remove it from the default working queue.

The Access-protected `/editorial/history` page lists archived intakes and candidates and exposes explicit restore controls on each detail page. Archive and restore operations preserve `created_at` and `updated_at`; each operation instead writes its own append-only `editorial_audit_log` entry. Archived detail pages are read-only until restored.

Bulk cleanup is limited to two server-defined operations: all currently unarchived `UNSUITABLE` intakes or all currently unarchived `REJECTED` candidates. The page displays the eligible count, submits it as an expected count, and fails closed if a fresh server count differs. Each successful D1 batch inserts one audit row per affected entity and repeats the terminal-status predicate in the update.

Archive filters apply only to active editorial views and generation-ready selection. Identity, source-URL, source-reference, model-run, and idempotency lookups remain unfiltered, so archived material stays known and cannot be rediscovered as new.

Migration `0013_editorial_queue_archiving.sql` is a separately reviewed production operation. Deployment does not apply it. Do not deploy code that reads the archive columns until the migration has been explicitly applied and verified on the intended D1 database.
