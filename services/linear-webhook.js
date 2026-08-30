#!/usr/bin/env node
'use strict';
// Backwards-compatible shim.
//
// The Linear-specific logic that used to live here (the raw GraphQL client,
// registerWebhook / deregisterWebhook, verifySignature) now lives behind the
// TicketSource interface in services/ticket-source/. This file preserves the
// historical export surface so existing importers and tests keep working
// unchanged — new code should call getTicketSource() from ./ticket-source
// instead of requiring this module.

const { linearSource, linearGraphQL, verifySignature } = require('./ticket-source/linear');

const source = linearSource;

async function registerWebhook(teamId, url, secret) {
  const { watchId } = await source.registerWatch({ teamId, url, secret });
  return { webhookId: watchId };
}

async function deregisterWebhook(webhookId) {
  return source.deregisterWatch(webhookId);
}

module.exports = { linearGraphQL, registerWebhook, deregisterWebhook, verifySignature };
