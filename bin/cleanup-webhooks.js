#!/usr/bin/env node
'use strict';

// Remove stale muaddib GitHub webhooks from the repo.
// Muaddib webhooks are identified by their trycloudflare.com URL — the domain
// used by cloudflared quick tunnels. Workers clean up their own webhook on exit;
// this script handles the case where a worker crashed before cleanup.
//
// By default, webhooks tagged with ?pr=<N> are kept if that PR is still open.
// Pass --force to delete all trycloudflare webhooks regardless of PR state.
//
// Usage (from anywhere with env set):
//   GITHUB_TOKEN=<token> REPO_URL=<url> node muaddib/bin/cleanup-webhooks.js
//   GITHUB_TOKEN=<token> REPO_URL=<url> node muaddib/bin/cleanup-webhooks.js --force

const https = require('https');

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const REPO_URL = (process.env.REPO_URL || '').trim();
const FORCE = process.argv.includes('--force');

const REPO = REPO_URL
  .replace(/^https?:\/\//, '')
  .replace(/^github\.com\//, '')
  .replace(/\.git$/, '');

if (!GITHUB_TOKEN) { console.error('error: GITHUB_TOKEN not set'); process.exit(1); }
if (!REPO) { console.error('error: REPO_URL not set'); process.exit(1); }

function githubApi(method, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}${endpoint}`,
        method,
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'muaddib-fleet',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub ${method} ${endpoint} → ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try { resolve(JSON.parse(text)); } catch (_) { resolve(text); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getPrState(prNumber) {
  try {
    const pr = await githubApi('GET', `/pulls/${prNumber}`);
    if (pr.merged) return 'MERGED';
    if (pr.state === 'closed') return 'CLOSED';
    return 'OPEN';
  } catch (err) {
    console.error(`  ! could not fetch PR #${prNumber}: ${err.message}`);
    return 'UNKNOWN';
  }
}

async function main() {
  console.log(`Fetching GitHub webhooks for ${REPO}...`);
  if (FORCE) console.log('  --force: skipping PR state check, deleting all trycloudflare webhooks');

  const hooks = await githubApi('GET', '/hooks');
  if (!Array.isArray(hooks)) {
    console.error('Unexpected response:', JSON.stringify(hooks).slice(0, 300));
    process.exit(1);
  }

  const cloudflareHooks = hooks.filter((h) => h.config?.url?.includes('trycloudflare.com'));

  if (cloudflareHooks.length === 0) {
    console.log('No muaddib webhooks found.');
    return;
  }

  console.log(`\nFound ${cloudflareHooks.length} trycloudflare webhook(s):`);
  cloudflareHooks.forEach((h) => console.log(`  ${h.id} → ${h.config.url}`));
  console.log();

  let deleted = 0;
  let skipped = 0;

  await Promise.all(
    cloudflareHooks.map(async (h) => {
      const url = h.config?.url || '';
      const prMatch = url.match(/[?&]pr=(\d+)/);

      if (!FORCE && prMatch) {
        const pr = prMatch[1];
        const state = await getPrState(pr);
        if (state === 'OPEN' || state === 'UNKNOWN') {
          console.log(`  ~ skipping ${h.id} — PR #${pr} is ${state}`);
          skipped++;
          return;
        }
        console.log(`  → deleting ${h.id} — PR #${pr} is ${state}`);
      } else if (!FORCE) {
        console.log(`  → deleting ${h.id} — no PR tag (legacy or pre-PR)`);
      } else {
        console.log(`  → deleting ${h.id} (--force)`);
      }

      try {
        await githubApi('DELETE', `/hooks/${h.id}`);
        console.log(`  ✓ deleted ${h.id}`);
        deleted++;
      } catch (err) {
        console.error(`  ✗ failed to delete ${h.id}: ${err.message}`);
      }
    })
  );

  console.log(`\nDone — deleted ${deleted}, skipped ${skipped} (open PRs).`);
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
