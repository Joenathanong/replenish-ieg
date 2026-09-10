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
| `npm run backfill-replenish` | Tarik seluruh riwayat transaksi replenish dari OCS |

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
| `GET` | `/api/replenish/summary` | Ringkasan transaksi replenish |
| `GET` | `/api/replenish/search?sku=` | Cari transaksi per SKU (log rak + baris dokumen) |
| `GET` | `/api/replenish/docs` | Daftar dokumen transfer (`status`, `search`) |
| `GET` | `/api/replenish/doc/:id` | Satu dokumen beserta baris detailnya |
| `POST` | `/api/replenish/sync` | Tarik riwayat replenish terbaru |
| `GET` | `/api/adjustment/summary` | Ringkasan + nilai yang tersedia untuk filter |
| `GET` | `/api/adjustment/search` | Cari penyesuaian (`sku`, `type`, `shop`, `user`, `from`, `to`, `remarks`) |
| `GET` | `/api/adjustment/export.csv` | Ekspor hasil filter ke CSV |
| `GET` | `/api/adjustment/trx/:id` | Satu transaksi beserta barisnya |
| `POST` | `/api/adjustment/sync` | Tarik riwayat penyesuaian terbaru |
| `GET` | `/api/sales/summary` | Ringkasan penjualan + nilai filter + cakupan tanggal |
| `GET` | `/api/sales/orders` | Order per hari (`from`, `to`, `area`, `shop`, `platform`, `status`, `groupBy`) |
| `GET` | `/api/sales/sku` | Barang terjual per SKU (`sku`, `mode`, `groupBy`) |
| `GET` | `/api/sales/days` | Hari yang sudah tersimpan |
| `POST` | `/api/sales/pull` | Tarik rentang tanggal tertentu (`from`, `to`) |
| `POST` | `/api/sales/refresh` | Segarkan beberapa hari terakhir |

---

## Transaksi Replenish

Tab **Transaksi Replenish** menelusuri riwayat pemindahan stok, dari dua sumber di
OCS yang saling melengkapi:

| Tabel | Sumber OCS | Isi |
|---|---|---|
| `replenish_bin_log` | `DTO_HistoryReplenish` | SKU masuk ke bin mana, berapa, kapan, oleh siapa |
| `replenish_doc` | `DTO_HistoryReplenishITHead` | Dokumen Inventory Transfer ke SAP dan statusnya |
| `replenish_doc_line` | `GET /Stock/ReplenishHistory/{id}` | Baris detail tiap dokumen |

Keduanya punya kolom SKU, sehingga satu pencarian menjawab dua pertanyaan sekaligus:
*"masuk ke rak mana"* dan *"dokumen SAP mana, berhasil posting atau gagal"*.

Tautan `#transaksi/<SKU>` membuka langsung hasil pencarian SKU tersebut, jadi bisa
dibagikan atau di-bookmark.

### Pencocokan kode

Pencarian **mencocokkan kode secara persis**. Mencari `CUSHION-LIGHT-1` tidak akan ikut
menampilkan `REFILL-CUSHION-LIGHT-1` — keduanya barang yang berbeda, dan menggabungkan
angkanya justru menyesatkan.

Besar-kecil huruf tetap diabaikan, karena itu soal cara mengetik dan bukan soal identitas
barang. Sakelar **Cocok persis** bisa dimatikan bila memang ingin mencari semua kode yang
mengandung kata kunci; saat dimatikan, aplikasi memberi peringatan bahwa hasilnya
menggabungkan beberapa SKU.

Kode serupa selalu ditawarkan sebagai tombol yang bisa diklik — termasuk ketika
pencocokan persis tidak menemukan apa pun, sehingga pengguna yang hanya ingat sepotong
kode tidak buntu.

### Cara sinkronisasinya

Log per bin dan daftar dokumen ditarik **inkremental** — hanya baris yang lebih baru
dari yang tersimpan, memakai `Id` untuk log dan `CreatedAt` untuk dokumen, masing-masing
dengan tenggang mundur supaya baris yang tersimpan terlambat tetap terjaring.

Baris detail dokumen berbeda: OCS hanya menyediakannya satu per satu
(`GET /Stock/ReplenishHistory/{id}`, ~1 detik per dokumen), sehingga ditarik bertahap
lewat antrean. Kolom `detail_synced_at` yang masih kosong berarti dokumen itu belum
diambil detailnya. Untuk menuntaskan sekaligus, jalankan:

```bash
npm run backfill-replenish
```

Aman dihentikan di tengah jalan dan dijalankan ulang — dokumen yang sudah selesai tidak
ditarik dua kali. Setelah backfill awal, worker menyusul sisanya sendiri tiap putaran.

---

## Adjustment Stok

