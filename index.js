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
// The SAME warning ladder is used for two offences:
//   - "Didn't complete engagement"
//   - "Deleted the link" (deleting a submitted link during an active session)
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
// - Posts with comments disabled are detected from the Nitter page. For those
//   posts the reply requirement is skipped and only the emoji reaction is
//   required. Nitter (and X itself) does not expose WHO liked a post, so
//   likes cannot be verified.
// - Deleted-link warnings use the Guild Audit Log (needs the bot to have the
//   "View Audit Log" permission). Discord only writes an audit entry when
//   SOMEONE ELSE deletes a message, so "no entry" = the author deleted it.
//   If the audit log can't be read, the bot fails safe and does NOT warn.
// - Session state lives in memory. If the container restarts mid-session
//   (crash, redeploy, host maintenance), that session's timers and participant
//   data are lost. With the engagement + grace window now up to ~3 hours, that is
//   a meaningful exposure window.
// ============================================================================

require('dotenv').config();

// Printed the moment the process boots, before anything else can fail — if you
// see this line in the console, the container (re)started at that time.
console.log('[system] Bot restarted. Re-initializing cron jobs...');

const {
  Client,
  GatewayIntentBits,
  Partials,
  Options,
  escapeMarkdown,
  AuditLogEvent,
  PermissionFlagsBits,
  Events,
  DiscordjsErrorCodes,
} = require('discord.js');
const cron = require('node-cron');
const http = require('http');

// ----------------------------------------------------------------------------
// Global error handlers — log and keep running (never exit on a stray error)
// ----------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// --- Channels ---
const MORNING_CHANNEL_ID = '1409772569556684851';
const EVENING_CHANNEL_ID = '1442484747191320678';
const DEFAULTERS_CHANNEL_ID = '1546519372250620074';
const LOUNGE_CHANNEL_ID = '1409772686799798283'; // !GuideMeKucchi works ONLY here

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
const TRACKED_EMOJI_ID = '1558278278089936996';
const TRACKED_EMOJI_NAME = 'Kucchi';
const TRACKED_EMOJI_TAG = `<a:${TRACKED_EMOJI_NAME}:${TRACKED_EMOJI_ID}>`;
// Format used when the bot itself reacts (documented "name:id" form).
const TRACKED_EMOJI_REACTION = `${TRACKED_EMOJI_NAME}:${TRACKED_EMOJI_ID}`;

// --- Other custom emojis used in message templates ---
const EMOJI_BACK = '<a:Kucchi:1558273201027678208>';
const EMOJI_DEADLINE = '<a:Kucchi:1558279883107606558>';
const EMOJI_HAPPY = '<a:Kucchi:1558392258749800480>';
const EMOJI_EDIT_WARNING = '<a:Kucchi:1559516166144401488>';
const EMOJI_DOUBLE_CHECK = '<a:Kucchi:1558341990129598464>';

// --- Warning reasons (shown in announcements) ---
const REASON_ENGAGEMENT = "Didn't complete engagement";
const REASON_DELETED_LINK = 'Deleted the link';

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
const EARLY_SCAN_WINDOW_MS = 5 * 60 * 1000; // safety scan on session open

// --- Link deletion policy ---
// If true, deleting your link during the SUBMISSION phase is also warned.
// Set to false if you want people to be able to delete + repost while the
// submission window is still open (the link is still removed from the count).
const WARN_ON_DELETE_DURING_SUBMISSION = true;

// --- Deleted-link audit-log check ---
const AUDIT_INITIAL_WAIT_MS = 2000; // audit entries can lag the delete event
const AUDIT_RETRY_WAIT_MS = 1500; // one extra look before deciding "user deleted it"
const AUDIT_FRESH_ENTRY_MS = 10 * 60 * 1000; // how recent an unseen audit entry must be

// --- Cron ---
const SESSION_1_TIME = { hour: 11, minute: 0 }; // 11:00 AM
const SESSION_2_TIME = { hour: 18, minute: 0 }; // 6:00 PM
const CRON_TIMEZONE = 'Asia/Karachi';
// TIMING TOLERANCE: the cron tick may arrive up to 2 minutes (120000 ms) late
// (server lag) and the session still starts. A tick later than that (process
// asleep/stalled/restarted) means the session is SKIPPED and an error is logged.
const CRON_MAX_LATENESS_MS = 120000;
const MISSED_CHECK_INTERVAL_MS = 15 * 1000; // how often we look for a tick that never came
const MISSED_LOG_WINDOW_MS = 10 * 60 * 1000; // only report a miss for 10 min after the time

const GUIDE_COMMAND = '!GuideMeKucchi';

const TWITTER_LINK_REGEX =
  /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/i;

// ----------------------------------------------------------------------------
// In-memory state
// ----------------------------------------------------------------------------

// channelId -> session object. The global messageCreate / messageDelete
// handlers use this to decide whether a message belongs to an active session.
const sessions = new Map();

// messageId -> channelId (of the session that tracks that message)
const activeTrackedMessages = new Map();

const SESSION_CHANNEL_IDS = new Set([MORNING_CHANNEL_ID, EVENING_CHANNEL_ID]);

// Connection-watchdog coordination (see "Resilience" section)
let criticalOps = 0; // raid open/close operations currently in flight
let reconnecting = false; // watchdog is mid destroy()+login()
let loginInProgress = false; // a login attempt/retry loop is running
let lastGatewayEventAt = Date.now(); // last ready/disconnect/resume/reconnecting event
let shuttingDown = false;

/** Runs fn while marking a raid-critical operation as in flight (blocks forced reconnects). */
async function runCritical(fn) {
  criticalOps++;
  try {
    return await fn();
  } finally {
    criticalOps--;
  }
}

// 'YYYY-MM-DD|Label' keys of sessions already handled today (started OR declared missed)
const startedSessionKeys = new Set();

// Audit-log bookkeeping: entryId -> how many deletions on that entry we've already attributed
const auditClaimed = new Map();
let auditCache = null; // { at, promise } — shares one fetch between near-simultaneous deletes

// ----------------------------------------------------------------------------
// Emoji self-correction
// ----------------------------------------------------------------------------
// On startup the bot asks Discord whether each custom emoji used in the message
// templates is animated. A static-style tag (<:name:id>) on an animated emoji,
// or the reverse, makes Discord show plain ":name:" text. verifiedEmojiAnimated
// lets fixEmojiTags() rewrite the prefix correctly just before sending.

const EMOJI_TAG_REGEX = /<(a?):(\w{2,32}):(\d{17,20})>/g;
const verifiedEmojiAnimated = new Map(); // emojiId -> boolean

function fixEmojiTags(text) {
  return String(text).replace(EMOJI_TAG_REGEX, (full, _a, name, id) => {
    if (!verifiedEmojiAnimated.has(id)) return full;
    return `<${verifiedEmojiAnimated.get(id) ? 'a' : ''}:${name}:${id}>`;
  });
}

