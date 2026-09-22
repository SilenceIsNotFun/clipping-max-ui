# ContentRewardFarm — Sub-proyek 2: Video Content Generation

## Tujuan

Mengubah `content_plan` (hasil Sub-proyek 1: BRD Ingest & Planner) menjadi video final yang siap diunggah operator, dengan cara merangkai footage yang diupload manual, menambahkan voiceover TTS, caption tersinkron, dan musik latar — tanpa auto-download source dan tanpa auto-scene-detection.

Sub-proyek ini berdiri sendiri: input kontraknya hanya `content_plan` (dan `campaign_id` terkait) dari Sub-proyek 1, jadi bisa dibangun dan ditest independen selama fixture `content_plan` tersedia.

## Ruang Lingkup Sub-proyek 2

### Termasuk
- Upload footage (video) dan musik latar per campaign melalui web UI.
- Assign manual: operator memetakan tiap segmen `content_plan` (hook, body, CTA, dst.) ke file footage yang diupload, dengan trim start/end.
- Generate voiceover otomatis dari script/hook memakai TTS lokal.
- Forced-alignment word-level dari audio TTS untuk caption yang tersinkron per kata.
- Render video: cut/concat footage sesuai assignment, burn-in caption tersinkron, mux voiceover dan musik latar.
- Preview hasil render sebagai draft, dengan opsi ganti voice TTS atau musik lalu render ulang.
- Finalize: menandai satu hasil render sebagai versi final campaign.
- Menjalankan semuanya dalam Docker Compose (service baru `video-worker`), tetap kompatibel dengan profile GPU RTX 4060 yang sudah ada.

### Tidak termasuk
- Auto-download footage dari link publik (tetap upload manual, konsisten dengan Sub-proyek 1).
- Auto-scene-detection atau pemilihan otomatis potongan footage — assignment segmen selalu manual oleh operator.
- Generative AI video (text-to-video) — hanya auto-editing dari footage yang sudah ada.
- Library musik bawaan/berlisensi — musik selalu upload sendiri oleh operator, lisensi jadi tanggung jawab operator.
- Publish/upload otomatis ke platform eksternal (TikTok/Instagram/YouTube) — itu di luar scope, kemungkinan masuk sub-proyek berikutnya.
- Multi-user, role, dan permission (tetap operator tunggal, konsisten dengan Sub-proyek 1).

## Arsitektur

### Stack & Services (tambahan dari Sub-proyek 1)
- `video-worker` — Python FastAPI baru, menangani rendering: ffmpeg untuk cut/concat/burn-in/mux, Piper untuk TTS lokal, faster-whisper untuk forced-alignment word-level.
- `api` (existing, diperluas) — endpoint baru untuk upload asset, assignment segmen, submit render job, polling status, dan finalize.
- `web-ui` (existing, diperluas) — halaman assign segmen, halaman preview + re-render.
- `db` — SQLite yang sama dengan Sub-proyek 1, tabel baru ditambahkan.

`video-worker` dipisah dari `ai-worker` karena dependency-nya berbeda sifat (ffmpeg, model TTS, whisper — berat dan butuh waktu render menit-an) dibanding OCR/LLM-planning yang sudah sinkron dan cepat di `ai-worker`. Memisahkan service menjaga masing-masing tetap fokus dan bisa di-restart/scale independen.

### Struktur Direktori (tambahan)
- `apps/video-worker` — service render FastAPI.
- `video-assets` — volume Docker untuk footage, musik, dan output MP4.

## Alur Data

1. Operator upload footage dan/atau musik dari UI campaign yang sudah punya `content_plan` (status `planned`).
2. `api` menyimpan file ke `video-assets/` dan mencatat `video_assets`.
3. Operator membuka halaman assign segmen: melihat daftar segmen dari `content_plan` (mis. `hook`, `body`, `cta`), memilih asset per segmen, mengatur `trim_start`/`trim_end`/`order_index`.
4. Operator submit render: `api` memvalidasi semua segmen terisi, membuat baris `render_jobs` berstatus `queued`, memanggil `video-worker` `POST /render` secara async (tidak menunggu response selesai), dan langsung mengembalikan `job_id`.
5. `video-worker` memproses job: generate TTS dari script/hook tiap segmen, forced-align audio ke `caption_words`, cut/trim footage sesuai assignment, burn-in caption tersinkron, mux voiceover dan musik latar, tulis MP4 ke `output_path`, lalu update status job jadi `ready_for_preview` (atau `failed` dengan `error_message`).
6. `web-ui` polling `GET /api/campaigns/:id/render/:jobId` sampai status berubah, lalu menampilkan video player untuk preview.
7. Operator bisa memilih voice TTS lain atau musik lain dan submit ulang (job baru, `render_jobs` baru untuk campaign yang sama) sampai puas.
8. Operator menekan "Finalize" pada satu `render_jobs` yang diinginkan — status job itu jadi `final`; job lain untuk campaign yang sama tetap tersimpan sebagai riwayat draft.

