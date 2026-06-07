#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const https = require('https');

function linearGraphQL(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY || '';
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            reject(new Error(`Linear GraphQL ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            const parsed = JSON.parse(text);
            if (parsed.errors && parsed.errors.length > 0) {
              reject(new Error(`Linear GraphQL error: ${JSON.stringify(parsed.errors[0])}`));
              return;
            }
            resolve(parsed.data);
          } catch (_) {
            resolve(text);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function registerWebhook(teamId, url, secret) {
  const data = await linearGraphQL(
    `mutation WebhookCreate($input: WebhookCreateInput!) {
       webhookCreate(input: $input) {
         success
         webhook { id }
       }
     }`,
    {
      input: {
        teamId,
        url,
        secret,
        resourceTypes: ['Issue'],
        allPublicTeams: false,
      },
    }
  );
  const webhookId = data && data.webhookCreate && data.webhookCreate.webhook && data.webhookCreate.webhook.id;
  if (!webhookId) {
    throw new Error(`webhookCreate returned no webhook id — response: ${JSON.stringify(data)}`);
  }
  return { webhookId };
}

async function deregisterWebhook(webhookId) {
  await linearGraphQL(
    `mutation WebhookDelete($id: String!) {
       webhookDelete(id: $id) { success }
     }`,
    { id: webhookId }
  );
}

// Linear sends the `linear-signature` header as raw hex (no sha256= prefix).
function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const sigBuf = Buffer.from(signatureHeader, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (_) {
    return false;
  }
}

module.exports = { linearGraphQL, registerWebhook, deregisterWebhook, verifySignature };
