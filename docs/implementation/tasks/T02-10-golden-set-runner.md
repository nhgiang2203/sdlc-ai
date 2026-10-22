# T02-10 — Runner golden set + job CI trên staging

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | EN-02 (+ AC-US008-10, đo lần đầu) · WP-25 |
| Loại | QA, BE |
| Ước lượng | 2,5 ngày công |
| Phụ thuộc | [T00-09](T00-09-golden-set-v0.md), [T02-05](T02-05-ask-question-sse.md) |
| Chặn | [T03-01](T03-01-golden-set-v1-scoring.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Viết runner chạy golden set **qua API thật trên staging** (đăng nhập → nạp corpus → tạo hội thoại → hỏi qua SSE), ghi lại kết quả từng câu và xuất báo cáo có số đo đầu tiên cho NFR-001 (độ trễ) và NFR-002 (chấm tự động sơ bộ). Chạy tự động trong CI sau mỗi lần deploy staging, **chưa chặn release** (cổng hồi quy ở [T03-01](T03-01-golden-set-v1-scoring.md)).

## 2. Bối cảnh

- IMPLEMENTATION_PLAN §2.2 nguyên tắc 2: "Golden set nháp có từ S0, chạy tự động trên staging từ S2"; exit S2: "Golden set nháp chạy tự động; có số đo đầu tiên cho NFR-001, NFR-002".
- [T00-09](T00-09-golden-set-v0.md) đã có `eval/golden_set.v0.yaml` (≥ 30 câu, trường `category`, `expected_answer_type`, `key_facts`, `expected_citations[{doc_key, pages}]`, `must_not_contain`) và `eval/corpus/MANIFEST.yaml`.
- SAD §11.3 "Chất lượng AI": job đánh giá chạy trên staging khi đổi model/prompt/tham số và hằng tuần trong pilot.
- Runner đi qua HTTP (không gọi use case trực tiếp) để đo độ trễ đầu-cuối gồm Nginx, SSE.

## 3. Phạm vi

**Trong phạm vi:**
- Package `eval/runner/`: đăng nhập, nạp corpus idempotent, chạy câu hỏi, parser SSE, chấm tự động sơ bộ, báo cáo JSONL/JSON/Markdown.
- Job CI `eval-staging` sau deploy staging (không chặn), lưu artifact.
- Tài khoản eval trên staging và miễn rate limit cho tài khoản đó.
- Báo cáo độ trễ p50/p90 (client và server), đối chiếu kích thước kho với điều kiện "kho ≥ 200 tài liệu".

**Ngoài phạm vi:**
- Golden set ≥ 100 câu, chấm đầy đủ, phiếu SME, so sánh với baseline và chặn release khi giảm > 3 điểm % → [T03-01](T03-01-golden-set-v1-scoring.md).
- Câu hỏi tiếp nhiều lượt (`follow_up_of`) → [T05-01](T05-01-follow-up-rewrite-history.md) mở rộng runner.
- Test tải đồng thời 20 người → [T07-01](T07-01-load-test.md).

## 4. Thiết kế chi tiết

### 4.1 Cấu trúc

```text
eval/
├── runner/
│   ├── __main__.py        # CLI: python -m eval.runner run --set eval/golden_set.v0.yaml --base-url …
│   ├── auth.py            # đăng nhập OIDC scripted (Keycloak staging)
│   ├── corpus.py          # nạp corpus idempotent, chờ READY
│   ├── sse_client.py      # httpx stream + parser SSE (cùng hành vi với FE)
│   ├── ask.py             # một câu hỏi → RunResult
│   ├── scoring.py         # chấm tự động sơ bộ
│   ├── report.py          # summary.json, summary.md
│   └── models.py          # pydantic: GoldenItem, RunResult, Summary
├── corpus/filler/         # (đề xuất) PDF công khai làm đầy kho lên ≥ 200 tài liệu
└── reports/               # .gitignore; CI lưu artifact
```

Python 3.12, `httpx`, `pydantic`, `pyyaml`; không import package `cwd` (runner là client bên ngoài).

### 4.2 Đăng nhập

- Tài khoản `cwd-eval` trên Keycloak staging, thuộc nhóm `cwd-users`; mật khẩu trong secret CI `EVAL_USER_PASSWORD`.
- `auth.py`: `GET /auth/login` → theo redirect tới form Keycloak → POST form → theo redirect `/auth/callback` → giữ cookie `__Host-cwd_session`, đọc `cwd_csrf` để gửi `X-CSRF-Token`.
- Phiên hết hạn (30 phút không hoạt động / 8 giờ) → đăng nhập lại khi nhận 401.

### 4.3 Nạp corpus

1. Đọc `eval/corpus/MANIFEST.yaml` (+ `eval/corpus/filler/MANIFEST.yaml` nếu `--fill-to N`).
2. `GET /api/v1/documents?page_size=100` (duyệt hết cursor) → so `filename`/`sha256` (nếu API trả) với manifest.
3. Thiếu → `POST /api/v1/documents`; 409 `DUPLICATE_DOCUMENT` → dùng `existing_document_id`.
4. Poll mỗi 5 s tới khi mọi tài liệu `READY` (timeout 30 phút); tài liệu `FAILED` → báo lỗi corpus, dừng.
5. Ánh xạ `doc_key → document_id` và `filename` để chấm citation.

### 4.4 Chạy câu hỏi

- Mỗi câu: `POST /api/v1/conversations` → `POST /conversations/{id}/messages {question}` đọc SSE.
- Ghi lại: `meta`, chuỗi `delta` (nối văn bản), mọi `citation`, `done`/`error`, `client_first_delta_ms` (từ lúc gửi tới `delta` đầu), `client_total_ms`, `server_first_token_ms`, `server_total_ms`, mã HTTP, `X-Request-ID`.
- Tuần tự mặc định (`--concurrency 1`) để đo độ trễ sạch; `--concurrency N` cho chạy nhanh.
- Lỗi mạng/timeout của runner (180 s/câu) → ghi `error = "runner_timeout"`, chạy tiếp.
- Rate limit: tài khoản eval được miễn qua cấu hình staging `CWD_RATE_LIMIT_EXEMPT_SUBJECTS=<sub của cwd-eval>` (đề xuất; chỉ bật ở staging, kiểm khi khởi động rằng prod không có giá trị). Nếu không được duyệt: runner tự giới hạn 10 câu/phút và 60 câu/giờ (100 câu ≈ 1 giờ 40 phút).

### 4.5 Chấm tự động sơ bộ (`scoring.py`)

| Chỉ số | Cách tính |
|---|---|
| `answer_type_match` | `done.answer_type == expected_answer_type` |
| `citation_hit` | Có ≥ 1 citation rơi vào một mục `expected_citations` (cùng `document_id`, khoảng `[page_start, page_end]` giao với `pages`) |
| `citation_precision` | Tỷ lệ citation rơi vào bất kỳ mục `expected_citations` nào |
| `doc_recall` | Với `multi_doc`: số `doc_key` trong `expected_citations` có ≥ 1 citation ÷ tổng |
| `key_facts_coverage` | Tỷ lệ `key_facts` xuất hiện trong văn bản sau chuẩn hoá (NFC, bỏ dấu, lowercase, gộp khoảng trắng; số so sánh sau khi bỏ dấu chấm phân cách nghìn) |
| `must_not_contain_violation` | Có cụm nào trong `must_not_contain` xuất hiện (chuẩn hoá như trên) |
| `auto_correct` (sơ bộ) | `answered`: `answer_type_match ∧ citation_hit ∧ key_facts_coverage = 1 ∧ ¬violation`; `not_found`: `answer_type_match` |

Đây là ước lượng tự động; NFR-002 chính thức dùng phiếu SME ở T03-01.

### 4.6 Báo cáo

- `eval/reports/<UTC-timestamp>_<git-sha>/results.jsonl`: mỗi dòng một `RunResult` (gồm câu hỏi, văn bản trả lời, citation — dữ liệu golden set không nhạy cảm).
- `summary.json` + `summary.md`:
  - Thông tin chạy: `git_sha`, `prompt_version` (đọc từ `GET /conversations/{id}`), `model`, `retrieval params_version` (từ cấu hình staging qua biến CI), số tài liệu `READY` trong kho, thời điểm.
  - Theo nhóm `category`: số câu, `auto_correct` %, `answer_type_match` %, `citation_hit` %, tỷ lệ `not_found` ở `no_answer`, tỷ lệ `not_found` sai ở nhóm có đáp án.
  - Độ trễ: p50/p90 của `client_first_delta_ms`, `client_total_ms`, `server_first_token_ms`, `server_total_ms` (chỉ câu `answered`/`partial`); số lỗi theo mã.
  - Cảnh báo nếu kho < 200 tài liệu: "Độ trễ chưa đo trên kho ≥ 200 tài liệu (AC-US008-10)".
- Exit code: 0 khi chạy xong (kể cả chất lượng thấp); khác 0 chỉ khi lỗi hạ tầng (không đăng nhập được, corpus lỗi).

### 4.7 Job CI `eval-staging`

| Mục | Giá trị |
|---|---|
| Kích hoạt | Sau job `deploy-staging` thành công trên `main`; thủ công (`workflow_dispatch`) với tham số `set`, `concurrency`, `fill_to` |
| Lệnh | `python -m eval.runner run --set eval/golden_set.v0.yaml --base-url $STAGING_URL --fill-to 200` |
| Chặn release | **Không** (`continue-on-error: true`) — T03-01 đổi thành required |
| Artifact | Thư mục báo cáo, giữ 30 ngày; `summary.md` đăng vào job summary |
| Bí mật | `EVAL_USER_PASSWORD`; không in cookie/CSRF ra log |

## 5. Các bước thực hiện

- [ ] Tạo tài khoản `cwd-eval` trên Keycloak staging (DevOps), xin duyệt miễn rate limit (PO + Bảo mật).
- [ ] Viết `models.py` đọc đúng schema của T00-09 (dùng chung `eval/schema/golden_set.schema.json`).
- [ ] Viết `auth.py`, `corpus.py`, `sse_client.py` (test parser với cùng fixture SSE của T02-05).
- [ ] Viết `ask.py`, `scoring.py` + unit test chấm điểm.
- [ ] Viết `report.py` (JSON + Markdown).
- [ ] Chuẩn bị `eval/corpus/filler/` (PDF công khai, giấy phép rõ) để kho đạt ≥ 200 tài liệu (đề xuất).
- [ ] Thêm job `eval-staging` vào pipeline CI (T00-06).
- [ ] Chạy lần đầu với Claude thật, đính kèm `summary.md` vào báo cáo sprint review S2.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US008-10 (đo lần đầu):** báo cáo có p90 ký tự đầu và p90 tổng thời gian trên golden set v0 với kho ≥ 200 tài liệu trên staging, so với ngưỡng 3 s / 15 s; nghiệm thu chính thức dưới tải ở [T07-01](T07-01-load-test.md).
- [ ] **EN-02 (phần S2):** script chạy trên staging trong CI sau mỗi deploy, xuất báo cáo theo nhóm câu; artifact tải được từ CI.
- [ ] Chạy lại lần hai không tải lại corpus (idempotent qua sha256 / 409).
- [ ] Runner chịu được câu lỗi (timeout, `error` SSE) mà không dừng cả lượt chạy.
- [ ] Unit test `scoring.py` phủ mọi chỉ số §4.5; parser SSE đạt cùng bộ fixture với FE/T02-05.
- [ ] Không có secret trong log CI.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `citation_hit` với khoảng trang giao/không giao; chuẩn hoá `key_facts` ("2.450.000.000 đồng" ≈ "2450000000"); `must_not_contain` |
| Integration (compose dev + `FakeLLMAdapter`) | Chạy 5 câu đầu-cuối; kịch bản `[fake:timeout]` ghi lỗi và chạy tiếp |
| Staging | Chạy đầy đủ v0 với Claude thật; so sánh số `delta`/citation với `GET /conversations/{id}` |

## 8. Analytics / observability

- Câu hỏi của runner tạo EV-08/EV-09 với `user_id` của `cwd-eval` → phải loại khỏi thống kê sản phẩm (WAU, số câu hỏi): đề xuất T06-01 loại theo danh sách tài khoản kỹ thuật `CWD_TECHNICAL_USER_IDS`.
- Mỗi lần chạy đặt header `X-Request-ID: eval-<run_id>-<item_id>` để tra trace trên Tempo.
- Báo cáo là nguồn số đo NFR-001/NFR-002 trong sprint review.

## 9. Tham chiếu

- [USER_STORIES.md — EN-02, US-008 AC-US008-10](../../requirements/USER_STORIES.md)
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §2.2, S2 WP-25, exit S2, §6 (chất lượng AI)
- [SAD.md](../../requirements/SAD.md) §10.3 (SSE), §11.2 (rate limit), §11.3 (chất lượng AI)
- [PRD.md](../../requirements/PRD.md) §4.7 NFR-001, NFR-002; §6.1 LG-02, LG-03
- [T00-09](T00-09-golden-set-v0.md) (schema golden set)

## 10. Giả định và câu hỏi mở

- Giả định staging dùng Keycloak (PA-04); nếu staging dùng IdP thật, cần tài khoản dịch vụ từ IT (OQ-016).
- **OQ-T0210-1:** Rate limit 10 câu/phút và 60 câu/giờ làm golden set 100 câu mất ≥ 1 giờ 40 phút. Cần PO + Bảo mật duyệt cơ chế miễn rate limit cho tài khoản eval chỉ ở staging.
- **OQ-T0210-2:** AC-US008-10 yêu cầu kho ≥ 200 tài liệu; bộ PDF mẫu (DEP-002) dự kiến ít hơn. Đề xuất làm đầy bằng PDF công khai (`eval/corpus/filler/`) — cần Pháp chế xác nhận giấy phép (OQ-030).
- **OQ-T0210-3:** Chi phí mỗi lần chạy (`usage`) không có trong API công khai. Đề xuất runner đọc `conv.messages.usage` qua kết nối read-only tới CSDL staging (`--db-dsn`) hoặc từ metric `cwd_llm_cost_usd_total`; cần Tech lead chọn.
- **OQ-T0210-4:** Sự kiện analytics của tài khoản eval làm nhiễu số liệu pilot nếu chạy trên prod — đề xuất không chạy runner trên prod.
