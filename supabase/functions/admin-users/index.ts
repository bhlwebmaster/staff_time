// Supabase Edge Function "admin-users": list / create / update / remove admin-page logins.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it  admin-users
//         → paste this file → Deploy.  Then in the function's settings turn OFF "Verify JWT"
//         (this function checks the caller's login itself, and it must answer the browser's CORS check).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to Edge Functions automatically.
// The service key never leaves Supabase. The caller must be signed in with role 'admin'.

const URL_ = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
const ROLES = ["admin", "finance"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function send(code: number, data: unknown) {
  return new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function sb(path: string, opts: any = {}) {
  const r = await fetch(URL_ + path, { ...opts, headers: { ...svc, ...(opts.headers || {}) } });
  const text = await r.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const msg = (body && (body.msg || body.message || body.error_description || body.error)) || `Supabase error ${r.status}`;
    const e: any = new Error(msg); e.status = r.status; throw e;
  }
  return body;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!URL_ || !KEY) return send(500, { error: "Function is missing its Supabase settings." });

  try {
    // 1. Who is calling? Verify their session token with Supabase Auth.
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return send(401, { error: "Sign in first." });
    const me = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!me.ok) return send(401, { error: "Your session has expired. Sign in again." });
    const caller = await me.json();

    // 2. Only full admins may manage users.
    const rows = await sb(`/rest/v1/admins?user_id=eq.${caller.id}&select=role`);
    if (!rows?.length || rows[0].role !== "admin") return send(403, { error: "Only admins can manage users." });

    let body: any = {};
    if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }

    if (req.method === "GET") {
      const list = await sb(`/rest/v1/admins?select=user_id,email,role,created_at&order=created_at.asc`);
      return send(200, { users: list, me: caller.id });
    }

    if (req.method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = ROLES.includes(body.role) ? body.role : "finance";
      if (!EMAIL.test(email)) return send(400, { error: "Enter a valid email address." });
      if (password.length < 8) return send(400, { error: "Temporary password must be at least 8 characters." });

      let user: any;
      try {
        user = await sb(`/auth/v1/admin/users`, { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
      } catch (e: any) {
        if (!/already|registered|exists/i.test(e.message)) throw e;
        // Existing login (e.g. removed earlier): find it and re-grant access with the new password.
        const found = await sb(`/auth/v1/admin/users?per_page=1000`);
        user = (found.users || []).find((u: any) => (u.email || "").toLowerCase() === email);
        if (!user) throw e;
        await sb(`/auth/v1/admin/users/${user.id}`, { method: "PUT", body: JSON.stringify({ password }) });
      }
      await sb(`/rest/v1/admins?on_conflict=user_id`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: user.id, email, role }),
      });
      return send(200, { ok: true, user_id: user.id });
    }

    if (req.method === "PATCH") {
      const { user_id, role, password } = body;
      if (!user_id) return send(400, { error: "Missing user." });
      if (role) {
        if (!ROLES.includes(role)) return send(400, { error: "Unknown role." });
        if (user_id === caller.id && role !== "admin") return send(400, { error: "You can't remove your own admin role." });
        await sb(`/rest/v1/admins?user_id=eq.${encodeURIComponent(user_id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ role }) });
      }
      if (password) {
        if (String(password).length < 8) return send(400, { error: "Password must be at least 8 characters." });
        await sb(`/auth/v1/admin/users/${encodeURIComponent(user_id)}`, { method: "PUT", body: JSON.stringify({ password }) });
      }
      return send(200, { ok: true });
    }

    if (req.method === "DELETE") {
      const user_id = body.user_id;
      if (!user_id) return send(400, { error: "Missing user." });
      if (user_id === caller.id) return send(400, { error: "You can't remove yourself." });
      await sb(`/rest/v1/admins?user_id=eq.${encodeURIComponent(user_id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      await sb(`/auth/v1/admin/users/${encodeURIComponent(user_id)}`, { method: "DELETE" }).catch(() => {});
      return send(200, { ok: true });
    }

    return send(405, { error: "Method not allowed." });
  } catch (e: any) {
    return send(e.status && e.status < 500 ? 400 : 500, { error: e.message || "Something went wrong." });
  }
});
