# Cetak Biru Skema Oracle Database Free 23ai (OLP Storage)

Dokumen ini mendefinisikan rancangan terperinci seluruh tabel internal OpenLocalPanel (OLP) sebelum skrip DDL final dieksekusi di fase berikutnya.

---

## 1. Prinsip Desain Skema

1. **Identitas Pengguna yang Stabil:**
   - OLP menggunakan `operator_id` (UUIDv4 atau surrogate key stabil) sebagai Primary Key pada entitas operator, bukan `username`.
   - Jika admin mengubah `username` di kemudian hari, relasi dengan passkey WebAuthn dan log audit tidak akan rusak.
2. **Integritas Relasional & Cascade:**
   - Tabel turunan seperti `olp_passkeys` menggunakan Foreign Key ke `olp_operator(operator_id)` dengan aturan `ON DELETE CASCADE`.
3. **Perlindungan Data Sensitif:**
   - Seluruh password koneksi database eksternal dan token bot Telegram disimpan dalam bentuk ciphertext berformat `v1:<iv>:<tag>:<ciphertext>` menggunakan algoritma AES-256-GCM.
4. **Pemetaan Seluruh Lokasi Persistensi:**
   - Seluruh data yang sebelumnya tersebar di file `~/.olp/*.json` dan sidecar backup dipetakan tanpa ada artefak yang hilang.

---

## 2. Definisi Struktur Tabel Lengkap

### A. Autentikasi dan Passkey

#### 1. Tabel `olp_operator`
Menyimpan kredensial operator admin OLP (sebelumnya `config.json`).
```sql
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
```

#### 2. Tabel `olp_passkeys`
Menyimpan kredensial publik WebAuthn / Passkey yang terikat pada operator.
```sql
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
```

---

### B. Situs Web dan Reverse Proxy

#### 3. Tabel `olp_sites`
Menyimpan registry aplikasi website lokal yang di-spawn oleh OLP (sebelumnya `sites.json`).
```sql
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
```

#### 4. Tabel `olp_proxies`
Menyimpan konfigurasi reverse proxy Nginx host (sebelumnya `nginx.json`).
```sql
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
```

---

### C. Pengaturan Panel dan Riwayat Cron

#### 5. Tabel `olp_settings`
Menyimpan preferensi panel, notifikasi Telegram, dan bind host (sebelumnya `settings.json`).
```sql
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
```

#### 6. Tabel `olp_cron_runs`
Menyimpan riwayat eksekusi cron job dengan batasan riwayat (sebelumnya `cron-runs.json`).
```sql
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
```

---

### D. Multi-Koneksi Database Eksternal

#### 7. Tabel `olp_db_connections`
Mendukung multi-koneksi database (MySQL, PostgreSQL, Oracle eksternal) dengan password terenkripsi AES-256-GCM.
```sql
CREATE TABLE olp_db_connections (
    connection_id VARCHAR2(36) NOT NULL,
    name VARCHAR2(128) NOT NULL,
    engine VARCHAR2(16) NOT NULL, -- 'mysql', 'postgres', 'oracle'
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
```

---

### E. Backup Schedules, Metadata, dan Snapshot Bundles

#### 8. Tabel `olp_backup_schedules`
Menyimpan jadwal pencadangan otomatis (sebelumnya `backup-schedules.json`).
```sql
CREATE TABLE olp_backup_schedules (
    schedule_id VARCHAR2(36) NOT NULL,
    name VARCHAR2(128) NOT NULL,
    backup_type VARCHAR2(16) NOT NULL, -- 'folder', 'mysql', 'postgres'
    source_target VARCHAR2(1024) NOT NULL,
    cron_expression VARCHAR2(128) NOT NULL,
    enabled NUMBER(1, 0) DEFAULT 1 NOT NULL,
    created_at_epoch NUMBER(19, 0) NOT NULL,
    last_run_epoch NUMBER(19, 0),
    last_status VARCHAR2(32),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_olp_backup_schedules PRIMARY KEY (schedule_id)
);
```

#### 9. Tabel `olp_backup_metadata`
Menyimpan metadata arsip cadangan (sebelumnya `<name>.json` sidecar di direktori backup).
```sql
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
```

#### 10. Tabel `olp_backup_bundles` & `olp_backup_bundle_parts`
Menyimpan snapshot full bundle manifest (sebelumnya `<id>.bundle.json`).
```sql
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
    part_kind VARCHAR2(16) NOT NULL, -- 'mysql', 'postgres', 'configs', 'crons'
    filename VARCHAR2(255) NOT NULL,
    sha256_checksum VARCHAR2(64) NOT NULL,
    CONSTRAINT pk_olp_bundle_parts PRIMARY KEY (part_id),
    CONSTRAINT fk_olp_bundle_parts FOREIGN KEY (bundle_id)
        REFERENCES olp_backup_bundles(bundle_id) ON DELETE CASCADE
);
CREATE INDEX idx_olp_bundle_parts_bid ON olp_backup_bundle_parts(bundle_id);
```

---

## 3. Strategi Ekspor dan Pemulihan (Backup/Restore Compatibility)

- **Format Ekspor Kompatibel:**
  Saat fitur *Create Bundle Snapshot* dijalankan dari UI OLP, OLP mengekstrak baris-baris dari tabel Oracle dan mengemasnya ke dalam file format JSON bundle terenkripsi yang kompatibel dengan format lama.
- **Pemisahan Kunci Master:**
  `master.key` tidak pernah disertakan di dalam bundle. Operator harus mempertahankan `master.key` secara terpisah.
- **Prosedur Restore:**
  Saat memulihkan snapshot ke server baru, migrator Oracle memastikan seluruh tabel sudah ada, lalu importer menulis data ke tabel Oracle dalam transaksi terkontrol.
