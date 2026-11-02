-- OlahPDF — skema database
-- Tabel jobs sekaligus berfungsi sebagai antrean (queue) antara API Node.js dan worker Python.
-- Worker mengambil job dengan SELECT ... FOR UPDATE SKIP LOCKED sehingga aman dijalankan paralel.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool          VARCHAR(40)  NOT NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'queued',
    options       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    input_files   JSONB        NOT NULL DEFAULT '[]'::jsonb,   -- [{field, name, path, size}]
    output_path   TEXT,
    output_name   TEXT,
    output_size   BIGINT,
    result        JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- info tambahan (jumlah halaman, rasio kompresi, dll)
    error         TEXT,
    attempts      SMALLINT     NOT NULL DEFAULT 0,
    client_ip     INET,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ  NOT NULL DEFAULT now() + interval '1 hour',
    CONSTRAINT jobs_status_chk CHECK (status IN ('queued', 'processing', 'done', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx   ON jobs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_expires_idx ON jobs (expires_at) WHERE status <> 'expired';
CREATE INDEX IF NOT EXISTS jobs_tool_idx    ON jobs (tool, created_at);

-- Statistik ringkas per tool per hari (untuk dashboard/monitoring)
CREATE OR REPLACE VIEW job_stats_daily AS
SELECT date_trunc('day', created_at)::date AS day,
       tool,
       count(*)                                   AS total,
       count(*) FILTER (WHERE status = 'done')    AS done,
       count(*) FILTER (WHERE status = 'failed')  AS failed,
       round(avg(extract(epoch FROM finished_at - started_at))::numeric, 2) AS avg_seconds
FROM jobs
GROUP BY 1, 2;
