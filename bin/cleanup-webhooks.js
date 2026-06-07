#!/usr/bin/env node
'use strict';

// Remove all stale muaddib GitHub webhooks from the repo.
// Muaddib webhooks are identified by their trycloudflare.com URL — the domain
// used by cloudflared quick tunnels. Workers clean up their own webhook on exit;
// this script handles the case where a worker crashed before cleanup.
//
// Usage (from anywhere with env set):
//   GITHUB_TOKEN=<token> REPO_URL=<url> node muaddib/bin/cleanup-webhooks.js

const https = require('https');

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const REPO_URL = (process.env.REPO_URL || '').trim();

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

async function main() {
  console.log(`Fetching GitHub webhooks for ${REPO}...`);
  const hooks = await githubApi('GET', '/hooks');
  if (!Array.isArray(hooks)) {
    console.error('Unexpected response:', JSON.stringify(hooks).slice(0, 300));
    process.exit(1);
  }

  const stale = hooks.filter((h) => h.config?.url?.includes('trycloudflare.com'));

  if (stale.length === 0) {
    console.log('No stale muaddib webhooks found.');
    return;
  }

  console.log(`Found ${stale.length} stale webhook(s):`);
  stale.forEach((h) => console.log(`  ${h.id} → ${h.config.url}`));
  console.log();

  await Promise.all(
    stale.map(async (h) => {
      try {
        await githubApi('DELETE', `/hooks/${h.id}`);
        console.log(`  ✓ deleted ${h.id}`);
      } catch (err) {
        console.error(`  ✗ failed to delete ${h.id}: ${err.message}`);
      }
    })
  );

  console.log(`\nDone — removed ${stale.length} muaddib webhook(s).`);
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
