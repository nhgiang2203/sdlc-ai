# T05-09 — Time study MET-001: baseline trước pilot và đo cuối pilot

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) cho baseline; đo lần 2 trong tuần cuối pilot (15/03 – 19/03/2027) |
| Story / WP | MET-001, BO-001, OQ-001, DEP-003 (PRD §6.2 "Đo MET-001") |
| Loại | PO, SME (Business owner chủ trì; QA hỗ trợ) |
| Ước lượng | 2 ngày công baseline + 1,5 ngày công đo cuối pilot (cộng thời gian của 5 người tham gia, mỗi người ~1,5 giờ mỗi lần) |
| Phụ thuộc | [T03-01](T03-01-golden-set-v1-scoring.md) (bộ câu hỏi chuẩn có đáp án) |
| Chặn | Báo cáo sponsor sau pilot (26/03/2027); không chặn Gate review |
| Trạng thái | Todo |

## 1. Mục tiêu

Đo **thời gian trung bình để một nhân viên BD có câu trả lời** cho một câu hỏi trong bộ câu hỏi chuẩn, theo hai cách:
1. Cách làm hiện tại (mở PDF, Ctrl+F, hỏi đồng nghiệp): baseline, đo **trước pilot**.
2. Dùng công cụ: đo **cuối pilot**, cùng bộ câu hỏi và cùng nhóm người.

Kết quả là số liệu MET-001 cho báo cáo sponsor (J4). Telemetry không đo được chỉ số này (PRD §6.2).

## 2. Bối cảnh

- BRD MET-001: tổng thời gian trả lời ÷ số câu hỏi, đo cả cách làm hiện tại và khi dùng công cụ; target `[TBD: OQ-001]`.
- OQ-001 (Trưởng nhóm BD): hiện tại một nhân viên BD mất bao lâu cho một câu hỏi điển hình? Baseline của task này trả lời trực tiếp câu hỏi đó.
- T07-05 ghi time study là ngoài phạm vi UAT (OQ-177). Không task nào nhận, nên task này nhận.
- Baseline phải làm **trước khi người tham gia dùng công cụ**, nếu không kết quả bị lệch vì họ đã quen tài liệu và câu hỏi. Chọn S5 vì lúc đó golden set v1 đã ổn định (M3), còn người dùng BD chưa vào UAT (S7).

## 3. Phạm vi

**Trong phạm vi:** chọn câu hỏi, chọn người tham gia, kịch bản và phiếu ghi, hai buổi đo, phân tích, báo cáo.

**Ngoài phạm vi:**
- Chấm chất lượng câu trả lời của công cụ (NFR-002): [T03-01](T03-01-golden-set-v1-scoring.md), [T07-04](T07-04-final-regression.md).
- UAT: [T07-05](T07-05-uat-user-guide.md).

## 4. Thiết kế chi tiết

**Bộ câu hỏi đo (đề xuất)**
- 20 câu lấy từ golden set v1, phân bổ: 8 câu một tài liệu, 5 câu đa tài liệu, 3 câu diễn đạt khác, 2 câu tiếng Anh, 2 câu không có đáp án.
- Chia 2 bộ tương đương A và B, mỗi bộ 10 câu, để giảm hiệu ứng nhớ câu. Một nửa người tham gia làm bộ A ở baseline và bộ B ở cuối pilot; nửa còn lại làm ngược lại.
- Kho tài liệu: cùng một bộ PDF (≥ 30 file, đúng thư mục hoặc shared drive như cách làm thật) cho cả hai lần.

**Người tham gia:** 5–6 chuyên viên BD (PER-01) sẽ tham gia pilot, không tham gia soạn golden set.

**Quy trình mỗi câu**
1. Người điều phối đọc câu hỏi và bấm giờ bắt đầu.
2. Người tham gia tìm câu trả lời bằng cách được chỉ định. Baseline: mọi cách trừ công cụ. Cuối pilot: chỉ dùng công cụ, được mở trang trích dẫn để kiểm chứng.
3. Bấm giờ dừng khi người tham gia nói câu trả lời cuối cùng kèm nguồn (tên file + trang), hoặc khi nói "không tìm thấy".
4. Giới hạn 10 phút/câu. Quá giờ thì ghi `timeout` và tính 10 phút.
5. SME chấm câu trả lời: đúng / sai / một phần.

