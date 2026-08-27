# Deploy — Worker di Windows + Dashboard di Vercel

Susunan hybrid: PC gudang yang menarik data, Vercel yang menyajikan tampilannya
ke internet. Perkiraan waktu pemasangan 30–45 menit.

---

## Bagaimana bentuknya

```
  PC / Server Windows                TiDB Cloud              Vercel
  ───────────────────                ──────────              ──────
  Windows Scheduled Task
  ├─ timer internal        ──tulis──▶  database  ◀──baca──   dashboard
  └─ tarik data dari OCS                                     mode slide
```

Windows adalah **penulis**, Vercel adalah **pembaca**. Keduanya tidak pernah
berhubungan langsung — mereka bertemu di TiDB. Karena itu:

- Tidak perlu membuka port apa pun di jaringan kantor.
- Tidak perlu IP publik, VPN, atau tunnel. PC cukup punya koneksi internet keluar.
- **Vercel Cron tidak dipakai sama sekali**, sehingga batasan "sekali sehari" pada
  plan Hobby tidak relevan. Plan gratis sudah cukup.
- Interval penarikan tetap diatur dari halaman Pengaturan, dibaca ulang tiap putaran
  oleh worker — mengubahnya tidak perlu me-restart apa pun.

---

## 1. Siapkan database TiDB Cloud

1. Daftar di <https://tidbcloud.com>, buat **Serverless Cluster** (ada tier gratis).
2. Pilih region **`ap-southeast-1` (Singapore)**. OCS berada di Jakarta dan function
   Vercel sudah disetel ke region `sin1`, jadi ketiganya berdekatan. Memilih region
   Amerika menambah ratusan milidetik pada setiap query.
3. Klik **Connect** → format **General** → salin connection string-nya. Bentuknya:
   ```
   mysql://xxxxxxxx.root:PASSWORD@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/test
   ```
4. **Ganti nama database di ujung URL menjadi `ocs_replenish`.** TiDB Cloud biasanya
   memberi string yang menunjuk ke `test` atau `sys` — keduanya database bawaan sistem
   dan tidak boleh ditumpangi tabel aplikasi. Buat database sendiri:
   ```sql
   CREATE DATABASE ocs_replenish DEFAULT CHARACTER SET utf8mb4;
   ```
   Parameter tambahan seperti `?sslaccept=strict` boleh dibiarkan atau dihapus —
   TLS sudah selalu diwajibkan dari sisi aplikasi.

## 2. Siapkan proyek di PC Windows

Taruh proyek di lokasi tetap, misalnya `C:\ocs-replenish-monitor` — jangan di Desktop
atau folder Downloads yang mudah terhapus.

```powershell
npm install
copy .env.example .env
```

Buka `.env`, isi `TIDB_URL` dengan string tadi. Isi juga `CRON_SECRET` dengan nilai acak:

```powershell
node -e "console.log(crypto.randomUUID())"
```

## 3. Buat tabel dan pindahkan data lama

```powershell
npm run migrate          # membuat seluruh tabel di TiDB
npm run check-db         # uji koneksi, TLS, tulis, baca, hapus
npm run import-sqlite    # pindahkan data dari SQLite versi sebelumnya
```

`import-sqlite` memindahkan pengaturan, ambang khusus, riwayat, **dan** `first_seen_at`
tiap item. Bagian terakhir penting: tanpanya seluruh katalog akan tampak sebagai
"material baru" setelah sinkronisasi pertama.

Uji satu tarikan penuh:

```powershell
npm run sync-once
```

Kalau ini berhasil, jalur OCS → TiDB sudah terbukti utuh.

## 4. Pasang worker sebagai tugas otomatis Windows

Buka PowerShell **sebagai Administrator**, lalu:

```powershell
cd C:\ocs-replenish-monitor
powershell -ExecutionPolicy Bypass -File windows\install-worker.ps1
```

Skrip ini mendaftarkan tugas bernama **OCS Replenish Worker** yang:

- berjalan otomatis saat komputer menyala, **tanpa perlu ada yang login**
  (dijalankan sebagai akun `SYSTEM`);
- dijalankan ulang otomatis satu menit kemudian bila prosesnya mati;
- tidak punya batas waktu eksekusi, karena memang harus hidup terus;
- menulis seluruh keluaran ke `logs\worker.log`.

Memantau jalannya:

```powershell
Get-ScheduledTask -TaskName 'OCS Replenish Worker'
Get-Content .\logs\worker.log -Tail 30 -Wait
```

Menghentikan atau mencopot:

```powershell
Stop-ScheduledTask -TaskName 'OCS Replenish Worker'
powershell -ExecutionPolicy Bypass -File windows\uninstall-worker.ps1
```

