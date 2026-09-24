/* Profiles (preset avatars, photos, colours) and the game layer (XP, levels, streaks, badges). */
(function () {
  const B = window.BHL;

  // ---------- preset avatars: original simple illustrations, 48×48 ----------
  const AV = {
    sunrise:  ["#f6b44b", `<circle cx="24" cy="30" r="10" fill="#fff4d6"/><path d="M6 34h36" stroke="#fff4d6" stroke-width="3" stroke-linecap="round"/><path d="M24 12v5M12 18l3 3M36 18l-3 3" stroke="#fff4d6" stroke-width="3" stroke-linecap="round"/>`],
    mango:    ["#2f9e6b", `<ellipse cx="25" cy="27" rx="11" ry="13" fill="#ffc53d" transform="rotate(-20 25 27)"/><path d="M26 14c3-5 9-6 12-4-3 4-8 5-12 4z" fill="#b6f0c9"/>`],
    wave:     ["#1f6fb2", `<path d="M6 30c5-8 11-8 16 0s11 8 16 0" stroke="#d6ecff" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M6 38c5-6 11-6 16 0s11 6 16 0" stroke="#8cc4f2" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="34" cy="14" r="4" fill="#fff4d6"/>`],
    coffee:   ["#7b4a2e", `<rect x="12" y="20" width="18" height="16" rx="4" fill="#f3e3d3"/><path d="M30 24h3a4 4 0 0 1 0 8h-3" stroke="#f3e3d3" stroke-width="3" fill="none"/><path d="M17 11c-2 3 2 4 0 7M23 11c-2 3 2 4 0 7" stroke="#f3e3d3" stroke-width="2" fill="none" stroke-linecap="round"/>`],
    leaf:     ["#3d8b3d", `<path d="M12 36C12 20 22 12 38 12c0 16-8 26-24 24z" fill="#c9f2b5"/><path d="M14 34L32 18" stroke="#3d8b3d" stroke-width="2.5" stroke-linecap="round"/>`],
    star:     ["#5b4bc4", `<path d="M24 10l4.2 9 9.8 1.2-7.2 6.7 1.9 9.7L24 31.8l-8.7 4.8 1.9-9.7-7.2-6.7 9.8-1.2z" fill="#ffe27a"/>`],
    bolt:     ["#222c3a", `<path d="M27 8L14 27h9l-3 13 14-20h-9z" fill="#ffd23f"/>`],
    mountain: ["#4a6fa5", `<path d="M6 38l12-18 7 10 5-6 12 14z" fill="#e3ecf7"/><path d="M18 20l4 6h-8z" fill="#fff"/><circle cx="35" cy="13" r="4" fill="#ffe27a"/>`],
    moon:     ["#1d2b53", `<path d="M30 10a14 14 0 1 0 8 24A12 12 0 0 1 30 10z" fill="#f4f1c9"/><circle cx="14" cy="14" r="1.5" fill="#fff"/><circle cx="38" cy="18" r="1.2" fill="#fff"/>`],
    rocket:   ["#c2416b", `<path d="M24 8c6 5 8 12 6 20h-12c-2-8 0-15 6-20z" fill="#fde8ef"/><circle cx="24" cy="18" r="3" fill="#c2416b"/><path d="M18 28l-5 6h6zM30 28l5 6h-6z" fill="#fde8ef"/><path d="M21 30l3 9 3-9z" fill="#ffc53d"/>`],
    flower:   ["#d9622b", `<g fill="#ffe2d1"><circle cx="24" cy="15" r="6"/><circle cx="33" cy="24" r="6"/><circle cx="24" cy="33" r="6"/><circle cx="15" cy="24" r="6"/></g><circle cx="24" cy="24" r="5" fill="#ffc53d"/>`],
    cat:      ["#8a6d5a", `<path d="M13 16l4 8M35 16l-4 8" stroke="#f6ece4" stroke-width="5" stroke-linecap="round"/><circle cx="24" cy="28" r="12" fill="#f6ece4"/><circle cx="19.5" cy="27" r="1.8" fill="#3b2a20"/><circle cx="28.5" cy="27" r="1.8" fill="#3b2a20"/><path d="M22 32q2 2 4 0" stroke="#3b2a20" stroke-width="1.5" fill="none"/>`],
  };
  const AVATARS = Object.keys(AV);
  const COLORS = { jade: "#0d7656", ocean: "#1f6fb2", sunset: "#d9622b", grape: "#6d4bc4", rose: "#c2416b", gold: "#b07d0c", slate: "#56606b" };
  const colorOf = (s) => COLORS[s?.color] || COLORS.jade;

  function avatarSvg(key, size) {
    const [bg, art] = AV[key] || AV.sunrise;
    return `<svg class="av-svg" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" fill="${bg}"/>${art}</svg>`;
  }
  function initials(name) { return (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase(); }
  /** Round avatar for a staff member: own photo → preset → initials. */
  function avatarHtml(s, size = 44) {
    const ring = colorOf(s);
    let inner;
    if (s?.photo) inner = `<img src="${B.esc(s.photo)}" alt="" width="${size}" height="${size}">`;
    else if (s?.avatar && AV[s.avatar]) inner = avatarSvg(s.avatar, size);
    else inner = `<span class="av-init" style="background:${ring}">${B.esc(initials(s?.display_name))}</span>`;
    return `<span class="av" style="--av:${size}px;--ring:${ring}">${inner}</span>`;
  }

  // ---------- game ----------
  const LEVELS = [[0, "Rookie"], [100, "Regular"], [250, "Reliable"], [450, "Pro"], [700, "Ace"], [1000, "Legend"]];
  const BADGES = [
    { key: "first",   name: "First Punch",  desc: "Clock in for the first time this month",  icon: "flag" },
    { key: "early",   name: "Early Bird",   desc: "Clock in 5+ minutes early, 5 times",      icon: "sun",    goal: 5 },
    { key: "fire",    name: "On Fire",      desc: "5 on-time days in a row",                 icon: "flame",  goal: 5 },
    { key: "iron",    name: "Iron Streak",  desc: "10 on-time days in a row",                icon: "shield", goal: 10 },
    { key: "week",    name: "Perfect Week", desc: "5 on-time, complete days in one week",    icon: "calendar", goal: 5 },
    { key: "lunch",   name: "Lunch Pro",    desc: "Log your lunch break on 10 days",         icon: "bowl",   goal: 10 },
    { key: "tidy",    name: "No Loose Ends", desc: "10+ days this month, no missed clock-outs", icon: "check", goal: 10 },
    { key: "ot",      name: "Extra Mile",   desc: "Earn 2 hours of OT this month",           icon: "bolt",   goal: 120 },
  ];
  const ICONS = {
    flag: `<path d="M7 21V4M7 4h10l-2 4 2 4H7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    sun: `<circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    flame: `<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-6 1-9z" fill="currentColor"/>`,
    shield: `<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z" fill="currentColor"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    calendar: `<rect x="3" y="5" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8.5 15l2.3 2.3 4.7-4.6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    bowl: `<path d="M3 11h18a9 9 0 0 1-18 0z" fill="currentColor"/><path d="M9 3c-1 2 1 3 0 5M14 3c-1 2 1 3 0 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    check: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
    bolt: `<path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/>`,
  };
  const icon = (k, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ""}</svg>`;

  function levelFor(xp) {
    let i = 0; while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++;
    const [base, title] = LEVELS[i], next = LEVELS[i + 1]?.[0] ?? null;
    return { n: i + 1, title, base, next, pct: next ? Math.round(((xp - base) / (next - base)) * 100) : 100 };
  }

  /**
   * XP this month: +10 on-time clock-in (+3 if late: you still showed up), +10 for a complete day,
   * +5 lunch logged, +5 early bird (5+ min before schedule). Streak = on-time days in a row (days off don't break it).
   */
  function stats(rows, staff, settings, today) {
    const month = today.slice(0, 7);
    const list = (rows || []).filter((r) => r.time_in).slice().sort((a, b) => a.work_date.localeCompare(b.work_date));
    let xp = 0, early = 0, lunch = 0, days = 0, missing = 0, ot = 0, run = 0, best = 0;
    const weeks = {};
    const all = B.calcDays(list, staff, settings);
    for (const r of list) {
      const c = all.get(r.work_date);
      const onTime = !c.late;
      run = onTime ? run + 1 : 0; best = Math.max(best, run);
      if (!r.work_date.startsWith(month)) continue;
      days++;
      xp += onTime ? 10 : 3;
      if (c.tout) xp += 10; else if (r.work_date !== today) missing++;
      if (c.lo && c.li) { xp += 5; lunch++; }
      if (c.tin && c.schedStart && c.schedStart - c.tin >= 5 * 60000) { xp += 5; early++; }
      if (c.complete) ot += c.ot;
      if (onTime && c.complete) {
        const d = new Date(r.work_date + "T12:00:00Z"), wk = new Date(d); wk.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        const k = wk.toISOString().slice(0, 10); weeks[k] = (weeks[k] || 0) + 1;
      }
    }
    const streak = run;
    const bestWeek = Math.max(0, ...Object.values(weeks));
    const prog = { first: days, early, fire: best, iron: best, week: bestWeek, lunch, tidy: missing ? 0 : days, ot };
    const badges = BADGES.map((b) => {
      const have = prog[b.key] || 0, goal = b.goal || 1;
      return { ...b, earned: have >= goal, have: Math.min(have, goal), goal };
    });
    return { xp, level: levelFor(xp), streak, best, days, badges, earnedCount: badges.filter((b) => b.earned).length };
  }

  // ---------- confetti (short, respects reduced motion) ----------
  function confetti(colors = ["#0d7656", "#ffc53d", "#1f6fb2", "#d9622b", "#c2416b"]) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cv = document.createElement("canvas"); cv.className = "confetti"; document.body.appendChild(cv);
    const ctx = cv.getContext("2d"), W = (cv.width = innerWidth), H = (cv.height = innerHeight);
    const ps = Array.from({ length: 90 }, () => ({ x: W / 2 + (Math.random() - 0.5) * 120, y: H * 0.45, vx: (Math.random() - 0.5) * 12,
      vy: -Math.random() * 13 - 4, r: Math.random() * 6 + 3, c: colors[(Math.random() * colors.length) | 0], a: Math.random() * 6 }));
    let t = 0;
    (function frame() {
      ctx.clearRect(0, 0, W, H);
      for (const p of ps) { p.vy += 0.38; p.x += p.vx; p.y += p.vy; p.a += 0.2;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore(); }
      if (++t < 110) requestAnimationFrame(frame); else cv.remove();
    })();
  }

  /** Resize an uploaded image to a 160×160 JPEG data URL (small enough to store). */
  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error("Choose a photo (JPG or PNG)."));
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const S = 160, cv = document.createElement("canvas"); cv.width = cv.height = S;
        const m = Math.min(img.width, img.height), ctx = cv.getContext("2d");
        ctx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
        URL.revokeObjectURL(url);
        let q = 0.85, out = cv.toDataURL("image/jpeg", q);
        while (out.length > 55000 && q > 0.4) { q -= 0.1; out = cv.toDataURL("image/jpeg", q); }
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file couldn't be read as an image.")); };
      img.src = url;
    });
  }

  Object.assign(B, { AVATARS, COLORS, avatarSvg, avatarHtml, colorOf, stats, levelFor, icon, confetti, resizePhoto, BADGES });
})();
