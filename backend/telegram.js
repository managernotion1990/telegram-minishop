/**
 * backend/telegram.js
 * Telegram WebApp initData validation (https://core.telegram.org/bots/webapps#validating-data-received-from-the-mini-app).
 *
 * Algorithm:
 *   secret_key = HMAC-SHA256(key="WebAppData", msg=botToken)
 *   data_check_string = "\n"-joined "key=<value>" pairs of all params except "hash", sorted by key
 *   expected = HMAC-SHA256(key=secret_key, msg=data_check_string)  (hex)
 *   valid if expected === hash (timing-safe compare)
 */
const crypto = require('crypto');

/**
 * @param {string} initData raw initData string from Telegram.WebApp
 * @param {string} botToken bot token from BotFather
 * @returns {{valid: boolean, user: object|null}} parsed `user` object when valid
 */
function validateInitData(initData, botToken) {
  if (!initData || !botToken) return { valid: false, user: null };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false, user: null };
  params.delete('hash');
  params.sort();

  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  let valid = false;
  try {
    valid = expected.length === hash.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
  } catch {
    valid = false;
  }

  let user = null;
  if (valid) {
    try {
      user = JSON.parse(params.get('user') || 'null');
    } catch {
      user = null;
    }
  }
  return { valid, user };
}

module.exports = { validateInitData };
