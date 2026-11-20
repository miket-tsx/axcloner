export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function snowflake() {
  const ts = BigInt(Date.now() - 1420070400000);
  const rand = BigInt(Math.floor(Math.random() * 0x3fffff));
  return ((ts << 22n) | rand).toString();
}

export function avatarUrl(user, size = 128) {
  if (!user || !user.avatar) return null;
  const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
}

export function guildIconUrl(guild, size = 1024) {
  if (!guild || !guild.icon) return null;
  const ext = String(guild.icon).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${ext}?size=${size}`;
}

export function emojiUrl(emoji, size = 96) {
  if (!emoji || !emoji.id) return null;
  const ext = emoji.animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}?size=${size}`;
}

export function roleIconUrl(roleId, icon, size = 64) {
  if (!icon) return null;
  const ext = String(icon).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/role-icons/${roleId}/${icon}.${ext}?size=${size}`;
}

export async function fetchAsDataUri(url) {
  if (!url) return null;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'image/png';
  const mime = type.split(';')[0];
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export async function fetchBinary(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) {
    const err = new Error(`download failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0],
  };
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunkString(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

export function truncate(str, max) {
  if (str == null) return str;
  return str.length > max ? `${str.slice(0, Math.max(0, max - 1))}…` : str;
}

export function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function humanWait(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'a moment';
  if (seconds < 1) return `${Math.ceil(seconds * 1000)}ms`;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
