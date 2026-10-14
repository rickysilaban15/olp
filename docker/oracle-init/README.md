# Oracle Database Initialization Scripts

Direktori ini dipetakan ke `/container-entrypoint-initdb.d:ro` di dalam container Oracle Database Free 23ai (`gvenzl/oracle-free`).

## Cara Kerja
1. Setiap file berekstensi `.sql` atau `.sh` yang diletakkan di direktori ini akan dieksekusi **hanya satu kali** saat volume database pertama kali dibuat (`initial database creation`).
2. Jika volume `olp_oracle_data` sudah ada dan sudah terinisialisasi, skrip di direktori ini tidak akan dijalankan ulang secara otomatis.

## Default OLP
Aplikasi OLP menggunakan mekanisme migrasi internal berversi (`apps/server/src/db/migrator.ts`) yang dijalankan langsung oleh aplikasi OLP saat startup dengan melacak checksum pada tabel `olp_schema_migrations`.
Oleh karena itu, direktori ini sengaja dibiarkan kosong untuk inisialisasi default, atau hanya digunakan jika administrator ingin menambahkan tuning tablespace khusus sebelum skema OLP dibuat.
