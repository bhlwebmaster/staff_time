/* Weekly schedule: effective day plans, week table and hour-by-hour timeline. Shared by staff and admin pages. */
(function () {
  const B = window.BHL;
  const KINDS = {
    shift:    { label: "Shift" },
    rest:     { label: "Rest Day", cls: "k-rest" },
    vacation: { label: "Vacation Leave", cls: "k-vac", paid: true },
    sick:     { label: "Sick Leave", cls: "k-sick", paid: true },
    holiday:  { label: "Holiday", cls: "k-hol", paid: true },
    unpaid:   { label: "Unpaid Leave", cls: "k-unpaid" },
  };
  // One distinct colour per person (same colour every day), in name order.
  const LANE_COLORS = ["#0d7656", "#1f6fb2", "#d9622b", "#6d4bc4", "#c2416b", "#a8740a", "#0e8a8a", "#56606b", "#8a5a2b", "#3f7d1f", "#b3386e", "#2f4fa8"];
  const DAY = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dow = (ds) => new Date(ds + "T12:00:00Z").getUTCDay();
  /** Sunday of the week containing ds (weeks run Sunday → Saturday, like the WhatsApp schedule). */
  const weekStart = (ds) => addDays(ds, -dow(ds));
  const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
  const mins = (t) => { const [h, m] = hhmm(t).split(":").map(Number); return h * 60 + m; };
  /** Short time for narrow bars: 5a, 2:30p */
  const shortT = (t) => { let [h, m] = hhmm(t).split(":").map(Number); const ap = h >= 12 ? "p" : "a"; h = h % 12 || 12; return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`; };
  const ampm = (t) => { let [h, m] = hhmm(t).split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")}${ap}`; };

  /** The usual shift for a weekday from the person's pattern (or Mon–Fri default). */
  function patternDay(p, d) {
    if (p.week_pattern) { const x = p.week_pattern[String(d)]; return x ? { kind: "shift", start: x.s, end: x.e } : { kind: "rest" }; }
    return d === 0 || d === 6 ? { kind: "rest" } : { kind: "shift", start: hhmm(p.sched_start), end: hhmm(p.sched_end) };
  }
  /** What a person is planned to do on a date: a changed day wins over their usual week. */
  function effective(p, ds, overrides) {
    const o = overrides && overrides[p.id + "|" + ds];
    if (o) return { kind: o.kind, start: hhmm(o.start_time) || patternDay(p, dow(ds)).start || hhmm(p.sched_start), end: hhmm(o.end_time) || patternDay(p, dow(ds)).end || hhmm(p.sched_end), note: o.note, changed: true };
    return { ...patternDay(p, dow(ds)), changed: false };
  }
  const indexDays = (list) => { const m = {}; for (const d of list || []) m[d.staff_id + "|" + d.work_date] = d; return m; };

  function cellText(e) { return e.kind === "shift" ? `${ampm(e.start)}-${ampm(e.end)}` : KINDS[e.kind]?.label || e.kind; }

  /** Bottom table in the WhatsApp sheet: one row per person, one column per day. */
  // opts.n = number of days to show (7 = week, 1 = one day); opts.colorFrom = week start used for stable colours
  function tableHtml(from, people, overrides, today, opts = {}) {
    const n = opts.n || 7, days = Array.from({ length: n }, (_, i) => addDays(from, i));
    const colors = laneColors(opts.colorFrom || from, people, overrides);
    return `<table class="wk-table ${n === 1 ? "one" : ""}"><thead><tr><th>UK time</th>${days.map((d) => `<th class="${d === today ? "is-today" : ""}">${DAY[dow(d)]}<span>${+d.slice(8)}</span></th>`).join("")}</tr></thead>
      <tbody>${people.map((p) => `<tr><th style="--pc:${colors[p.id] || "#9aa6a0"}"><span class="dot"></span>${B.esc(p.display_name)}</th>${days.map((d) => {
        const e = effective(p, d, overrides);
        return `<td class="${KINDS[e.kind]?.cls || ""} ${d === today ? "is-today" : ""}" title="${B.esc(e.note || "")}">${cellText(e)}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`;
  }


  const HOUR_WEEK = 28, HOUR_DAY = 44; // px per hour

  function laneColors(from, people, overrides) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i)), c = {};
    people.filter((p) => days.some((d) => effective(p, d, overrides).kind === "shift")).forEach((p, i) => { c[p.id] = LANE_COLORS[i % LANE_COLORS.length]; });
    return c;
  }
  /** Calendar-style week: one coloured bar per person per shift, each person in their own lane. */
  function timelineHtml(from, people, overrides, today, opts = {}) {
    const nd = opts.n || 7, days = Array.from({ length: nd }, (_, i) => addDays(from, i));
    // lanes: only people with at least one shift in view, in a stable order
    const lanes = people.filter((p) => days.some((d) => effective(p, d, overrides).kind === "shift"));
    const color = laneColors(opts.colorFrom || from, people, overrides);
    const n = Math.max(1, lanes.length);
    // One day: zoom in on the hours people actually work (1 hour either side)
    let h0 = 0, h1 = 24, HOUR = HOUR_WEEK;
    if (nd === 1) {
      HOUR = HOUR_DAY;
      const sh = lanes.map((p) => effective(p, days[0], overrides)).filter((e) => e.kind === "shift" && e.start && e.end);
      if (sh.length) {
        h0 = Math.max(0, Math.floor(Math.min(...sh.map((e) => mins(e.start))) / 60) - 1);
        h1 = Math.min(24, Math.ceil(Math.max(...sh.map((e) => { const st = mins(e.start), en = mins(e.end); return en <= st ? 1440 : en; })) / 60) + 1);
      } else { h0 = 6; h1 = 18; }
    }
    const hours = Array.from({ length: h1 - h0 }, (_, i) => new Date(Date.UTC(2000, 0, 1, h0 + i)).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" }));
    const col = (d) => {
      const items = [], off = [];
      for (const p of lanes) {
        const e = effective(p, d, overrides);
        if (e.kind !== "shift") { if (e.kind !== "rest") off.push(`${B.esc(p.display_name)}: ${KINDS[e.kind].label}`); continue; }
        if (!e.start || !e.end) continue;
        const st = mins(e.start); let en = mins(e.end); if (en <= st) en = 24 * 60; // overnight shows to midnight
        items.push({ p, e, st, en });
      }
      // Pack shifts into as few side-by-side columns as needed (overlapping shifts sit next to each other)
      items.sort((x, y) => x.st - y.st || y.en - x.en);
      const colEnd = [];
      for (const it of items) { let c = colEnd.findIndex((end) => end <= it.st); if (c < 0) { c = colEnd.length; colEnd.push(0); } colEnd[c] = it.en; it.col = c; }
      const cols = Math.max(1, colEnd.length);
      const bars = items.map(({ p, e, st, en, col }) => {
        const top = (st / 60 - h0) * HOUR, h = Math.max(HOUR * 0.75, ((en - st) / 60) * HOUR);
        const nar = cols > 2 && nd > 1;
        return `<div class="bar ${nar ? "narrow" : ""}" style="top:${top}px;height:${h}px;left:calc(${(col / cols) * 100}% + 2px);width:calc(${100 / cols}% - 4px);--c:${color[p.id]}"
          title="${B.esc(p.display_name)} · ${ampm(e.start)}–${ampm(e.end)}"><b>${B.esc(p.display_name)}</b><span>${nar ? `${shortT(e.start)}–${shortT(e.end)}` : `${ampm(e.start)}–${ampm(e.end)}`}</span></div>`;
      });
      return `<div class="tl-day ${d === today ? "is-today" : ""}">${bars.join("")}${off.length ? `<div class="tl-off">${off.join("<br>")}</div>` : ""}</div>`;
    };
    const head = nd === 1 ? `${DAY[dow(days[0])]}<span>${+days[0].slice(8)}</span>` : "";
    return `<div class="tl ${nd === 1 ? "one" : ""}" style="--h:${HOUR}px;--n:${n};--days:${nd};--rows:${h1 - h0}">
      <div class="tl-head"><div class="tl-corner">UK time</div>${nd === 1 ? `<div class="tl-dh ${days[0] === today ? "is-today" : ""}">${head}</div>` : days.map((d) => `<div class="tl-dh ${d === today ? "is-today" : ""}">${DAY[dow(d)].slice(0, 3)}<span>${+d.slice(8)}</span></div>`).join("")}</div>
      <div class="tl-body"><div class="tl-hours">${hours.map((h) => `<div>${h}</div>`).join("")}</div>${days.map(col).join("")}</div>
    </div>
    <div class="tl-legend">${lanes.map((p) => `<span><i style="background:${color[p.id]}"></i>${B.esc(p.display_name)}</span>`).join("")}</div>`;
  }

  const CSS = `
  .wk-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
  .wk-table, .wk-time { border-collapse: collapse; width: 100%; font-size: 12.5px; min-width: 640px; }
  .wk-table th, .wk-table td, .wk-time th, .wk-time td { border: 1px solid #d5dedb; padding: 6px 6px; text-align: center; }
  .wk-table thead th, .wk-time thead th { background: #0f5c56; color: #fff; font-size: 11px; letter-spacing: .04em; }
  .wk-table thead th span, .wk-time thead th span { display: block; font-size: 13px; }
  .wk-table thead th.is-today, .wk-time thead th.is-today { background: #0a3f3b; box-shadow: inset 0 -3px #ffe45c; }
  .wk-table tbody th { text-align: left; white-space: nowrap; font-weight: 700; color: var(--ink); background: var(--surface); }
  .wk-table tbody th .dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; background: var(--pc); margin-right: 6px; }
  .wk-table td { white-space: nowrap; font-family: var(--mono); font-size: 11.5px; color: var(--ink); }
  .wk-table td.is-today { box-shadow: inset 0 0 0 2px #ffe45c; }
  .wk-table td.k-rest, .wk-time td.k-rest { background: #fff59a; color: #3b3500; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-vac { background: #37d34a; color: #06300c; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-sick { background: #ffc9b8; color: #4a1606; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-hol { background: #b9d8ff; color: #0b2a52; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-unpaid { background: #e4e4e4; color: #333; font-family: var(--body); font-weight: 700; }
  .wk-time { table-layout: fixed; } .wk-time thead th:first-child { width: 78px; }
  .tl { min-width: 760px; font-size: 12px; }
  .tl-head, .tl-body { display: grid; grid-template-columns: 56px repeat(var(--days, 7), 1fr); }
  .tl.one { min-width: 0; font-size: 13px; }
  .tl.one .tl-day .bar { padding: 6px 8px; } .tl.one .tl-day .bar b { font-size: 13.5px; } .tl.one .tl-day .bar span { font-size: 11.5px; white-space: normal; }
  .wk-table.one thead th:first-child, .wk-table.one tbody th { width: 38%; }
  .wk-table.one { min-width: 0; } .wk-table.one td { font-size: 13px; padding: 9px 10px; } .wk-table.one tbody th { padding: 9px 12px; }
  .tl-head > div { background: #0f5c56; color: #fff; text-align: center; font-weight: 700; font-size: 11px; letter-spacing: .05em; padding: 7px 2px; border-left: 1px solid #2c7a73; }
  .tl-head > div span { display: block; font-size: 14px; }
  .tl-head .tl-corner { border-left: 0; display: grid; place-items: center; font-size: 10.5px; }
  .tl-head .is-today { background: #0a3f3b; box-shadow: inset 0 -3px #ffe45c; }
  .tl-hours > div { height: var(--h); font-size: 10.5px; color: var(--muted); text-align: right; padding: 0 8px; transform: translateY(-7px); font-variant-numeric: tabular-nums; }
  .tl-hours > div:first-child { transform: none; }
  .tl-day { position: relative; height: calc(var(--h) * var(--rows, 24)); border-left: 1px solid #d5dedb;
    background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--h) - 1px), #e4ebe8 calc(var(--h) - 1px), #e4ebe8 var(--h)); }
  .tl-day.is-today { background-color: #fffbe0; }
  .tl-day .bar { position: absolute; border-radius: 7px; background: var(--c); color: #fff; padding: 4px 4px; overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,.18); display: flex; flex-direction: column; gap: 1px; line-height: 1.15; }
  .tl-day .bar b { font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: clip; line-height: 1.15; }
  .tl-day .bar.narrow { padding: 4px 3px; } .tl-day .bar.narrow b { font-size: 11px; letter-spacing: -.01em; }
  .tl-day .bar span { font-size: 10px; opacity: .92; white-space: nowrap; overflow: hidden; text-overflow: clip; }
  .tl-day .bar.narrow span { font-size: 9.5px; }
  .tl-day .tl-off { position: absolute; left: 3px; right: 3px; bottom: 3px; font-size: 10px; color: #1c5a26; background: #d7f5dc; border-radius: 6px; padding: 3px 5px; line-height: 1.25; }
  .tl-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12.5px; font-weight: 600; padding: 10px 12px; border-top: 1px solid var(--line); background: var(--surface); }
  .tl-legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -2px; margin-right: 5px; }
  .wk-legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 8px; }
  .wk-legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -2px; margin-right: 4px; }`;

  Object.assign(B, { sched: { KINDS, DAY, addDays, dow, weekStart, effective, patternDay, indexDays, tableHtml, timelineHtml, cellText, hhmm, ampm, CSS } });
})();
