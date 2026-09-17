# Jalan Lasak — Peta Program

Peta mudah alih untuk program **Jalan Lasak** di Kuala Kubu Bharu, dalam dua
peranan:

| | **Peserta** (`/`) | **Marshal** (`/marshal.html`, PIN) | **Pusat kawalan** (`/pusat.html`, kunci) |
| --- | --- | --- | --- |
| Checkpoint & laluan | checkpoint **didedahkan satu persatu**; laluan tidak dipaparkan | semua checkpoint dan laluan | tambah, seret, namakan, jadual; lukis laluan; anggaran tiba ikut kelajuan |
| Kedudukan | telefon kumpulan hantar sendiri (masuk dengan **PIN kumpulan**) | peta kedudukan semasa semua kumpulan, jarak dari CP-nya | peta + senarai semua kumpulan, jejak, "kali terakhir dilihat"; PIN setiap kumpulan |
| Daftar masuk | — | catat setiap kumpulan yang tiba di CP-nya | catat sendiri (dari radio), lihat semua |
| Jadual | lihat jangkaan tiba | — | tetapkan; amaran bila kumpulan **lewat** |
| Kecemasan | butang **SOS**, sandaran **SMS** | — | amaran merah, bunyi & getar; masuk SMS secara manual |
| Peta offline | ya — satu butang simpan **seluruh kawasan program** pada zum paling dalam yang muat | tile yang pernah dilihat sahaja | ya |

Satu telefon setiap kumpulan: ketua kumpulan buka app, masuk sekali dengan
**PIN 6 digit kumpulannya** (dijana rawak oleh pelayan bila pusat kawalan
menambah kumpulan), dan telefon itu menghantar kedudukan ke pusat kawalan
selagi app dibuka. PIN dihantar bersama setiap kedudukan, jadi telefon lain
tidak boleh melapor sebagai kumpulan itu. Satu telefon marshal di setiap checkpoint mencatat kumpulan yang
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
- **Titik biru** kedudukan telefon ada **kon arah hadap** (seperti Google
  Maps): ikut kompas telefon (iOS minta kebenaran pada ketikan pertama),
  atau arah pergerakan GPS bila berjalan; disembunyikan bila arah tidak
  diketahui. Peta kekal utara di atas.
- **Pusat kawalan** menyegarkan kedudukan setiap 15 saat. Kumpulan senyap
  > 10 minit ditanda, > 20 minit merah; SOS diletak paling atas dengan
  amaran berbunyi, dan kekal sehingga telefon itu membatalkannya.

### Checkpoint didedahkan satu persatu

Telefon peserta hanya menerima MULA, checkpoint yang sudah dicapai
kumpulannya, dan **satu** checkpoint seterusnya — pelayan menapis mengikut
PIN kumpulan, bukan sekadar menyembunyikan di skrin. "Sampai" dikira dari
daftar masuk marshal atau pusat kawalan, atau mana-mana kedudukan kumpulan
itu dalam 100 m dari titik. Bila checkpoint baharu didedahkan, kompas terus
disasarkan kepadanya.

