-- Migration V002: Baseline sanity probe table
-- Digunakan untuk memverifikasi fungsionalitas DDL Oracle tanpa memengaruhi data aplikasi OLP
CREATE TABLE olp_sanity_probe (
  probe_id VARCHAR2(36) NOT NULL,
  probed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  probe_note VARCHAR2(256),
  CONSTRAINT pk_olp_sanity_probe PRIMARY KEY (probe_id)
);
