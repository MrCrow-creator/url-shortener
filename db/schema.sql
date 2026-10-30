CREATE TABLE IF NOT EXISTS short_urls (
    code VARCHAR(32) COLLATE "C" PRIMARY KEY,
    original_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_short_code CHECK (code ~ '^[A-Za-z0-9_-]{3,32}$'),
    CONSTRAINT valid_url_length CHECK (char_length(original_url) BETWEEN 1 AND 2048)
);