Worker memakai Task Scheduler bawaan Windows sehingga tidak ada yang perlu diunduh.
Bila Anda ingin kontrol lebih rapi — misalnya start/stop lewat `services.msc` dan
rotasi log otomatis — [NSSM](https://nssm.cc/) bisa dipakai sebagai gantinya, dengan
`node.exe` sebagai aplikasi dan `src\worker.js` sebagai argumen.

## 5. Deploy dashboard ke Vercel

```powershell
vercel login
vercel link
```

Masukkan environment variable (ulangi untuk `preview` bila perlu):

```powershell
vercel env add TIDB_URL production
vercel env add OCS_USERNAME production
vercel env add OCS_PASSWORD production
vercel env add OCS_COMPANY_DB production
vercel env add CRON_SECRET production
```

`OCS_BASE_URL` boleh dilewati karena nilai bawaannya sudah benar.

```powershell
vercel --prod
```

## 6. Periksa hasilnya

```powershell
curl https://NAMA-PROYEK.vercel.app/api/status
```

Perhatikan bagian `staleness` pada jawabannya — bila `stale: false`, artinya worker di
Windows benar-benar mengisi database dan Vercel membacanya.

Buka `https://NAMA-PROYEK.vercel.app` untuk dashboard, dan `.../#slide` untuk layar gudang.

---

## Hal-hal yang perlu dijaga

### PC gudang harus benar-benar menyala

Ini titik lemah utama susunan hybrid. Kalau PC mati, dashboard di Vercel **tetap tampil
normal** dengan angka yang membeku — dan itu berbahaya karena orang mengira datanya
mutakhir.

Aplikasi ini karena itu memantau dirinya sendiri: bila sinkronisasi berhasil terakhir
sudah lewat **tiga kali interval**, dashboard menampilkan peringatan merah di atas
kartu KPI, dan mode slide menampilkan tulisan **DATA TIDAK MUTAKHIR** di kepala layar.
Jangan abaikan peringatan itu.

Pastikan juga PC tidak tidur sendiri:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

### SKU yang hanya berbeda huruf besar/kecil

OCS memuat SKU seperti `BDL-NCO-00000000052_OLD_` dan `BDL-NCO-00000000052_old_` — dua
barang berbeda yang hanya dibedakan besar-kecil huruf. Kolom kunci karena itu dibuat
bercollation `utf8mb4_bin`; dengan collation bawaan MySQL yang mengabaikan besar-kecil
huruf, keduanya dianggap satu kunci primer dan salah satunya lenyap tanpa pesan galat.

Setiap sinkronisasi kini memverifikasi jumlah baris tersimpan terhadap jumlah yang
dikirim OCS, dan `npm run check-db` memeriksa collation-nya. Bila suatu saat tabel
dibuat ulang secara manual, jangan lupa collation ini.

### Dua penulis, satu database

Worker di Windows menarik data terjadwal, sementara tombol **Sinkron** di web memicu
penarikan lewat function Vercel. Keduanya menulis ke database yang sama.

Kalau dibiarkan, dua sinkronisasi yang bertumpang tindih bisa saling menghapus: masing-masing
menulis seluruh baris dengan cap waktunya sendiri, lalu membuang baris bercap waktu lain —
dan tabel bisa terkosongkan. Karena itu ada tabel `sync_lock`: proses yang hendak menarik
data harus memegang kunci lebih dulu, dan yang kalah cepat akan dilewati dengan pesan
"sedang dikerjakan proses lain". Kunci kedaluwarsa sendiri setelah 5 menit supaya proses
yang mati mendadak tidak memblokir sistem.

Anda tidak perlu melakukan apa pun untuk ini — cukup tahu bahwa perilakunya memang begitu.

### Koneksi database

TiDB Serverless membatasi jumlah koneksi. `DB_POOL_SIZE` sengaja kecil (5) karena tiap
instance function Vercel punya pool sendiri dan Vercel bisa menjalankan banyak instance
sekaligus. Worker Windows hanya butuh satu.

### Keamanan

Setelah tayang di internet, siapa pun yang tahu URL-nya bisa membuka dashboard dan
mengubah pengaturan — aplikasi ini belum punya login sendiri. Cara termurah menutupnya
adalah menyalakan **Vercel Deployment Protection**, yang mengunci akses ke anggota tim
Vercel Anda tanpa perlu menulis kode.

Terpisah dari itu, kredensial `ADMIN` yang dipakai ke OCS punya klaim akses penuh padahal
aplikasi ini hanya perlu membaca stok. Sebaiknya minta tim OCS membuatkan user khusus
integrasi dengan hak baca saja.

### Backup

Hampir semua isi database bisa dibangun ulang dari OCS. Dua yang tidak ada di tempat lain:
**`item_threshold`** (ambang khusus per item) dan **`app_setting`** (pengaturan). Dua tabel
itu yang benar-benar perlu dijaga.
