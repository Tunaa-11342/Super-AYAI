require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

const RULES_PATH = path.join(__dirname, "rules.json");

// ==================== UTILITY FUNCTIONS ====================

function cryptoRandomId() {
  return "r_" + Math.random().toString(36).slice(2, 10);
}

function arrStr(v) {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

function wordCount(str) {
  const t = (str ?? "").trim();
  return t ? t.split(/\s+/).length : 0;
}

function clampString(s, maxLen) {
  if (typeof s !== "string") return "";
  return s.length <= maxLen ? s : s.slice(0, maxLen);
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

// ==================== NORMALIZATION FUNCTIONS ====================

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

function normalizeAllowedMentions(am) {
  const x = am && typeof am === "object" ? am : {};
  return {
    users: x.users !== false,
    roles: !!x.roles,
    everyone: !!x.everyone,
  };
}

function normalizeAction(action, defaultMode) {
  const a = action && typeof action === "object" ? action : {};
  return {
    mode: ["reply", "send"].includes(a.mode) ? a.mode : defaultMode,
    mentionAuthor: a.mentionAuthor !== false,
    allowedMentions: normalizeAllowedMentions(a.allowedMentions),
    deleteTriggerMessage: !!a.deleteTriggerMessage,
    replies: arrStr(a.replies),
  };
}

// ==================== RULES LOADER ====================

function loadRulesFile() {
  try {
    const raw = fs.readFileSync(RULES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const settings = parsed.settings ?? {};
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];

    const mergedSettings = {
      replyModeDefault: settings.replyModeDefault ?? "reply",
      ignoreBots: settings.ignoreBots !== false,
      ignoreDMs: settings.ignoreDMs !== false,
      ignorePrefixes: arrStr(settings.ignorePrefixes),
      ignoreUrls: settings.ignoreUrls !== false, // Thêm option này
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

        // Handle entries (multiple trigger-reply pairs)
        if (Array.isArray(r.entries) && r.entries.length > 0) {
          return r.entries
            .filter((e) => e && typeof e === "object")
            .map((e, idx) => {
              const triggers = arrStr(e.triggers);
              const replies = arrStr(e.replies);

              if (triggers.length === 0 || replies.length === 0) return null;

              return {
                ...base,
                id: `${baseId}:${idx}`,
                match: String(e.match ?? r.match ?? "wildcard"),
                triggers,
                action: { ...base.actionBase, replies },
              };
            })
            .filter(Boolean);
        }

        // Single rule
        const triggers = arrStr(r.triggers);
        const replies = arrStr(r.action?.replies);

        if (triggers.length === 0 || replies.length === 0) return [];

        return [
          {
            ...base,
            match: String(r.match ?? "wildcard"),
            triggers,
            action: { ...base.actionBase, replies },
          },
        ];
      });

    return { settings: mergedSettings, rules: normRules };
  } catch (error) {
    console.error("[FATAL] Failed to load rules.json:", error.message);
    process.exit(1);
  }
}

// ==================== MATCHER BUILDER ====================

function buildMatcher(rule) {
  const flags = rule.caseInsensitive ? "i" : "";

  if (rule.match === "regex") {
    try {
      const regexes = rule.triggers.map((p) => new RegExp(p, flags));
      return (content) => regexes.some((re) => re.test(content));
    } catch (e) {
      console.error(`[ERROR] Invalid regex in rule ${rule.id}:`, e.message);
      return () => false;
    }
  }

  if (rule.match === "wildcard") {
    const regexes = rule.triggers.map((p) =>
      wildcardToRegex(p, rule.caseInsensitive)
    );
    return (content) => regexes.some((re) => re.test(content));
  }

  return (contentRaw) => {
    const content = rule.caseInsensitive
      ? contentRaw.toLowerCase()
      : contentRaw;
    return rule.triggers.some((tRaw) => {
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
          return false;
      }
    });
  };
}

// ==================== WHERE CHECKER ====================

function passesWhere(where, message) {
  const channelId = message.channelId;
  const userId = message.author.id;

  if (where.denyChannels.includes(channelId)) return false;
  if (where.denyUsers.includes(userId)) return false;

  const member = message.member;
  const roleIds = member ? Array.from(member.roles.cache.keys()) : [];

  if (
    where.denyRoles.length > 0 &&
    roleIds.some((r) => where.denyRoles.includes(r))
  )
    return false;

  if (
    where.allowChannels.length > 0 &&
    !where.allowChannels.includes(channelId)
  )
    return false;

  if (where.allowUsers.length > 0 && !where.allowUsers.includes(userId))
    return false;

  if (
    where.allowRoles.length > 0 &&
    !roleIds.some((r) => where.allowRoles.includes(r))
  )
    return false;

  return true;
}

// ==================== COOLDOWN SYSTEM ====================

const cooldownMap = new Map();

function bucketIdFor(rule, message) {
  if (rule.per === "guild") return message.guildId ?? "dm";
  if (rule.per === "channel") return message.channelId;
  return message.author.id;
}

function canTrigger(rule, message) {
  if (rule.cooldownMs <= 0) return true;

  const now = Date.now();
  const bucket = bucketIdFor(rule, message);
  const key = `${rule.per}:${rule.id}:${bucket}`;

  const prev = cooldownMap.get(key) || 0;
  if (now - prev < rule.cooldownMs) return false;

  cooldownMap.set(key, now);
  return true;
}

// ==================== TEMPLATE RENDERER ====================

