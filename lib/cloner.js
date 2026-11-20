import { Rest, RateLimitError } from './rest.js';
import {
  sleep,
  snowflake,
  avatarUrl,
  guildIconUrl,
  emojiUrl,
  roleIconUrl,
  fetchAsDataUri,
  fetchBinary,
  mapLimit,
  chunkString,
  truncate,
  clampNumber,
  humanWait,
} from './util.js';

const ADMINISTRATOR = 1n << 3n;
const CHANNEL = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, STAGE: 13, FORUM: 15, MEDIA: 16 };
const MESSAGE_CHANNEL_TYPES = new Set([CHANNEL.TEXT, CHANNEL.ANNOUNCEMENT]);
const CLONEABLE_ROLE_LIMIT = 250;

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

function hasAdministrator(guild, member, roles, userId) {
  if (!guild || !member) return false;
  if (guild.owner_id === userId) return true;
  const myRoles = new Set(member.roles ?? []);
  return roles.some((role) => myRoles.has(role.id) && (BigInt(role.permissions) & ADMINISTRATOR) === ADMINISTRATOR);
}

function maxBitrate(guild) {
  const tier = guild?.premium_tier ?? 0;
  if (tier >= 3) return 384000;
  if (tier === 2) return 256000;
  if (tier === 1) return 128000;
  return 96000;
}

function maxUploadBytes(guild) {
  const tier = guild?.premium_tier ?? 0;
  if (tier >= 3) return 100 * 1024 * 1024;
  if (tier === 2) return 50 * 1024 * 1024;
  return 8 * 1024 * 1024;
}

function sanitizeEmbed(embed) {
  if (!embed || typeof embed !== 'object') return null;
  const out = {};
  if (embed.title) out.title = truncate(String(embed.title), 256);
  if (embed.description) out.description = truncate(String(embed.description), 4096);
  if (embed.url) out.url = embed.url;
  if (typeof embed.color === 'number' && embed.color > 0) out.color = embed.color;
  if (embed.timestamp) out.timestamp = embed.timestamp;
  if (Array.isArray(embed.fields) && embed.fields.length) {
    out.fields = embed.fields.slice(0, 25).map((field) => ({
      name: truncate(String(field.name ?? ''), 256) || '\u200b',
      value: truncate(String(field.value ?? ''), 1024) || '\u200b',
      inline: Boolean(field.inline),
    }));
  }
  if (embed.image?.url) out.image = { url: embed.image.url };
  if (embed.thumbnail?.url) out.thumbnail = { url: embed.thumbnail.url };
  if (embed.footer?.text) {
    out.footer = { text: truncate(String(embed.footer.text), 2048) };
    if (embed.footer.icon_url) out.footer.icon_url = embed.footer.icon_url;
  }
  if (embed.author?.name) {
    out.author = { name: truncate(String(embed.author.name), 256) };
    if (embed.author.url) out.author.url = embed.author.url;
    if (embed.author.icon_url) out.author.icon_url = embed.author.icon_url;
  }
  return Object.keys(out).length ? out : null;
}

function safeUsername(user) {
  const raw = user?.global_name || user?.username || 'unknown';
  const cleaned = String(raw).replace(/discord|clyde/gi, 'd!scord').trim();
  return (cleaned || 'user').slice(0, 80);
}

function buildWebhookPayload(message) {
  const payload = { allowed_mentions: { parse: [] } };
  payload.username = safeUsername(message.author);
  const avatar = avatarUrl(message.author, 128);
  if (avatar) payload.avatar_url = avatar;
  if (message.content) payload.content = message.content;
  const embeds = (message.embeds ?? []).map(sanitizeEmbed).filter(Boolean).slice(0, 10);
  if (embeds.length) payload.embeds = embeds;
  return payload;
}

function mapOverwrites(overwrites, roleMap, sourceGuildId, targetGuildId) {
  const out = [];
  for (const overwrite of overwrites ?? []) {
    if (overwrite.type !== 0) continue; // member overwrites are skipped: members are not cloned
    if (overwrite.id === sourceGuildId) {
      out.push({ id: targetGuildId, type: 0, allow: overwrite.allow, deny: overwrite.deny });
      continue;
    }
    const mapped = roleMap.get(overwrite.id);
    if (mapped) out.push({ id: mapped, type: 0, allow: overwrite.allow, deny: overwrite.deny });
  }
  return out;
}

function buildChannelPayload(channel, overwrites, parentId, targetGuild) {
  const payload = {
    name: channel.name,
    type: channel.type,
    position: channel.position ?? 0,
    permission_overwrites: overwrites,
  };
  if (parentId) payload.parent_id = parentId;

  switch (channel.type) {
    case CHANNEL.TEXT:
    case CHANNEL.ANNOUNCEMENT:
      if (channel.topic) payload.topic = truncate(channel.topic, 1024);
      if (channel.nsfw) payload.nsfw = true;
      if (channel.rate_limit_per_user) payload.rate_limit_per_user = channel.rate_limit_per_user;
      if (channel.default_auto_archive_duration) {
        payload.default_auto_archive_duration = channel.default_auto_archive_duration;
      }
      if (channel.default_thread_rate_limit_per_user) {
        payload.default_thread_rate_limit_per_user = channel.default_thread_rate_limit_per_user;
      }
      break;
    case CHANNEL.VOICE:
    case CHANNEL.STAGE:
      if (channel.bitrate) {
        payload.bitrate = clampNumber(channel.bitrate, 8000, maxBitrate(targetGuild), 64000);
      }
      if (channel.user_limit) payload.user_limit = channel.user_limit;
      if (channel.video_quality_mode) payload.video_quality_mode = channel.video_quality_mode;
      break;
    case CHANNEL.FORUM:
    case CHANNEL.MEDIA:
      if (channel.topic) payload.topic = truncate(channel.topic, 1024);
      if (channel.nsfw) payload.nsfw = true;
      if (channel.rate_limit_per_user) payload.rate_limit_per_user = channel.rate_limit_per_user;
      if (channel.default_auto_archive_duration) {
        payload.default_auto_archive_duration = channel.default_auto_archive_duration;
      }
      if (channel.default_sort_order != null) payload.default_sort_order = channel.default_sort_order;
      if (channel.default_forum_layout != null) payload.default_forum_layout = channel.default_forum_layout;
      if (channel.default_reaction_emoji?.emoji_name && !channel.default_reaction_emoji.emoji_id) {
        payload.default_reaction_emoji = { emoji_name: channel.default_reaction_emoji.emoji_name };
      }
      if (Array.isArray(channel.available_tags) && channel.available_tags.length) {
        payload.available_tags = channel.available_tags.map((tag) => ({
          name: truncate(String(tag.name ?? ''), 20) || 'tag',
          moderated: Boolean(tag.moderated),
          // custom emoji ids do not survive a server copy, unicode names do
          emoji_id: null,
          emoji_name: tag.emoji_id ? null : tag.emoji_name ?? null,
        }));
      }
      break;
    default:
      break;
  }
  return payload;
}

