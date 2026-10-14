-- Migration V005: Settings and Cron Runs
CREATE TABLE olp_settings (
  setting_key VARCHAR2(64) NOT NULL,
  telegram_bot_token_encrypted VARCHAR2(1024),
  telegram_chat_id VARCHAR2(64),
  telegram_enabled NUMBER(1, 0) DEFAULT 0 NOT NULL,
  telegram_commands_enabled NUMBER(1, 0) DEFAULT 0 NOT NULL,
  bind_host VARCHAR2(255),
  bind_port NUMBER(5, 0),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_settings PRIMARY KEY (setting_key)
);

CREATE TABLE olp_cron_runs (
  run_id VARCHAR2(36) NOT NULL,
  job_id VARCHAR2(64) NOT NULL,
  name VARCHAR2(128) NOT NULL,
  command VARCHAR2(2048) NOT NULL,
  started_at_epoch NUMBER(19, 0) NOT NULL,
  finished_at_epoch NUMBER(19, 0) NOT NULL,
  exit_code NUMBER(6, 0),
  timed_out NUMBER(1, 0) DEFAULT 0 NOT NULL,
  latency_ms NUMBER(10, 0) NOT NULL,
  output CLOB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_cron_runs PRIMARY KEY (run_id)
);

CREATE INDEX idx_olp_cron_runs_job ON olp_cron_runs(job_id, started_at_epoch DESC);
