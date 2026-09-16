# Jalan Lasak — Peta Program

Peta mudah alih untuk program **Jalan Lasak** di Kuala Kubu Bharu, dalam dua
peranan:

| | **Peserta** (`/`) | **Pusat kawalan** (`/pusat.html`, dilindungi kunci) |
| --- | --- | --- |
| Checkpoint & laluan | lihat sahaja — kemas kini automatik | tambah, seret, namakan, padam; lukis laluan cadangan |
| Kedudukan | telefon kumpulan hantar sendiri | peta + senarai semua kumpulan, jejak, "kali terakhir dilihat" |
| Kecemasan | butang **SOS** | amaran merah, bunyi & getar; SOS diletak paling atas |
| Peta offline | ya — simpan kawasan sebelum keluar liputan | ya |

Satu telefon setiap kumpulan: ketua kumpulan buka app, pilih kumpulannya
sekali, dan telefon itu menghantar kedudukan ke pusat kawalan selagi app
dibuka.

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
2. **Senarai kumpulan → Tambah kumpulan** — satu untuk setiap telefon ketua.
3. Betulkan checkpoint (seret), lukis laluan cadangan.
4. Setiap ketua kumpulan buka `/` di telefonnya semasa masih ada talian,
   pilih kumpulannya, tekan **Simpan kawasan ini** untuk peta offline, dan
   **Kekalkan skrin hidup**. Tambah ke skrin utama (*Add to Home Screen*).

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
  sw.js                 service worker: shell + dua cache tile + salinan /api/state
  manifest.webmanifest  metadata PWA
  _routes.json          hanya /api/* memanggil Functions
  assets/css/modernist.css  sistem reka bentuk (token + komponen)
  assets/css/app.css    chrome app, dibina atas token tersebut
  assets/js/core.js     peta, lapisan, marker, laluan, strip kompas, senarai, peta offline
  assets/js/edit.js     alat suntingan (pusat kawalan sahaja)
  assets/js/peserta.js  peranan peserta: kumpulan, pelapor, SOS, wake lock
  assets/js/pusat.js    peranan pusat kawalan: kunci, kumpulan, kedudukan, amaran
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
| GET | `/api/state` | semua | checkpoint, laluan, kumpulan, versi |
| PUT | `/api/state` | kunci | ganti checkpoint + laluan |
| PUT | `/api/groups` | kunci | ganti senarai kumpulan |
| POST | `/api/positions` | telefon | hantar sekumpulan kedudukan |
| GET | `/api/positions?trail=N` | kunci | kedudukan terkini setiap kumpulan + N jejak |

Kunci dihantar sebagai `Authorization: Bearer <CC_KEY>`. Semua ralat pulang
sebagai `{ "error": "…" }` dalam Bahasa Melayu dan dipaparkan terus dalam app.

### Cache dalam telefon

| Cache | Isi | Dibuang bila |
| --- | --- | --- |
| `jl-shell-v4` | fail app + salinan terakhir `/api/state` | versi baharu digunakan |
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
