-- Migration V003: Operator Authentication & Passkeys
CREATE TABLE olp_operator (
  operator_id VARCHAR2(36) NOT NULL,
  username VARCHAR2(64) NOT NULL,
  password_salt VARCHAR2(128) NOT NULL,
  password_hash VARCHAR2(256) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_operator PRIMARY KEY (operator_id),
  CONSTRAINT uq_olp_operator_username UNIQUE (username)
);

CREATE TABLE olp_passkeys (
  credential_id VARCHAR2(256) NOT NULL,
  operator_id VARCHAR2(36) NOT NULL,
  public_key VARCHAR2(1024) NOT NULL,
  counter NUMBER(19, 0) DEFAULT 0 NOT NULL,
  name VARCHAR2(128) NOT NULL,
  created_at_epoch NUMBER(19, 0) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  last_used_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT pk_olp_passkeys PRIMARY KEY (credential_id),
  CONSTRAINT fk_olp_passkeys_operator FOREIGN KEY (operator_id)
    REFERENCES olp_operator(operator_id) ON DELETE CASCADE
);

CREATE INDEX idx_olp_passkeys_op ON olp_passkeys(operator_id);
