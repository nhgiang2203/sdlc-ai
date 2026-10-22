# T00-09 — Golden set nháp v0 + bộ PDF mẫu

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | EN-02 (phần 1), WP-07 |
| Loại | QA, SME |
| Ước lượng | 4 ngày công (rải sprint: QA ~2,5; SME ~1,5 ≈ 4 giờ/tuần × 2 tuần + workshop) |
| Phụ thuộc | — |
| Chặn | [T00-05](T00-05-spike-llm-latency.md) (cần ≥ 20 câu đầu), [T02-10](T02-10-golden-set-runner.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Có bộ PDF mẫu không nhạy cảm (DEP-002) và file `eval/golden_set.v0.yaml` gồm **≥ 30 câu hỏi có đáp án chuẩn** do SME duyệt, phân bổ theo 6 nhóm của LG-02, đủ máy đọc được để spike EN-01 (T00-05) và runner (T02-10) dùng trực tiếp. **20 câu đầu phải xong trước 30/10/2026** để spike chạy kịp M1.

## 2. Bối cảnh

- PRD §6.1 LG-02: golden set ≥ 100 câu, gồm ít nhất 40% một tài liệu, 20% đa tài liệu, 15% không có đáp án, 10% diễn đạt khác, 10% tiếng Anh, 5% yêu cầu khuyến nghị (đề xuất). v0 giữ cùng tỷ lệ để số đo sớm so sánh được với v1 (T03-01).
- NFR-002: ≥ 85% đúng + trích dẫn đúng; ≥ 90% câu "không có đáp án" → not_found; 0 câu dùng kiến thức ngoài.
- BRD DEP-002 (bộ tài liệu mẫu, hạn 03/11), DEP-003 (bộ câu hỏi chuẩn + SME, hạn 06/11).
- IMPLEMENTATION_PLAN §6: golden set là tài sản quản lý phiên bản; **không chứa tài liệu mật trong repo** cho tới khi OQ-005/OQ-025 cho phép.
- RSK-010: câu hỏi về bảng cần có mặt sớm.

## 3. Phạm vi

**Trong phạm vi:**
- Chọn/tạo 10–15 PDF mẫu (có chữ) đại diện loại tài liệu BD: hợp đồng (≥ 2 phiên bản mâu thuẫn), báo giá, hồ sơ năng lực, biên bản họp, tài liệu tiếng Anh, tài liệu có bảng.
- Bộ file lỗi cho QA (dùng từ S1/S2): có mật khẩu, hỏng, scan, > 500 trang, > 50 MB, không phải PDF đổi đuôi, PDF scan một phần.
- Schema YAML §4.2, file `eval/golden_set.v0.yaml`, `eval/schema/golden_set.schema.json`, script kiểm tra `eval/validate_golden_set.py`.
- Hướng dẫn soạn câu cho SME (`eval/README.md`) và buổi workshop 1 giờ.

**Ngoài phạm vi:**
- Mở rộng lên ≥ 100 câu, chấm tự động, phiếu SME, cổng hồi quy → [T03-01](T03-01-golden-set-v1-scoring.md).
- Runner gọi API staging → [T02-10](T02-10-golden-set-runner.md).
- Nhóm câu prompt injection → [T03-04](T03-04-grounding-hardening.md) (v0 có thể thêm 1–2 câu thử, không tính vào tỷ lệ).

## 4. Thiết kế chi tiết

### 4.1 Bộ PDF mẫu

| Nguồn ưu tiên | Ghi chú |
|---|---|
| 1. Tài liệu đã công khai hoặc đã được Trưởng nhóm BD xác nhận không mật | Ghi người xác nhận + ngày trong `eval/corpus/MANIFEST.yaml` |
| 2. Tài liệu hư cấu do SME soạn theo mẫu thật (như prototype: dự án "Phú Hưng") | Xuất PDF có lớp chữ từ Word |
| 3. Tài liệu thật | **Chỉ khi OQ-005/OQ-025 cho phép**; lưu ở bucket staging có kiểm soát, không commit |

- Nguồn 1–2 được commit vào `eval/corpus/` (dùng Git LFS nếu tổng > 50 MB — đề xuất).
- `MANIFEST.yaml` mỗi file: `doc_key`, `filename`, `sha256`, `pages`, `language`, `has_tables`, `source` (public/fictional/real), `approved_by`, `approved_at`.
- Yêu cầu tối thiểu: ≥ 1 cặp tài liệu mâu thuẫn số liệu (cho câu đa tài liệu, US-012), ≥ 1 tài liệu tiếng Anh, ≥ 2 tài liệu có bảng, ≥ 1 tài liệu ≥ 100 trang, ≥ 1 tài liệu có trang scan một phần (EC-10).
- Bộ file lỗi đặt `eval/corpus/invalid/` với `MANIFEST` ghi `expected_error_reason` (`password_protected`, `corrupted`, `scanned`, `too_many_pages`, — và mã HTTP mong đợi 413/415 cho file quá lớn/không phải PDF). File > 50 MB sinh bằng script, không commit.

### 4.2 Schema câu hỏi (`golden_set.v0.yaml`)

```yaml
version: "0.1"
corpus_manifest: eval/corpus/MANIFEST.yaml
items:
  - id: GS-001
    category: single_doc        # single_doc | multi_doc | no_answer | paraphrase | english | recommendation
    tags: [table]               # tuỳ chọn: table, numeric, date, follow_up, injection
    language: vi                # vi | en (ngôn ngữ câu hỏi)
    question: "Điều khoản thanh toán của dự án Phú Hưng chia thành mấy đợt?"
    expected_answer_type: answered       # answered | partial | not_found
    reference_answer: "3 đợt: 30% tạm ứng trong 10 ngày; 50% sau nghiệm thu giai đoạn 1; 20% trong 15 ngày làm việc sau hồ sơ nghiệm thu cuối."
    key_facts:                  # ý bắt buộc phải có để tính "đúng" — dùng cho chấm tự động sau này
      - "30%"
      - "50%"
      - "20%"
    expected_citations:         # trang chứa bằng chứng; ít nhất 1 citation phải rơi vào một mục
      - {doc_key: hopdong_phuhung_v2, pages: [12, 13]}
    must_not_contain: []        # ví dụ cho recommendation: ["nên ký", "khuyến nghị"]
    follow_up_of: null          # id câu trước nếu là câu hỏi tiếp (dùng ở S5)
    scope_doc_keys: null        # null = toàn kho
    author: sme.<tên viết tắt>
    reviewed_by: qa.<tên viết tắt>
    notes: ""
```

Quy tắc theo nhóm:

| Nhóm | `expected_answer_type` | `expected_citations` | Ghi chú soạn |
|---|---|---|---|
| `single_doc` | `answered` | 1 tài liệu | Câu thật BD hay hỏi; ≥ 2 câu về bảng (tag `table`) |
| `multi_doc` | `answered` | ≥ 2 tài liệu | Có ≥ 1 câu mâu thuẫn số liệu (phải nêu cả hai giá trị — SAD §4.2 quy tắc 4) |
| `no_answer` | `not_found` | rỗng | Thông tin hợp lý nhưng **không có** trong kho; ≥ 1 câu kiến thức chung (NFR-002 "0 câu dùng kiến thức ngoài") |
| `paraphrase` | `answered` | như câu gốc | Diễn đạt khác của một câu `single_doc`; trường `notes` ghi id câu gốc |
| `english` | `answered` hoặc `not_found` | | Câu tiếng Anh trên tài liệu tiếng Việt và/hoặc ngược lại (US-015) |
| `recommendation` | `answered` (chỉ thông tin) | có | `must_not_contain` chứa cụm khuyến nghị (BRU-001, EC-15) |

### 4.3 Phân bổ v0 (≥ 30 câu, theo tỷ lệ LG-02)

| Nhóm | Tỷ lệ LG-02 | Số câu v0 | 20 câu đầu (hạn 30/10) |
|---|---|---|---|
| `single_doc` | 40% | 12 | 8 |
| `multi_doc` | 20% | 6 | 4 |
| `no_answer` | 15% | 5 | 3 |
| `paraphrase` | 10% | 3 | 2 |
| `english` | 10% | 3 | 2 |
| `recommendation` | 5% | 2 | 1 |
| **Cộng** | 100% | **31** | **20** |

Thêm (không tính tỷ lệ): 5 cặp câu hỏi tiếp (`follow_up_of`) cho spike đo bước viết lại (T00-05 §4.4).

### 4.4 Script kiểm tra (`eval/validate_golden_set.py`)

`python eval/validate_golden_set.py eval/golden_set.v0.yaml` kiểm tra: đúng JSON Schema; `id` duy nhất, dạng `GS-\d{3}`; `doc_key` tồn tại trong MANIFEST; `pages` trong khoảng `1..pages`; quy tắc theo nhóm §4.2 (ví dụ `no_answer` → `expected_citations` rỗng); tỷ lệ nhóm lệch ≤ 3 điểm % so với LG-02 (cảnh báo, không lỗi ở v0); `sha256` file trong `eval/corpus/` khớp MANIFEST. Chạy trong CI (thêm bước vào job `frontend/backend-quality` hoặc job `eval-lint` nhỏ — đề xuất).

### 4.5 Quy trình soạn

1. Workshop 1 giờ (QA + SME + Tech lead), tuần 1: giải thích 6 nhóm, schema, ví dụ từ prototype (`mock-data.js`: payment, warranty, price, team, advice).
2. SME soạn câu + đáp án + trang trong bảng tính chung; QA chuyển sang YAML và chạy validator.
3. QA kiểm chéo: mở PDF đúng trang xác nhận bằng chứng có ở đó (AC-US010-2 tinh thần).
4. Trưởng nhóm BD duyệt danh sách tài liệu (MANIFEST) và ký `approved_by`.
5. Gắn tag Git `golden-set-v0` khi đủ 31 câu.

## 5. Các bước thực hiện

- [ ] Ngày 1 (26/10): PO/Trưởng nhóm BD chỉ định SME, xác nhận nguồn tài liệu; lên lịch workshop.
- [ ] Viết schema JSON + validator + `eval/README.md` (QA).
- [ ] Thu thập/soạn 10–15 PDF, lập MANIFEST, xin duyệt (hạn DEP-002 03/11; 5 PDF đầu trước 29/10 để spike nạp).
- [ ] Soạn 20 câu đầu (hạn 30/10) → bàn giao T00-05.
- [ ] Soạn đủ 31 câu + 5 cặp hỏi tiếp (hạn 05/11).
- [ ] Chuẩn bị bộ file lỗi `invalid/` + script sinh file lớn.
- [ ] Gắn tag `golden-set-v0`; báo cáo độ phủ nhóm trong review sprint.

## 6. Tiêu chí hoàn thành

- [ ] `eval/golden_set.v0.yaml` có ≥ 30 câu có đáp án, validator xanh (WP-07, exit S0: "Golden set nháp ≥ 30 câu có đáp án").
- [ ] Đủ 6 nhóm theo LG-02, lệch tỷ lệ ≤ 3 điểm % (tiền đề EN-02: "phủ 6 nhóm câu theo LG-02").
- [ ] Mọi câu `answered` có ≥ 1 `expected_citations` được QA kiểm tra trên PDF.
- [ ] MANIFEST có người duyệt cho từng tài liệu; không có tài liệu nguồn `real` trong repo (IMPLEMENTATION_PLAN §6).
- [ ] 20 câu đầu bàn giao cho T00-05 trước 30/10/2026.

## 7. Kiểm thử

| Kịch bản | Kỳ vọng |
|---|---|
| Validator với file thiếu `expected_answer_type` | Lỗi schema |
| `no_answer` có `expected_citations` | Lỗi quy tắc nhóm |
| `doc_key` không có trong MANIFEST | Lỗi |
| Sửa 1 byte PDF trong `corpus/` | Lỗi sha256 |
| QA mở ngẫu nhiên 10 câu, đối chiếu trang | 10/10 có bằng chứng đúng trang |

## 8. Analytics / observability

Không phát sự kiện. Validator in thống kê phân bổ nhóm/tag để đưa vào báo cáo sprint. Kết quả đo của spike trên v0 (T00-05) là mốc nền đầu tiên cho NFR-002.

## 9. Tham chiếu

- PRD §6.1 LG-02, NFR-002; USER_STORIES §8 EN-02, US-009..US-012, US-015
- BRD DEP-002, DEP-003, RSK-004
- SAD §4.2 (quy tắc system prompt), §11.3 (golden set CI), RSK-010
- IMPLEMENTATION_PLAN §2.1 PA-06, §4 S0 WP-07, §6
- Prototype `docs/design/UI_UX_design/assets/mock-data.js` (ví dụ câu và trích dẫn)

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Giả định | SME dành ~4 giờ/tuần từ S0 (PA-06). |
| Đề xuất | Schema YAML §4.2 (`key_facts`, `must_not_contain`) để T03-01 chấm tự động mà không đổi định dạng. |
| Đề xuất | Dùng Git LFS cho `eval/corpus/` nếu vượt 50 MB. |
| OQ-005, OQ-025 | Được dùng tài liệu thật cho golden set? Tới khi có quyết định, chỉ dùng tài liệu công khai/hư cấu. |
| OQ-010, OQ-027 | Ngưỡng NFR-002 và tỷ lệ LG-02 đang là đề xuất. |
| Rủi ro | Tài liệu hư cấu có thể dễ hơn tài liệu thật → số đo spike lạc quan; ghi rõ trong báo cáo T00-05. |
