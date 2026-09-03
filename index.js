// ============================================================================
// X Engagement Raid Bot
// ----------------------------------------------------------------------------
// This bot automatically opens and closes a "raid session" twice a day
// (11:00 AM and 6:00 PM, Asia/Karachi time), each in its own channel:
//   - 11:00 AM session runs in MORNING_CHANNEL_ID
//   - 6:00 PM session runs in EVENING_CHANNEL_ID
//
// - "Opening" a session = giving a role permission to view + send messages,
//   and posting an announcement.
// - After 30 minutes, the bot removes the role's "Send Messages" permission,
//   counts how many messages posted in that window contained a link, and
//   posts a closing message whose wording depends on that count.
//
// You do not need to edit any logic below to run this bot. You only need to
// create a .env file (instructions at the very bottom of this file / in the
// chat response) with your bot token and the two channel IDs.
// ============================================================================

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Options,
} = require('discord.js');
const cron = require('node-cron');

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MORNING_CHANNEL_ID = process.env.MORNING_CHANNEL_ID;
const EVENING_CHANNEL_ID = process.env.EVENING_CHANNEL_ID;

// Role that gets opened up / locked down during the raid session.
const RAID_ROLE_ID = '1459120132235329536';

// How long a session stays open before it auto-locks (30 minutes).
const SESSION_DURATION_MS = 30 * 60 * 1000;

// Link count threshold that decides which closing message is used.
const LINK_COUNT_THRESHOLD = 20;

// Cron schedules (server/OS-independent because we pass timezone explicitly).
const SESSION_1_CRON = '0 11 * * *'; // 11:00 AM
const SESSION_2_CRON = '0 18 * * *'; // 6:00 PM
const CRON_TIMEZONE = 'Asia/Karachi';

// ----------------------------------------------------------------------------
// Message templates
// ----------------------------------------------------------------------------

function buildOpeningMessage() {
  return (
    `||<@&${RAID_ROLE_ID}>||\n` +
    `I'm Back Fams <a:alya:1494783730122752142>\n` +
    `The morning raid session is officially open. You have 30 minutes to submit your links in the channel. Any links posted after the deadline will not be considered <a:alya:1494775877622435983>\n` +
    `If your links getting removed, kindly remove your tracking ID and try again <a:alya:1494782724022603827>\n` +
    `Wishing everyone happy engagement and great interactions <a:alya:1494940138860711936>`
  );
}

function buildClosingMessage(linkCount) {
  const withinWindow = linkCount > LINK_COUNT_THRESHOLD ? '2 Hours' : '1 Hour';

  return (
    `Alright, Fams, that’s a wrap :alya~37: \n` +
    `The Raid Session Is Now Closed :alya~23: \n` +
    `**Complete Your Engagements Within ${withinWindow}** :alya~38: \n` +
    `If someone didn’t complete engagement please report it in https://discord.com/channels/1343701000174698602/1414278885260005496`
  );
}

// ----------------------------------------------------------------------------
// Discord client
// ----------------------------------------------------------------------------

// Memory optimization: this bot only ever needs guild info, the raid
// channel, and message content/timestamps for link-scanning. Everything
// else (emoji cache, ban list, stickers, scheduled events, reaction
// caches, member presences, thread caches) is pure overhead on a
// 100MB-limited host, so those caches are disabled entirely below.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
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
// Helpers
// ----------------------------------------------------------------------------

/**
 * Scans every message in `channel` whose createdTimestamp falls between
 * startTimestamp and endTimestamp (inclusive), handling pagination since
 * a single Discord API call only returns up to 100 messages at a time.
 *
 * Memory note: instead of accumulating full Discord.js Message objects
 * (which carry author, member, embeds, attachments, etc.), this only
 * keeps the tiny bit of data it actually needs (whether a message has a
 * link), and drops every other reference (the fetched page, the message
 * objects themselves, the "before" cursor) as soon as it's done with
 * them each loop iteration. That keeps the working set small and lets
 * V8 garbage-collect each page immediately rather than holding hundreds
 * of heavy message objects in memory for the whole scan.
 */
async function fetchMessagesInWindow(channel, startTimestamp, endTimestamp) {
  let linkCount = 0;
  let beforeId = undefined;

  // Walk backwards from "now" in pages of 100, stopping once we reach
  // messages older than the window we care about.
  while (true) {
    const fetchOptions = { limit: 100 };
    if (beforeId) fetchOptions.before = beforeId;

    let page = await channel.messages.fetch(fetchOptions);
    if (page.size === 0) {
      page = null;
      break;
    }

    let reachedOlderMessages = false;
    let oldestInPage = null;

    for (const message of page.values()) {
      if (message.createdTimestamp > endTimestamp) {
        // Message is newer than our window (shouldn't normally happen
        // since we start fetching after the window closes, but skip it
        // just in case).
        continue;
      }
      if (message.createdTimestamp < startTimestamp) {
        reachedOlderMessages = true;
        continue;
      }

      const content = message.content || '';
      if (content.includes('http://') || content.includes('https://')) {
        linkCount += 1;
      }
    }

    // Grab the cursor for the next page, then immediately drop the page
    // reference (and every message object it held) instead of keeping
    // it around until the function returns.
    oldestInPage = page.last();
    beforeId = oldestInPage ? oldestInPage.id : undefined;
    oldestInPage = null;
    page = null;

    if (reachedOlderMessages || !beforeId) break;
  }

  return linkCount;
}