**Kod checkpoint — pendedahan tanpa isyarat.** Setiap titik ada kod rahsia
6 aksara (tanpa 0/O/1/I). Semasa ada talian, telefon peserta turut memuat
turun setiap checkpoint yang belum didedahkan dalam bentuk **disulitkan**
(AES-GCM, kunci PBKDF2 daripada kod checkpoint *sebelumnya*). Di checkpoint,
marshal memaparkan kod titiknya (teks besar + QR di `/marshal.html`; pusat
kawalan boleh **cetak** satu helai setiap checkpoint melalui *Kod
checkpoint*). Ketua kumpulan taip kod itu, imbas QR dalam app (Android
Chrome), atau imbas dengan kamera telefon (QR membawa URL `/?kod=…`) —
checkpoint seterusnya dibuka **serta-merta tanpa talian**, dan catatan
"tiba" beratur dalam telefon lalu dihantar (`source: 'qr'`) bila ada
isyarat. Kod juga boleh dibaca melalui walkie-talkie atau dibalas oleh pusat
kawalan melalui SMS. Jangan letak semua kod pada satu helai di trek.
Pangkalan data lama: jalankan `migrations/0002-point-code.sql` sekali. Laluan cadangan **tidak dihantar kepada peserta** —
ia alat pusat kawalan. Setiap laluan bermula di MULA atau checkpoint dan
berakhir di checkpoint (dipilih semasa melukis; titik pertama dan terakhir
ditambat, nama automatik "MULA → Checkpoint 1"). Pusat kawalan dan marshal
menggunakannya untuk **anggaran tiba ikut kelajuan sebenar**: jarak baki
diukur di sepanjang laluan ke checkpoint seterusnya (dari unjuran kedudukan
kumpulan ke laluan; garis lurus jika tiada laluan atau kumpulan > 300 m
darinya), dibahagi kelajuan purata 20 minit terakhir dari jejak kumpulan —
"≈ 14 min ke Checkpoint 2 · 1.2 km ikut laluan · 4.8 km/j", atau "Berhenti"
bila hampir tidak bergerak. Pangkalan data lama: jalankan juga
`migrations/0003-route-endpoints.sql` sekali.

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
3. **Sandaran SMS, sebahagian daripada aliran SOS.** SMS lalu pada isyarat
   yang jauh lebih lemah daripada data. Butang **SOS** menghantar melalui
   internet bila ada talian; bila tiada, app **terus membuka SMS** dengan
   teks siap — `JL K3 3.54012,101.65123 12:04 SOS` — ke nombor yang pusat
   kawalan tetapkan (*Tetapan*), dan sepanduk SOS menunjukkan saluran mana
   yang digunakan. Di luar SOS, butang *Hantar kedudukan melalui SMS* hanya
   muncul bila tiada talian. Pusat kawalan tampal teks itu ke *Masuk SMS*;
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

### Manual pengguna

Dua manual PDF lengkap dengan tangkapan skrin, diedarkan oleh penganjur
(tidak disimpan dalam repositori; folder `docs/` diabaikan git):

| Manual | Untuk siapa | Isi |
| --- | --- | --- |
| **Manual Peserta** | ketua kumpulan | masuk PIN, simpan peta offline, kekalkan skrin hidup, tab Kumpulan / Checkpoint / Peta, kod checkpoint, SOS dan SMS, bila tiada isyarat, penyelesaian masalah |
| **Manual Pusat Kawalan & Marshal** | operator pusat kawalan, marshal | senarai semak sebelum program, kumpulan dan PIN, tetapan, checkpoint dan jadual, kod checkpoint dan cetak, memantau kumpulan, daftar masuk manual dan SMS, marshal langkah demi langkah, prosedur kecemasan |

Tangkapan skrin dalam manual dibuat dari pelayan tempatan dengan data demo;
PIN dan kod di dalamnya bukan data sebenar.

### Sebelum program

1. Buka `/pusat.html`, masukkan `CC_KEY`.
2. **Tetapan** — nombor telefon pusat kawalan untuk SMS, dan PIN marshal.
3. **Senarai kumpulan → Tambah kumpulan** — satu untuk setiap telefon ketua.
   PIN kumpulan dipaparkan serta-merta; beri kepada ketua kumpulan itu sahaja.
   Butang *PIN* pada setiap baris memaparkan semula atau menjana PIN baharu
   (PIN lama terus tidak sah).
4. Betulkan checkpoint (seret), tetapkan **Masa** (jangkaan minit dari mula)
   pada setiap checkpoint, lukis laluan cadangan.
5. Setiap marshal buka `/marshal.html` di telefonnya semasa ada talian,
   masukkan PIN, pilih checkpoint-nya.
