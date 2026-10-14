-- Migration V006: External Database Connection Registry
CREATE TABLE olp_db_connections (
  connection_id VARCHAR2(36) NOT NULL,
  name VARCHAR2(128) NOT NULL,
  engine VARCHAR2(16) NOT NULL,
  host VARCHAR2(255) NOT NULL,
  port NUMBER(5, 0) NOT NULL,
  db_user VARCHAR2(128) NOT NULL,
  password_encrypted VARCHAR2(1024) NOT NULL,
  database_name VARCHAR2(128) NOT NULL,
  is_default NUMBER(1, 0) DEFAULT 0 NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_db_connections PRIMARY KEY (connection_id),
  CONSTRAINT chk_olp_db_engine CHECK (engine IN ('mysql', 'postgres', 'oracle')),
  CONSTRAINT chk_olp_db_port CHECK (port > 0 AND port <= 65535)
);

CREATE INDEX idx_olp_db_engine ON olp_db_connections(engine);
