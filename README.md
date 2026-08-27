# OCS Replenish Monitor

Aplikasi monitoring replenish gudang. Menarik data stok dari OCS IEG secara berkala,
menyimpannya secara lokal, lalu menampilkannya sebagai dashboard bertema SAP Fiori
lengkap dengan mode slide untuk layar di area gudang.

Basis perhitungan status adalah **Qty Rack** (`QtyGudangKecil` di OCS) — stok yang
benar-benar ada di rak picking gudang kecil.

---

## Menjalankan

Butuh Node.js 22.5+ dan sebuah database TiDB Cloud.

```bash
npm install
cp .env.example .env      # lalu isi TIDB_URL
npm run migrate           # buat tabel
npm run serve
```

Lalu buka <http://localhost:3000>.

Untuk menayangkannya di internet, lihat **[DEPLOY.md](DEPLOY.md)** — susunan hybrid
dengan worker di PC gudang dan dashboard di Vercel.

### Perintah lain

| Perintah | Kegunaan |
|---|---|
| `npm run serve` | Server web lokal, lengkap dengan penjadwal internal |
| `npm run worker` | Worker penarik data saja, tanpa web server (dipakai di PC gudang) |
| `npm run migrate` | Membuat seluruh tabel di TiDB (aman diulang) |
| `npm run check-db` | Uji koneksi, TLS, tulis, baca, hapus |
| `npm run sync-once` | Tarik satu snapshot lalu keluar |
| `npm run import-sqlite` | Pindahkan data dari database SQLite versi lama |

### Konfigurasi

Salin `.env.example` menjadi `.env` bila belum ada, lalu sesuaikan:

| Variabel | Arti | Default |
|---|---|---|
| `OCS_BASE_URL` | Alamat server OCS | `https://ocs.iegsystem.id` |
| `OCS_USERNAME` / `OCS_PASSWORD` | Kredensial login | `ADMIN` / `ADMIN` |
| `OCS_COMPANY_DB` | Company database | `EJI_WMS` |
| `PORT` / `HOST` | Alamat web lokal | `3000` / `0.0.0.0` |
| `TIDB_URL` | Connection string TiDB Cloud | — (wajib) |
| `CRON_SECRET` | Pelindung endpoint `/api/cron` | — (wajib di Vercel) |
| `DB_POOL_SIZE` | Jumlah koneksi dalam pool | `5` |
| `HISTORY_RETENTION_DAYS` | Lama riwayat disimpan | `30` |

Pengaturan operasional lain (interval, ambang, toggle tampilan, mode slide) **tidak** ada
di `.env` — semuanya diatur dari halaman **Pengaturan** di web dan tersimpan di database.

---

## Cara kerja

```
   ┌── penjadwal (interval dari UI) ────────────────────────────┐
   │                                                            │
   │  POST /Auth/Login          -> JWT (berlaku 24 jam, di-cache)│
   │  GET  /odata/DTO_WmsItemStockLiteV2  -> 2.460 baris, ~2 dtk │
   │  GET  /Stock/WmsItemSettings         -> pemetaan brand      │
   │                                                            │
   └──> TiDB ────> REST ─────────> Dashboard / Mode Slide ───────┘
```

Penarikan data dan penyajian tampilan bisa dipisah. `npm run worker` menjalankan
penariknya saja (dipasang sebagai tugas otomatis di PC gudang), sementara dashboard-nya
disajikan Vercel dari database yang sama. Karena penjadwalnya ada di Windows, tidak ada
batasan cron sama sekali dan interval tetap diatur dari halaman Pengaturan.

Bila dua proses berpotensi menulis bersamaan — worker terjadwal dan tombol Sinkron di web —
tabel `sync_lock` memastikan hanya satu yang berjalan pada satu waktu. Rinciannya ada di
[DEPLOY.md](DEPLOY.md).

Beberapa keputusan penting:

- **Bukan scraping HTML.** Halaman `/stocks/view-v2` adalah SPA Vue; datanya diambil
  langsung dari REST/OData backend-nya. Jauh lebih cepat dan tidak rusak saat UI berubah.
- **Snapshot penuh tiap tarikan.** Datanya hanya ~760 KB, jadi paging tidak diperlukan.
  Snapshot bersifat otoritatif: item yang hilang dari sumber ikut dihapus.
- **Database TiDB Cloud** (kompatibel MySQL 8). Penulisan memakai bulk upsert berbatch
  500 baris, bukan 2.460 perintah terpisah — penting karena tiap perintah adalah satu
  perjalanan jaringan.
- **Riwayat hanya dicatat saat nilainya berubah.** Kalau setiap tarikan menyimpan 2.460 baris,
  database akan tumbuh ~700 ribu baris per hari. Dengan cara ini ukurannya tetap wajar.
- **Token diperbarui otomatis** menjelang kedaluwarsa dan saat menerima 401.

---

## Status item

Dihitung dari Qty Rack terhadap ambang masing-masing item:

| Status | Syarat | Warna |
|---|---|---|
| **Minus** | Qty Rack &lt; 0 | Merah |
| **Habis** | Qty Rack = 0 | Merah |
| **Tipis** | 0 &lt; Qty Rack ≤ ambang | Oranye |
| **Aman** | Qty Rack &gt; ambang | Hijau |

