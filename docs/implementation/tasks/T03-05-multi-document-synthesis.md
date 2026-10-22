# T03-05 — Tổng hợp đa tài liệu và mâu thuẫn

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S3 (07/12 – 18/12/2026) |
| Story / WP | US-012 · WP-33 |
| Loại | BE, QA |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T03-01](T03-01-golden-set-v1-scoring.md) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Bảo đảm câu hỏi cần thông tin từ ≥ 2 tài liệu nhận được câu trả lời tổng hợp có trích dẫn tới **từng** tài liệu, và khi các tài liệu mâu thuẫn thì câu trả lời nêu đủ các giá trị kèm nguồn, nói rõ có mâu thuẫn, không tự chọn. Đo riêng hai tầng: truy xuất (top 8 có trải đủ tài liệu không) và sinh câu trả lời (LLM có dùng và trích dẫn đủ không); xác minh EV-09 `distinct_docs_cited` trên staging.

## 2. Bối cảnh

- US-012 (P0, BR-010). Ghi chú kỹ thuật: top 8 sau rerank có thể đến từ nhiều tài liệu; **không giới hạn số đoạn mỗi tài liệu ở MVP**; quy tắc mâu thuẫn nằm trong system prompt (quy tắc 4, SAD §4.2).
- ADR-005 chọn Opus vì chất lượng tổng hợp đa tài liệu (D1).
- [T03-01](T03-01-golden-set-v1-scoring.md): nhóm `multi_doc` ≥ 20 câu, ≥ 5 câu `contradiction` có `expected_conflict_values`; chỉ số `multi_doc_recall`, `retrieval_evidence_at_8`.
- Dữ liệu mẫu có sẵn cặp hợp đồng v1/v2 và báo giá (prototype [mock-data.js](../../design/UI_UX_design/assets/mock-data.js): `HopDong_PhuHung_v1.pdf`, `HopDong_PhuHung_v2_DaKy.pdf`, `BaoGia_PhuHung_0209.pdf`).

## 3. Phạm vi

**Trong phạm vi:**
- Phân tích lỗi nhóm `multi_doc` theo tầng (truy xuất / LLM).
- Chỉ số truy xuất `doc_coverage_at_8` và báo cáo phân bố số tài liệu trong top 8.
- Thử nghiệm có cờ (mặc định tắt) đa dạng hoá tài liệu trong top 8 nếu truy xuất là nút thắt.
- Đóng góp nội dung quy tắc 4 cho `answer.v2` (cùng [T03-04](T03-04-grounding-hardening.md)).
- Xác minh EV-09 `distinct_docs_cited`.

**Ngoài phạm vi:**
- Prompt v2 chung, injection → [T03-04](T03-04-grounding-hardening.md).
- Giới hạn phạm vi tài liệu → [T04-03](T04-03-scope-filter-api.md).
- Hiển thị trích dẫn nhiều tài liệu (đã có ở [T02-07](T02-07-fe-answer-citations.md)).
- Thay đổi mặc định "không giới hạn số đoạn mỗi tài liệu" khi chưa có quyết định của Architect.

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `eval/analysis/multi_doc.py` | Đọc `dump.jsonl` (CLI của T03-02) + `results.jsonl` → báo cáo theo tầng |
| `backend/cwd/application/qa/retrieval.py` | (Thử nghiệm) `diversify_by_document(passages, min_docs)` sau rerank, cờ `CWD_RETRIEVAL_DIVERSIFY=false` |
| `backend/prompts/answer/v2.md` | Quy tắc 4 (phối hợp T03-04) |
| `eval/reports/multi_doc_s3.md` | Báo cáo phân tích |

### 4.2 Chỉ số

| Chỉ số | Định nghĩa | Tầng |
|---|---|---|
| `doc_coverage_at_8` | Với câu `multi_doc`: số `doc_key` trong `expected_citations` có ≥ 1 đoạn bằng chứng trong top 8 ÷ tổng `doc_key` | Truy xuất |
| `distinct_docs_top8` | Phân bố số tài liệu khác nhau trong top 8 (mọi câu) | Truy xuất |
| `multi_doc_recall` (T03-01) | Số `doc_key` được trích dẫn ÷ tổng | LLM |
| `conflict_complete` | Câu `contradiction`: mọi `expected_conflict_values` có mặt **và** mỗi giá trị đi kèm citation tới tài liệu chứa nó **và** có từ chỉ mâu thuẫn ("mâu thuẫn", "khác nhau", "không thống nhất" sau chuẩn hoá) | LLM |
| `distinct_docs_cited` | Từ EV-09 / `done`, đối chiếu với citation trong `results.jsonl` | Analytics |

Phân loại lỗi mỗi câu sai: `retrieval_miss` (`doc_coverage_at_8 < 1`) hoặc `generation_miss` (bằng chứng có trong top 8 nhưng không được dùng/trích).

### 4.3 Quy tắc 4 trong prompt v2 (đề xuất nội dung)

> Nếu các tài liệu ghi các giá trị khác nhau cho cùng một thông tin (ví dụ hai phiên bản hợp đồng ghi giá khác nhau), hãy nêu **từng giá trị cùng tài liệu chứa nó**, nói rõ "Các tài liệu có thông tin mâu thuẫn", và không tự chọn hay suy luận giá trị nào đúng. Có thể nêu dữ kiện giúp người đọc phân biệt (ngày, số phiên bản, trạng thái "đã ký") nếu tài liệu ghi rõ.