6. Setiap ketua kumpulan buka `/` di telefonnya semasa masih ada talian,
   masuk dengan PIN kumpulannya, tekan **Simpan kawasan ini** untuk peta offline
   (seluruh kawasan program, zum paling dalam yang muat dalam ± 70 MB), dan
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
  assets/js/schedule.js jadual: sampai/belum, lewat berapa; anggaran tiba ikut kelajuan
  assets/js/reporter.js pelapor kedudukan + giliran offline
  assets/js/api.js      pembalut HTTP untuk /api/*
  assets/js/store.js    simpanan localStorage
  assets/js/geo.js      jarak, bearing, matematik tile
  assets/js/ui.js       dialog dan toast bertema
  assets/js/tabs.js     navbar bawah (peserta dan pusat kawalan)
  assets/js/lock.js     buka kunci checkpoint dengan kod (AES-GCM, PBKDF2)
  assets/js/offline.js  simpan tile kawasan
  vendor/               Leaflet 1.9.4 + fon Archivo + qrcode-generator (self-hosted)
functions/api/[[route]].js   API — satu Pages Function
schema.sql              jadual D1
wrangler.toml           konfigurasi Pages + binding D1
tools/icon.svg          sumber ikon app (Modernist: petak MULA merah, jejak putus, petak checkpoint)
tools/make-icons.js     jana semula ikon (PNG 512/192/180 + maskable) dengan Chrome headless, tanpa npm
design/                 bundle serahan Claude Design (rujukan)
```

### API

| Kaedah | Laluan | Siapa | Kegunaan |
| --- | --- | --- | --- |
| GET | `/api/state` | semua | checkpoint (+ jadual), laluan, kumpulan (+ masa mula), tetapan, versi, `area` (kotak semua titik + laluan, tambah 1.5 km, untuk peta offline). Kunci / PIN marshal: semua titik; `X-Group-Pin`: titik yang didedahkan + `progress`; tanpa apa-apa: MULA sahaja |
| PUT | `/api/state` | kunci | ganti checkpoint + laluan (`from`, `to` = id titik; `to` mesti checkpoint) |
| PUT | `/api/groups` | kunci | ganti senarai kumpulan; masa mula dan PIN dikekalkan jika tidak dihantar, `resetPin: true` jana PIN baharu; pulang PIN setiap kumpulan |
| POST | `/api/groups/login` | telefon | `{ pin }` → kumpulan yang memiliki PIN itu |
| PUT | `/api/settings` | kunci | nombor SMS, PIN marshal |
| POST | `/api/positions` | telefon (PIN kumpulan) atau kunci | hantar sekumpulan kedudukan (`source: 'sms'` untuk yang ditaip); pulang `revealed` = bilangan titik yang kumpulan itu boleh lihat |
| GET | `/api/positions?trail=N` | kunci **atau** PIN | kedudukan terkini, daftar masuk dan masa mula setiap kumpulan + N jejak; PIN kumpulan hanya untuk kunci |
| POST | `/api/checkins` | kunci, PIN marshal, **atau** PIN kumpulan + kod titik | catat kumpulan tiba di titik; tiba di MULA memulakan jam kumpulan |

Kunci dihantar sebagai `Authorization: Bearer <CC_KEY>`; PIN marshal sebagai
`X-Marshal-Pin`; PIN kumpulan dalam badan `POST /api/positions` sebagai `pin`.
Pangkalan data yang dibuat sebelum PIN kumpulan wujud: jalankan
`migrations/0001-group-pin.sql` sekali. Semua ralat pulang sebagai `{ "error": "…" }` dalam Bahasa
Melayu dan dipaparkan terus dalam app.

### Cache dalam telefon

| Cache | Isi | Dibuang bila |
| --- | --- | --- |
| `jl-shell-v25` | fail app + salinan terakhir `/api/state` | versi baharu digunakan |
| `jl-tiles-v1` | tile yang **sengaja** disimpan | hanya melalui butang *Kosongkan* |
| `jl-tiles-auto-v1` | tile yang terpapar semasa melayari | automatik, melebihi 1500 tile |

Fail app dilayan **network-first**, jadi perubahan yang di-deploy muncul pada
lawatan berikutnya; cache hanya jadi sandaran bila tiada talian. Bila service
worker baharu mengambil alih, halaman **memuat semula sendiri** sekali (app
skrin utama tiada butang muat semula); kemas kini disemak setiap kali app
kembali ke depan.

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
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 — MIT (`public/vendor/qrcode/LICENSE`)
- Tile: © OpenStreetMap contributors · © OpenTopoMap (CC-BY-SA) · Imagery © Esri,
  Maxar, Earthstar Geographics. Patuhi
  [dasar penggunaan tile OSM](https://operations.osmfoundation.org/policies/tiles/)
  — jangan muat turun kawasan besar secara pukal.
