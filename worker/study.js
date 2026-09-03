/**
 * Lớp ôn tập: đọc lịch ôn và ghi kết quả làm bài vào D1.
 *
 * Vì sao D1 chứ không phải KV (đã cân nhắc kỹ, đừng đổi lại):
 *   1. KV không có CAS. Một phiên luyện tập là một CHÙM ghi dồn dập; hai tab hoặc
 *      một lần thử lại sau khi rớt mạng là mất trắng cả phiên.
 *   2. Đường ĐỌC mới là chỗ chết: "câu nào hay sai nhất" trên KV là parse toàn kho
 *      rồi gộp bằng JS, O(toàn kho) mỗi lần gọi, trong khi Worker Free chỉ có 10ms CPU.
 *   3. Lịch sử từng lượt phình vô hạn (~16.000 dòng/năm) — không nhét vào một
 *      tài liệu JSON đọc-sửa-ghi được.
 *
 * Tiến độ "đã học" vẫn ở KV, không đụng tới.
 *
 * ĐỘ TRỄ, không phải hạn mức, mới là cạm bẫy của D1: từ Việt Nam tới primary mất
 * ~200ms mỗi vòng. 20 thẻ mà await tuần tự = 4 giây trẻ ngồi nhìn vòng quay. Mọi
 * thao tác nhiều câu lệnh BẮT BUỘC đi qua db.batch() — một vòng, và là một giao dịch.
 */

// Cho phép chữ, số, gạch ngang, gạch dưới và dấu chấm (id có dạng "q.4f81b2c0").
const ID_RE = /^[\w.-]{1,64}$/;
const MAX_ATTEMPTS = 200; // một phiên dài nhất còn hợp lý
const MS_CAP = 600000;    // 10 phút cho một câu là quá thừa
const DUE_CAP = 31536000; // không cho hoãn quá 1 năm

const ok = (s) => typeof s === "string" && ID_RE.test(s);

/** Lịch ôn của một học sinh trong một môn. 1 câu lệnh, 2 tham số. */
export async function readCards(env, user, course) {
  const r = await env.STUDY_DB.prepare(
    `SELECT item_id, n, wrong, streak, box, ease, due, last_ts
       FROM card WHERE user_id = ?1 AND course = ?2`
  )
    .bind(user, course)
    .all();
  // Trả dạng cột + hàng chứ không phải mảng object: khoảng 1/3 số byte và 1/3
  // thời gian stringify — đáng kể khi chỉ có 10ms CPU.
  const cols = ["item_id", "n", "wrong", "streak", "box", "ease", "due", "last_ts"];
  return { cols, rows: (r.results || []).map((o) => cols.map((c) => o[c])) };
}

/**
 * Ghi cả phiên bằng ĐÚNG 2 câu lệnh và 8 tham số, bất kể phiên dài bao nhiêu.
 *
 * Mẹo là json_each trên một tham số JSON duy nhất: kích thước phiên không còn
 * liên quan gì tới trần 100 tham số ràng buộc lẫn trần 100KB độ dài câu lệnh.
 * Nếu sau này sửa hàm này thì giữ nguyên tính chất đó — đừng quay về cách nối
 * chuỗi "(?,?,?),(?,?,?)…" vì nó chia lô theo số tham số và sinh nhiều vòng mạng.
 *
 * Máy chủ KHÔNG tin client: mốc thời gian bị kẹp vào [now-24h, now] để không lùi
 * ngày mà lách lịch ôn, còn box/ease/due bị kẹp vào khoảng hợp lệ.
 */
export async function writeSession(env, user, course, attempts) {
  const now = Math.floor(Date.now() / 1000);

  // Lọc trước ở JS cho rẻ; SQL vẫn kẹp lại lần nữa.
  const rows = attempts
    .filter((a) => a && ok(a.i) && ok(a.c))
    .slice(0, MAX_ATTEMPTS)
    .map((a) => ({
      i: a.i,
      c: a.c,
      ok: a.ok ? 1 : 0,
      g: Number(a.g) || 0,
      ms: Number(a.ms) || 0,
      t: Number(a.t) || now,
      x: typeof a.x === "string" ? a.x.slice(0, 64) : null,
      box: Number(a.box) || 1,
      ease: Number(a.ease) || 250,
      due: Number(a.due) || now,
    }));
  if (!rows.length) return { ok: true, n: 0 };

  const payload = JSON.stringify(rows);
  const db = env.STUDY_DB;

  const insertAttempts = db
    .prepare(
      `INSERT INTO attempt (ts,user_id,course,item_id,concept_id,correct,grade,ms,chose)
       SELECT MIN(MAX(COALESCE(json_extract(e.value,'$.t'), ?3), ?3 - 86400), ?3),
              ?1, ?2,
              json_extract(e.value,'$.i'),
              json_extract(e.value,'$.c'),
              CASE WHEN json_extract(e.value,'$.ok') THEN 1 ELSE 0 END,
              MIN(MAX(COALESCE(json_extract(e.value,'$.g'), 0), 0), 3),
              MIN(MAX(COALESCE(json_extract(e.value,'$.ms'), 0), 0), ${MS_CAP}),
              json_extract(e.value,'$.x')
         FROM json_each(?4) AS e`
    )
    .bind(user, course, now, payload);

  // Cùng một câu xuất hiện hai lần trong một phiên (thẻ sai được hỏi lại) vẫn
  // đúng: SQLite duyệt tuần tự nên lần thứ hai rơi vào nhánh ON CONFLICT.
  const upsertCards = db
    .prepare(
      `INSERT INTO card (user_id,item_id,course,concept_id,n,wrong,streak,box,ease,due,last_ts)
       SELECT ?1,
              json_extract(e.value,'$.i'),
              ?2,
              json_extract(e.value,'$.c'),
              1,
              CASE WHEN json_extract(e.value,'$.ok') THEN 0 ELSE 1 END,
              CASE WHEN json_extract(e.value,'$.ok') THEN 1 ELSE 0 END,
              MIN(MAX(COALESCE(json_extract(e.value,'$.box'),  1),   1),   6),
              MIN(MAX(COALESCE(json_extract(e.value,'$.ease'), 250), 130), 350),
              MIN(MAX(COALESCE(json_extract(e.value,'$.due'),  ?3),  ?3), ?3 + ${DUE_CAP}),
              ?3
         FROM json_each(?4) AS e
        WHERE true   -- BẮT BUỘC: với INSERT…SELECT, SQLite không phân biệt được
                     -- "ON" của JOIN với "ON CONFLICT" nếu SELECT không có WHERE.
       ON CONFLICT(user_id, item_id) DO UPDATE SET
              n          = card.n + 1,
              wrong      = card.wrong + excluded.wrong,
              streak     = CASE WHEN excluded.streak = 1 THEN card.streak + 1 ELSE 0 END,
              box        = excluded.box,
              ease       = excluded.ease,
              due        = excluded.due,
              last_ts    = excluded.last_ts,
              course     = excluded.course,
              concept_id = excluded.concept_id`
    )
    .bind(user, course, now, payload);

  await db.batch([insertAttempts, upsertCards]);
  return { ok: true, n: rows.length };
}
