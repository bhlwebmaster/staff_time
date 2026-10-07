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
   * - Worked = time out − time in − the lunch actually tapped (no lunch tapped = nothing taken off),
   *   plus any after-hours OT clocked after the shift (row.after_mins), so all of a day's time is rounded once.
   *   Minutes before the scheduled start count only if Settings → "count early minutes" is on.
   * - Expected = that day's scheduled start→end − that day's planned lunch (Staff → Usual week).
   *   No lunch tapped: the shift length, but no more than their normal day (e.g. 8:00) or the shift minus lunch if that's longer.
   *   So a 9:00–18:00 day without lunch still expects 8:00, and a 9:00–13:00 half day without lunch expects 4:00 (not 3:00).
   * - OT = worked beyond expected, in whole blocks (Settings, e.g. 30 min: 45 min extra → 30).
   * - Short = worked below expected (taken from OT first, then counted as undertime in payroll).
   * - Late: clocked in after start + grace. With "judge by hours" on, a complete day with its full hours isn't late.
   * - noLunch: a complete day with a planned lunch but no lunch taps (worth a check).
   * - OT from the last work day (opts.avail, see calcDays) covers short time today; what it can't cover stays "short".
   *   Expected hours come from the PLANNED schedule (plan_start/plan_end), so starting later or leaving earlier
   *   with "use yesterday's OT" draws on that OT instead of reducing the day.
   */
  function calcDay(row, staff, settings, opts = {}) {
    const tz = settings.timezone;
    const sStart = zonedToDate(row.work_date, row.sched_start, tz);
    const sEnd = zonedToDate(row.work_date, row.sched_end, tz);
    const tin = d(row.time_in), tout = d(row.time_out), lo = d(row.lunch_out), li = d(row.lunch_in);
    const ps = row.plan_start || row.sched_start, pe = row.plan_end || row.sched_end;
    let span = ps && pe ? minsOf(pe) - minsOf(ps) : standardMins(staff) + (staff.lunch_mins ?? 60);
    if (span <= 0) span += 1440;                              // overnight shift
    const isRest = row.day_kind === "rest";                   // rest day: nothing is expected, every worked minute is OT
    const planLunch = isRest ? 0 : plannedLunch(staff, row.work_date);
    const tookLunch = !!(row.lunch_out && row.lunch_in);
    const std = isRest ? 0 : tookLunch ? Math.max(0, span - planLunch) : Math.min(span, Math.max(span - planLunch, standardMins(staff)));
    const flex = settings.flex_hours !== false;
    const avail = Math.max(0, Number(opts.avail) || 0);
    const after = Math.max(0, Number(row.after_mins) || 0);
    const out = { date: row.work_date, std, planLunch, otAvail: avail, otFrom: opts.availFrom || null, otUsed: 0, late: 0, lateRaw: 0, worked: null, variance: null, ot: 0, short: 0, lunch: null, noLunch: false, after,
                  complete: !!(tin && tout), open: !!(tin && !tout), status: "absent", tin, tout, lo, li };
    if (tin && sStart && !isRest) {
      const lateMs = tin - sStart;
      if (lateMs > (settings.grace_mins ?? 5) * 60000) out.late = out.lateRaw = Math.round(lateMs / 60000);
    }
    out.lunch = lo && li ? Math.round((li - lo) / 60000) : null;
    if (tin && !tout) out.status = lo && !li ? "lunch" : "in";
    if (tout) out.status = "out";
    if (tin && tout) {
      const effIn = settings.count_early ? tin : new Date(Math.max(tin, sStart || tin));
      const lunchMs = lo && li ? li - lo : 0;
      out.worked = Math.max(0, Math.round((tout - effIn - lunchMs) / 60000)) + after;
      out.variance = out.worked - std;
      const block = Math.max(1, settings.ot_block_mins || 1);
      if (out.variance > 0) out.ot = Math.floor(out.variance / block) * block;
      if (out.variance < 0) {
        out.otUsed = Math.min(-out.variance, avail);          // last work day's OT covers the gap first
        out.short = -out.variance - out.otUsed;
      }
      if (flex && out.short === 0) out.late = 0;             // full hours done (with OT): starting late doesn't count
      out.noLunch = planLunch > 0 && !(lo && li) && std < span;   // a short day that needs no lunch isn't flagged
    } else if (!tin && isRest && after > 0) {
      // Rest day worked only in OT sessions (no clock-in): all of it is OT
      out.worked = after; out.variance = after; out.complete = true; out.status = "out";
      const block = Math.max(1, settings.ot_block_mins || 1);
      out.ot = Math.floor(after / block) * block;
    }
    out.schedStart = sStart; out.schedEnd = sEnd;
    return out;
  }

  const daysApart = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
  /** OT can be used on the next work day only: the next day they clock in, if it's within this many days (Fri → Mon/Tue). */
  const OT_WINDOW_DAYS = 4;
  /** Carry-over OT bank (people with After-hours OT on, from staff.ot_carry_from): OT never expires, it waits until used. */
  const carriesOt = (staff, date) => !!staff.ot_carry_from && date >= staff.ot_carry_from;
  /** The most of a carry-over bank someone can plan to use at clock-in (Settings → Max OT bank use per day). Other short time takes from the whole bank. */
  const dailyUse = (settings) => Math.max(0, settings.ot_daily_use_mins ?? 180);
  /**
   * Work out every day for one person, in date order, passing each work day's OT to the next work day.
   * Returns a Map work_date → calcDay result. Give it a few days before the range you show, so the first day
   * knows about the OT before it. row.ot_adjust = extra OT credit an admin granted for that day.
   * Carry-over bank: unused OT stays in the bank (oldest used first) and today's OT is added on top. Rows must go back
   * to staff.ot_carry_from for the bank to be right (api.admin.attendance and punch() load them).
   */
  function calcDays(rows, staff, settings) {
    const list = rows.slice().sort((a, b) => (a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : 0));
    const out = new Map(); let bank = 0, bankFrom = null, bankDate = null;
    for (const r of list) {
      const carry = carriesOt(staff, r.work_date);
      let avail = Number(r.ot_adjust) || 0, from = null;
      const live = bank > 0 && bankDate && (carry || daysApart(bankDate, r.work_date) <= OT_WINDOW_DAYS);
      if (live) { avail += bank; from = bankFrom; }   // short time takes from the whole bank; undertime only once it's empty
      const c = calcDay(r, staff, settings, { avail, availFrom: from });
      c.carry = carry;
      out.set(r.work_date, c);
      if (carry) c.bankAfter = bank;   // until the day is done, the whole bank is still there
      if (!r.time_in && !c.complete) continue;
      if (carry) {
        const left = avail - (c.complete ? c.otUsed : 0), add = c.complete ? c.ot : 0;
        if (left <= 0) bankFrom = add ? r.work_date : null;   // bank was used up: what's left starts from today
        else if (!bankFrom) bankFrom = r.work_date;
        bank = left + add;
        c.bankAfter = bank; c.overCap = bank > (settings.ot_bank_cap_mins ?? 480);
      } else if (r.day_kind === "rest") {
        // A rest day never uses OT: it adds its own OT to the bank, and the bank waits for the next working day.
        bank = (live ? bank : 0) + (c.complete ? c.ot : 0);
        if (!live) bankFrom = r.work_date;
      } else { bank = c.complete ? c.ot : 0; bankFrom = r.work_date; }   // a working day uses the bank; only its own OT moves on
      bankDate = r.work_date;
    }
    out.bank = bank; out.bankFrom = bankFrom; out.bankDate = bankDate;
    out.carry = carriesOt(staff, bankDate || "9999");
    return out;
  }
  /**
   * OT this person can still use today: from their last work day (if today is their next one), minus what's used.
   * mins = OT to use today, or the whole bank for a carry-over bank. use = what today can actually use (bank: up to the daily max).
   */
  function otToday(rows, staff, settings, today) {
    const all = calcDays(rows.filter((r) => r.work_date <= today), staff, settings);
    const t = all.get(today);
    if (t) {
      const left = Math.max(0, t.otAvail - (t.complete ? t.otUsed : 0));
      return { mins: t.carry ? t.bankAfter ?? t.otAvail : left, use: t.carry ? Math.min(left, dailyUse(settings)) : left, from: t.otFrom, used: t.otUsed, today: true, carry: t.carry };
    }
    if (all.bank > 0 && all.bankDate && (all.carry || daysApart(all.bankDate, today) <= OT_WINDOW_DAYS))
      return { mins: all.bank, use: all.carry ? Math.min(all.bank, dailyUse(settings)) : all.bank, from: all.bankFrom, used: 0, today: false, carry: all.carry };
    return { mins: 0, use: 0, from: null, used: 0, today: false, carry: carriesOt(staff, today) };
  }

  /** Roll a set of rows (one person) into period totals. opts.from: only count days from this date (earlier rows only feed OT). */
  function summarise(rows, staff, settings, today, opts = {}) {
    const s = { days: 0, complete: 0, worked: 0, regular: 0, ot: 0, otUsed: 0, short: 0, late: 0, lateMins: 0, missingOut: 0, days_list: [] };
    const all = calcDays(rows, staff, settings);
    for (const r of rows.slice().sort((a, b) => (a.work_date < b.work_date ? -1 : 1))) {
      if (opts.from && r.work_date < opts.from) continue;
      const c = all.get(r.work_date);
      s.days_list.push({ row: r, c });
      if (!c.tin && !c.complete) continue;
      s.days++;
      if (c.late) { s.late++; s.lateMins += c.late; }
      if (c.complete) {
        s.complete++; s.worked += c.worked; s.ot += c.ot; s.otUsed += c.otUsed; s.short += c.short;
        s.regular += Math.min(c.worked, c.std);
      } else if (r.work_date !== today) s.missingOut++;
    }
    s.bank = s.ot - s.otUsed;   // OT earned but not used (it expires after the next work day)
    if (all.carry) { s.carryBank = all.bank; s.overCap = all.bank > (settings.ot_bank_cap_mins ?? 480); }   // carry-over bank now
    s.after = s.days_list.reduce((a, x) => a + (x.c.complete ? x.c.after : 0), 0);   // after-hours OT clocked in the period
    s.billable = s.regular + s.ot;
    return s;
  }

  function whatsappText(row, staff, settings, sessions = []) {
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
    for (const o of sessions) lines.push(`${row.day_kind === "rest" ? "Rest-day" : row.time_in && d(o.started_at) >= d(row.time_in) ? "Post-shift" : "Pre-shift"} OT: ${clockIn(d(o.started_at), tz)} – ${o.ended_at ? clockIn(d(o.ended_at), tz) + " " + label : "ongoing"} (${o.note})`);
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
    fmtMins, hoursDec, prettyDate, standardMins, plannedLunch, calcDay, calcDays, otToday, summarise, whatsappText, esc, toast, copyText, lsGet, lsSet };
})();
