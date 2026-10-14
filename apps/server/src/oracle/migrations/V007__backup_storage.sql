-- Migration V007: Backup Schedules, Metadata, Snapshot Bundles, and Restore Logs
CREATE TABLE olp_backup_schedules (
  schedule_id VARCHAR2(36) NOT NULL,
  name VARCHAR2(128) NOT NULL,
  backup_type VARCHAR2(16) NOT NULL,
  source_target VARCHAR2(1024) NOT NULL,
  cron_expression VARCHAR2(128) NOT NULL,
  enabled NUMBER(1, 0) DEFAULT 1 NOT NULL,
  created_at_epoch NUMBER(19, 0) NOT NULL,
  last_run_epoch NUMBER(19, 0),
  last_status VARCHAR2(32),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_backup_schedules PRIMARY KEY (schedule_id)
);

CREATE TABLE olp_backup_metadata (
  backup_name VARCHAR2(128) NOT NULL,
  filename VARCHAR2(255) NOT NULL,
  backup_type VARCHAR2(16) NOT NULL,
  source_target VARCHAR2(1024) NOT NULL,
  sha256_checksum VARCHAR2(64),
  file_size_bytes NUMBER(19, 0) NOT NULL,
  created_at_epoch NUMBER(19, 0) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_backup_metadata PRIMARY KEY (backup_name)
);

CREATE TABLE olp_backup_bundles (
  bundle_id VARCHAR2(64) NOT NULL,
  has_auth NUMBER(1, 0) DEFAULT 0 NOT NULL,
  created_at_epoch NUMBER(19, 0) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_backup_bundles PRIMARY KEY (bundle_id)
);

CREATE TABLE olp_backup_bundle_parts (
  part_id VARCHAR2(36) NOT NULL,
  bundle_id VARCHAR2(64) NOT NULL,
  part_name VARCHAR2(128) NOT NULL,
  part_kind VARCHAR2(16) NOT NULL,
  filename VARCHAR2(255) NOT NULL,
  sha256_checksum VARCHAR2(64) NOT NULL,
  CONSTRAINT pk_olp_bundle_parts PRIMARY KEY (part_id),
  CONSTRAINT fk_olp_bundle_parts FOREIGN KEY (bundle_id)
    REFERENCES olp_backup_bundles(bundle_id) ON DELETE CASCADE
);

CREATE INDEX idx_olp_bundle_parts_bid ON olp_backup_bundle_parts(bundle_id);

CREATE TABLE olp_backup_restore_logs (
  restore_id VARCHAR2(36) NOT NULL,
  bundle_id VARCHAR2(64),
  status VARCHAR2(16) NOT NULL,
  started_at_epoch NUMBER(19, 0) NOT NULL,
  finished_at_epoch NUMBER(19, 0),
  steps_json CLOB,
  error_message VARCHAR2(2000),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_restore_logs PRIMARY KEY (restore_id)
);
