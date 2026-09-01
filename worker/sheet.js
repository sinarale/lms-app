/**
 * Theo dõi bảng học tập trên Google Sheet (lớp học thêm).
 *
 *   GET  /api/sheet        → danh sách đầu mục + trạng thái, gom theo buổi
 *   POST /api/sheet        → tick/bỏ tick một dòng (cần mã bí mật)
 *
 * Vì sao đọc qua Worker chứ không để trình duyệt gọi thẳng Google:
 *   1. Sheet chứa mật khẩu tài khoản IXL/Reading Eggs ở các cột phụ. Đọc qua
 *      Worker thì lọc bỏ được, trình duyệt không bao giờ nhận những cột đó.
 *   2. Sheet cho phép sửa ẩn danh — lộ id là ai cũng vào phá được. Để id trong
 *      secret nên trang web không hề biết địa chỉ sheet.
 *
 * Ghi cần OAuth (API từ chối ghi ẩn danh, kể cả khi sheet mở quyền cho mọi
 * người), nên dùng service account: ký JWT rồi đổi lấy access token.
 *
 * Cấu hình:
 *   SHEET_ID       secret — id spreadsheet
 *   SHEET_GID      secret — gid của tab cần đọc
 *   SHEET_COL      var    — chỉ số cột trạng thái, 0-based (E = 4)
 *   GOOGLE_SA_KEY  secret — nội dung file JSON của service account
 */

const COL_LABEL = 1; // cột B: tên đầu mục
const SESSION_RE = /^(OFF_)?(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/i;

// ── CSV: tự viết vì phải xử lý ô có xuống dòng và dấu phẩy bên trong ──────────
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Gom các dòng thành buổi học → môn → đầu mục. Chỉ giữ cột an toàn. */
function toSessions(rows, col) {
  const sessions = [];
  let cur = null, subject = "";
  rows.forEach((r, i) => {
    const rowNo = i + 1;                       // dòng thứ i trong CSV = dòng i+1 trong sheet
    const a = (r[0] || "").trim();
    const label = (r[COL_LABEL] || "").trim();
    const raw = (r[col] || "").trim().toUpperCase();
    const isTask = raw === "TRUE" || raw === "FALSE";

    if (a && !isTask) {
      if (SESSION_RE.test(a)) {                // "Saturday 30/8", "OFF_Thursday 27/8"
        cur = { title: a, items: [] };
        sessions.push(cur);
        subject = "";
      } else {
        subject = a;                           // "Science", "English"
      }
      if (!label) return;                      // dòng chỉ có tiêu đề, không phải việc
    }
    if (!isTask || !label) return;
    if (!cur) { cur = { title: "Chưa phân buổi", items: [] }; sessions.push(cur); }
    cur.items.push({
      row: rowNo,
      subject,
      label,
      url: /^https?:\/\//.test(label) ? label : "",
      done: raw === "TRUE",
    });
  });
  return sessions.filter((s) => s.items.length);
}

export async function readSheet(env) {
  if (!env.SHEET_ID || !env.SHEET_GID) {
    return { error: "Chưa cấu hình SHEET_ID / SHEET_GID", status: 503 };
  }
  const url = `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/export?format=csv&gid=${env.SHEET_GID}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) return { error: `Không đọc được sheet (HTTP ${r.status})`, status: 502 };
  const col = Number(env.SHEET_COL ?? 4);
  const sessions = toSessions(parseCsv(await r.text()), col);
  const total = sessions.reduce((n, s) => n + s.items.length, 0);
  const done = sessions.reduce((n, s) => n + s.items.filter((i) => i.done).length, 0);
  return { sessions, total, done };
}

// ── Ghi: service account → JWT → access token → Sheets API ───────────────────
let tokenCache = { value: "", exp: 0 };

function b64url(buf) {
  const bin = typeof buf === "string" ? buf : String.fromCharCode(...new Uint8Array(buf));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}

async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp - 120 > now) return tokenCache.value;

  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${b64url(sig)}`,
    }),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || "không lấy được token");
  tokenCache = { value: d.access_token, exp: now + (d.expires_in || 3600) };
  return tokenCache.value;
}

export async function writeCell(env, row, done) {
  if (!env.GOOGLE_SA_KEY) {
    return { error: "Chưa cấu hình GOOGLE_SA_KEY — xem CLAUDE.md", status: 503 };
  }
  const col = Number(env.SHEET_COL ?? 4);
  const token = await accessToken(env);
  // Dùng batchUpdate với sheetId (gid) để khỏi phải biết tên tab
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}:batchUpdate`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        requests: [{
          updateCells: {
            range: {
              sheetId: Number(env.SHEET_GID),
              startRowIndex: row - 1, endRowIndex: row,
              startColumnIndex: col, endColumnIndex: col + 1,
            },
            rows: [{ values: [{ userEnteredValue: { boolValue: !!done } }] }],
            fields: "userEnteredValue",
          },
        }],
      }),
    },
  );
  if (!r.ok) {
    const t = await r.text();
    return { error: `Sheets API ${r.status}: ${t.slice(0, 160)}`, status: 502 };
  }
  return { ok: true };
}