// ----------------------------------------------------------------------------
// Message templates
// ----------------------------------------------------------------------------

function buildMorningOpeningMessage() {
  return (
    `||<@&${RAID_ROLE_ID}>||\n` +
    `I'm Back Fams ${EMOJI_BACK}\n` +
    `The morning raid session is officially open. You have 30 minutes to submit your links in the channel. Any links posted after the deadline will not be considered ${EMOJI_DEADLINE}\n` +
    `If your link gets removed, kindly remove your tracking ID and try again ${TRACKED_EMOJI_TAG}\n` +
    `Don't delete your link, edit it instead to avoid a warning ${EMOJI_EDIT_WARNING}\n` +
    `Wishing everyone happy engagement and great interactions ${EMOJI_HAPPY}`
  );
}

function buildEveningOpeningMessage() {
  return (
    `||<@&${RAID_ROLE_ID}>||\n` +
    `I'm Back Fams ${EMOJI_BACK}\n` +
    `The evening raid session is officially open. You have 30 minutes to submit your links in the channel. Any links posted after the deadline will not be considered ${EMOJI_DEADLINE}\n` +
    `If your link gets removed, kindly remove your tracking ID and try again ${TRACKED_EMOJI_TAG}\n` +
    `Don't delete your link, edit it instead to avoid a warning ${EMOJI_EDIT_WARNING}\n` +
    `Wishing everyone happy engagement and great interactions ${EMOJI_HAPPY}`
  );
}

/**
 * withinWindow is passed in (rather than recomputed from linkCount) so that
 * when the message is edited after a link deletion, the stated engagement
 * window still matches the timer that is actually running.
 */
function buildClosingMessage(linkCount, withinWindow) {
  return (
    `Alright, Fams, that's a wrap ${TRACKED_EMOJI_TAG}\n` +
    `The Raid Session Is Now Closed ${EMOJI_DEADLINE}\n` +
    `Total Links Submitted: ${linkCount} ${EMOJI_HAPPY}\n` +
    `Double Check Your Engagement That Is (Like & Reply On X, React On Every Link Here ${EMOJI_DOUBLE_CHECK})\n` +
    `Complete Your Engagements Within ${withinWindow} ${EMOJI_HAPPY}\n` +
    `If someone didn't complete the engagement please report it in <#1414278885260005496>`
  );
}

/** Reply for the !GuideMeKucchi command. displayName is inserted as plain text. */
function buildGuideMessage(displayName) {
  return (
    `Yoo fella ${displayName} Welcome to the server <a:Kucchi:1558444604129280101>\n` +
    `\n` +
    `Explore OMC https://discord.com/channels/1343701000174698602/1459852660780961824 <a:Kucchi:1558278278089936996>\n` +
    `\n` +
    `Quick Guide <a:Kucchi:1558278278089936996>\n` +
    `\n` +
    `- First grab the **Engagement Role** <:Kucchi:1558270758101328023> from here https://discord.com/channels/1343701000174698602/1517589732748693534 <a:Kucchi:1558444641924419656>\n` +
    `- Then you'll see both **Morning & Evening** engagement channels <a:Kucchi:1558342054965420142>\n` +
    `- Then head over to https://discord.com/channels/1343701000174698602/1409772210465542236 to check **Rules & Timings** of engagement. The bot will reflect your local time zone <a:Kucchi:1558444438039302204>\n` +
    `- During raid time, the server bot will open & close the engagement channel automatically for 30 minutes for submitting the link, so send your link in the meantime. No late submissions allowed because the channel will be locked <a:Kucchi:1558341684587397231>\n` +
    `- For any queries tag my **Queen & Rockstar** from <@&1452929346162524335> and if they are unable to respond then tag <@&1414655205554786390> <a:Kucchi:1558342633246429235>\n` +
    `\n` +
    `Have a great time here fella <a:Kucchi:1558444560613384212>`
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
  const lines = outcomes
    .map((o) => `<@${o.userId}> ( ${o.label} ) - ${REASON_ENGAGEMENT}`)
    .join('\n');
  return (
    `Alright Fams ${EMOJI_HAPPY}\n` +
    `These Are The Defaulters Of ${sessionLabel} Engagement ${EMOJI_DEADLINE}\n` +
    `Below Mentioned Members Is Getting Warning ${TRACKED_EMOJI_TAG}\n` +
    `${lines}`
  );
}

function buildDeletedLinkMessage(userId, label) {
  return `⚠️ <@${userId}> has received ${label} for: ${REASON_DELETED_LINK}`;
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

function collectParticipantLinks(session) {
  return Array.from(session.participants.entries()).map(([userId, data]) => ({
    userId,
    ...data,
  }));
}

/** Schedules a timer that is automatically cleared when the session ends. */
function scheduleForSession(session, fn, ms) {
  const timer = setTimeout(fn, ms);
  session.timers.push(timer);
  return timer;
}

/** Removes a participant and everything tracked for their post. */
function removeParticipant(session, userId) {
  const entry = session.participants.get(userId);
  if (!entry) return null;
  session.participants.delete(userId);
  activeTrackedMessages.delete(entry.messageId);
  session.reactions.delete(entry.messageId);
  return entry;
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
 * plain text scan (no HTML parser, to stay light on small hosts), so
 * it can false-positive if the handle appears elsewhere on the page.
 */
function pageMentionsHandle(pageText, handle) {
  const needle = handle.toLowerCase();
  const lower = pageText.toLowerCase();
  return lower.includes(`/${needle}`) || lower.includes(`@${needle}`);
}

const COMMENTS_DISABLED_PHRASES = [
  'replies are disabled',
  'replies disabled',
  'comments are disabled',
  'comments disabled',
  'limited who can reply',
  'who can reply',
];

/**
 * Heuristic: were replies disabled / unavailable for this post?
 * Returns true if ANY of these hold:
 *   - the page contains an explicit "replies are disabled"-style notice
 *   - the page has no reply section (no <div class="replies">) at all
 *   - the reply section exists but contains no reply items
 *
 * When this returns true the reply requirement is skipped for the post.
 * Note this also fires when a post simply has zero replies or when Nitter
 * returns a stripped-down page — that errs on the lenient side (nobody gets
 * warned for a post whose replies we can't confirm).
 */
function detectCommentsDisabled(pageText) {
  const lower = pageText.toLowerCase();

  if (COMMENTS_DISABLED_PHRASES.some((phrase) => lower.includes(phrase))) {
    return true;
  }

  const repliesMarker = lower.search(/class="replies[\s"]/);
  if (repliesMarker === -1) return true; // reply section absent

  const repliesSection = lower.slice(repliesMarker);
  if (!repliesSection.includes('timeline-item')) return true; // container empty

  return false;
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
    // No reaction.fetch()/message.fetch() here: everything we need (emoji id,
    // message id, channel id) is present on partials, and fetching would cost
    // 1-2 REST calls per reaction once message caches are trimmed.

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
    const trackedChannelId = activeTrackedMessages.get(reaction.message.id);
    if (!trackedChannelId) return;
    const session = sessions.get(trackedChannelId);
    if (!session) return;

    trackReactions(session, reaction.message.id, user.id);
  } catch (err) {
    console.error('[reaction] Failed to process reaction:', err);
  }
});

