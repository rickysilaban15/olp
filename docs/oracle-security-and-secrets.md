# Spesifikasi Keamanan dan Pengelolaan Secret Oracle OLP

Dokumen ini mendefinisikan arsitektur keamanan, manajemen kredensial, dan enkripsi data sensitif untuk migrasi penyimpanan OpenLocalPanel (OLP) ke Oracle Database Free 23ai.

---

## 1. Prinsip Dasar Keamanan

1. **Prinsip Hak Akses Minimum (*Least Privilege*):**
   - Aplikasi OLP **DILARANG KERAS** menggunakan kredensial administratif Oracle (`SYS`, `SYSTEM`, atau `PDBADMIN`) pada operasi runtime.
   - OLP menggunakan akun database khusus aplikasi (`olp_app`).
   - Akun `olp_app` hanya memiliki hak `CREATE SESSION`, `CREATE TABLE`, `CREATE VIEW`, `CREATE SEQUENCE`, serta kuota penyimpanan pada tablespace aplikasinya.
2. **Isolasi Jaringan (*Network Isolation*):**
   - Port 1521 container Oracle hanya di-bind ke loopback interface host (`127.0.0.1:1521`).
   - Port 1521 tidak boleh dibuka pada firewall host (`ufw`, `iptables`, `firewalld`) ke jaringan LAN atau publik.
3. **Penyimpanan Kredensial Nol-Teks-Biasa (*Zero Plaintext Secrets*):**
   - Password koneksi database eksternal (MySQL/PostgreSQL) dan token bot Telegram disimpan dalam bentuk terenkripsi menggunakan algoritma autentikasi modern.

---

## 2. Arsitektur Enkripsi Rahasia (AES-256-GCM)

Untuk melindungi secret yang harus dapat didekripsi kembali oleh aplikasi (reversible secrets), OLP mengadopsi standar industri **AES-256-GCM** (*Galois/Counter Mode*):

### Komponen Enkripsi
- **Algoritma:** `aes-256-gcm` (standar modul `node:crypto`).
- **Panjang Kunci Master:** 256 bit (32 bytes entropy murni).
- **Initialization Vector (IV):** 96 bit (12 bytes), dihasilkan secara acak kriptografis unik (`crypto.randomBytes(12)`) untuk SETIAP operasi enkripsi. DILARANG menggunakan ulang IV yang sama.
- **Authentication Tag:** 128 bit (16 bytes), memverifikasi keaslian dan integritas ciphertext untuk mencegah tampering atau modifikasi data tanpa izin (*authenticated encryption*).

### Format Payload Terenkripsi
Ciphertext disimpan dalam format string gabungan yang aman:
```text
v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
```
Contoh:
```text
v1:a3f912c4b8e21094dc15f3a0:7b419ec801d9fa45be3267ab09c43ef1:4d8e90a1b2c3d4e5f6071829
```
Keuntungan format berawalan `v1:`:
- Memudahkan migrasi algoritma di masa depan jika standar industri diperbarui.
- Mencegah kebingungan antara data terenkripsi dan data teks biasa lama (backward compatibility check).

---

## 3. Pembuatan dan Manajemen Kunci Master (`OLP_MASTER_KEY`)

### Pembuatan Kunci Baru
Kunci master dibuat di server host menggunakan generator acak kriptografis:
```bash
node -e "console.log(crypto.randomBytes(32).toString('hex'))"
```
Hasilnya adalah 64 karakter heksadesimal yang mewakili 32 bytes data acak.

### Lokasi Penyimpanan Kunci pada Host Linux
Kunci master disimpan di salah satu dari dua lokasi berikut:

1. **File Terisolasi (Paling Direkomendasikan):**
   - Lokasi: `/etc/olp/master.key`
   - Kepemilikan: Pengguna service OLP (misal: `olp:olp` atau `root:root` jika OLP dijalankan oleh systemd khusus).
   - Izin Akses File: **Wajib 0400** (hanya pemilik yang memiliki izin baca, tanpa izin tulis atau eksekusi).
   ```bash
   sudo mkdir -p /etc/olp
   sudo sh -c 'node -e "console.log(crypto.randomBytes(32).toString(\"hex\"))" > /etc/olp/master.key'
   sudo chown root:root /etc/olp/master.key
   sudo chmod 0400 /etc/olp/master.key
   ```
2. **Variabel Lingkungan Sistem:**
   - Didefinisikan dalam unit file systemd (`/etc/systemd/system/openlocalpanel.service`):
     ```ini
     [Service]
     EnvironmentFile=/etc/olp/environment
     ```
   - Berkas `/etc/olp/environment` memiliki izin `chmod 0600`.

