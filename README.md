# Jalan Lasak — Peta Program

Peta mudah alih untuk program **Jalan Lasak** di Kuala Kubu Bharu, dalam dua
peranan:

| | **Peserta** (`/`) | **Marshal** (`/marshal.html`, PIN) | **Pusat kawalan** (`/pusat.html`, kunci) |
| --- | --- | --- | --- |
| Checkpoint & laluan | lihat sahaja — kemas kini automatik | — | tambah, seret, namakan, jadual; lukis laluan |
| Kedudukan | telefon kumpulan hantar sendiri | — | peta + senarai semua kumpulan, jejak, "kali terakhir dilihat" |
| Daftar masuk | — | catat setiap kumpulan yang tiba di CP-nya | catat sendiri (dari radio), lihat semua |
| Jadual | lihat jangkaan tiba | — | tetapkan; amaran bila kumpulan **lewat** |
| Kecemasan | butang **SOS**, sandaran **SMS** | — | amaran merah, bunyi & getar; masuk SMS secara manual |
| Peta offline | ya — simpan kawasan sebelum keluar liputan | tak perlu peta | ya |

Satu telefon setiap kumpulan: ketua kumpulan buka app, pilih kumpulannya
sekali, dan telefon itu menghantar kedudukan ke pusat kawalan selagi app
dibuka. Satu telefon marshal di setiap checkpoint mencatat kumpulan yang
tiba — pengesahan yang tidak bergantung pada GPS mahupun isyarat telefon
peserta.

Dibina atas **Cloudflare Pages** (laman statik) + **Pages Functions** (API)
+ **D1** (SQLite). Tiada pelayan untuk dijaga; semuanya dalam tier percuma.

---

## Bagaimana ia berfungsi

```
telefon kumpulan ──POST /api/positions──▶ ┌─────────────┐ ◀──GET /api/positions── pusat kawalan
                 ◀──GET /api/state────── │ Pages Func. │ ◀──PUT /api/state ─────  (kunci CC_KEY)
                                         │     + D1    │ ◀──PUT /api/groups ────
                                         └─────────────┘
```

- **Keadaan program** (checkpoint, laluan, senarai kumpulan) ada satu nombor
  versi. Pusat kawalan menghantar keseluruhannya bila ada suntingan; telefon
  peserta menyemak versi setiap 5 minit dan setiap kali ia menghantar
  kedudukan, dan mengambil salinan baharu bila berubah. Salinan terakhir
  disimpan dalam telefon supaya peta tetap terbuka tanpa isyarat.
- **Kedudukan** dihantar dengan peraturan keselamatan ini (lihat
  `public/assets/js/reporter.js`):
  - disampel setiap 1 minit semasa app dibuka;
  - **dihantar** bila SOS aktif, bila 5 minit berlalu, atau bila telefon
    bergerak ≥ 30 m dan 2 minit berlalu — kumpulan yang berhenti tetap
    dilaporkan, kumpulan yang bergerak dilaporkan lebih kerap;
  - yang gagal dihantar (tiada isyarat di denai) **beratur dalam telefon**
    dengan cap masa asalnya dan dihantar sekali gus bila ada isyarat, jadi
    pusat kawalan nampak jejak penuh, bukan lubang;
  - kembali ke latar depan → sampel dan hantar serta-merta.
- **Pusat kawalan** menyegarkan kedudukan setiap 15 saat. Kumpulan senyap
  > 10 minit ditanda, > 20 minit merah; SOS diletak paling atas dengan
  amaran berbunyi, dan kekal sehingga telefon itu membatalkannya.

### Kawasan tiada isyarat — apa yang menjaga keselamatan

Bila tiada isyarat, tiada app boleh menghantar apa-apa. Tiga perkara ini
direka supaya keselamatan **tidak bergantung** pada telefon peserta ada
talian:

1. **Jadual dan amaran lewat.** Setiap checkpoint ada "+N minit dari mula"
   (butang *Masa* pada checkpoint di pusat kawalan). Masa mula direkod
   **setiap kumpulan** — oleh marshal di MULA yang menanda "bertolak", atau
   butang *Mula* / *Mula semua* di pusat kawalan — jadi bertolak berperingkat
   dikira betul. Kumpulan yang belum sampai ke CP yang dijangka **lewat**
   dinaikkan ke atas senarai; lewat ≥ 15 minit menjadi amaran berbunyi, walaupun
   telefonnya senyap: *"LEWAT Kumpulan 3 · CP2 dijangka 11:30 · 25 min ·
   dilihat 32 min lalu."* Dalam hutan, senyap itu biasa; lewat itu tidak.