// ----------------------------------------------------------------------------
// Submission phase
// ----------------------------------------------------------------------------

async function memberHasRaidRole(message) {
  try {
    const member =
      message.member || (await message.guild.members.fetch(message.author.id));
    return member.roles.cache.has(RAID_ROLE_ID);
  } catch (err) {
    console.error('[submission] Could not resolve member for role check:', err);
    return false;
  }
}

/**
 * Bot reacts first so non-Nitro members can piggyback on the bot's reaction
 * to add the animated emoji themselves. One retry on failure.
 */
async function reactToSubmission(message) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await message.react(TRACKED_EMOJI_REACTION);
      return true;
    } catch (err) {
      if (err && err.code === 10008) return false; // message already deleted
      console.error(`[submission] Auto-react failed (attempt ${attempt}):`, err);
      if (attempt < 2) await sleep(1000);
    }
  }
  return false;
}

/**
 * Handles one candidate submission message. Idempotent per message id, so it
 * is safe for both the live handler and the on-open safety scan to call it.
 */
async function processSubmission(session, message) {
  if (session.processedMessageIds.has(message.id)) return;
  session.processedMessageIds.add(message.id);

  const content = message.content || '';
  const hasHttpLink = /https?:\/\//i.test(content);

  const isRaidMember = await memberHasRaidRole(message);
  if (isRaidMember && hasHttpLink) {
    await reactToSubmission(message);
  }

  const parsed = parseTwitterLink(content);
  if (!parsed) return; // not a valid X/Twitter status link — don't register as a submission

  // The window may have closed while we were awaiting above.
  if (session.stage !== 'submission') return;

  // Last submitted link wins if a user posts more than once. Stop tracking
  // the superseded post so deleting it later isn't treated as a violation.
  const previous = session.participants.get(message.author.id);
  if (previous && previous.messageId !== message.id) {
    activeTrackedMessages.delete(previous.messageId);
    session.reactions.delete(previous.messageId);
  }

  session.participants.set(message.author.id, {
    handle: parsed.handle,
    statusId: parsed.statusId,
    link: content.trim(),
    messageId: message.id,
  });

  // Register for reaction tracking immediately (not just after lock) so
  // reactions added during the submission phase still count.
  activeTrackedMessages.set(message.id, session.channelId);
}

// Global handler: no per-session collector, so there is no registration gap
// between the opening announcement and the first submissions.
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild) return;
    if (!message.author || message.author.bot) return;

    // !GuideMeKucchi works ONLY in the Lounge channel; anywhere else it is ignored.
    if ((message.content || '').trim() === GUIDE_COMMAND) {
      if (message.channelId !== LOUNGE_CHANNEL_ID) return;

      const rawName =
        (message.member && message.member.displayName) ||
        message.author.globalName ||
        message.author.username;

      await message
        .reply({
          content: fixEmojiTags(buildGuideMessage(escapeMarkdown(rawName))),
          // The name is plain text, so nobody is pinged (the staff roles show but don't ping).
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch((err) => console.error('[guide] Failed to send guide message:', err));
      return;
    }

    const session = sessions.get(message.channelId);
    if (!session || session.stage !== 'submission') return;

    await processSubmission(session, message);
  } catch (err) {
    console.error('[messageCreate] Failed to process message:', err);
  }
});

/**
 * Safety net: on session open, sweep the last few minutes of the channel for
 * links that the live handler might not have seen.
 */
async function scanRecentSubmissions(session, channel) {
  try {
    const cutoff = Date.now() - EARLY_SCAN_WINDOW_MS;
    const fetched = await channel.messages.fetch({ limit: 50 });
    const recent = Array.from(fetched.values())
      .filter((m) => !m.author.bot && m.createdTimestamp >= cutoff)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp); // oldest first

    for (const m of recent) {
      if (session.stage !== 'submission') break;
      await processSubmission(session, m);
    }

    console.log(
      `[openRaidSession] (${session.label}) Safety scan checked ${recent.length} recent message(s).`
    );
  } catch (err) {
    console.error(`[openRaidSession] (${session.label}) Safety scan failed:`, err);
  }
}

async function openRaidSession(channelId, sessionLabel, buildOpeningMessageFn) {
  let session = null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`[openRaidSession] Could not resolve a text channel for ${sessionLabel}.`);
      return false;
    }

    console.log(`[openRaidSession] (${sessionLabel}) Opening submission phase.`);

    // A leftover session in this channel (shouldn't happen) is discarded.
    const existing = sessions.get(channelId);
    if (existing) {
      console.warn(`[openRaidSession] (${sessionLabel}) Discarding unfinished previous session.`);
      endSession(existing);
    }

    // Create + register the session BEFORE opening the channel so the global
    // handler is ready for the very first message.
    session = {
      label: sessionLabel,
      channelId,
      stage: 'submission',
      participants: new Map(), // userId -> { handle, statusId, link, messageId }
      reactions: new Map(), // messageId -> Set<userId>
      processedMessageIds: new Set(),
      deletionWarned: new Set(), // userIds already warned for deleting a link this session
      closingMessage: null,
      closeAt: null, // epoch ms when the submission window locks
      engagementLabel: null,
      timers: [],
    };
    sessions.set(channelId, session);

    // Submission phase: raid role can view + send.
    await setRolePermissions(channel, RAID_ROLE_ID, { view: true, send: true });

    await channel.send({
      content: fixEmojiTags(buildOpeningMessageFn()),
      allowedMentions: { roles: [RAID_ROLE_ID] },
    });

    console.log(`[openRaidSession] (${sessionLabel}) Collecting links for 30 minutes.`);

    // Catch anything posted in the last few minutes that we haven't handled.
    await scanRecentSubmissions(session, channel);

    const openedSession = session;
    openedSession.closeAt = Date.now() + SUBMISSION_DURATION_MS;
    scheduleForSession(
      openedSession,
      () => {
        runCritical(() => closeSubmissionChannel(openedSession)).catch((err) => {
          console.error(`[closeSubmissionChannel] (${sessionLabel}) Unhandled error:`, err);
        });
      },
      SUBMISSION_DURATION_MS
    );
    return true;
  } catch (err) {
    console.error(`[openRaidSession] (${sessionLabel}) Failed to open session:`, err);
    if (session && sessions.get(channelId) === session) endSession(session);
    return false;
  }
}

