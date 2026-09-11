ALTER TABLE model_runs
ADD COLUMN provider_http_status INTEGER CHECK (
    provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599
);
ALTER TABLE model_runs ADD COLUMN provider_error_type TEXT;
ALTER TABLE model_runs ADD COLUMN provider_error_code TEXT;
ALTER TABLE model_runs ADD COLUMN provider_error_message TEXT;
ALTER TABLE model_runs ADD COLUMN provider_request_id TEXT;
ALTER TABLE model_runs ADD COLUMN provider_retry_after TEXT;

PRAGMA optimize;