2. **Daftar masuk di checkpoint** (`/marshal.html`). Marshal pilih CP-nya
   sekali dan tekan *Tiba* untuk setiap kumpulan. Tanpa isyarat, catatan
   beratur dalam telefon dengan masa sebenar dan dihantar bila ada isyarat.
   Pusat kawalan juga boleh mencatat sendiri (*Tiba* pada baris kumpulan)
   bila marshal melapor melalui walkie-talkie. Sampai di CP juga dikesan dari
   GPS (dalam 100 m) sebagai sandaran.
3. **Sandaran SMS.** SMS lalu pada isyarat yang jauh lebih lemah daripada
   data. *Hantar melalui SMS* pada telefon peserta membuka app mesej dengan
   teks siap — `JL K3 3.54012,101.65123 12:04 SOS` — ke nombor yang pusat
   kawalan tetapkan (*Tetapan*). Pusat kawalan tampal teks itu ke *Masuk SMS*;
   kumpulan, koordinat dan SOS dibaca automatik dan dipaparkan seperti
   kedudukan biasa, bertanda *via SMS*.

Yang app tidak boleh ganti: walkie-talkie/VHF untuk marshal, *satellite
messenger* untuk pasukan *sweep* di belakang, wisel, masa *cut-off* keras.
Mesh Bluetooth antara telefon tidak mungkin dalam web app.

### Had yang perlu difahami — penting untuk keselamatan

Pelayar telefon **menggantung JavaScript bila skrin padam**. Web app tidak
boleh menghantar GPS di latar belakang seperti app native. Oleh itu:

1. Ketua kumpulan **mesti biarkan app terbuka** — gunakan butang
   *Kekalkan skrin hidup* (Wake Lock; disokong Android Chrome dan iOS 16.4+).
2. Pusat kawalan mesti menganggap kumpulan yang senyap > 20 minit sebagai
   *tidak diketahui*, bukan *selamat* — itulah sebabnya ia ditanda merah.
3. Jika pelaporan latar belakang tanpa syarat diperlukan, jawapannya ialah
   app native, bukan konfigurasi app ini.

---

## Pasang di Cloudflare

Perlukan akaun Cloudflare (percuma), Node 18+ dan `git`.

```sh
npm install

# 1. Log masuk dan buat pangkalan data
npx wrangler login
npx wrangler d1 create jalan-lasak
#    → salin database_id yang dicetak ke dalam wrangler.toml

# 2. Buat jadual
npm run db:init:remote

# 3. Buat projek Pages dan hantar laman
npx wrangler pages project create jalan-lasak --production-branch main
npm run deploy

# 4. Tetapkan kunci pusat kawalan (pilih kunci yang panjang dan rahsia)
npx wrangler pages secret put CC_KEY --project-name jalan-lasak
```

Selepas itu laman ada di `https://jalan-lasak.pages.dev` (atau domain
sendiri). Pastikan **binding D1** `DB` dan **secret** `CC_KEY` kelihatan di
*Pages → jalan-lasak → Settings → Bindings*; `wrangler.toml` menetapkannya
secara automatik bila deploy melalui CLI.

Untuk deploy automatik setiap `git push`, sambungkan repo GitHub di
*Workers & Pages → Create → Pages → Connect to Git* dengan build output
directory `public`. Binding dan secret ditetapkan sekali dalam tetapan projek.

### Sebelum program

1. Buka `/pusat.html`, masukkan `CC_KEY`.
2. **Tetapan** — nombor telefon pusat kawalan untuk SMS, dan PIN marshal.
3. **Senarai kumpulan → Tambah kumpulan** — satu untuk setiap telefon ketua.
4. Betulkan checkpoint (seret), tetapkan **Masa** (jangkaan minit dari mula)
   pada setiap checkpoint, lukis laluan cadangan.
5. Setiap marshal buka `/marshal.html` di telefonnya semasa ada talian,
   masukkan PIN, pilih checkpoint-nya.
6. Setiap ketua kumpulan buka `/` di telefonnya semasa masih ada talian,
   pilih kumpulannya, tekan **Simpan kawasan ini** untuk peta offline, dan
   **Kekalkan skrin hidup**. Tambah ke skrin utama (*Add to Home Screen*).
7. Bila kumpulan bertolak: marshal di MULA tekan *Tiba* untuk kumpulan itu
   (mula jam kumpulan), atau pusat kawalan tekan *Mula* / *Mula semua*.

### Kembangkan di komputer

```sh
npm install
cp .dev.vars.example .dev.vars      # tetapkan CC_KEY tempatan
npm run db:init                     # D1 tempatan
npm run dev                         # http://localhost:8788
```

---

## Struktur