async function closeSubmissionChannel(session) {
  if (sessions.get(session.channelId) !== session) return;
  session.stage = 'locked';

  const channel = await client.channels.fetch(session.channelId);
  if (!channel || !channel.isTextBased()) {
    console.error(`[closeSubmissionChannel] (${session.label}) Could not resolve channel.`);
    return;
  }

  console.log(`[closeSubmissionChannel] (${session.label}) Locking channel.`);

  // Locked: raid role keeps View, loses Send. They can still react.
  await setRolePermissions(channel, RAID_ROLE_ID, { view: true, send: false });

  const linkCount = session.participants.size;
  session.engagementLabel = linkCount > LINK_COUNT_THRESHOLD ? '2 Hours' : '1 Hour';
  console.log(`[closeSubmissionChannel] (${session.label}) ${linkCount} link(s) submitted.`);

  session.closingMessage = await channel.send({
    content: fixEmojiTags(buildClosingMessage(linkCount, session.engagementLabel)),
    allowedMentions: { parse: [] },
  });

  // If a link was deleted while the closing message was being sent, fix the count.
  if (session.participants.size !== linkCount) {
    await refreshClosingMessage(session);
  }

  if (linkCount === 0) {
    console.log(`[closeSubmissionChannel] (${session.label}) No links submitted — ending session.`);
    endSession(session);
    return;
  }

  startEngagementPhase(session, linkCount);
}

/** Edits the already-posted closing message so the link total stays accurate. */
async function refreshClosingMessage(session) {
  if (!session.closingMessage) return;
  try {
    await session.closingMessage.edit({
      content: fixEmojiTags(
        buildClosingMessage(session.participants.size, session.engagementLabel)
      ),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    if (err && err.code === 10008) {
      // Closing message was deleted (e.g. by a purge bot) — nothing left to edit.
      session.closingMessage = null;
      return;
    }
    console.error(`[closingMessage] (${session.label}) Could not update link count:`, err);
  }
}

// ----------------------------------------------------------------------------
// Deleted links
// ----------------------------------------------------------------------------

/** Shares one audit-log request between deletions that happen at about the same time. */
function fetchRecentDeleteAuditEntries(guild) {
  if (auditCache && Date.now() - auditCache.at < 1000) return auditCache.promise;

  const promise = guild
    .fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 50 })
    .then((logs) => Array.from(logs.entries.values()));
  const cacheEntry = { at: Date.now(), promise };
  auditCache = cacheEntry;
  promise.catch(() => {
    if (auditCache === cacheEntry) auditCache = null;
  });
  return promise;
}

/**
 * Looks for an audit entry showing that SOMEONE ELSE deleted this author's
 * message in this channel. Discord aggregates repeat deletions into one entry
 * with a growing `extra.count`, so each entry's count is "claimed" one deletion
 * at a time (auditClaimed) — a second deletion by the same executor is still
 * recognised, and old unrelated entries are never matched.
 */
function claimAuditEntry(entries, authorId, channelId) {
  if (auditClaimed.size > 1000) auditClaimed.clear();

  for (const entry of entries) {
    if (!entry.target || entry.target.id !== authorId) continue;
    if (!entry.extra || !entry.extra.channel || entry.extra.channel.id !== channelId) continue;
    if (entry.executorId === authorId) continue; // defensive: author's own deletion

    const total = (entry.extra && entry.extra.count) || 1;
    const claimed = auditClaimed.get(entry.id);

    if (claimed === undefined) {
      // First time we see this entry: only trust it if it is recent.
      auditClaimed.set(entry.id, total);
      if (Date.now() - entry.createdTimestamp <= AUDIT_FRESH_ENTRY_MS) return entry;
      continue;
    }

    if (claimed < total) {
      auditClaimed.set(entry.id, claimed + 1);
      return entry;
    }
  }
  return null;
}

/**
 * Decides who deleted a tracked link.
 *   { type: 'other', executor } — a bot/moderator deleted it (audit entry found)
 *   { type: 'self' }            — no audit entry: the author deleted it themselves
 *   { type: 'unknown' }         — audit log unreadable: fail safe, do NOT warn
 */
async function findDeletionExecutor(guild, authorId, channelId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(attempt === 0 ? AUDIT_INITIAL_WAIT_MS : AUDIT_RETRY_WAIT_MS);

    let entries;
    try {
      entries = await fetchRecentDeleteAuditEntries(guild);
    } catch (err) {
      console.error(
        '[audit] Could not read the audit log (bot needs the "View Audit Log" permission). Not warning.',
        err && err.message
      );
      return { type: 'unknown' };
    }

    const hit = claimAuditEntry(entries, authorId, channelId);
    if (hit) return { type: 'other', executor: hit.executor || null };
  }
  return { type: 'self' };
}

/**
 * Called when a tracked message is deleted. Works from the message id alone,
 * because deleted messages are frequently uncached (no author available).
 * Warnings are only given when the AUTHOR deleted their own link.
 */
async function handleDeletedLink(messageId, { bulk = false } = {}) {
  const channelId = activeTrackedMessages.get(messageId);
  if (!channelId) return;

  const session = sessions.get(channelId);
  if (!session) {
    activeTrackedMessages.delete(messageId);
    return;
  }

  // Do all in-memory removal synchronously, before any await, so duplicate
  // delete events (e.g. single + bulk) can't process the same link twice.
  const entry = collectParticipantLinks(session).find((p) => p.messageId === messageId);
  activeTrackedMessages.delete(messageId);
  session.reactions.delete(messageId);
  if (!entry) return; // superseded/untracked post — nothing to penalize

  // The post is gone either way, so nobody can be expected to engage with it.
  removeParticipant(session, entry.userId);
  console.log(
    `[deletedLink] (${session.label}) Link from ${entry.userId} was deleted — removed from session.`
  );

  // Keep the posted total in sync (only exists once the session has closed).
  await refreshClosingMessage(session);

  // Bulk deletes are always a purge, never a member deleting their own link.
  if (bulk) {
    console.log(`[deletedLink] (${session.label}) Bulk delete (purge) — no warning for ${entry.userId}.`);
    return;
  }

  if (session.stage === 'submission' && !WARN_ON_DELETE_DURING_SUBMISSION) return;
  if (session.deletionWarned.has(entry.userId)) return;
  session.deletionWarned.add(entry.userId); // reserve now so concurrent events can't double-warn

  try {
    const defaultersChannel = await client.channels.fetch(DEFAULTERS_CHANNEL_ID);
    const verdict = await findDeletionExecutor(
      defaultersChannel.guild,
      entry.userId,
      session.channelId
    );

    if (verdict.type !== 'self') {
      session.deletionWarned.delete(entry.userId);
      if (verdict.type === 'other') {
        const who = verdict.executor
          ? `${verdict.executor.tag || verdict.executor.id}${verdict.executor.bot ? ' (bot)' : ''}`
          : 'another user/bot';
        console.log(
          `[deletedLink] (${session.label}) Deleted by ${who}, not by ${entry.userId} — no warning.`
        );
      }
      return;
    }

    const outcome = await applyWarning(defaultersChannel.guild, entry.userId);

    await defaultersChannel.send({
      content: buildDeletedLinkMessage(entry.userId, outcome.label),
      allowedMentions: { users: [entry.userId] },
    });
  } catch (err) {
    console.error(`[deletedLink] (${session.label}) Failed to warn ${entry.userId}:`, err);
  }
}

