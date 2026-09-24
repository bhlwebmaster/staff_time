/* Data layer. Talks to Supabase using config.js. If that's missing, shows a
   clear "not set up" message instead. There is no demo data. */
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

  // ---------------- not connected ----------------
  // Production only: no demo data. If the app can't reach the database, say so plainly.
  function showSetupProblem(title, detail) {
    const run = () => {
      document.querySelectorAll("main, dialog, nav.tabs").forEach((el) => { el.hidden = true; });
      const box = document.createElement("div");
      box.className = "wrap"; box.setAttribute("role", "alert");
      box.innerHTML = `<div class="card pad stack" style="max-width:520px;margin:40px auto">
        <h1 style="font-size:24px">${title}</h1><p style="margin:0" class="muted">${detail}</p>
        <div class="row"><button class="btn primary" type="button" onclick="location.reload()">Try again</button>
        <a class="btn" href="help/">Open help</a></div></div>`;
      document.body.appendChild(box);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
  }
  const cfgMissing = !configured;
  const libMissing = configured && !sb;
  if (cfgMissing) showSetupProblem("This app isn't set up yet", "The connection settings in <code>config.js</code> are missing. Ask the webmaster (biohack.webmaster@gmail.com) to add the Supabase URL and key.");
  else if (libMissing) showSetupProblem("Can't connect right now", "Part of the app couldn't load. Check your internet connection and try again.");
  const broken = new Proxy({}, { get: () => async () => { throw new Error("The app isn't connected. Try again in a moment."); } });
  window.BHL.api = cfgMissing || libMissing ? Object.assign(Object.create(null), { ready: false, admin: broken, roster: broken.x, punch: broken.x, setPin: broken.x, setProfile: broken.x }) : Object.assign(live, { ready: true });
})();
