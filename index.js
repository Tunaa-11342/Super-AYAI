require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} = require("discord.js");

const RULES_PATH = path.join(__dirname, "rules.json");

function loadRulesFile() {
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const settings = parsed.settings ?? {};
  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  const mergedSettings = {
    replyModeDefault: settings.replyModeDefault ?? "reply",
    ignoreBots: settings.ignoreBots ?? true,
    ignoreDMs: settings.ignoreDMs ?? true,
    ignorePrefixes: Array.isArray(settings.ignorePrefixes)
      ? settings.ignorePrefixes
      : [],
    defaultCooldownMs: Number.isFinite(settings.defaultCooldownMs)
      ? settings.defaultCooldownMs
      : 3000,
    maxMessageLength: Number.isFinite(settings.maxMessageLength)
      ? settings.maxMessageLength
      : 4000,
    logMatches: !!settings.logMatches,
  };

  const normRules = rules
    .filter((r) => r && typeof r === "object")
    .flatMap((r) => {
      const baseId = String(r.id ?? cryptoRandomId());
      const enabled = r.enabled !== false;

      const base = {
        id: baseId,
        enabled,

        caseInsensitive: r.caseInsensitive !== false,

        minWords: Number.isFinite(r.minWords) ? r.minWords : undefined,
        maxWords: Number.isFinite(r.maxWords) ? r.maxWords : undefined,

        cooldownMs: Number.isFinite(r.cooldownMs)
          ? r.cooldownMs
          : mergedSettings.defaultCooldownMs,
        per: ["user", "channel", "guild"].includes(r.per) ? r.per : "user",

        where: normalizeWhere(r.where),
        actionBase: normalizeAction(
          { ...r.action, replies: [] },
          mergedSettings.replyModeDefault
        ),
      };

      // Nếu có entries -> bung ra nhiều rule con
      if (Array.isArray(r.entries) && r.entries.length > 0) {
        return r.entries
          .filter((e) => e && typeof e === "object")
          .map((e, idx) => {
            const triggers = Array.isArray(e.triggers)
              ? e.triggers.map(String).filter(Boolean)
              : [];
            const replies = Array.isArray(e.replies)
              ? e.replies.map(String).filter(Boolean)
              : [];

            return {
              ...base,
              id: `${baseId}:${idx}`, // id unique cho từng entry
              match: String(e.match ?? r.match ?? "wildcard"),
              triggers,
              action: {
                ...base.actionBase,
                replies,
              },
            };
          })
          .filter((x) => x.triggers.length > 0 && x.action.replies.length > 0);
      }

      const triggers = Array.isArray(r.triggers) ? r.triggers.map(String) : [];
      const replies = Array.isArray(r.action?.replies)
        ? r.action.replies.map(String).filter(Boolean)
        : [];

      return [
        {
          ...base,
          match: String(r.match ?? "wildcard"),
          triggers,
          action: {
            ...base.actionBase,
            replies,
          },
        },
      ].filter((x) => x.triggers.length > 0 && x.action.replies.length > 0);
    });

  return { settings: mergedSettings, rules: normRules };
}

function normalizeWhere(where) {
  const w = where && typeof where === "object" ? where : {};
  return {
    allowChannels: arrStr(w.allowChannels),
    denyChannels: arrStr(w.denyChannels),
    allowRoles: arrStr(w.allowRoles),
    denyRoles: arrStr(w.denyRoles),
    allowUsers: arrStr(w.allowUsers),
    denyUsers: arrStr(w.denyUsers),
  };
}

function normalizeAction(action, defaultMode) {
  const a = action && typeof action === "object" ? action : {};
  const replies = Array.isArray(a.replies)
    ? a.replies.map(String).filter(Boolean)
    : [];
  return {
    mode: ["reply", "send"].includes(a.mode) ? a.mode : defaultMode,
    mentionAuthor: a.mentionAuthor !== false,
    allowedMentions: normalizeAllowedMentions(a.allowedMentions),
    deleteTriggerMessage: !!a.deleteTriggerMessage,
    replies,
  };
}

function normalizeAllowedMentions(am) {
  const x = am && typeof am === "object" ? am : {};
  return {
    users: x.users !== false,
    roles: !!x.roles,
    everyone: !!x.everyone,
  };
}

