# ContentRewardFarm — Sub-proyek 2: Video Content Generation

## Tujuan

Mengubah `content_plan` (hasil Sub-proyek 1: BRD Ingest & Planner) menjadi video final yang siap diunggah operator, dengan cara merangkai footage yang diupload manual, menambahkan voiceover TTS, caption tersinkron, dan musik latar — tanpa auto-download source dan tanpa auto-scene-detection.

Sub-proyek ini berdiri sendiri: input kontraknya hanya `content_plan` (dan `campaign_id` terkait) dari Sub-proyek 1, jadi bisa dibangun dan ditest independen selama fixture `content_plan` tersedia.

## Ruang Lingkup Sub-proyek 2

### Termasuk
- Upload footage (video) dan musik latar per campaign melalui web UI.
- Assign manual: operator memetakan tiap segmen `content_plan` (hook, body, CTA, dst.) ke file footage yang diupload, dengan trim start/end dipilih lewat timeline scrubber visual.
- Saran momen otomatis (audio-peak & scene-change detection) sebagai marker di timeline, murni sebagai bantuan visual — trim akhir tetap keputusan operator.
- Layout template per segmen: `standard`, `gameplay_facecam_split`, `gameplay_full_focus`, `cinematic_letterbox`, dengan crop area digambar manual di preview untuk template yang butuh crop.
- Title text overlay opsional per segmen (independen dari layout template), untuk teks momen seperti "MOMENT CLUTCH TENZ".
- Generate voiceover otomatis dari script/hook memakai TTS lokal.
- Forced-alignment word-level dari audio TTS untuk caption yang tersinkron per kata.
- Render video: cut/concat footage sesuai assignment & layout template, burn-in caption tersinkron dan title text, mux voiceover dan musik latar.
- Preview hasil render sebagai draft, dengan opsi ganti voice TTS atau musik lalu render ulang.
- Finalize: menandai satu hasil render sebagai versi final campaign.
- Menjalankan semuanya dalam Docker Compose (service baru `video-worker`), tetap kompatibel dengan profile GPU RTX 4060 yang sudah ada.

### Tidak termasuk
- Auto-download footage dari link publik (tetap upload manual, konsisten dengan Sub-proyek 1).
- Auto-trim/auto-cut penuh dari hasil deteksi momen — deteksi cuma menyarankan marker, operator yang tetap menentukan trim_start/trim_end final.
- Generative AI video (text-to-video) — hanya auto-editing dari footage yang sudah ada.
- Library musik bawaan/berlisensi — musik selalu upload sendiri oleh operator, lisensi jadi tanggung jawab operator.
- Publish/upload otomatis ke platform eksternal (TikTok/Instagram/YouTube) — itu di luar scope, kemungkinan masuk sub-proyek berikutnya.
- Multi-user, role, dan permission (tetap operator tunggal, konsisten dengan Sub-proyek 1).
- Template layout custom buatan operator sendiri — MVP cuma menyediakan 4 template built-in di atas.

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
3. `video-worker` otomatis menganalisis tiap footage yang baru diupload di background (audio-peak & scene-change detection), menyimpan hasilnya sebagai `moment_candidates` dan meng-update `video_assets.analysis_status` jadi `done`.
4. Operator membuka halaman assign segmen: melihat daftar segmen dari `content_plan` (mis. `hook`, `body`, `cta`), memilih asset per segmen, scrub timeline (dengan marker `moment_candidates` sebagai bantuan) untuk menentukan `trim_start`/`trim_end`/`order_index`, memilih `layout_template`, menggambar crop area jika template butuh crop, dan mengisi `title_text` opsional.
5. Operator submit render: `api` memvalidasi semua segmen terisi, membuat baris `render_jobs` berstatus `queued`, memanggil `video-worker` `POST /render` secara async (tidak menunggu response selesai), dan langsung mengembalikan `job_id`.
6. `video-worker` memproses job: generate TTS dari script/hook tiap segmen, forced-align audio ke `caption_words`, cut/trim/crop footage sesuai assignment dan `layout_template`, burn-in caption tersinkron dan `title_text`, mux voiceover dan musik latar, tulis MP4 ke `output_path`, lalu update status job jadi `ready_for_preview` (atau `failed` dengan `error_message`).
7. `web-ui` polling `GET /api/campaigns/:id/render/:jobId` sampai status berubah, lalu menampilkan video player untuk preview.
8. Operator bisa memilih voice TTS lain atau musik lain dan submit ulang (job baru, `render_jobs` baru untuk campaign yang sama) sampai puas.
9. Operator menekan "Finalize" pada satu `render_jobs` yang diinginkan — status job itu jadi `final`; job lain untuk campaign yang sama tetap tersimpan sebagai riwayat draft.

