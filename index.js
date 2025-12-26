require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_ADMIN_ID = process.env.BOT_ADMIN_ID; 

if (!BOT_TOKEN) {
  console.error('Errore: manca TELEGRAM_BOT_TOKEN nel .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const SUBS_FILE = './subscriptions.json';

// =======================
// Helper: escape HTML
// =======================

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =======================
// Gestione storage
// =======================

function loadSubscriptions() {
  try {
    if (!fs.existsSync(SUBS_FILE)) {
      fs.writeFileSync(SUBS_FILE, JSON.stringify({}, null, 2));
      return {};
    }
    const data = fs.readFileSync(SUBS_FILE, 'utf8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Errore loadSubscriptions:', err);
    return {};
  }
}

function saveSubscriptions(subs) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
  } catch (err) {
    console.error('Errore saveSubscriptions:', err);
  }
}

let subscriptions = loadSubscriptions(); // { [chatId]: { tiktokHandle, lastSentAt } }

// =======================
// Helper: controllo admin
// =======================

function isAdmin(msg) {
  if (!BOT_ADMIN_ID) return true;
  return String(msg.from.id) === String(BOT_ADMIN_ID);
}

// =======================
// Chiamata API TikTok
// =======================

async function fetchTikTokAnalytics(handleOrUrl) {
  const url = 'https://free-tools.socialinsider.io/api';

  const payload = {
    id: 1,
    method: 'tk_tools.free_tools',
    params: {
      handle: handleOrUrl,               
      timezone: 'Europe/Rome',
      tool: 'free_video_analytics',
      auth: {
        dashboardVersion: 1
      }
    }
  };

  const res = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  return res.data;
}

// =======================
// Formattazione messaggio (HTML)
// =======================

function formatReportMessage(data) {
  const profileName = data.profile_name || data.profile_id || 'Profilo';
  const handle = data.profile_id ? `@${data.profile_id}` : '';

  const followers = data.profile_followers?.value ?? 0;
  const er = data.engagement_rate?.float_2f ?? 0;
  const totalViews = data.video_views?.abbr_string_1f ?? data.video_views?.value ?? 0;
  const avgViews = data.average_video_views_per_post?.float_1f ?? 0;
  const avgLikes = data.likes?.float_1f ?? 0;
  const posts = data.posts ?? 0;

  const profileNameEsc = escapeHtml(profileName);
  const handleEsc = escapeHtml(handle);
  const totalViewsEsc = escapeHtml(totalViews);
  const followersEsc = escapeHtml(followers);
  const erEsc = escapeHtml(er);
  const postsEsc = escapeHtml(posts);
  const avgViewsEsc = escapeHtml(avgViews.toFixed ? avgViews.toFixed(1) : avgViews);
  const avgLikesEsc = escapeHtml(avgLikes.toFixed ? avgLikes.toFixed(1) : avgLikes);

  let msg = `📊 <b>Report TikTok</b>\n`;
  msg += `👤 Profilo: <b>${profileNameEsc}</b> ${handleEsc}\n\n`;
  msg += `👥 Follower: <b>${followersEsc}</b>\n`;
  msg += `🔥 Engagement rate: <b>${erEsc}%</b>\n`;
  msg += `🎬 Post analizzati: <b>${postsEsc}</b>\n\n`;
  msg += `👁️‍🗨️ Views totali: <b>${totalViewsEsc}</b>\n`;
  msg += `📈 Views medie/video: <b>${avgViewsEsc}</b>\n`;
  msg += `❤️ Like medi/video: <b>${avgLikesEsc}</b>\n`;

  if (Array.isArray(data.top_posts) && data.top_posts.length > 0) {
    const top = data.top_posts.slice(0, 3);
    msg += `\n🏆 <b>Top video</b>\n`;
    top.forEach((p, idx) => {
      const likes = p.like_count ?? p.diggCount ?? 0;
      const likesEsc = escapeHtml(likes);
      const link = p.si_permalink || p.permalink || p.si_picture || '';
      const linkEsc = escapeHtml(link);

      msg += `${idx + 1}) ❤️ ${likesEsc} like\n`;
      if (link) {
        msg += `${linkEsc}\n`;
      }
    });
  }

  return msg;
}

