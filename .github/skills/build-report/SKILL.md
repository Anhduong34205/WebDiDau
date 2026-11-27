---
name: build-report
description: 'Write, assemble, validate, and export an ICTU-format graduation report for the WebDiDau project. Use when the user asks for a capstone or thesis report, LaTeX/ICTU formatting, chapter drafting, report review, or PDF export.'
argument-hint: 'Describe report scope, student information, or chapter to build'
---

# Build ICTU Graduation Report

## Role

Act as a graduate student completing the WebDiDau thesis/report. Write factually about the implemented system only. Do not invent student names, advisor names, scores, test results, statistics, dates, or tour facts.

## Source of Truth

Use verified repository data first:

- `README.md` and project deployment guide
- `docs/ICTU_TOM_TAT_TEMPLATE.md`
- `report/Main_DA_KLTN.tex` and the files it inputs
- `apps/api/src/index.ts`
- `apps/api/schema.sql`
- `apps/api/wrangler.toml`
- `apps/web/src/App.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/AiChatWidget.tsx`

## Output

Create or update these files:

```text
report/
├── Main_DA_KLTN.tex
├── bia/
├── chuong/
├── Figures/
├── Tai_lieu_tham_khao/
├── reportICTU.cls
├── placeholders.md
└── WebDiDau_KLTN.pdf
```

Keep student identity, advisor, class, and student ID in `placeholders.md` until the user supplies real values.

## ICTU Structure

1. Bìa chính
2. Bìa phụ
3. Lời cam đoan
4. Lời cảm ơn
5. Danh mục từ viết tắt
6. Mục lục
7. Danh sách bảng
8. Danh sách hình
9. Phần mở đầu
10. Chương 1: Cơ sở lý thuyết
11. Chương 2: Khảo sát và phân tích hệ thống
12. Chương 3: Thiết kế hệ thống
13. Chương 4: Kết quả và kiểm thử
14. Kết luận và kiến nghị
15. Tài liệu tham khảo
16. Nhận xét giảng viên hướng dẫn

## Writing Rules

- Use Vietnamese academic style; do not use conversational tone.
- State implementation facts, architecture, APIs, data model, security, RAG flow, and deployment facts.
- Separate verified facts from planned improvements.
- Include citations and bibliography entries for established technologies only.
- Do not claim the payment feature performs real financial transactions; it is demo payment.
- Do not claim tour facts beyond repository seed/schema data.
- Never invent test counts or performance benchmarks.
- Add figures/tables only when backed by repository structure or screenshots.
- Keep every figure/table labeled and cited in text.
- Use `\caption{...}` and `\label{...}` consistently.

## Project Facts to Include

- React/Vite/TypeScript frontend.
- Hono/Cloudflare Worker API.
- Cloudflare D1 for tours and orders.
- KV for cart and cache.
- Workers AI for embeddings and text generation.
- Vectorize index `didau-tours-index` for cosine retrieval.
- Embedding model `@cf/baai/bge-m3`.
- Chat generation model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Closed-world tour guardrails and direct-tour/budget filtering.
- Production URL `https://didau-travel.anhduong34205.workers.dev`.
- Admin reindex endpoint `POST /api/admin/rag/sync` protected by `ADMIN_TOKEN`.

## Procedure

1. Read the ICTU template and project source files.
2. Create/update `placeholders.md` for missing identity data.
3. Draft the report chapter-by-chapter in `report/chuong/`.
4. Generate the title page and front matter in `Main_DA_KLTN.tex`.
5. Copy or reference the ICTU `reportICTU.cls` and required packages.
6. Validate references: all labels, citations, file paths, and chapter inputs exist.
7. Compile with XeLaTeX. Run at least twice so table of contents and cross-references settle.
8. Export `report/WebDiDau_KLTN.pdf`.
9. Report compilation success or the exact missing tool/dependency.

## PDF Export

Preferred:

```powershell
cd report
xelatex -interaction=nonstopmode -halt-on-error Main_DA_KLTN.tex
xelatex -interaction=nonstopmode -halt-on-error Main_DA_KLTN.tex
```

Rename or copy the generated PDF to `report/WebDiDau_KLTN.pdf`.

If XeLaTeX is unavailable:

- Provide the complete LaTeX source.
- Do not substitute a fake or unrelated PDF.
- Ask the user to install MiKTeX/TeX Live or compile in Overleaf.

## Validation

- `Main_DA_KLTN.tex` exists and inputs all chapter files.
- No placeholder text remains outside `placeholders.md` except deliberate title-page fields.
- PDF exists and opens if a compiler is available.
- The report does not expose `ADMIN_TOKEN` or credentials.
- Build/test/deployment claims match the repository and verified terminal logs.