**Ambang** tiap item = angka khusus di tab *Ambang per Item* bila ada, kalau tidak
memakai **ambang default global** (bawaan 50 pcs). Material baru otomatis memakai
default tersebut, sehingga langsung termonitor begitu muncul tanpa perlu disetel dulu.

Kolom **Saran** menunjukkan berapa yang perlu dipindahkan dari Gudang Besar agar rak
kembali ke ambang — dibatasi oleh stok Gudang Besar yang benar-benar tersedia. Item
bertanda *"Stok besar habis"* tidak bisa di-replenish dan perlu pengadaan, bukan transfer.

---

## Lingkup data

Secara bawaan dashboard hanya menampilkan `Category = Sku` yang berstatus aktif
di luar item Clearance Sale — 346 dari 2.460 baris. Toggle di halaman Pengaturan:

- **Tampilkan Bundle** — mati secara bawaan. Bundle adalah SKU virtual hasil kalkulasi,
  bukan barang di rak; menyalakannya menambah ~1.800 baris yang tidak bisa di-replenish.
- **Tampilkan Gimmick** — mati secara bawaan.
- **Tampilkan item non-aktif** — mati secara bawaan.
- **Tampilkan item Clearance Sale (CS-)** — mati secara bawaan. Kategori `Sku` dengan kode
  berawalan `CS-` adalah barang clearance yang sedang dihabiskan, bukan diisi ulang.
  Ada 46 item semacam ini dan 34 di antaranya berstatus rak kosong, sehingga bila ikut
  ditampilkan mereka mengisi separuh KPI *Rak Kosong* tanpa satu pun yang benar-benar
  bisa di-replenish. Filter ini hanya berlaku untuk kategori `Sku`; bundle atau gimmick
  berawalan `CS-` tidak terpengaruh.
- **Sembunyikan item aman** — menyala, agar layar hanya berisi pekerjaan.
- **Hanya yang siap transfer** — batasi ke item yang stok Gudang Besar-nya masih ada.

---

## Mode slide

Untuk TV/monitor di gudang. Daftar item yang perlu ditindak dipecah menjadi beberapa
slide yang berputar otomatis.

- Buka <http://localhost:3000/#slide> — browser yang dibuka ke URL ini langsung masuk
  mode slide tanpa perlu diklik. Cocok dipasang sebagai halaman awal kiosk.
- **Esc** keluar, **spasi** jeda, **←** / **→** pindah slide manual.
- Jumlah baris per slide dan durasinya diatur di halaman Pengaturan.
- Setelah berputar satu putaran penuh, data ditarik ulang otomatis.

---

## Menjalankan terus-menerus di server sendiri (alternatif Vercel)

Cara paling sederhana lewat Task Scheduler:

```powershell
schtasks /create /tn "OCS Replenish Monitor" /sc onstart /ru SYSTEM ^
  /tr "node C:\Users\EJI\ocs-replenish-monitor\src\server.js"
```

Untuk kontrol lebih baik (auto-restart bila proses mati, log terpisah), pakai
[NSSM](https://nssm.cc/) dan daftarkan `node src/server.js` sebagai Windows Service.

---

## API

Semua endpoint mengembalikan JSON kecuali `export.csv`.

| Metode | Endpoint | Kegunaan |
|---|---|---|
| `GET` | `/api/status` | Status sinkronisasi & jadwal berikutnya |
| `POST` | `/api/sync` | Tarik data sekarang juga |
| `GET` `POST` | `/api/cron` | Dipanggil penjadwal; menarik data hanya bila sudah waktunya. Butuh header `Authorization: Bearer <CRON_SECRET>` |
| `POST` | `/api/connection-test` | Uji kredensial ke OCS |
| `GET` | `/api/dashboard` | Data dashboard (`status`, `search`, `shop`, `sort`, `hide_safe`, …) |
| `GET` | `/api/export.csv` | Ekspor hasil filter ke CSV (dipisah `;`, ada BOM untuk Excel) |
| `GET` | `/api/history?sku=&areaId=` | Riwayat pergerakan satu item |
| `GET` | `/api/items/search?q=` | Cari item |
| `GET` `PUT` | `/api/settings` | Baca / ubah pengaturan |
| `GET` `PUT` `DELETE` | `/api/thresholds` | Kelola ambang khusus per item |
| `GET` | `/api/sync-log` | Riwayat penarikan data |

---

## Catatan keamanan

Kredensial `ADMIN` punya klaim akses penuh (`ACCESS: ["ADMIN"]`), padahal aplikasi ini
hanya perlu membaca stok. Sebaiknya minta tim OCS membuatkan user khusus integrasi
dengan hak baca saja, lalu ganti isi `.env`.

Aplikasi ini juga belum punya autentikasi sendiri — siapa pun yang bisa menjangkau
port 3000 dapat melihat dashboard dan mengubah pengaturan. Selama hanya dijalankan di
jaringan internal itu wajar; bila perlu diakses dari luar, letakkan di belakang reverse
proxy yang menangani login.