client.on('messageDelete', async (message) => {
  try {
    if (!SESSION_CHANNEL_IDS.has(message.channelId)) return;
    await handleDeletedLink(message.id);
  } catch (err) {
    console.error('[messageDelete] Failed to process deletion:', err);
  }
});

// Bulk deletes are purges: links are dropped from the session, nobody is warned.
client.on('messageDeleteBulk', async (messages) => {
  try {
    for (const id of messages.keys()) {
      await handleDeletedLink(id, { bulk: true });
    }
  } catch (err) {
    console.error('[messageDeleteBulk] Failed to process deletions:', err);
  }
});

// ----------------------------------------------------------------------------
// Engagement phase
// ----------------------------------------------------------------------------

function startEngagementPhase(session, linkCount) {
  session.stage = 'engagement';
  const duration = linkCount > LINK_COUNT_THRESHOLD ? ENGAGEMENT_LONG_MS : ENGAGEMENT_SHORT_MS;

  console.log(
    `[startEngagementPhase] (${session.label}) Engagement window: ${duration / 60000} minute(s).`
  );

  scheduleForSession(
    session,
    () => {
      runComplianceCheck(session).catch((err) => {
        console.error(`[runComplianceCheck] (${session.label}) Unhandled error:`, err);
      });
    },
    duration
  );
}

/**
 * Safety net for missed delete events (e.g. the bot was briefly offline):
 * any participant whose post no longer exists is dropped from the session
 * silently, so nobody is checked against a post that can't be engaged with.
 */
async function pruneDeletedPosts(session) {
  let channel;
  try {
    channel = await client.channels.fetch(session.channelId);
  } catch (err) {
    console.error(`[compliance] (${session.label}) Could not fetch channel to verify posts:`, err);
    return;
  }

  for (const p of collectParticipantLinks(session)) {
    try {
      await channel.messages.fetch(p.messageId, { force: true });
    } catch (err) {
      if (err && err.code === 10008) {
        console.warn(
          `[compliance] (${session.label}) Post ${p.messageId} no longer exists — removing ${p.userId} from checks.`
        );
        removeParticipant(session, p.userId);
      }
    }
  }
}

/**
 * For every participant's post, checks whether each OTHER participant both
 * reacted (reliable) and replied on X (best-effort via Nitter).
 * Posts with comments disabled only require the reaction.
 * Returns Map<userId, { missingReactions, missingReplies }> containing only
 * members with at least one gap. Entries are { handle, messageId }.
 */
async function checkEngagementCompliance(session) {
  await pruneDeletedPosts(session);

  const defaulters = new Map();
  if (session.participants.size < 2) return defaulters;

  const ensure = (userId) => {
    if (!defaulters.has(userId)) {
      defaulters.set(userId, { missingReactions: [], missingReplies: [] });
    }
    return defaulters.get(userId);
  };

  for (const poster of collectParticipantLinks(session)) {
    // Skip posts deleted while this (slow) check is running.
    const live = session.participants.get(poster.userId);
    if (!live || live.messageId !== poster.messageId) continue;

    const reactors = session.reactions.get(poster.messageId) || new Set();
    const others = collectParticipantLinks(session).filter((p) => p.userId !== poster.userId);

    // --- Reaction check (always reliable) ---
    for (const other of others) {
      if (!reactors.has(other.userId)) {
        ensure(other.userId).missingReactions.push({
          handle: poster.handle,
          messageId: poster.messageId,
        });
      }
    }

    // --- Reply check (best-effort) ---
    const pageText = await fetchNitterPage(poster.handle, poster.statusId);
    if (pageText === null) {
      console.warn(
        `[compliance] Nitter unreachable for @${poster.handle} — skipping reply check for this post.`
      );
    } else if (detectCommentsDisabled(pageText)) {
      console.log(
        `[compliance] Comments disabled/unavailable on @${poster.handle}'s post — reaction only.`
      );
    } else {
      for (const other of others) {
        if (!pageMentionsHandle(pageText, other.handle)) {
          ensure(other.userId).missingReplies.push({
            handle: poster.handle,
            messageId: poster.messageId,
          });
        }
      }
    }

    await sleep(NITTER_REQUEST_DELAY_MS);
  }

  // Final cleanup: if anyone deleted their link mid-check, drop them and drop
  // every gap that was recorded against their post.
  const stillPosted = new Set(collectParticipantLinks(session).map((p) => p.messageId));
  for (const [userId, record] of defaulters) {
    record.missingReactions = record.missingReactions.filter((e) => stillPosted.has(e.messageId));
    record.missingReplies = record.missingReplies.filter((e) => stillPosted.has(e.messageId));
    const stillParticipant = session.participants.has(userId);
    const hasGap = record.missingReactions.length > 0 || record.missingReplies.length > 0;
    if (!stillParticipant || !hasGap) defaulters.delete(userId);
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
    content: fixEmojiTags(buildSoftReminderMessage(defaulterIds)),
    allowedMentions: { users: defaulterIds },
  });
}

// ----------------------------------------------------------------------------
// Combined warning system (engagement failures AND deleted links)
// ----------------------------------------------------------------------------

/**
 * Applies one step of escalation to a single member and returns
 * { userId, label } where label is 'Warning 1' | 'Warning 2' | '7 Day Timeout'.
 *   no warning role -> Warning 1
 *   has Warning 1   -> remove Warning 1, add Warning 2
 *   has Warning 2   -> 7-day timeout (Warning 2 is kept, not removed)
 * Discord expires timeouts on its own after the duration, so no cleanup job
 * is needed to lift the 7-day timeout.
 *
 * Throws if the member can't be fetched or a role can't be added.
 */
async function applyWarning(guild, userId) {
  // force: true so we never escalate from a stale cached role list.
  const member = await guild.members.fetch({ user: userId, force: true });
  const hasWarning1 = member.roles.cache.has(WARNING_ROLE_1_ID);
  const hasWarning2 = member.roles.cache.has(WARNING_ROLE_2_ID);

  if (hasWarning2) {
    await member
      .timeout(WARNING_2_TIMEOUT_MS, 'Repeated raid violation')
      .catch((err) => console.error(`[warnings] Timeout failed for ${userId}:`, err));
    return { userId, label: '7 Day Timeout' };
  }

  if (hasWarning1) {
    await member.roles.remove(WARNING_ROLE_1_ID).catch(() => {});
    await member.roles.add(WARNING_ROLE_2_ID);
    return { userId, label: 'Warning 2' };
  }

  await member.roles.add(WARNING_ROLE_1_ID);
  return { userId, label: 'Warning 1' };
}

