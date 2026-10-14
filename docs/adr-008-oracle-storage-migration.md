# ADR-008: Migrasi Penyimpanan Internal OLP ke Oracle Database Free 23ai

- Status: Proposed / Phase 1 Foundation
- Date: 2026-10-14
- Scope: Penyimpanan internal OLP (`apps/server`, `@olp/auth`), manajemen deployment, dan sekuriti kredensial.
- Context: OLP saat ini menyimpan seluruh data internal (akun, passkey, situs, reverse proxy, pengaturan telegram, riwayat cron, registry database, jadwal backup) dalam flat file JSON di direktori `~/.olp/*.json`.

---

## 1. Konteks dan Latar Belakang

OpenLocalPanel (OLP) dirancang sebagai panel operasi server lokal yang mengelola berbagai komponen host Linux:
- Konfigurasi dan reload Nginx di `/etc/nginx/nginx.conf`
- Layanan unit systemd melalui `systemctl`
- Tugas terjadwal melalui file crontab host
- Manajemen proses website lokal (spawn Node.js, Python, PHP, binary)
- Sesi pseudo-terminal interaktif (PTY)
- Penjelajahan dan manipulasi filesystem lokal

Saat ini, penyimpanan internal OLP menggunakan file JSON datar:
- `~/.olp/config.json` (@olp/auth): Kredensial operator, hash password Argon2id, passkey WebAuthn.
- `~/.olp/sites.json` (@olp/server): Daftar situs yang di-spawn.
- `~/.olp/nginx.json` (@olp/server): Pemetaan reverse proxy Nginx.
- `~/.olp/settings.json` (@olp/server): Konfigurasi bot Telegram & bind network.
- `~/.olp/cron-runs.json` (@olp/server): Riwayat eksekusi cron (capped 500 baris).
- `~/.olp/db.json` (@olp/server): Registry koneksi database eksternal (MySQL, PostgreSQL).
- `~/.olp/backup-schedules.json` (@olp/server): Jadwal pencadangan otomatis.

Untuk meningkatkan integritas data transaksional, konkurensi ACID, keandalan jangka panjang, dan dukungan multi-koneksi database eksternal, OLP memutuskan untuk mengadopsi **Oracle Database Free 23ai** sebagai basis data internal utama.

---

## 2. Batas Arsitektur dan Tanggung Jawab (Host Linux vs Container Oracle)

### Pilihan Arsitektur: Model Hibrida (OLP Host Native + Oracle Docker)

```
+---------------------------------------------------------------------------------+
| HOST LINUX VM / MINI PC                                                         |
|                                                                                 |
|  +---------------------------------------------------------------------------+  |
|  | OpenLocalPanel (OLP) - Native Node.js Service (systemd)                   |  |
|  | - Mengelola Nginx (/etc/nginx/nginx.conf)                                 |  |
|  | - Mengontrol systemd (systemctl restart/status)                           |  |
|  | - Menjalankan crontab host                                                |  |
|  | - Menjalankan proses website & PTY terminal                               |  |
|  | - Mengakses filesystem lokal tanpa sandbox                                |  |
|  |                                                                           |  |
|  | Penyimpanan Sementara (Fase 1): Flat JSON di ~/.olp/                      |  |
|  | Target Penyimpanan (Fase Lanjutan): node-oracledb Thin Mode                |  |
|  +-------------------------------------+-------------------------------------+  |
|                                        |                                        |
|                          TCP 127.0.0.1:1521 (Localhost Only)                    |
|                                        |                                        |
|  +-------------------------------------v-------------------------------------+  |
|  | DOCKER CONTAINER: 'olp-oracle-db' (gvenzl/oracle-free:23-slim)            |  |
|  | - Terisolasi dari jaringan publik (tidak ada bind ke 0.0.0.0)             |  |
|  | - Menjalankan Oracle Database Free 23ai (PDB: FREEPDB1)                   |  |
|  | - Pengguna aplikasi: 'olp_app' (Least Privilege)                          |  |
|  | - Volume Persisten: olp_oracle_data -> /opt/oracle/oradata                |  |
|  +---------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------+
```

### Mengapa OLP TIDAK dijalankan di dalam Docker?
Jika OLP dikemas ke dalam Docker container:
1. Akses ke systemd host membutuhkan bind mount `/run/systemd/system` dan izin privileged yang merusak isolasi keamanan.
2. Akses ke konfigurasi Nginx dan reload Nginx host membutuhkan kontrol proses host (`nsenter` atau SSH internal).
3. PTY terminal akan membuka shell container, bukan shell server host yang ingin dikelola pengguna.
4. Spawn proses situs pengguna akan terbatas di dalam container dan membebani container lifecycle.