// =======================
// Invio report per una chat
// =======================

async function sendReportToChat(chatId, tiktokHandle) {
  try {
    const data = await fetchTikTokAnalytics(tiktokHandle);
    const message = formatReportMessage(data);
    await bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    subscriptions[chatId].lastSentAt = new Date().toISOString();
    saveSubscriptions(subscriptions);
  } catch (err) {
    console.error(`Errore nel report per chat ${chatId}:`, err?.response?.data || err.message);
    await bot.sendMessage(
      chatId,
      '⚠️ Errore nel recupero dei dati TikTok. Riproverò al prossimo ciclo.'
    ).catch(() => {});
  }
}

// =======================
// Scheduler ogni 12 ore
// =======================

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

async function runSchedulerCycle() {
  console.log('Esecuzione ciclo scheduler', new Date().toISOString());
  const entries = Object.entries(subscriptions); // [ [chatId, {..}], ... ]

  for (const [chatId, info] of entries) {
    if (!info.tiktokHandle) continue;
    console.log(`Invio report per chat ${chatId} (${info.tiktokHandle})`);
    await sendReportToChat(chatId, info.tiktokHandle);
    await new Promise(res => setTimeout(res, 1500));
  }
}

runSchedulerCycle();
setInterval(runSchedulerCycle, TWELVE_HOURS_MS);

// =======================
// Comandi Telegram
// =======================

bot.onText(/^\/start/, (msg) => {
  const text =
    'Ciao! Sono il bot report TikTok.\n' +
    'Comandi disponibili (solo admin):\n' +
    '/add &lt;link_tiktok&gt; &lt;id_chat&gt;\n' +
    '/rem &lt;id_chat&gt;\n' +
    '/list';

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// /add link_tiktok id_chat
bot.onText(/^\/add(?:@[\w_]+)?\s+(\S+)(?:\s+(-?\d+))?/, (msg, match) => {
  if (!isAdmin(msg)) return;

  const tiktokLink = match[1];
  const chatIdToUse = match[2] ? match[2] : String(msg.chat.id);

  subscriptions[chatIdToUse] = {
    tiktokHandle: tiktokLink,
    lastSentAt: null
  };
  saveSubscriptions(subscriptions);

  const chatIdEsc = escapeHtml(chatIdToUse);
  const linkEsc = escapeHtml(tiktokLink);

  bot.sendMessage(
    msg.chat.id,
    `✅ Aggiunto report per chat <b>${chatIdEsc}</b> sul profilo:\n${linkEsc}`,
    { parse_mode: 'HTML' }
  );
});

// /rem id_chat
bot.onText(/^\/rem(?:@[\w_]+)?\s+(-?\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;

  const chatIdToRemove = match[1];
  if (subscriptions[chatIdToRemove]) {
    delete subscriptions[chatIdToRemove];
    saveSubscriptions(subscriptions);
    bot.sendMessage(
      msg.chat.id,
      `🗑️ Rimossa chat <b>${escapeHtml(chatIdToRemove)}</b> dalla lista report.`,
      { parse_mode: 'HTML' }
    );
  } else {
    bot.sendMessage(
      msg.chat.id,
      `❓ Chat <b>${escapeHtml(chatIdToRemove)}</b> non trovata.`,
      { parse_mode: 'HTML' }
    );
  }
});

// /list
bot.onText(/^\/list/, (msg) => {
  if (!isAdmin(msg)) return;

  const entries = Object.entries(subscriptions);
  if (entries.length === 0) {
    return bot.sendMessage(msg.chat.id, '📭 Nessuna chat configurata.', {
      parse_mode: 'HTML'
    });
  }

  let text = '📋 <b>Chat configurate</b>\n\n';
  for (const [chatId, info] of entries) {
    const chatIdEsc = escapeHtml(chatId);
    const linkEsc = escapeHtml(info.tiktokHandle);
    const lastSentEsc = info.lastSentAt ? escapeHtml(info.lastSentAt) : 'mai';

    text += `• Chat ID: <b>${chatIdEsc}</b>\n`;
    text += `  TikTok: ${linkEsc}\n`;
    text += `  Ultimo invio: ${lastSentEsc}\n\n`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

console.log('Bot avviato...');
