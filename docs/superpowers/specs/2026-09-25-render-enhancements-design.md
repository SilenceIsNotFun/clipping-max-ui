# ContentRewardFarm — Sub-proyek 3: Render Enhancements

## Tujuan

Meningkatkan kualitas output render `video-worker` dengan tiga peningkatan yang terinspirasi dari riset terhadap proyek open-source `cheat-clip-pro`: caption karaoke bergaya word-highlight (menggantikan SRT polos), title text yang di-render sebagai gambar (menggantikan `drawtext` yang rawan bug escaping), dan saran crop otomatis berbasis deteksi wajah/saliency (membantu operator menentukan area crop, bukan menggantikan keputusannya).

Sub-proyek ini murni memperkaya render pipeline `video-worker` (dan sedikit `api`/`web-ui` untuk menyimpan & menampilkan saran crop) — tidak menambah service baru, tidak mengubah arsitektur upload/segmen/render yang sudah ada di Sub-proyek 2.

## Ruang Lingkup Sub-proyek 3

### Termasuk
- Caption dirender sebagai file ASS (Advanced SubStation Alpha) dengan highlight warna per-kata yang aktif diucapkan (karaoke-style), menggantikan SRT.
- 2-3 preset warna caption yang bisa dipilih operator per segmen (`default`, `energetic`, `warning` atau serupa).
- Title text dirender sebagai PNG transparan via Pillow lalu di-composite dengan `overlay` filter, menggantikan `drawtext`.
- Saran crop otomatis (deteksi wajah via YuNet + fallback Haar cascade, fallback lagi ke saliency+motion detection kalau tidak ada wajah) yang berjalan otomatis saat footage diupload, hasilnya disimpan dan ditampilkan sebagai pre-fill di UI crop canvas.
- Operator tetap bisa mengabaikan/mengubah saran crop secara manual — saran bersifat advisory, bukan otomatis penuh.

### Tidak termasuk
- Real-time face tracking per-frame (crop tetap statis per segmen, sama seperti arsitektur Sub-proyek 2).
- Integrasi heatmap YouTube atau data engagement eksternal apa pun (tidak relevan untuk footage upload manual).
- LLM-based clip/moment suggestion (dicatat sebagai ide follow-up terpisah, di luar scope sub-proyek ini).
- Emoji rendering pada title text (PNG rendering dasar dulu; dukungan emoji berwarna didefer).
- Kustomisasi penuh warna/font caption oleh operator (cukup 2-3 preset hardcoded untuk MVP).

## Arsitektur

### Perubahan pada `video-worker`
- Modul baru `face_crop.py`: `detect_crop_suggestion(video_path: str) -> CropSuggestion | None` — sample ~25 frame merata di sepanjang video, jalankan YuNet ONNX face detector, fallback ke ensemble Haar cascade OpenCV bawaan kalau YuNet tidak menemukan apa pun, cluster deteksi antar-frame berdasarkan jarak spasial, filter cluster yang cuma muncul sekali/confidence rendah, skor cluster yang tersisa (jumlah × akar-lebar × confidence × bias-ke-tengah), pilih pemenang. Kalau tidak ada wajah terdeteksi sama sekali, fallback ke `detect_saliency_crop` (OpenCV `StaticSaliencySpectralResidual` + motion centroid dari `absdiff`/`cv2.moments`, weighted-average antar frame sampel).
- Modul baru `title_render.py`: `render_title_png(title_text: str, output_path: str, ...) -> None` — pakai Pillow untuk menggambar title text (dengan shadow+stroke, smart line-wrapping) ke kanvas transparan 1080×1920, simpan sebagai PNG.
- `render.py` dimodifikasi: `_write_srt` diganti `_write_ass` (menerima `caption_style` sebagai parameter, generate `Dialogue` event per kata aktif dengan override tag warna `\c`); title handling diubah dari memanggil `build_segment_filter` dengan `title_text` string ke: render PNG dulu (kalau `title_text` ada), lalu pass path PNG ke `layout.py` untuk di-overlay sebagai input ffmpeg tambahan.
- `layout.py` dimodifikasi: `_title_filter` (drawtext-based) dihapus, `build_segment_filter` menerima `title_overlay_path: str | None` sebagai pengganti `title_text: str | None` di `SegmentInput`, menghasilkan filter graph yang mereferensikan input PNG tambahan via `overlay=0:0`.
- `main.py`'s `/analyze` route dimodifikasi: setelah `detect_audio_peaks`/`detect_scene_changes`, panggil juga `detect_crop_suggestion`, sertakan hasilnya (atau `null` kalau gagal) di payload callback sebagai field baru `crop_suggestion`.
- Dependency baru di `requirements.txt`: `opencv-python-headless`. Model YuNet (`face_detection_yunet.onnx`, ~230KB, lisensi MIT dari OpenCV Zoo) di-vendor langsung ke repo (`apps/video-worker/models/face_detection_yunet.onnx`), bukan di-download saat build — menghindari titik gagal network tambahan.

