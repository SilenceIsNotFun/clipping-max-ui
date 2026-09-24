# ContentRewardFarm — Sub-proyek 1: BRD Ingest & Planner

## Tujuan

Membangun sistem untuk membaca BRD campuran (PDF, DOCX, gambar), merencanakan strategi pengambilan reward dari brief tersebut, dan menyimpan riwayat hasil analisis untuk operator tunggal. Output utama adalah rencana aksi yang bisa dijalankan oleh manusia dan, pada sub-proyek berikutnya, dijadikan input untuk pembuatan konten.

## Ruang Lingkup Sub-proyek 1

### Termasuk
- Upload BRD (PDF, DOCX, gambar) melalui web UI.
- Parsing BRD menjadi teks, metadata, dan link contoh.
- Deteksi source link video yang bisa di-download otomatis atau perlu upload manual.
- Perencanaan strategi berbasis LLM:
  - Ringkasan campaign.
  - Checklist requirement.
  - Content plan (ide, hook, script, asset list, jadwal produksi).
  - Skor peluang reward/prioritas campaign.
- Penyimpanan riwayat campaign ke SQLite.
- Ekspor hasil planner ke PDF.
- Menjalankan semuanya dalam Docker Compose lokal dengan GPU NVIDIA.

### Tidak termasuk
- Auto-download video dari link publik.
- Auto-edit video / clipping.
- Integrasi platform eksternal (TikTok/Instagram/YouTube).
- Multi-user, role, dan permission.
- Notifikasi real-time.

## Arsitektur

### Stack & Services
- `web-ui` — Next.js (TypeScript) untuk upload, review, riwayat, dan unduh PDF.
- `api` — Node.js (TypeScript) untuk REST API, orchestration, dan integrasi database.
- `ai-worker` — Python FastAPI untuk OCR, parsing dokumen, ekstraksi link, dan pemanggilan LLM.
- `db` — SQLite pada shared volume.
- `ollama` — LLM lokal via Ollama, model tersimpan pada Docker volume.

### Struktur Direktori
- `apps/web-ui` — UI Next.js.
- `apps/api` — API Node.js.
- `apps/ai-worker` — worker FastAPI.
- `docs/superpowers/specs` — spec desain.
- `docs/superpowers/plans` — plan implementasi.
- `tests/fixtures` — contoh BRD untuk testing.
- `uploads` — file BRD yang di-upload.
- `data` — SQLite database.
- `docker` — Dockerfile, compose, konfigurasi.

## Alur Data

1. Operator upload BRD dari UI.
2. API menyimpan file ke `uploads/` dan membuat record campaign di SQLite.
3. API memanggil `ai-worker` untuk parsing.
4. Worker mengekstrak teks, metadata, dan link contoh dari BRD.
5. Worker memanggil LLM lokal untuk membuat strategi, content plan, dan skor.
6. Hasil disimpan ke SQLite.
7. UI menampilkan hasil dan menyediakan tombol unduh PDF.

## Data Model (SQLite)

### Tabel `campaigns`
- `id` — primary key
- `title` — nama campaign
- `status` — `uploaded`, `parsing`, `planned`, `needs_review`, `failed`
- `source_file_path` — path file BRD
- `created_at`, `updated_at`

### Tabel `brd_documents`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `doc_type` — `pdf`, `docx`, `image`
- `raw_text` — teks hasil parsing
- `extracted_links` — JSON array link yang ditemukan
- `parsing_confidence` — nilai 0–1
- `created_at`

### Tabel `plans`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `strategy_summary` — ringkasan strategi
- `requirements_checklist` — JSON array checklist
- `content_plan` — JSON object rencana konten
- `opportunity_score` — skor peluang (0–100)
- `pdf_path` — path file PDF hasil ekspor
- `created_at`

### Tabel `review_tasks`
- `id` — primary key
- `campaign_id` — foreign key ke `campaigns`
- `reason` — alasan butuh review manual
- `status` — `open`, `resolved`
- `created_at`, `resolved_at`

