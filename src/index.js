import { runSmtpTest } from './smtp-client.js';
import { StreamHandler } from './stream-handler.js';

/**
 * SMTP Tester v2.0 — Cloudflare Worker Entry Point
 * Routes:
 *   GET  /*         → Static assets (served by Cloudflare [assets])
 *   POST /api/test  → Run SMTP test, return SSE stream
 */

// Allowed origins for CORS
const ALLOWED_ORIGINS = ['https://smtp.tyk.app'];

// Simple in-memory rate limiter (per-isolate, resets on cold starts)
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // Max 10 tests per minute per IP

// Blocked host patterns (SSRF protection)
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^\[::1\]$/,
];

// Blocked port ranges
const BLOCKED_PORTS = new Set([25]); // Port 25 explicitly blocked
const MIN_PORT = 25; // Ports below 25 are blocked

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

/**
 * Get security headers for all responses.
 */
function securityHeaders(origin) {
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

/**
 * Check if a host is blocked (private IP / localhost).
 */
function isBlockedHost(host) {
  return BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(host));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // Handle SMTP test API
    if (url.pathname === '/api/test' && request.method === 'POST') {
      return handleSmtpTest(request, ctx, origin);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...securityHeaders(origin),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Everything else is handled by static assets ([assets] in wrangler.toml)
    return new Response('Not Found', {
      status: 404,
      headers: securityHeaders(origin),
    });
  },
};

async function handleSmtpTest(request, ctx, origin) {
  const headers = securityHeaders(origin);

  // Rate limiting
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  cleanupRateLimiter();

  if (!checkRateLimit(clientIp)) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please wait a minute before trying again.' }),
      {
        status: 429,
        headers: {
          ...headers,
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
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  // Validate required fields
  if (!config.host || !config.port || !config.mailFrom || !config.rcptTo) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: host, port, mailFrom, rcptTo' }),
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  // Input length validation
  if (config.host.length > 253) {
    return new Response(
      JSON.stringify({ error: 'Host name too long (max 253 characters)' }),
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }
  if (config.mailFrom.length > 254 || config.rcptTo.length > 254) {
    return new Response(
      JSON.stringify({ error: 'Email address too long (max 254 characters)' }),
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }
  if (config.username && config.username.length > 256) {
    return new Response(
      JSON.stringify({ error: 'Username too long (max 256 characters)' }),
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }
  if (config.password && config.password.length > 256) {
    return new Response(
      JSON.stringify({ error: 'Password too long (max 256 characters)' }),
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  // SSRF protection — block private/local hosts
  if (isBlockedHost(config.host)) {
    return new Response(
      JSON.stringify({ error: 'Connections to private/local addresses are not allowed.' }),
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  // Port validation
  const port = parseInt(config.port);
  if (port < MIN_PORT || BLOCKED_PORTS.has(port)) {
    return new Response(
      JSON.stringify({
        error: `Port ${port} is blocked. Please use port 587 (TLS) or 465 (SSL) instead.`,
      }),
      { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  // Validate and normalize security option
  const validSecurity = ['none', 'ssl', 'tls'];
  if (!validSecurity.includes(config.security)) {
    config.security = 'tls';
  }

  // Create SSE stream
  const stream = new StreamHandler();

  // Run the SMTP test in the background (non-blocking)
  ctx.waitUntil(runSmtpTest(config, stream));

  // Return the SSE response immediately
  return new Response(stream.readable, {
    headers: {
      ...StreamHandler.responseHeaders(),
      ...headers,
    },
  });
}
