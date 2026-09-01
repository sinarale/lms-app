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

/** Gom các dòng thành buổi học → nhóm nhỏ → đầu mục. Chỉ giữ cột an toàn.
 *
 * Cấu trúc thật trong sheet:
 *   cột A "Saturday 30/8"                 → buổi học
 *   cột A "Science"                       → môn của buổi đó
 *   cột B "4.5. Vocab: Teeth" (không tick) → tiêu đề nhóm nhỏ
 *   cột B <nội dung> + cột E TRUE/FALSE   → đầu mục cần làm
 *
 * `rows[i][j]` là { text, link } — link có thể là hyperlink gắn trong ô mà bản
 * xuất CSV không hề chứa.
 */
function toSessions(rows, col) {
  const sessions = [];
  let cur = null, group = null, subject = "";

  const newGroup = (name) => {
    group = { name, items: [] };
    if (cur) cur.groups.push(group);
  };

  rows.forEach((r, i) => {
    const rowNo = i + 1;                       // dòng thứ i = dòng i+1 trong sheet
    const cell = (j) => (r[j] || { text: "", link: "" });
    const a = cell(0).text.trim();
    const b = cell(COL_LABEL);
    const label = b.text.trim();
    const raw = cell(col).text.trim().toUpperCase();
    const isTask = raw === "TRUE" || raw === "FALSE";

    if (a && !isTask) {
      if (SESSION_RE.test(a)) {                // "Saturday 30/8", "OFF_Thursday 27/8"
        cur = { title: a, groups: [] };
        sessions.push(cur);
        subject = "";
        group = null;
      } else {
        subject = a;                           // "Science", "English"
      }
    }
    if (!label) return;

    if (!isTask) { newGroup(label); return; }  // dòng có chữ nhưng không có ô tick
    if (!cur) { cur = { title: "Chưa phân buổi", groups: [] }; sessions.push(cur); }
    if (!group) newGroup("");
    group.items.push({
      row: rowNo,
      subject,
      label,
      // Ưu tiên hyperlink gắn trong ô; nếu không có thì xét bản thân nội dung
      url: b.link || (/^https?:\/\//.test(label) ? label : ""),
      done: raw === "TRUE",
    });
  });

  return sessions
    .map((s) => ({ ...s, groups: s.groups.filter((g) => g.items.length) }))
    .filter((s) => s.groups.length);
}

/** Đọc qua Sheets API — cách DUY NHẤT lấy được hyperlink gắn trong ô.
 *  Bản xuất CSV/gviz chỉ có text hiển thị, nên ô kiểu "Can You Name the baby
 *  Animals" gắn link sẽ mất link nếu đọc bằng CSV. */
async function readViaApi(env, col) {
  const token = await accessToken(env);
  const auth = { authorization: `Bearer ${token}` };
  const id = env.SHEET_ID;

  // Cần TÊN tab để dùng A1 notation; chỉ có gid nên phải tra một lần
  const meta = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(sheetId,title)`,
    { headers: auth },
  );
  if (!meta.ok) throw new Error(`Sheets API ${meta.status} khi đọc metadata`);
  const gid = Number(env.SHEET_GID);
  const tab = (await meta.json()).sheets.find((s) => s.properties.sheetId === gid);
  if (!tab) throw new Error(`Không tìm thấy tab có gid=${gid}`);

  // Chỉ lấy các cột an toàn (A..F). Cột G/H chứa mật khẩu tài khoản học liệu —
  // không bao giờ được lọt ra khỏi Worker.
  const lastCol = String.fromCharCode(65 + Math.max(col, 5));
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}` +
      `?includeGridData=true&ranges=${encodeURIComponent(`'${tab.properties.title}'!A:${lastCol}`)}` +
      `&fields=${encodeURIComponent("sheets.data.rowData.values(formattedValue,hyperlink)")}`,
    { headers: auth },
  );
  if (!r.ok) throw new Error(`Sheets API ${r.status} khi đọc dữ liệu`);
  const grid = (await r.json()).sheets?.[0]?.data?.[0]?.rowData || [];
  return grid.map((row) =>
    (row.values || []).map((c) => ({ text: c.formattedValue || "", link: c.hyperlink || "" })),
  );
}

/** Dự phòng khi chưa cấu hình service account: đọc bản CSV công khai.
 *  Mất hyperlink nhưng vẫn xem được danh sách và trạng thái. */
async function readViaCsv(env) {
  const url = `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/export?format=csv&gid=${env.SHEET_GID}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Không đọc được sheet (HTTP ${r.status})`);
  return parseCsv(await r.text()).map((row) => row.map((t) => ({ text: t, link: "" })));
}

export async function readSheet(env) {
  if (!env.SHEET_ID || !env.SHEET_GID) {
    return { error: "Chưa cấu hình SHEET_ID / SHEET_GID", status: 503 };
  }
  const col = Number(env.SHEET_COL ?? 4);
  let rows, source = "api";
  try {
    if (!env.GOOGLE_SA_KEY) throw new Error("chưa có service account");
    rows = await readViaApi(env, col);
  } catch (e) {
    rows = await readViaCsv(env);   // vẫn dùng được, chỉ thiếu hyperlink
    source = "csv";
  }
  const sessions = toSessions(rows, col);
  const items = sessions.flatMap((s) => s.groups.flatMap((g) => g.items));
  return {
    sessions,
    source,
    total: items.length,
    done: items.filter((i) => i.done).length,
  };
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

  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SA_KEY);
  } catch {
    // Hay gặp: dán JSON nhiều dòng vào prompt của `wrangler secret put` thì chỉ
    // một phần được nhận. Phải nạp từ file: wrangler secret put X < key.json
    throw new Error(
      "GOOGLE_SA_KEY không phải JSON hợp lệ (dài " + (env.GOOGLE_SA_KEY || "").length +
      " ký tự). Nạp lại từ file thay vì dán tay: " +
      "npx wrangler secret put GOOGLE_SA_KEY < key.json");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SA_KEY thiếu client_email hoặc private_key");
  }
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
