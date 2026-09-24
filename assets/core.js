/* Shared helpers: Supabase client, timezone maths, and the hours/OT rules. */
(function () {
  const cfg = window.BHL_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !/YOUR-PROJECT/.test(cfg.SUPABASE_URL) && cfg.SUPABASE_ANON_KEY && !/YOUR-ANON/.test(cfg.SUPABASE_ANON_KEY);
  const sb = configured && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  // ---------- time zones ----------
  const partsCache = {};
  function fmtParts(tz) {
    return (partsCache[tz] ||= new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  function tzOffsetMs(date, tz) {
    const p = {};
    for (const x of fmtParts(tz).formatToParts(date)) p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
  }
  /** "2026-09-23" + "06:30" in tz → Date */
  function zonedToDate(dateStr, timeStr, tz) {
    if (!dateStr || !timeStr) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm] = timeStr.split(":").map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    let t = guess - tzOffsetMs(new Date(guess), tz);
    t = guess - tzOffsetMs(new Date(t), tz);
    return new Date(t);
  }
  /** Date → "YYYY-MM-DD" in tz */
  function dateIn(date, tz) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
  /** Date → "HH:MM" (24h) in tz — for <input type=time> */
  function hhmmIn(date, tz) {
    if (!date) return "";
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  }
  /** Date → "6:25 AM" in tz */
  function clockIn(date, tz) {
    if (!date) return "";
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
  }
  /** "06:30:00" → "6:30 AM" */
  function clockStr(t) {
    if (!t) return "";
    let [h, m] = t.split(":").map(Number);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, "0")} ${ap}`;
  }
  function tzShort(tz, date = new Date()) {
    const n = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(date).find((p) => p.type === "timeZoneName");
    return n ? n.value : tz;
  }
  const minsOf = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const d = (iso) => (iso ? new Date(iso) : null);

  function fmtMins(m, { sign = false } = {}) {
    if (m == null || isNaN(m)) return "—";
    const s = m < 0 ? "−" : sign && m > 0 ? "+" : "";
    m = Math.abs(Math.round(m));
    const h = Math.floor(m / 60), mm = m % 60;
    return `${s}${h}:${String(mm).padStart(2, "0")}`;
  }
  const hoursDec = (m) => (Math.round((m / 60) * 100) / 100).toFixed(2);

  function prettyDate(dateStr, opts = { weekday: "short", day: "numeric", month: "short" }) {
    const [y, m, dd] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  }

  // ---------- the rules ----------
  /** Standard paid minutes for a staff member's normal day (e.g. 6:00–15:00 minus 60 lunch = 480). */
  const standardMins = (staff) => minsOf(staff.sched_end) - minsOf(staff.sched_start) - (staff.lunch_mins ?? 60);

  /** Planned unpaid lunch for a date: that weekday's lunch in the usual week, else the person's standard lunch. */
  function plannedLunch(staff, dateStr) {
    const g = new Date(dateStr + "T12:00:00Z").getUTCDay(), p = staff.week_pattern && staff.week_pattern[String(g)];
    if (p && p.l != null && p.l !== "") return Number(p.l) || 0;
    return staff.lunch_mins ?? 60;
  }

  /**
   * Work out one day.
   * - Worked = time out − time in − the lunch actually tapped (no lunch tapped = nothing taken off).
   *   Minutes before the scheduled start count only if Settings → "count early minutes" is on.
   * - Expected = that day's scheduled start→end − that day's planned lunch (Staff → Usual week).
   * - OT = worked beyond expected, in whole blocks (Settings, e.g. 30 min: 45 min extra → 30).
   * - Short = worked below expected (taken from OT first, then counted as undertime in payroll).
   * - Late: clocked in after start + grace. With "judge by hours" on, a complete day with its full hours isn't late.
   * - noLunch: a complete day with a planned lunch but no lunch taps (worth a check).
   */
  function calcDay(row, staff, settings, now = new Date()) {
    const tz = settings.timezone;
    const sStart = zonedToDate(row.work_date, row.sched_start, tz);
    const sEnd = zonedToDate(row.work_date, row.sched_end, tz);
    const tin = d(row.time_in), tout = d(row.time_out), lo = d(row.lunch_out), li = d(row.lunch_in);
    let span = row.sched_start && row.sched_end ? minsOf(row.sched_end) - minsOf(row.sched_start) : standardMins(staff) + (staff.lunch_mins ?? 60);
    if (span <= 0) span += 1440;                              // overnight shift
    const planLunch = plannedLunch(staff, row.work_date);
    const std = Math.max(0, span - planLunch);
    const flex = settings.flex_hours !== false;
    const out = { date: row.work_date, std, planLunch, late: 0, lateRaw: 0, worked: null, variance: null, ot: 0, short: 0, lunch: null, noLunch: false,
                  complete: !!(tin && tout), open: !!(tin && !tout), status: "absent", tin, tout, lo, li };
    if (tin && sStart) {
      const lateMs = tin - sStart;
      if (lateMs > (settings.grace_mins ?? 5) * 60000) out.late = out.lateRaw = Math.round(lateMs / 60000);
    }
    out.lunch = lo && li ? Math.round((li - lo) / 60000) : null;
    if (tin && !tout) out.status = lo && !li ? "lunch" : "in";
    if (tout) out.status = "out";
    if (tin && tout) {
      const effIn = settings.count_early ? tin : new Date(Math.max(tin, sStart || tin));
      const lunchMs = lo && li ? li - lo : 0;
      out.worked = Math.max(0, Math.round((tout - effIn - lunchMs) / 60000));
      out.variance = out.worked - std;
      const block = Math.max(1, settings.ot_block_mins || 1);
      if (out.variance > 0) out.ot = Math.floor(out.variance / block) * block;
      if (out.variance < 0) out.short = -out.variance;
      if (flex && out.variance >= 0) out.late = 0;          // full hours done: starting late doesn't count
      out.noLunch = planLunch > 0 && !(lo && li);
    }
    out.schedStart = sStart; out.schedEnd = sEnd;
    return out;
  }

  /** Roll a set of rows (one person) into period totals. */
  function summarise(rows, staff, settings, today) {
    const s = { days: 0, complete: 0, worked: 0, regular: 0, ot: 0, short: 0, late: 0, lateMins: 0, missingOut: 0, days_list: [] };
    for (const r of rows) {
      const c = calcDay(r, staff, settings);
      s.days_list.push({ row: r, c });
      if (!c.tin) continue;
      s.days++;
      if (c.late) { s.late++; s.lateMins += c.late; }
      if (c.complete) {
        s.complete++; s.worked += c.worked; s.ot += c.ot; s.short += c.short;
        s.regular += Math.min(c.worked, c.std);
      } else if (r.work_date !== today) s.missingOut++;
    }
    s.bank = s.ot - s.short;
    s.billable = s.regular + s.ot;
    return s;
  }

  function whatsappText(row, staff, settings) {
    const tz = settings.timezone;
    const label = "GMT";
    const lines = [
      `Date: ${prettyDate(row.work_date, { month: "long", day: "numeric", year: "numeric" })}`,
      `Name: ${staff.full_name}`,
      `Sched: ${clockStr(row.sched_start)} - ${clockStr(row.sched_end)} ${label}`,
      `Time In: ${row.time_in ? clockIn(d(row.time_in), tz) + " " + label : ""}`,
    ];
    if (row.lunch_out) lines.push(`Lunch Break: ${clockIn(d(row.lunch_out), tz)} – ${row.lunch_in ? clockIn(d(row.lunch_in), tz) : "…"} ${label}`);
    lines.push(`Time out: ${row.time_out ? clockIn(d(row.time_out), tz) + " " + label : ""}`);
    if (row.note) lines.push("", row.note);
    return lines.join("\n");
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg, kind = "ok") {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = msg; el.dataset.kind = kind; el.classList.add("show");
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3200);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok; }
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

  window.BHL = { cfg, sb, configured, tzOffsetMs, zonedToDate, dateIn, hhmmIn, clockIn, clockStr, tzShort, minsOf,
    fmtMins, hoursDec, prettyDate, standardMins, plannedLunch, calcDay, summarise, whatsappText, esc, toast, copyText, lsGet, lsSet };
})();
