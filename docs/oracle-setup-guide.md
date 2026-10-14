# Panduan Setup Lokal dan Validasi Oracle Database Free 23ai

Panduan ini berisi langkah-langkah menyiapkan dan memvalidasi lingkungan container Oracle Database Free 23ai secara bertahap dan non-destruktif untuk pengujian OLP.

> **PENTING: PADA FASE 1, TIDAK ADA PERUBAHAN DATA ATAU CUTOVER APLIKASI.**
> Aplikasi OLP tetap berjalan menggunakan file penyimpanan JSON (`OLP_STORAGE_MODE=json`). Langkah-langkah di bawah ini hanya untuk menguji dan memvalidasi kesiapan container database Oracle di lingkungan lokal/VM Anda.

---

## 1. Prasyarat Sistem

1. **Sistem Operasi:** Linux (Ubuntu 22.04+, Debian 12+, Arch, Fedora) atau Windows dengan Docker Desktop / WSL2.
2. **Docker Engine:** Versi `>= 24.0` (Docker Compose v2+).
3. **Node.js:** Versi `>= 22.12` (sesuai engine OLP di `package.json`).
4. **Memori (RAM):** Minimal 2 GB RAM kosong yang dialokasikan untuk container Oracle (disarankan 4 GB untuk performa optimal).
5. **Ruang Disk:** Minimal 10 GB ruang kosong untuk image Oracle dan volume data persisten.

---

## 2. Langkah Setup Bertahap

### Langkah 1: Siapkan Konfigurasi Lingkungan (`.env`)
Salin file template konfigurasi ke file `.env` di root proyek:
```bash
cp .env.oracle.example .env
```
Pada Linux, batasi izin akses file:
```bash
chmod 0600 .env
```
Buka file `.env` dengan editor teks dan sesuaikan parameter berikut:
- Ganti `ORACLE_SYS_PASSWORD` dengan password yang kuat (misal: kombinasi huruf besar, kecil, angka, minimal 12 karakter).
- Ganti `ORACLE_PASSWORD` dengan password untuk pengguna aplikasi OLP (`olp_app`).
- Pastikan `OLP_STORAGE_MODE=json` tetap disetel ke `json`.

---

### Langkah 2: Validasi Sintaks Docker Compose
Jalankan perintah validasi untuk memastikan template terbaca tanpa error:
```bash
docker compose -f docker-compose.oracle.yml config
```
Perintah ini akan menampilkan konfigurasi akhir yang telah menggabungkan variabel lingkungan dari file `.env`. Pastikan nilai `ports` menampilkan `127.0.0.1:1521:1521`.

---

### Langkah 3: Jalankan Container Oracle Database
Jalankan container di latar belakang (*detached mode*):
```bash
docker compose -f docker-compose.oracle.yml up -d
```
*Catatan:* Pada pemanggilan pertama kali, Docker akan mengunduh image `gvenzl/oracle-free:23-slim` (sekitar 1.5 - 2 GB).

---

### Langkah 4: Pantau Proses Inisialisasi Database
Inisialisasi database Oracle baru membutuhkan waktu sekitar 1–3 menit tergantung kecepatan disk. Pantau proses melalui log container:
```bash
docker compose -f docker-compose.oracle.yml logs -f oracle-db
```
Tunggu hingga muncul pesan status:
```text
DATABASE IS READY TO USE!
```
Tekan `Ctrl+C` untuk keluar dari pemantauan log.

Periksa status container menggunakan perintah:
```bash
docker compose -f docker-compose.oracle.yml ps
```
Pastikan kolom `STATUS` menunjukkan tanda **`(healthy)`**.

---

### Langkah 5: Uji Konektivitas Listener Port Localhost
Verifikasi bahwa port listener Oracle (1521) hanya terbuka dan dapat diakses dari localhost host:

**Di Linux:**
```bash
nc -zv 127.0.0.1 1521
```
Atau menggunakan `curl`:
```bash
curl -v telnet://127.0.0.1:1521
```

**Di Windows (PowerShell):**
```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 1521
```
Hasil yang diharapkan: Koneksi TCP berhasil tersambung (`TcpTestSucceeded : True`).

---

### Langkah 6: Verifikasi Non-Eksposur ke Jaringan Luar (Uji Keamanan)
Pastikan port 1521 **TIDAK** terbuka pada interface eksternal:
```bash
# Periksa binding port aktif pada host Linux
ss -tlnp | grep 1521
# Atau menggunakan netstat:
netstat -tlnp | grep 1521
```
Output harus menunjukkan alamat lokal `127.0.0.1:1521`, **BUKAN** `0.0.0.0:1521` atau `:::1521`.

---

## 3. Langkah Penghentian dan Pembersihan Aman

### Menghentikan Container Sementara (Data Tetap Utuh)
Jika Anda ingin menghentikan container tanpa menghapus data database:
```bash
docker compose -f docker-compose.oracle.yml stop
```
Untuk menjalankannya kembali nanti:
```bash
docker compose -f docker-compose.oracle.yml start
```

### Mematikan Container (Volume Data Tetap Tersimpan)
```bash
docker compose -f docker-compose.oracle.yml down
```
Perintah ini akan menghapus container tetapi mempertahankan volume data `olp_oracle_data`. Saat Anda menjalankan `up -d` kembali di masa mendatang, database tidak perlu diinisialisasi ulang dari nol.

> **PERINGATAN:** Jangan pernah menambahkan flag `-v` (`docker compose down -v`) jika Anda ingin mempertahankan data pengujian.

---

## 4. Panduan Mengatasi Kendala (Troubleshooting)

1. **Kendala: Port 1521 Sudah Digunakan (*Address already in use*)**
   - Periksa proses apa yang sedang menggunakan port 1521:
     `lsof -i :1521` atau `netstat -ano | findstr 1521`
   - Jika ada service Oracle lokal atau container lama yang berjalan, hentikan service tersebut sebelum menjalankan `docker-compose.oracle.yml`.

2. **Kendala: Container Keluar dengan Status Crash (*Exited 137 / Out of Memory*)**
   - Oracle Database Free membutuhkan alokasi memori minimal ~1.5 GB.
   - Jika menggunakan Docker Desktop di Windows/macOS, buka **Docker Settings > Resources** dan naikkan alokasi memori ke minimal 4 GB.
   - Di Linux VM, pastikan ada swap memory aktif jika RAM fisik di bawah 4 GB:
     `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`

3. **Kendala: Container Lambat Menjadi *Healthy***
   - Inisialisasi awal database pada hard drive konvensional (non-SSD) memerlukan waktu hingga 5 menit.
   - Berikan waktu ekstra dan pantau via `docker compose -f docker-compose.oracle.yml logs -f`.
