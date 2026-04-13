import { runSmtpTest } from './smtp-client.js';
import { StreamHandler } from './stream-handler.js';

/**
 * SMTP Tester — Cloudflare Worker Entry Point
 * Routes:
 *   GET  /*         → Static assets (served by Cloudflare [assets])
 *   POST /api/test  → Run SMTP test, return SSE stream
 */

// Simple in-memory rate limiter (per-isolate, resets on cold starts)
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // Max 10 tests per minute per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimiter.set(ip, { windowStart: now, count: 1 });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up old rate limit entries periodically
function cleanupRateLimiter() {
  const now = Date.now();
  for (const [ip, entry] of rateLimiter) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimiter.delete(ip);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle SMTP test API
    if (url.pathname === '/api/test' && request.method === 'POST') {
      return handleSmtpTest(request, ctx);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Everything else is handled by static assets ([assets] in wrangler.toml)
    return new Response('Not Found', { status: 404 });
  },
};

async function handleSmtpTest(request, ctx) {
  // Rate limiting
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  cleanupRateLimiter();

  if (!checkRateLimit(clientIp)) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please wait a minute before trying again.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      }
    );
  }

  // Parse request body
  let config;
  try {
    config = await request.json();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate required fields
  if (!config.host || !config.port || !config.mailFrom || !config.rcptTo) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: host, port, mailFrom, rcptTo' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Block port 25
  if (parseInt(config.port) === 25) {
    return new Response(
      JSON.stringify({
        error: 'Port 25 is blocked by Cloudflare Workers to prevent spam. Please use port 587 (STARTTLS) or 465 (SSL/TLS) instead.',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate security option
  const validSecurity = ['none', 'ssl', 'starttls'];
  if (!validSecurity.includes(config.security)) {
    config.security = 'starttls';
  }

  // Create SSE stream
  const stream = new StreamHandler();

  // Run the SMTP test in the background (non-blocking)
  ctx.waitUntil(runSmtpTest(config, stream));

  // Return the SSE response immediately
  return new Response(stream.readable, {
    headers: {
      ...StreamHandler.responseHeaders(),
      'Access-Control-Allow-Origin': '*',
    },
  });
}
