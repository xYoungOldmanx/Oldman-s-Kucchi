// ============================================================================
// Oldman's Kucchi — X Engagement Raid Bot
// ----------------------------------------------------------------------------
// Twice a day (11:00 AM and 6:00 PM, Asia/Karachi):
//   1. SUBMISSION PHASE (30 min)   — raid role can post X/Twitter links.
//   2. LOCK                        — channel closes, links counted.
//   3. ENGAGEMENT PHASE (1h or 2h) — participants must reply on X *and* react
//      with the tracked emoji to every other participant's post.
//   4. SOFT REMINDER               — defaulters get pinged, 1 hour to fix it.
//   5. FINAL WARNING               — still non-compliant users are escalated:
//      no role -> Warning 1 | Warning 1 -> Warning 2 | Warning 2 -> 7d timeout.
//
// IMPORTANT CAVEATS (read before relying on this in production):
//
// - Reply verification uses Nitter, a free unofficial mirror of X. Public
//   Nitter instances are frequently down, rate-limited, or blocked — this is
//   NOT a reliable substitute for the official X API. When a post's Nitter
//   page can't be fetched from any mirror, that post's REPLY check is skipped
//   (treated as "unverifiable", never as "defaulted"), so a dead mirror does
//   not get innocent members warned or timed out. The REACTION check uses
//   native Discord data and is always reliable.
// - Session state lives in memory. If the host restarts mid-session (Render's
//   free tier sleeps/redeploys), that session's timers and participant data
//   are lost. With the engagement + grace window now up to ~3 hours, that is
//   a meaningful exposure window.
// ============================================================================

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Options,
} = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// --- Channels ---
const MORNING_CHANNEL_ID = '1409772569556684851';
const EVENING_CHANNEL_ID = '1442484747191320678';
const DEFAULTERS_CHANNEL_ID = '1546519372250620074';

// --- Roles ---
const RAID_ROLE_ID = '1459120132235329536';
const WARNING_ROLE_1_ID = '1546519757887373372';
const WARNING_ROLE_2_ID = '1546519989509693483';

// --- Staff (full access to the defaulters channel) ---
const STAFF_USER_IDS = [
  '1035777352053035018', // Server owner
  '1337534067804995654', // Co-founder 1
  '1337547099448938649', // Co-founder 2
];

// --- Tracked emoji (the ONLY reaction allowed on participant posts) ---
const TRACKED_EMOJI_ID = '1494782724022603827';
const TRACKED_EMOJI_NAME = 'alya';
const TRACKED_EMOJI_TAG = `<a:${TRACKED_EMOJI_NAME}:${TRACKED_EMOJI_ID}>`;

// --- Other custom emojis used in message templates ---
const EMOJI_BACK = '<a:alya:1494783730122752142>';
const EMOJI_DEADLINE = '<a:alya:1494775877622435983>';
const EMOJI_HAPPY = '<a:alya:1494940138860711936>';

// --- Nitter (best-effort, see caveats above) ---
const NITTER_MIRRORS = ['https://nitter.net', 'https://nitter.poast.org'];
const NITTER_REQUEST_DELAY_MS = 1500; // pause between posts
const NITTER_TIMEOUT_MS = 8000; // per-request timeout

// --- Timers ---
const SUBMISSION_DURATION_MS = 30 * 60 * 1000; // 30 min link submission
const LINK_COUNT_THRESHOLD = 20;
const ENGAGEMENT_SHORT_MS = 60 * 60 * 1000; // 1 hour  (<=20 links)
const ENGAGEMENT_LONG_MS = 2 * 60 * 60 * 1000; // 2 hours (>20 links)
const REMINDER_GRACE_MS = 60 * 60 * 1000; // 1 hour after soft reminder
const WARNING_2_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7-day timeout

// --- Cron ---
const SESSION_1_CRON = '0 11 * * *'; // 11:00 AM
const SESSION_2_CRON = '0 18 * * *'; // 6:00 PM
const CRON_TIMEZONE = 'Asia/Karachi';