/** Escalates every engagement defaulter; returns outcomes for the announcement. */
async function assignWarningRoles(defaulterIds, guild) {
  const outcomes = [];

  for (const userId of defaulterIds) {
    try {
      outcomes.push(await applyWarning(guild, userId));
    } catch (err) {
      console.error(`[warnings] Failed to process defaulter ${userId}:`, err);
    }
  }

  return outcomes;
}

async function runComplianceCheck(session) {
  if (sessions.get(session.channelId) !== session) return;

  console.log(`[runComplianceCheck] (${session.label}) First compliance check.`);
  const defaulters = await checkEngagementCompliance(session);
  const defaulterIds = Array.from(defaulters.keys());

  if (defaulterIds.length === 0) {
    console.log(`[runComplianceCheck] (${session.label}) Everyone compliant.`);
    endSession(session);
    return;
  }

  await remindDefaulters(defaulterIds, DEFAULTERS_CHANNEL_ID);

  scheduleForSession(
    session,
    () => {
      runFinalCheck(session).catch((err) => {
        console.error(`[runFinalCheck] (${session.label}) Unhandled error:`, err);
      });
    },
    REMINDER_GRACE_MS
  );
}

async function runFinalCheck(session) {
  if (sessions.get(session.channelId) !== session) return;

  console.log(`[runFinalCheck] (${session.label}) Final compliance check.`);
  const defaulters = await checkEngagementCompliance(session);
  const defaulterIds = Array.from(defaulters.keys());

  if (defaulterIds.length === 0) {
    console.log(`[runFinalCheck] (${session.label}) Everyone caught up during the grace period.`);
    endSession(session);
    return;
  }

  try {
    const channel = await client.channels.fetch(DEFAULTERS_CHANNEL_ID);
    const outcomes = await assignWarningRoles(defaulterIds, channel.guild);

    if (outcomes.length > 0) {
      await channel.send({
        content: fixEmojiTags(buildFinalWarningMessage(session.label, outcomes)),
        allowedMentions: { users: outcomes.map((o) => o.userId) },
      });
    }
  } catch (err) {
    console.error(`[runFinalCheck] (${session.label}) Failed to apply warnings:`, err);
  }

  endSession(session);
}

function endSession(session) {
  for (const timer of session.timers) clearTimeout(timer);
  session.timers = [];

  // Clear every tracked message that points at this session's channel
  // (includes superseded posts that are no longer in participants).
  for (const [messageId, channelId] of activeTrackedMessages) {
    if (channelId === session.channelId) activeTrackedMessages.delete(messageId);
  }

  if (sessions.get(session.channelId) === session) {
    sessions.delete(session.channelId);
  }
  console.log(`[endSession] (${session.label}) Session state cleared.`);
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
      try {
        // permissionOverwrites.edit needs an actual User/GuildMember object
        // (or a Role) to resolve against — a raw ID string only resolves if
        // it happens to already be sitting in cache, which ours often won't
        // be since we run with minimal caching. Fetching the member first
        // guarantees a resolvable object every time.
        const member = await channel.guild.members.fetch(staffId);
        await channel.permissionOverwrites.edit(member, {
          ViewChannel: true,
          SendMessages: true,
          ManageMessages: true,
        });
        console.log(`[setup] Access granted to ${member.user.tag}`);
      } catch (err) {
        console.error(`[setup] Could not set access for ${staffId}:`, err.message);
      }
    }

    console.log('[setup] Defaulters channel permissions configured.');
  } catch (err) {
    console.error('[setup] Failed to configure defaulters channel:', err);
  }
}

// ----------------------------------------------------------------------------
// Scheduling (node-cron, strict exact-time starts — never late)
// ----------------------------------------------------------------------------

const SESSION_JOBS = [
  {
    label: 'Morning',
    channelId: MORNING_CHANNEL_ID,
    ...SESSION_1_TIME,
    buildMessage: buildMorningOpeningMessage,
  },
  {
    label: 'Evening',
    channelId: EVENING_CHANNEL_ID,
    ...SESSION_2_TIME,
    buildMessage: buildEveningOpeningMessage,
  },
];

/** Current date + time-of-day in the bot's timezone (Asia/Karachi). */
function getZonedNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CRON_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const pad = (n) => String(n).padStart(2, '0');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  return {
    dateKey: `${get('year')}-${pad(get('month'))}-${pad(get('day'))}`,
    minutesOfDay: hour * 60 + minute,
    // Milliseconds are timezone-independent (offsets are whole minutes).
    msOfDay: (hour * 3600 + minute * 60 + second) * 1000 + new Date().getMilliseconds(),
  };
}

function scheduledMs(job) {
  return (job.hour * 60 + job.minute) * 60 * 1000;
}

function formatJobTime(job) {
  return `${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')}`;
}

function describeTimeUntil(job) {
  const { minutesOfDay } = getZonedNow();
  const diff = (job.hour * 60 + job.minute - minutesOfDay + 1440) % 1440;
  if (diff === 0) return 'now';
  return `${Math.floor(diff / 60)}h ${diff % 60}m`;
}

function logMissedSession(job, lateMs) {
  console.error(
    `[cron] Missed exact time for ${job.label} Session! (scheduled ${formatJobTime(job)} ${CRON_TIMEZONE}, ${(lateMs / 1000).toFixed(1)}s late) — NOT starting it late.`
  );
}

/**
 * Called by the cron tick. Starts the session ONLY if the tick arrives on time
 * (within CRON_MAX_LATENESS_MS of the exact scheduled time); otherwise it logs
 * a strict error and skips the session. Each session is handled once per day.
 */
async function triggerSession(job) {
  const { dateKey, msOfDay } = getZonedNow();
  const key = `${dateKey}|${job.label}`;

  if (startedSessionKeys.has(key)) {
    console.log(`[cron] ${job.label} session already handled today — skipping.`);
    return;
  }

  for (const k of startedSessionKeys) {
    if (!k.startsWith(dateKey)) startedSessionKeys.delete(k); // drop yesterday's keys
  }
  startedSessionKeys.add(key);

  const lateMs = msOfDay - scheduledMs(job);
  if (lateMs > CRON_MAX_LATENESS_MS) {
    logMissedSession(job, lateMs);
    return;
  }

  console.log(`[cron] Triggering ${job.label} session (${formatJobTime(job)} ${CRON_TIMEZONE}).`);

  if (reconnecting || loginInProgress || !client.isReady()) {
    console.warn(`[cron] ${job.label}: Discord connection is not ready at session time — attempting to open anyway.`);
  }

  const opened = await runCritical(() =>
    openRaidSession(job.channelId, job.label, job.buildMessage)
  );
  if (!opened) {
    console.error(`[cron] ${job.label} session FAILED to open (see errors above) — not retrying, to avoid a late start.`);
  }
}

/**
 * Detects a cron tick that never arrived (e.g. the process was frozen at the
 * scheduled time). It ONLY reports — it never starts a session.
 */
