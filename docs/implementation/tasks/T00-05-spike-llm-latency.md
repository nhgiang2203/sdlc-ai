# T00-05 — Spike đo độ trễ và chất lượng Claude

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | EN-01, WP-04 (trả lời OQ-028) |
| Loại | BE |
| Ước lượng | 4 ngày công |
| Phụ thuộc | [T00-03](T00-03-dev-docker-compose.md), [T00-09](T00-09-golden-set-v0.md) (≥ 20 câu đầu) |
| Chặn | [T02-03](T02-03-claude-llm-adapter.md), [T02-04](T02-04-system-prompt-v1.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Trước khi xây pipeline thật, đo trên dữ liệu mẫu **thời gian tới ký tự đầu (p50/p90), tổng thời gian, chất lượng sơ bộ và chi phí/câu hỏi** của chuỗi truy xuất lai + rerank + `claude-opus-5-5` streaming có citations ở effort `low` và `medium`; xác nhận ánh xạ `content_block_location` → trang hoạt động; đưa ra khuyến nghị cấu hình (OQ-028) trước **06/11/2026**.

## 2. Bối cảnh

- NFR-001: ký tự đầu p90 ≤ 3 s, hoàn chỉnh p90 ≤ 15 s. SAD §0.3, RSK-008: chưa đo với mô hình có suy luận adaptive (không tắt được trên Opus 5.5).
- SAD §4.2 bảng pipeline: ngân sách thời gian từng bước; bước 2 (viết lại câu hỏi) 800–1.500 ms là rủi ro chính cho lượt hỏi tiếp.
- ADR-006: trích dẫn gốc qua `document` block `source.type = "content"`, mỗi content block con là một trang.
- Exit criteria S0 (M1): "Báo cáo spike: ký tự đầu p90 ≤ 3 s ở effort đã chọn, **hoặc** phương án giảm thiểu RSK-008 được Tech lead + PO chấp thuận."
- PA-05: chỉ dùng dữ liệu giả/PDF mẫu không nhạy cảm cho tới khi có OQ-005.

## 3. Phạm vi

**Trong phạm vi:**
- Script độc lập trong `eval/spike_en01/` (không thuộc package `cwd`, không chịu import-linter): nạp PDF → cắt đoạn đơn giản → embed → lưu vào schema tạm `spike` → truy vấn lai SQL SAD §7.2 → rerank → gọi Claude stream.
- Ma trận chạy: 2 effort × ≥ 20–30 câu × 2 lần lặp; thêm 10 lượt hỏi tiếp có bước viết lại.
- Báo cáo `docs/implementation/spikes/EN-01-report.md` + dữ liệu thô CSV.

**Ngoài phạm vi:**
- Chunking chuẩn (bge-m3 tokenizer, ≤ 2 trang, tiền tố ngữ cảnh) → [T01-05](T01-05-pdf-extraction-chunking.md); spike dùng bản rút gọn.
- `ClaudeLLMAdapter`, `LLMPort`, retry/circuit breaker → [T02-03](T02-03-claude-llm-adapter.md), [T05-07](T05-07-circuit-breaker-degraded.md).
- System prompt có phiên bản → [T02-04](T02-04-system-prompt-v1.md) (spike dùng bản nháp 6 quy tắc SAD §4.2, chuyển giao cho T02-04).
- Cổng τ_nf, hiệu chỉnh ngưỡng → [T03-02](T03-02-not-found-gate-calibration.md).
- Chấm chất lượng chính thức (SME) → [T03-01](T03-01-golden-set-v1-scoring.md).

## 4. Thiết kế chi tiết

### 4.1 Cấu trúc

```text
eval/spike_en01/
├── pyproject.toml           # deps riêng: anthropic, pypdfium2, httpx, psycopg[binary], pgvector, pyyaml, pandas
├── ingest.py                # PDF → pages → chunks → /embed → spike.chunks
├── run.py                   # golden_set.v0.yaml × effort × repeat → results/*.csv
├── retrieval.py             # SQL lai + /rerank
├── llm.py                   # build_request(), stream_and_measure()
├── prompts/system_draft.md
├── report.py                # CSV → bảng p50/p90, chi phí, biểu đồ histogram (PNG)
└── results/                 # gitignored, trừ file tổng hợp
```

Chạy trên Compose dev (profile `core` + `models` + `obs`). Claude API key **dev/spike riêng** đọc từ `deploy/compose/secrets/anthropic_api_key`.

### 4.2 Nạp tài liệu (rút gọn)

- `pypdfium2`: trích theo trang, bỏ trang < 20 ký tự.
- Cắt đoạn: ~450 token, chồng 60, không vượt 2 trang; đếm token bằng TEI `POST /tokenize` của `tei-embed` (cùng tokenizer bge-m3).
- Mỗi chunk lưu `page_segments = [{page, text}]` (1–2 phần tử).
- Embed lô 32, chuỗi đầu vào có tiền tố `"{filename} — trang {page_start}: "` (SAD §4.2).
- Bảng `spike.chunks(id uuid, document_id uuid, filename text, page_start int, page_end int, text text, page_segments jsonb, embedding vector(1024), tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(text))) STORED)`; HNSW `m=16, ef_construction=64`; GIN(`tsv`). Cần T00-04 hoặc tự tạo `f_unaccent` trong schema spike nếu T00-04 chưa xong.

### 4.3 Truy xuất

1. `POST /embed {inputs:[question], normalize:true}`.
2. SQL lai của SAD §7.2 (vector top 40 + toàn văn top 40, RRF k = 60 → top 30), `SET hnsw.ef_search = 80`.
3. `POST /rerank {query, texts: 30 đoạn, raw_scores:false}` → top 8 (không áp τ_keep/τ_nf trong spike; ghi lại điểm cao nhất để T03-02 tham khảo).

### 4.4 Request Claude

```python
client = anthropic.Anthropic(max_retries=2, timeout=httpx.Timeout(120, connect=10))
documents = [{
    "type": "document",
    "source": {"type": "content",
               "content": [{"type": "text", "text": seg["text"]} for seg in chunk.page_segments]},
    "title": f"{chunk.filename} — tr. {chunk.page_start}–{chunk.page_end}",
    "citations": {"enabled": True},
} for chunk in top8]
with client.beta.messages.stream(
    model="claude-opus-5-5", max_tokens=4096,
    system=SYSTEM_DRAFT,
    messages=[{"role": "user", "content": [*documents, {"type": "text", "text": question}]}],
    output_config={"effort": effort},                 # "low" | "medium" — đặt rõ, mặc định của Opus 5.5 là medium
    betas=["server-side-fallback-2026-07-01"], fallbacks="default",   # SAD §4.2 "Từ chối"
) as stream:
    for event in stream: ...                          # đo thời điểm text_delta đầu tiên, gom citations_delta
    final = stream.get_final_message()
```

- Không truyền tham số `thinking` (adaptive mặc định; `disabled` bị từ chối trên Opus 5.5).
- Kiểm tra `final.stop_reason == "refusal"` trước khi đọc nội dung; ghi `stop_details.category`.
- Hỏi tiếp (10 lượt): bước viết lại là một request riêng `max_tokens=256`, effort `low`, không có document; đo `rewrite_ms`, sau đó chạy pipeline với câu đã viết lại.
- Kiểm tra lại tên trường/sự kiện SDK theo tài liệu `anthropic` 1.x hiện hành khi viết code; chỗ nào khác với ở trên thì ghi vào báo cáo cho T02-03.

### 4.5 Đo lường (mỗi lần chạy một dòng CSV)

| Cột | Định nghĩa |
|---|---|
| `q_id`, `category`, `effort`, `rep`, `turn` | Khoá |
| `embed_ms`, `sql_ms`, `rerank_ms`, `rewrite_ms` | Thời gian từng bước (`time.perf_counter`) |
| `llm_ttft_ms` | Từ lúc gửi request Claude tới `text_delta` đầu tiên |
| `first_token_ms` | Từ lúc **nhận câu hỏi** tới `text_delta` đầu tiên (đại lượng NFR-001, khớp EV-09) |
| `total_ms` | Từ lúc nhận câu hỏi tới `message_stop` |
| `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | Từ `final.usage` |
| `cost_usd` | input × $4/MTok + output × $20/MTok + cache read × $0,20/MTok (SAD §12.4) + cache write theo bảng giá hiện hành |
| `stop_reason`, `refusal_category` | |
| `citation_count`, `citation_pages_ok` | Số citation; tỷ lệ citation ánh xạ được (doc, trang) (§4.6) |
| `answer_type_guess` | `not_found` nếu văn bản bằng đúng câu cố định; `partial` nếu không có citation; còn lại `answered` |
| `top_rerank_score` | Điểm rerank cao nhất |
| `expected_pages_hit` | Có ít nhất một citation trùng trang đáp án trong golden set |

Không ghi nội dung câu trả lời vào CSV dùng chung; nội dung lưu ở `results/answers/*.jsonl` cục bộ để Tech lead đọc mẫu (dữ liệu giả, không mật).

### 4.6 Kiểm chứng ánh xạ trích dẫn

Với mỗi citation `content_block_location {document_index, start_block_index, end_block_index}`: `chunk = top8[document_index]`, `pages = chunk.page_segments[start_block_index : end_block_index]` → `(page_start, page_end)` (lưu ý chỉ số cuối là exclusive hay inclusive — xác nhận thực nghiệm và ghi vào báo cáo). Kiểm tra `cited_text` là chuỗi con của `chunk.page_segments[i].text` tương ứng. Kết quả: tỷ lệ ánh xạ đúng phải 100% trên mẫu, nếu không phải ghi cách xử lý cho T02-03.

### 4.7 Báo cáo (`docs/implementation/spikes/EN-01-report.md`)

1. Cấu hình (phiên bản SDK, model, kho mẫu: số tài liệu/trang/chunk, phần cứng TEI).
2. Bảng p50/p90 `first_token_ms`, `llm_ttft_ms`, `total_ms` theo effort, theo lượt đầu/hỏi tiếp.
3. Phân rã thời gian theo bước so với ngân sách SAD §4.2.
4. Chất lượng sơ bộ: tỷ lệ `expected_pages_hit`, tỷ lệ `not_found` đúng với nhóm không có đáp án, theo nhóm LG-02.
5. Chi phí trung bình/câu và ngoại suy 9.000 câu/tháng (so với $360 của SAD §12.4).
6. Kết quả ánh xạ trích dẫn (§4.6) và các khác biệt API cần T02-03 lưu ý.
7. **Khuyến nghị:** effort cho câu trả lời và bước viết lại; có cần phương án RSK-008 (fast mode, mô hình nhanh hơn cho bước viết lại) không; đề xuất cập nhật SAD §4.2/§12.4.

## 5. Các bước thực hiện

- [ ] Ngày 1: dựng `eval/spike_en01/`, `ingest.py`; nạp 10 PDF mẫu từ T00-09.
- [ ] Ngày 2: `retrieval.py`, `llm.py`; chạy thử 3 câu, kiểm chứng ánh xạ trích dẫn §4.6.
- [ ] Ngày 3: `run.py` toàn ma trận (≈ 30 câu × 2 effort × 2 lặp + 10 lượt hỏi tiếp × 2 effort ≈ 140 lời gọi, chi phí ước tính < $10); thu trace qua OTel (nếu T00-08 sẵn).
- [ ] Ngày 4: `report.py`, viết báo cáo, trình bày với Tech lead + PO; cập nhật OQ-028.
- [ ] Bàn giao `prompts/system_draft.md` và ghi chú API cho T02-03, T02-04.

## 6. Tiêu chí hoàn thành

- [ ] Báo cáo có p50/p90 ký tự đầu và tổng thời gian, tỷ lệ đúng sơ bộ, chi phí/câu hỏi từ `usage`, khuyến nghị effort (tiêu chí EN-01).
- [ ] Ký tự đầu p90 ≤ 3 s ở effort được chọn, **hoặc** phương án giảm thiểu RSK-008 được Tech lead + PO ký chấp thuận (exit S0/M1).
- [ ] Xác nhận ánh xạ `content_block_location` → trang hoạt động trên ≥ 95% citation mẫu, có giải thích phần còn lại (WP-04).
- [ ] OQ-028 chuyển trạng thái trong SAD §16.2 (PR cập nhật SAD do Tech lead duyệt).

## 7. Kiểm thử

Spike không đòi hỏi test tự động. Kiểm tra tối thiểu:

| Kịch bản | Kỳ vọng |
|---|---|
| Câu thuộc nhóm "không có đáp án" | Đa số trả đúng câu cố định "Không tìm thấy thông tin này trong các tài liệu hiện có." (ghi tỷ lệ) |
| Câu đa tài liệu (giá trị hợp đồng v1 vs v2) | Citation trỏ tới ≥ 2 tài liệu |
| Ngắt mạng giữa stream (thủ công) | Ghi nhận hành vi SDK để T02-03 xử lý `STOPPED` |
| Chạy lại cùng câu 2 lần | Ghi độ dao động p90 giữa hai lần |

## 8. Analytics / observability

- Mỗi bước bọc span OTel tên giống SAD §11.3 (`qa.retrieve`, `embed`, `vector_search`, `fts_search`, `rerank`, `llm.stream`) với thuộc tính `model`, `effort`, `first_token_ms`, token — **không** gắn câu hỏi/đoạn trích vào span (PR-06). Xem trên Jaeger cục bộ (WP-06).
- Đại lượng `first_token_ms`, `total_ms` định nghĩa giống EV-09 để so sánh được với số đo staging sau này.

## 9. Tham chiếu

- USER_STORIES §8 EN-01; PRD NFR-001, NFR-002, §6.2 EV-09
- SAD §0.3, §4.2 (pipeline, hợp đồng LLM, system prompt), §7.2 (SQL lai), §8.1, §10.4 (IF-03 ánh xạ trích dẫn), §11.3, §12.4, §16 RSK-008, OQ-028, ADR-005, ADR-006
- IMPLEMENTATION_PLAN §4 S0 WP-04, §5.1, IR-03

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Giả định | PO cấp API key Claude cho dev trước 26/10 (PA-05); không dùng tài liệu thật (OQ-005). |
| Giả định | TEI chạy CPU trên máy dev/VM tạm; số đo rerank có thể khác staging — báo cáo ghi rõ phần cứng. |
| Thiếu phụ thuộc | Spike cần `f_unaccent` (T00-04) và tracing (T00-08); README không liệt kê. Nếu chưa xong, spike tự tạo hàm trong schema `spike` và đo bằng `perf_counter`. |
| Đề xuất | Đặt báo cáo tại `docs/implementation/spikes/`, dữ liệu thô trong `eval/spike_en01/results/`. |
| OQ-028 | Kết quả của chính task này. |
| OQ-005, OQ-029 | Đường egress tới `api.anthropic.com`; spike chạy từ máy dev — số đo độ trễ mạng có thể khác khi qua proxy. Nếu OQ-029 chọn nền tảng cloud, chạy lại phần LLM. |
| OQ-031 | Tier tài khoản — ghi lại header rate limit trả về trong lúc spike. |