## Data Model (SQLite — tabel baru)

### Tabel `video_assets`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `file_path` — path file di `video-assets/`
- `asset_type` — `footage` atau `music`
- `duration_seconds` — durasi asset (divalidasi saat upload)
- `analysis_status` — `pending`, `done`, `failed` (status deteksi momen otomatis; hanya relevan untuk `asset_type = footage`)
- `created_at`

### Tabel `moment_candidates`
- `id` — primary key
- `video_asset_id` — foreign key ke `video_assets`
- `timestamp_ms` — posisi momen yang disarankan (ms)
- `score` — skor kepercayaan deteksi (0–1)
- `detection_type` — `audio_peak` atau `scene_change`
- `created_at`

### Tabel `segment_assignments`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `segment_key` — nama segmen dari `content_plan` (mis. `hook`, `body`, `cta`)
- `video_asset_id` — foreign key ke `video_assets` (footage utama, mis. gameplay)
- `secondary_video_asset_id` — foreign key ke `video_assets`, nullable (dipakai kalau gameplay & facecam dua file terpisah)
- `trim_start` — detik mulai potongan
- `trim_end` — detik akhir potongan
- `order_index` — urutan segmen dalam video final
- `layout_template` — `standard`, `gameplay_facecam_split`, `gameplay_full_focus`, atau `cinematic_letterbox`
- `crop_gameplay_rect` — JSON `{x, y, width, height}` koordinat relatif 0.0–1.0, nullable (dipakai `gameplay_facecam_split` dan `gameplay_full_focus` saat sumbernya 1 file nyatu)
- `crop_facecam_rect` — JSON `{x, y, width, height}` koordinat relatif 0.0–1.0, nullable (dipakai `gameplay_facecam_split` saat sumbernya 1 file nyatu)
- `title_text` — teks judul/momen opsional, nullable

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
- `POST /api/campaigns/:id/assets` — upload footage/musik (multipart), validasi bisa dibaca ffprobe dan punya durasi > 0 sebelum disimpan. Untuk `asset_type = footage`, set `analysis_status = pending` dan trigger `video-worker` `POST /analyze` secara async (fire-and-forget).
- `GET /api/campaigns/:id/assets` — list asset campaign (termasuk `analysis_status`).
- `GET /api/campaigns/:id/assets/:assetId/moments` — list `moment_candidates` untuk satu asset, dipakai timeline scrubber menampilkan marker.
- `PUT /api/campaigns/:id/segments` — set/replace seluruh `segment_assignments` campaign (body: array segmen dengan `segment_key`, `video_asset_id`, `secondary_video_asset_id`, `trim_start`, `trim_end`, `order_index`, `layout_template`, `crop_gameplay_rect`, `crop_facecam_rect`, `title_text`).
- `POST /api/campaigns/:id/render` — validasi semua segmen dari `content_plan` sudah ter-assign dan `layout_template` valid (crop rect wajib ada untuk template yang butuh crop), buat `render_jobs` baru berstatus `queued`, panggil `video-worker` `POST /render` tanpa menunggu selesai (fire-and-forget dengan job id sebagai callback reference), balikan `{job_id, status: "queued"}` langsung.
- `GET /api/campaigns/:id/render/:jobId` — status job + `output_path` (jika ada) + `caption_words` (untuk preview) + `error_message` (jika gagal).
- `POST /api/campaigns/:id/render/:jobId/finalize` — set job jadi `final`.

