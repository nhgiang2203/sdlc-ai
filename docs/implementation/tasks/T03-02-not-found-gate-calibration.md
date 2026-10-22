# T03-02 — Cổng "không tìm thấy" τ_nf + hiệu chỉnh τ_keep, τ_nf

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S3 (07/12 – 18/12/2026) |
| Story / WP | US-011 · WP-31 |
| Loại | BE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T02-05](T02-05-ask-question-sse.md), [T03-01](T03-01-golden-set-v1-scoring.md) |
| Chặn | — (nằm trên đường găng tới [T07-04](T07-04-final-regression.md) theo sơ đồ README) |
| Trạng thái | Todo |

## 1. Mục tiêu

Hoàn thiện cơ chế "không tìm thấy" hai lớp (ADR-002, US-011): (1) cổng ngưỡng τ_nf sau rerank trả `not_found` **không gọi LLM** khi điểm rerank cao nhất < τ_nf; (2) nhận diện câu cố định "Không tìm thấy thông tin này trong các tài liệu hiện có." do LLM trả để gán `answer_type = not_found` thay vì `partial`. Hiệu chỉnh τ_keep và τ_nf trên golden set v1 để đạt KR2.2 (≥ 90% câu không có đáp án → not_found) mà không làm giảm KR2.1.

## 2. Bối cảnh

- SAD §4.2 bước 7–8, §9.2 (`not_found` từ cổng hoặc từ câu cố định), ADR-002 (phương án không có cổng bị loại vì kém ổn định, tốn chi phí).
- [T02-02](T02-02-hybrid-retrieval-rerank.md) trả `RetrievalResult.top_score` (trước khi lọc τ_keep) và `passages` (đã lọc τ_keep = 0,05 khởi điểm).
- [T02-05](T02-05-ask-question-sse.md) có chỗ gọi `NotFoundGate.evaluate(result)` với `EmptyPassagesGate`; S2 để câu cố định của LLM rơi vào `partial` (INV-04).
- [T03-01](T03-01-golden-set-v1-scoring.md) cung cấp golden set v1 với ≥ 15 câu `no_answer` và chỉ số `not_found_recall`, `false_not_found_rate`.

## 3. Phạm vi

**Trong phạm vi:**
- `ThresholdNotFoundGate` thay `EmptyPassagesGate`.
- Hàm miền `is_not_found_sentence(text, lang)` + tích hợp vào `decide_answer_type` (T02-05).
- CLI dump truy xuất trên staging, script quét ngưỡng, báo cáo hiệu chỉnh, cập nhật cấu hình τ.
- Lưu nội dung message `not_found` chuẩn (cho lịch sử và T05-01).

**Ngoài phạm vi:**
- Giao diện khối "Không tìm thấy" (ℹ️, phạm vi đã tìm, gợi ý) → [T03-03](T03-03-fe-not-found-processing-note.md).
- Câu trả lời "một phần" (AC-US011-2, quy tắc 3 của prompt) → [T03-04](T03-04-grounding-hardening.md).
- Câu cố định tiếng Anh → [T04-05](T04-05-english-language-support.md) (hàm đã nhận tham số `lang`).
- Phạm vi tài liệu chọn → [T04-03](T04-03-scope-filter-api.md) (cổng giữ nguyên, chỉ tập ứng viên thay đổi).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `backend/cwd/domain/qa/not_found.py` | `NOT_FOUND_TEXT`, `is_not_found_sentence`, `gate_decision(top_score, tau_nf)` |
| `backend/cwd/application/qa/not_found_gate.py` | `ThresholdNotFoundGate` (thay `EmptyPassagesGate`) |
| `backend/cwd/domain/conversations/citation_numbering.py` | `decide_answer_type` gọi `is_not_found_sentence` |
| `backend/cwd/entrypoints/cli/retrieval_dump.py` | `python -m cwd.entrypoints.cli.retrieval_dump --set eval/golden_set.v1.yaml --out dump.jsonl` |
| `eval/calibration/sweep_thresholds.py` | Quét τ_nf, τ_keep; xuất `calibration.md` |
| `backend/cwd/config/retrieval.py` | Giá trị τ mới, `params_version = "ret.v2"` |

### 4.2 Cổng ngưỡng

