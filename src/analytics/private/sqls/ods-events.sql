CREATE TABLE IF NOT EXISTS {{schema}}.{{table_ods_events}}(
    app_info SUPER, 
    device SUPER, 
    ecommerce SUPER,
    event_bundle_sequence_id BIGINT,
    event_date DATE, 
    event_dimensions SUPER,
    event_id VARCHAR(255)  DEFAULT RANDOM(),
    event_name VARCHAR(255),
    event_params SUPER,
    event_previous_timestamp BIGINT,
    event_server_timestamp_offset BIGINT,
    event_timestamp BIGINT,
    event_value_in_usd VARCHAR(255),
    geo SUPER, 
    ingest_timestamp BIGINT,
    items SUPER,
    platform VARCHAR(255),
    privacy_info SUPER,
    project_id VARCHAR(255),
    traffic_source SUPER,
    user_first_touch_timestamp BIGINT,
    user_id VARCHAR(255),
    user_ltv SUPER,
    user_properties SUPER,
    user_pseudo_id VARCHAR(255)
) DISTSTYLE AUTO 
SORTKEY AUTO