const TWITTER_LINK_REGEX =
  /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/i;

// ----------------------------------------------------------------------------
// In-memory state
// ----------------------------------------------------------------------------

const sessions = new Map(); // 'Morning' | 'Evening' -> session object
const activeTrackedMessages = new Map(); // messageId -> sessionLabel

const SESSION_CHANNEL_IDS = new Set([MORNING_CHANNEL_ID, EVENING_CHANNEL_ID]);

// ----------------------------------------------------------------------------
// Message templates
// ----------------------------------------------------------------------------

function buildMorningOpeningMessage() {
  return (
    `||<@&${RAID_ROLE_ID}>||\n` +
    `I'm Back Fams ${EMOJI_BACK}\n` +
    `The morning raid session is officially open. You have 30 minutes to submit your links in the channel. Any links posted after the deadline will not be considered ${EMOJI_DEADLINE}\n` +
    `If your links getting removed, kindly remove your tracking ID and try again ${TRACKED_EMOJI_TAG}\n` +
    `Wishing everyone happy engagement and great interactions ${EMOJI_HAPPY}`
  );
}

function buildEveningOpeningMessage() {
  return (
    `||<@&${RAID_ROLE_ID}>||\n` +
    `I'm Back Fams ${EMOJI_BACK}\n` +
    `The evening raid session is officially open. You have 30 minutes to submit your links in the channel. Any links posted after the deadline will not be considered ${EMOJI_DEADLINE}\n` +
    `If your links getting removed, kindly remove your tracking ID and try again ${TRACKED_EMOJI_TAG}\n` +
    `Wishing everyone happy engagement and great interactions ${EMOJI_HAPPY}`
  );
}

function buildClosingMessage(linkCount) {
  const withinWindow = linkCount > LINK_COUNT_THRESHOLD ? '2 Hours' : '1 Hour';
  return (
    `Alright, Fams, that's a wrap ${TRACKED_EMOJI_TAG}\n` +
    `The Raid Session Is Now Closed ${EMOJI_DEADLINE}\n` +
    `Total Links Submitted: ${linkCount} ${EMOJI_HAPPY}\n` +
    `Complete Your Engagements Within ${withinWindow} ${EMOJI_HAPPY}\n` +
    `If someone didn't complete engagement please report it in <#1414278885260005496>`
  );
}

function buildSoftReminderMessage(defaulterIds) {
  const mentions = defaulterIds.map((id) => `<@${id}>`).join(' ');
  return (
    `Hey Fams ${EMOJI_HAPPY}\n` +
    `Soft Reminder For You All ${TRACKED_EMOJI_TAG}\n` +
    `Complete Your Engagements Within 1 Hour ${EMOJI_DEADLINE}\n` +
    `Otherwise You Will Get Warning ${EMOJI_BACK}\n` +
    `After Warning 1 & Warning 2 You Will Get Timeout For 7 Days ${TRACKED_EMOJI_TAG}\n` +
    `${mentions}`
  );
}

/**
 * outcomes: Array<{ userId, label }> where label is
 * 'Warning 1' | 'Warning 2' | '7 Day Timeout'
 */
function buildFinalWarningMessage(sessionLabel, outcomes) {
  const lines = outcomes.map((o) => `<@${o.userId}> ( ${o.label} )`).join('\n');
  return (
    `Alright Fams ${EMOJI_HAPPY}\n` +
    `These Are The Defaulters Of ${sessionLabel} Engagement ${EMOJI_DEADLINE}\n` +
    `Below Mentioned Members Is Getting Warning ${TRACKED_EMOJI_TAG}\n` +
    `${lines}`
  );
}

