/**
 * Worker entry point cho site "Góc Học Tập".
 *
 * Định tuyến:
 *   /api/progress  → API tiến độ học tập (đọc/ghi Workers KV)
 *   còn lại        → trả file tĩnh từ binding ASSETS (thư mục dist/)
 *
 * API:
 *   GET  /api/progress          → toàn bộ tiến độ đã lưu (không cần xác thực)
 *   POST /api/progress          → cập nhật, cần header x-progress-key
 *   POST /api/progress?check=1  → chỉ kiểm tra mã bí mật
 *
 * Lưu trữ: một tài liệu JSON duy nhất trong KV, khoá "progress". Mỗi mục học
 * liệu định danh bằng "{user_id}/{course_id}/{item_id}" — đều là id gốc từ
 * Canvas nên ổn định qua các lần đồng bộ lại.
 *
 * Cấu hình trong wrangler.toml / dashboard:
 *   ASSETS          — binding tới thư mục tĩnh
 *   PROGRESS_KV     — KV namespace lưu tiến độ
 *   LMS_SECRET      — mã bí mật để được phép ghi (đặt trên dashboard)
 */

const KEY = "progress";
const MAX_ITEMS = 5000; // chặn ghi phình vô hạn
const KEY_RE = /^[\w-]+\/\d+\/[\w-]+$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

async function readAll(env) {
  return (await env.PROGRESS_KV.get(KEY, { type: "json" })) || {};
}

async function handleGet(env) {
  if (!env.PROGRESS_KV) return json({ error: "Chưa cấu hình PROGRESS_KV" }, 503);
  return json({ items: await readAll(env) });
}

async function handlePost(request, env) {
  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) {
    return json({ error: "Mã bí mật không đúng" }, 401);
  }
  // Chỉ kiểm tra mã, không ghi gì
  if (new URL(request.url).searchParams.get("check")) return json({ ok: true });

  if (!env.PROGRESS_KV) return json({ error: "Chưa cấu hình PROGRESS_KV" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body không phải JSON hợp lệ" }, 400);
  }

  // Chấp nhận {key, done} hoặc {updates: {key: done, ...}}
  const updates =
    body && typeof body.updates === "object" && body.updates !== null
      ? body.updates
      : body && typeof body.key === "string"
      ? { [body.key]: !!body.done }
      : null;
  if (!updates) return json({ error: "Thiếu 'key' hoặc 'updates'" }, 400);

  const items = await readAll(env);
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(updates)) {
    if (typeof k !== "string" || !KEY_RE.test(k)) continue;
    if (v) items[k] = { done: true, at: now };
    else delete items[k];
  }
  if (Object.keys(items).length > MAX_ITEMS) {
    return json({ error: "Vượt giới hạn số mục" }, 413);
  }

  await env.PROGRESS_KV.put(KEY, JSON.stringify(items));
  return json({ ok: true, count: Object.keys(items).length });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/progress") {
      if (request.method === "GET") return handleGet(env);
      if (request.method === "POST") return handlePost(request, env);
      return json({ error: "Method không hỗ trợ" }, 405);
    }

    // Mọi đường dẫn khác: trả file tĩnh
    return env.ASSETS.fetch(request);
  },
};
