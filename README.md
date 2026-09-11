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
| `npm run backfill-sales <YYYY-MM> <YYYY-MM>` | Tarik penjualan bulan demi bulan, mundur, melewati yang sudah ada |

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
| `POST` | `/api/sales/fill` | Tarik hanya tanggal yang belum tersimpan pada rentang |
| `POST` | `/api/sales/refresh` | Segarkan beberapa hari terakhir yang masih berubah |

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

### Batas hari mengikuti zona waktu OCS

Cap waktu OCS berakhiran **+07:00** dan pengelompokan hariannya mengikuti hari kalender
di zona itu. Batas rentang karena itu dikirim sebagai `T00:00:00+07:00` sampai
`T23:59:59.999+07:00`, bukan tengah malam UTC.

Ini bukan detail kecil. Tengah malam UTC jatuh pada pukul 07:00 waktu OCS, sehingga hari
pertama dan terakhir setiap permintaan terpotong dan hanya hari di tengah rentang yang
utuh. Terukur pada 15 Maret 2026:

| Posisi 15 Maret dalam jendela | Qty |
|---|---|
| Di tengah | 67.601 |
| Di awal | 50.888 |
| Di akhir | 16.713 |

Dua angka terakhir berjumlah tepat sama dengan yang pertama — harinya memang terbelah di
tengah malam UTC. Dengan potongan tiga-harian, dua dari tiga hari akan salah.

Setelah batasnya dipatok ke zona OCS, keempat posisi (tengah, awal, akhir, sendirian)
memberi angka yang sama.

Halaman Penjualan menandai tiga keadaan berbeda:

| Keadaan | Arti |
|---|---|
| **Hari bolong** | Belum pernah ditarik |
| **Hari kosong** | Tercatat ditarik tetapi tanpa satu baris pun |
| **Hari usang** | Ditarik dengan aturan lama yang sudah diketahui salah |

Dua yang terakhir lebih menyesatkan daripada yang pertama, karena cakupannya tampak
lengkap. Hari usang bahkan berisi angka yang wajar — hanya saja dihitung dengan cara
yang keliru.

Kolom `pull_version` pada `sales_sync_day` menyimpan versi aturan penarikan yang dipakai
saat hari itu diambil. Ketika aturan berubah sedemikian rupa sehingga data lama menjadi
salah, konstanta `PULL_VERSION` di `src/sales.js` dinaikkan dan hari berversi lebih
rendah otomatis dilaporkan usang. Tanpa ini, satu-satunya cara menemukannya adalah
menebak dari cap waktu penarikan.

Rentang penarikan ditentukan sendiri dari bagian **Tarik Data**. Worker menyegarkan
beberapa hari terakhir tiap putaran, sebanyak `sales_resync_days` di halaman Pengaturan
(bawaan 7 hari).

### Berhenti menarik hari yang angkanya sudah tetap

Setiap hari yang tersimpan punya **sidik jari** — gabungan jumlah order, jumlah barang,
dan banyaknya baris. Bila penarikan berikutnya menghasilkan sidik jari yang sama,
`stable_count` naik; begitu isinya sama **dua kali berturut-turut**, hari itu dianggap
mengendap dan berhenti ikut disegarkan berkala.

Dua hari terakhir selalu ditarik ulang apa pun keadaannya, karena di sanalah order masih
aktif berpindah status.

Hasilnya penyegaran rutin hanya menyentuh hari yang benar-benar masih berubah. Kolom
**Angka** di daftar hari menunjukkan mana yang sudah *Mengendap* dan mana yang *Masih
berubah*.

### Memperluas cakupan ke belakang

```bash
npm run backfill-sales 2026-01 2026-06
```

Menarik bulan demi bulan dari yang terbaru ke yang terlama — kalau terhenti di tengah
jalan, yang sudah masuk adalah bagian yang paling sering dipakai. **Tanggal yang sudah
tersimpan dilewati**, jadi menjalankan ulang hanya mengerjakan sisanya.

