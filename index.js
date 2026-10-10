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
const TRACKED_EMOJI_ID = '1558278278089936996';
const TRACKED_EMOJI_NAME = 'Kucchi';
const TRACKED_EMOJI_TAG = `<a:${TRACKED_EMOJI_NAME}:${TRACKED_EMOJI_ID}>`;
// Format used when the bot itself reacts (documented "name:id" form).
const TRACKED_EMOJI_REACTION = `${TRACKED_EMOJI_NAME}:${TRACKED_EMOJI_ID}`;

// --- Other custom emojis used in message templates ---
const EMOJI_BACK = '<a:Kucchi:1558273201027678208>';
const EMOJI_DEADLINE = '<a:Kucchi:1558279883107606558>';
const EMOJI_HAPPY = '<a:Kucchi:1558318070160687196>';

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

// --- Cron ---
const SESSION_1_CRON = '0 11 * * *'; // 11:00 AM
const SESSION_2_CRON = '0 18 * * *'; // 6:00 PM
const CRON_TIMEZONE = 'Asia/Karachi';

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
 * plain text scan (no HTML parser, to stay light on Render's free tier), so
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
      return;
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
      engagementLabel: null,
      timers: [],
    };
    sessions.set(channelId, session);

    // Submission phase: raid role can view + send.
    await setRolePermissions(channel, RAID_ROLE_ID, { view: true, send: true });

    await channel.send({
      content: buildOpeningMessageFn(),
      allowedMentions: { roles: [RAID_ROLE_ID] },
    });

    console.log(`[openRaidSession] (${sessionLabel}) Collecting links for 30 minutes.`);

    // Catch anything posted in the last few minutes that we haven't handled.
    await scanRecentSubmissions(session, channel);

    const openedSession = session;
    scheduleForSession(
      openedSession,
      () => {
        closeSubmissionChannel(openedSession).catch((err) => {
          console.error(`[closeSubmissionChannel] (${sessionLabel}) Unhandled error:`, err);
        });
      },
      SUBMISSION_DURATION_MS
    );
  } catch (err) {
    console.error(`[openRaidSession] (${sessionLabel}) Failed to open session:`, err);
    if (session && sessions.get(channelId) === session) endSession(session);
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
    content: buildClosingMessage(linkCount, session.engagementLabel),
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
      content: buildClosingMessage(session.participants.size, session.engagementLabel),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error(`[closingMessage] (${session.label}) Could not update link count:`, err);
  }
}

// ----------------------------------------------------------------------------
// Deleted links
// ----------------------------------------------------------------------------

/**
 * Called when a tracked message is deleted. Works from the message id alone,
 * because deleted messages are frequently uncached (no author available).
 */
async function handleDeletedLink(messageId) {
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

  removeParticipant(session, entry.userId);
  console.log(
    `[deletedLink] (${session.label}) ${entry.userId} deleted their link — removed from session.`
  );

  // Keep the posted total in sync (only exists once the session has closed).
  await refreshClosingMessage(session);

  // Penalize the deleter (once per session). Nobody else is affected: the
  // post is gone from the session, so no one is checked against it.
  if (session.stage === 'submission' && !WARN_ON_DELETE_DURING_SUBMISSION) return;
  if (session.deletionWarned.has(entry.userId)) return;
  session.deletionWarned.add(entry.userId);

  try {
    const defaultersChannel = await client.channels.fetch(DEFAULTERS_CHANNEL_ID);
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

client.on('messageDeleteBulk', async (messages) => {
  try {
    for (const id of messages.keys()) {
      await handleDeletedLink(id);
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
      await channel.messages.fetch(p.messageId);
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
    content: buildSoftReminderMessage(defaulterIds),
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
        content: buildFinalWarningMessage(session.label, outcomes),
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
      } catch (err) {
        console.error(`[setup] Could not set access for ${staffId}:`, err);
      }
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