Tab **Adjustment Stok** menelusuri riwayat penyesuaian stok dari OCS
(`/stocks/update`). Satu baris di tabel berarti satu SKU pada satu transaksi.

| Tabel | Sumber OCS | Isi |
|---|---|---|
| `adjustment_head` | `DTO_HistoryStockAdjustment` | Nomor transaksi, jenis IN/OUT, area, brand, pengguna, waktu |
| `adjustment_line` | `POST /Stock/GetHistoryStockAdjustmentDetail` | SKU, qty penyesuaian, keterangan |

Filternya bisa digabung bebas: kode SKU, jenis (IN/OUT), brand, pengguna, rentang
tanggal, dan pencarian di kolom keterangan. Tombol **Ekspor CSV** mengikuti filter yang
sedang aktif, bukan seluruh tabel — berguna karena tampilan dibatasi 300 baris teratas
sedangkan ekspor mengambil semuanya.

Pencocokan kode SKU **persis** secara bawaan, sama seperti Transaksi Replenish, dengan
sakelar untuk melonggarkannya.

Berbeda dengan riwayat replenish, detail penyesuaian bisa diminta beberapa transaksi
sekaligus, sehingga seluruh riwayat tertarik dalam hitungan detik tanpa perlu antrean
bertahap.

---

## Penjualan

Tab **Penjualan** menarik agregat harian dari halaman Report OCS. Data mentah order
berjumlah **19,6 juta baris**, jadi yang disimpan adalah ringkasan hariannya — bukan
barisan order satu per satu.

| Tabel | Sumber OCS | Isi |
|---|---|---|
| `sales_order_status_daily` | `/Report/OrderPerShopReport` | Jumlah order per tanggal x brand x platform x status |
| `sales_order_shop_daily` | idem | Total order, SOI, dan MOI per tanggal x brand |
| `sales_sku_daily` | `/Report/OrderPerSkuReport` | Qty terjual per tanggal x SKU x platform |
| `sales_sync_day` | — | Catatan hari mana saja yang sudah ditarik |

### Audit status

`/MasterData/GetStatusList` mengembalikan **32 entri, tetapi hanya 31 kode unik dan 31
nama unik**:

- Kode **30200** dipakai dua nama sekaligus: `SHIPPING_LOST` dan `SHIPPING_DAMAGED`.
  Menyaring dengan kode itu tidak bisa membedakan keduanya.
- Nama **`CANCELLED`** punya dua kode: **11100** dan **90000**.

Laporan Order tidak memakai 32 status itu, melainkan **13 kelompok**: `UNPAID`,
`IN_CANCEL`, `CANCELLED`, `READY_TO_PROCESS`, `PROCESSED`, `PICK_ASSIGNED`, `PICKED`,
`SORTED`, `PACKED`, `MANIFESTED`, `IN_TRANSIT`, `DELIVERED`, `RETURN`.

Pengelompokan itu terbukti utuh: pada 128 baris selama 1–9 September, jumlah 13 kolom
sama persis dengan `TotalOrder` — 260.675 order, selisih nol. Status mentah seperti
`COMPLETED`, `PICKING`, dan `BYPASS` terlipat ke dalam salah satu kelompok.

Karena itu penyaringan status di aplikasi ini memakai **13 nama kelompok**, bukan kode
numerik — sesuai yang benar-benar dikembalikan laporan.

### Tidak ada penarikan ganda

Isi satu hari **bisa berubah** setelah hari itu lewat, karena order berpindah status.
Karena itu penarikan ulang **menghapus dulu seluruh baris tanggal tersebut lalu menulis
ulang**, bukan menambahkan. Menarik rentang yang sama berkali-kali karena itu selalu
menghasilkan angka yang sama.

Penghapusan mencakup gabungan hari yang diminta dan hari yang benar-benar dikembalikan
server — keduanya perlu, karena hari yang transaksinya hilang harus ikut bersih, dan
batas rentang di sisi server pernah menyertakan hari di luar permintaan.

Rentang penarikan ditentukan sendiri dari bagian **Tarik Data**. Worker menyegarkan
beberapa hari terakhir tiap putaran, sebanyak `sales_resync_days` di halaman Pengaturan
(bawaan 7 hari).

---

## Catatan keamanan

Kredensial `ADMIN` punya klaim akses penuh (`ACCESS: ["ADMIN"]`), padahal aplikasi ini
hanya perlu membaca stok. Sebaiknya minta tim OCS membuatkan user khusus integrasi
dengan hak baca saja, lalu ganti isi `.env`.

Aplikasi ini juga belum punya autentikasi sendiri — siapa pun yang bisa menjangkau
port 3000 dapat melihat dashboard dan mengubah pengaturan. Selama hanya dijalankan di
jaringan internal itu wajar; bila perlu diakses dari luar, letakkan di belakang reverse
proxy yang menangani login.
