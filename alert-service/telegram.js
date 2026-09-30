// Telegram bot over long polling: the machine calls out to Telegram, so it
// works behind home NAT with no public URL or TLS certificate.
const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

const LOCATION_KEYBOARD = {
  keyboard: [[{ text: '📍 ส่งตำแหน่งของฉัน', request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

const HELP = [
  'BKK Watch — แจ้งเตือนระดับน้ำสูงและดับไฟในกรุงเทพฯ',
  '',
  '📍 ส่งตำแหน่ง (ปุ่มด้านล่าง หรือแนบ Location) — ติดตามพื้นที่รอบจุดนั้น',
  '/radius 3 — ตั้งรัศมีเป็นกิโลเมตร (0.5–20)',
  '/watch ลาซาล — แจ้งเมื่อประกาศดับไฟมีคำนี้ (เช่นชื่อซอย/หมู่บ้าน)',
  '/unwatch ลาซาล — เลิกติดตามคำนั้น',
  '/status — สถานการณ์ตอนนี้ในพื้นที่ของคุณ',
  '/stop — หยุดรับแจ้งเตือน',
  '',
  'แหล่งข้อมูล: สถานีวัดน้ำ สสน./ThaiWater (กทม. 9 สถานี) และประกาศดับไฟตามแผนของ MEA',
  'ยังไม่ครอบคลุมไฟดับฉุกเฉินและน้ำท่วมถนนโดยตรง',
].join('\n');

export function createTelegram({ token, db, config, engine }) {
  const call = async (method, body) => {
    const res = await fetch(API(token, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  };

  const q = {
    get: db.prepare('SELECT * FROM subscribers WHERE chat_id = ?'),
    ensure: db.prepare(
      'INSERT OR IGNORE INTO subscribers (chat_id, radius_m, active, created_at) VALUES (?, ?, 1, ?)',
    ),
    setLoc: db.prepare(
      'UPDATE subscribers SET lat = ?, lon = ?, active = 1 WHERE chat_id = ?',
    ),
    setRadius: db.prepare(
      'UPDATE subscribers SET radius_m = ? WHERE chat_id = ?',
    ),
    setActive: db.prepare(
      'UPDATE subscribers SET active = ? WHERE chat_id = ?',
    ),
    addKw: db.prepare(
      'INSERT OR IGNORE INTO keywords (chat_id, keyword) VALUES (?, ?)',
    ),
    delKw: db.prepare('DELETE FROM keywords WHERE chat_id = ? AND keyword = ?'),
    kws: db.prepare('SELECT keyword FROM keywords WHERE chat_id = ?'),
  };

  const send = (chatId, text, extra = {}) =>
    call('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...extra,
    });

  function subscriber(chatId) {
    q.ensure.run(chatId, config.defaultRadiusM, Date.now());
    return q.get.get(chatId);
  }
  const keywords = (chatId) => q.kws.all(chatId).map((r) => r.keyword);

  async function handle(msg) {
    const chatId = String(msg.chat.id);
    const sub = subscriber(chatId);
    if (msg.location) {
      q.setLoc.run(msg.location.latitude, msg.location.longitude, chatId);
      const s = q.get.get(chatId);
      await send(
        chatId,
        `✅ บันทึกตำแหน่งแล้ว ติดตามรัศมี ${(s.radius_m / 1000).toFixed(1)} กม.\n\n${engine.statusFor(s, keywords(chatId))}`,
        {
          reply_markup: { remove_keyboard: true },
        },
      );
      return;
    }
    const [cmd, ...rest] = String(msg.text || '')
      .trim()
      .split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd.replace(/@.*$/, '')) {
      case '/start':
      case '/help':
        q.setActive.run(1, chatId);
        await send(chatId, HELP, { reply_markup: LOCATION_KEYBOARD });
        return;
      case '/radius': {
        const kmVal = Number(arg);
        if (!(kmVal >= 0.5 && kmVal <= 20))
          return send(chatId, 'ใช้แบบนี้: /radius 3 (0.5–20 กม.)');
        q.setRadius.run(Math.round(kmVal * 1000), chatId);
        return send(chatId, `ตั้งรัศมีเป็น ${kmVal} กม. แล้ว`);
      }
      case '/watch':
        if (arg.length < 2)
          return send(chatId, 'ใช้แบบนี้: /watch ชื่อซอยหรือหมู่บ้าน');
        q.addKw.run(chatId, arg);
        return send(
          chatId,
          `จะแจ้งเมื่อประกาศดับไฟมีคำว่า "${arg}"\n\n${engine.statusFor(q.get.get(chatId), keywords(chatId))}`,
        );
      case '/unwatch':
        q.delKw.run(chatId, arg);
        return send(chatId, `เลิกติดตาม "${arg}" แล้ว`);
      case '/status':
        return send(
          chatId,
          engine.statusFor(q.get.get(chatId), keywords(chatId)),
        );
      case '/stop':
        q.setActive.run(0, chatId);
        return send(chatId, 'หยุดแจ้งเตือนแล้ว พิมพ์ /start เพื่อเริ่มใหม่');
      default:
        if (sub.lat == null)
          return send(chatId, HELP, { reply_markup: LOCATION_KEYBOARD });
        return send(chatId, 'ไม่รู้จักคำสั่งนี้ — พิมพ์ /help');
    }
  }

  async function run(signal) {
    const me = await call('getMe', {});
    console.log(`[telegram] polling as @${me.username}`);
    let offset = 0;
    while (!signal?.aborted) {
      try {
        const updates = await call('getUpdates', {
          offset,
          timeout: 50,
          allowed_updates: ['message'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message)
            await handle(u.message).catch((e) =>
              console.warn(`[telegram] ${e.message}`),
            );
        }
      } catch (e) {
        console.warn(`[telegram] ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return { send, run };
}