Di web, tombol **Lengkapi yang Kosong** melakukan hal yang sama untuk rentang yang
sedang dipilih: hanya menarik tanggal yang belum ada, jauh lebih murah daripada menarik
ulang semuanya.

### Berapa lama penarikannya

Kecepatannya **sangat bergantung pada umur data**. OCS menyegarkan materialized view
untuk data terkini (`/Report/MvRefreshInfo` melaporkan waktu penyegaran terakhir),
sehingga rentang beberapa minggu terakhir dijawab cepat. Rentang lama tampaknya dipindai
dari tabel order 19,6 juta baris.

| Rentang | Terukur | Per hari |
|---|---|---|
| 7 hari terakhir (potongan 7 hari) | 17,6 detik | 2,5 detik |
| Hari-hari Juli (potongan 7 hari) | 21 hari / ±11 menit | 31 detik |
| 39 hari Juli–Agustus (potongan 3 hari) | 9,4 menit | **14,5 detik** |

Mengecilkan potongan untuk data lama membuatnya lebih dari dua kali lebih cepat —
permintaan yang lebih pendek lebih jarang menabrak batas waktu dan lebih jarang perlu
diulang.

Perkiraan praktis: 30 hari ±1 menit, 90 hari ±16 menit, satu tahun ±1,4 jam. Halaman
Tarik Data menghitung perkiraan ini per rentang dan menampilkannya sebelum penarikan
dimulai, dengan tarif berbeda untuk data baru dan lama.

Karena itu potongan permintaan menyesuaikan umurnya — 7 hari sekali jalan untuk data
baru, 3 hari untuk data lama — dan batas waktunya dinaikkan menjadi 240 detik.

Pemecahan ini juga membuat batas **31 hari per permintaan** di halaman Report OCS tidak
pernah tersentuh: rentang satu tahun pun terpecah menjadi 117 potongan yang masing-masing
paling banyak 7 hari. Jadi rentang sepanjang apa pun boleh diisi di halaman Tarik Data. Potongan
yang tetap gagal **tidak menjatuhkan sisa rentang**: hari yang sudah masuk tetap
tersimpan, potongan yang gagal dilaporkan, dan hari yang belum lengkap muncul sebagai
"hari bolong" di halaman Penjualan.

---

## ATP Monitoring

ATP (*Available To Promise*) menjawab satu pertanyaan: **dari barang yang memang
dijual di sebuah cabang, berapa persen yang stoknya cukup untuk dijanjikan hari ini?**

Rumusnya sengaja dibuat sederhana supaya bisa dipertanggungjawabkan:

```
ATP % = jumlah SKU aktif yang stoknya > ambang
        ------------------------------------- x 100
              jumlah SKU aktif di cabang itu
```

Ambangnya **5 pcs**. Stok di atas 5 dihitung *tersedia*, 5 ke bawah dihitung *kosong* —
sisa segitu tidak layak dijanjikan ke pembeli. Angka ini bisa diubah di Pengaturan.

### Dari mana datanya

Tiga sumber OCS digabung jadi satu tabel master:

| Sumber | Endpoint | Yang diambil |
|---|---|---|
| `/master/sku-rack` | `MasterData/GetSkuRack` | nama barang, kode SAP, **brand/shop** |
| `/stocks/view-v2` | `odata/DTO_WmsItemStockLiteV2` | stok per area, status aktif OCS |
| `/master/bundle` | `MasterData/GetBundle` | komponen tiap produk bundling |

Penarikan ATP memakai **akun tersendiri** (`OCS_ATP_USERNAME` / `OCS_ATP_PASSWORD`),
bukan akun yang dipakai monitoring replenish. Alasannya: hak akses area menempel pada
akun. Akun `ADMIN` hanya melihat area "Pusat", sedangkan akun ATP melihat kelima cabang.
Token keduanya disimpan terpisah supaya tidak saling menimpa.

**Brand bundle diturunkan dari komponennya.** `GetSkuRack` hanya memuat barang yang
dirak, dan bundle tidak pernah dirak — sehingga 1.857 dari 2.525 SKU tadinya masuk
kelompok "(tanpa brand)" dan membuat pengelompokan brand tidak ada gunanya. Sekarang
brand sebuah bundle diambil dari brand komponen yang paling dominan di dalamnya.

