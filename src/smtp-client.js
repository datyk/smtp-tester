import { connect } from 'cloudflare:sockets';

/**
 * SMTP Client v2.0 — performs SMTP test sessions over TCP.
 * Uses Cloudflare Workers connect() API for raw TCP connections.
 * Supports: none, ssl, tls (STARTTLS).
 */

const SMTP_TIMEOUT = 15000; // 15 seconds per command
const FALLBACK_DOMAIN = 'tyk.app';

// Fixed test email body to prevent abuse
const TEST_EMAIL_BODY = [
  'Subject: SMTP Tester - Connection Verification',
  'From: {MAIL_FROM}',
  'To: {RCPT_TO}',
  'Date: {DATE}',
  'Message-ID: <smtp-test-{ID}@tyk.app>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'X-Mailer: SMTP-Tester/2.0 (https://smtp.tyk.app)',
  '',
  'This is an automated test email sent by SMTP Tester (https://smtp.tyk.app).',
  'If you received this message, the SMTP connection test was successful.',
  '',
  '---',
  'This email was generated automatically to verify SMTP server connectivity.',
  'No action is required on your part.',
].join('\r\n');

/**
 * Run a full SMTP test session.
 * @param {object} config - Test configuration
 * @param {StreamHandler} stream - SSE stream handler
 */
export async function runSmtpTest(config, stream) {
  const { host, port, security, auth, username, password, mailFrom, rcptTo, sendTestEmail } = config;

  let socket = null;
  let reader = null;
  let writer = null;
  let buffer = '';
  let cmdStart = Date.now();

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  /**
   * Emit with elapsed time tracking.
   */
  async function emitTimed(type, data) {
    const elapsed = Date.now() - cmdStart;
    await stream.emit(type, data, elapsed);
  }

  function resetTimer() {
    cmdStart = Date.now();
  }

  try {
    // --- 1. Determine TLS mode ---
    // Map our security options to Cloudflare's secureTransport values
    let secureTransport;
    if (security === 'ssl') {
      secureTransport = 'on';
      await stream.emit('info', `Connecting to ${host}:${port} with implicit SSL/TLS...`);
    } else if (security === 'tls') {
      secureTransport = 'starttls';
      await stream.emit('info', `Connecting to ${host}:${port} (STARTTLS upgrade planned)...`);
    } else {
      secureTransport = 'off';
      await stream.emit('info', `Connecting to ${host}:${port} (no encryption)...`);
    }

    // --- 2. Open TCP connection ---
    resetTimer();
    socket = connect(
      { hostname: host, port: parseInt(port) },
      { secureTransport }
    );

    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();

    await emitTimed('tls', `TCP connection established (transport: ${secureTransport})`);

    // --- 3. Determine EHLO domain ---
    let ehloDomain = FALLBACK_DOMAIN;
    if (mailFrom && mailFrom.includes('@')) {
      ehloDomain = mailFrom.split('@').pop() || FALLBACK_DOMAIN;
    }

    // --- 4. Read server greeting ---
    resetTimer();
    const greeting = await readResponse(reader, decoder, buffer);
    buffer = greeting.remaining;
    await emitTimed('received', greeting.response);

    if (!greeting.response.startsWith('220')) {
      await stream.emit('error', `Server did not send 220 greeting. Got: ${greeting.response}`);
      return;
    }

    // --- 5. Send EHLO ---
    resetTimer();
    await sendCommand(writer, encoder, `EHLO ${ehloDomain}`, stream);
    const ehloResp = await readResponse(reader, decoder, buffer);
    buffer = ehloResp.remaining;
    await emitTimed('received', ehloResp.response);

    if (!ehloResp.response.startsWith('250')) {
      await stream.emit('error', `EHLO rejected: ${ehloResp.response}`);
      return;
    }

    // --- 6. STARTTLS upgrade (for 'tls' and 'tls-available' modes) ---
    if (security === 'tls') {
      // Check if server supports STARTTLS
      if (!ehloResp.response.toUpperCase().includes('STARTTLS')) {
        await stream.emit('error', 'Server does not advertise STARTTLS support');
        return;
      }

      // Server supports STARTTLS — upgrade
      resetTimer();
      await sendCommand(writer, encoder, 'STARTTLS', stream);
      const starttlsResp = await readResponse(reader, decoder, buffer);
      buffer = starttlsResp.remaining;
      await emitTimed('received', starttlsResp.response);

      if (!starttlsResp.response.startsWith('220')) {
        await stream.emit('error', `STARTTLS rejected: ${starttlsResp.response}`);
        return;
      }

      // Release current reader/writer before upgrading
      reader.releaseLock();
      writer.releaseLock();

      // Upgrade to TLS
      resetTimer();
      await stream.emit('tls', 'Upgrading connection to TLS...');
      socket = socket.startTls();
      await emitTimed('tls', 'TLS handshake completed successfully');

      // Get new reader/writer from the secure socket
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      buffer = '';

      // Re-send EHLO after TLS upgrade
      resetTimer();
      await sendCommand(writer, encoder, `EHLO ${ehloDomain}`, stream);
      const ehlo2Resp = await readResponse(reader, decoder, buffer);
      buffer = ehlo2Resp.remaining;
      await emitTimed('received', ehlo2Resp.response);

      if (!ehlo2Resp.response.startsWith('250')) {
        await stream.emit('error', `Post-TLS EHLO rejected: ${ehlo2Resp.response}`);
        return;
      }
    }

    // --- 7. Authentication ---
    if (auth && username && password) {
      // Try AUTH PLAIN first, fall back to LOGIN
      if (ehloResp.response.toUpperCase().includes('AUTH') &&
          ehloResp.response.toUpperCase().includes('PLAIN')) {
        await stream.emit('info', 'Authenticating with AUTH PLAIN...');
        resetTimer();
        const credentials = btoa(`\0${username}\0${password}`);
        await sendCommand(writer, encoder, `AUTH PLAIN ${credentials}`, stream, true);
      } else {
        await stream.emit('info', 'Authenticating with AUTH LOGIN...');
        resetTimer();
        await sendCommand(writer, encoder, 'AUTH LOGIN', stream);
        const loginPrompt = await readResponse(reader, decoder, buffer);
        buffer = loginPrompt.remaining;
        await emitTimed('received', loginPrompt.response);

        // Send username (base64)
        resetTimer();
        await sendCommand(writer, encoder, btoa(username), stream, true);
        const userResp = await readResponse(reader, decoder, buffer);
        buffer = userResp.remaining;
        await emitTimed('received', userResp.response);

        // Send password (base64)
        resetTimer();
        await sendCommand(writer, encoder, btoa(password), stream, true);
      }

      const authResp = await readResponse(reader, decoder, buffer);
      buffer = authResp.remaining;
      await emitTimed('received', authResp.response);

      if (!authResp.response.startsWith('235')) {
        await stream.emit('error', `Authentication failed: ${authResp.response}`);
        // Continue to QUIT — don't abort, let user see full conversation
      } else {
        await stream.emit('info', 'Authentication successful!');
      }
    }

    // --- 8. MAIL FROM / RCPT TO / DATA (optional) ---
    if (mailFrom && rcptTo) {
      resetTimer();
      await sendCommand(writer, encoder, `MAIL FROM:<${mailFrom}>`, stream);
      const mailResp = await readResponse(reader, decoder, buffer);
      buffer = mailResp.remaining;
      await emitTimed('received', mailResp.response);

      if (mailResp.response.startsWith('250')) {
        resetTimer();
        await sendCommand(writer, encoder, `RCPT TO:<${rcptTo}>`, stream);
        const rcptResp = await readResponse(reader, decoder, buffer);
        buffer = rcptResp.remaining;
        await emitTimed('received', rcptResp.response);

        if (rcptResp.response.startsWith('250') && sendTestEmail) {
          resetTimer();
          await sendCommand(writer, encoder, 'DATA', stream);
          const dataResp = await readResponse(reader, decoder, buffer);
          buffer = dataResp.remaining;
          await emitTimed('received', dataResp.response);

          if (dataResp.response.startsWith('354')) {
            // Build the fixed test email
            const msgId = crypto.randomUUID().slice(0, 8);
            const date = new Date().toUTCString();
            const body = TEST_EMAIL_BODY
              .replace('{MAIL_FROM}', mailFrom)
              .replace('{RCPT_TO}', rcptTo)
              .replace('{DATE}', date)
              .replace('{ID}', msgId);

            resetTimer();
            await stream.emit('info', 'Sending test email body...');
            await stream.emit('sent', `[Email body: ${body.length} bytes]`);
            await writer.write(encoder.encode(body + '\r\n.\r\n'));

            const sendResp = await readResponse(reader, decoder, buffer);
            buffer = sendResp.remaining;
            await emitTimed('received', sendResp.response);

            if (sendResp.response.startsWith('250')) {
              await stream.emit('info', 'Test email sent successfully!');
            } else {
              await stream.emit('error', `Message delivery failed: ${sendResp.response}`);
            }
          }
        }
      }
    }

    // --- 9. QUIT ---
    resetTimer();
    await sendCommand(writer, encoder, 'QUIT', stream);
    try {
      const quitResp = await readResponse(reader, decoder, buffer);
      await emitTimed('received', quitResp.response);
    } catch (e) {
      // Server may close connection immediately after QUIT
      await stream.emit('info', 'Server closed connection');
    }

    await stream.emit('complete', 'SMTP test completed successfully');

  } catch (error) {
    await stream.emit('error', `Connection error: ${error.message}`);
  } finally {
    // Clean up
    try {
      if (reader) reader.releaseLock();
      if (writer) writer.releaseLock();
      if (socket) socket.close();
    } catch (e) {
      // Ignore cleanup errors
    }
    await stream.close();
  }
}

/**
 * Send an SMTP command and emit it to the stream.
 * @param {WritableStreamDefaultWriter} writer
 * @param {TextEncoder} encoder
 * @param {string} command
 * @param {StreamHandler} stream
 * @param {boolean} sensitive - If true, mask the command in output
 */
async function sendCommand(writer, encoder, command, stream, sensitive = false) {
  const display = sensitive ? `${command.split(' ')[0]} ${'*'.repeat(8)}` : command;
  await stream.emit('sent', display);
  await writer.write(encoder.encode(command + '\r\n'));
}

/**
 * Read a complete SMTP response (handles multi-line responses).
 * @param {ReadableStreamDefaultReader} reader
 * @param {TextDecoder} decoder
 * @param {string} existing - Existing buffer content
 * @returns {Promise<{response: string, remaining: string}>}
 */
async function readResponse(reader, decoder, existing = '') {
  let buffer = existing;
  const startTime = Date.now();

  while (true) {
    // Check timeout
    if (Date.now() - startTime > SMTP_TIMEOUT) {
      throw new Error('SMTP response timeout (15s)');
    }

    // Check if we have a complete response in the buffer
    const lines = buffer.split('\r\n');
    let responseLines = [];
    let complete = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0 && i === lines.length - 1) continue;

      responseLines.push(line);

      // A line with format "XXX " (space after code) indicates final line
      if (line.length >= 4 && line[3] === ' ') {
        complete = true;
        const remaining = lines.slice(i + 1).join('\r\n');
        return {
          response: responseLines.join('\r\n'),
          remaining: remaining,
        };
      }
    }

    // Need more data
    const { value, done } = await reader.read();
    if (done) {
      if (responseLines.length > 0) {
        return { response: responseLines.join('\r\n'), remaining: '' };
      }
      throw new Error('Connection closed by server');
    }
    buffer += decoder.decode(value, { stream: true });
  }
}
