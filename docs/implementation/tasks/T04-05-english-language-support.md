# T04-05 — Hỗ trợ tiếng Anh và truy xuất chéo ngôn ngữ

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S4 (21/12/2026 – 01/01/2027) |
| Story / WP | US-015 · WP-42 |
| Loại | BE, QA |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T02-05](T02-05-ask-question-sse.md), [T03-01](T03-01-golden-set-v1-scoring.md) (golden set v1 + chấm tự động); liên quan [T03-02](T03-02-not-found-gate-calibration.md), [T03-04](T03-04-grounding-hardening.md) (prompt v2) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Câu hỏi tiếng Anh nhận câu trả lời tiếng Anh với cùng quy tắc trích dẫn và "không tìm thấy" (thông báo bằng tiếng Anh); câu hỏi tiếng Việt về nội dung chỉ có trong tài liệu tiếng Anh vẫn được trả lời bằng tiếng Việt kèm trích dẫn; chất lượng nhóm tiếng Anh đạt cùng ngưỡng NFR-002; ghi `language` cho EV-08.

## 2. Bối cảnh

- SAD §4.2: system prompt quy tắc 6 (trả lời bằng ngôn ngữ của câu hỏi), quy tắc 2 (câu cố định not_found — hiện chỉ có bản tiếng Việt); cổng τ_nf (bước 8) trả `not_found` **không gọi LLM**, nên câu thông báo phải do hệ thống chọn theo ngôn ngữ; §9.2: hệ thống nhận diện câu cố định để gán `answer_type`.
- ADR-004: bge-m3 đa ngôn ngữ (dense) cho phép truy xuất chéo ngôn ngữ; bge-reranker-v2-m3 đa ngôn ngữ. Nhánh toàn văn dùng cấu hình `simple` + `f_unaccent`, **không** khớp chéo ngôn ngữ → câu chéo ngôn ngữ phụ thuộc nhánh vector trong RRF.
- PRD §6.2 EV-08 `language` (vi / en / other); LG-02: ≥ 10% câu tiếng Anh trong golden set.
- UX-12: giao diện tiếng Việt; riêng nội dung câu trả lời và khối not_found theo ngôn ngữ câu hỏi (AC-US015-1).

## 3. Phạm vi

**Trong phạm vi:** hàm phát hiện ngôn ngữ (domain); cột `conv.messages.language`; câu not_found tiếng Anh ở cổng ngưỡng và trong system prompt; nhận diện câu cố định hai ngôn ngữ; trường `language` trong SSE `done` và schema `Message`; thay đổi nhỏ ở FE `AnswerMessage` cho khối not_found tiếng Anh; nhóm câu tiếng Anh/chéo ngôn ngữ trong golden set; báo cáo chất lượng.

**Ngoài phạm vi:** dịch giao diện sang tiếng Anh (không có yêu cầu); ngôn ngữ khác ngoài vi/en (chờ OQ-006); bước viết lại câu hỏi giữ ngôn ngữ ([T05-01](T05-01-follow-up-rewrite-history.md) dùng `language` của task này).

## 4. Thiết kế chi tiết

### 4.1 Phát hiện ngôn ngữ

`backend/cwd/domain/conversations/language.py` — hàm thuần, không phụ thuộc thư viện (đề xuất; tránh thêm model và giấy phép):

```python
def detect_language(text: str) -> Literal["vi", "en", "other"]: ...
```

1. Bỏ URL, số, ký hiệu; tách token chữ cái; < 2 token → `"vi"` (mặc định theo giao diện, đề xuất).
2. Có ký tự đặc thù tiếng Việt (`đ ă â ê ô ơ ư` hoặc nguyên âm mang dấu thanh, sau NFC) chiếm ≥ 1 ký tự → `"vi"`.
3. Tỷ lệ token thuộc danh sách stopword tiếng Anh (~150 từ: *the, what, is, of, payment, ...* — chỉ từ chức năng) ≥ 0,2 và lớn hơn tỷ lệ stopword tiếng Việt không dấu (*la, cua, va, khong, duoc, cho, trong, nhung, thi, bao, nhieu, gi* …) → `"en"`.
4. Tỷ lệ stopword tiếng Việt không dấu ≥ 0,2 → `"vi"`.
5. Còn lại: chữ Latin → `"en"`; không phải Latin → `"other"`.

