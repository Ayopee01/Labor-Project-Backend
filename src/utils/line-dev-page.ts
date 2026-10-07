// หน้า HTML แบบ standalone สำหรับจำลองปุ่ม Vendor ใน LINE โดยไม่ต้องมี frontend build แยก
export const LINE_DEV_PAGE_HTML = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LINE Dev Tester</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #172033; background: #f4f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; }
    main { width: min(1180px, 100%); margin: 0 auto; }
    header, .toolbar, .card { background: #fff; border: 1px solid #dfe6ef; border-radius: 14px; box-shadow: 0 5px 18px rgba(30, 41, 59, .06); }
    header { padding: 20px; margin-bottom: 14px; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    p { margin: 0; color: #64748b; }
    .notice { margin-top: 12px; padding: 10px 12px; border-radius: 9px; background: #ecfdf5; color: #047857; font-weight: 650; }
    .toolbar { display: flex; gap: 10px; align-items: center; padding: 12px; margin-bottom: 14px; position: sticky; top: 8px; z-index: 2; }
    select, button { min-height: 38px; border-radius: 9px; border: 1px solid #cbd5e1; padding: 0 13px; font: inherit; font-weight: 700; }
    select { background: #fff; }
    button { cursor: pointer; background: #f8fafc; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .refresh { color: #1d4ed8; background: #eff6ff; border-color: #bfdbfe; }
    .summary { margin-left: auto; font-size: 14px; color: #475569; }
    #message { min-height: 24px; margin: 0 0 10px; font-weight: 700; }
    #message.ok { color: #047857; } #message.error { color: #b91c1c; }
    .list { display: grid; gap: 12px; }
    .card { padding: 16px; }
    .card-head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
    .title { font-size: 18px; font-weight: 800; }
    .meta { margin-top: 5px; color: #64748b; font-size: 13px; line-height: 1.55; }
    .badge { display: inline-flex; margin-left: 7px; padding: 3px 8px; border-radius: 999px; font-size: 12px; }
    .badge.pending { color: #9a3412; background: #ffedd5; }
    .badge.done { color: #166534; background: #dcfce7; }
    .badge.reject { color: #991b1b; background: #fee2e2; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .confirm { color: #fff; background: #16a34a; border-color: #16a34a; }
    .reject { color: #fff; background: #dc2626; border-color: #dc2626; }
    table { width: 100%; border-collapse: collapse; margin-top: 13px; font-size: 13px; }
    th, td { padding: 8px; text-align: left; border-top: 1px solid #e5e7eb; }
    th { color: #64748b; }
    .empty { padding: 34px; text-align: center; color: #64748b; background: #fff; border: 1px dashed #cbd5e1; border-radius: 14px; }
    @media (max-width: 700px) { body { padding: 12px; } .toolbar, .card-head { align-items: stretch; flex-direction: column; } .summary { margin-left: 0; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>LINE Dev Tester</h1>
    <p>รายการยอดที่ Worker/Admin ส่งมา ใช้ทดสอบยืนยันหรือปฏิเสธแทนการกดจาก LINE</p>
    <div class="notice">หน้านี้ไม่ส่งข้อความผ่าน LINE Messaging API ใช้เป็นทางสำรองกรณีเส้น LINE ติดลิมิต</div>
  </header>
  <section class="toolbar">
    <select id="filter" aria-label="กรองสถานะ">
      <option value="pending">รอดำเนินการ</option>
      <option value="all">ทั้งหมด</option>
      <option value="handled">ดำเนินการแล้ว</option>
    </select>
    <button id="refresh" class="refresh" type="button">รีเฟรช</button>
    <span id="summary" class="summary">กำลังโหลด...</span>
  </section>
  <div id="message" role="status"></div>
  <section id="list" class="list"></section>
</main>
<script>
  const state = { items: [], busy: false };
  const list = document.getElementById('list');
  const message = document.getElementById('message');
  const summary = document.getElementById('summary');
  const filter = document.getElementById('filter');
  const escapeHtml = (value) => String(value ?? '-').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const formatDate = (value) => value ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(value)) : '-';
  const statusMeta = (item) => item.Actionable
    ? { label: 'รอยืนยัน', className: 'pending' }
    : item.SubmissionStatus === 'REJECT'
      ? { label: 'ปฏิเสธแล้ว', className: 'reject' }
      : { label: 'ยืนยัน/จบแล้ว', className: 'done' };
  const visibleItems = () => state.items.filter((item) => filter.value === 'all' || (filter.value === 'pending' ? item.Actionable : !item.Actionable));

  function setMessage(text, type = '') {
    message.textContent = text;
    message.className = type;
  }

  function render() {
    const items = visibleItems();
    const pending = state.items.filter((item) => item.Actionable).length;
    summary.textContent = 'ทั้งหมด ' + state.items.length + ' รายการ · รอดำเนินการ ' + pending;
    if (!items.length) {
      list.innerHTML = '<div class="empty">ไม่พบรายการในตัวกรองนี้</div>';
      return;
    }
    list.innerHTML = items.map((item) => {
      const status = statusMeta(item);
      const products = (item.Products || []).map((product) => '<tr><td>' + escapeHtml(product.ProductCode) + '</td><td>' + escapeHtml(product.ProductName) + '</td><td>' + escapeHtml(product.PackageName || product.PackageCode) + '</td><td>' + escapeHtml(product.ExpectedQuantity) + '</td><td><strong>' + escapeHtml(product.SubmittedQuantity) + '</strong></td></tr>').join('');
      return '<article class="card"><div class="card-head"><div><div class="title">' + escapeHtml(item.LicensePlate) + ' · แผง ' + escapeHtml(item.BoothCode) + '<span class="badge ' + status.className + '">' + status.label + '</span></div><div class="meta">TicketNumber: ' + escapeHtml(item.TicketNumber) + ' · เลขงาน: ' + escapeHtml(item.TicketNo) + '<br>ตลาด: ' + escapeHtml(item.MarketName) + ' (' + escapeHtml(item.MarketCode) + ') · ผู้ส่ง: ' + escapeHtml(item.SubmittedByName) + ' [' + escapeHtml(item.SubmittedByCode) + ' / ' + escapeHtml(item.SubmittedByRole) + ']<br>ส่งเมื่อ: ' + escapeHtml(formatDate(item.SubmittedAt)) + ' · Submission #' + escapeHtml(item.SubmissionId) + '</div></div><div class="actions">' + (item.Actionable ? '<button class="confirm" data-action="confirm" data-id="' + item.SubmissionId + '" type="button">ยืนยัน</button><button class="reject" data-action="reject" data-id="' + item.SubmissionId + '" type="button">ปฏิเสธ</button>' : '') + '</div></div><table><thead><tr><th>รหัส</th><th>สินค้า</th><th>บรรจุภัณฑ์</th><th>ยอดคาด</th><th>ยอดที่ส่ง</th></tr></thead><tbody>' + products + '</tbody></table></article>';
    }).join('');
    list.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.id, button.dataset.action)));
  }

  async function load() {
    try {
      const response = await fetch('/api/line/dev/submissions', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.Message || 'โหลดข้อมูลไม่สำเร็จ');
      state.items = payload.Data || [];
      render();
    } catch (error) {
      setMessage(error.message || 'โหลดข้อมูลไม่สำเร็จ', 'error');
      list.innerHTML = '<div class="empty">เชื่อมต่อ backend ไม่สำเร็จ</div>';
    }
  }

  async function runAction(id, action) {
    if (state.busy || !confirm(action === 'confirm' ? 'ยืนยันยอดรายการนี้?' : 'ปฏิเสธยอดรายการนี้?')) return;
    state.busy = true;
    document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    setMessage('กำลังดำเนินการ...');
    try {
      const response = await fetch('/api/line/dev/submissions/' + encodeURIComponent(id) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.Message || 'ดำเนินการไม่สำเร็จ');
      setMessage(action === 'confirm' ? 'ยืนยันยอดสำเร็จ' : 'ปฏิเสธยอดสำเร็จ', 'ok');
      await load();
    } catch (error) {
      setMessage(error.message || 'ดำเนินการไม่สำเร็จ', 'error');
    } finally {
      state.busy = false;
      document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  filter.addEventListener('change', render);
  document.getElementById('refresh').addEventListener('click', load);
  load();
  setInterval(load, 15000);
</script>
</body>
</html>`;
