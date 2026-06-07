#!/usr/bin/env node
// GitHub webhook receiver. Validates X-Hub-Signature-256 HMAC, then drops a
// flag file when a /feedback comment is created on the watched PR.
//
// Env vars:
//   WEBHOOK_SECRET  — HMAC secret used when registering the GitHub webhook
//   PR_NUMBER       — PR number to watch (optional; accepts any if unset)
//   COMMENT_FLAG    — path to touch when a qualifying comment arrives
//   PORT            — port to listen on (default: 9090)
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");

const SECRET = process.env.WEBHOOK_SECRET;
const PR_NUMBER = process.env.PR_NUMBER
  ? parseInt(process.env.PR_NUMBER, 10)
  : null;
const COMMENT_FLAG = process.env.COMMENT_FLAG;
const PORT = parseInt(process.env.PORT || "9090", 10);
const DEBUG = process.env.WEBHOOK_DEBUG === "1";

if (!SECRET || !COMMENT_FLAG) {
  console.error(
    "webhook-receiver: missing required env vars (WEBHOOK_SECRET, COMMENT_FLAG)",
  );
  process.exit(1);
}

function verify(secret, rawBody, sigHeader) {
  // GitHub sends: X-Hub-Signature-256: sha256=<hex>
  if (!sigHeader || !sigHeader.startsWith("sha256=")) {
    if (DEBUG)
      console.log(
        "[webhook-receiver:debug] missing or malformed signature header",
      );
    return false;
  }
  const sig = sigHeader.slice("sha256=".length);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch (_) {
    return false;
  }
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const sigHeader = req.headers["x-hub-signature-256"] || "";
      const event = req.headers["x-github-event"] || "";

      if (!verify(SECRET, rawBody, sigHeader)) {
        console.warn(
          "[webhook-receiver] invalid X-Hub-Signature-256 — rejected",
        );
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }

      res.writeHead(200);
      res.end("ok");

      let payload;
      try {
        payload = JSON.parse(rawBody.toString());
      } catch (_) {
        return;
      }

      if (DEBUG)
        console.log(
          `[webhook-receiver:debug] event=${event} action=${payload.action}`,
        );

      if (event !== "issue_comment" || payload.action !== "created") return;

      const issueNumber = payload.issue && payload.issue.number;
      const body = (payload.comment && payload.comment.body) || "";
      const isPR = payload.issue && payload.issue.pull_request;

      if (!isPR) return;
      if (PR_NUMBER !== null && issueNumber !== PR_NUMBER) {
        if (DEBUG)
          console.log(
            `[webhook-receiver:debug] comment on #${issueNumber}, watching #${PR_NUMBER} — ignored`,
          );
        return;
      }

      // Ignore bot/app comments — only human users should trigger feedback.
      // Check both sender.type and login suffix; bots often omit or vary the type field.
      const senderType = (payload.sender && payload.sender.type) || "";
      const senderLogin = (payload.sender && payload.sender.login) || "";
      const commenterType =
        (payload.comment &&
          payload.comment.user &&
          payload.comment.user.type) ||
        "";
      const commenterLogin =
        (payload.comment &&
          payload.comment.user &&
          payload.comment.user.login) ||
        "";
      const isBot =
        senderType === "Bot" ||
        commenterType === "Bot" ||
        senderLogin.endsWith("[bot]") ||
        commenterLogin.endsWith("[bot]");
      const isFeedbackComment = body.includes("/feedback");

      console.log(`[webhook-receiver] comment: ${body}`);
      console.log(`[webhook-receiver] isBot: ${isBot}`);
      console.log(`[webhook-receiver] isFeedbackComment: ${isFeedbackComment}`);
      if (isBot || !isFeedbackComment) {
        console.log(
          `[webhook-receiver] bot sender (${senderLogin || commenterLogin}) or not feedback comment — ignored`,
        );
        return;
      }

      console.log(
        `[webhook-receiver] feedback comment on PR #${issueNumber} — writing flag`,
      );
      fs.writeFileSync(COMMENT_FLAG, String(Date.now()));
    });
  })
  .listen(PORT, () => {
    console.log(
      `[webhook-receiver] listening on :${PORT} (PR_NUMBER=${PR_NUMBER ?? "any"})`,
    );
  });