## Data Model (SQLite — tabel baru)

### Tabel `video_assets`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `file_path` — path file di `video-assets/`
- `asset_type` — `footage` atau `music`
- `duration_seconds` — durasi asset (divalidasi saat upload)
- `created_at`

### Tabel `segment_assignments`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `segment_key` — nama segmen dari `content_plan` (mis. `hook`, `body`, `cta`)
- `video_asset_id` — foreign key ke `video_assets`
- `trim_start` — detik mulai potongan
- `trim_end` — detik akhir potongan
- `order_index` — urutan segmen dalam video final

### Tabel `render_jobs`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `status` — `queued`, `rendering`, `ready_for_preview`, `final`, `failed`
- `tts_voice` — nama voice Piper yang dipakai
- `music_asset_id` — foreign key ke `video_assets` (nullable, boleh tanpa musik)
- `output_path` — path MP4 hasil render
- `error_message` — pesan error jika `failed`
- `created_at`, `updated_at`

### Tabel `caption_words`
- `id` — primary key
- `render_job_id` — foreign key ke `render_jobs`
- `word` — teks kata
- `start_ms` — waktu mulai (ms) dari hasil forced-alignment
- `end_ms` — waktu akhir (ms)

## API & Komponen

### `api` (Node.js) — endpoint baru
- `POST /api/campaigns/:id/assets` — upload footage/musik (multipart), validasi bisa dibaca ffprobe dan punya durasi > 0 sebelum disimpan.
- `GET /api/campaigns/:id/assets` — list asset campaign.
- `PUT /api/campaigns/:id/segments` — set/replace seluruh `segment_assignments` campaign (body: array segmen dengan `segment_key`, `video_asset_id`, `trim_start`, `trim_end`, `order_index`).
- `POST /api/campaigns/:id/render` — validasi semua segmen dari `content_plan` sudah ter-assign, buat `render_jobs` baru berstatus `queued`, panggil `video-worker` `POST /render` tanpa menunggu selesai (fire-and-forget dengan job id sebagai callback reference), balikan `{job_id, status: "queued"}` langsung.
- `GET /api/campaigns/:id/render/:jobId` — status job + `output_path` (jika ada) + `caption_words` (untuk preview) + `error_message` (jika gagal).
- `POST /api/campaigns/:id/render/:jobId/finalize` — set job jadi `final`.

### `video-worker` (Python FastAPI)
- `POST /render` — terima `{job_id, segments: [{segment_key, file_path, trim_start, trim_end, order_index, script_text}], tts_voice, music_path, callback_url}`. Memproses secara async di background task FastAPI, lalu memanggil `callback_url` (endpoint internal `api`, mis. `POST /api/internal/render/:jobId/complete`) dengan hasil (`output_path`, `caption_words`, atau `error_message`).
- `GET /health` — healthcheck.

### `api` — endpoint internal (dipanggil `video-worker`, bukan dari UI)
- `POST /api/internal/render/:jobId/complete` — terima hasil render dari `video-worker`, update `render_jobs` dan insert `caption_words`.

### `web-ui` (Next.js) — halaman baru
- `/campaigns/:id/assets` — upload footage/musik, lihat daftar asset.
- `/campaigns/:id/segments` — assign asset ke tiap segmen `content_plan`, atur trim, submit render.
- `/campaigns/:id/preview/:jobId` — video player, tombol "Render ulang dengan voice/musik lain", tombol "Finalize".

## Voiceover & Caption

### TTS
- Engine: Piper (lokal, ringan, cocok CPU maupun GPU RTX 4060).
- Voice dipilih operator dari daftar voice Piper yang tersedia di `video-worker` (hardcode daftar kecil untuk MVP, mis. 2-3 voice Bahasa Indonesia/Inggris).
- Satu file audio TTS di-generate per segmen dari `script_text` segmen tersebut (`content_plan` sudah punya field script per segmen dari Sub-proyek 1).

### Forced Alignment
- Setelah TTS digenerate, audio dijalankan lewat faster-whisper untuk mendapatkan timestamp per kata (`caption_words`).
- Timestamp ini dipakai `video-worker` untuk burn-in caption yang muncul kata-per-kata sinkron dengan audio (gaya auto-subtitle).

### Musik
- Musik latar diupload operator sebagai `video_assets` dengan `asset_type = music`.
- Saat render, volume musik diturunkan (ducking sederhana, level tetap/statis, bukan dinamis) supaya tidak menutupi voiceover.

