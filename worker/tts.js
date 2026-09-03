/**
 * Đọc to bằng Google Cloud Text-to-Speech, sinh LÚC BẤM, cache ở edge.
 *
 * Trình duyệt không được cầm khoá Google nên Worker làm proxy. Mỗi câu chỉ tốn
 * Google đúng một lần: kết quả vào Cache API của Cloudflare (miễn phí, không
 * tính vào 1.000 lượt ghi KV/ngày), khoá theo sha1(text). Hạn mức Google free:
 * 1 triệu ký tự/tháng giọng Neural2; cả cuốn sách chưa tới 40.000.
 *
 * Endpoint công khai nên phải chặn lạm dụng: chỉ đọc chuỗi CÓ TRONG HỌC LIỆU
 * (đối chiếu với study/{course}.json qua ASSETS — chính file trang đang tải),
 * và tối đa 200 ký tự. Ai đó muốn đốt hạn mức thì chỉ đốt được đúng ~100 câu
 * mà cache đã giữ sẵn.
 *
 * Secret: GOOGLE_TTS_API_KEY (API key chỉ bật Cloud Text-to-Speech):
 *     npx wrangler secret put GOOGLE_TTS_API_KEY
 */

const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const VOICE = { languageCode: "en-US", name: "en-US-Neural2-F" };
const AUDIO = { audioEncoding: "MP3", speakingRate: 0.92 };
const MAX_LEN = 200;

async function sha1(s) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Chuỗi được phép đọc của một môn: thuật ngữ, mặt trước thẻ, đề bài. KHÔNG đáp án. */
async function allowed(env, request, user, course) {
  const url = new URL(`/${user}/study/${course}.json`, request.url);
  const r = await env.ASSETS.fetch(new Request(url, request));
  if (!r.ok) return null;
  const d = await r.json();
  const set = new Set();
  for (const s of d.summary || []) for (const g of s.glossary || []) if (g.term) set.add(g.term.trim());
  for (const c of d.flashcards || []) if (c.front_en) set.add(c.front_en.trim());
  for (const q of d.quiz || []) if (q.stem_en) set.add(q.stem_en.trim());
  return set;
}

export async function handleTts(request, env, url) {
  if (request.method !== "GET") return new Response("Method không hỗ trợ", { status: 405 });
  const key = env.GOOGLE_TTS_API_KEY || "";
  if (!key) return new Response("Chưa cấu hình GOOGLE_TTS_API_KEY", { status: 503 });

  const user = url.searchParams.get("user") || "";
  const course = url.searchParams.get("course") || "";
  const text = (url.searchParams.get("text") || "").trim();
  if (!/^[\w-]{1,32}$/.test(user) || !/^[\w-]{1,64}$/.test(course)) return new Response("Sai user/course", { status: 400 });
  if (!text || text.length > MAX_LEN) return new Response("Thiếu hoặc quá dài", { status: 400 });

  // Cache TRƯỚC khi đối chiếu học liệu: câu đã có thì không parse JSON, không gọi Google.
  const cache = caches.default;
  const ckey = new Request(new URL(`/__tts/${await sha1(user + "|" + course + "|" + text)}`, url).toString());
  const hit = await cache.match(ckey);
  if (hit) return hit;

  const ok = await allowed(env, request, user, course);
  if (!ok) return new Response("Không có học liệu", { status: 404 });
  if (!ok.has(text)) return new Response("Chuỗi không thuộc học liệu", { status: 403 });

  const g = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { text }, voice: VOICE, audioConfig: AUDIO }),
  });
  if (!g.ok) return new Response("Google TTS lỗi " + g.status, { status: 502 });
  const { audioContent } = await g.json();
  const bytes = Uint8Array.from(atob(audioContent), (c) => c.charCodeAt(0));
  const res = new Response(bytes, {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000, immutable" },
  });
  await cache.put(ckey, res.clone());
  return res;
}