### `video-worker` (Python FastAPI)
- `POST /analyze` — terima `{video_asset_id, file_path, callback_url}`. Jalankan audio-peak & scene-change detection di background task, lalu callback ke `api` (mis. `POST /api/internal/assets/:assetId/analysis-complete`) dengan daftar `moment_candidates` atau error.
- `POST /render` — terima `{job_id, segments: [{segment_key, file_path, secondary_file_path, trim_start, trim_end, order_index, script_text, layout_template, crop_gameplay_rect, crop_facecam_rect, title_text}], tts_voice, music_path, callback_url}`. Memproses secara async di background task FastAPI, lalu memanggil `callback_url` (endpoint internal `api`, mis. `POST /api/internal/render/:jobId/complete`) dengan hasil (`output_path`, `caption_words`, atau `error_message`).
- `GET /health` — healthcheck.

### `api` — endpoint internal (dipanggil `video-worker`, bukan dari UI)
- `POST /api/internal/assets/:assetId/analysis-complete` — terima hasil analisis dari `video-worker`, insert `moment_candidates` dan update `video_assets.analysis_status`.
- `POST /api/internal/render/:jobId/complete` — terima hasil render dari `video-worker`, update `render_jobs` dan insert `caption_words`.

### `web-ui` (Next.js) — halaman baru
- `/campaigns/:id/assets` — upload footage/musik, lihat daftar asset dan status analisis.
- `/campaigns/:id/segments` — assign asset ke tiap segmen `content_plan`; timeline scrubber dengan marker `moment_candidates` untuk set trim; pilih `layout_template`; kanvas gambar crop area untuk template yang butuh crop; isi `title_text` opsional; submit render.
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

## Moment Detection (`video-worker`)

Dijalankan otomatis sekali per footage begitu diupload (`POST /analyze`), sebelum operator sempat assign segmen. Murni advisory — hasilnya cuma marker di timeline, tidak pernah mengubah `trim_start`/`trim_end` secara otomatis.

- **Audio peak detection** — hitung RMS loudness track audio asli footage per sliding window (mis. 1 detik, langkah 0.5 detik) pakai `ffmpeg astats`/`volumedetect` atau `pydub`. Window dengan RMS di atas ambang batas (mis. top 15% dari distribusi RMS footage tersebut) jadi kandidat `audio_peak`, `score` dinormalisasi dari RMS relatif.
- **Scene change detection** — jalankan ffmpeg scene-detection filter (`select='gt(scene,0.4)'`) untuk menandai timestamp perubahan adegan/cut mendadak sebagai kandidat `scene_change`, `score` diambil dari nilai scene-score ffmpeg.
- Kedua daftar kandidat digabung, durasi analisis sebanding dengan panjang footage (bukan real-time, tapi tetap CPU-only dan ringan — tidak butuh GPU).
- Gagal dianalisis (footage corrupt/tidak terbaca) → `video_assets.analysis_status = failed`; timeline scrubber tetap bisa dipakai tanpa marker, operator trim manual seperti biasa.

## Layout Templates (`video-worker`)

Dipilih operator per segmen di `segment_assignments.layout_template`. Semua template merender ke kanvas output 1080x1920 (9:16).

- **`standard`** — footage `video_asset_id` di-trim sesuai `trim_start`/`trim_end`, di-scale-crop supaya penuh mengisi kanvas 9:16 (behavior default, sama seperti versi awal spec ini).
- **`gameplay_facecam_split`** — kanvas dibagi dua horizontal (atas 60%, bawah 40%):
  - Jika `secondary_video_asset_id` kosong (facecam nyatu dalam 1 file): crop `crop_gameplay_rect` dari `video_asset_id` ditempatkan di area atas, crop `crop_facecam_rect` dari `video_asset_id` yang sama ditempatkan di area bawah.
  - Jika `secondary_video_asset_id` terisi (2 file terpisah): `video_asset_id` (gameplay) ditempatkan di area atas apa adanya (di-scale-crop), `secondary_video_asset_id` (facecam) ditempatkan di area bawah apa adanya.