## Render Pipeline (`video-worker`)

1. Untuk tiap segmen (urut `order_index`): generate TTS dari `script_text` → forced-align → dapat durasi aktual segmen dari panjang audio.
2. Trim footage segmen sesuai `trim_start`/`trim_end`; jika durasi footage lebih pendek dari audio, loop footage; jika lebih panjang, potong sesuai durasi audio.
3. Concat semua segmen footage yang sudah ditrim jadi satu video utuh (ffmpeg concat).
4. Concat semua audio TTS per segmen jadi satu voiceover track utuh, selaras dengan urutan video.
5. Burn-in caption per kata dari gabungan `caption_words` semua segmen (offset waktu disesuaikan posisi segmen dalam video gabungan).
6. Mux voiceover + musik latar (jika ada) + video jadi satu file MP4 output, resolusi vertikal 1080x1920 (9:16), sesuai kebutuhan konten reward campaign vertikal.
7. Simpan `output_path`, kirim hasil ke `api` lewat `callback_url`.

## Error Handling

- Asset gagal diupload/dibaca ffprobe → `api` reject upload dengan pesan jelas, tidak masuk `video_assets`.
- Segmen belum lengkap ter-assign saat submit render → `api` balas 400 dengan daftar `segment_key` yang kosong.
- TTS/forced-alignment/ffmpeg gagal di `video-worker` → job `failed` dengan `error_message` spesifik tahap mana yang gagal; operator bisa submit render baru tanpa upload ulang asset.
- `video-worker` down saat `api` submit render → `api` set job `failed` dengan pesan "video-worker unreachable", retry manual dari UI.
- Musik lebih pendek dari total durasi video → musik di-loop; lebih panjang → musik dipotong sesuai durasi video.

## Testing

### Unit
- ffmpeg command builder (trim, concat, burn-in, mux) — verifikasi command yang dihasilkan, bukan menjalankan ffmpeg beneran di setiap test.
- Forced-alignment output parser (whisper word timestamps → `caption_words`).
- Segment validator di `api` (deteksi segmen kosong dari `content_plan` vs `segment_assignments`).

### Integration
- Upload footage + musik → assign segmen → submit render → poll sampai `ready_for_preview` → cek `output_path` adalah MP4 valid, memakai footage pendek asli (1-2 detik) sebagai fixture supaya cepat.
- Render gagal (paksa ffmpeg gagal dengan asset korup) → job `failed` dengan `error_message` terisi.
- Re-render dengan voice berbeda → job baru terbentuk, job lama tetap ada sebagai riwayat.
- Finalize → status job berubah jadi `final`, job lain tetap `ready_for_preview`.

### Fixtures
- Footage pendek (1-2 detik, beberapa file) untuk tiap segmen.
- File musik pendek.
- `content_plan` contoh dari Sub-proyek 1 dengan 3 segmen (`hook`, `body`, `cta`).

## Deployment

### Docker Compose (tambahan)
- Service baru `video-worker`, image dari `apps/video-worker/Dockerfile` (Python + ffmpeg + Piper + faster-whisper).
- Volume baru `video-assets` — shared antara `api` dan `video-worker` untuk footage, musik, dan output MP4.
- Tetap pakai profile GPU yang sama (`docker-compose.gpu.yml`); faster-whisper otomatis pakai GPU jika tersedia, fallback CPU jika tidak.

### Environment (tambahan)
- `VIDEO_ASSETS_DIR=/app/video-assets`
- `VIDEO_WORKER_URL=http://video-worker:8100` (dipakai `api`)
- `API_INTERNAL_CALLBACK_URL=http://api:4000/api/internal` (dipakai `video-worker` untuk callback)
- `PIPER_VOICES_DIR=/app/voices`

## Sukses MVP

- Operator bisa upload footage + musik, assign ke segmen `content_plan`.
- Render menghasilkan MP4 dengan voiceover TTS, caption tersinkron kata-per-kata, dan musik latar.
- Operator bisa preview, ganti voice/musik, render ulang tanpa upload ulang asset.
- Operator bisa finalize satu hasil render sebagai versi final campaign.
- Semua jalan di Docker Compose lokal, service `video-worker` terpisah dari `ai-worker`.

## Catatan Implementasi

- Fokus MVP: satu resolusi output (vertikal 1080x1920), satu gaya caption (kata-per-kata, font/warna default), tanpa kustomisasi visual lanjutan — styling caption bisa jadi iterasi berikutnya.
- Publish/upload ke platform eksternal tetap manual oleh operator, konsisten dengan constraint global "tidak ada integrasi platform eksternal".
- Sub-proyek 3 (scope belum ditentukan) akan dibrainstorm terpisah setelah sub-proyek ini disetujui.