### Perubahan pada `api`
- Tabel baru `crop_suggestions` (lihat Data Model).
- `segment_assignments` dapat kolom baru `caption_style` (nullable, default `"default"`).
- Endpoint baru `GET /api/campaigns/:id/assets/:assetId/crop-suggestion` — mengembalikan baris `crop_suggestions` untuk asset tersebut (atau 404 kalau belum ada/gagal dideteksi).
- Internal callback `POST /api/internal/assets/:assetId/analysis-complete` (sudah ada dari Sub-proyek 2) diperluas: kalau payload menyertakan `crop_suggestion` yang tidak null, insert ke tabel `crop_suggestions`.
- `PUT /api/campaigns/:id/segments` menerima field opsional `caption_style` per segmen (default `"default"` kalau tidak diisi, tidak perlu validasi ketat karena hanya memengaruhi tampilan visual, bukan korektnes render).
- `POST /api/campaigns/:id/render` meneruskan `caption_style` per segmen ke payload `submitRender` yang dikirim ke `video-worker`.

### Perubahan pada `web-ui`
- `SegmentEditor.tsx`: saat asset footage dipilih untuk sebuah segmen, fetch `GET .../crop-suggestion`; kalau ada dan template butuh crop, pre-fill `CropCanvas` dengan rect yang disarankan (operator tetap bisa drag ubah seperti biasa). Tambah dropdown pemilihan `caption_style` (2-3 preset) di form segmen.
- `apiClient.ts`: tambah tipe `CropSuggestion`, fungsi `getCropSuggestion(campaignId, assetId)`, dan field `caption_style` di `SegmentDraft`.

## Alur Data

1. Operator upload footage → `api` insert `video_assets` (status `pending`) → panggil `video-worker` `/analyze`.
2. `video-worker` jalankan `detect_audio_peaks`, `detect_scene_changes` (sudah ada), dan `detect_crop_suggestion` (baru) secara berurutan dalam satu background task, lalu POST hasil gabungan ke callback.
3. `api` simpan `moment_candidates` (sudah ada) dan `crop_suggestions` (baru, kalau ada) dari payload callback yang sama, set `video_assets.analysis_status = done`.
4. Operator buka halaman assign segmen: `TimelineScrubber` menampilkan marker momen (sudah ada), `CropCanvas` pre-fill dari `crop_suggestions` kalau tersedia dan template butuh crop, operator pilih `caption_style` dari dropdown.
5. Submit segmen → `PUT /segments` menyimpan `caption_style` bersama field lain yang sudah ada.
6. Submit render → `api` kirim `caption_style` per segmen ke `video-worker` `/render`.
7. `video-worker`'s `render_video`: untuk tiap segmen, kalau ada `title_text`, render PNG title dulu; bangun filter layout (crop/split/letterbox) + overlay title PNG (kalau ada) via `build_segment_filter`; setelah semua segmen di-render dan caption words terkumpul (dengan offset dari durasi TTS, sudah diperbaiki di fix wave Sub-proyek 2), generate file `.ass` (bukan `.srt`) dari `caption_style` segmen pertama (asumsi MVP: satu style untuk seluruh video, bukan per-segmen — lihat Catatan Implementasi) dan burn-in via `subtitles=` filter (filter yang sama, cuma format file beda).

## Data Model (SQLite — tabel baru & kolom tambahan)

### Tabel `crop_suggestions`
- `id` — primary key
- `video_asset_id` — foreign key ke `video_assets`
- `crop_gameplay_rect` — JSON `{x, y, width, height}` koordinat relatif 0.0–1.0, nullable
- `crop_facecam_rect` — JSON `{x, y, width, height}`, nullable (kalau terdeteksi 2 speaker/wajah berdampingan)
- `detection_method` — `face` atau `saliency`
- `confidence` — skor 0.0–1.0
- `created_at`

### `segment_assignments` (kolom tambahan)
- `caption_style` — TEXT, nullable, default `"default"`

## API & Komponen (ringkasan endpoint baru/berubah)

- `GET /api/campaigns/:id/assets/:assetId/crop-suggestion` — baru, baca `crop_suggestions`.
- `POST /api/internal/assets/:assetId/analysis-complete` — diperluas, insert `crop_suggestions` kalau payload menyertakannya.
- `PUT /api/campaigns/:id/segments` — request body per segmen dapat field opsional `caption_style`.
- `POST /api/campaigns/:id/render` — payload ke `video-worker` per segmen dapat field `caption_style`.
- `video-worker` `POST /analyze` — payload callback dapat field `crop_suggestion` (objek atau `null`).
- `video-worker` `POST /render` — payload per segmen dapat field `caption_style`.

## Caption Style Presets

Tiga preset warna ASS (format `&HAABBGGRR`), dipilih dari string preset name:
- `default` — teks putih, highlight kuning saat kata aktif.
- `energetic` — teks putih dengan outline tebal, highlight merah-oranye.
- `warning` — teks kuning pucat, highlight merah terang.

Setiap preset mendefinisikan: warna teks utama, warna outline, warna highlight kata aktif. Detail nilai hex persis ditentukan saat implementasi (bukan bagian keputusan desain).

