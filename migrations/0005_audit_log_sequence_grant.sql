-- Gathered: fix found while building Slice 1. 0002 granted gathered_app INSERT on app.audit_log
-- but not USAGE on its bigserial sequence, so every audit_log insert from the application failed
-- with "permission denied for sequence audit_log_id_seq". The ranking client writes one
-- audit_log row per model attempt, so the app role needs the sequence. No other privilege changes.
grant usage on sequence app.audit_log_id_seq to gathered_app;
