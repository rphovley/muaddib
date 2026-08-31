#!/usr/bin/env node
'use strict';
// Slack delivery for muaddib's human-facing notifications.
//
// POSTs a message to a Slack incoming webhook (SLACK_WEBHOOK_URL) — the same
// class of outbound HTTPS call the codebase already makes to GitHub/Linear. It
// shares orchestrator/notify-format.js with the desktop channel (services/
// notify.sh) so both say exactly the same thing.
//
// Unlike GITHUB_TOKEN / CLAUDE_CODE_OAUTH_TOKEN, Slack is NEVER a hard
// requirement: notify() no-ops cleanly (logs, never throws) when
// SLACK_WEBHOOK_URL is unset, so a fleet with no Slack configured runs exactly
// as before.
//
// The HTTP client is injectable (opts.post) so the test asserts on the built
// payload with no real network — the same pattern services/ticket-source uses
// for its injected graphql / api client. The default client is https.request to
// the webhook URL, shaped like github.js's githubRequest.

const https = require('https');
const { URL } = require('url');
const { buildNotification } = require('../orchestrator/notify-format');

// Default HTTP client: POST a JSON body to the webhook URL. Rejects on HTTP
// >= 400 so a misconfigured webhook surfaces (the caller swallows it — Slack is
// best-effort — but the reason is logged).
function httpsPost(webhookUrl, body) {
  const payload = JSON.stringify(body);
  const u = new URL(webhookUrl);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            reject(new Error(`Slack webhook ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          resolve(text);
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Compose the Slack message body from the shared notification object. Slack
// incoming webhooks render mrkdwn in `text`; the title is bold, the subtitle is
// the action line, and a quiet context line carries worker + kind so a reader
// knows which worker and why without opening anything.
function buildSlackBody(note, payload = {}) {
  const emoji = note.tier === 'info' ? ':information_source:' : ':bell:';
  const lines = [`${emoji} *${note.title}*`, note.subtitle];

  const meta = [];
  if (payload.worker != null && String(payload.worker).trim() !== '') {
    meta.push(`worker ${payload.worker}`);
  }
  if (note.kind) meta.push(note.kind);
  if (meta.length) lines.push(`_${meta.join(' · ')}_`);

  return { text: lines.join('\n') };
}

// notify(payload, opts) → { delivered, body, reason? }.
//   payload: { worker, projectName, ticketTitle, kind, message, url } — fed
//            straight into buildNotification().
//   opts.webhookUrl : override the SLACK_WEBHOOK_URL env var (used by tests).
//   opts.post       : injected HTTP client (webhookUrl, body) => Promise.
//
// Never throws: an unset webhook is a clean no-op (post is never called), and a
// delivery failure is logged and reported in the result — Slack is best-effort,
// so a webhook hiccup must not break a workflow.
async function notify(payload = {}, opts = {}) {
  const webhookUrl = opts.webhookUrl || process.env.SLACK_WEBHOOK_URL || '';
  const note = buildNotification(payload);
  const body = buildSlackBody(note, payload);

  if (!webhookUrl) {
    console.log(`[notify:slack] SLACK_WEBHOOK_URL unset — skipping: ${note.title} — ${note.subtitle}`);
    return { delivered: false, reason: 'no-webhook-url', body };
  }

  const post = opts.post || httpsPost;
  try {
    await post(webhookUrl, body);
    return { delivered: true, body };
  } catch (err) {
    console.error(`[notify:slack] delivery failed: ${err.message}`);
    return { delivered: false, reason: err.message, body };
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
// `node services/notify.js <worker> <kind> <message...>` fires a real Slack
// notification (SLACK_WEBHOOK_URL / MUADDIB_PROJECT_NAME from the env) — a
// standalone smoke test of the delivery path.
if (require.main === module) {
  const [, , worker, kind, ...rest] = process.argv;
  notify({
    worker,
    kind,
    projectName: process.env.MUADDIB_PROJECT_NAME,
    message: rest.join(' '),
  })
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`[notify:slack] FATAL: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { notify, buildSlackBody, httpsPost };
