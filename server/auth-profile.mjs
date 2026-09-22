import { transaction } from './db.mjs';

// GitHub public profile fields only. An address change always requires new consent.
export function refreshPublicProfile(db, account, profile) {
  const email = typeof profile.email === 'string' && profile.email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(profile.email) ? profile.email : null;
  const name = String(profile.name || profile.login || account.name).slice(0, 160);
  return transaction(db, () => {
    const changed = email !== account.email;
    db.prepare('UPDATE users SET name=?,email=?,email_opt_in=? WHERE id=?').run(name, email, changed ? 0 : account.email_opt_in, account.id);
    if (changed) db.prepare("UPDATE outbox SET status='cancelled',last_error='公开邮箱变化，需要重新确认邮件订阅' WHERE user_id=? AND status IN ('queued','retry','previewed')").run(account.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(account.id);
  });
}