Bộ kiểm thử `backend/tests/unit/domain/test_language.py` với ≥ 200 câu có nhãn (100 vi có dấu, 30 vi không dấu, 60 en, 10 khác/trộn) — độ chính xác ≥ 95% (đề xuất).

### 4.2 Lưu và phát

- Migration expand: `ALTER TABLE conv.messages ADD COLUMN language text NULL CHECK (language IN ('vi','en','other'));` — ghi cho cả message user và assistant (cùng giá trị).
- `AskQuestion`: tính `language` ở bước 1 (trên câu hỏi gốc); đưa vào EV-08 (server-side).
- SSE `done`: thêm `language` (đề xuất, bổ sung SAD §10.3); schema `Message` (assistant) trong `GET /conversations/{id}` thêm `language`.

### 4.3 Câu "không tìm thấy" hai ngôn ngữ

`backend/cwd/domain/conversations/not_found.py`:

```python
NOT_FOUND_TEXT = {
    "vi": "Không tìm thấy thông tin này trong các tài liệu hiện có.",
    "en": "This information was not found in the available documents.",  # (đề xuất)
}
def is_not_found_sentence(text: str) -> bool  # chuẩn hoá NFC, bỏ dấu câu cuối, so cả hai bản
```

- Cổng τ_nf: `message.text = NOT_FOUND_TEXT[lang if lang in ("vi","en") else "vi"]`.
- System prompt: sửa quy tắc 2 để nêu cả câu tiếng Anh khi câu hỏi tiếng Anh → tạo `prompt_version` mới (phối hợp T03-04; thay đổi phải qua golden set). Không đưa ngôn ngữ đã phát hiện vào system prompt (giữ system prompt cố định để cache, SAD §4.2) — mô hình tự theo quy tắc 6.
- `is_not_found_sentence` dùng cho cả hai bản khi gán `answer_type` (thay hàm một ngôn ngữ của T03-02).

### 4.4 Thay đổi FE nhỏ

`frontend/src/features/chat/AnswerMessage.tsx` (khối not_found của T03-03): khi `message.language === "en"` hiển thị tiêu đề `NOT_FOUND_TEXT.en`, dòng phạm vi "Searched {n} documents." và gợi ý "Try rephrasing, check the document scope, or add relevant documents." (đề xuất); chuỗi đặt trong `lib/i18n/answer.en.ts`. Phần còn lại của giao diện giữ tiếng Việt.

### 4.5 Golden set

Phối hợp QA/SME bổ sung vào `eval/golden_set.v1.yaml` (T03-01 sở hữu file; task này thêm mục, gắn thẻ `lang`):

| Nhóm | Số câu tối thiểu | Ví dụ |
|---|---|---|
| `en` một tài liệu (tài liệu tiếng Anh) | 6 | "What is the warranty period in contract X?" |
| `en` không có đáp án | 2 | — |
| `en` hỏi trên tài liệu tiếng Việt | 2 | — |
| `cross_vi_en` (hỏi tiếng Việt, đáp án chỉ trong tài liệu tiếng Anh) | 5 (đề xuất) | — |

Tổng câu tiếng Anh ≥ 10% golden set (LG-02). Chấm tự động thêm tiêu chí "ngôn ngữ câu trả lời = ngôn ngữ câu hỏi" (dùng `detect_language` trên câu trả lời).

## 5. Các bước thực hiện

