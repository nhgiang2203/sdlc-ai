/* Workspace prototype — mô phỏng hành vi theo Blueprint §3.7 (state machines) và PRD AC.
   Không gọi máy chủ thật; mọi dữ liệu đến từ mock-data.js. */
(function () {
  "use strict";
  const { icon, esc, fold, fmtBytes, toast, confirmDialog, track, store } = window.CWD;
  const D = window.CWD_DATA;
  const session = window.CWD.renderHeader("workspace");

  const MAX_Q = 2000, WARN_Q = 1800, MAX_MB = 50, MAX_TURNS = 20;
  const $ = id => document.getElementById(id);

  // ---------- State ----------
  const state = {
    docs: D.documents.map(d => Object.assign({}, d)),
    uploads: [],
    selected: new Set(),
    filter: "",
    messages: [],
    turns: 0,
    streaming: null,
    viewer: { open: false, docId: null, page: 1, highlight: "", state: "closed", citeKey: null },
    aiBusy: false,
    rateLimitUntil: 0,
    offline: false
  };
  let msgSeq = 0, upSeq = 0;
  const draftKey = "cwd.draft.new";

  // ---------- Static icons ----------
  $("dz-icon").innerHTML = icon("upload");
  $("search-icon").outerHTML = icon("search");
  $("sidebar-close").innerHTML = icon("x");
  $("sidebar-open").innerHTML = icon("layout") + "Kho tài liệu";
  $("history-link").innerHTML = icon("history") + '<span class="nav-label">Lịch sử</span>';
  $("new-chat").innerHTML = icon("plus") + "Hội thoại mới";
  $("viewer-icon").innerHTML = icon("file");
  $("viewer-close").innerHTML = icon("x");
  $("viewer-prev").innerHTML = icon("chevronLeft");
  $("viewer-next").innerHTML = icon("chevronRight");
  $("drag-icon").innerHTML = icon("upload", "icon-lg");

  // ---------- Helpers ----------
  const readyDocs = () => state.docs.filter(d => d.status === "READY");
  const processingDocs = () => state.docs.filter(d => d.status === "PROCESSING" || d.status === "QUEUED");
  const docById = id => state.docs.find(d => d.id === id);
  function scopeIds() {
    const sel = [...state.selected].filter(id => { const d = docById(id); return d && d.status === "READY"; });
    return sel.length ? sel : readyDocs().map(d => d.id);
  }
  function announce(t) { const el = $("sr-live"); el.textContent = ""; setTimeout(() => { el.textContent = t; }, 30); }
  function fmtBold(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); }
  function pageLabel(c) { return c.pageStart === c.pageEnd ? "tr. " + c.pageStart : "tr. " + c.pageStart + "–" + c.pageEnd; }

  // ======================================================================
  // Sidebar: DocumentSidebar / DocumentRow / StatusBadge
  // ======================================================================
  function badge(d) {
    if (d.status === "READY" && d.unreadablePages > 0) return '<span class="badge badge-processing">' + icon("alert") + "Sẵn sàng · " + d.unreadablePages + " trang không đọc được</span>";
    if (d.status === "READY") return '<span class="badge badge-ready">' + icon("check") + "Sẵn sàng</span>";
    if (d.status === "PROCESSING" || d.status === "QUEUED") return '<span class="badge badge-processing">' + icon("loader", "spin") + "Đang xử lý</span>";
    return '<span class="badge badge-failed">' + icon("alertCircle") + "Lỗi</span>";
  }
  function uploadBadge(u) {
    if (u.state === "uploading") return '<span class="badge badge-info">' + icon("upload") + "Đang tải lên " + u.progress + "%</span>";
    if (u.state === "interrupted") return '<span class="badge badge-failed">' + icon("wifiOff") + "Tải lên bị gián đoạn</span>";
    if (u.state === "rejected") return '<span class="badge badge-failed">' + icon("x") + "Không được chấp nhận</span>";
    return '<span class="badge badge-neutral">' + icon("clock") + "Đang kiểm tra</span>";
  }
  function renderSidebar() {
    const list = $("doc-list");
    const f = fold(state.filter.trim());
    const docs = state.docs.filter(d => !f || fold(d.filename).includes(f));
    let html = "";
    if (state.uploads.length) {
      html += '<li class="doc-section-label" aria-hidden="true">Đang tải lên</li>';
      html += state.uploads.map(u =>
        '<li class="doc-row" data-upload="' + u.id + '"><span aria-hidden="true">' + icon("file", "icon-sm") + '</span><div style="min-width:0"><span class="doc-name" title="' + esc(u.name) + '">' + esc(u.name) + '</span><div class="doc-meta">' + uploadBadge(u) + "<span>" + fmtBytes(u.size) + "</span></div>" +
        (u.state === "uploading" ? '<div class="progress" role="progressbar" aria-label="Tiến trình tải ' + esc(u.name) + '" aria-valuenow="' + u.progress + '" aria-valuemin="0" aria-valuemax="100"><span style="width:' + u.progress + '%"></span></div>' : "") +
        (u.reason ? '<p class="doc-error">' + esc(u.reason) + "</p>" : "") + '</div><div class="doc-actions">' +
        (u.state === "interrupted" ? '<button class="icon-btn" data-act="retry" aria-label="Thử tải lại ' + esc(u.name) + '" title="Thử lại">' + icon("refresh") + "</button>" : "") +
        (u.state !== "uploading" ? '<button class="icon-btn" data-act="dismiss" aria-label="Bỏ ' + esc(u.name) + ' khỏi danh sách" title="Bỏ qua">' + icon("x") + "</button>" : "") +
        "</div></li>").join("");
    }
    if (state.docs.length) html += '<li class="doc-section-label" aria-hidden="true">Tài liệu (' + state.docs.length + ")</li>";
    if (!state.docs.length && !state.uploads.length) {
      html += '<li class="empty" style="padding:24px 12px"><p>Chưa có tài liệu nào.</p></li>';
    } else if (state.docs.length && !docs.length) {
      html += '<li class="empty" style="padding:24px 12px"><p>Không có tài liệu khớp “' + esc(state.filter) + '”.</p><button class="link-btn" data-act="clear-filter">Xoá bộ lọc</button></li>';
    }
    html += docs.map(d => {
      const ready = d.status === "READY";
      const sel = state.selected.has(d.id);
      const cbId = "cb-" + d.id;
      return '<li class="doc-row' + (sel ? " is-selected" : "") + '" data-doc="' + d.id + '">' +
        '<input type="checkbox" class="checkbox" id="' + cbId + '"' + (sel ? " checked" : "") + (ready ? "" : ' disabled title="Chỉ chọn được tài liệu đã sẵn sàng"') + ' aria-label="Chỉ hỏi trong ' + esc(d.filename) + '">' +
        '<div style="min-width:0"><label class="doc-name" for="' + cbId + '" title="' + esc(d.filename) + '">' + esc(d.filename) + '</label><div class="doc-meta">' + badge(d) +
        (d.status !== "FAILED" ? "<span>" + d.pageCount + " trang</span>" : "") + "<span>" + esc(d.uploadedBy) + " · " + esc(d.uploadedAt.split(" ")[0]) + "</span></div>" +
        (d.status === "FAILED" ? '<p class="doc-error">' + esc(D.errorText[d.errorReason] || D.errorText.other) + "</p>" : "") +
        '</div><div class="doc-actions">' +
        '<button class="icon-btn" data-act="remove" aria-label="' + (d.status === "FAILED" ? "Xoá " : "Gỡ ") + esc(d.filename) + '" title="' + (d.status === "FAILED" ? "Xoá khỏi danh sách" : "Gỡ tài liệu") + '"' + (d.status === "PROCESSING" ? " disabled" : "") + ">" + icon("trash") + "</button>" +
        "</div></li>";
    }).join("");
    list.innerHTML = html;
    const r = readyDocs().length, p = processingDocs().length;
    $("sidebar-foot").textContent = r + " sẵn sàng · " + p + " đang xử lý · " + state.docs.filter(d => d.status === "FAILED").length + " lỗi";
  }
  $("doc-list").addEventListener("change", e => {
    if (!e.target.matches(".checkbox")) return;
    const id = e.target.closest("[data-doc]").dataset.doc;
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    track("scope_changed", { docs_selected: state.selected.size });
    renderSidebar(); renderScope();
  });
  $("doc-list").addEventListener("click", async e => {
    const btn = e.target.closest("button[data-act]"); if (!btn) return;
    const act = btn.dataset.act;
    if (act === "clear-filter") { state.filter = ""; $("doc-filter").value = ""; renderSidebar(); return; }
    const upRow = btn.closest("[data-upload]");
    if (upRow) {
      const u = state.uploads.find(x => x.id === upRow.dataset.upload);
      if (act === "dismiss") state.uploads = state.uploads.filter(x => x !== u);
      if (act === "retry") { if (state.offline) { toast("Vẫn chưa có kết nối mạng.", "danger"); return; } u.state = "uploading"; u.reason = ""; runUpload(u); }
      renderSidebar(); return;
    }
    const d = docById(btn.closest("[data-doc]").dataset.doc);
    if (act === "remove") {
      const failed = d.status === "FAILED";
      const ok = await confirmDialog(failed
        ? { title: "Xoá khỏi danh sách?", body: "“" + d.filename + "” không xử lý được và sẽ bị xoá khỏi danh sách.", confirmLabel: "Xoá", tone: "danger" }
        : { title: "Gỡ tài liệu?", body: "“" + d.filename + "” sẽ không còn được dùng để trả lời. Thao tác này không hoàn tác được.", confirmLabel: "Gỡ tài liệu", tone: "danger" });
      if (!ok) return;
      removeDoc(d.id);
      toast((failed ? "Đã xoá " : "Đã gỡ ") + d.filename, "success");
    }
  });
  function removeDoc(id) {
    state.docs = state.docs.filter(d => d.id !== id);
    state.selected.delete(id);
    state.removedIds = state.removedIds || new Set(); state.removedIds.add(id);
    track("document_removed", { document_id: id });
    if (state.viewer.open && state.viewer.docId === id) { state.viewer.state = "removed"; renderViewer(); }
    renderSidebar(); renderScope(); state.messages.forEach(m => m.role === "assistant" && renderMessage(m)); renderEmpty();
  }
  $("doc-filter").addEventListener("input", e => { state.filter = e.target.value; renderSidebar(); });

  // ---------- Upload (UploadItem state machine — Blueprint §3.7.2) ----------
  const fileInput = $("file-input");
  $("dropzone").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { handleFiles([...fileInput.files]); fileInput.value = ""; });
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { if (![...e.dataTransfer.types].includes("Files")) return; dragDepth++; $("drag-overlay").hidden = false; });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drag-overlay").hidden = true; });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; $("drag-overlay").hidden = true; handleFiles([...e.dataTransfer.files]); });

  function handleFiles(files) {
    if (!files.length) return;
    files.forEach(f => {
      const u = { id: "u" + (++upSeq), name: f.name, size: f.size, state: "validating", progress: 0, reason: "" };
      const isPdf = /\.pdf$/i.test(f.name) && (!f.type || f.type === "application/pdf");
      if (!isPdf) { u.state = "rejected"; u.reason = "Chỉ hỗ trợ file PDF."; track("document_upload_rejected", { reason: "not_pdf" }); }
      else if (f.size > MAX_MB * 1048576) { u.state = "rejected"; u.reason = "File vượt quá 50 MB."; track("document_upload_rejected", { reason: "too_large" }); }
      state.uploads.unshift(u);
      if (u.state === "validating") { u.state = "uploading"; track("document_upload_started", { file_size_mb: +(f.size / 1048576).toFixed(1), batch_size: files.length }); runUpload(u); }
    });
    renderSidebar(); renderEmpty();
  }
  function runUpload(u) {
    const step = () => {
      if (u.state !== "uploading") return;
      if (state.offline) { u.state = "interrupted"; u.reason = "Mất kết nối khi đang tải lên."; renderSidebar(); return; }
      u.progress = Math.min(100, u.progress + 12 + Math.round(Math.random() * 18));
      renderSidebar();
      if (u.progress < 100) { setTimeout(step, 220); return; }
      finishUpload(u);
    };
    setTimeout(step, 200);
  }
  async function finishUpload(u) {
    const dup = state.docs.find(d => d.filename.toLowerCase() === u.name.toLowerCase());
    if (dup) {
      const ok = await confirmDialog({ title: "Tài liệu này đã có trong kho", body: "“" + u.name + "” trùng nội dung với tài liệu đã tải lên ngày " + dup.uploadedAt.split(" ")[0] + ". Vẫn thêm bản này?", confirmLabel: "Vẫn thêm", cancelLabel: "Huỷ" });
      if (!ok) { state.uploads = state.uploads.filter(x => x !== u); renderSidebar(); return; }
    }
    state.uploads = state.uploads.filter(x => x !== u);
    const now = new Date();
    const doc = { id: "n" + u.id, filename: u.name, status: "PROCESSING", pageCount: 8 + Math.round(Math.random() * 40), sizeBytes: u.size, uploadedBy: session.name,
      uploadedAt: now.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }) + " " + now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }), unreadablePages: 0 };
    state.docs.unshift(doc);
    renderSidebar(); renderScope(); renderComposer(); renderEmpty();
    setTimeout(() => {
      const f = fold(doc.filename);
      if (/scan/.test(f)) { doc.status = "FAILED"; doc.errorReason = "scanned"; track("document_processing_failed", { reason: "scanned" }); toast("Không xử lý được " + doc.filename, "danger"); }
      else if (/mat ?khau|password/.test(f)) { doc.status = "FAILED"; doc.errorReason = "password_protected"; track("document_processing_failed", { reason: "password" }); toast("Không xử lý được " + doc.filename, "danger"); }
      else if (/hong|corrupt/.test(f)) { doc.status = "FAILED"; doc.errorReason = "corrupted"; track("document_processing_failed", { reason: "corrupted" }); toast("Không xử lý được " + doc.filename, "danger"); }
      else { doc.status = "READY"; track("document_processing_completed", { page_count: doc.pageCount }); toast("Đã sẵn sàng: " + doc.filename, "success"); }
      renderSidebar(); renderScope(); renderComposer(); renderEmpty();
    }, 3500);
  }

  // ======================================================================
  // ScopeBar
  // ======================================================================
  function renderScope() {
    const r = readyDocs().length, p = processingDocs().length;
    const sel = [...state.selected].filter(id => docById(id)).length;
    let html;
    if (!r) html = icon("info", "icon-sm") + "<span>Chưa có tài liệu sẵn sàng để hỏi.</span>";
    else if (sel) html = icon("file", "icon-sm") + "<span>Đang hỏi trong <strong>" + sel + " tài liệu đã chọn</strong></span> · <button class='link-btn' id='clear-scope'>Hỏi trong tất cả</button>";
    else html = icon("file", "icon-sm") + "<span>Đang hỏi trong <strong>tất cả " + r + " tài liệu sẵn sàng</strong></span>";
    if (p && r) html += "<span>· " + p + " tài liệu đang xử lý chưa được dùng</span>";
    $("scope-bar").innerHTML = html;
    const c = $("clear-scope"); if (c) c.addEventListener("click", () => { state.selected.clear(); renderSidebar(); renderScope(); });
  }

  // ======================================================================
  // Composer (Blueprint §3.7.4)
  // ======================================================================
  const ta = $("question");
  ta.value = store.sget(draftKey, "");
  function composerDisabledReason() {
    if (!readyDocs().length) return processingDocs().length ? "Tài liệu đang được xử lý, vui lòng chờ." : "Thêm tài liệu để bắt đầu hỏi.";
    return "";
  }
  function renderComposer() {
    const reason = composerDisabledReason();
    const len = ta.value.length;
    const over = len > MAX_Q;
    const limited = Date.now() < state.rateLimitUntil;
    ta.disabled = !!reason;
    ta.placeholder = reason || "Hỏi về nội dung tài liệu…";
    $("composer").classList.toggle("is-disabled", !!reason);
    $("composer").classList.toggle("is-invalid", over);
    ta.setAttribute("aria-invalid", String(over));
    const send = $("send");
    if (state.streaming) {
      send.classList.add("is-stop"); send.innerHTML = icon("stop"); send.setAttribute("aria-label", "Dừng tạo câu trả lời"); send.disabled = false;
    } else {
      send.classList.remove("is-stop"); send.innerHTML = icon("send"); send.setAttribute("aria-label", "Gửi câu hỏi");
      send.disabled = !!reason || !ta.value.trim() || over || state.offline || limited;
    }
    const count = $("composer-count");
    if (over) { count.className = "is-error"; count.textContent = "Câu hỏi tối đa 2.000 ký tự (" + len.toLocaleString("vi-VN") + " / 2.000)"; }
    else if (len >= WARN_Q) { count.className = ""; count.textContent = len.toLocaleString("vi-VN") + " / 2.000"; }
    else count.textContent = "";
    const hint = $("composer-hint");
    if (limited) { hint.innerHTML = "<span class='is-error'>Bạn đang hỏi quá nhanh. Vui lòng thử lại sau " + Math.ceil((state.rateLimitUntil - Date.now()) / 1000) + " giây.</span>"; }
    else if (state.offline) hint.textContent = "Mất kết nối — câu hỏi được giữ lại, gửi khi có mạng.";
    else if (state.streaming) hint.textContent = "Đang trả lời… Nhấn nút vuông để dừng.";
    else hint.textContent = "Enter để gửi · Shift + Enter để xuống dòng";
    ta.style.height = "auto"; ta.style.height = Math.min(168, ta.scrollHeight) + "px";
  }
  ta.addEventListener("input", () => { store.sset(draftKey, ta.value); renderComposer(); });
  ta.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("composer").addEventListener("submit", e => {
    e.preventDefault();
    if (state.streaming) { stopStreaming(); return; }
    const q = ta.value.trim();
    if (!q || q.length > MAX_Q || composerDisabledReason() || state.offline || Date.now() < state.rateLimitUntil) return;
    ask(q);
  });
  setInterval(() => { if (state.rateLimitUntil && Date.now() < state.rateLimitUntil + 1000) renderComposer(); }, 1000);

  // ======================================================================
  // Chat thread & AnswerMessage (Blueprint §3.7.1)
  // ======================================================================
  const inner = $("thread-inner");
  function renderEmpty() {
    const existing = $("thread-empty");
    if (state.messages.length) { if (existing) existing.remove(); return; }
    const el = existing || document.createElement("div");
    el.id = "thread-empty";
    if (!state.docs.length && !state.uploads.length) {
      el.className = "empty";
      el.innerHTML = '<div class="empty-icon">' + icon("upload", "icon-lg") + '</div><h2>Bắt đầu bằng cách thêm tài liệu</h2><p>Chưa có tài liệu nào. Kéo-thả file PDF vào đây để bắt đầu.</p>' +
        '<ol class="steps"><li><b>1. Thêm tài liệu</b>Kéo-thả các file PDF của dự án vào kho chung.</li><li><b>2. Đặt câu hỏi</b>Hỏi bằng tiếng Việt như hỏi một đồng nghiệp.</li><li><b>3. Kiểm chứng</b>Bấm vào số trích dẫn để mở đúng trang gốc.</li></ol>' +
        '<button class="btn btn-primary" id="empty-upload">' + icon("upload") + "Chọn file PDF</button>";
    } else if (!readyDocs().length) {
      el.className = "empty";
      el.innerHTML = '<div class="empty-icon">' + icon("loader", "icon-lg spin") + '</div><h2>Tài liệu đang được xử lý</h2><p>Bạn có thể đặt câu hỏi ngay khi có ít nhất một tài liệu ở trạng thái “Sẵn sàng”.</p>';
    } else {
      el.className = "empty";
      el.innerHTML = '<div class="empty-icon">' + icon("sparkle", "icon-lg") + '</div><h2>Hỏi bất cứ điều gì về ' + readyDocs().length + ' tài liệu trong kho</h2><p>Câu trả lời chỉ dựa trên tài liệu và luôn kèm trang trích dẫn để bạn kiểm chứng.</p>' +
        '<div class="suggestions">' + D.suggestions.map(s => '<button class="suggestion" type="button">' + esc(s) + "</button>").join("") + "</div>";
    }
    if (!existing) inner.appendChild(el);
    const up = $("empty-upload"); if (up) up.addEventListener("click", () => fileInput.click());
    el.querySelectorAll(".suggestion").forEach(b => b.addEventListener("click", () => { ta.value = b.textContent; renderComposer(); ta.focus(); }));
  }

  function ask(q) {
    if (state.turns >= MAX_TURNS) {
      const note = document.createElement("div");
      note.className = "callout callout-info"; note.setAttribute("role", "status");
      note.innerHTML = icon("info") + '<div class="callout-body"><p class="callout-title">Hội thoại đã dài</p><p>Hãy bắt đầu hội thoại mới để có kết quả tốt nhất. Câu hỏi của bạn vẫn được giữ trong ô soạn.</p><p style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="new-chat">' + icon("plus") + "Hội thoại mới</button></p></div>";
      inner.appendChild(note);
      note.querySelector("button").addEventListener("click", newConversation);
      note.scrollIntoView({ block: "end" });
      return;
    }
    if (!state.messages.length) { $("chat-title").textContent = q; track("conversation_started", {}); }
    const scope = scopeIds();
    const user = { id: "m" + (++msgSeq), role: "user", text: q };
    state.messages.push(user); state.turns++;
    renderEmpty();
    const ue = document.createElement("div"); ue.className = "msg-user"; ue.textContent = q; inner.appendChild(ue);
    ta.value = ""; store.sdel(draftKey);
    track("question_submitted", { turn_index: state.turns - 1, question_length: q.length, scope_type: state.selected.size ? "selected" : "all", docs_in_scope: scope.length });
    const intent = window.CWD_DATA.classify(q);
    const m = { id: "m" + (++msgSeq), role: "assistant", state: "retrieving", intent, scope, shown: [], citations: [], rating: null, reason: null, processing: processingDocs().length, started: performance.now() };
    state.messages.push(m);
    m.el = document.createElement("div"); m.el.className = "msg-answer"; inner.appendChild(m.el);
    state.streaming = m;
    renderMessage(m); renderComposer(); scrollBottom();
    announce("Đang tìm trong " + scope.length + " tài liệu");
    m.timer = setTimeout(() => resolveAnswer(m), 900);
  }

  function resolveAnswer(m) {
    if (m.state !== "retrieving") return;
    if (state.aiBusy || m.intent === "fail") {
      m.timer = setTimeout(() => { if (m.state !== "retrieving") return; m.state = "failed"; m.ref = "REQ-" + Math.random().toString(36).slice(2, 8).toUpperCase(); finish(m); track("answer_failed", { error_type: "service_unavailable" }); announce("Không tạo được câu trả lời. Hệ thống đang bận."); }, 1400);
      return;
    }
    const script = D.answers[m.intent];
    const usable = script && script.citations.every(c => m.scope.includes(c.doc));
    if (!script || !usable) {
      m.state = "not_found"; finish(m); track("answer_completed", { answer_type: "not_found", citation_count: 0 });
      announce("Không tìm thấy thông tin này trong các tài liệu hiện có."); return;
    }
    m.script = script; m.state = "streaming"; m.segIdx = 0; m.charIdx = 0;
    m.firstToken = Math.round(performance.now() - m.started);
    tick(m);
  }
  function tick(m) {
    if (m.state !== "streaming") return;
    const segs = m.script.segments;
    let budget = 4 + Math.round(Math.random() * 6);
    while (budget > 0 && m.segIdx < segs.length) {
      const s = segs[m.segIdx];
      const text = s.t != null ? s.t : s.li;
      if (text != null) {
        if (m.charIdx === 0) m.shown.push(Object.assign({}, s, s.t != null ? { t: "" } : { li: "" }));
        const cur = m.shown[m.shown.length - 1];
        const take = Math.min(budget, text.length - m.charIdx);
        const piece = text.slice(m.charIdx, m.charIdx + take);
        if (s.t != null) cur.t += piece; else cur.li += piece;
        m.charIdx += take; budget -= take;
        if (m.charIdx >= text.length) { m.segIdx++; m.charIdx = 0; }
      } else {
        m.shown.push(s);
        if (s.c) { const c = m.script.citations.find(x => x.idx === s.c); if (!m.citations.includes(c)) m.citations.push(c); }
        m.segIdx++;
      }
    }
    renderMessage(m); scrollBottom(true);
    if (m.segIdx >= segs.length) {
      m.state = m.script.answerType === "partial" ? "partial" : "answered";
      finish(m);
      track("answer_completed", { answer_type: m.state, first_token_ms: m.firstToken, total_ms: Math.round(performance.now() - m.started), citation_count: m.citations.length });
      announce("Đã có câu trả lời với " + m.citations.length + " nguồn trích dẫn.");
      return;
    }
    m.timer = setTimeout(() => tick(m), 35);
  }
  function stopStreaming() {
    const m = state.streaming; if (!m) return;
    clearTimeout(m.timer);
    m.state = "stopped"; finish(m); track("answer_stopped", {}); announce("Đã dừng tạo câu trả lời.");
  }
  function finish(m) { state.streaming = null; renderMessage(m); renderComposer(); scrollBottom(true); }
  function scrollBottom(soft) {
    const t = $("thread");
    if (soft && t.scrollHeight - t.scrollTop - t.clientHeight > 160) return;
    t.scrollTop = t.scrollHeight;
  }

  function renderText(m) {
    let html = "", open = null;
    const close = () => { if (open === "p") html += "</p>"; if (open === "ul") html += "</li></ul>"; open = null; };
    const removed = state.removedIds || new Set();
    m.shown.forEach(s => {
      if (s.p) { close(); return; }
      if (s.li != null) { if (open === "ul") html += "</li><li>"; else { close(); html += "<ul><li>"; open = "ul"; } html += fmtBold(s.li); return; }
      if (s.t != null) { if (!open) { html += "<p>"; open = "p"; } html += fmtBold(s.t); return; }
      if (s.c) {
        const c = m.script.citations.find(x => x.idx === s.c);
        const doc = D.documents.find(d => d.id === c.doc);
        const isRemoved = removed.has(c.doc);
        const active = state.viewer.open && state.viewer.citeKey === m.id + ":" + c.idx;
        if (!open) { html += "<p>"; open = "p"; }
        const before = html.length;
        html = html.replace(/([^\s>]+) $/, '<span class="nowrap">$1&nbsp;');
        const wrapped = html.length !== before;
        html += '<button class="cite' + (isRemoved ? " is-removed" : "") + '" type="button" data-msg="' + m.id + '" data-cite="' + c.idx + '" aria-pressed="' + active + '" aria-label="Nguồn ' + c.idx + ": " + esc(doc.filename) + ", " + pageLabel(c) + (isRemoved ? " (tài liệu đã bị gỡ)" : "") + '">' + c.idx + "</button>" + (wrapped ? "</span>" : "");
      }
    });
    close();
    return html.replace(/(<\/button>)<\/span>([.,;:!?)])/g, "$1$2</span>");
  }
  function renderMessage(m) {
    const removed = state.removedIds || new Set();
    let body = "";
    if (m.script && m.script.notice && m.state !== "retrieving") body += '<div class="callout callout-info">' + icon("info") + '<div class="callout-body"><p>' + esc(m.script.notice) + "</p></div></div>";
    if (m.state === "retrieving") {
      body += '<div class="answer-status">' + icon("loader", "spin") + "<span>Đang tìm trong " + m.scope.length + " tài liệu…</span></div><div class='skeleton' aria-hidden='true'><span></span><span></span><span></span></div>";
    } else if (m.state === "not_found") {
      body += '<div class="callout callout-info" role="note">' + icon("info") + '<div class="callout-body"><p class="callout-title">Không tìm thấy thông tin này trong các tài liệu hiện có.</p><p>Đã tìm trong ' + m.scope.length + " tài liệu" + (state.selected.size ? " đã chọn" : "") + ". Thử diễn đạt khác, kiểm tra phạm vi tài liệu, hoặc thêm tài liệu liên quan.</p></div></div>";
    } else if (m.state === "failed") {
      if (m.shown.length) body += '<div class="answer-text">' + renderText(m) + "</div>";
      body += '<div class="callout callout-danger" role="alert">' + icon("alertCircle") + '<div class="callout-body"><p class="callout-title">Hệ thống đang bận, vui lòng thử lại sau ít phút.</p><p class="muted">Câu hỏi của bạn không bị mất. Mã tham chiếu: <span class="mono">' + m.ref + '</span></p><p style="margin-top:8px"><button class="btn btn-secondary btn-sm" data-act="retry">' + icon("refresh") + "Thử lại</button></p></div></div>";
    } else {
      body += '<div class="answer-text">' + renderText(m) + (m.state === "streaming" ? '<span class="cursor" aria-hidden="true"></span>' : "") + "</div>";
      if (m.state === "partial") body += '<div class="callout callout-warning">' + icon("alert") + '<div class="callout-body"><p>' + esc(m.script.partialNote) + "</p></div></div>";
      if (m.state === "stopped") body += '<span class="badge badge-neutral tag-stopped">' + icon("stop") + "Đã dừng</span>";
    }
    if (m.processing && m.state !== "retrieving" && m.state !== "failed") body += '<p class="muted" style="font-size:12px;margin-top:8px">' + m.processing + " tài liệu đang xử lý chưa được dùng để trả lời.</p>";
    if (m.citations.length && m.state !== "retrieving") {
      body += '<div class="sources"><h3>Nguồn</h3><ol>' + m.citations.map(c => {
        const doc = D.documents.find(d => d.id === c.doc); const isRemoved = removed.has(c.doc);
        return '<li><button class="source-item' + (isRemoved ? " is-removed" : "") + '" type="button" data-msg="' + m.id + '" data-cite="' + c.idx + '"' + (isRemoved ? ' aria-disabled="true"' : "") + '><span class="cite' + (isRemoved ? " is-removed" : "") + '" aria-hidden="true">' + c.idx + "</span><span>" + esc(doc.filename) + (isRemoved ? " — <em>Tài liệu đã bị gỡ</em>" : "") + '</span><span class="src-page">' + pageLabel(c) + "</span></button></li>";
      }).join("") + "</ol></div>";
    }
    if (["answered", "partial", "not_found"].includes(m.state)) {
      body += '<div class="answer-actions">' +
        (m.state !== "not_found" ? '<button class="btn btn-ghost btn-sm" data-act="copy">' + icon("copy", "icon-sm") + "Sao chép</button><span class='divider'></span>" : "") +
        '<button class="icon-btn" data-act="up" aria-pressed="' + (m.rating === "up") + '" aria-label="Câu trả lời hữu ích" title="Hữu ích">' + icon("thumbUp", "icon-sm") + "</button>" +
        '<button class="icon-btn" data-act="down" aria-pressed="' + (m.rating === "down") + '" aria-label="Câu trả lời chưa hữu ích" title="Chưa hữu ích">' + icon("thumbDown", "icon-sm") + "</button>" +
        (m.rating && !m.feedbackOpen ? '<span class="muted" style="font-size:12px;margin-left:4px">Cảm ơn phản hồi của bạn</span>' : "") + "</div>";
      if (m.feedbackOpen) {
        const reasons = [["wrong_info", "Sai thông tin"], ["wrong_citation", "Trích dẫn sai"], ["missing_info", "Thiếu thông tin"], ["other", "Khác"]];
        body += '<div class="feedback-panel"><p class="callout-title" id="fb-' + m.id + '">Điều gì chưa ổn? (không bắt buộc)</p><div class="chip-group" role="group" aria-labelledby="fb-' + m.id + '">' +
          reasons.map(r => '<button class="chip" type="button" data-reason="' + r[0] + '" aria-pressed="' + (m.reason === r[0]) + '">' + r[1] + "</button>").join("") +
          '</div><div class="field"><label for="note-' + m.id + '">Ghi chú (tối đa 500 ký tự)</label><textarea class="input" id="note-' + m.id + '" rows="2" maxlength="500"></textarea></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-ghost btn-sm" data-act="fb-cancel">Bỏ qua</button><button class="btn btn-primary btn-sm" data-act="fb-send">Gửi phản hồi</button></div></div>';
      }
    }
    m.el.innerHTML = '<div class="msg-avatar" aria-hidden="true">' + icon("sparkle") + '</div><div class="answer-body">' + body + "</div>";
  }

  inner.addEventListener("click", e => {
    const cite = e.target.closest("[data-cite]");
    if (cite) {
      const m = state.messages.find(x => x.id === cite.dataset.msg);
      const c = m.script.citations.find(x => x.idx === +cite.dataset.cite);
      openViewer(m, c); return;
    }
    const btn = e.target.closest("button[data-act]"); if (!btn) return;
    const msgEl = btn.closest(".msg-answer");
    const m = state.messages.find(x => x.el === msgEl);
    if (!m) return;
    const act = btn.dataset.act;
    if (act === "retry") { const q = [...state.messages].reverse().find(x => x.role === "user"); state.turns--; ta.value = q ? q.text : ""; m.el.previousElementSibling && m.el.previousElementSibling.remove(); m.el.remove(); state.messages = state.messages.filter(x => x !== m && x !== q); if (q) ask(q.text); return; }
    if (act === "copy") {
      const text = m.el.querySelector(".answer-text").innerText.replace(/\s*\n\s*/g, "\n").trim();
      const src = m.citations.map(c => "[" + c.idx + "] " + D.documents.find(d => d.id === c.doc).filename + " — " + pageLabel(c).replace("tr.", "trang")).join("\n");
      const full = text + "\n\nNguồn:\n" + src;
      (navigator.clipboard ? navigator.clipboard.writeText(full) : Promise.reject()).then(() => toast("Đã sao chép câu trả lời kèm nguồn", "success"), () => toast("Không sao chép được — trình duyệt chặn clipboard", "danger"));
      track("answer_copied", {}); return;
    }
    if (act === "up") { m.rating = m.rating === "up" ? null : "up"; m.feedbackOpen = false; track("answer_rated", { rating: m.rating }); renderMessage(m); return; }
    if (act === "down") { m.rating = "down"; m.feedbackOpen = true; renderMessage(m); const first = m.el.querySelector(".chip"); if (first) first.focus(); return; }
    if (act === "fb-cancel") { m.feedbackOpen = false; track("answer_rated", { rating: "down" }); renderMessage(m); return; }
    if (act === "fb-send") { m.feedbackOpen = false; track("answer_rated", { rating: "down", reason: m.reason }); renderMessage(m); toast("Đã gửi phản hồi. Cảm ơn bạn!", "success"); return; }
  });
  inner.addEventListener("click", e => {
    const chip = e.target.closest("[data-reason]"); if (!chip) return;
    const m = state.messages.find(x => x.el === chip.closest(".msg-answer"));
    m.reason = m.reason === chip.dataset.reason ? null : chip.dataset.reason;
    chip.parentElement.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.reason === m.reason)));
  });

  function newConversation() {
    if (state.streaming) stopStreaming();
    state.messages.forEach(m => clearTimeout(m.timer));
    state.messages = []; state.turns = 0; inner.innerHTML = ""; $("chat-title").textContent = "Hội thoại mới";
    closeViewer(); renderEmpty(); renderComposer(); ta.focus();
  }
  $("new-chat").addEventListener("click", newConversation);

  // ======================================================================
  // SourceViewer (Blueprint §3.7.3)
  // ======================================================================
  function openViewer(m, c) {
    const removed = state.removedIds || new Set();
    state.viewer = { open: true, docId: c.doc, page: c.pageStart, highlight: c.cited, state: removed.has(c.doc) ? "removed" : "loading", citeKey: m.id + ":" + c.idx };
    track("citation_clicked", { citation_index: c.idx, document_id: c.doc, page: c.pageStart });
    renderViewer(); refreshChips();
    if (state.viewer.state === "loading") setTimeout(() => { if (state.viewer.state === "loading") { state.viewer.state = "loaded"; renderViewer(); track("source_viewer_loaded", { document_id: c.doc }); } }, 450);
    $("viewer-close").focus();
  }
  function closeViewer() {
    if (!state.viewer.open) return;
    const key = state.viewer.citeKey;
    state.viewer = { open: false, state: "closed" };
    renderViewer(); refreshChips();
    if (key) { const [mid, idx] = key.split(":"); const b = inner.querySelector('.cite[data-msg="' + mid + '"][data-cite="' + idx + '"]'); if (b) b.focus(); }
  }
  function refreshChips() {
    inner.querySelectorAll(".cite[data-msg]").forEach(b => b.setAttribute("aria-pressed", String(state.viewer.open && state.viewer.citeKey === b.dataset.msg + ":" + b.dataset.cite)));
  }
  function genericPage(n) {
    return { heading: "Điều " + (n + 2) + ". Quy định chung", paras: ["Nội dung trang " + n + " của tài liệu (minh hoạ). Các điều khoản tại trang này không liên quan tới câu hỏi hiện tại.", "Hai bên cam kết thực hiện đúng các nội dung đã thoả thuận trong hợp đồng và các phụ lục kèm theo."] };
  }
  function renderViewer() {
    const v = state.viewer, el = $("viewer");
    $("workspace").classList.toggle("viewer-open", !!v.open);
    el.hidden = !v.open;
    if (!v.open) return;
    const doc = D.documents.find(d => d.id === v.docId);
    $("viewer-name").textContent = doc.filename;
    $("viewer-sub").textContent = v.state === "removed" ? "Tài liệu đã bị gỡ" : "Trang " + v.page + " / " + doc.pageCount;
    $("viewer-page").textContent = v.state === "loaded" ? v.page + " / " + doc.pageCount : "";
    $("viewer-prev").disabled = v.state !== "loaded" || v.page <= 1;
    $("viewer-next").disabled = v.state !== "loaded" || v.page >= doc.pageCount;
    const body = $("viewer-body");
    if (v.state === "loading") { body.innerHTML = '<div class="empty">' + icon("loader", "icon-lg spin") + "<p>Đang tải trang " + v.page + "…</p></div>"; return; }
    if (v.state === "removed") { body.innerHTML = '<div class="empty"><div class="empty-icon">' + icon("trash", "icon-lg") + "</div><h3>Tài liệu đã bị gỡ</h3><p>Tài liệu này đã bị gỡ khỏi kho nên không mở được. Nội dung câu trả lời cũ vẫn được giữ.</p></div>"; return; }
    if (v.state === "error") { body.innerHTML = '<div class="empty"><div class="empty-icon">' + icon("alertCircle", "icon-lg") + '</div><h3>Không tải được tài liệu</h3><button class="btn btn-secondary" id="viewer-retry">' + icon("refresh") + "Thử lại</button></div>"; $("viewer-retry").onclick = () => { v.state = "loading"; renderViewer(); setTimeout(() => { v.state = "loaded"; renderViewer(); }, 450); }; return; }
    const pg = (D.pages[v.docId] && D.pages[v.docId][v.page]) || genericPage(v.page);
    const paras = pg.paras.map(p => {
      const i = v.highlight ? p.indexOf(v.highlight) : -1;
      if (i < 0) return "<p>" + esc(p) + "</p>";
      return "<p>" + esc(p.slice(0, i)) + '<mark id="hl">' + esc(v.highlight) + "</mark>" + esc(p.slice(i + v.highlight.length)) + "</p>";
    }).join("");
    body.innerHTML = '<article class="pdf-page" aria-label="Trang ' + v.page + '"><h4>' + esc(pg.heading) + "</h4>" + paras + '<span class="page-no">— ' + v.page + " —</span></article>";
    const hl = $("hl"); if (hl) hl.scrollIntoView({ block: "center" });
  }
  $("viewer-close").addEventListener("click", closeViewer);
  $("viewer-prev").addEventListener("click", () => { state.viewer.page--; state.viewer.highlight = ""; renderViewer(); });
  $("viewer-next").addEventListener("click", () => { state.viewer.page++; state.viewer.highlight = ""; renderViewer(); });

  // ---------- Narrow layout: sidebar drawer ----------
  const sidebar = $("sidebar");
  function setSidebar(open) { sidebar.classList.toggle("is-open", open); $("sidebar-open").setAttribute("aria-expanded", String(open)); if (open) $("doc-filter").focus(); }
  $("sidebar-open").addEventListener("click", () => setSidebar(true));
  $("sidebar-close").addEventListener("click", () => setSidebar(false));
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || document.querySelector(".dialog-backdrop")) return;
    if (state.viewer.open) closeViewer(); else if (sidebar.classList.contains("is-open")) setSidebar(false);
  });

  // ---------- Connectivity ----------
  document.addEventListener("cwd:connectivity", e => {
    state.offline = e.detail.offline;
    $("workspace").classList.toggle("has-banner", state.offline);
    if (state.offline && state.streaming) { const m = state.streaming; clearTimeout(m.timer); m.state = "failed"; m.ref = "NET-" + Math.random().toString(36).slice(2, 7).toUpperCase(); finish(m); }
    state.uploads.forEach(u => { if (state.offline && u.state === "uploading") { u.state = "interrupted"; u.reason = "Mất kết nối khi đang tải lên."; } });
    renderSidebar(); renderComposer();
  });

  // ======================================================================
  // Demo panel (chỉ trong prototype)
  // ======================================================================
  window.CWD.demoPanel("Trạng thái Workspace", panel => {
    const add = (label, fn) => { const b = document.createElement("button"); b.className = "btn btn-secondary btn-sm"; b.type = "button"; b.textContent = label; b.addEventListener("click", fn); panel.appendChild(b); return b; };
    add("Dữ liệu mẫu đầy đủ", () => { resetDocs(D.documents); newConversation(); });
    add("Kho trống (lần đầu sử dụng)", () => { resetDocs([]); newConversation(); });
    add("Chỉ có tài liệu đang xử lý", () => { resetDocs(D.documents.filter(d => d.status === "PROCESSING")); newConversation(); });
    add("Điền sẵn một câu trả lời mẫu", () => { ta.value = D.suggestions[0]; $("composer").requestSubmit(); });
    const off = add("Mô phỏng mất kết nối: tắt", () => { window.CWD.setOffline(!state.offline); off.textContent = "Mô phỏng mất kết nối: " + (state.offline ? "bật" : "tắt"); });
    const busy = add("Dịch vụ AI bận: tắt", () => { state.aiBusy = !state.aiBusy; busy.textContent = "Dịch vụ AI bận: " + (state.aiBusy ? "bật" : "tắt"); });
    add("Vượt giới hạn hỏi (20 giây)", () => { state.rateLimitUntil = Date.now() + 20000; renderComposer(); });
    add("Hội thoại đã đủ 20 lượt", () => { state.turns = MAX_TURNS; toast("Câu hỏi tiếp theo sẽ hiện gợi ý tạo hội thoại mới", "info"); });
    add("Câu hỏi 1.900 ký tự (gần giới hạn)", () => { ta.value = "Tóm tắt các điều khoản quan trọng. ".repeat(56).slice(0, 1900); renderComposer(); });
    add("Lỗi tải trang trong vùng xem", () => { if (!state.viewer.open) { toast("Hãy mở một trích dẫn trước", "info"); return; } state.viewer.state = "error"; renderViewer(); });
    const tips = document.createElement("p"); tips.className = "demo-note";
    tips.innerHTML = "Thử hỏi: “thanh toán”, “bảo hành” (hỏi tiếp), “tổng giá trị” (mâu thuẫn), “nhân sự” (một phần), “có nên ký” (không khuyến nghị), câu bất kỳ khác (không tìm thấy). Tải file có chữ “scan”/“matkhau” để xem lỗi xử lý; file không phải PDF bị từ chối.";
    panel.appendChild(tips);
  });
  function resetDocs(list) {
    state.docs = list.map(d => Object.assign({}, d)); state.uploads = []; state.selected.clear(); state.removedIds = new Set();
    renderSidebar(); renderScope(); renderComposer(); renderEmpty();
  }

  // ---------- Init ----------
  renderSidebar(); renderScope(); renderComposer(); renderEmpty();
  track("session_started", { role: session.key });
})();