```
public/                 laman statik (Cloudflare Pages)
  index.html            peserta
  pusat.html            pusat kawalan
  marshal.html          marshal checkpoint
  sw.js                 service worker: shell + dua cache tile + salinan /api/state
  manifest.webmanifest  metadata PWA
  _routes.json          hanya /api/* memanggil Functions
  assets/css/modernist.css  sistem reka bentuk (token + komponen)
  assets/css/app.css    chrome app, dibina atas token tersebut
  assets/js/core.js     peta, lapisan, marker, laluan, strip kompas, senarai, peta offline
  assets/js/edit.js     alat suntingan (pusat kawalan sahaja)
  assets/js/peserta.js  peranan peserta: kumpulan, pelapor, SOS, wake lock
  assets/js/pusat.js    peranan pusat kawalan: kunci, kumpulan, jadual, kedudukan, amaran
  assets/js/marshal.js  peranan marshal: PIN, checkpoint, daftar masuk + giliran offline
  assets/js/schedule.js jadual: sampai/belum, lewat berapa
  assets/js/reporter.js pelapor kedudukan + giliran offline
  assets/js/api.js      pembalut HTTP untuk /api/*
  assets/js/store.js    simpanan localStorage
  assets/js/geo.js      jarak, bearing, matematik tile
  assets/js/ui.js       dialog dan toast bertema
  assets/js/offline.js  simpan tile kawasan
  vendor/               Leaflet 1.9.4 + fon Archivo (self-hosted)
functions/api/[[route]].js   API — satu Pages Function
schema.sql              jadual D1
wrangler.toml           konfigurasi Pages + binding D1
tools/make-icons.py     jana semula ikon app
design/                 bundle serahan Claude Design (rujukan)
```

### API

| Kaedah | Laluan | Siapa | Kegunaan |
| --- | --- | --- | --- |
| GET | `/api/state` | semua | checkpoint (+ jadual), laluan, kumpulan (+ masa mula), tetapan, versi |
| PUT | `/api/state` | kunci | ganti checkpoint + laluan |
| PUT | `/api/groups` | kunci | ganti senarai kumpulan; masa mula dikekalkan jika tidak dihantar |
| PUT | `/api/settings` | kunci | nombor SMS, PIN marshal |
| POST | `/api/positions` | telefon | hantar sekumpulan kedudukan (`source: 'sms'` untuk yang ditaip) |
| GET | `/api/positions?trail=N` | kunci | kedudukan terkini, daftar masuk dan masa mula setiap kumpulan + N jejak |
| POST | `/api/checkins` | kunci **atau** PIN | catat kumpulan tiba di titik; tiba di MULA memulakan jam kumpulan |

Kunci dihantar sebagai `Authorization: Bearer <CC_KEY>`; PIN marshal sebagai
`X-Marshal-Pin`. Semua ralat pulang sebagai `{ "error": "…" }` dalam Bahasa
Melayu dan dipaparkan terus dalam app.

### Cache dalam telefon

| Cache | Isi | Dibuang bila |
| --- | --- | --- |
| `jl-shell-v5` | fail app + salinan terakhir `/api/state` | versi baharu digunakan |
| `jl-tiles-v1` | tile yang **sengaja** disimpan | hanya melalui butang *Kosongkan* |
| `jl-tiles-auto-v1` | tile yang terpapar semasa melayari | automatik, melebihi 1500 tile |

Fail app dilayan **network-first**, jadi perubahan yang di-deploy muncul pada
lawatan berikutnya; cache hanya jadi sandaran bila tiada talian.

## Reka bentuk

UI mengikut sistem **Modernist** dari bundle serahan — Archivo, sudut 0px,
garis 2px, satu aksen merah `#ec3013` atas ground `#f3f2f2`, label rata kiri.
`public/assets/css/modernist.css` ialah salinan `styles.css` sistem tersebut,
dengan satu perubahan sahaja: fon Archivo di-hos sendiri supaya app tetap
betul rupanya tanpa talian. Prototaip asal dan transkrip perbualan reka bentuk
ada dalam `design/`.

## Lesen pihak ketiga

- [Leaflet](https://leafletjs.com) 1.9.4 — BSD-2-Clause (`public/vendor/leaflet/LICENSE`)
- [Archivo](https://fonts.google.com/specimen/Archivo) — SIL OFL 1.1 (`public/vendor/fonts/LICENSE`)
- Tile: © OpenStreetMap contributors · © OpenTopoMap (CC-BY-SA) · Imagery © Esri,
  Maxar, Earthstar Geographics. Patuhi
  [dasar penggunaan tile OSM](https://operations.osmfoundation.org/policies/tiles/)
  — jangan muat turun kawasan besar secara pukal.