function arrStr(v) {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

function cryptoRandomId() {
  return "r_" + Math.random().toString(36).slice(2, 10);
}

function wordCount(str) {
  const t = (str ?? "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function clampString(s, maxLen) {
  if (typeof s !== "string") return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegex(pattern, caseInsensitive) {
  const hasStar = pattern.includes("*");
  const escaped = escapeRegex(pattern).replace(/\\\*/g, ".*");
  const final = hasStar ? `^${escaped}$` : `^${escapeRegex(pattern)}$`;
  return new RegExp(final, caseInsensitive ? "i" : "");
}

function buildMatcher(rule) {
  const flags = rule.caseInsensitive ? "i" : "";
  const triggers = rule.triggers;

  if (rule.match === "regex") {
    const res = triggers.map((p) => new RegExp(p, flags));
    return (content) => res.some((re) => re.test(content));
  }

  if (rule.match === "wildcard") {
    const res = triggers.map((p) => wildcardToRegex(p, rule.caseInsensitive));
    return (content) => res.some((re) => re.test(content));
  }

  return (contentRaw) => {
    const content = rule.caseInsensitive
      ? contentRaw.toLowerCase()
      : contentRaw;
    return triggers.some((tRaw) => {
      const t = rule.caseInsensitive ? tRaw.toLowerCase() : tRaw;
      switch (rule.match) {
        case "exact":
          return content === t;
        case "contains":
          return content.includes(t);
        case "startsWith":
          return content.startsWith(t);
        case "endsWith":
          return content.endsWith(t);
        default:
          return wildcardToRegex(tRaw, rule.caseInsensitive).test(contentRaw);
      }
    });
  };
}

function hasAny(list) {
  return Array.isArray(list) && list.length > 0;
}

function passesWhere(where, message) {
  const channelId = message.channelId;
  const userId = message.author.id;

  if (where.denyChannels?.includes(channelId)) return false;
  if (where.denyUsers?.includes(userId)) return false;

  const member = message.member;
  const roleIds = member ? Array.from(member.roles.cache.keys()) : [];

  if (
    hasAny(where.denyRoles) &&
    roleIds.some((r) => where.denyRoles.includes(r))
  )
    return false;
  if (hasAny(where.allowChannels) && !where.allowChannels.includes(channelId))
    return false;
  if (hasAny(where.allowUsers) && !where.allowUsers.includes(userId))
    return false;
  if (
    hasAny(where.allowRoles) &&
    !roleIds.some((r) => where.allowRoles.includes(r))
  )
    return false;

  return true;
}

const cooldownMap = new Map();
function bucketIdFor(rule, message) {
  if (rule.per === "guild") return message.guildId ?? "dm";
  if (rule.per === "channel") return message.channelId;
  return message.author.id; // user
}
function canTrigger(rule, message) {
  const now = Date.now();
  const bucket = bucketIdFor(rule, message);
  const key = `${rule.per}:${rule.id}:${bucket}`;

  const prev = cooldownMap.get(key) || 0;
  if (rule.cooldownMs > 0 && now - prev < rule.cooldownMs) return false;

  cooldownMap.set(key, now);
  return true;
}

function renderTemplate(tpl, message) {
  const mention = `${message.author}`;
  return tpl
    .replaceAll("{mention}", mention)
    .replaceAll("{username}", message.author.username ?? "")
    .replaceAll("{userid}", message.author.id)
    .replaceAll("{content}", message.content ?? "");
}

function pickReply(replies) {
  if (!Array.isArray(replies) || replies.length === 0) return null;
  const i = Math.floor(Math.random() * replies.length);
  return replies[i];
}

let CONFIG = loadRulesFile();

fs.watchFile(RULES_PATH, { interval: 800 }, () => {
  try {
    CONFIG = loadRulesFile();
    console.log(`[rules] reloaded: ${CONFIG.rules.length} rule(s)`);
  } catch (e) {
    console.error("[rules] reload failed:", e.message);
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);
  console.log(`[READY] Process ID: ${process.pid}`);
  console.log(`[READY] In ${client.guilds.cache.size} guild(s)`);
});

client.on("messageCreate", async (message) => {
  const { settings, rules } = CONFIG;

  // ✅ CHECK NÀY PHẢI Ở ĐẦU TIÊN - trước tất cả logic khác
  if (settings.ignoreBots && message.author.bot) return;
  if (settings.ignoreDMs && !message.guild) return;

  const contentRaw = message.content ?? "";
  if (!contentRaw.trim()) return;
  if (settings.ignorePrefixes.some((p) => contentRaw.startsWith(p))) return;

  const content = clampString(contentRaw, settings.maxMessageLength);

  const wc = wordCount(content);

  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (Number.isFinite(rule.minWords) && wc < rule.minWords) continue;
    if (Number.isFinite(rule.maxWords) && wc > rule.maxWords) continue;

    if (!passesWhere(rule.where, message)) continue;

    const matcher = rule.__matcher || (rule.__matcher = buildMatcher(rule));
    if (!matcher(content)) continue;

    if (!canTrigger(rule, message)) continue;

    if (settings.logMatches) {
      console.log(
        `[match] rule=${rule.id} user=${message.author.id} channel=${message.channelId}`
      );
    }

    const me = message.guild?.members?.me;
    if (me) {
      const perms = message.channel?.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel)) return;
      if (rule.action.mode === "send" || rule.action.mode === "reply") {
        if (!perms?.has(PermissionFlagsBits.SendMessages)) return;
      }
    }

    const chosen = pickReply(rule.action.replies);
    if (!chosen) return;

    const text = renderTemplate(chosen, message);

    const allowedMentions = {
      parse: [],
      users: [],
      roles: [],
      repliedUser: rule.action.mentionAuthor,
    };

    if (rule.action.allowedMentions.everyone)
      allowedMentions.parse.push("everyone");
    if (rule.action.allowedMentions.roles) allowedMentions.parse.push("roles");
    if (rule.action.allowedMentions.users)
      allowedMentions.users.push(message.author.id);

    // ✅ Chỉ log khi thực sự gửi message
    if (settings.logMatches) {
      console.log("[send_attempt]", {
        pid: process.pid,
        rule: rule.id,
        msg: message.id,
      });
    }

    try {
      if (rule.action.mode === "send") {
        await message.channel.send({ content: text, allowedMentions });
      } else {
        await message.reply({ content: text, allowedMentions });
      }

      if (rule.action.deleteTriggerMessage) {
        const me2 = message.guild?.members?.me;
        const perms2 = me2 ? message.channel?.permissionsFor(me2) : null;
        if (perms2?.has(PermissionFlagsBits.ManageMessages)) {
          await message.delete().catch(() => {});
        }
      }
    } catch (e) {
      if (settings.logMatches) console.error("[send failed]", e.message);
    }

    break;
  }
});

client.login(process.env.DISCORD_TOKEN);