function runMissedCheck() {
  try {
    const { dateKey, msOfDay } = getZonedNow();

    for (const job of SESSION_JOBS) {
      const sinceMs = msOfDay - scheduledMs(job);
      if (sinceMs <= CRON_MAX_LATENESS_MS || sinceMs > MISSED_LOG_WINDOW_MS) continue;

      const key = `${dateKey}|${job.label}`;
      if (startedSessionKeys.has(key)) continue; // started, or already reported

      startedSessionKeys.add(key);
      logMissedSession(job, sinceMs);
    }
  } catch (err) {
    console.error('[cron] Missed-session check failed:', err);
  }
}

let cronScheduled = false;

function scheduleRaidSessions() {
  if (cronScheduled) return; // never register the same jobs twice
  cronScheduled = true;

  for (const job of SESSION_JOBS) {
    const expression = `${job.minute} ${job.hour} * * *`;
    try {
      cron.schedule(
        expression,
        () => {
          triggerSession(job).catch((err) => {
            console.error(`[cron] ${job.label} trigger crashed:`, err);
          });
        },
        { timezone: CRON_TIMEZONE }
      );
      console.log(
        `[cron] ✅ Scheduled ${job.label} session "${expression}" (${CRON_TIMEZONE}) at ${new Date().toISOString()} — next run in ${describeTimeUntil(job)}.`
      );
    } catch (err) {
      console.error(`[cron] ❌ Failed to schedule ${job.label} session:`, err);
    }
  }

  setInterval(runMissedCheck, MISSED_CHECK_INTERVAL_MS);
  console.log(
    `[cron] Timing guard ON: a session starts only if its cron tick arrives within ${CRON_MAX_LATENESS_MS / 1000}s of the exact time; later than that it is logged as missed and skipped.`
  );
}

// ----------------------------------------------------------------------------
// Startup checks (audit-log permission + custom emoji verification)
// ----------------------------------------------------------------------------

async function verifyEmojis(guild) {
  const sample = [
    buildMorningOpeningMessage(),
    buildEveningOpeningMessage(),
    buildClosingMessage(0, '1 Hour'),
    buildSoftReminderMessage([]),
    buildFinalWarningMessage('Morning', []),
    buildGuideMessage('x'),
  ].join('\n');

  const found = new Map();
  for (const match of sample.matchAll(EMOJI_TAG_REGEX)) {
    const [, a, name, id] = match;
    if (!found.has(id)) found.set(id, { name, writtenAnimated: a === 'a' });
  }

  for (const [id, info] of found) {
    try {
      const emoji = await guild.emojis.fetch(id);
      const animated = Boolean(emoji.animated);
      verifiedEmojiAnimated.set(id, animated);
      if (animated !== info.writtenAnimated) {
        console.warn(
          `[emoji] ${info.name}:${id} is ${animated ? 'ANIMATED' : 'STATIC'} but the code writes it as ${info.writtenAnimated ? 'animated (<a:)' : 'static (<:)'} — auto-correcting when sending.`
        );
      }
    } catch (err) {
      console.warn(
        `[emoji] ${info.name}:${id} was NOT found in this server (wrong/deleted ID, or it lives in another server) — it will show as plain text.`
      );
    }
  }

  console.log(`[emoji] Checked ${found.size} custom emoji(s).`);
}

async function runStartupChecks() {
  try {
    const channel = await client.channels.fetch(DEFAULTERS_CHANNEL_ID);
    const guild = channel.guild;

    const me = guild.members.me || (await guild.members.fetchMe());
    if (me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      console.log('[setup] View Audit Log permission OK.');
    } else {
      console.error(
        '[setup] ❌ Bot is missing the "View Audit Log" permission — deleted-link warnings are DISABLED (fail-safe) until it is granted.'
      );
    }

    await verifyEmojis(guild);
  } catch (err) {
    console.error('[setup] Startup checks failed:', err);
  }
}

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------

/** Confirms the cron timezone is what we think it is, independent of the server's clock. */
function logSystemInfo() {
  try {
    const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const karachiNow = new Intl.DateTimeFormat('en-GB', {
      timeZone: CRON_TIMEZONE,
      dateStyle: 'medium',
      timeStyle: 'medium',
      hourCycle: 'h23',
    }).format(new Date());

    console.log(
      `[system] Boot at ${new Date().toISOString()} (UTC) | Node ${process.version} | server timezone: ${serverTz}${process.env.TZ ? ` (TZ=${process.env.TZ})` : ''}`
    );
    console.log(
      `[system] Cron + session timing are locked to ${CRON_TIMEZONE} — time there right now: ${karachiNow}. The server's own timezone is never used.`
    );
    for (const job of SESSION_JOBS) {
      console.log(`[system] ${job.label} session: ${formatJobTime(job)} ${CRON_TIMEZONE}, next in ${describeTimeUntil(job)}.`);
    }
  } catch (err) {
    console.error(`[system] ❌ Timezone "${CRON_TIMEZONE}" is not usable on this host — sessions will NOT run correctly:`, err);
  }
}

// Gateway connection visibility: discord.js reconnects on its own; these logs
// show when the connection dropped and came back.
client.on(Events.ShardDisconnect, (event, shardId) => {
  console.warn(`[system] Discord connection lost (shard ${shardId}, code ${event && event.code}) — reconnecting automatically.`);
});
client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`[system] Reconnecting to Discord (shard ${shardId})...`);
});
client.on(Events.ShardResume, (shardId, replayedEvents) => {
  console.log(`[system] Discord connection resumed (shard ${shardId}, ${replayedEvents} event(s) replayed).`);
});
client.on(Events.Error, (err) => {
  console.error('[system] Discord client error:', err);
});
client.on(Events.ShardError, (err, shardId) => {
  console.error(`[system] Discord shard ${shardId} error:`, err);
});

// Remember when the gateway last did something, so the watchdog never
// "rescues" a connection that is in the middle of reconnecting by itself.
for (const evt of [
  Events.ClientReady,
  Events.ShardDisconnect,
  Events.ShardReconnecting,
  Events.ShardResume,
]) {
  client.on(evt, () => {
    lastGatewayEventAt = Date.now();
  });
}

let readyCount = 0;
client.on(Events.ClientReady, () => {
  readyCount++;
  if (readyCount > 1) {
    console.log(`[system] ✅ Back online as ${client.user.tag} (reconnect #${readyCount - 1}). Cron jobs were never stopped.`);
  }
});

client.once(Events.ClientReady, () => {
  console.log(`[bot] Logged in as ${client.user.tag}.`);
  scheduleRaidSessions(); // first, so setup problems can never block the schedule
  setupDefaultersChannelPermissions();
  runStartupChecks();
});

if (!DISCORD_TOKEN) {
  console.error('[bot] DISCORD_TOKEN is not set in your environment variables. Cannot start the bot.');
  process.exit(1);
}

logSystemInfo();