// ----------------------------------------------------------------------------
// Discord client
// ----------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  makeCache: Options.cacheWithLimits({
    GuildEmojiManager: 0,
    GuildBanManager: 0,
    GuildStickerManager: 0,
    GuildScheduledEventManager: 0,
    ReactionManager: 0,
    PresenceManager: 0,
    ThreadManager: 0,
  }),
});

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTwitterLink(content) {
  const match = String(content || '').match(TWITTER_LINK_REGEX);
  if (!match) return null;
  return { handle: match[1], statusId: match[2] };
}

async function setRolePermissions(channel, roleId, { view, send }) {
  const overwrite = {};
  if (view !== undefined) overwrite.ViewChannel = view;
  if (send !== undefined) overwrite.SendMessages = send;
  await channel.permissionOverwrites.edit(roleId, overwrite);
}

// ----------------------------------------------------------------------------
// Nitter verification (best-effort — see caveats at top of file)
// ----------------------------------------------------------------------------

/**
 * Returns the Nitter page text for a tweet, trying each mirror in order.
 * Returns null if EVERY mirror fails — callers must treat null as
 * "unverifiable", never as "nobody replied".
 */
async function fetchNitterPage(handle, statusId) {
  for (const mirror of NITTER_MIRRORS) {
    const url = `${mirror}/${handle}/status/${statusId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NITTER_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RaidBot/1.0)' },
      });
      if (res.ok) return await res.text();
    } catch (err) {
      // Mirror down / timed out / blocked — try the next one.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Heuristic: does this handle appear on the fetched Nitter page? This is a
 * plain text scan (no HTML parser, to stay light on Render's free tier), so
 * it can false-positive if the handle appears elsewhere on the page.
 */
function pageMentionsHandle(pageText, handle) {
  const needle = handle.toLowerCase();
  const lower = pageText.toLowerCase();
  return lower.includes(`/${needle}`) || lower.includes(`@${needle}`);
}

// ----------------------------------------------------------------------------
// Reaction tracking + reaction policing
// ----------------------------------------------------------------------------

function trackReactions(session, messageId, userId) {
  let reactors = session.reactions.get(messageId);
  if (!reactors) {
    reactors = new Set();
    session.reactions.set(messageId, reactors);
  }
  reactors.add(userId);
}

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const channelId = reaction.message.channelId;
    if (!SESSION_CHANNEL_IDS.has(channelId)) return;

    const isTracked = reaction.emoji.id === TRACKED_EMOJI_ID;

    // --- Policing: remove any reaction that isn't the tracked emoji ---
    if (!isTracked) {
      await reaction.users.remove(user.id).catch((err) => {
        console.error('[reaction] Could not remove disallowed reaction:', err);
      });
      return;
    }

    // --- Tracking: record the reaction if it's on a participant's post ---
    const sessionLabel = activeTrackedMessages.get(reaction.message.id);
    if (!sessionLabel) return;
    const session = sessions.get(sessionLabel);
    if (!session) return;

    trackReactions(session, reaction.message.id, user.id);
  } catch (err) {
    console.error('[reaction] Failed to process reaction:', err);
  }
});

// ----------------------------------------------------------------------------
// Submission phase
// ----------------------------------------------------------------------------

function collectParticipantLinks(session) {
  return Array.from(session.participants.entries()).map(([userId, data]) => ({
    userId,
    ...data,
  }));
}

async function openRaidSession(channelId, sessionLabel, buildOpeningMessageFn) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`[openRaidSession] Could not resolve a text channel for ${sessionLabel}.`);
      return;
    }

    console.log(`[openRaidSession] (${sessionLabel}) Opening submission phase.`);

    // Submission phase: raid role can view + send.
    await setRolePermissions(channel, RAID_ROLE_ID, { view: true, send: true });

    const session = {
      channelId,
      stage: 'submission',
      participants: new Map(), // userId -> { handle, statusId, link, messageId }
      reactions: new Map(), // messageId -> Set<userId>
    };
    sessions.set(sessionLabel, session);

    await channel.send({
      content: buildOpeningMessageFn(),
      allowedMentions: { roles: [RAID_ROLE_ID] },
    });

    console.log(`[openRaidSession] (${sessionLabel}) Collecting links for 30 minutes.`);

    const collector = channel.createMessageCollector({ time: SUBMISSION_DURATION_MS });

    collector.on('collect', async (message) => {
      if (message.author.bot) return;

      const isRaidMember = Boolean(message.member && message.member.roles.cache.has(RAID_ROLE_ID));
      const hasHttpLink = /https?:\/\//i.test(message.content || '');

      // Bot reacts first so non-Nitro members can piggyback on the bot's
      // reaction to add the animated emoji themselves.
      if (isRaidMember && hasHttpLink) {
        await message.react(TRACKED_EMOJI_ID).catch((err) => {
          console.error('[collector] Failed to auto-react to link submission:', err);
        });
      }

      const parsed = parseTwitterLink(message.content);
      if (!parsed) return; // not a valid X/Twitter status link — don't register as a submission

      // Last submitted link wins if a user posts more than once.
      session.participants.set(message.author.id, {
        handle: parsed.handle,
        statusId: parsed.statusId,
        link: message.content.trim(),
        messageId: message.id,
      });

      // Register for reaction tracking immediately (not just after lock) so
      // reactions added during the submission phase still count.
      activeTrackedMessages.set(message.id, sessionLabel);
    });

    collector.on('end', () => {
      closeSubmissionChannel(channelId, sessionLabel).catch((err) => {
        console.error(`[closeSubmissionChannel] (${sessionLabel}) Unhandled error:`, err);
      });
    });
  } catch (err) {
    console.error(`[openRaidSession] (${sessionLabel}) Failed to open session:`, err);
  }
}

async function closeSubmissionChannel(channelId, sessionLabel) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    console.error(`[closeSubmissionChannel] (${sessionLabel}) Could not resolve channel.`);
    return;
  }

  const session = sessions.get(sessionLabel);
  if (!session) return;

  console.log(`[closeSubmissionChannel] (${sessionLabel}) Locking channel.`);
  session.stage = 'locked';

  // Locked: raid role keeps View, loses Send. They can still react.
  await setRolePermissions(channel, RAID_ROLE_ID, { view: true, send: false });

  const participants = collectParticipantLinks(session);
  const linkCount = participants.length;
  console.log(`[closeSubmissionChannel] (${sessionLabel}) ${linkCount} link(s) submitted.`);

  await channel.send({
    content: buildClosingMessage(linkCount),
    allowedMentions: { parse: [] },
  });

  // (Participant posts were already registered for reaction tracking the
  // moment they were collected, so non-Nitro reactions during submission
  // still count toward compliance.)

  if (linkCount === 0) {
    console.log(`[closeSubmissionChannel] (${sessionLabel}) No links submitted — ending session.`);
    endSession(sessionLabel);
    return;
  }

  startEngagementPhase(session, sessionLabel, linkCount);
}

// ----------------------------------------------------------------------------
// Engagement phase
// ----------------------------------------------------------------------------

function startEngagementPhase(session, sessionLabel, linkCount) {
  session.stage = 'engagement';
  const duration = linkCount > LINK_COUNT_THRESHOLD ? ENGAGEMENT_LONG_MS : ENGAGEMENT_SHORT_MS;

  console.log(
    `[startEngagementPhase] (${sessionLabel}) Engagement window: ${duration / 60000} minute(s).`
  );

  setTimeout(() => {
    runComplianceCheck(sessionLabel).catch((err) => {
      console.error(`[runComplianceCheck] (${sessionLabel}) Unhandled error:`, err);
    });
  }, duration);
}

/**
 * For every participant's post, checks whether each OTHER participant both
 * reacted (reliable) and replied on X (best-effort via Nitter).
 * Returns Map<userId, { missingReactions: string[], missingReplies: string[] }>
 * containing only members with at least one gap.
 */
async function checkEngagementCompliance(session) {
  const participants = collectParticipantLinks(session);
  const defaulters = new Map();

  const ensure = (userId) => {
    if (!defaulters.has(userId)) {
      defaulters.set(userId, { missingReactions: [], missingReplies: [] });
    }
    return defaulters.get(userId);
  };

  for (const poster of participants) {
    const reactors = session.reactions.get(poster.messageId) || new Set();
    const others = participants.filter((p) => p.userId !== poster.userId);

    // --- Reaction check (always reliable) ---
    for (const other of others) {
      if (!reactors.has(other.userId)) {
        ensure(other.userId).missingReactions.push(poster.handle);
      }
    }

    // --- Reply check (best-effort) ---
    const pageText = await fetchNitterPage(poster.handle, poster.statusId);
    if (pageText === null) {
      console.warn(
        `[compliance] Nitter unreachable for @${poster.handle} — skipping reply check for this post.`
      );
    } else {
      for (const other of others) {
        if (!pageMentionsHandle(pageText, other.handle)) {
          ensure(other.userId).missingReplies.push(poster.handle);
        }
      }
    }

    await sleep(NITTER_REQUEST_DELAY_MS);
  }

  return defaulters;
}

async function remindDefaulters(defaulterIds, channelId) {
  if (defaulterIds.length === 0) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    console.error('[remindDefaulters] Could not resolve defaulters channel.');
    return;
  }

  await channel.send({
    content: buildSoftReminderMessage(defaulterIds),
    allowedMentions: { users: defaulterIds },
  });
}

/**
 * Applies escalation per defaulter and returns the outcome labels for the
 * final warning message.
 *   no warning role -> Warning 1
 *   has Warning 1   -> remove Warning 1, add Warning 2
 *   has Warning 2   -> 7-day timeout (Warning 2 is kept, not removed)
 * Discord expires timeouts on its own after the duration, so no cleanup job
 * is needed to lift the 7-day timeout.
 */
async function assignWarningRoles(defaulterIds, guild) {
  const outcomes = [];

  for (const userId of defaulterIds) {
    try {
      const member = await guild.members.fetch(userId);
      const hasWarning1 = member.roles.cache.has(WARNING_ROLE_1_ID);
      const hasWarning2 = member.roles.cache.has(WARNING_ROLE_2_ID);

      if (hasWarning2) {
        await member
          .timeout(WARNING_2_TIMEOUT_MS, 'Repeated raid engagement violation')
          .catch((err) => console.error(`[warnings] Timeout failed for ${userId}:`, err));
        outcomes.push({ userId, label: '7 Day Timeout' });
      } else if (hasWarning1) {
        await member.roles.remove(WARNING_ROLE_1_ID).catch(() => {});
        await member.roles.add(WARNING_ROLE_2_ID);
        outcomes.push({ userId, label: 'Warning 2' });
      } else {
        await member.roles.add(WARNING_ROLE_1_ID);
        outcomes.push({ userId, label: 'Warning 1' });
      }
    } catch (err) {
      console.error(`[warnings] Failed to process defaulter ${userId}:`, err);
    }
  }

  return outcomes;
}

async function runComplianceCheck(sessionLabel) {
  const session = sessions.get(sessionLabel);
  if (!session) return;

  console.log(`[runComplianceCheck] (${sessionLabel}) First compliance check.`);
  const defaulters = await checkEngagementCompliance(session);
  const defaulterIds = Array.from(defaulters.keys());

  if (defaulterIds.length === 0) {
    console.log(`[runComplianceCheck] (${sessionLabel}) Everyone compliant.`);
    endSession(sessionLabel);
    return;
  }

  await remindDefaulters(defaulterIds, DEFAULTERS_CHANNEL_ID);

  setTimeout(() => {
    runFinalCheck(sessionLabel).catch((err) => {
      console.error(`[runFinalCheck] (${sessionLabel}) Unhandled error:`, err);
    });
  }, REMINDER_GRACE_MS);
}

async function runFinalCheck(sessionLabel) {
  const session = sessions.get(sessionLabel);
  if (!session) return;

  console.log(`[runFinalCheck] (${sessionLabel}) Final compliance check.`);
  const defaulters = await checkEngagementCompliance(session);
  const defaulterIds = Array.from(defaulters.keys());

  if (defaulterIds.length === 0) {
    console.log(`[runFinalCheck] (${sessionLabel}) Everyone caught up during the grace period.`);
    endSession(sessionLabel);
    return;
  }

  try {
    const channel = await client.channels.fetch(DEFAULTERS_CHANNEL_ID);
    const outcomes = await assignWarningRoles(defaulterIds, channel.guild);

    if (outcomes.length > 0) {
      await channel.send({
        content: buildFinalWarningMessage(sessionLabel, outcomes),
        allowedMentions: { users: outcomes.map((o) => o.userId) },
      });
    }
  } catch (err) {
    console.error(`[runFinalCheck] (${sessionLabel}) Failed to apply warnings:`, err);
  }

  endSession(sessionLabel);
}

function endSession(sessionLabel) {
  const session = sessions.get(sessionLabel);
  if (!session) return;

  for (const p of collectParticipantLinks(session)) {
    activeTrackedMessages.delete(p.messageId);
  }
  sessions.delete(sessionLabel);
  console.log(`[endSession] (${sessionLabel}) Session state cleared.`);
}

// ----------------------------------------------------------------------------
// Defaulters channel base permissions (set once at startup)
// ----------------------------------------------------------------------------

async function setupDefaultersChannelPermissions() {
  try {
    const channel = await client.channels.fetch(DEFAULTERS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error('[setup] Could not resolve defaulters channel.');
      return;
    }

    await setRolePermissions(channel, RAID_ROLE_ID, { view: true, send: false });

    for (const staffId of STAFF_USER_IDS) {
      await channel.permissionOverwrites
        .edit(staffId, {
          ViewChannel: true,
          SendMessages: true,
          ManageMessages: true,
        })
        .catch((err) => console.error(`[setup] Could not set access for ${staffId}:`, err));
    }

    console.log('[setup] Defaulters channel permissions configured.');
  } catch (err) {
    console.error('[setup] Failed to configure defaulters channel:', err);
  }
}

// ----------------------------------------------------------------------------
// Scheduling
// ----------------------------------------------------------------------------

function scheduleRaidSessions() {
  cron.schedule(
    SESSION_1_CRON,
    () => {
      console.log('[cron] Triggering Session 1 (11:00 AM Asia/Karachi) — Morning channel.');
      openRaidSession(MORNING_CHANNEL_ID, 'Morning', buildMorningOpeningMessage);
    },
    { timezone: CRON_TIMEZONE }
  );

  cron.schedule(
    SESSION_2_CRON,
    () => {
      console.log('[cron] Triggering Session 2 (6:00 PM Asia/Karachi) — Evening channel.');
      openRaidSession(EVENING_CHANNEL_ID, 'Evening', buildEveningOpeningMessage);
    },
    { timezone: CRON_TIMEZONE }
  );

  console.log(`[cron] Scheduled Morning 11:00 AM and Evening 6:00 PM (${CRON_TIMEZONE}).`);
}

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------

client.once('ready', () => {
  console.log(`[bot] Logged in as ${client.user.tag}.`);
  setupDefaultersChannelPermissions();
  scheduleRaidSessions();
});

if (!DISCORD_TOKEN) {
  console.error('[bot] DISCORD_TOKEN is not set in your .env file. Cannot start the bot.');
  process.exit(1);
}

console.log('[bot] Token found. Length:', DISCORD_TOKEN.length);
console.log('[bot] Attempting login...');

// ----------------------------------------------------------------------------
// Keep-alive HTTP server (for Render)
// ----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
  })
  .listen(PORT, () => {
    console.log(`[http] Keep-alive server running on port ${PORT}`);
  });

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[bot] Failed to log in. Check that DISCORD_TOKEN is correct.', err);
  process.exit(1);
});
