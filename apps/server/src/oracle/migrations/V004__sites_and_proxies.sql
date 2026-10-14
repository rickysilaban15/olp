-- Migration V004: Sites and Reverse Proxies
CREATE TABLE olp_sites (
  site_id VARCHAR2(36) NOT NULL,
  name VARCHAR2(128) NOT NULL,
  site_type VARCHAR2(32) NOT NULL,
  root_path VARCHAR2(1024) NOT NULL,
  port NUMBER(5, 0) NOT NULL,
  created_at_epoch NUMBER(19, 0) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_sites PRIMARY KEY (site_id),
  CONSTRAINT chk_olp_sites_port CHECK (port > 0 AND port <= 65535)
);

CREATE INDEX idx_olp_sites_port ON olp_sites(port);

CREATE TABLE olp_proxies (
  proxy_id VARCHAR2(36) NOT NULL,
  name VARCHAR2(128) NOT NULL,
  listen_port NUMBER(5, 0) NOT NULL,
  domain VARCHAR2(255) NOT NULL,
  target_port NUMBER(5, 0) NOT NULL,
  created_at_epoch NUMBER(19, 0) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT pk_olp_proxies PRIMARY KEY (proxy_id),
  CONSTRAINT chk_olp_proxies_lport CHECK (listen_port > 0 AND listen_port <= 65535),
  CONSTRAINT chk_olp_proxies_tport CHECK (target_port > 0 AND target_port <= 65535)
);

CREATE INDEX idx_olp_proxies_domain ON olp_proxies(domain);