// ----------------------------------------------------------------------------
// Keep-alive / health HTTP server (Docker / Kerit Cloud)
// ----------------------------------------------------------------------------
//   GET /        -> 200 "Bot is running!"  (the process is alive)
//   GET /health  -> 200 JSON when connected to Discord, 503 while it is not
// Binds to 0.0.0.0 so the container's port mapping / health checks can reach it
// (binding to localhost only would be invisible from outside the container).

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const server = http.createServer((req, res) => {
  const path = String(req.url || '/').split('?')[0];

  if (path === '/health') {
    const ready = client.isReady();
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: ready ? 'ok' : 'connecting',
        uptimeSeconds: Math.round(process.uptime()),
        discordPingMs: ready ? client.ws.ping : null,
        activeSessions: sessions.size,
      })
    );
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
});

server.on('error', (err) => {
  console.error(`[http] Server error on ${HOST}:${PORT}:`, err);
});

server.listen(PORT, HOST, () => {
  console.log(`[http] Keep-alive server listening on ${HOST}:${PORT} (GET / and GET /health)`);
});

// ----------------------------------------------------------------------------
// Process lifecycle (Docker sends SIGTERM when it stops/restarts the container)
// ----------------------------------------------------------------------------

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[system] Received ${signal} — container is stopping. Any session in progress will be lost.`);
  try {
    server.close();
    client.destroy();
  } catch (err) {
    console.error('[system] Error during shutdown:', err);
  }
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ----------------------------------------------------------------------------
// Resilience: login retry, connection watchdog, memory trimming
// ----------------------------------------------------------------------------

const CONNECTION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RECONNECT_GRACE_MS = 60 * 1000; // let discord.js' own reconnect finish first
const CRITICAL_WINDOW_MS = 30 * 1000; // no forced reconnect this close to a raid open/close
const MEMORY_CLEAN_INTERVAL_MS = 15 * 60 * 1000;

function isFatalLoginError(err) {
  const text = `${err && err.code} ${err && err.message}`;
  return (
    (err && (err.code === DiscordjsErrorCodes.TokenInvalid || err.code === DiscordjsErrorCodes.DisallowedIntents)) ||
    /invalid token|disallowed intents/i.test(text)
  );
}

/**
 * Logs in, retrying with backoff (5s, 10s ... max 60s) on transient failures
 * such as a network blip. Returns false only for errors that can never fix
 * themselves (invalid token / privileged intents not enabled).
 */
async function loginWithRetry(reason) {
  loginInProgress = true;
  let delay = 5000;
  try {
    for (let attempt = 1; !shuttingDown; attempt++) {
      try {
        await client.login(DISCORD_TOKEN);
        console.log(`[system] Discord login OK (${reason}, attempt ${attempt}).`);
        return true;
      } catch (err) {
        console.error(`[system] Discord login failed (${reason}, attempt ${attempt}):`, err && err.message);
        if (isFatalLoginError(err)) {
          console.error('[system] ❌ This error cannot fix itself — check DISCORD_TOKEN and the Message Content intent in the Developer Portal.');
          return false;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 60 * 1000);
      }
    }
    return false;
  } finally {
    loginInProgress = false;
  }
}

/** True when a forced reconnect right now could break a raid session opening or locking. */
function isCriticalMoment() {
  if (criticalOps > 0) return true;

  const { msOfDay } = getZonedNow();
  for (const job of SESSION_JOBS) {
    if (Math.abs(msOfDay - scheduledMs(job)) <= CRITICAL_WINDOW_MS) return true;
  }

  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.stage === 'submission' && session.closeAt && Math.abs(now - session.closeAt) <= CRITICAL_WINDOW_MS) {
      return true;
    }
  }
  return false;
}

/**
 * Connection watchdog (runs every 5 minutes). If the bot is not connected to
 * Discord, it tears the client down and logs back in. It never touches the
 * cron jobs (they are plain timers and keep running), and it holds off while a
 * raid session is opening/locking so it cannot break one mid-flight.
 */
async function checkConnection() {
  if (shuttingDown || reconnecting || loginInProgress) return;

  const healthy = client.isReady() && client.ws.ping !== -1;
  if (healthy) return;

  if (Date.now() - lastGatewayEventAt < RECONNECT_GRACE_MS) {
    console.log('[watchdog] Connection looks unhealthy but the gateway was active <60s ago — giving it time to recover on its own.');
    return;
  }

  if (isCriticalMoment()) {
    console.warn('[watchdog] Connection lost, but a raid session is opening/locking right now — postponing the reconnect to the next check.');
    return;
  }

  reconnecting = true;
  try {
    console.error('[watchdog] Connection lost, forcing reconnect...');
    await client.destroy();
    await loginWithRetry('watchdog reconnect');
  } catch (err) {
    console.error('[watchdog] Reconnect attempt failed:', err);
  } finally {
    reconnecting = false;
    lastGatewayEventAt = Date.now();
  }
}

/**
 * Trims discord.js caches to stay inside a small RAM limit (256 MB).
 * Safe for the raid logic: sessions keep their own data (participants,
 * reactions, the closing-message object), message/member lookups fall back to
 * the API, and the bot's own member is kept so permission checks keep working.
 */
function clearCaches() {
  let membersRemoved = 0;
  let channelCaches = 0;

  for (const guild of client.guilds.cache.values()) {
    const botId = client.user && client.user.id;
    membersRemoved += guild.members.cache.sweep((member) => member.id !== botId);

    for (const channel of guild.channels.cache.values()) {
      // Categories / forums have no message cache.
      if (channel.messages && channel.messages.cache) {
        channel.messages.cache.clear();
        channelCaches++;
      }
    }
  }

  const mem = process.memoryUsage();
  const mb = (n) => (n / 1024 / 1024).toFixed(0);
  console.log(
    `[memory] Cleared ${membersRemoved} cached member(s) and ${channelCaches} channel message cache(s) | RSS ${mb(mem.rss)} MB, heap ${mb(mem.heapUsed)} MB`
  );
  if (mem.rss > 200 * 1024 * 1024) {
    console.warn(`[memory] ⚠️ RSS is ${mb(mem.rss)} MB — close to the 256 MB limit.`);
  }
}

setInterval(() => {
  checkConnection().catch((err) => console.error('[watchdog] Unexpected error:', err));
}, CONNECTION_CHECK_INTERVAL_MS);

setInterval(() => {
  try {
    clearCaches();
  } catch (err) {
    console.error('[memory] Cache cleanup failed:', err);
  }
}, MEMORY_CLEAN_INTERVAL_MS);

console.log(
  `[system] Safety nets active: connection watchdog every ${CONNECTION_CHECK_INTERVAL_MS / 60000} min, memory cleanup every ${MEMORY_CLEAN_INTERVAL_MS / 60000} min, global error handlers.`
);

loginWithRetry('startup').then((ok) => {
  if (!ok) process.exit(1); // unrecoverable config problem — nothing left to retry
});
