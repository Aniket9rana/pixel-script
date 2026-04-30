CREATE DATABASE IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.events
(
    -- Identity
    event_id        UUID,
    event_name      LowCardinality(String),
    site_id         LowCardinality(String),
    source          LowCardinality(String),     -- 'client' | 'server'

    -- User
    anon_id         UUID,
    session_id      Nullable(UUID),
    user_id         Nullable(String),

    -- Page
    page_url        String,
    page_path       LowCardinality(String),
    referrer        Nullable(String),

    -- Attribution — first touch
    ft_utm_source   Nullable(LowCardinality(String)),
    ft_utm_medium   Nullable(LowCardinality(String)),
    ft_utm_campaign Nullable(String),
    ft_fbclid       Nullable(String),
    ft_gclid        Nullable(String),
    ft_ttclid       Nullable(String),
    ft_msclkid      Nullable(String),

    -- Attribution — last touch
    lt_utm_source   Nullable(LowCardinality(String)),
    lt_utm_medium   Nullable(LowCardinality(String)),
    lt_utm_campaign Nullable(String),
    lt_fbclid       Nullable(String),
    lt_gclid        Nullable(String),
    lt_ttclid       Nullable(String),
    lt_msclkid      Nullable(String),

    -- Meta
    fbp             Nullable(String),
    fbc             Nullable(String),

    -- Network
    ip              Nullable(String),
    user_agent      Nullable(String),

    -- Meta CAPI result
    meta_success    Nullable(Bool),
    meta_status     Nullable(Int32),
    meta_error      Nullable(String),

    -- Payload
    properties      String,                     -- JSON blob
    sdk_version     Nullable(LowCardinality(String)),

    -- Timestamps
    received_at     DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(received_at)
ORDER BY (received_at, event_name, anon_id)
TTL received_at + INTERVAL 13 MONTH DELETE
SETTINGS index_granularity = 8192;