### Hierarki Resolusi Kunci Master
Saat aplikasi OLP khởi động:
1. Cek `process.env['OLP_MASTER_KEY']`. Jika tersedia dan valid (64 hex characters), gunakan nilai ini.
2. Jika tidak ada, cek `process.env['OLP_MASTER_KEY_FILE']` (default: `/etc/olp/master.key` atau `~/.olp/master.key`). Jika file ada dan berisi 64 hex characters, muat kunci dari file.
3. Jika keduanya tidak ditemukan:
   - Pada mode pengembangan lokal (`NODE_ENV !== 'production'`), buat kunci darurat di memori dengan peringatan keras di konsol.
   - Pada mode produksi (`NODE_ENV === 'production'`), hentikan server secara *fail-fast* dengan kode error kritis, karena data rahasia tidak dapat dienkripsi/didekripsi secara aman tanpa kunci master yang persisten.

---

## 4. Prosedur Rotasi Kunci Master Tanpa Downtime

Jika kunci master dicurigai terkompromi atau ada kebijakan kepatuhan berkala, lakukan rotasi kunci dengan prosedur berikut:

1. Siapkan kunci baru (`NEW_MASTER_KEY`).
2. Jalankan skrip utilitas rotasi CLI OLP:
   ```bash
   node cli/dist/index.js secrets:rotate --old-key-file=/etc/olp/master.key --new-key-file=/etc/olp/master.key.new
   ```
3. Cara kerja skrip rotasi:
   - Buka transaksi database di Oracle.
   - Baca seluruh kolom terenkripsi pada tabel `olp_db_connections` dan `olp_settings`.
   - Dekripsi ciphertext menggunakan `OLD_MASTER_KEY`.
   - Enkripsi ulang plaintext menggunakan `NEW_MASTER_KEY` dengan IV baru untuk setiap baris.
   - Update baris di Oracle dan lakukan `COMMIT`.
4. Ganti file kunci:
   ```bash
   sudo mv /etc/olp/master.key.new /etc/olp/master.key
   sudo chmod 0400 /etc/olp/master.key
   ```
5. Reload service OLP (`systemctl reload-or-restart openlocalpanel`).

---

## 5. Dampak Kehilangan Kunci Master & Penanganannya

Jika file `/etc/olp/master.key` hilang atau rusak tanpa cadangan:
- **Data yang Terdampak:** Password koneksi database eksternal (`olp_db_connections`) dan token bot Telegram (`olp_settings`) tidak dapat didekripsi.
- **Data yang TIDAK Terdampak:** Kredensial operator login OLP (hash Argon2id) dan passkey WebAuthn tetap utuh dan tetap berfungsi normal, karena diverifikasi menggunakan skema verifikasi satu arah / public-key cryptography yang tidak bergantung pada `OLP_MASTER_KEY`.
- **Pemulihan:** Operator hanya perlu membuat kunci baru dan memasukkan kembali password koneksi database eksternal serta token Telegram melalui UI panel OLP.

---

## 6. Pemisahan Backup Kunci vs Backup Database

- **Aturan Mutlak:** `master.key` **TIDAK BOLEH** disertakan di dalam bundle backup database Oracle yang diekspor melalui panel web.
- Jika database dan kunci berada dalam bundle yang sama, siapapun yang mendapatkan file backup memiliki akses penuh untuk mendekripsi seluruh rahasia.
- Kunci master harus dicadangkan secara terpisah (*out-of-band backup*) melalui channel administratif yang aman (misalnya: password manager perusahaan atau brankas rahasia terisolasi).

---

## 7. Pencegahan Kebocoran Secret ke Git dan Log

1. **Aturan `.gitignore` yang Diperketat:**
   - Seluruh file `.env`, `.env.local`, `.env.*.local` diblokir dari Git.
   - Seluruh file kunci (`*.key`, `*.pem`, `*.crt`, `master.key`) diblokir dari Git.
   - Hanya template contoh (`.env.example`, `.env.*.example`) yang diizinkan untuk dilacak.
2. **Pembersihan Log (*Log Sanitization*):**
   - Fastify logger dan modul database dikonfigurasi untuk menyaring (*redact*) field sensitif: `password`, `token`, `secret`, `masterKey`, `authorization`.
   - Pesan error database yang dikirim ke client HTTP tidak boleh mengekspos connection string lengkap atau parameter autentikasi internal.
