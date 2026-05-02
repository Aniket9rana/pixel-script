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
    attribution     String,                     -- raw first/last-touch JSON

    -- Attribution — first touch
    ft_utm_source   Nullable(String),
    ft_utm_medium   Nullable(String),
    ft_utm_campaign Nullable(String),
    ft_utm_term     Nullable(String),
    ft_utm_content  Nullable(String),
    ft_fbclid       Nullable(String),
    ft_gclid        Nullable(String),
    ft_ttclid       Nullable(String),
    ft_msclkid      Nullable(String),
    ft_twclid       Nullable(String),
    ft_dclid        Nullable(String),
    ft_gbraid       Nullable(String),
    ft_wbraid       Nullable(String),
    ft_yclid        Nullable(String),

    -- Attribution — last touch
    lt_utm_source   Nullable(String),
    lt_utm_medium   Nullable(String),
    lt_utm_campaign Nullable(String),
    lt_utm_term     Nullable(String),
    lt_utm_content  Nullable(String),
    lt_fbclid       Nullable(String),
    lt_gclid        Nullable(String),
    lt_ttclid       Nullable(String),
    lt_msclkid      Nullable(String),
    lt_twclid       Nullable(String),
    lt_dclid        Nullable(String),
    lt_gbraid       Nullable(String),
    lt_wbraid       Nullable(String),
    lt_yclid        Nullable(String),

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
    sdk_version     Nullable(String),

    -- Timestamps
    received_at     DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(received_at)
ORDER BY (received_at, event_name, anon_id)
TTL received_at + INTERVAL 13 MONTH DELETE
SETTINGS index_granularity = 8192;
