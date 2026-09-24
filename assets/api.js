/* Data layer. Talks to Supabase when config.js is filled in; otherwise runs a
   self-contained demo (in memory, resets on reload) so you can try the app first. */
(function () {
  const { sb, configured } = window.BHL;

  // ---------------- live (Supabase) ----------------
  const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  // User management runs in a Supabase Edge Function ("admin-users") because creating logins needs the secret service key.
  async function userApi(method, body) {
    const { data, error } = await sb.functions.invoke("admin-users", { method, body: method === "GET" ? undefined : body || {} });
    if (!error) return data;
    let msg = error.message, status = error.context?.status;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch {}
    if (status === 404 || /Failed to send|not found/i.test(msg)) msg = "User management isn't set up yet. Deploy the admin-users Edge Function in Supabase (see README).";
    throw new Error(msg);
  }
  const live = {
    demo: false,
    roster: async () => unwrap(await sb.rpc("roster")),
    setPin: async (staff, current, next) => unwrap(await sb.rpc("set_pin", { p_staff: staff, p_current: current, p_new: next })),
    setProfile: async (staff, pin, p) => unwrap(await sb.rpc("set_profile", { p_staff: staff, p_pin: pin,
      p_avatar: p.avatar || null, p_photo: p.photo || null, p_tagline: p.tagline || null, p_color: p.color || null })),
    punch: async (staff, pin, action, extra = {}) =>
      unwrap(await sb.rpc("punch", { p_staff: staff, p_pin: pin, p_action: action,
        p_sched_start: extra.sched_start || null, p_sched_end: extra.sched_end || null, p_note: extra.note ?? null })),
    admin: {
      session: async () => (await sb.auth.getSession()).data.session,
      signIn: async (email, password) => unwrap(await sb.auth.signInWithPassword({ email, password })),
      signOut: async () => sb.auth.signOut(),
      role: async () => unwrap(await sb.rpc("my_role")),
      me: async () => (await sb.auth.getUser()).data.user,
      changePassword: async (password) => unwrap(await sb.auth.updateUser({ password })),
      users: async () => userApi("GET"),
      createUser: async (u) => userApi("POST", u),
      updateUser: async (u) => userApi("PATCH", u),
      removeUser: async (user_id) => userApi("DELETE", { user_id }),
      settings: async () => unwrap(await sb.from("settings").select("*").eq("id", 1).single()),
      saveSettings: async (s) => unwrap(await sb.from("settings").update(s).eq("id", 1)),
      staff: async () => unwrap(await sb.rpc("admin_staff")),
      saveStaff: async (s) => s.id ? unwrap(await sb.from("staff").update(s).eq("id", s.id)) : unwrap(await sb.from("staff").insert(s)),
      resetPin: async (id) => unwrap(await sb.from("staff").update({ pin_hash: null, failed_attempts: 0, locked_until: null }).eq("id", id)),
      attendance: async (from, to) => unwrap(await sb.from("attendance").select("*").gte("work_date", from).lte("work_date", to).order("work_date")),
      saveAttendance: async (r) => r.id
        ? unwrap(await sb.from("attendance").update(r).eq("id", r.id))
        : unwrap(await sb.from("attendance").insert({ ...r, source: "admin" })),
      deleteAttendance: async (id) => unwrap(await sb.from("attendance").delete().eq("id", id)),
      audit: async (staffId, date) => unwrap(await sb.from("audit_log").select("at,actor,action").eq("staff_id", staffId).eq("work_date", date).order("at", { ascending: false }).limit(20)),
    },
  };

  // ---------------- demo (in memory) ----------------
  const D = (() => {
    const settings = { id: 1, timezone: "Europe/London", grace_mins: 5, ot_block_mins: 15, count_early: false, company_name: "BioHack London" };
    const staff = [
      { id: "rae", full_name: "BINGHOY, RAE", display_name: "Rae", sched_start: "05:00:00", sched_end: "14:00:00", lunch_mins: 60, active: true, pin: "1111", avatar: "sunrise", color: "sunset", tagline: "Early shift, early wins" },
      { id: "cess", full_name: "ALISEN, CESS", display_name: "Cess", sched_start: "06:00:00", sched_end: "15:00:00", lunch_mins: 60, active: true, pin: "2222", avatar: "coffee", color: "jade", tagline: "Coffee first, then conquer" },
      { id: "jaycel", full_name: "TE, JAYCEL", display_name: "Jaycel", sched_start: "06:00:00", sched_end: "15:00:00", lunch_mins: 60, active: true, pin: null },
      { id: "verge", full_name: "GAMOTAN, VERGE", display_name: "Verge", sched_start: "09:00:00", sched_end: "18:00:00", lunch_mins: 60, active: true, pin: "3333", avatar: "rocket", color: "grape", tagline: "Ship it" },
    ];
    const Z = (dt, t) => (t ? window.BHL.zonedToDate(dt, t, settings.timezone).toISOString() : null);
    const rows = [];
    let n = 0;
    const add = (sid, dt, ss, se, i, lo, li, o, note) => rows.push({ id: "r" + ++n, staff_id: sid, work_date: dt, sched_start: ss + ":00", sched_end: se + ":00",
      time_in: Z(dt, i), lunch_out: Z(dt, lo), lunch_in: Z(dt, li), time_out: Z(dt, o), note: note || null, source: "demo" });
    // a few weeks of plausible history (demo only)
    const today = window.BHL.dateIn(new Date(), settings.timezone);
    const start = new Date(today + "T12:00:00Z"); start.setUTCDate(start.getUTCDate() - 24);
    const jitter = (k, a) => ((k * 7919 + a * 104729) % 23) - 8;
    for (let k = 0; k < 24; k++) {
      const dt = new Date(start); dt.setUTCDate(start.getUTCDate() + k);
      if ([0, 6].includes(dt.getUTCDay())) continue;
      const ds = dt.toISOString().slice(0, 10);
      const mm = (base, j) => { const t = base + j; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(((t % 60) + 60) % 60).padStart(2, "0")}`; };
      add("rae", ds, "05:00", "14:00", mm(300, jitter(k, 1) - 4), mm(730, 0), mm(790, jitter(k, 2) % 4), mm(840, Math.abs(jitter(k, 3)) + 2));
      add("cess", ds, "06:00", "15:00", mm(360, jitter(k, 4) - 3), mm(750, 0), mm(810, 0), mm(900, Math.abs(jitter(k, 5)) * 2));
      if (k % 5 !== 2) add("jaycel", ds, "06:00", "15:00", mm(360, jitter(k, 6)), mm(720, 0), mm(780, 1), mm(900, jitter(k, 7)));
      add("verge", ds, "09:00", "18:00", mm(540, -Math.abs(jitter(k, 8)) % 9), mm(750, 0), mm(810, 0), mm(1080, Math.abs(jitter(k, 9))));
    }
    // today: Rae on lunch, Cess in
    add("rae", today, "05:00", "14:00", "04:52", "12:10", null, null);
    add("cess", today, "06:30", "15:00", "06:25", null, null, null, "Offset against 30-minute OT yesterday");
    const users = [
      { user_id: "u-me", email: "you@demo", role: "admin", created_at: "2026-09-01T09:00:00Z" },
      { user_id: "u-fin", email: "finance@demo", role: "finance", created_at: "2026-09-10T09:00:00Z" },
    ];
    return { settings, staff, rows, users, log: [] };
  })();
  const nowIso = () => new Date().toISOString();
  const todayStr = () => window.BHL.dateIn(new Date(), D.settings.timezone);
  const pub = (s) => { const { pin, ...rest } = s; return { ...rest, has_pin: !!pin }; };
  const logIt = (actor, action, r) => D.log.push({ at: nowIso(), actor, action, staff_id: r.staff_id, work_date: r.work_date });
  const demo = {
    demo: true,
    roster: async () => ({ now: nowIso(), today: todayStr(), settings: D.settings,
      staff: D.staff.filter((s) => s.active).map((s) => {
        const a = D.rows.find((r) => r.staff_id === s.id && r.work_date === todayStr());
        const f = new Date(todayStr() + "T12:00:00Z"); f.setUTCDate(f.getUTCDate() - 45); const from = f.toISOString().slice(0, 10);
        return { ...pub(s), today: a || null, recent: D.rows.filter((r) => r.staff_id === s.id && r.work_date >= from).sort((x, y) => x.work_date.localeCompare(y.work_date)) };
      }).sort((a, b) => a.display_name.localeCompare(b.display_name)) }),
    setProfile: async (id, pin, p) => {
      const s = D.staff.find((x) => x.id === id);
      if (s.pin !== pin) return { ok: false, error: "Wrong PIN." };
      if ((p.tagline || "").length > 40) return { ok: false, error: "Keep your tagline to 40 characters." };
      Object.assign(s, { avatar: p.avatar || null, photo: p.photo || null, tagline: p.tagline?.trim() || null, color: p.color || null });
      return { ok: true };
    },
    setPin: async (id, cur, next) => {
      const s = D.staff.find((x) => x.id === id);
      if (!/^\d{4}$/.test(next)) return { ok: false, error: "PIN must be 4 digits." };
      if (s.pin && s.pin !== cur) return { ok: false, error: "Wrong PIN." };
      s.pin = next; return { ok: true };
    },
    punch: async (id, pin, action, extra = {}) => {
      const s = D.staff.find((x) => x.id === id);
      if (!s.pin) return { ok: false, error: "No PIN set yet." };
      if (s.pin !== pin) return { ok: false, error: "Wrong PIN." };
      const t = todayStr();
      let a = D.rows.find((r) => r.staff_id === id && r.work_date === t);
      const note = extra.note?.trim() || null;
      const E = (m) => ({ ok: false, error: m });
      if (action === "in") {
        if (a?.time_in) return E("You already clocked in today.");
        a = { id: "r" + Math.random(), staff_id: id, work_date: t, sched_start: (extra.sched_start || s.sched_start.slice(0, 5)) + (extra.sched_start ? ":00" : s.sched_start.slice(5)),
          sched_end: (extra.sched_end || s.sched_end.slice(0, 5)) + (extra.sched_end ? ":00" : s.sched_end.slice(5)), time_in: nowIso(), note, source: "app" };
        D.rows.push(a); logIt("staff: " + s.display_name, "create", a);
      } else if (action === "lunch_start") {
        if (!a?.time_in) return E("Clock in first."); if (a.time_out) return E("You already clocked out."); if (a.lunch_out) return E("Lunch already started.");
        a.lunch_out = nowIso(); logIt("staff: " + s.display_name, "edit", a);
      } else if (action === "lunch_end") {
        if (!a?.lunch_out) return E("Start lunch first."); if (a.lunch_in) return E("Lunch already ended.");
        a.lunch_in = nowIso(); logIt("staff: " + s.display_name, "edit", a);
      } else if (action === "out") {
        if (!a?.time_in) return E("Clock in first."); if (a.time_out) return E("You already clocked out.");
        if (a.lunch_out && !a.lunch_in) return E("End your lunch before clocking out.");
        a.time_out = nowIso(); if (note) a.note = note; logIt("staff: " + s.display_name, "edit", a);
      } else if (action === "note") {
        if (!a) return E("Clock in first."); a.note = note; logIt("staff: " + s.display_name, "edit", a);
      }
      const from = new Date(t + "T12:00:00Z"); from.setUTCMonth(from.getUTCMonth() - 1); from.setUTCDate(1);
      const f = from.toISOString().slice(0, 10);
      return { ok: true, now: nowIso(), staff: pub(s), settings: D.settings,
        rows: D.rows.filter((r) => r.staff_id === id && r.work_date >= f).sort((x, y) => x.work_date.localeCompare(y.work_date)) };
    },
    admin: {
      session: async () => demo._signed ? { user: { email: "demo@admin" } } : null,
      signIn: async (email) => { demo._signed = true; demo._role = /finance/i.test(email) ? "finance" : "admin"; },
      signOut: async () => { demo._signed = false; },
      role: async () => demo._role || "admin",
      me: async () => ({ id: "u-me", email: "you@demo" }),
      changePassword: async (p) => { if (p.length < 8) throw new Error("Password must be at least 8 characters."); },
      users: async () => ({ me: "u-me", users: D.users.map((u) => ({ ...u })) }),
      createUser: async ({ email, password, role }) => {
        email = String(email || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
        if (String(password || "").length < 8) throw new Error("Temporary password must be at least 8 characters.");
        const ex = D.users.find((u) => u.email === email);
        if (ex) ex.role = role; else D.users.push({ user_id: "u" + Math.random(), email, role, created_at: new Date().toISOString() });
        return { ok: true };
      },
      updateUser: async ({ user_id, role }) => {
        if (user_id === "u-me" && role && role !== "admin") throw new Error("You can't remove your own admin role.");
        if (role) D.users.find((u) => u.user_id === user_id).role = role; return { ok: true };
      },
      removeUser: async (id) => { if (id === "u-me") throw new Error("You can't remove yourself."); D.users = D.users.filter((u) => u.user_id !== id); return { ok: true }; },
      settings: async () => ({ ...D.settings }),
      saveSettings: async (s) => Object.assign(D.settings, s),
      staff: async () => D.staff.map(pub).sort((a, b) => a.display_name.localeCompare(b.display_name)),
      saveStaff: async (s) => { if (s.id) Object.assign(D.staff.find((x) => x.id === s.id), s); else D.staff.push({ ...s, id: "s" + Math.random(), pin: null }); },
      resetPin: async (id) => { D.staff.find((x) => x.id === id).pin = null; },
      attendance: async (from, to) => D.rows.filter((r) => r.work_date >= from && r.work_date <= to).map((r) => ({ ...r })).sort((a, b) => a.work_date.localeCompare(b.work_date)),
      saveAttendance: async (r) => {
        if (r.id) { Object.assign(D.rows.find((x) => x.id === r.id), r); logIt("demo@admin", "edit", r); }
        else {
          if (D.rows.some((x) => x.staff_id === r.staff_id && x.work_date === r.work_date)) throw new Error("There is already an entry for that person on that date.");
          const x = { ...r, id: "r" + Math.random(), source: "admin" }; D.rows.push(x); logIt("demo@admin", "create", x);
        }
      },
      deleteAttendance: async (id) => { const i = D.rows.findIndex((x) => x.id === id); logIt("demo@admin", "delete", D.rows[i]); D.rows.splice(i, 1); },
      audit: async (sid, dt) => D.log.filter((l) => l.staff_id === sid && l.work_date === dt).reverse(),
    },
  };

  window.BHL.api = configured ? live : demo;
})();