- [ ] Viết `detect_language` + bộ 200 câu nhãn.
- [ ] Migration `language`; cập nhật `AskQuestion`, EV-08, SSE `done`, schema `Message`.
- [ ] `NOT_FOUND_TEXT` + `is_not_found_sentence` hai ngôn ngữ; nối cổng τ_nf.
- [ ] Prompt mới (quy tắc 2 song ngữ) → chạy golden set trước/sau.
- [ ] Sửa FE khối not_found tiếng Anh + test component.
- [ ] Bổ sung nhóm câu golden set; SME chấm nhóm `en` và `cross_vi_en`.
- [ ] Nếu nhóm chéo ngôn ngữ thấp: thử tăng top-k vector (40 → 60) hoặc trọng số RRF cho nhánh vector khi `language` khác ngôn ngữ tài liệu (ghi kết quả, không đổi nếu không cải thiện).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US015-1:** câu hỏi tiếng Anh → câu trả lời tiếng Anh có trích dẫn; câu không có đáp án → "This information was not found in the available documents." ở cả hai đường (cổng ngưỡng và câu cố định của LLM), `answer_type = not_found`, FE hiển thị khối not_found tiếng Anh.
- [ ] **AC-US015-2:** ≥ 80% câu `cross_vi_en` được SME chấm đúng, trả lời tiếng Việt và trích dẫn tài liệu tiếng Anh (đề xuất ngưỡng; chờ OQ-010).
- [ ] **AC-US015-3:** nhóm câu tiếng Anh đạt cùng ngưỡng NFR-002 như tiếng Việt (≥ 85% đúng + trích dẫn đúng; ≥ 90% not_found đúng) trong báo cáo golden set.
- [ ] EV-08 có `language` ∈ {vi, en, other} cho 100% câu hỏi trên staging; độ chính xác `detect_language` ≥ 95% trên bộ nhãn.
- [ ] Golden set toàn bộ không hồi quy > 3 điểm %.

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | `detect_language` (bộ 200 câu, câu 1 từ, câu trộn "Điều khoản payment terms là gì?" → `vi`); `is_not_found_sentence` có/không dấu chấm, khoảng trắng thừa, NFD |
| Integration (`FakeLLMAdapter`) | Cổng τ_nf với câu tiếng Anh → `text` tiếng Anh, `done.language = "en"`; Fake trả câu cố định tiếng Anh → `answer_type = not_found` |
| Component (FE) | Khối not_found `language = "en"` hiển thị chuỗi tiếng Anh |
| Chất lượng (staging, Claude thật) | Golden set có nhóm `en`, `cross_vi_en`; báo cáo theo nhóm đính kèm PR |

## 8. Analytics / observability

- EV-08 `language` (P0) — chỉ mã ngôn ngữ, không có nội dung.
- Báo cáo golden set tách số liệu theo `lang`; metric `cwd_answer_type_total{type, language}` (đề xuất thêm nhãn `language`, lực lượng nhãn nhỏ).

## 9. Tham chiếu

USER_STORIES US-015; PRD §6.1 LG-02, §6.2 EV-08, UX-12; SAD §4.2 (system prompt, cổng τ_nf), §7.2 (FTS `simple`), §9.2, §10.3, ADR-004; BRD BR-013, OQ-006.

## 10. Giả định và câu hỏi mở

- Giả định: DEP-002 cung cấp ≥ 3 PDF tiếng Anh không nhạy cảm cho golden set.
- **OQ-T0405-01:** Câu not_found tiếng Anh chính xác là gì? PO/UX writer chốt (đề xuất ở §4.3); câu này phải khớp nguyên văn giữa system prompt, cổng ngưỡng và bộ nhận diện.
- **OQ-T0405-02:** Ngôn ngữ khác (ví dụ tiếng Trung) có trong phạm vi không (OQ-006)? Hiện `other` → trả lời theo ngôn ngữ câu hỏi nhưng not_found tiếng Việt.
- **OQ-T0405-03:** Ngưỡng riêng cho nhóm chéo ngôn ngữ (AC-US015-2) chưa có trong nguồn; đề xuất 80%.