## API & Komponen

### `api` (Node.js)
- `POST /api/campaigns` — upload BRD.
- `GET /api/campaigns` — list campaign.
- `GET /api/campaigns/:id` — detail campaign.
- `POST /api/campaigns/:id/retry` — retry parsing/planning.
- `GET /api/campaigns/:id/pdf` — unduh PDF hasil planner.
- `GET /api/health` — healthcheck.

### `ai-worker` (Python FastAPI)
- `POST /parse` — parse BRD, return teks + metadata + link.
- `POST /plan` — generate strategi, checklist, content plan, skor.
- `GET /health` — healthcheck.

### `web-ui` (Next.js)
- Upload BRD.
- List campaign + status.
- Detail hasil parsing + plan.
- Unduh PDF.
- Review manual untuk `needs_review`.

## Parsing & Ekstraksi

### Input
- PDF, DOCX, gambar (JPG/PNG).

### Output Parsing
- `raw_text`
- `doc_type`
- `extracted_links` — termasuk link video contoh dan link source jika ada.
- `parsing_confidence`

### Aturan
- Jika parsing confidence rendah atau field penting kosong, campaign diberi status `needs_review`.
- Jika link source tidak bisa di-download otomatis, buat `review_tasks` untuk upload manual.
- Jika dokumen mengandung banyak bahasa, simpan teks apa adanya; bahasa final dipilih manual di UI saat membuat plan.

## LLM Planning

### Input Prompt
- Ringkasan campaign.
- Requirement dari BRD.
- Contoh link video.
- Format konten yang diminta.
- Bahasa target.
- Deadline dan reward.
- Risiko/constraint.

### Output Planner
- `strategy_summary`
- `requirements_checklist`
- `content_plan`
- `opportunity_score`

### Model
- LLM: Mistral 7B / Qwen2.5 7B quantized via Ollama.
- OCR: Tesseract.
- Dokumen: `pypdf`, `python-docx`, `Pillow`.

## PDF Export

- Hasil plan di-render menjadi PDF.
- Isi PDF: ringkasan, checklist, content plan, skor, link contoh, catatan review.
- PDF disimpan di `data/exports/`.

## Error Handling

- File rusak/duplikat → reject upload dengan pesan jelas.
- Parsing gagal → status `failed` atau `needs_review`.
- LLM gagal → retry manual dari UI.
- Link tidak bisa diakses → buat review task.
- Database lock → retry ringan di API.

## Testing

### Unit
- Parser PDF/DOCX/gambar.
- Link extractor.
- Scoring rules.
- Prompt builder.

### Integration
- Upload BRD → parsing → plan → simpan DB → unduh PDF.
- Retry flow untuk campaign gagal.

### Fixtures
- Contoh BRD PDF, DOCX, gambar.
- Contoh brief dengan link video publik dan link drive manual.

## Deployment

### Docker Compose
- GPU profile untuk RTX 4060.
- Volume:
  - `uploads` — file BRD.
  - `data` — SQLite + exports.
  - `ollama` — model LLM.

### Environment
- `OLLAMA_MODEL=mistral:7b-instruct`
- `UPLOAD_DIR=/app/uploads`
- `DATA_DIR=/app/data`
- `DB_PATH=/app/data/app.db`
- `EXPORT_DIR=/app/data/exports`

## Sukses MVP

- BRD campuran terparse.
- Strategi, content plan, dan skor keluar.
- Source link terdeteksi auto/manual.
- Riwayat campaign tersimpan.
- PDF bisa diunduh.
- Semua jalan di Docker Compose lokal.

## Catatan Implementasi

- Fokus pada parsing dan planning dulu, bukan kualitas final content generation.
- Video generation/editing didefer ke sub-proyek berikutnya.
- Jika BRD terlalu bervariasi, gunakan pendekatan extraction-first, bukan template-based parsing.
