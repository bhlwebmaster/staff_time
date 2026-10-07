// Supabase Edge Function "send-reminders": sends the shift reminders as push notifications.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it  send-reminders
//         → paste this file → Deploy. Then in the function's settings turn OFF "Verify JWT" (it checks callers itself).
// Secrets (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…), CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically; the service key never leaves Supabase.
//
// Two ways in:
//   1. The 5-minute schedule (pg_cron) with header  x-cron-secret: <CRON_SECRET>  → sends the reminders due now.
//   2. An admin signed in to the admin page, body {"test": true}  → sends a test to every phone with reminders on.
import webpush from "npm:web-push@3.6.7";

const URL_ = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const send = (code: number, data: unknown) =>
  new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function sb(path: string, opts: any = {}) {
  const r = await fetch(URL_ + path, { ...opts, headers: { ...svc, ...(opts.headers || {}) } });
  const text = await r.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) { const e: any = new Error((body && (body.message || body.error)) || `Supabase error ${r.status}`); e.status = r.status; throw e; }
  return body;
}

type Sub = { staff_id: string; endpoint: string; p256dh: string; auth: string };
/** Send one notification; a phone that unsubscribed or reinstalled (404/410) is removed. */
async function push(s: Sub, payload: Record<string, unknown>) {
  try {
    await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 900, urgency: "high" });
    await sb(`/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "PATCH", body: JSON.stringify({ last_ok_at: new Date().toISOString() }) });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await sb(`/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" });
    console.log("push failed", e?.statusCode, e?.body || e?.message);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!URL_ || !KEY) return send(500, { error: "Function is missing its Supabase settings." });
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return send(500, { error: "Reminders aren't set up yet: add the VAPID keys under Edge Functions → Secrets." });
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:biohack.webmaster@gmail.com", pub, priv);
  let body: any = {}; try { body = await req.json(); } catch { body = {}; }

  try {
    // 1. The schedule: send what's due
    const secret = Deno.env.get("CRON_SECRET");
    if (secret && req.headers.get("x-cron-secret") === secret) {
      const due: (Sub & { kind: string; title: string; body: string })[] = await sb("/rest/v1/rpc/due_reminders", { method: "POST", body: JSON.stringify({ p_window_mins: 10 }) });
      let sent = 0;
      for (const d of due || []) if (await push(d, { title: d.title, body: d.body, kind: d.kind, url: "./" })) sent++;
      return send(200, { due: due?.length || 0, sent });
    }

    // 2. An admin's test from the admin page
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token || !body.test) return send(401, { error: "Not allowed." });
    const me = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!me.ok) return send(401, { error: "Your session has expired. Sign in again." });
    const caller = await me.json();
    const rows = await sb(`/rest/v1/admins?user_id=eq.${caller.id}&select=role`);
    if (!rows?.length || rows[0].role !== "admin") return send(403, { error: "Only admins can send a test." });
    const filter = body.staff_id ? `&staff_id=eq.${encodeURIComponent(body.staff_id)}` : "";
    const subs: Sub[] = await sb(`/rest/v1/push_subscriptions?select=staff_id,endpoint,p256dh,auth${filter}`);
    let sent = 0;
    for (const s of subs || []) if (await push(s, { title: "Test reminder", body: "Reminders are working on this phone.", kind: "test", url: "./" })) sent++;
    return send(200, { phones: subs?.length || 0, sent });
  } catch (e: any) {
    return send(e.status && e.status < 500 ? e.status : 500, { error: e.message || "Something went wrong." });
  }
});
