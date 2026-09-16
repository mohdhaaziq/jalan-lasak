# Jalan Lasak — Peta Program

Peta mudah alih untuk program **Jalan Lasak** di Kuala Kubu Bharu: titik mula,
checkpoint, laluan cadangan dan peta topo/satelit — semuanya berfungsi **tanpa
talian** selepas kawasan disimpan.

A static, installable web app (PWA). No build step, no framework, no server:
open `index.html` from any static host and it runs.

---

## Ciri

| | |
| --- | --- |
| **Titik mula** | Parking Stesen KTM Kuala Kubu Bharu (3.556879, 101.632263) |
| **Checkpoint** | CP1 (3.494318, 101.688912), CP2 (3.567827, 101.613620), tambah sendiri melalui butang **+** atau tekan lama pada peta |
| **Lapisan** | Denai OSM · Topo (OpenTopoMap) · Satelit (Esri World Imagery), dengan kontur lutsinar boleh dihidupkan atas satelit |
| **GPS** | Blue dot + bulatan ketepatan, jarak ke setiap titik, anak panah kompas dan bearing ke sasaran |
| **Laluan cadangan** | Lukis titik demi titik, anggaran KM secara langsung, undo, simpan dengan nama |
| **Offline** | Simpan tile kawasan yang sedang dilihat; app dan data kekal dalam peranti |

Semua marker boleh diseret untuk membetulkan posisi. Checkpoint, laluan,
sasaran dan pilihan lapisan disimpan dalam peranti (`localStorage`) —
tiada pelayan, tiada akaun.

> **Nota ketepatan.** KM laluan ialah jumlah jarak garis lurus antara titik
> yang diletakkan — makin rapat titik mengikut denai, makin tepat anggarannya.
> Kompas sebenar hanya berfungsi pada telefon yang ada sensor; tanpa sensor
> anak panah menunjuk bearing dengan utara di atas.

## Menjalankan

Perlukan pelayan HTTP — service worker dan ES module tidak berfungsi dari
`file://`:

```sh
python3 -m http.server 8000
# buka http://localhost:8000
```

Untuk guna di lapangan, hos folder ini pada mana-mana static host (GitHub
Pages, Netlify, Cloudflare Pages). **HTTPS diperlukan** untuk GPS dan mod
offline. Buka di telefon → *Add to Home Screen*.

### Sebelum keluar dari liputan

1. Buka app semasa masih ada talian.
2. Zum ke kawasan program.
3. **Peta offline → Simpan kawasan ini** — ia memuat turun tile untuk paparan
   semasa merentas tiga aras zum.
4. Ulang bagi setiap kawasan dan setiap lapisan yang hendak dibawa.

## Struktur

```
index.html              satu skrin — topbar, peta, sheet bawah
manifest.webmanifest    metadata PWA
sw.js                   service worker: shell + dua cache tile
assets/css/modernist.css  sistem reka bentuk (token + komponen)
assets/css/app.css      chrome app, dibina atas token tersebut
assets/js/app.js        pendawaian: peta, marker, mod, senarai
assets/js/geo.js        jarak, bearing, matematik tile
assets/js/store.js      simpanan localStorage
assets/js/ui.js         dialog dan toast bertema
assets/js/offline.js    simpan tile kawasan
vendor/                 Leaflet 1.9.4 + fon Archivo (self-hosted)
tools/make-icons.py     jana semula ikon app
design/                 bundle serahan Claude Design (rujukan)
```

### Cache

| Cache | Isi | Dibuang bila |
| --- | --- | --- |
| `jl-shell-v3` | fail app | versi baharu digunakan |
| `jl-tiles-v1` | tile yang **sengaja** disimpan | hanya melalui butang *Kosongkan* |
| `jl-tiles-auto-v1` | tile yang terpapar semasa melayari | automatik, melebihi 1500 tile |

Fail app dilayan **network-first**, jadi perubahan yang dihantar akan muncul
pada lawatan berikutnya; cache hanya jadi sandaran bila tiada talian.

## Reka bentuk

UI mengikut sistem **Modernist** dari bundle serahan — Archivo, sudut 0px,
garis 2px, satu aksen merah `#ec3013` atas ground `#f3f2f2`, label rata kiri.
`assets/css/modernist.css` ialah salinan `styles.css` sistem tersebut, dengan
satu perubahan sahaja: fon Archivo di-hos sendiri dan bukan diimport dari
Google Fonts, supaya app tetap betul rupanya tanpa talian. Warna, fon dan
radius dalam `app.css` semuanya diambil dari token sistem itu.

Prototaip asal dan transkrip perbualan reka bentuk ada dalam `design/`.

## Ikon

```sh
pip install Pillow && python3 tools/make-icons.py
```

## Lesen pihak ketiga

- [Leaflet](https://leafletjs.com) 1.9.4 — BSD-2-Clause (`vendor/leaflet/LICENSE`)
- [Archivo](https://fonts.google.com/specimen/Archivo) — SIL OFL 1.1 (`vendor/fonts/LICENSE`)
- Tile: © OpenStreetMap contributors · © OpenTopoMap (CC-BY-SA) · Imagery © Esri,
  Maxar, Earthstar Geographics. Patuhi
  [dasar penggunaan tile OSM](https://operations.osmfoundation.org/policies/tiles/)
  — jangan muat turun kawasan besar secara pukal.