```python
@dataclass(frozen=True)
class GateDecision:
    not_found: bool
    reason: Literal["no_candidates", "below_tau_nf", "no_passage_kept", "pass"]
    top_score: float | None

class ThresholdNotFoundGate:
    def __init__(self, tau_nf: float) -> None: ...
    def evaluate(self, result: RetrievalResult) -> GateDecision:
        # no_candidates  : result.candidate_count == 0
        # below_tau_nf   : result.top_score < tau_nf
        # no_passage_kept: len(result.passages) == 0  (τ_keep > τ_nf do cấu hình sai → vẫn an toàn)
        # pass           : còn lại
```

- Ràng buộc cấu hình: `tau_keep ≤ tau_nf` (kiểm khi khởi động).
- `not_found` từ cổng: T02-05 lưu message `COMPLETED`, `answer_type = not_found`, `text = NOT_FOUND_TEXT["vi"]`, `citations = []`, `first_token_ms = NULL`, `usage = {"gate": reason, "top_score": …}`; `llm_content` user = `[{"type":"text","text": câu hỏi}]`, assistant = `[{"type":"text","text": NOT_FOUND_TEXT}]` (khớp T05-01 §4).
- SSE: `meta` → `done{answer_type: "not_found", status: "COMPLETED", first_token_ms: null, total_ms, citation_count: 0}`. FE dùng `meta.docs_in_scope` để hiển thị "Đã tìm trong N tài liệu".

### 4.3 Nhận diện câu cố định

```python
NOT_FOUND_TEXT = {"vi": "Không tìm thấy thông tin này trong các tài liệu hiện có."}

def is_not_found_sentence(text: str, lang: str = "vi") -> bool:
    """True khi văn bản (sau chuẩn hoá: NFC, bỏ dấu, lowercase, bỏ dấu câu/markdown, gộp khoảng trắng)
    bằng đúng câu cố định đã chuẩn hoá, hoặc câu cố định là toàn bộ nội dung trừ khoảng trắng/dấu chấm."""
```

`decide_answer_type` (cập nhật T02-05 §4.5), theo thứ tự:
1. `is_not_found_sentence(text)` ∧ `citation_count == 0` → `not_found` (bỏ cảnh báo partial).
2. `is_not_found_sentence(text)` ∧ `citation_count > 0` → `answered` (LLM vẫn trích dẫn — hiếm; ghi metric `cwd_not_found_with_citation_total`).
3. Văn bản chứa câu cố định **cùng** nội dung khác → không phải not_found; xét theo citation như cũ (`partial` nếu 0 citation) — phần "một phần" là T03-04.
4. Còn lại như T02-05.

Chỉ đánh giá sau `Completed` (không ngắt stream sớm); FE nhận `done.answer_type = not_found` và chuyển văn bản đã stream sang khối info (T03-03).

### 4.4 Hiệu chỉnh

1. **Dump:** CLI chạy `RetrieveContext` (không gọi LLM) cho mọi câu v1 trên staging, ghi mỗi câu: `top_score`, điểm 30 ứng viên, cờ ứng viên chứa bằng chứng (`chunk` giao với `expected_citations`), `category`.
2. **Quét τ_nf** ∈ [0,00; 0,60] bước 0,01: tính `gate_catch_no_answer` (tỷ lệ câu `no_answer` bị cổng chặn) và `gate_false_reject` (câu có đáp án bị chặn).
3. **Chọn τ_nf** = giá trị lớn nhất sao cho `gate_false_reject ≤ 2%` (đề xuất); phần câu `no_answer` lọt qua cổng do lớp 2 (prompt) xử lý.
4. **Quét τ_keep** ∈ [0,00; τ_nf]: chọn giá trị lớn nhất mà `evidence_recall_kept` (đoạn bằng chứng còn trong top 8 sau lọc) ≥ 98% của giá trị tại τ_keep = 0 (đề xuất) — giảm đoạn nhiễu gửi LLM, giảm chi phí.
5. **Xác nhận đầu-cuối:** chạy golden set v1 đầy đủ với τ mới → `not_found_recall ≥ 90%` (KR2.2) và `auto_correct` nhóm có đáp án không giảm > 3 điểm % so với baseline S2 (KR2.1 — cổng hồi quy T03-01).
6. Nếu không đạt cả hai: báo cáo ma trận đánh đổi cho PO; phương án: tăng effort, sửa prompt (T03-04), tách ngưỡng theo ngôn ngữ (T04-05).
7. Ghi giá trị vào `retrieval.py` + `params_version = "ret.v2"`; `calibration.md` lưu biểu đồ/bảng và commit cùng PR.

## 5. Các bước thực hiện