**Phiếu ghi** (`docs/implementation/met001/time_study_<lần>.csv`; không chứa nội dung tài liệu mật):

| Cột | Ý nghĩa |
|---|---|
| `participant_id` | Mã ẩn danh P01..P06 |
| `round` | `baseline` / `pilot_end` |
| `question_id` | ID trong golden set |
| `set` | A / B |
| `seconds` | Thời gian, giới hạn 600 |
| `outcome` | `correct` / `partial` / `wrong` / `timeout` / `not_found_correct` |
| `notes` | Quan sát của người điều phối (cách tìm, khó khăn) |

**Phân tích**
- Chỉ số chính: trung bình và trung vị `seconds` mỗi câu, tính theo từng vòng.
- Chỉ số phụ: tỷ lệ đúng; thời gian chỉ tính trên các câu trả lời đúng; tách theo nhóm câu.
- So sánh: chênh lệch (%) giữa hai vòng, kèm khoảng tin cậy bootstrap 95% (số mẫu nhỏ, nêu rõ hạn chế).

## 5. Các bước thực hiện

**Baseline (S5)**
- [ ] 04/01: Business owner chốt người tham gia và lịch (2 buổi, mỗi buổi ~1,5 giờ).
- [ ] 05/01: QA + SME chọn 20 câu, chia bộ A/B, chuẩn bị kho tài liệu và phiếu ghi.
- [ ] 06/01: chạy thử với 1 người để chỉnh kịch bản.
- [ ] 07/01 – 13/01: chạy baseline với 5–6 người.
- [ ] 15/01: tổng hợp baseline; Trưởng nhóm BD đóng OQ-001 bằng số liệu; sponsor chốt target MET-001 (OQ-027).

**Cuối pilot**
- [ ] 15/03 – 18/03/2027: chạy vòng `pilot_end` với cùng người tham gia, mỗi người làm bộ còn lại.
- [ ] 19/03: phân tích, đưa kết quả vào báo cáo sponsor (26/03).

## 6. Tiêu chí hoàn thành

- [ ] Có số liệu baseline của ≥ 5 người × 10 câu trước 15/01/2027; OQ-001 được đóng.
- [ ] Target MET-001 được sponsor chốt dựa trên baseline (hoặc ghi nhận là chưa chốt).
- [ ] Có số liệu vòng cuối pilot với cùng người tham gia; báo cáo nêu chỉ số chính, chỉ số phụ, khoảng tin cậy và hạn chế.
- [ ] Phiếu ghi không chứa tên người tham gia hay nội dung tài liệu.

## 7. Kiểm thử

Không có kiểm thử phần mềm. Kiểm soát chất lượng đo:
- Chạy thử trước để chỉnh kịch bản.
- Cùng một người điều phối và cùng cách bấm giờ cho cả hai vòng.
- SME thứ hai chấm lại ngẫu nhiên 20% số câu; nếu kết quả lệch > 10% thì thống nhất lại tiêu chí chấm.

## 8. Analytics / observability

- Không dùng telemetry của sản phẩm làm số liệu chính. Ở vòng cuối pilot, tài khoản của người tham gia vẫn phát EV-08/EV-09/EV-12 như bình thường. Trong báo cáo có thể đối chiếu `total_ms` với thời gian đo, để tách thời gian chờ hệ thống khỏi thời gian kiểm chứng.
- Đánh dấu khoảng thời gian chạy time study để PO loại các phiên này khỏi số liệu WAU của pilot (đề xuất).

## 9. Tham chiếu

- BRD BO-001, MET-001, OQ-001, DEP-003; PRD §6.2 (Đo MET-001, nhịp xem số liệu), J4.
- [T03-01](T03-01-golden-set-v1-scoring.md), [T07-05](T07-05-uat-user-guide.md) (OQ-177).

## 10. Giả định và câu hỏi mở

- OQ-177 (từ T07-05): task này là câu trả lời đề xuất.
- OQ-001, OQ-027 (kế thừa): baseline dùng để chốt target.
- Giả định: người tham gia chưa dùng công cụ trước baseline. Nếu ai đã dùng ở UAT hoặc demo thì ghi chú và phân tích riêng.
- Câu hỏi: có được dùng tài liệu thật cho time study không? Phụ thuộc OQ-005 cho vòng cuối pilot; baseline không gửi dữ liệu ra ngoài nên không bị ảnh hưởng.