function channelSortKey(channel, positionById) {
  const parentPosition = channel.parent_id ? positionById.get(channel.parent_id) ?? 0 : -1;
  return [parentPosition, channel.position ?? 0, channel.id];
}

/**
 * Lightweight, non-mutating read of the source guild + optional target guild.
 */
export async function fetchPreview({ token, sourceId, targetId }) {
  const rest = new Rest(token, { maxConcurrent: 4 });

  const me = await rest.get('/users/@me');
  const guild = await rest.get(`/guilds/${sourceId}`);

  const [roles, channels, emojis] = await Promise.all([
    rest.get(`/guilds/${sourceId}/roles`),
    rest.get(`/guilds/${sourceId}/channels`),
    rest.get(`/guilds/${sourceId}/emojis`).catch(() => []),
  ]);

  let onboarding = { exists: false, prompts: 0, enabled: false };
  try {
    const data = await rest.get(`/guilds/${sourceId}/onboarding`);
    onboarding = {
      exists: Array.isArray(data?.prompts) ? data.prompts.length > 0 : false,
      prompts: data?.prompts?.length ?? 0,
      enabled: Boolean(data?.enabled),
    };
  } catch {
    onboarding = { exists: false, prompts: 0, enabled: false, locked: true };
  }

  let target = null;
  if (targetId) {
    try {
      const targetGuild = await rest.get(`/guilds/${targetId}`);
      const [member, targetRoles] = await Promise.all([
        rest.get(`/guilds/${targetId}/members/${me.id}`),
        rest.get(`/guilds/${targetId}/roles`),
      ]);
      target = {
        id: targetGuild.id,
        name: targetGuild.name,
        icon: guildIconUrl(targetGuild, 128),
        premium_tier: targetGuild.premium_tier ?? 0,
        canAdmin: hasAdministrator(targetGuild, member, targetRoles, me.id),
      };
    } catch (error) {
      target = { id: targetId, error: error.message };
    }
  }

  return {
    user: {
      id: me.id,
      username: me.username,
      global_name: me.global_name ?? null,
      avatar: avatarUrl(me, 128),
    },
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guildIconUrl(guild, 256),
      description: guild.description ?? null,
      member_count: guild.member_count ?? null,
      premium_tier: guild.premium_tier ?? 0,
      features: guild.features ?? [],
    },
    roles: roles.map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      position: role.position,
      managed: Boolean(role.managed),
      permissions: role.permissions,
    })),
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      position: channel.position,
      parent_id: channel.parent_id ?? null,
      topic: channel.topic ?? null,
      nsfw: Boolean(channel.nsfw),
    })),
    emojis: emojis.map((emoji) => ({
      id: emoji.id,
      name: emoji.name,
      animated: Boolean(emoji.animated),
      url: emojiUrl(emoji, 48),
    })),
    onboarding,
    target,
  };
}

/**
 * Main clone run. Emits structured events through `emit`:
 *   { type: 'log', level, message }
 *   { type: 'progress', percent, step }
 *   { type: 'stats', ... }
 *   { type: 'done', summary }
 *   { type: 'error', message, details }
 */
