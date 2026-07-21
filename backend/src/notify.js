// ════════════════════════════════════════════════════════════════════
// Telegram notifications for fofus-quote
// ════════════════════════════════════════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TECHNICIAN_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || process.env.TECHNICIAN_CHAT_ID || '1507272535';

export async function sendTelegram(text) {
  if (!BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN not set; skipping Telegram notification');
    return { ok: false, reason: 'no_token' };
  }
  if (!CHAT_ID) {
    console.warn('TELEGRAM_CHAT_ID not set; skipping Telegram notification');
    return { ok: false, reason: 'no_chat_id' };
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      console.error('Telegram notify failed:', data);
      return { ok: false, detail: data };
    }
    return { ok: true, message_id: data.result?.message_id };
  } catch (e) {
    console.error('Telegram notify exception:', e);
    return { ok: false, error: e.message };
  }
}

export async function notifyNewQuote(job) {
  const quote = job.final_quote || job.client_quote || {};
  const total = Math.round(quote.total_inr || quote.total || 0);
  const material = (job.material || 'PLA').toUpperCase();
  const printer = job.printer?.toUpperCase() || 'X1C';

  const text = [
    `🖨 *New fofus-quote request*`,
    ``,
    `*File:* ${job.file_name || '—'}`,
    `*Customer:* ${job.contact_name || '—'}`,
    `*Phone:* ${job.contact_phone || '—'}`,
    `*Email:* ${job.contact_email || '—'}`,
    `*Pincode:* ${job.pincode || '—'}`,
    `*Notes:* ${job.notes || '—'}`,
    ``,
    `*Quote:* ₹${total.toLocaleString('en-IN')}`,
    `*Material:* ${material}  *Printer:* ${printer}`,
    `*Job ID:* \`${job.id}\``,
    ``,
    `Admin: https://quote.business.fofus.in/admin.html`,
  ].join('\n');

  return sendTelegram(text);
}

export async function notifyPaidOrder(job, shopifyOrderId, total) {
  const text = [
    `✅ *Paid fofus-quote order*`,
    ``,
    `*Customer:* ${job.contact_name || '—'}`,
    `*Phone:* ${job.contact_phone || '—'}`,
    `*Total:* ₹${Math.round(total).toLocaleString('en-IN')}`,
    `*Shopify Order:* \`${shopifyOrderId}\``,
    `*Job ID:* \`${job.id}\``,
  ].join('\n');

  return sendTelegram(text);
}