function renderTemplate(tpl, message) {
  return tpl
    .replace(/\{mention\}/g, `<@${message.author.id}>`)
    .replace(/\{username\}/g, message.author.username ?? "")
    .replace(/\{userid\}/g, message.author.id)
    .replace(/\{content\}/g, message.content ?? "");
}

function pickReply(replies) {
  if (!Array.isArray(replies) || replies.length === 0) return null;
  return replies[Math.floor(Math.random() * replies.length)];
}

// ==================== MAIN BOT ====================

let CONFIG = loadRulesFile();
console.log(`[INIT] Loaded ${CONFIG.rules.length} rule(s)`);

// Watch for rules file changes
fs.watchFile(RULES_PATH, { interval: 2000 }, () => {
  try {
    CONFIG = loadRulesFile();
    console.log(`[RELOAD] ${CONFIG.rules.length} rule(s) reloaded`);
  } catch (e) {
    console.error("[RELOAD ERROR]", e.message);
  }
});

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// Handle errors
client.on("error", (error) => {
  console.error("[CLIENT ERROR]", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("[UNHANDLED REJECTION]", error);
});

process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION]", error);
  process.exit(1);
});

// Ready event
client.once("ready", () => {
  console.log(`[READY] ${client.user.tag}`);
  console.log(`[READY] PID: ${process.pid}`);
  console.log(`[READY] Guilds: ${client.guilds.cache.size}`);
  console.log(`[READY] Rules: ${CONFIG.rules.length}`);
});

// Message handler
client.on("messageCreate", async (message) => {
  try {
    const { settings, rules } = CONFIG;

    // Early returns for ignored messages
    if (settings.ignoreBots && message.author.bot) return;
    if (settings.ignoreDMs && !message.guild) return;

    const contentRaw = message.content ?? "";
    if (!contentRaw.trim()) return;

    // Check ignored prefixes
    if (settings.ignorePrefixes.some((p) => contentRaw.startsWith(p))) return;

    // Skip messages with URLs if enabled
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    if (settings.ignoreUrls && urlRegex.test(contentRaw)) return;

    const content = clampString(contentRaw, settings.maxMessageLength);
    const wc = wordCount(content);

    // Process rules
    for (const rule of rules) {
      if (!rule.enabled) continue;

      // Word count filters
      if (rule.minWords !== undefined && wc < rule.minWords) continue;
      if (rule.maxWords !== undefined && wc > rule.maxWords) continue;

      // Where filters
      if (!passesWhere(rule.where, message)) continue;

      // Content matching
      const matcher = rule.__matcher || (rule.__matcher = buildMatcher(rule));
      if (!matcher(content)) continue;

      // Cooldown check
      if (!canTrigger(rule, message)) continue;

      // Log match
      if (settings.logMatches) {
        console.log(`[MATCH] ${rule.id} | ${message.author.tag}`);
      }

      // Pick and render reply
      const chosen = pickReply(rule.action.replies);
      if (!chosen) continue;

      const text = renderTemplate(chosen, message);

      // Build allowed mentions
      const allowedMentions = {
        parse: [],
        users: [],
        roles: [],
        repliedUser: rule.action.mentionAuthor,
      };

      if (rule.action.allowedMentions.everyone)
        allowedMentions.parse.push("everyone");
      if (rule.action.allowedMentions.roles)
        allowedMentions.parse.push("roles");
      if (rule.action.allowedMentions.users)
        allowedMentions.users.push(message.author.id);

      // Send reply
      try {
        if (rule.action.mode === "send") {
          await message.channel.send({ content: text, allowedMentions });
        } else {
          await message.reply({ content: text, allowedMentions });
        }

        // Delete trigger message if needed
        if (rule.action.deleteTriggerMessage && message.guild) {
          const me = message.guild.members.me;
          const perms = message.channel?.permissionsFor(me);
          if (perms?.has("ManageMessages")) {
            await message.delete().catch(() => {});
          }
        }

        if (settings.logMatches) {
          console.log(`[SENT] ${rule.id}`);
        }
      } catch (e) {
        console.error(`[SEND ERROR] ${rule.id}:`, e.message);
      }

      break; // Only trigger first matching rule
    }
  } catch (error) {
    console.error("[MESSAGE HANDLER ERROR]", error);
  }
});

// Create HTTP server for Render health check
const http = require("http");
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        bot: client.user?.tag || "not ready",
        guilds: client.guilds.cache.size,
      })
    );
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Discord Bot is running!");
  }
});

server.listen(PORT, () => {
  console.log(`[HTTP] Server listening on port ${PORT}`);
  
  // Self-ping every 14 minutes to prevent sleep (only on Render)
  if (process.env.RENDER) {
    const selfPingUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
      http.get(selfPingUrl, (res) => {
        console.log(`[SELF-PING] Status: ${res.statusCode}`);
      }).on('error', (err) => {
        console.error('[SELF-PING ERROR]', err.message);
      });
    }, 14 * 60 * 1000); // 14 minutes
    console.log('[SELF-PING] Enabled - will ping every 14 minutes');
  }
});

// Login with timeout
const loginTimeout = setTimeout(() => {
  console.error("[TIMEOUT] Failed to login within 30 seconds");
  process.exit(1);
}, 30000);

client
  .login(process.env.DISCORD_TOKEN)
  .then(() => {
    clearTimeout(loginTimeout);
  })
  .catch((error) => {
    console.error("[LOGIN ERROR]", error.message);
    process.exit(1);
  });