export async function cloneServer({ token, sourceId, targetId, options = {}, emit, signal }) {
  const log = (message, level = 'info') => emit({ type: 'log', level, message });
  const ok = (message) => log(message, 'ok');
  const warn = (message) => log(message, 'warn');
  const fail = (message) => log(message, 'error');
  let lastPercent = 0;
  const progress = (percent, step) => {
    const p = Math.max(lastPercent, Math.min(99, Math.round(percent)));
    if (p > lastPercent || step) {
      lastPercent = p;
      emit({ type: 'progress', percent: p, step });
    }
  };
  const ensureAlive = () => {
    if (signal?.aborted) throw new AbortedError();
  };
  const describe = (error) =>
    error instanceof RateLimitError
      ? `rate limited for ${humanWait(error.retryAfter)} (${error.scope})`
      : error.message;

  const tolerate = async (label, fn, fallback = null) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AbortedError) throw error;
      warn(`${label}: ${describe(error)}`);
      return fallback;
    }
  };

  const maxWaitMs = clampNumber(options.rateLimitWaitSeconds, 5, 300, 60) * 1000;

  let lastStatsAt = 0;
  const rest = new Rest(token, {
    maxConcurrent: 12,
    maxWaitMs,
    onRequest: (stats) => {
      const now = Date.now();
      if (now - lastStatsAt < 250) return;
      lastStatsAt = now;
      emit({ type: 'stats', requests: stats.requests, rateLimits: stats.hits429, waitMs: stats.waitMs });
    },
    onRateLimit: ({ path, retryAfter, scope, global }) =>
      emit({
        type: 'ratelimit',
        global,
        scope,
        path,
        retryAfter,
        message: `${scope} limit on ${path.split('?')[0]} — ${humanWait(retryAfter)}`,
      }),
  });

  const summary = {
    guild: null,
    roles: 0,
    categories: 0,
    channels: 0,
    emojis: 0,
    stickers: 0,
    soundboard: 0,
    webhooks: 0,
    invites: 0,
    bans: 0,
    events: 0,
    automod: 0,
    messages: 0,
    pins: 0,
    onboarding: false,
    welcome: false,
    warnings: [],
  };

  // ---------------------------------------------------------------- connect
  progress(2, 'connecting');
  log('connecting to discord…');
  const me = await rest.get('/users/@me');
  ok(`authenticated as ${me.username}${me.global_name ? ` (${me.global_name})` : ''}`);

  const sourceGuild = await rest.get(`/guilds/${sourceId}`);
  const targetGuild = await rest.get(`/guilds/${targetId}`);

  if (sourceGuild.id === targetGuild.id) throw new Error('source and target are the same server');

  const [targetMember, targetRoles] = await Promise.all([
    rest.get(`/guilds/${targetId}/members/${me.id}`),
    rest.get(`/guilds/${targetId}/roles`),
  ]);

  if (!hasAdministrator(targetGuild, targetMember, targetRoles, me.id)) {
    throw new Error(
      `missing administrator in target server "${targetGuild.name}" — the token account needs admin there`,
    );
  }
  ok(`target "${targetGuild.name}" — administrator confirmed`);
  summary.guild = { source: sourceGuild.name, target: targetGuild.name };
  progress(6, 'fetching source');

  const [sourceRoles, sourceChannels, sourceEmojis] = await Promise.all([
    rest.get(`/guilds/${sourceId}/roles`),
    rest.get(`/guilds/${sourceId}/channels`),
    rest.get(`/guilds/${sourceId}/emojis`).catch(() => []),
  ]);
  ok(`source "${sourceGuild.name}" — ${sourceRoles.length} roles, ${sourceChannels.length} channels`);

  // ---------------------------------------------------------------- wipe
  if (options.deleteExisting) {
    progress(8, 'wiping target');
    log('wiping existing target content…');
    const [channels, roles, emojis] = await Promise.all([
      rest.get(`/guilds/${targetId}/channels`),
      rest.get(`/guilds/${targetId}/roles`),
      rest.get(`/guilds/${targetId}/emojis`).catch(() => []),
    ]);

    let removedChannels = 0;
    await mapLimit(channels, 6, async (channel) => {
      ensureAlive();
      try {
        await rest.delete(`/channels/${channel.id}`);
        removedChannels++;
      } catch (error) {
        if (error.status !== 404) warn(`could not delete channel #${channel.name}: ${error.message}`);
      }
    });

    const protectedRoles = new Set(targetMember.roles ?? []);
    let removedRoles = 0;
    for (const role of roles) {
      ensureAlive();
      if (role.id === targetId || role.managed || protectedRoles.has(role.id)) continue;
      try {
        await rest.delete(`/guilds/${targetId}/roles/${role.id}`);
        removedRoles++;
      } catch (error) {
        if (error.status !== 404) warn(`could not delete role ${role.name}: ${error.message}`);
      }
    }

    let removedEmojis = 0;
    await mapLimit(emojis, 6, async (emoji) => {
      ensureAlive();
      try {
        await rest.delete(`/guilds/${targetId}/emojis/${emoji.id}`);
        removedEmojis++;
      } catch (error) {
        if (error.status !== 404) warn(`could not delete emoji ${emoji.name}: ${error.message}`);
      }
    });

    const extras = await Promise.all([
      rest.get(`/guilds/${targetId}/stickers`).catch(() => []),
      rest
        .get(`/guilds/${targetId}/soundboard-sounds`)
        .then((res) => res?.items ?? [])
        .catch(() => []),
    ]);

    let removedStickers = 0;
    await mapLimit(extras[0] ?? [], 6, async (sticker) => {
      ensureAlive();
      try {
        await rest.delete(`/guilds/${targetId}/stickers/${sticker.id}`);
        removedStickers++;
      } catch (error) {
        if (error.status !== 404) warn(`could not delete sticker ${sticker.name}: ${error.message}`);
      }
    });

    let removedSounds = 0;
    await mapLimit(extras[1] ?? [], 6, async (sound) => {
      ensureAlive();
      try {
        await rest.delete(`/guilds/${targetId}/soundboard-sounds/${sound.sound_id}`);
        removedSounds++;
      } catch (error) {
        if (error.status !== 404) warn(`could not delete sound ${sound.name}: ${error.message}`);
      }
    });

    const extraBits = [
      removedStickers ? `${removedStickers} stickers` : null,
      removedSounds ? `${removedSounds} sounds` : null,
    ].filter(Boolean);

    ok(
      `wiped: ${removedChannels} channels, ${removedRoles} roles, ${removedEmojis} emojis${
        extraBits.length ? `, ${extraBits.join(', ')}` : ''
      }`,
    );
    await sleep(600);
  }

  // ---------------------------------------------------------------- roles
  const roleMap = new Map([[sourceId, targetId]]);
  if (options.cloneRoles) {
    progress(16, 'cloning roles');
    log('cloning roles…');
    const everyone = sourceRoles.find((role) => role.id === sourceId);
    if (everyone) {
      await tolerate('@everyone permissions', () =>
        rest.patch(`/guilds/${targetId}/roles/${targetId}`, { permissions: everyone.permissions }),
      );
    }

    const creatable = sourceRoles
      .filter((role) => role.id !== sourceId && !role.managed)
      .sort((a, b) => a.position - b.position)
      .slice(0, CLONEABLE_ROLE_LIMIT - 1);

    // icons are CDN reads, so pull them all at once instead of stalling the
    // role queue on each one
    const roleIcons = new Map();
    const iconRoles = creatable.filter((role) => role.icon);
    if (iconRoles.length) {
      await mapLimit(iconRoles, 5, async (role) => {
        const uri = await tolerate(`role icon ${role.name}`, () =>
          fetchAsDataUri(roleIconUrl(role.id, role.icon)),
        );
        if (uri) roleIcons.set(role.id, uri);
      });
    }

    let index = 0;
    for (const role of creatable) {
      ensureAlive();
      const payload = {
        name: role.name,
        permissions: role.permissions,
        color: role.color,
        hoist: Boolean(role.hoist),
        mentionable: Boolean(role.mentionable),
      };
      if (role.unicode_emoji) payload.unicode_emoji = role.unicode_emoji;
      if (roleIcons.has(role.id)) payload.icon = roleIcons.get(role.id);
      try {
        const created = await rest.post(`/guilds/${targetId}/roles`, payload);
        roleMap.set(role.id, created.id);
        summary.roles++;
      } catch (error) {
        warn(`role "${role.name}" failed: ${describe(error)}`);
      }
      index++;
      progress(16 + (index / Math.max(1, creatable.length)) * 20, 'cloning roles');
    }

    const moves = creatable
      .filter((role) => roleMap.has(role.id))
      .map((role) => ({ id: roleMap.get(role.id), position: role.position }))
      .sort((a, b) => a.position - b.position);

    if (moves.length) {
      try {
        await rest.patch(`/guilds/${targetId}/roles`, moves);
        ok(`roles cloned (${summary.roles}) with positions`);
      } catch (error) {
        warn(`role position update failed: ${describe(error)}`);
      }
    } else {
      ok('roles cloned (0)');
    }
  }

  // ---------------------------------------------------------------- emojis
  if (options.cloneEmojis && sourceEmojis.length) {
    progress(38, 'cloning emojis');
    log(`cloning emojis (${sourceEmojis.length})…`);
    const cap = sourceEmojis.slice(0, 150);

    // download in parallel, create serially: the guild emoji bucket is a single
    // queue no matter how many requests get thrown at it
    const payloads = await mapLimit(cap, 5, async (emoji) => {
      try {
        const uri = await fetchAsDataUri(emojiUrl(emoji, 96));
        if (!uri) return null;
        const name =
          String(emoji.name ?? 'emoji').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32) || 'emoji';
        return { name, image: uri };
      } catch {
        return null;
      }
    });

    let index = 0;
    for (let i = 0; i < payloads.length; i++) {
      ensureAlive();
      const payload = payloads[i];
      if (!payload) {
        warn(`emoji ${cap[i].name} failed to download`);
      } else {
        try {
          await rest.post(`/guilds/${targetId}/emojis`, payload);
          summary.emojis++;
        } catch (error) {
          warn(`emoji ${cap[i].name} failed: ${describe(error)}`);
        }
      }
      index++;
      progress(38 + (index / Math.max(1, cap.length)) * 8, 'cloning emojis');
    }
    ok(`emojis cloned (${summary.emojis})`);
  }

  // ---------------------------------------------------------------- stickers
  if (options.cloneStickers) {
    progress(46, 'stickers');
    log('cloning stickers…');
    const stickers = await tolerate(
      'sticker list',
      () => rest.get(`/guilds/${sourceId}/stickers`),
      [],
    );
    const usable = (stickers ?? []).filter((sticker) => sticker.format_type !== 3);
    const STICKER_EXT = { 1: 'png', 2: 'apng', 4: 'gif' };
    for (const sticker of usable) {
      ensureAlive();
      const ext = STICKER_EXT[sticker.format_type] ?? 'png';
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/apng';
      try {
        const binary = await fetchBinary(
          `https://media.discordapp.net/stickers/${sticker.id}.${ext}?size=320`,
        );
        await rest.upload(
          `/guilds/${targetId}/stickers`,
          {
            name: sticker.name,
            description: sticker.description ? truncate(sticker.description, 100) : '',
            tags: sticker.tags || sticker.name.slice(0, 2),
          },
          { buffer: binary.buffer, contentType: mime, name: `sticker.${ext}` },
        );
        summary.stickers++;
      } catch (error) {
        warn(`sticker ${sticker.name} failed: ${describe(error)}`);
      }
    }
    if ((stickers ?? []).some((sticker) => sticker.format_type === 3)) {
      warn('Lottie stickers skipped — Discord will not take them back as images');
    }
    ok(`stickers cloned (${summary.stickers})`);
  }

  // ---------------------------------------------------------------- soundboard
  if (options.cloneSoundboard) {
    progress(47, 'soundboard');
    const board = await tolerate(
      'soundboard list',
      () => rest.get(`/guilds/${sourceId}/soundboard-sounds`),
      null,
    );
    const sounds = board?.items ?? [];
    for (const sound of sounds) {
      ensureAlive();
      try {
        const binary = await fetchBinary(
          `https://cdn.discordapp.com/soundboard-sounds/${sound.sound_id}`,
        );
        const uri = `data:${binary.contentType || 'audio/ogg'};base64,${binary.buffer.toString('base64')}`;
        await rest.post(`/guilds/${targetId}/soundboard-sounds`, {
          name: sound.name,
          sound: uri,
          volume: sound.volume ?? 1,
        });
        summary.soundboard++;
      } catch (error) {
        warn(`sound ${sound.name} failed: ${describe(error)}`);
      }
    }
    ok(`soundboard cloned (${summary.soundboard})`);
  }

  // ---------------------------------------------------------------- channels
  const channelMap = new Map();
  const channelMeta = new Map();
  if (options.cloneChannels || options.cloneCategories) {
    progress(48, 'cloning channels');
    log('cloning channels…');

    const categories = sourceChannels
      .filter((channel) => channel.type === CHANNEL.CATEGORY)
      .sort((a, b) => a.position - b.position);
    const nonCategories = sourceChannels.filter((channel) => channel.type !== CHANNEL.CATEGORY);

    if (options.cloneCategories) {
      for (const category of categories) {
        ensureAlive();
        const overwrites = mapOverwrites(category.permission_overwrites, roleMap, sourceId, targetId);
        try {
          const created = await rest.post(`/guilds/${targetId}/channels`, {
            name: category.name,
            type: CHANNEL.CATEGORY,
            position: category.position ?? 0,
            permission_overwrites: overwrites,
          });
          channelMap.set(category.id, created.id);
          channelMeta.set(category.id, {
            position: created.position ?? 0,
            parentId: created.parent_id ?? null,
          });
          summary.categories++;
        } catch (error) {
          warn(`category "${category.name}" failed: ${describe(error)}`);
        }
      }
    }

    const positionById = new Map(categories.map((category) => [category.id, category.position ?? 0]));
    const ordered = nonCategories.slice().sort((a, b) => {
      const ka = channelSortKey(a, positionById);
      const kb = channelSortKey(b, positionById);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });

    let index = 0;
    for (const channel of ordered) {
      ensureAlive();
      const parentId = options.cloneCategories ? channelMap.get(channel.parent_id) ?? null : null;
      const overwrites = mapOverwrites(channel.permission_overwrites, roleMap, sourceId, targetId);
      const payload = buildChannelPayload(channel, overwrites, parentId, targetGuild);
      try {
        const created = await rest.post(`/guilds/${targetId}/channels`, payload);
        channelMap.set(channel.id, created.id);
        channelMeta.set(channel.id, {
          position: created.position ?? 0,
          parentId: created.parent_id ?? null,
        });
        summary.channels++;
      } catch (error) {
        warn(`channel "${channel.name}" failed: ${describe(error)}`);
      }
      index++;
      progress(48 + (index / Math.max(1, ordered.length)) * 20, 'cloning channels');
    }

    // Discord usually honours the position sent at creation. Only patch the
    // channels that actually landed somewhere else, so a clean clone costs
    // zero extra requests here.
    const reposition = async (list, startPercent, span) => {
      const pending = [];
      for (const channel of list) {
        const targetChannelId = channelMap.get(channel.id);
        if (!targetChannelId) continue;
        const meta = channelMeta.get(channel.id);
        const parentId = options.cloneCategories ? channelMap.get(channel.parent_id) ?? null : null;
        if (
          !meta ||
          meta.position !== (channel.position ?? 0) ||
          (meta.parentId ?? null) !== (parentId ?? null)
        ) {
          pending.push({ id: targetChannelId, position: channel.position ?? 0 });
        }
      }
      if (!pending.length) return;

      // ascending order so each move lands against an already-settled layout
      pending.sort((a, b) => a.position - b.position);
      let i = 0;
      for (const item of pending) {
        ensureAlive();
        try {
          await rest.patch(`/channels/${item.id}`, { position: item.position });
        } catch {
          /* position drift is cosmetic */
        }
        i++;
        progress(startPercent + (i / Math.max(1, pending.length)) * span, 'positioning channels');
      }
    };

    await reposition(categories.filter((c) => channelMap.has(c.id)), 68, 2);
    for (const category of categories) {
      const children = ordered.filter((channel) => channel.parent_id === category.id);
      await reposition(children, 70, 0.2);
    }
    await reposition(
      ordered.filter((channel) => !channel.parent_id),
      70,
      1,
    );

    ok(`channels cloned (${summary.categories} categories, ${summary.channels} channels)`);
  }

  // ---------------------------------------------------------------- server settings
  progress(70, 'server settings');
  const guildPatch = {};
  if (options.cloneName && sourceGuild.name !== targetGuild.name) guildPatch.name = sourceGuild.name;
  if (options.cloneIcon) {
    const iconUri = await tolerate('icon fetch', () =>
      fetchAsDataUri(guildIconUrl(sourceGuild, 1024)),
    );
    if (iconUri) guildPatch.icon = iconUri;
  }
  if (options.cloneDescription) {
    guildPatch.description = sourceGuild.description ? truncate(sourceGuild.description, 300) : null;
  }

  if (options.cloneSettings) {
    if (sourceGuild.afk_channel_id) {
      guildPatch.afk_channel_id = channelMap.get(sourceGuild.afk_channel_id) ?? null;
    }
    guildPatch.afk_timeout = sourceGuild.afk_timeout ?? 300;
    if (sourceGuild.system_channel_id) {
      guildPatch.system_channel_id = channelMap.get(sourceGuild.system_channel_id) ?? null;
    }
    guildPatch.system_channel_flags = sourceGuild.system_channel_flags ?? 0;
    guildPatch.verification_level = sourceGuild.verification_level ?? 0;
    guildPatch.default_message_notifications = sourceGuild.default_message_notifications ?? 0;
    guildPatch.explicit_content_filter = sourceGuild.explicit_content_filter ?? 0;
    if (sourceGuild.preferred_locale) guildPatch.preferred_locale = sourceGuild.preferred_locale;

    // community-only fields only go in when the target already has the feature
    const targetFeatures = new Set(targetGuild.features ?? []);
    if (targetFeatures.has('COMMUNITY')) {
      if (sourceGuild.rules_channel_id) {
        guildPatch.rules_channel_id = channelMap.get(sourceGuild.rules_channel_id) ?? null;
      }
      if (sourceGuild.public_updates_channel_id) {
        guildPatch.public_updates_channel_id =
          channelMap.get(sourceGuild.public_updates_channel_id) ?? null;
      }
    }
    if (targetFeatures.has('BANNER') && sourceGuild.banner) {
      const banner = await tolerate('banner fetch', () =>
        fetchAsDataUri(
          `https://cdn.discordapp.com/banners/${sourceId}/${sourceGuild.banner}.png?size=1024`,
        ),
      );
      if (banner) guildPatch.banner = banner;
    }
    if (targetFeatures.has('INVITE_SPLASH') && sourceGuild.splash) {
      const splash = await tolerate('splash fetch', () =>
        fetchAsDataUri(
          `https://cdn.discordapp.com/splashes/${sourceId}/${sourceGuild.splash}.png?size=1024`,
        ),
      );
      if (splash) guildPatch.splash = splash;
    }
  }

  if (Object.keys(guildPatch).length) {
    try {
      await rest.patch(`/guilds/${targetId}`, guildPatch);
      ok(`server settings applied (${Object.keys(guildPatch).join(', ')})`);
    } catch (error) {
      if (error instanceof RateLimitError) {
        warn(
          `server settings skipped — Discord caps server edits, reset in ${humanWait(error.retryAfter)}`,
        );
      } else if (error.status === 400 && (guildPatch.banner || guildPatch.splash)) {
        const soft = { ...guildPatch };
        delete soft.banner;
        delete soft.splash;
        try {
          await rest.patch(`/guilds/${targetId}`, soft);
          warn('banner/splash rejected by Discord, the rest of the settings applied');
        } catch (retryError) {
          warn(`server settings failed: ${describe(retryError)}`);
        }
      } else {
        warn(`server settings failed: ${describe(error)}`);
      }
    }
  } else {
    log('no server-level settings selected');
  }

  // ---------------------------------------------------------------- welcome screen
  if (options.cloneWelcome) {
    progress(71, 'welcome screen');
    const screen = await tolerate(
      'welcome screen',
      () => rest.get(`/guilds/${sourceId}/welcome-screen`),
      null,
    );
    const channels = (screen?.welcome_channels ?? [])
      .map((entry) => ({
        channel_id: channelMap.get(entry.channel_id),
        description: truncate(entry.description ?? '', 140),
        emoji_id: entry.emoji_id ?? null,
        emoji_name: entry.emoji_name ?? null,
      }))
      .filter((entry) => entry.channel_id);

    if (channels.length) {
      try {
        await rest.patch(`/guilds/${targetId}/welcome-screen`, {
          description: screen.description ? truncate(screen.description, 140) : null,
          welcome_channels: channels,
        });
        summary.welcome = true;
        ok('welcome screen cloned');
      } catch (error) {
        warn(`welcome screen failed: ${describe(error)}`);
      }
    } else {
      log('no welcome screen in source — skipped');
    }
  }

  // ---------------------------------------------------------------- webhooks
  if (options.cloneWebhooks) {
    progress(71, 'webhooks');
    const hooks = await tolerate(
      'webhook list',
      () => rest.get(`/guilds/${sourceId}/webhooks`),
      [],
    );
    for (const hook of hooks ?? []) {
      ensureAlive();
      if (hook.type !== 1) continue;
      const targetChannelId = channelMap.get(hook.channel_id);
      if (!targetChannelId) continue;
      try {
        const payload = { name: hook.name || 'webhook' };
        if (hook.avatar) {
          const avatar = await tolerate('webhook avatar', () =>
            fetchAsDataUri(
              `https://cdn.discordapp.com/avatars/${hook.id}/${hook.avatar}.png?size=128`,
            ),
          );
          if (avatar) payload.avatar = avatar;
        }
        await rest.post(`/channels/${targetChannelId}/webhooks`, payload);
        summary.webhooks++;
      } catch (error) {
        warn(`webhook ${hook.name} failed: ${describe(error)}`);
      }
    }
    ok(`webhooks cloned (${summary.webhooks})`);
  }

  // ---------------------------------------------------------------- invites
  if (options.cloneInvites) {
    progress(71, 'invites');
    const invites = await tolerate(
      'invite list',
      () => rest.get(`/guilds/${sourceId}/invites`),
      [],
    );
    for (const invite of invites ?? []) {
      ensureAlive();
      if (!invite.channel?.id) continue;
      if (invite.code === sourceGuild.vanity_url_code) continue;
      const targetChannelId = channelMap.get(invite.channel.id);
      if (!targetChannelId) continue;
      try {
        await rest.post(`/channels/${targetChannelId}/invites`, {
          max_age: invite.max_age ?? 86400,
          max_uses: invite.max_uses ?? 0,
          temporary: Boolean(invite.temporary),
          unique: false,
        });
        summary.invites++;
      } catch (error) {
        warn(`invite in #${invite.channel.name ?? invite.channel.id} failed: ${describe(error)}`);
      }
    }
    ok(`invites cloned (${summary.invites})`);
  }

  // ---------------------------------------------------------------- scheduled events
  if (options.cloneEvents) {
    progress(71, 'scheduled events');
    const events = await tolerate(
      'event list',
      () => rest.get(`/guilds/${sourceId}/scheduled-events?with_user_count=true`),
      [],
    );
    for (const event of events ?? []) {
      ensureAlive();
      if (event.status === 'completed' || event.status === 'canceled') continue;
      const payload = {
        name: event.name,
        description: event.description ?? '',
        privacy_level: event.privacy_level ?? 2,
        scheduled_start_time: event.scheduled_start_time,
        entity_type: event.entity_type,
        entity_metadata: {},
      };
      if (event.entity_type === 3) {
        payload.entity_metadata.location = event.entity_metadata?.location || 'Discord';
      } else {
        const targetChannelId = channelMap.get(event.channel_id);
        if (!targetChannelId) continue;
        payload.entity_metadata.channel_id = targetChannelId;
      }
      if (event.scheduled_end_time) payload.scheduled_end_time = event.scheduled_end_time;
      if (event.image) {
        const image = await tolerate('event image', () =>
          fetchAsDataUri(
            `https://cdn.discordapp.com/guild-events/${event.id}/${event.image}.png?size=1024`,
          ),
        );
        if (image) payload.image = image;
      }
      try {
        await rest.post(`/guilds/${targetId}/scheduled-events`, payload);
        summary.events++;
      } catch (error) {
        warn(`event "${event.name}" failed: ${describe(error)}`);
      }
    }
    ok(`scheduled events cloned (${summary.events})`);
  }

  // ---------------------------------------------------------------- automod
  if (options.cloneAutomod) {
    progress(71, 'automod');
    const rules = await tolerate(
      'automod list',
      () => rest.get(`/guilds/${sourceId}/auto-moderation/rules`),
      [],
    );
    for (const rule of rules ?? []) {
      ensureAlive();
      const actions = (rule.actions ?? [])
        .map((action) => {
          const metadata = { ...(action.metadata ?? {}) };
          if (metadata.channel_id) {
            const mapped = channelMap.get(metadata.channel_id);
            if (mapped) metadata.channel_id = mapped;
            else delete metadata.channel_id;
          }
          return { type: action.type, metadata };
        })
        .filter((action) => action.type);

      if (!actions.length) continue;

      try {
        await rest.post(`/guilds/${targetId}/auto-moderation/rules`, {
          name: rule.name,
          event_type: rule.event_type,
          trigger_type: rule.trigger_type,
          trigger_metadata: rule.trigger_metadata ?? {},
          actions,
          enabled: Boolean(rule.enabled),
          exempt_roles: (rule.exempt_roles ?? []).map((id) => roleMap.get(id)).filter(Boolean),
          exempt_channels: (rule.exempt_channels ?? [])
            .map((id) => channelMap.get(id))
            .filter(Boolean),
        });
        summary.automod++;
      } catch (error) {
        warn(`automod rule "${rule.name}" failed: ${describe(error)}`);
      }
    }
    ok(`automod rules cloned (${summary.automod})`);
  }

  // ---------------------------------------------------------------- onboarding
  if (options.cloneOnboarding) {
    progress(72, 'onboarding');
    log('cloning onboarding…');
    const sourceOnboarding = await tolerate('onboarding read', () =>
      rest.get(`/guilds/${sourceId}/onboarding`),
    );
    if (sourceOnboarding?.prompts?.length) {
      const prompts = sourceOnboarding.prompts.map((prompt) => ({
        id: snowflake(),
        title: truncate(prompt.title ?? 'Prompt', 100),
        single_select: Boolean(prompt.single_select),
        required: Boolean(prompt.required),
        in_onboarding: prompt.in_onboarding !== false,
        options: (prompt.options ?? [])
          .map((option) => ({
            id: snowflake(),
            title: truncate(option.title ?? 'Option', 100),
            description: truncate(option.description ?? '', 100),
            channel_ids: (option.channel_ids ?? []).map((id) => channelMap.get(id)).filter(Boolean),
            role_ids: (option.role_ids ?? []).map((id) => roleMap.get(id)).filter(Boolean),
            emoji_id: option.emoji_id ?? null,
            emoji_name: option.emoji_name ?? null,
            emoji_animated: Boolean(option.emoji_animated),
          }))
          .filter((option) => option.channel_ids.length || option.role_ids.length || option.title),
      }));

      const defaultChannels = (sourceOnboarding.default_channel_ids ?? [])
        .map((id) => channelMap.get(id))
        .filter(Boolean);

      const usable = prompts.filter((prompt) => prompt.options.length > 0);
      if (!usable.length || !defaultChannels.length) {
        warn('onboarding skipped — no usable prompts/channels mapped');
      } else {
        try {
          await rest.put(`/guilds/${targetId}/onboarding`, {
            prompts: usable,
            default_channel_ids: defaultChannels,
            enabled: Boolean(sourceOnboarding.enabled),
            mode: sourceOnboarding.mode ?? 'onboarding',
          });
          summary.onboarding = true;
          ok('onboarding cloned');
        } catch (error) {
          warn(
            `onboarding failed: ${error.message} — the target must have the COMMUNITY feature enabled`,
          );
        }
      }
    } else {
      log('no onboarding in source — skipped');
    }
  }

  // ---------------------------------------------------------------- bans
  if (options.cloneBans) {
    progress(73, 'bans');
    log('re-applying bans…');
    let after = null;
    for (;;) {
      ensureAlive();
      const page = await tolerate(
        'ban list',
        () => rest.get(`/guilds/${sourceId}/bans?limit=1000${after ? `&after=${after}` : ''}`),
        [],
      );
      if (!page?.length) break;
      for (const ban of page) {
        ensureAlive();
        try {
          await rest.put(`/guilds/${targetId}/bans/${ban.user.id}`, {
            delete_message_seconds: 0,
          });
          summary.bans++;
        } catch (error) {
          warn(`ban ${ban.user.username ?? ban.user.id} failed: ${describe(error)}`);
        }
      }
      after = page[page.length - 1].user.id;
      if (page.length < 1000) break;
    }
    ok(`bans cloned (${summary.bans})`);
  }

  // ---------------------------------------------------------------- messages
  if (options.cloneMessages) {
    const requested = new Set(options.messageChannels ?? []);
    const targets = sourceChannels.filter(
      (channel) =>
        requested.has(channel.id) &&
        MESSAGE_CHANNEL_TYPES.has(channel.type) &&
        channelMap.has(channel.id),
    );

    if (!targets.length) {
      warn('message cloning selected but no eligible channels mapped');
    } else {
      progress(74, 'cloning messages');
      const limit = clampNumber(options.messageLimit, 1, 2000, 50);
      const webhookCount = clampNumber(options.webhookCount, 1, 5, 3);
      const parallelChannels = clampNumber(options.parallelChannels, 1, 6, 3);
      const uploadCap = maxUploadBytes(targetGuild);
      log(
        `messages: ${targets.length} channel(s), ${limit} each, ${parallelChannels} channel(s) at a time`,
      );

      let doneChannels = 0;

      const cloneChannel = async (sourceChannel) => {
        const targetChannelId = channelMap.get(sourceChannel.id);
        log(`→ #${sourceChannel.name}`);

        const created = await Promise.all(
          Array.from({ length: webhookCount }, (_, i) =>
            rest
              .post(`/channels/${targetChannelId}/webhooks`, { name: `axcloner-${i + 1}` })
              .then((hook) => ({ id: hook.id, token: hook.token, dead: false }))
              .catch((error) => {
                warn(`webhook create failed in #${sourceChannel.name}: ${describe(error)}`);
                return null;
              }),
          ),
        );
        const webhooks = created.filter(Boolean);

        if (!webhooks.length) {
          fail(`no webhook in #${sourceChannel.name} — skipping messages`);
          return;
        }

        // rotate across hooks so a single throttled webhook cannot stop the channel
        let cursor = 0;
        const nextHook = () => {
          const usable = webhooks.filter((hook) => !hook.dead);
          if (!usable.length) return null;
          return usable[cursor++ % usable.length];
        };
        const send = async (payload, files, wait = false) => {
          for (let attempt = 0; attempt < webhooks.length; attempt++) {
            const hook = nextHook();
            if (!hook) return { ok: false, data: null };
            try {
              const data = await rest.executeWebhook(hook.id, hook.token, payload, files, { wait });
              return { ok: true, data };
            } catch (error) {
              if (error instanceof RateLimitError) {
                hook.dead = true;
                const left = webhooks.filter((h) => !h.dead).length;
                warn(
                  `webhook throttled for ${humanWait(error.retryAfter)} in #${sourceChannel.name} — ${left} left`,
                );
                continue;
              }
              warn(`message send failed in #${sourceChannel.name}: ${describe(error)}`);
              return { ok: false, data: null };
            }
          }
          return { ok: false, data: null };
        };

        // Fetch history, newest → oldest, capped at the limit.
        const collected = [];
        let before = null;
        while (collected.length < limit) {
          ensureAlive();
          const batchSize = Math.min(100, limit - collected.length);
          const query = `/channels/${sourceChannel.id}/messages?limit=${batchSize}${
            before ? `&before=${before}` : ''
          }`;
          let batch;
          try {
            batch = await rest.get(query);
          } catch (error) {
            warn(`history read failed in #${sourceChannel.name}: ${describe(error)}`);
            break;
          }
          if (!Array.isArray(batch) || batch.length === 0) break;
          collected.push(...batch);
          before = batch[batch.length - 1].id;
          if (batch.length < batchSize) break;
        }
        collected.reverse();

        // Attachments download while the messages ahead of them are still sending.
        const prepare = async (message) => {
          const attachments = message.attachments ?? [];
          const results = await Promise.all(
            attachments.map(async (attachment) => {
              try {
                if (attachment.size && attachment.size > uploadCap) {
                  return { link: attachment.url };
                }
                const binary = await fetchBinary(attachment.url);
                return {
                  file: {
                    buffer: binary.buffer,
                    contentType:
                      binary.contentType || attachment.content_type || 'application/octet-stream',
                    name: attachment.filename || 'file',
                  },
                };
              } catch {
                return { link: attachment.url };
              }
            }),
          );
          const files = [];
          const links = [];
          for (const result of results) {
            if (result.file) files.push(result.file);
            else if (result.link) links.push(result.link);
          }
          return { files, links };
        };

        const prefetched = new Map();
        const prefetch = (message) => {
          if (!prefetched.has(message.id)) {
            prefetched.set(
              message.id,
              prepare(message).catch(() => ({ files: [], links: [] })),
            );
          }
          return prefetched.get(message.id);
        };

        const prefetchWindow = 6;
        for (const message of collected.slice(0, prefetchWindow)) prefetch(message);

        for (let index = 0; index < collected.length; index++) {
          ensureAlive();
          const message = collected[index];
          if (collected[index + prefetchWindow]) prefetch(collected[index + prefetchWindow]);

          if (!webhooks.some((hook) => !hook.dead)) {
            warn(`all webhooks throttled — stopping #${sourceChannel.name}`);
            break;
          }
          if (![0, 19, 20, 21].includes(message.type)) {
            prefetched.delete(message.id);
            continue;
          }

          const { files, links } = await prefetch(message);
          prefetched.delete(message.id);

          const payload = buildWebhookPayload(message);
          if (links.length) {
            payload.content = [payload.content, ...links].filter(Boolean).join('\n');
          }
          if (!payload.content && !payload.embeds?.length && !files.length) continue;

          const chunks = payload.content ? chunkString(payload.content, 2000) : [null];
          let delivered = false;
          for (let i = 0; i < chunks.length; i++) {
            ensureAlive();
            const chunkPayload = { ...payload };
            if (chunks[i] === null) delete chunkPayload.content;
            else chunkPayload.content = chunks[i];
            const pinThis = Boolean(options.clonePins) && message.pinned && i === 0;
            const result = await send(chunkPayload, i === 0 ? files : [], pinThis);
            if (result.ok) {
              delivered = true;
              if (pinThis && result.data?.id) {
                try {
                  await rest.put(`/channels/${targetChannelId}/pins/${result.data.id}`);
                  summary.pins++;
                } catch {
                  /* a pin that did not land is not worth a warning */
                }
              }
            }
          }
          if (delivered) summary.messages++;
        }

        if (options.deleteWebhooks !== false) {
          await Promise.all(
            webhooks.map((hook) =>
              tolerate('webhook delete', () =>
                rest.delete(`/webhooks/${hook.id}/${hook.token}`, { auth: false }),
              ),
            ),
          );
        }

        ok(`#${sourceChannel.name} — ${collected.length} messages processed`);
      };

      await mapLimit(targets, parallelChannels, async (sourceChannel) => {
        try {
          await cloneChannel(sourceChannel);
        } catch (error) {
          if (error instanceof AbortedError) throw error;
          fail(`#${sourceChannel.name}: ${describe(error)}`);
        }
        doneChannels += 1;
        progress(74 + (doneChannels / targets.length) * 25, 'cloning messages');
      });
    }
  }

  emit({
    type: 'stats',
    requests: rest.stats.requests,
    rateLimits: rest.stats.hits429,
    waitMs: rest.stats.waitMs,
  });

  progress(100, 'done');
  return summary;
}