- [ ] Viết `not_found.py` + unit test chuẩn hoá (dấu, chữ hoa, dấu chấm, markdown `**…**`).
- [ ] Viết `ThresholdNotFoundGate`, thay DI trong T02-05; giữ `EmptyPassagesGate` cho test.
- [ ] Cập nhật `decide_answer_type` + test.
- [ ] Viết CLI `retrieval_dump` (chạy trong container API staging, đọc golden set qua volume, không gọi LLM).
- [ ] Viết `sweep_thresholds.py`, chạy, viết `calibration.md`.
- [ ] Chạy golden set đầu-cuối, cập nhật baseline nếu đạt (qua T03-01).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US011-4:** trên golden set v1, ≥ 90% câu `no_answer` nhận `answer_type = not_found` (KR2.2, ngưỡng đề xuất), đồng thời `auto_correct` nhóm có đáp án không giảm > 3 điểm % so với baseline.
- [ ] Điểm rerank cao nhất < τ_nf → `done.answer_type = not_found` và **không có lời gọi Claude** (kiểm bằng FakeLLM đếm số lần gọi = 0 và span `llm.stream` không xuất hiện).
- [ ] LLM trả đúng câu cố định → `answer_type = not_found`, không có cảnh báo partial; EV-09 `answer_type = not_found`.
- [ ] Message not_found có `text` chuẩn, `citations` rỗng (dữ liệu cho AC-US011-3 ở T03-03).
- [ ] `calibration.md` có bảng quét, giá trị chọn, lý do; `params_version` mới xuất hiện trong báo cáo golden set.
- [ ] Cấu hình `tau_keep > tau_nf` → app không khởi động.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `gate_decision` biên (= τ_nf → pass); `is_not_found_sentence`: nguyên văn, không dấu, có `**`, có thêm câu khác (→ False), tiếng Anh (→ False ở `vi`) |
| Unit | `decide_answer_type` bốn nhánh §4.3 |
| Integration | Câu "Thủ đô của Pháp là gì?" trên corpus mẫu → cổng chặn (FakeLLM không được gọi); `[fake:not_found]` → not_found từ lớp 2 |
| Golden set | Chạy trước/sau hiệu chỉnh; so sánh `not_found_recall`, `false_not_found_rate`, chi phí trung bình/câu |

## 8. Analytics / observability

- EV-09 `answer_type = not_found` (cả hai lớp). Để tách lớp, ghi `usage.gate` trong message và thuộc tính span `qa.gate.reason` (không thêm khoá vào EV-09 vì schema đóng — đề xuất bổ sung `not_found_source: gate | llm` nếu PO muốn đo trên dashboard, xem §10).
- Metric `cwd_answer_type_total{type}`, `cwd_gate_decisions_total{reason}`, histogram `cwd_retrieval_top_score`.
- Theo dõi tỷ lệ not_found trên pilot (PRD §6.2 "Tỷ lệ không tìm thấy") để phát hiện τ_nf lệch với tài liệu thật.

## 9. Tham chiếu

- [USER_STORIES.md — US-011](../../requirements/USER_STORIES.md)
- [SAD.md](../../requirements/SAD.md) §4.2 (bước 7–8, quy tắc 2), §7.3, §9.2, ADR-002
- [PRD.md](../../requirements/PRD.md) §2.2 KR2.1, KR2.2; §5.2 EC-14; §6.2 EV-09
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) S3 WP-31
- [T05-01](T05-01-follow-up-rewrite-history.md) (`llm_content` của lượt not_found)

## 10. Giả định và câu hỏi mở

- Giả định thang điểm rerank [0, 1] ổn định giữa các phiên bản TEI/model; đổi model rerank → hiệu chỉnh lại.
- **OQ-T0302-1:** Ngưỡng `gate_false_reject ≤ 2%` và `evidence_recall_kept ≥ 98%` là đề xuất; cần PO chấp thuận cách đánh đổi KR2.1/KR2.2.
- **OQ-T0302-2:** Thêm `not_found_source` vào EV-09 (PRD §6.2) để đo hai lớp? Cần PO quyết định; nếu có, cập nhật catalog T01-10.
- **OQ-T0302-3:** EC-14 lời chào ("Xin chào") bị cổng trả not_found; PRD muốn "trả lời ngắn và hướng dẫn cách hỏi". Đề xuất T03-03 hiển thị gợi ý cách hỏi trong khối not_found là đủ — cần PO chốt.
- **OQ-T0302-4:** Sơ đồ đường găng README nối T03-02 → T07-04 nhưng bảng S7 chỉ ghi T07-04 phụ thuộc T03-01. Đề nghị bổ sung T03-02 vào phụ thuộc của T07-04.