**Keputusan:** OLP tetap berjalan NATIVE pada host Linux. Oracle Database Free dijalankan di dalam container DOCKER dengan bind localhost `127.0.0.1:1521` dan persistent volume Docker.

---

## 3. Keputusan Driver Database: node-oracledb Thin Mode

1. **Driver:** `node-oracledb` versi `>=6.7.0`.
2. **Mode:** **Thin Mode** (default pada `node-oracledb` 6.x).
3. **Keunggulan Thin Mode:**
   - 100% JavaScript / TypeScript murni.
   - Tidak memerlukan Oracle Instant Client C-libraries (`libclntsh.so`, `oci.dll`).
   - Tidak memerlukan kompilasi native C++ addons saat instalasi (`npm install`).
   - Kompatibel penuh dengan Node.js `>=22.12` dan Node.js 24 LTS.
   - Mengurangi kompleksitas deployment di Linux VM secara drastis.

---

## 4. State Machine Mode Penyimpanan (Zero Silent Fallback)

Untuk mencegah kehilangan data (`split-brain` atau silent data loss):
1. **Mode `json` (Saat Ini / Fase 1 & 2):**
   - Aplikasi membaca dan menulis data ke `~/.olp/*.json`.
   - Koneksi Oracle belum aktif pada runtime aplikasi.
2. **Mode `migrating`:**
   - Server memasuki mode perawatan (read-only pada level API).
   - Data JSON divalidasi, ditransformasi, dan disalin ke tabel Oracle.
   - File JSON asli diarsipkan ke `~/.olp/archive_pre_oracle/` secara non-destruktif.
3. **Mode `oracle` (Setelah Cutover Tervalidasi):**
   - Oracle menjadi satu-satunya sumber kebenaran data (*single source of truth*).
   - File JSON lama tidak lagi dibaca maupun ditulis.
4. **Perilaku Ketika Oracle Tidak Tersedia (Post-Cutover):**
   - **DILARANG KERAS** berpindah secara diam-diam (*silent fallback*) ke file JSON lama. File JSON lama sudah *stale* dan akan menyebabkan hilangnya perubahan data yang dibuat di Oracle.
   - OLP akan masuk ke mode terdegradasi (*degraded mode*): API storage mengembalikan HTTP 503 (*Database Unavailable*).
   - Layanan host yang sudah berjalan (Nginx, systemd services, cron) tetap berjalan normal tanpa terpengaruh.
   - Operator dapat memulihkan koneksi Oracle atau secara eksplisit menjalankan perintah pemulihan bencana (*explicit disaster recovery*).

---

## 5. Ringkasan Skema Oracle yang Direncanakan (Fase 2)

- `olp_schema_migrations`: Pelacakan migrasi DDL berversi dengan checksum SHA-256.
- `olp_config`: Autentikasi operator (hash Argon2id, salt, lockout counter).
- `olp_passkeys`: Kredensial WebAuthn (public key, counter, transports).
- `olp_sites`: Registry situs web yang dikelola OLP.
- `olp_proxies`: Pemetaan reverse proxy Nginx host.
- `olp_settings`: Pengaturan bot Telegram, bind host, dan opsi panel.
- `olp_cron_runs`: Log eksekusi cron dengan constraint riwayat.
- `olp_db_connections`: Registry multi-koneksi database (MySQL/Postgres) dengan password terenkripsi AES-256-GCM.
- `olp_backup_schedules`: Jadwal pencadangan otomatis.

---

## 6. Konsekuensi dan Langkah Lanjutan

- **Fase 1 (Selesai):** Fondasi keamanan, `.gitignore`, template konfigurasi `.env.oracle.example`, template `docker-compose.oracle.yml`, dokumen ADR, spesifikasi enkripsi rahasia, dan panduan setup lokal tanpa mengubah perilaku runtime OLP.
- **Fase 2 (Rencana):** Implementasi engine migrator DDL berversi, skrip SQL V001..V006, connection pool Oracle dengan retry backoff, dan pengujian unit terisolasi.
- **Fase 3 (Rencana):** Refactoring interface storage menjadi asinkron (`Promise`) dengan in-memory adapter fakes untuk pengujian unit.
- **Fase 4 (Rencana):** Idempotent JSON-to-Oracle importer dan validasi checksum.
- **Fase 5 (Rencana):** Adaptasi fitur backup/restore OLP untuk menyertakan dump tabel Oracle.
