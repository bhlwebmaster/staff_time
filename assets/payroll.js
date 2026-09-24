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

  /** Pay types. Pay periods are bi-monthly cut-offs (1–15, 16–end of month) of usually 10 working days. */
  const TYPES = {
    hourly:    { label: "Hourly",     short: "per hour",    rateLabel: "Hourly rate (£)",       eg: "e.g. 4" },
    daily:     { label: "Daily",      short: "per day",     rateLabel: "Daily rate (£)",        eg: "e.g. 30" },
    weekly:    { label: "Weekly",     short: "per week",    rateLabel: "Weekly rate (£)",       eg: "e.g. 150" },
    bimonthly: { label: "Bi-monthly", short: "per cut-off", rateLabel: "Rate per cut-off (£)",  eg: "e.g. 300" },
    monthly:   { label: "Monthly",    short: "per month",   rateLabel: "Monthly rate (£)",      eg: "e.g. 600" },
  };
  const payType = (t) => (t === "period" ? "bimonthly" : TYPES[t] ? t : "daily");
  /** Bi-monthly cut-off containing a date: 1–15 or 16–end of month. */
  function cutoffOf(ds) {
    const [y, m, d] = ds.split("-").map(Number), mm = String(m).padStart(2, "0");
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d <= 15 ? { start_date: `${y}-${mm}-01`, end_date: `${y}-${mm}-15` } : { start_date: `${y}-${mm}-16`, end_date: `${y}-${mm}-${last}` };
  }
  const nextCutoff = (c) => cutoffOf(addDays(c.end_date, 1));
  const prevCutoff = (c) => cutoffOf(addDays(c.start_date, -1));

  /**
   * One person's pay for a cut-off, from their attendance and the schedule.
   * - Hourly: pay = (regular hours worked + paid leave days × paid hours per day) × rate. Lates/undertime are already
   *   missing from the hours, so they aren't deducted again.
   * - Daily: pay = (days worked + paid leave days) × rate. Absent days simply aren't paid.
   * - Weekly / Bi-monthly / Monthly: fixed pay per cut-off (weekly: 2 weeks' pay = daily × working days per cut-off,
   *   bi-monthly: the rate, monthly: half the rate). Daily rate = cut-off pay ÷ working days per cut-off (Settings, usually 10).
   *   Absences are deducted at that daily rate.
   * - Minute rate (for lates/undertime) = daily ÷ paid minutes per day.
   * - Started mid-period (fixed types): paid for the working days from their start date, up to the cut-off pay.
   * - Public holidays on a working day are paid days off (unless the holiday is marked unpaid in Settings).
   * - Lates: minutes after the day's scheduled start (beyond grace). Undertime: minutes before the day's scheduled end.
   * - Working days come from the weekly schedule (rest days don't count; paid leave is paid, unpaid leave is deducted).
   * - Absences: planned shifts up to today (or period end) with no clock-in, plus unpaid leave days.
   * - Anything in `over` (typed by an admin) replaces the automatic value.
   */
  function compute(staff, rows, p, settings, over = {}, today = B.dateIn(new Date(), settings.timezone), plan = null) {
    // plan(date) → { kind: shift | rest | vacation | sick | emergency | holiday | unpaid } from the weekly schedule; default Mon–Fri.
    const kindOf = (d) => { if (!plan) return isWeekday(d) ? "shift" : "rest"; const e = plan(d); return e.kind === "holiday" && e.paid === false ? "rest" : e.kind; };
    const PAID = { shift: 1, vacation: 1, sick: 1, emergency: 1, holiday: 1 };
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
      if (k === "vacation" || k === "sick" || k === "emergency" || (k === "holiday" && !workedOn.has(d))) leave++;
    }
    // Lates / undertime.
    // Judge by hours (default): a day with its full hours has nothing to deduct. Short time is first covered by OT from
    //   the person's last work day (OT can only be used on the next work day); what's left is undertime.
    // Strict: minutes late after grace + minutes left before the scheduled end, as before.
    const flex = settings.flex_hours !== false;
    const days = B.calcDays(rows.filter((r) => r.staff_id === staff.id && r.time_in), staff, settings);
    let late = 0, under = 0, hrs = 0;
    for (const r of mine) {
      const c = days.get(r.work_date);
      if (c.complete) hrs += Math.min(c.worked, c.std) + c.otUsed;
      if (flex) under += c.short || 0;
      else {
        late += c.late || 0;
        if (c.tout && c.schedEnd && c.tout < c.schedEnd) under += Math.round((c.schedEnd - c.tout) / 60000);
      }
    }
    const auto = { days_worked: mine.length, hours_worked: r2(hrs / 60), late_mins: late, undertime_mins: under, absences: absent, other_ded: 0, other_note: "" };
    const v = { ...auto };
    for (const k of Object.keys(auto)) if (over[k] !== undefined && over[k] !== null && over[k] !== "") v[k] = k === "other_note" ? over[k] : Number(over[k]);
    const rate = Number(staff.pay_rate) || 0;
    const type = payType(staff.pay_type), dpc = Number(settings.days_per_cutoff) || 10, std = Math.max(1, B.standardMins(staff));
    let daily, gross, paid_days, paid_hours = 0, absence_ded = 0;
    if (type === "hourly") {
      daily = rate * std / 60;
      paid_days = (Number(v.days_worked) || 0) + leave;
      paid_hours = r2((Number(v.hours_worked) || 0) + leave * std / 60);
      gross = r2(rate * paid_hours);
    } else if (type === "daily") {
      daily = rate; paid_days = (Number(v.days_worked) || 0) + leave; gross = r2(daily * paid_days);
    } else {
      daily = type === "weekly" ? rate / 5 : type === "monthly" ? rate / 2 / dpc : rate / dpc;
      const cut = daily * dpc;
      paid_days = sched;
      gross = r2(from > p.start_date ? Math.min(cut, daily * sched) : cut);
      absence_ded = r2(v.absences * daily);
    }
    const minute = daily / std;
    const late_ded = type === "hourly" ? 0 : r2(v.late_mins * minute), undertime_ded = type === "hourly" ? 0 : r2(v.undertime_mins * minute);
    const total_ded = r2(late_ded + undertime_ded + absence_ded + (Number(v.other_ded) || 0));
    return {
      staff_id: staff.id, employee_name: staff.full_name, start_date: staff.start_date || null, rate: r2(rate), pay_type: type, paid_days, paid_hours,
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
    for (const k of ["rate", "days_worked", "hours_worked", "late_mins", "undertime_mins", "absences", "total_ded", "gross", "net", "gross_php", "net_php", "fee_php", "received_php"])
      t[k] = r2(lines.reduce((a, l) => a + (Number(l[k]) || 0), 0));
    return t;
  }

  /** "Basic Pay (…)" wording for a payslip. */
  function basicLabel(s, x = "×") {
    const t = payType(s.pay_type), n = Number(s.paid_days) || 0;
    if (t === "hourly") return `Basic Pay (${r2(s.paid_hours)} hrs ${x} ${GBP(s.rate)}):`;
    if (t === "daily") return `Basic Pay (${n} day${n === 1 ? "" : "s"} ${x} ${GBP(s.rate)}):`;
    return `Basic Pay (${TYPES[t].label}, ${GBP(s.rate)} ${TYPES[t].short}):`;
  }
  const unpaidAbs = (s) => ["hourly", "daily"].includes(payType(s.pay_type));

  /** Payslip card (HTML). `s` = a payslip row joined with its period. */
  function slipHtml(s, company) {
    const row = (k, v, cls = "") => `<tr class="${cls}"><td>${k}</td><td>${v}</td></tr>`;
    const head = (t) => `<tr class="sec"><td colspan="2">${t}</td></tr>`;
    const lateUnder = (Number(s.late_mins) || 0) + (Number(s.undertime_mins) || 0);
    return `<div class="slip">
      <div class="slip-head">${B.LOGO ? `<img src="${B.LOGO.src}" alt="The Biohack Group">` : `<b>${B.esc(company || "THE BIOHACK GROUP")}</b>`}<span>PAYSLIP</span></div>
      <table>
        ${row("Employee Name:", `<b>${B.esc(s.employee_name)}</b>`)}
        ${row("Pay Period:", period({ start_date: s.period_start, end_date: s.period_end }))}
        ${row("Payment Date:", B.prettyDate(s.pay_date, { month: "long", day: "numeric", year: "numeric" }))}
        ${head("EARNINGS (GBP)")}
        ${row(basicLabel(s), `<b>${GBP(s.gross)}</b>`)}
        ${head("DEDUCTIONS (GBP)")}
        ${row(`Late/Undertime (${lateUnder} min):`, GBP(r2((+s.late_ded || 0) + (+s.undertime_ded || 0))))}
        ${row(`Absences (${Number(s.absences) || 0} day${Number(s.absences) === 1 ? "" : "s"}${unpaidAbs(s) ? ", unpaid" : ""}):`, GBP(s.absence_ded))}
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
      <p class="slip-note"><b>Computer-generated payslip. No signature required.</b> ${SLIP_NOTE}</p>
      <p class="slip-note">${B.esc(EMPLOYER_CLAUSE)}</p>
    </div>`;
  }

  const SLIP_CSS = `
  .slip { background: #fff; color: #15201b; border: 1px solid #c9d3cf; border-radius: 12px; overflow: hidden; max-width: 420px; font-size: 14px; }
  .slip-head { background: #0c0c0c; border-bottom: 3px solid #0f5c56; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 14px; }
  .slip-head img { height: 11px; width: auto; display: block; }
  .slip-head b { color: #fff; letter-spacing: .12em; font-size: 12px; }
  .slip-head span { color: #fff; font-weight: 800; letter-spacing: .08em; font-size: 15px; }
  .slip-title { background: #0f5c56; color: #fff; text-align: center; font-weight: 800; letter-spacing: .35em; padding: 12px 0 2px; font-size: 18px; }
  .slip-co { background: #0f5c56; color: #cfe7e3; text-align: center; font-size: 12px; padding-bottom: 10px; }
  .slip table { width: 100%; border-collapse: collapse; }
  .slip td { padding: 6px 12px; border-bottom: 1px solid #e3e9e6; vertical-align: top; }
  .slip td:last-child { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .slip tr.sec td { background: #e8eeec; font-weight: 800; font-size: 12px; letter-spacing: .04em; color: #0f5c56; }
  .slip tr.big td { font-size: 15px; }
  .slip tr.recv td { background: #33e0ea; font-weight: 800; font-size: 16px; padding: 12px; }
  .slip-note { color: #68706d; font-size: 11px; line-height: 1.45; margin: 10px 14px 12px; }
  .slip-note + .slip-note { margin-top: 0; }`;

  /** Employer details printed at the foot of every payslip. */
  const EMPLOYER_CLAUSE = "THE BIOHACK GROUP, a company registered in Cyprus, with its registered/business address at 9, Kastellorizou, 4532, " +
    "Agios Tychonas, Limassol, Cyprus, represented by Myles Gerrome Jessop, hereinafter referred to as the “Employer”.";
  const SLIP_NOTE = "This is a computer-generated payslip and does not require a signature or company stamp. It is issued electronically by the " +
    "Employer and is confidential to the employee named above. Please check the details and report any discrepancy to the Company Human Resources as soon as possible.";

  /** One full A4 payslip page: logo header, employee details, earnings, deductions, payment, and a footer. */
  function slipPdf(doc, s, company, first) {
    if (!first) doc.addPage();
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 48, CW = W - 2 * M;
    const ink = [24, 28, 27], muted = [104, 112, 109], rule = [222, 226, 224], soft = [245, 246, 245], teal = [15, 92, 86], black = [12, 12, 12];
    const money = (n) => GBP(n);
    const peso = (n) => (n == null || isNaN(n) ? "-" : "PHP " + r2(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const t = payType(s.pay_type), T = TYPES[t];
    const font = (style = "normal", size = 10, color = ink) => { doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(...color); };

    // ---- header: black band with the logo ----
    doc.setFillColor(...black); doc.rect(0, 0, W, 92, "F");
    const L = B.LOGO; let lw = 250, lh = L ? (lw * L.h) / L.w : 0;
    if (L) doc.addImage(L.src, "PNG", M, 46 - lh / 2, lw, lh);
    else { font("bold", 16, [255, 255, 255]); doc.text((company || "THE BIOHACK GROUP").toUpperCase(), M, 51); }
    font("bold", 20, [255, 255, 255]); doc.text("PAYSLIP", W - M, 44, { align: "right" });
    font("normal", 9, [190, 196, 194]); doc.text(period({ start_date: s.period_start, end_date: s.period_end }), W - M, 60, { align: "right" });
    doc.setFillColor(...teal); doc.rect(0, 92, W, 3, "F");

    // ---- employee details ----
    let y = 126;
    font("bold", 8, muted); doc.text("EMPLOYEE", M, y); doc.text("PAY DETAILS", M + CW / 2, y);
    y += 8; doc.setDrawColor(...rule); doc.setLineWidth(0.8); doc.line(M, y, W - M, y);
    const kv = (x, yy, k, v) => { font("normal", 9, muted); doc.text(k, x, yy); font("bold", 10.5, ink); doc.text(String(v ?? "-"), x + 92, yy); };
    y += 20;
    kv(M, y, "Name", s.employee_name); kv(M + CW / 2, y, "Pay period", period({ start_date: s.period_start, end_date: s.period_end }));
    y += 18;
    kv(M, y, "Start date", s.start_date ? B.prettyDate(s.start_date, { day: "numeric", month: "long", year: "numeric" }) : "-");
    kv(M + CW / 2, y, "Payment date", B.prettyDate(s.pay_date, { day: "numeric", month: "long", year: "numeric" }));
    y += 18;
    kv(M, y, "Pay type", T.label); kv(M + CW / 2, y, "Rate", `${money(s.rate)} ${T.short}`);

    // ---- tables ----
    const table = (title, rows, totalLabel, total) => {
      y += 30;
      doc.setFillColor(...soft); doc.rect(M, y - 13, CW, 20, "F");
      font("bold", 8.5, teal); doc.text(title, M + 10, y); doc.text("DETAILS", M + CW * 0.52, y); doc.text("AMOUNT (GBP)", W - M - 10, y, { align: "right" });
      y += 7;
      for (const [k, d, v] of rows) {
        y += 19; font("normal", 10, ink); doc.text(k, M + 10, y);
        font("normal", 9.5, muted); doc.text(d || "", M + CW * 0.52, y);
        font("normal", 10, ink); doc.text(v, W - M - 10, y, { align: "right" });
        doc.setDrawColor(...rule); doc.setLineWidth(0.6); doc.line(M, y + 7, W - M, y + 7);
      }
      y += 21; font("bold", 10.5, ink); doc.text(totalLabel, M + 10, y); doc.text(total, W - M - 10, y, { align: "right" });
    };
    const n = (x) => Number(x) || 0, pl = (x, w) => `${x} ${w}${x === 1 ? "" : "s"}`;
    const basicD = t === "hourly" ? `${r2(s.paid_hours)} hours x ${money(s.rate)}` : t === "daily" ? `${pl(n(s.paid_days), "day")} x ${money(s.rate)}`
      : `${T.label} rate, ${money(s.rate)} ${T.short}`;
    table("EARNINGS", [["Basic pay", basicD, money(s.gross)]], "Gross pay", money(s.gross));
    const unpaid = t === "hourly" || t === "daily";
    table("DEDUCTIONS", [
      ["Lates", pl(n(s.late_mins), "minute") + (t === "hourly" && n(s.late_mins) ? " (already left out of paid hours)" : ""), money(s.late_ded)],
      ["Undertime", pl(n(s.undertime_mins), "minute") + (t === "hourly" && n(s.undertime_mins) ? " (already left out of paid hours)" : ""), money(s.undertime_ded)],
      ["Absences", pl(n(s.absences), "day") + (unpaid && n(s.absences) ? " (not paid, no deduction)" : ""), money(s.absence_ded)],
      ["Other deductions", s.other_note || "", money(s.other_ded)],
    ], "Total deductions", money(s.total_ded));

    // ---- net pay ----
    y += 26;
    doc.setFillColor(...ink); doc.rect(M, y - 16, CW, 30, "F");
    font("bold", 11, [255, 255, 255]); doc.text("NET PAY (GBP)", M + 10, y + 3); font("bold", 13, [255, 255, 255]); doc.text(money(s.net), W - M - 10, y + 3.5, { align: "right" });

    // ---- payment in pesos ----
    y += 44;
    doc.setFillColor(...soft); doc.rect(M, y - 13, CW, 20, "F");
    font("bold", 8.5, teal); doc.text("PAYMENT (PHP)", M + 10, y);
    y += 7;
    const prow = (k, v) => { y += 19; font("normal", 10, ink); doc.text(k, M + 10, y); doc.text(v, W - M - 10, y, { align: "right" });
      doc.setDrawColor(...rule); doc.setLineWidth(0.6); doc.line(M, y + 7, W - M, y + 7); };
    prow("Exchange rate", s.exchange_rate ? `PHP ${Number(s.exchange_rate).toFixed(2)} per GBP 1` : "-");
    prow("Gross pay (PHP)", peso(s.gross_php));
    prow("Net pay (PHP)", peso(s.net_php));
    prow(`Transfer fee (${((Number(s.fee_share) || 0) * 100).toFixed(2)}% share)`, peso(s.fee_php));
    y += 30;
    doc.setFillColor(230, 246, 243); doc.setDrawColor(...teal); doc.setLineWidth(1.2); doc.rect(M, y - 18, CW, 38, "FD");
    font("bold", 11.5, teal); doc.text("AMOUNT RECEIVED (PHP)", M + 12, y + 5); font("bold", 16, teal); doc.text(peso(s.received_php), W - M - 12, y + 6, { align: "right" });

    // ---- footer ----
    font("normal", 8.2, muted);   // wrap using the footer's font size
    const clause = doc.splitTextToSize(EMPLOYER_CLAUSE, CW), note = doc.splitTextToSize(SLIP_NOTE, CW);
    let fy = H - 44 - (note.length + clause.length) * 11 - 34;
    doc.setDrawColor(...rule); doc.setLineWidth(0.8); doc.line(M, fy, W - M, fy);
    fy += 18; font("bold", 9, ink); doc.text("Computer-generated payslip. No signature required.", M, fy);
    fy += 13; font("normal", 8.2, muted); doc.text(note, M, fy);
    fy += note.length * 11 + 8; font("bold", 8.2, ink); doc.text("Employer", M, fy);
    fy += 11; font("normal", 8.2, muted); doc.text(clause, M, fy);
    doc.setFillColor(...black); doc.rect(0, H - 22, W, 22, "F");
    font("normal", 7.5, [190, 196, 194]);
    doc.text("THE BIOHACK GROUP  |  Confidential", M, H - 8.5);
    doc.text(`Generated ${B.prettyDate(new Date().toISOString().slice(0, 10), { day: "numeric", month: "short", year: "numeric" })}`, W - M, H - 8.5, { align: "right" });
  }
  // jsPDF's built-in font has no ₱ or £ glyphs: write "PHP" / "GBP" in PDFs.
  function pdfSafe(s) { return s; }

  Object.assign(B, { payroll: { compute, finish, totals, weekdays, slipHtml, slipPdf, SLIP_CSS, EMPLOYER_CLAUSE, SLIP_NOTE, GBP, PHP, r2, period, usDate, addDays, TYPES, payType, cutoffOf, nextCutoff, prevCutoff } });
})();
