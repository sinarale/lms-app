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

import { readSheet, writeCell } from "./sheet.js";

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

  // Chấp nhận {key, done, hash} hoặc {updates: {key: done, ...}}
  const updates =
    body && typeof body.updates === "object" && body.updates !== null
      ? body.updates
      : body && typeof body.key === "string"
      ? { [body.key]: body.done ? { hash: body.hash } : false }
      : null;
  if (!updates) return json({ error: "Thiếu 'key' hoặc 'updates'" }, 400);

  const items = await readAll(env);
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(updates)) {
    if (typeof k !== "string" || !KEY_RE.test(k)) continue;
    if (!v) {
      delete items[k];
      continue;
    }
    items[k] = { done: true, at: now };
    // Vân tay nội dung lúc đánh dấu. Nhờ nó, lần sau mở trang có thể phát hiện
    // bài đã bị sửa từ sau khi học — chỉ so id thì không bao giờ biết được.
    // Mục đánh dấu từ trước khi có tính năng này không có hash → coi như không
    // đổi, tránh báo động giả hàng loạt.
    const h = typeof v === "object" && v !== null ? v.hash : undefined;
    if (typeof h === "string" && /^[0-9a-f]{6,64}$/.test(h)) items[k].hash = h;
  }
  if (Object.keys(items).length > MAX_ITEMS) {
    return json({ error: "Vượt giới hạn số mục" }, 413);
  }

  await env.PROGRESS_KV.put(KEY, JSON.stringify(items));
  return json({ ok: true, count: Object.keys(items).length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/progress") {
      if (request.method === "GET") return handleGet(env);
      if (request.method === "POST") return handlePost(request, env);
      return json({ error: "Method không hỗ trợ" }, 405);
    }

    if (pathname === "/api/sheet") {
      if (request.method === "GET") {
        try {
          const d = await readSheet(env);
          return d.error ? json({ error: d.error }, d.status || 500) : json(d);
        } catch (e) {
          return json({ error: String(e.message || e) }, 502);
        }
      }
      if (request.method === "POST") {
        // Ghi vào sheet của lớp → chặn bằng cùng mã bí mật với tiến độ
        const secret = env.LMS_SECRET || "";
        if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
        if ((request.headers.get("x-progress-key") || "") !== secret) {
          return json({ error: "Mã bí mật không đúng" }, 401);
        }
        let body;
        try { body = await request.json(); } catch { return json({ error: "Body không hợp lệ" }, 400); }
        const row = Number(body?.row);
        if (!Number.isInteger(row) || row < 1 || row > 100000) {
          return json({ error: "Thiếu hoặc sai 'row'" }, 400);
        }
        try {
          const d = await writeCell(env, row, !!body.done);
          return d.error ? json({ error: d.error }, d.status || 500) : json(d);
        } catch (e) {
          return json({ error: String(e.message || e) }, 502);
        }
      }
      return json({ error: "Method không hỗ trợ" }, 405);
    }

    // Mọi đường dẫn khác: trả file tĩnh.
    //
    // wrangler.toml đặt html_handling = "none" để bỏ chuyển hướng 307 thừa từ
    // "/pl/x.html" sang "/pl/x". Nhưng tắt nó cũng tắt luôn hai tiện ích khác của
    // Cloudflare, phải tự làm lại ở đây, nếu không sẽ gãy:
    //   1. "/" không còn tự tìm index.html  → trang chủ 404
    //   2. "/pl/x" (không đuôi) không còn tìm ra x.html → hỏng link đã lưu của
    //      người dùng từ trước khi đổi
    const asset = (path) => env.ASSETS.fetch(new Request(new URL(path, url), request));

    if (pathname.endsWith("/")) return asset(pathname + "index.html");

    const res = await asset(pathname);
    // Chỉ thử thêm ".html" khi thật sự không thấy file, và chỉ với đường dẫn
    // không có đuôi — tránh đi tìm lần hai cho ảnh/PDF vốn đã 404 thật.
    if (res.status === 404 && !pathname.split("/").pop().includes(".")) {
      const alt = await asset(pathname + ".html");
      if (alt.status !== 404) return alt;
    }
    return res;
  },
};