## Error Handling

- `detect_crop_suggestion` gagal (video corrupt, tidak ada frame terbaca, OpenCV exception apa pun) → `crop_suggestion` di payload callback adalah `null`; tidak menggagalkan `moment_candidates` yang lain, `video_assets.analysis_status` tetap `done` (bukan `failed`) selama audio-peak/scene-change tetap berhasil.
- Generate ASS atau title PNG gagal saat render → job `render_jobs` diberi status `failed` dengan `error_message` yang jelas (konsisten dengan pola error-handling `/render` yang sudah ada di Sub-proyek 2 — seluruh `render_video` dibungkus try/except di level route).
- Model YuNet tidak ditemukan/gagal dimuat saat startup `video-worker` → `detect_crop_suggestion` langsung fallback ke saliency-only (tidak fatal, hanya mengurangi akurasi deteksi wajah).

## Testing

### Unit
- `face_crop.py`: test logic clustering, scoring, dan saliency-fallback dengan mocked detector output (bounding box hasil YuNet/Haar di-mock, karena footage asli dengan wajah sulit disediakan sebagai fixture kecil yang stabil). Satu integration test ringan memverifikasi jalur saliency-fallback benar-benar tereksekusi terhadap fixture video sederhana yang tidak punya wajah (fixture yang sudah ada dari Sub-proyek 2 cocok untuk ini).
- ASS generation (`_write_ass` di `render.py` atau modul terpisah): test murni string/file-content, verifikasi jumlah `Dialogue` event, format timestamp, dan tag warna `\c` untuk kata aktif sesuai `caption_style` yang dipilih — pola sama seperti `test_layout.py` yang sudah ada.
- `title_render.py`: test bahwa PNG dihasilkan dengan dimensi 1080×1920, mode RGBA, dan tidak kosong (ada piksel non-transparan) ketika `title_text` diisi.
- `layout.py`: test `build_segment_filter` dengan `title_overlay_path` diisi vs `None`, verifikasi filter graph mereferensikan input tambahan hanya ketika ada overlay.

### Integration
- `api`: test `PUT /segments` menyimpan `caption_style`; test `GET /crop-suggestion` mengembalikan data yang benar setelah `analysis-complete` callback menyertakan `crop_suggestion`; test callback tanpa `crop_suggestion` (null) tidak membuat baris `crop_suggestions`.
- `video-worker`: test `/render` end-to-end (mocked TTS/alignment seperti pola Sub-proyek 2) menghasilkan file `.ass` alih-alih `.srt`, dan ketika salah satu segmen punya `title_text`, ffmpeg command yang dibangun menyertakan input PNG tambahan.

## Deployment

### Dependency & Assets
- `apps/video-worker/requirements.txt` tambah `opencv-python-headless`.
- `apps/video-worker/models/face_detection_yunet.onnx` — file model di-commit langsung ke repo (bukan didownload saat build).
- `apps/video-worker/Dockerfile` — tidak perlu perubahan signifikan (model sudah ikut ter-`COPY . .`), pastikan `opencv-python-headless` terinstall via `pip install -r requirements.txt` yang sudah ada.

### Environment
- Tidak ada environment variable baru yang diperlukan.

## Sukses MVP

- Video hasil render punya caption karaoke (kata aktif ter-highlight warna) alih-alih caption statis SRT.
- Title text tampil dengan rendering yang bersih (termasuk karakter spesial seperti apostrof) tanpa risiko ffmpeg filter-graph error.
- Operator melihat kotak crop yang sudah pre-fill (saran) saat memilih template yang butuh crop, dan tetap bebas mengubahnya.
- Semua fitur di atas terintegrasi tanpa mengubah alur upload/assign/render/finalize yang sudah ada dari Sub-proyek 2.

## Catatan Implementasi

- MVP mengasumsikan satu `caption_style` berlaku untuk keseluruhan video (diambil dari segmen pertama), bukan per-segmen — meskipun kolom `caption_style` disimpan per `segment_assignments` untuk fleksibilitas UI (operator pilih per segmen di form, tapi backend render cukup pakai nilai dari segmen dengan `order_index` terkecil). Mendukung ganti-style di tengah video didefer ke iterasi berikutnya kalau dibutuhkan — ini pilihan YAGNI, bukan keterbatasan teknis fundamental.
- Auto-crop suggestion tidak pernah mengubah `segment_assignments` secara langsung — ia hanya baris terpisah (`crop_suggestions`) yang dibaca UI untuk pre-fill form. Operator tetap harus submit form segmen seperti biasa agar prinsip "operator adalah keputusan akhir" (konsisten dengan constraint global Sub-proyek 2 soal tidak ada auto-trim) tetap terjaga untuk crop juga.
- Dual-speaker/dua-wajah berdampingan (mis. format interview) terdeteksi oleh `detect_crop_suggestion` dan diisi ke `crop_facecam_rect` selain `crop_gameplay_rect` — berguna khusus untuk `layout_template = gameplay_facecam_split` dengan sumber tunggal; untuk template lain field kedua ini diabaikan oleh UI.