### Aktif di cabang mana

Tidak semua cabang menerima barang yang sama. Status aktif punya dua lapis:

- `is_active_ocs` — apa kata OCS, disegarkan setiap penarikan.
- `is_active_override` — centang manual di halaman Master Data.

Yang berlaku adalah `COALESCE(override, ocs)`: selama tidak ada centang manual,
OCS yang menentukan. Sekali dicentang manual, centang itu menang dan bertahan
walau OCS berubah. Mengosongkan override mengembalikan kendali ke OCS.

### Rekaman harian

Setiap hari pukul **07:00 WIB** hasil perhitungan disimpan ke `atp_snapshot`,
satu baris per cabang x brand x kategori. Pemeriksaannya dilakukan worker tiap
putaran, bukan lewat penjadwal terpisah — jadi kalau worker sempat mati melewati
jam 7, rekamannya tetap terambil begitu worker hidup lagi. Menyimpan tanggal yang
sama dua kali menimpa baris lama, tidak menggandakannya.

Master ATP ditarik paling sering **setengah jam sekali**, karena sekali tarik
memakan sekitar satu menit dan datanya tidak berubah secepat stok. Pengecualiannya
saat rekaman harian hendak diambil: di situ master dipaksa segar lebih dulu.

### Cabang

Kelima cabang OCS (Pusat, Surabaya, Medan, Makassar, Yogyakarta) terdaftar otomatis
dan **tidak bisa dihapus** dari aplikasi — kalau cabangnya benar-benar tutup,
hapus dari OCS. Cabang baru di luar OCS bisa ditambahkan manual lewat halaman Cabang,
misalnya untuk gudang yang belum masuk sistem.

### Pengaturan

| Kunci | Bawaan | Arti |
|---|---|---|
| `atp_stock_field` | `qty_on_hand` | kolom stok yang dipakai: `qty_on_hand`, `available_qty`, atau `qty_rack` |
| `atp_threshold` | `5` | stok di atas angka ini dianggap tersedia |
| `atp_snapshot_hour` | `7` | jam WIB pengambilan rekaman harian |

Mengganti `atp_stock_field` mengubah angka ATP saat itu juga, tapi **tidak** menulis
ulang rekaman lama — tiap baris `atp_snapshot` menyimpan kolom dan ambang yang berlaku
ketika ia diambil, supaya tren tidak berubah arti secara diam-diam.

### API

| Endpoint | Kegunaan |
|---|---|
| `GET /api/atp/dashboard` | ringkasan: total, per cabang, per brand, matriks, tren |
| `GET /api/atp/master` | master data per SKU x cabang (filter `search`, `shop`, `category`, `branch`, `status`) |
| `GET /api/atp/bundle/:sku` | komponen satu bundle beserta stoknya per cabang |
| `PUT /api/atp/override` | ubah centang aktif manual satu SKU di satu cabang |
| `GET /api/atp/history` | riwayat rekaman harian |
| `GET/POST/PUT/DELETE /api/atp/branches` | kelola cabang |
| `POST /api/atp/sync` | tarik master ATP sekarang |
| `POST /api/atp/snapshot` | simpan rekaman untuk hari ini |

---

## Catatan keamanan

Kredensial `ADMIN` punya klaim akses penuh (`ACCESS: ["ADMIN"]`), padahal aplikasi ini
hanya perlu membaca stok. Sebaiknya minta tim OCS membuatkan user khusus integrasi
dengan hak baca saja, lalu ganti isi `.env`. Hal yang sama berlaku untuk akun ATP —
ia dipakai hanya karena kebetulan punya akses kelima area, bukan karena butuh hak tulis.

Aplikasi ini juga belum punya autentikasi sendiri — siapa pun yang bisa menjangkau
port 3000 dapat melihat dashboard dan mengubah pengaturan. Selama hanya dijalankan di
jaringan internal itu wajar; bila perlu diakses dari luar, letakkan di belakang reverse
proxy yang menangani login.
