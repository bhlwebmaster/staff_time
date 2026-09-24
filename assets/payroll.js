/* Payroll: pay calculation from attendance, payslip layout (screen + PDF). Shared by admin and staff pages. */
(function () {
  const B = window.BHL;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const GBP = (n) => "£" + r2(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const PHP = (n) => (n == null || isNaN(n) ? "—" : "₱" + r2(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const isWeekday = (ds) => { const g = new Date(ds + "T12:00:00Z").getUTCDay(); return g !== 0 && g !== 6; };
  function weekdays(from, to) { let n = 0; for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) n++; return n; }
  const usDate = (ds) => { if (!ds) return ""; const [y, m, d] = ds.split("-").map(Number); return `${m}/${d}/${y}`; };
  const period = (p) => `${usDate(p.start_date)}-${usDate(p.end_date)}`;

  /**
   * One person's pay for a period, from their attendance.
   * - Pay type "daily": rate per day; gross = (days worked + paid leave) × rate.
   * - Pay type "period": fixed rate per pay period; daily = rate ÷ working days; absences deducted at the daily rate.
   * - Minute rate (for lates/undertime) = daily ÷ paid minutes per day.
   * - Started mid-period: paid for the weekdays from their start date.
   * - Lates: minutes after the day's scheduled start (beyond grace). Undertime: minutes before the day's scheduled end.
   * - Working days come from the weekly schedule (rest days don't count; paid leave is paid, unpaid leave is deducted).
   * - Absences: planned shifts up to today (or period end) with no clock-in, plus unpaid leave days.
   * - Anything in `over` (typed by an admin) replaces the automatic value.
   */
  function compute(staff, rows, p, settings, over = {}, today = B.dateIn(new Date(), settings.timezone), plan = null) {
    // plan(date) → { kind: shift | rest | vacation | sick | holiday | unpaid } from the weekly schedule; default Mon–Fri.
    const kindOf = (d) => (plan ? plan(d).kind : isWeekday(d) ? "shift" : "rest");
    const PAID = { shift: 1, vacation: 1, sick: 1, holiday: 1 };
    const from = staff.start_date && staff.start_date > p.start_date ? staff.start_date : p.start_date;
    // Absences only count days that are over: up to yesterday, or the period end if that's earlier
    const lastPast = [p.end_date, addDays(today, -1)].sort()[0];
    const mine = rows.filter((r) => r.staff_id === staff.id && r.work_date >= p.start_date && r.work_date <= p.end_date && r.time_in);
    const workedOn = new Set(mine.map((r) => r.work_date));
    let fullSched = 0, sched = 0, absent = 0, leave = 0;
    for (let d = p.start_date; d <= p.end_date; d = addDays(d, 1)) {
      const k = kindOf(d);
      if (PAID[k] || k === "unpaid") fullSched++;           // planned working days in the period
      if (d < from) continue;
      if (PAID[k] || k === "unpaid") sched++;
      if (d <= lastPast && ((k === "shift" && !workedOn.has(d)) || k === "unpaid")) absent++;
      if (k === "vacation" || k === "sick" || k === "holiday") leave++;
    }
    let late = 0, under = 0;
    for (const r of mine) {
      const c = B.calcDay(r, staff, settings);
      late += c.late || 0;
      if (c.tout && c.schedEnd && c.tout < c.schedEnd) under += Math.round((c.schedEnd - c.tout) / 60000);
    }
    const auto = { days_worked: mine.length, late_mins: late, undertime_mins: under, absences: absent, other_ded: 0, other_note: "" };
    const v = { ...auto };
    for (const k of Object.keys(auto)) if (over[k] !== undefined && over[k] !== null && over[k] !== "") v[k] = k === "other_note" ? over[k] : Number(over[k]);
    const rate = Number(staff.pay_rate) || 0;
    const type = staff.pay_type === "period" ? "period" : "daily";
    // Daily rate: pay = (days worked + paid leave days) × rate. Absences simply aren't paid, so no separate deduction.
    // Per period: fixed amount for the period; absent days are deducted at rate ÷ working days.
    const daily = type === "daily" ? rate : fullSched ? rate / fullSched : 0;
    const minute = daily / Math.max(1, B.standardMins(staff));
    const paid_days = type === "daily" ? (Number(v.days_worked) || 0) + leave : sched;
    const gross = r2(type === "daily" ? daily * paid_days : daily * sched);
    const late_ded = r2(v.late_mins * minute), undertime_ded = r2(v.undertime_mins * minute), absence_ded = type === "daily" ? 0 : r2(v.absences * daily);
    const total_ded = r2(late_ded + undertime_ded + absence_ded + (Number(v.other_ded) || 0));
    return {
      staff_id: staff.id, employee_name: staff.full_name, start_date: staff.start_date || null, rate: r2(rate), pay_type: type, paid_days,
      days_scheduled: sched, paid_leave: leave, ...v, late_ded, undertime_ded, absence_ded, other_ded: r2(v.other_ded), total_ded,
      gross, net: r2(Math.max(0, gross - total_ded)), auto, overrides: over, daily: r2(daily), minute,
    };
  }

  /** Currency conversion and the transfer fee, split by each person's share of total net pay. */
  function finish(lines, p) {
    const xr = Number(p.exchange_rate) || null, fee = Number(p.transfer_fee) || 0;
    const totalNet = lines.reduce((a, l) => a + l.net, 0);
    for (const l of lines) {
      l.exchange_rate = xr;
      l.gross_php = xr ? r2(l.gross * xr) : null;
      l.net_php = xr ? r2(l.net * xr) : null;
      l.fee_share = totalNet ? Math.round((l.net / totalNet) * 10000) / 10000 : 0;
      l.fee_php = r2(fee * l.fee_share);
      l.received_php = xr ? r2(l.net_php - l.fee_php) : null;
    }
    return lines;
  }

  function totals(lines) {
    const t = {};
    for (const k of ["rate", "days_worked", "late_mins", "undertime_mins", "absences", "total_ded", "gross", "net", "gross_php", "net_php", "fee_php", "received_php"])
      t[k] = r2(lines.reduce((a, l) => a + (Number(l[k]) || 0), 0));
    return t;
  }

  /** Payslip card (HTML). `s` = a payslip row joined with its period. */
  function slipHtml(s, company) {
    const row = (k, v, cls = "") => `<tr class="${cls}"><td>${k}</td><td>${v}</td></tr>`;
    const head = (t) => `<tr class="sec"><td colspan="2">${t}</td></tr>`;
    const lateUnder = (Number(s.late_mins) || 0) + (Number(s.undertime_mins) || 0);
    return `<div class="slip">
      <div class="slip-title">PAYSLIP</div>
      <div class="slip-co">${B.esc(company || "BioHack London")}</div>
      <table>
        ${row("Employee Name:", `<b>${B.esc(s.employee_name)}</b>`)}
        ${row("Pay Period:", period({ start_date: s.period_start, end_date: s.period_end }))}
        ${row("Payment Date:", B.prettyDate(s.pay_date, { month: "long", day: "numeric", year: "numeric" }))}
        ${head("EARNINGS (GBP)")}
        ${row(s.pay_type === "daily" ? `Basic Pay (${Number(s.paid_days) || 0} day${Number(s.paid_days) === 1 ? "" : "s"} × ${GBP(s.rate)}):` : "Basic Pay:", `<b>${GBP(s.gross)}</b>`)}
        ${head("DEDUCTIONS (GBP)")}
        ${row(`Late/Undertime (${lateUnder} min):`, GBP(r2((+s.late_ded || 0) + (+s.undertime_ded || 0))))}
        ${row(`Absences (${Number(s.absences) || 0} day${Number(s.absences) === 1 ? "" : "s"}${s.pay_type === "daily" ? ", unpaid" : ""}):`, GBP(s.absence_ded))}
        ${row(`Other Deductions${s.other_note ? ` (${B.esc(s.other_note)})` : ""}:`, GBP(s.other_ded))}
        ${row("<b>Total Deductions:</b>", `<b>${GBP(s.total_ded)}</b>`)}
        ${head("TOTAL (GBP)")}
        ${row("<b>Net Pay (GBP):</b>", `<b>${GBP(s.net)}</b>`, "big")}
        ${head("PAYMENT CONVERSION")}
        ${row("Exchange Rate:", s.exchange_rate ? "₱" + Number(s.exchange_rate).toFixed(2) : "—")}
        ${row("Gross Pay (PHP):", PHP(s.gross_php))}
        ${row("Net Pay (PHP):", PHP(s.net_php))}
        ${row("Transfer Fee Share:", ((Number(s.fee_share) || 0) * 100).toFixed(2) + "%")}
        ${row("Transfer Fee (PHP):", PHP(s.fee_php))}
        ${head("TOTAL (PHP)")}
        <tr class="recv"><td>AMOUNT RECEIVED (PHP)</td><td>${PHP(s.received_php)}</td></tr>
      </table>
      <p class="slip-note">This payslip is generated electronically and does not require a signature.</p>
    </div>`;
  }

  const SLIP_CSS = `
  .slip { background: #fff; color: #15201b; border: 1px solid #c9d3cf; border-radius: 12px; overflow: hidden; max-width: 420px; font-size: 14px; }
  .slip-title { background: #0f5c56; color: #fff; text-align: center; font-weight: 800; letter-spacing: .35em; padding: 12px 0 2px; font-size: 18px; }
  .slip-co { background: #0f5c56; color: #cfe7e3; text-align: center; font-size: 12px; padding-bottom: 10px; }
  .slip table { width: 100%; border-collapse: collapse; }
  .slip td { padding: 6px 12px; border-bottom: 1px solid #e3e9e6; vertical-align: top; }
  .slip td:last-child { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .slip tr.sec td { background: #e8eeec; font-weight: 800; font-size: 12px; letter-spacing: .04em; color: #0f5c56; }
  .slip tr.big td { font-size: 15px; }
  .slip tr.recv td { background: #33e0ea; font-weight: 800; font-size: 16px; padding: 12px; }
  .slip-note { text-align: center; font-style: italic; color: #56655d; font-size: 12px; margin: 10px 14px 14px; }`;

  /** Add one payslip page to a jsPDF doc (portrait A5-ish on A4). */
  function slipPdf(doc, s, company, first) {
    if (!first) doc.addPage();
    const W = doc.internal.pageSize.getWidth(), X = (W - 300) / 2; let y = 50;
    const teal = [15, 92, 86], ink = [21, 32, 27], muted = [86, 101, 93];
    doc.setFillColor(...teal); doc.rect(X, y, 300, 44, "F");
    doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text("P A Y S L I P", W / 2, y + 22, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.text(company || "BioHack London", W / 2, y + 36, { align: "center" });
    y += 44;
    const line = (k, v, opt = {}) => {
      if (opt.fill) { doc.setFillColor(...opt.fill); doc.rect(X, y, 300, opt.h || 20, "F"); }
      doc.setDrawColor(220, 228, 224); doc.line(X, y + (opt.h || 20), X + 300, y + (opt.h || 20));
      doc.setTextColor(...(opt.color || ink)); doc.setFont("helvetica", opt.bold ? "bold" : "normal"); doc.setFontSize(opt.size || 9.5);
      doc.text(k, X + 8, y + (opt.h || 20) / 2 + 3.5);
      if (v != null) doc.text(String(v).replace("₱", "PHP "), X + 292, y + (opt.h || 20) / 2 + 3.5, { align: "right" });
      y += opt.h || 20;
    };
    const sec = (t) => line(t, null, { fill: [232, 238, 236], bold: true, color: teal, size: 8.5, h: 18 });
    const lateUnder = (Number(s.late_mins) || 0) + (Number(s.undertime_mins) || 0);
    line("Employee Name:", s.employee_name, { bold: true });
    line("Pay Period:", period({ start_date: s.period_start, end_date: s.period_end }));
    line("Payment Date:", B.prettyDate(s.pay_date, { month: "long", day: "numeric", year: "numeric" }));
    sec("EARNINGS (GBP)"); line(s.pay_type === "daily" ? `Basic Pay (${Number(s.paid_days) || 0} days x ${GBP(s.rate)}):` : "Basic Pay:", GBP(s.gross), { bold: true });
    sec("DEDUCTIONS (GBP)");
    line(`Late/Undertime (${lateUnder} min):`, GBP(r2((+s.late_ded || 0) + (+s.undertime_ded || 0))));
    line(`Absences (${Number(s.absences) || 0} days):`, GBP(s.absence_ded));
    line(`Other Deductions${s.other_note ? " (" + s.other_note + ")" : ""}:`, GBP(s.other_ded));
    line("Total Deductions:", GBP(s.total_ded), { bold: true });
    sec("TOTAL (GBP)"); line("Net Pay (GBP):", GBP(s.net), { bold: true, h: 26, size: 11 });
    sec("PAYMENT CONVERSION");
    line("Exchange Rate:", s.exchange_rate ? "PHP " + Number(s.exchange_rate).toFixed(2) : "—");
    line("Gross Pay (PHP):", PHP(s.gross_php)); line("Net Pay (PHP):", PHP(s.net_php));
    line("Transfer Fee Share:", ((Number(s.fee_share) || 0) * 100).toFixed(2) + "%"); line("Transfer Fee (PHP):", PHP(s.fee_php));
    sec("TOTAL (PHP)"); line("AMOUNT RECEIVED (PHP)", PHP(s.received_php), { fill: [51, 224, 234], bold: true, size: 12, h: 32 });
    doc.setDrawColor(201, 211, 207); doc.rect(X, 50, 300, y - 50);
    doc.setTextColor(...muted); doc.setFont("helvetica", "italic"); doc.setFontSize(8);
    doc.text("This payslip is generated electronically and does not require a signature.", W / 2, y + 18, { align: "center" });
  }
  // jsPDF's built-in font has no ₱ or £ glyphs: write "PHP" / "GBP" in PDFs.
  function pdfSafe(s) { return s; }

  Object.assign(B, { payroll: { compute, finish, totals, weekdays, slipHtml, slipPdf, SLIP_CSS, GBP, PHP, r2, period, usDate, addDays } });
})();