Khi câu hỏi cần nhiều tài liệu (giá ở báo giá, thời hạn thanh toán ở hợp đồng): tổng hợp thành một câu trả lời, mỗi ý dựa trên trích dẫn của tài liệu tương ứng.

### 4.4 Thử nghiệm đa dạng hoá (chỉ khi `retrieval_miss` chiếm > 50% lỗi `multi_doc`)

- `diversify_by_document(passages, min_docs=2)`: sau rerank, nếu top 8 chỉ có 1 tài liệu mà trong 30 ứng viên có tài liệu khác với điểm ≥ τ_keep, thay đoạn có điểm thấp nhất bằng đoạn tốt nhất của tài liệu khác (đề xuất).
- Chạy golden set v1 hai cấu hình (tắt/bật); bật mặc định **chỉ** khi `multi_doc_recall` tăng ≥ 5 điểm % và không nhóm nào giảm > 3 điểm %; cần Architect duyệt vì khác ghi chú US-012.

## 5. Các bước thực hiện

- [ ] Kiểm golden set v1 có đủ ≥ 20 câu `multi_doc`, ≥ 5 `contradiction` (cùng T03-01); bổ sung cặp tài liệu mâu thuẫn nếu thiếu.
- [ ] Chạy dump truy xuất (CLI T03-02) và golden set; viết `multi_doc.py`, tạo báo cáo theo tầng.
- [ ] Soạn quy tắc 4 cho `answer.v2`, đưa vào vòng tinh chỉnh của T03-04.
- [ ] (Có điều kiện) cài `diversify_by_document` sau cờ, chạy so sánh.
- [ ] Đối chiếu EV-09 `distinct_docs_cited` trên staging với citation thực tế của 20 câu.
- [ ] SME chấm nhóm `multi_doc` (phiếu T03-01), viết `multi_doc_s3.md`.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US012-1:** câu cần thông tin của ≥ 2 tài liệu (ví dụ giá trong `BaoGia_PhuHung_0209.pdf` + thời hạn thanh toán trong `HopDong_PhuHung_v2_DaKy.pdf`) → câu trả lời kết hợp cả hai và có citation tới từng tài liệu (`multi_doc_recall = 1` cho câu đó; SME xác nhận).
- [ ] **AC-US012-2:** 100% câu `contradiction` đạt `conflict_complete` (nêu cả hai giá trị, trích dẫn từng nguồn, nói rõ mâu thuẫn, không tự chọn) — SME xác nhận.
- [ ] **AC-US012-3:** tỷ lệ câu `multi_doc` được SME chấm đầy đủ và trích dẫn đủ tài liệu liên quan đạt ngưỡng OQ-010 (đề xuất ≥ 80% cho tới khi chốt).
- [ ] Báo cáo `multi_doc_s3.md` có phân loại lỗi `retrieval_miss` / `generation_miss` và đề xuất cho S4–S5.
- [ ] EV-09 `distinct_docs_cited` khớp số tài liệu phân biệt trong citation ở 20/20 câu kiểm tra trên staging.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `doc_coverage_at_8`, `conflict_complete` (thiếu từ chỉ mâu thuẫn → False); `diversify_by_document` (không thay khi đã ≥ 2 tài liệu; tôn trọng τ_keep) |
| Golden set | Nhóm `multi_doc` với `answer.v1` → `answer.v2`; (nếu có) cờ đa dạng hoá tắt/bật |
| Thủ công | 5 câu mâu thuẫn ngoài golden set do SME đặt trên cặp hợp đồng v1/v2 |

## 8. Analytics / observability

- EV-09 `distinct_docs_cited` (tính ở T02-05) — xác minh trên staging; dùng để theo dõi tỷ lệ câu trả lời đa tài liệu trong pilot.
- Thuộc tính span `qa.retrieve.distinct_docs_top8` (đề xuất) để theo dõi phân bố trên prod mà không lưu nội dung.

## 9. Tham chiếu

- [USER_STORIES.md — US-012](../../requirements/USER_STORIES.md)
- [SAD.md](../../requirements/SAD.md) §4.2 (bước 7, quy tắc 4), ADR-002, ADR-005
- [PRD.md](../../requirements/PRD.md) §6.1 LG-02 (20% câu đa tài liệu), §6.2 EV-09
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) S3 WP-33

## 10. Giả định và câu hỏi mở

- Giả định T03-02 cung cấp CLI dump truy xuất có điểm 30 ứng viên.
- **OQ-T0305-1:** Ngưỡng AC-US012-3 phụ thuộc OQ-010 (chưa chốt); đề xuất ≥ 80%.
- **OQ-T0305-2:** Nếu truy xuất là nút thắt, có cho phép đa dạng hoá theo tài liệu (lệch ghi chú "không giới hạn số đoạn mỗi tài liệu" của US-012) hoặc tăng top 8 → 10 (lệch PR-02 "≤ 8 đoạn")? Cần Architect + Bảo mật thông tin quyết định.
- **OQ-T0305-3:** Câu mâu thuẫn giữa bản nháp và bản đã ký: có nên ưu tiên nêu bản "đã ký" trước không? Quy tắc 4 cấm tự chọn; đề xuất chỉ nêu dữ kiện, không xếp ưu tiên.
