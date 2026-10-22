/* Dữ liệu mẫu cho prototype — toàn bộ tên dự án, công ty, người là hư cấu. */
window.CWD_DATA = (function () {
  "use strict";

  const documents = [
    { id: "d1", filename: "HopDong_PhuHung_v2_DaKy.pdf", status: "READY", pageCount: 42, sizeBytes: 3355443, uploadedBy: "Trần Quốc Bảo", uploadedAt: "14/10/2026 09:12", unreadablePages: 0 },
    { id: "d2", filename: "BaoGia_PhuHung_0209.pdf", status: "READY", pageCount: 8, sizeBytes: 912384, uploadedBy: "Nguyễn Thu Hà", uploadedAt: "12/10/2026 15:40", unreadablePages: 0 },
    { id: "d3", filename: "HoSoNangLuc_CongTy_2026.pdf", status: "READY", pageCount: 36, sizeBytes: 7340032, uploadedBy: "Trần Quốc Bảo", uploadedAt: "10/10/2026 10:05", unreadablePages: 2 },
    { id: "d4", filename: "HopDong_PhuHung_v1.pdf", status: "READY", pageCount: 40, sizeBytes: 3145728, uploadedBy: "Nguyễn Thu Hà", uploadedAt: "02/09/2026 08:30", unreadablePages: 0 },
    { id: "d5", filename: "BienBanHop_PhuHung_1510.pdf", status: "PROCESSING", pageCount: 6, sizeBytes: 524288, uploadedBy: "Trần Quốc Bảo", uploadedAt: "21/10/2026 08:55", unreadablePages: 0 },
    { id: "d6", filename: "GiayPhepKinhDoanh_Scan.pdf", status: "FAILED", errorReason: "scanned", pageCount: 3, sizeBytes: 2097152, uploadedBy: "Nguyễn Thu Hà", uploadedAt: "20/10/2026 16:20", unreadablePages: 3 }
  ];

  const errorText = {
    password_protected: "File có mật khẩu. Hãy gỡ mật khẩu rồi tải lại.",
    corrupted: "File bị hỏng, không mở được. Hãy xuất lại PDF rồi tải lại.",
    scanned: "PDF dạng ảnh scan — chưa hỗ trợ. Hãy dùng bản PDF có chữ chọn được.",
    too_many_pages: "File vượt quá 500 trang.",
    other: "Lỗi xử lý, vui lòng thử tải lại."
  };

  // Nội dung các trang được trích dẫn (trang khác sinh nội dung chung)
  const pages = {
    d1: {
      12: { heading: "Điều 5. Giá trị hợp đồng và phương thức thanh toán", paras: [
        "5.1. Tổng giá trị hợp đồng là 2.450.000.000 đồng (Hai tỷ bốn trăm năm mươi triệu đồng), đã bao gồm thuế giá trị gia tăng.",
        "5.2. Đợt 1: Bên A tạm ứng 30% giá trị hợp đồng trong vòng 10 ngày kể từ ngày ký hợp đồng.",
        "5.3. Đợt 2: Bên A thanh toán 50% giá trị hợp đồng sau khi hai bên ký biên bản nghiệm thu giai đoạn 1."] },
      13: { heading: "Điều 5. (tiếp theo)", paras: [
        "5.4. Đợt 3: Bên A thanh toán 20% giá trị còn lại trong vòng 15 ngày làm việc kể từ ngày nhận đủ hồ sơ nghiệm thu cuối cùng và hoá đơn hợp lệ.",
        "5.5. Hình thức thanh toán: chuyển khoản vào tài khoản của Bên B ghi tại Phụ lục 02."] },
      18: { heading: "Điều 9. Bảo hành", paras: [
        "9.1. Thời hạn bảo hành là 12 tháng kể từ ngày ký biên bản nghiệm thu cuối cùng.",
        "9.2. Bảo hành không áp dụng với hư hỏng do Bên A tự ý thay đổi cấu hình hệ thống."] },
      19: { heading: "Điều 9. (tiếp theo)", paras: [
        "9.3. Trong thời gian bảo hành, Bên B phản hồi yêu cầu xử lý sự cố trong vòng 4 giờ làm việc và khắc phục trong vòng 3 ngày làm việc."] },
      25: { heading: "Điều 12. Phạt vi phạm", paras: [
        "12.1. Trường hợp Bên B chậm tiến độ, Bên B chịu phạt 0,1% giá trị phần việc chậm cho mỗi ngày chậm, tổng mức phạt không vượt quá 8% giá trị hợp đồng.",
        "12.2. Bên A có quyền đơn phương chấm dứt hợp đồng nếu Bên B chậm tiến độ quá 30 ngày."] }
    },
    d2: {
      3: { heading: "Bảng tổng hợp chi phí", paras: [
        "Tổng chi phí triển khai: 2.450.000.000 đồng (đã gồm VAT 10%).",
        "Báo giá có hiệu lực 60 ngày kể từ ngày 02/09/2026."] }
    },
    d3: {
      7: { heading: "Năng lực nhân sự", paras: [
        "Đội dự án dự kiến gồm 12 người: 1 quản lý dự án, 2 chuyên gia nghiệp vụ kho vận, 6 kỹ sư phát triển và 3 kỹ sư kiểm thử.",
        "Quản lý dự án có hơn 10 năm kinh nghiệm triển khai hệ thống quản lý kho."] }
    },
    d4: {
      11: { heading: "Điều 5. Giá trị hợp đồng", paras: [
        "5.1. Tổng giá trị hợp đồng là 2.300.000.000 đồng, đã bao gồm thuế giá trị gia tăng.",
        "5.2. Tiến độ thanh toán theo Phụ lục 03."] }
    }
  };

  // Kịch bản câu trả lời. segments: {t: text} | {c: chỉ số trích dẫn} | {p: true} (ngắt đoạn)
  const answers = {
    payment: {
      answerType: "answered",
      segments: [
        { t: "Theo hợp đồng dự án Phú Hưng (bản đã ký), việc thanh toán chia thành 3 đợt:" }, { p: true },
        { li: "Đợt 1: tạm ứng 30% giá trị hợp đồng trong vòng 10 ngày kể từ ngày ký " }, { c: 1 },
        { li: "Đợt 2: 50% sau khi hai bên ký biên bản nghiệm thu giai đoạn 1 " }, { c: 1 },
        { li: "Đợt 3: 20% còn lại trong vòng 15 ngày làm việc kể từ khi nhận đủ hồ sơ nghiệm thu cuối cùng và hoá đơn hợp lệ " }, { c: 2 },
        { p: true }, { t: "Hình thức thanh toán là chuyển khoản theo Phụ lục 02 " }, { c: 2 }, { t: "." }
      ],
      citations: [
        { idx: 1, doc: "d1", pageStart: 12, pageEnd: 12, cited: "Đợt 1: Bên A tạm ứng 30% giá trị hợp đồng trong vòng 10 ngày kể từ ngày ký hợp đồng." },
        { idx: 2, doc: "d1", pageStart: 13, pageEnd: 13, cited: "Đợt 3: Bên A thanh toán 20% giá trị còn lại trong vòng 15 ngày làm việc kể từ ngày nhận đủ hồ sơ nghiệm thu cuối cùng và hoá đơn hợp lệ." }
      ]
    },
    warranty: {
      answerType: "answered",
      segments: [
        { t: "Thời hạn bảo hành của dự án Phú Hưng là 12 tháng kể từ ngày ký biên bản nghiệm thu cuối cùng " }, { c: 1 }, { t: "." }, { p: true },
        { t: "Trong thời gian bảo hành, bên triển khai phải phản hồi yêu cầu xử lý sự cố trong vòng 4 giờ làm việc và khắc phục trong vòng 3 ngày làm việc " }, { c: 2 }, { t: "." }
      ],
      citations: [
        { idx: 1, doc: "d1", pageStart: 18, pageEnd: 18, cited: "9.1. Thời hạn bảo hành là 12 tháng kể từ ngày ký biên bản nghiệm thu cuối cùng." },
        { idx: 2, doc: "d1", pageStart: 19, pageEnd: 19, cited: "Bên B phản hồi yêu cầu xử lý sự cố trong vòng 4 giờ làm việc và khắc phục trong vòng 3 ngày làm việc." }
      ]
    },
    price: {
      answerType: "answered",
      segments: [
        { t: "Các tài liệu ghi tổng giá trị hợp đồng **không thống nhất**:" }, { p: true },
        { li: "2.450.000.000 đồng (đã gồm VAT) trong hợp đồng bản đã ký (v2) " }, { c: 1 },
        { li: "2.300.000.000 đồng (đã gồm VAT) trong hợp đồng bản v1 " }, { c: 2 },
        { li: "Báo giá ngày 02/09/2026 ghi 2.450.000.000 đồng, khớp với bản v2 " }, { c: 3 },
        { p: true }, { t: "Hãy đối chiếu phiên bản hợp đồng nào là bản có hiệu lực trước khi sử dụng con số này." }
      ],
      citations: [
        { idx: 1, doc: "d1", pageStart: 12, pageEnd: 12, cited: "5.1. Tổng giá trị hợp đồng là 2.450.000.000 đồng (Hai tỷ bốn trăm năm mươi triệu đồng), đã bao gồm thuế giá trị gia tăng." },
        { idx: 2, doc: "d4", pageStart: 11, pageEnd: 11, cited: "5.1. Tổng giá trị hợp đồng là 2.300.000.000 đồng, đã bao gồm thuế giá trị gia tăng." },
        { idx: 3, doc: "d2", pageStart: 3, pageEnd: 3, cited: "Tổng chi phí triển khai: 2.450.000.000 đồng (đã gồm VAT 10%)." }
      ]
    },
    advice: {
      answerType: "answered",
      notice: "Công cụ chỉ cung cấp thông tin có trong tài liệu và không đưa ra khuyến nghị kinh doanh.",
      segments: [
        { t: "Các thông tin liên quan trong tài liệu:" }, { p: true },
        { li: "Bên triển khai chịu phạt 0,1% giá trị phần việc chậm cho mỗi ngày chậm, tối đa 8% giá trị hợp đồng " }, { c: 1 },
        { li: "Bên A có quyền đơn phương chấm dứt hợp đồng nếu chậm tiến độ quá 30 ngày " }, { c: 1 },
        { li: "Thời hạn bảo hành 12 tháng kể từ nghiệm thu cuối cùng " }, { c: 2 }
      ],
      citations: [
        { idx: 1, doc: "d1", pageStart: 25, pageEnd: 25, cited: "12.1. Trường hợp Bên B chậm tiến độ, Bên B chịu phạt 0,1% giá trị phần việc chậm cho mỗi ngày chậm, tổng mức phạt không vượt quá 8% giá trị hợp đồng." },
        { idx: 2, doc: "d1", pageStart: 18, pageEnd: 18, cited: "9.1. Thời hạn bảo hành là 12 tháng kể từ ngày ký biên bản nghiệm thu cuối cùng." }
      ]
    },
    team: {
      answerType: "partial",
      partialNote: "Chỉ tìm được một phần: tài liệu không có thông tin về chi phí nhân sự.",
      segments: [
        { t: "Hồ sơ năng lực nêu đội dự án dự kiến gồm 12 người: 1 quản lý dự án, 2 chuyên gia nghiệp vụ kho vận, 6 kỹ sư phát triển và 3 kỹ sư kiểm thử " }, { c: 1 }, { t: "." }, { p: true },
        { t: "Không tìm thấy thông tin về chi phí nhân sự trong các tài liệu hiện có." }
      ],
      citations: [
        { idx: 1, doc: "d3", pageStart: 7, pageEnd: 7, cited: "Đội dự án dự kiến gồm 12 người: 1 quản lý dự án, 2 chuyên gia nghiệp vụ kho vận, 6 kỹ sư phát triển và 3 kỹ sư kiểm thử." }
      ]
    }
  };

  function classify(q) {
    const f = window.CWD.fold(q);
    if (/(loi he thong|demo loi)/.test(f)) return "fail";
    if (/(co nen|khuyen nghi|nen ky)/.test(f)) return "advice";
    if (/bao hanh/.test(f)) return "warranty";
    if (/thanh toan|tam ung/.test(f)) return "payment";
    if (/(gia tri|tong gia|bao nhieu tien|gia hop dong)/.test(f)) return "price";
    if (/(nhan su|doi du an|bao nhieu nguoi)/.test(f)) return "team";
    return "not_found";
  }

  const suggestions = [
    "Điều khoản thanh toán của dự án Phú Hưng là gì?",
    "Tổng giá trị hợp đồng Phú Hưng là bao nhiêu?",
    "Đội dự án gồm bao nhiêu người và chi phí nhân sự?",
    "Có nên ký hợp đồng này không?"
  ];

  const conversations = [
    { id: "c1", title: "Điều khoản thanh toán của dự án Phú Hưng là gì?", turns: 3, last: "Hôm nay, 09:41" },
    { id: "c2", title: "Tổng giá trị hợp đồng Phú Hưng là bao nhiêu?", turns: 1, last: "Hôm qua, 16:05" },
    { id: "c3", title: "Thời hạn hiệu lực của báo giá?", turns: 2, last: "18/10/2026, 11:20" },
    { id: "c4", title: "Kinh nghiệm của quản lý dự án trong hồ sơ năng lực", turns: 4, last: "15/10/2026, 14:02" }
  ];

  const audit = [
    { at: "2026-10-21T08:55:00", actor: "Trần Quốc Bảo", action: "DOCUMENT_UPLOADED", doc: "BienBanHop_PhuHung_1510.pdf" },
    { at: "2026-10-20T16:21:00", actor: "Hệ thống", action: "DOCUMENT_FAILED", doc: "GiayPhepKinhDoanh_Scan.pdf", note: "PDF dạng ảnh scan" },
    { at: "2026-10-20T16:20:00", actor: "Nguyễn Thu Hà", action: "DOCUMENT_UPLOADED", doc: "GiayPhepKinhDoanh_Scan.pdf" },
    { at: "2026-10-16T10:12:00", actor: "Trần Quốc Bảo", action: "DOCUMENT_REMOVED", doc: "BaoGia_PhuHung_draft.pdf" },
    { at: "2026-10-14T09:12:00", actor: "Trần Quốc Bảo", action: "DOCUMENT_UPLOADED", doc: "HopDong_PhuHung_v2_DaKy.pdf" },
    { at: "2026-10-12T15:40:00", actor: "Nguyễn Thu Hà", action: "DOCUMENT_UPLOADED", doc: "BaoGia_PhuHung_0209.pdf" },
    { at: "2026-10-10T10:05:00", actor: "Trần Quốc Bảo", action: "DOCUMENT_UPLOADED", doc: "HoSoNangLuc_CongTy_2026.pdf" },
    { at: "2026-09-29T13:30:00", actor: "Lê Minh Châu", action: "DOCUMENT_REMOVED", doc: "HoSoNangLuc_CongTy_2025.pdf" },
    { at: "2026-09-02T08:30:00", actor: "Nguyễn Thu Hà", action: "DOCUMENT_UPLOADED", doc: "HopDong_PhuHung_v1.pdf" }
  ];

  // 8 tuần pilot, 20 người được cấp quyền
  const weekly = [
    { week: "2026-W36", label: "T36", authorized: 20, active: 9, questions: 86, notFoundRate: 0.19, helpfulRate: 0.61 },
    { week: "2026-W37", label: "T37", authorized: 20, active: 12, questions: 141, notFoundRate: 0.17, helpfulRate: 0.64 },
    { week: "2026-W38", label: "T38", authorized: 20, active: 14, questions: 188, notFoundRate: 0.15, helpfulRate: 0.68 },
    { week: "2026-W39", label: "T39", authorized: 20, active: 15, questions: 232, notFoundRate: 0.14, helpfulRate: 0.70 },
    { week: "2026-W40", label: "T40", authorized: 20, active: 13, questions: 204, notFoundRate: 0.14, helpfulRate: 0.71 },
    { week: "2026-W41", label: "T41", authorized: 20, active: 16, questions: 259, notFoundRate: 0.12, helpfulRate: 0.73 },
    { week: "2026-W42", label: "T42", authorized: 20, active: 17, questions: 291, notFoundRate: 0.11, helpfulRate: 0.74 },
    { week: "2026-W43", label: "T43", authorized: 20, active: 18, questions: 312, notFoundRate: 0.10, helpfulRate: 0.76 }
  ];

  return { documents, errorText, pages, answers, classify, suggestions, conversations, audit, weekly };
})();