- **`gameplay_full_focus`** — crop `crop_gameplay_rect` dari `video_asset_id` (buang bagian facecam), hasil crop di-scale mengisi penuh kanvas 9:16. Kalau footage berasal dari `secondary_video_asset_id` terpisah, `crop_gameplay_rect` diabaikan dan `video_asset_id` langsung di-scale-crop penuh (karena sudah bersih tanpa facecam).
- **`cinematic_letterbox`** — footage `video_asset_id` di-scale supaya lebar penuh kanvas dengan rasio asli terjaga (letterbox), sisa ruang atas-bawah diisi bar hitam.
- Validasi di `api` sebelum submit render: `gameplay_facecam_split` dan `gameplay_full_focus` wajib punya `crop_gameplay_rect` terisi jika `secondary_video_asset_id` kosong; `gameplay_facecam_split` juga wajib punya `crop_facecam_rect` dalam kondisi yang sama.

### Title Text Overlay
- Field `title_text` independen dari `layout_template` — bisa diisi di segmen dengan template apa pun.
- Kalau terisi, dirender sebagai teks statis (bukan sinkron kata-per-kata seperti caption) di area atas kanvas, font besar/bold, tampil sepanjang durasi segmen tersebut.
- Kalau kosong, tidak ada elemen title text dirender untuk segmen itu.

## Render Pipeline (`video-worker`)

1. Untuk tiap segmen (urut `order_index`): generate TTS dari `script_text` → forced-align → dapat durasi aktual segmen dari panjang audio.
2. Trim footage segmen sesuai `trim_start`/`trim_end`; jika durasi footage lebih pendek dari audio, loop footage; jika lebih panjang, potong sesuai durasi audio.
3. Terapkan `layout_template` segmen (crop/split/letterbox sesuai aturan di atas) untuk menghasilkan frame 9:16 per segmen; burn-in `title_text` segmen jika terisi.
4. Concat semua segmen video yang sudah diberi layout jadi satu video utuh (ffmpeg concat).
5. Concat semua audio TTS per segmen jadi satu voiceover track utuh, selaras dengan urutan video.
6. Burn-in caption per kata dari gabungan `caption_words` semua segmen (offset waktu disesuaikan posisi segmen dalam video gabungan).
7. Mux voiceover + musik latar (jika ada) + video jadi satu file MP4 output, resolusi vertikal 1080x1920 (9:16).
8. Simpan `output_path`, kirim hasil ke `api` lewat `callback_url`.

## Error Handling

- Asset gagal diupload/dibaca ffprobe → `api` reject upload dengan pesan jelas, tidak masuk `video_assets`.
- Analisis momen gagal (footage corrupt saat dianalisis lebih dalam dari validasi awal) → `video_assets.analysis_status = failed`, timeline scrubber tetap jalan tanpa marker, tidak menghalangi assignment/render.
- Segmen belum lengkap ter-assign saat submit render → `api` balas 400 dengan daftar `segment_key` yang kosong.
- Crop rect wajib tapi kosong untuk `layout_template` yang butuh crop → `api` balas 400 dengan daftar `segment_key` yang crop-nya belum digambar.
- TTS/forced-alignment/ffmpeg gagal di `video-worker` → job `failed` dengan `error_message` spesifik tahap mana yang gagal (termasuk tahap layout/crop); operator bisa submit render baru tanpa upload ulang asset.
- `video-worker` down saat `api` submit render → `api` set job `failed` dengan pesan "video-worker unreachable", retry manual dari UI.
- Musik lebih pendek dari total durasi video → musik di-loop; lebih panjang → musik dipotong sesuai durasi video.