async function setRolePermissions(channel, { view, send }) {
  const overwrite = {};
  if (view !== undefined) overwrite.ViewChannel = view;
  if (send !== undefined) overwrite.SendMessages = send;

  await channel.permissionOverwrites.edit(RAID_ROLE_ID, overwrite);
}

// ----------------------------------------------------------------------------
// Core workflow
// ----------------------------------------------------------------------------

async function openRaidSession(channelId, sessionLabel) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`[openRaidSession] Could not resolve a text channel for ${sessionLabel} (check its channel ID in .env).`);
      return;
    }

    console.log(`[openRaidSession] (${sessionLabel}) Opening session — granting View + Send to role.`);
    await setRolePermissions(channel, { view: true, send: true });

    const sentMessage = await channel.send({
      content: buildOpeningMessage(),
      allowedMentions: { roles: [RAID_ROLE_ID] },
    });

    const sessionStart = sentMessage.createdTimestamp;

    console.log(`[openRaidSession] (${sessionLabel}) Session opened at ${new Date(sessionStart).toISOString()}. Closing in 30 minutes.`);

    setTimeout(() => {
      closeRaidSession(channel.id, sessionStart, sessionLabel).catch((err) => {
        console.error(`[closeRaidSession] (${sessionLabel}) Unhandled error:`, err);
      });
    }, SESSION_DURATION_MS);
  } catch (err) {
    console.error(`[openRaidSession] (${sessionLabel}) Failed to open session:`, err);
  }
}

async function closeRaidSession(channelId, sessionStart, sessionLabel) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    console.error(`[closeRaidSession] (${sessionLabel}) Could not resolve channel to close session.`);
    return;
  }

  console.log(`[closeRaidSession] (${sessionLabel}) Locking role — revoking Send Messages.`);
  await setRolePermissions(channel, { send: false });

  const sessionEnd = Date.now();

  console.log(`[closeRaidSession] (${sessionLabel}) Scanning messages posted during the session window...`);
  let linkCount = await fetchMessagesInWindow(channel, sessionStart, sessionEnd);

  console.log(`[closeRaidSession] (${sessionLabel}) Found ${linkCount} message(s) containing a link.`);

  const closingContent = buildClosingMessage(linkCount);
  linkCount = null; // release as soon as it's no longer needed

  await channel.send({
    content: closingContent,
    allowedMentions: { parse: [] },
  });

  console.log(`[closeRaidSession] (${sessionLabel}) Session closed.`);
}

// ----------------------------------------------------------------------------
// Scheduling
// ----------------------------------------------------------------------------

function scheduleRaidSessions() {
  cron.schedule(
    SESSION_1_CRON,
    () => {
      console.log('[cron] Triggering Session 1 (11:00 AM Asia/Karachi) — Morning channel.');
      openRaidSession(MORNING_CHANNEL_ID, 'Morning');
    },
    { timezone: CRON_TIMEZONE }
  );

  cron.schedule(
    SESSION_2_CRON,
    () => {
      console.log('[cron] Triggering Session 2 (6:00 PM Asia/Karachi) — Evening channel.');
      openRaidSession(EVENING_CHANNEL_ID, 'Evening');
    },
    { timezone: CRON_TIMEZONE }
  );

  console.log(`[cron] Scheduled Morning session at 11:00 AM and Evening session at 6:00 PM (${CRON_TIMEZONE}).`);
}

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------

client.once('ready', () => {
  console.log(`[bot] Logged in as ${client.user.tag}.`);

  if (!MORNING_CHANNEL_ID) {
    console.error('[bot] MORNING_CHANNEL_ID is not set in your .env file. The 11:00 AM session will not be able to run.');
  }
  if (!EVENING_CHANNEL_ID) {
    console.error('[bot] EVENING_CHANNEL_ID is not set in your .env file. The 6:00 PM session will not be able to run.');
  }

  scheduleRaidSessions();
});

if (!DISCORD_TOKEN) {
  console.error('[bot] DISCORD_TOKEN is not set in your .env file. Cannot start the bot.');
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[bot] Failed to log in. Check that DISCORD_TOKEN is correct.', err);
  process.exit(1);
});