## Testing

### Unit
- ffmpeg command builder (trim, concat, burn-in, mux, crop/split/letterbox per `layout_template`) — verifikasi command yang dihasilkan, bukan menjalankan ffmpeg beneran di setiap test.
- Forced-alignment output parser (whisper word timestamps → `caption_words`).
- Segment validator di `api` (deteksi segmen kosong dari `content_plan` vs `segment_assignments`, dan crop rect kosong untuk template yang butuh crop).
- Moment detection scorer (RMS window → kandidat `audio_peak`, scene-score → kandidat `scene_change`) — pakai fixture audio/video pendek dengan puncak yang sudah diketahui posisinya.

### Integration
- Upload footage + musik → tunggu `analysis_status = done` → assign segmen (termasuk `layout_template` dan crop rect) → submit render → poll sampai `ready_for_preview` → cek `output_path` adalah MP4 valid, memakai footage pendek asli (1-2 detik) sebagai fixture supaya cepat.
- Render dengan `gameplay_facecam_split` dari 1 file nyatu → cek command ffmpeg memuat dua crop filter berbeda.
- Render dengan `gameplay_facecam_split` dari 2 file terpisah (`secondary_video_asset_id` terisi) → cek kedua source dipakai tanpa crop filter.
- Render gagal (paksa ffmpeg gagal dengan asset korup) → job `failed` dengan `error_message` terisi.
- Re-render dengan voice berbeda → job baru terbentuk, job lama tetap ada sebagai riwayat.
- Finalize → status job berubah jadi `final`, job lain tetap `ready_for_preview`.

### Fixtures
- Footage pendek (1-2 detik, beberapa file) untuk tiap segmen, termasuk satu file simulasi "facecam nyatu" (frame dengan dua area warna berbeda supaya crop gampang diverifikasi).
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

- Operator bisa upload footage + musik, lihat saran momen otomatis di timeline, assign ke segmen `content_plan` lewat scrubber visual.
- Operator bisa pilih layout template per segmen (`standard`, `gameplay_facecam_split`, `gameplay_full_focus`, `cinematic_letterbox`) dan gambar crop area manual saat dibutuhkan.
- Operator bisa isi title text opsional per segmen.
- Render menghasilkan MP4 dengan layout sesuai template, title text, voiceover TTS, caption tersinkron kata-per-kata, dan musik latar.
- Operator bisa preview, ganti voice/musik, render ulang tanpa upload ulang asset.
- Operator bisa finalize satu hasil render sebagai versi final campaign.
- Semua jalan di Docker Compose lokal, service `video-worker` terpisah dari `ai-worker`.

## Catatan Implementasi

- Fokus MVP: satu resolusi output (vertikal 1080x1920), satu gaya caption (kata-per-kata, font/warna default) dan satu gaya title text (font/warna default), tanpa kustomisasi visual lanjutan — styling lebih detail bisa jadi iterasi berikutnya.
- Moment detection murni heuristik ringan (RMS audio + scene-change ffmpeg), bukan model ML berat — cukup untuk MVP, bisa ditingkatkan nanti kalau akurasinya kurang memadai.
- 4 layout template built-in cukup untuk MVP; template custom/tambahan didefer ke iterasi berikutnya kalau operator butuh gaya lain di luar gaming split-screen, full-focus, dan cinematic letterbox.
- Publish/upload ke platform eksternal tetap manual oleh operator, konsisten dengan constraint global "tidak ada integrasi platform eksternal".
- Fitur "nambah BRD baru sambil ada campaign lain jalan" sudah otomatis terpenuhi oleh desain Sub-proyek 1 (tiap campaign row independen, dashboard menampilkan semua campaign dengan form upload di halaman yang sama) — tidak perlu sub-proyek terpisah untuk ini.
- Sub-proyek 3 lain (di luar poin di atas) belum ditentukan — akan dibrainstorm terpisah kalau ada kebutuhan baru.
