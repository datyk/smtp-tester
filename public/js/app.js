/**
 * SMTP Tester — Frontend Application
 * Handles form interaction, SSE streaming, and terminal rendering.
 */

(function () {
  'use strict';

  // --- DOM Elements ---
  const form = document.getElementById('smtp-form');
  const hostInput = document.getElementById('smtp-host');
  const portInput = document.getElementById('smtp-port');
  const securityRadios = document.querySelectorAll('input[name="security"]');
  const authToggle = document.getElementById('auth-toggle');
  const authFields = document.getElementById('auth-fields');
  const usernameInput = document.getElementById('smtp-username');
  const passwordInput = document.getElementById('smtp-password');
  const mailFromInput = document.getElementById('smtp-mail-from');
  const rcptToInput = document.getElementById('smtp-rcpt-to');
  const sendTestWrapper = document.getElementById('send-test-wrapper');
  const sendTestCheckbox = document.getElementById('send-test-email');
  const port25Warning = document.getElementById('port25-warning');
  const btnTest = document.getElementById('btn-test');
  const btnExport = document.getElementById('btn-export');
  const btnClear = document.getElementById('btn-clear');
  const exportDropdown = document.getElementById('export-dropdown');
  const exportMenu = document.getElementById('export-menu');
  const exportOptions = document.querySelectorAll('.export-option');
  const presetBtns = document.querySelectorAll('.preset-btn');
  const terminalLog = document.getElementById('terminal-log');
  const terminalBody = document.getElementById('terminal-body');
  const statusIndicator = document.getElementById('test-status');
  const statusText = statusIndicator.querySelector('.status-text');

  // --- State ---
  let isRunning = false;
  let abortController = null;
  let events = [];

  // --- Port preset buttons ---
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const port = btn.dataset.port;
      const security = btn.dataset.security;

      portInput.value = port;
      document.getElementById(`security-${security}`).checked = true;

      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      checkPort25();
    });
  });

  // --- Port input change → auto-select security ---
  portInput.addEventListener('input', () => {
    const port = parseInt(portInput.value);

    // Auto-select security based on port
    if (port === 465) {
      document.getElementById('security-ssl').checked = true;
    } else if (port === 587) {
      document.getElementById('security-starttls').checked = true;
    }

    // Update preset button active state
    presetBtns.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.port) === port);
    });

    checkPort25();
  });

  // --- Security change → auto-update port ---
  securityRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const security = radio.value;
      if (security === 'ssl' && portInput.value !== '465') {
        portInput.value = 465;
      } else if (security === 'starttls' && portInput.value === '465') {
        portInput.value = 587;
      }

      presetBtns.forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.port) === parseInt(portInput.value));
      });

      checkPort25();
    });
  });

  // --- Port 25 warning ---
  function checkPort25() {
    const isPort25 = parseInt(portInput.value) === 25;
    port25Warning.classList.toggle('hidden', !isPort25);
    btnTest.disabled = isPort25 && !isRunning;
  }

  // --- Auth toggle ---
  authToggle.addEventListener('change', () => {
    authFields.classList.toggle('hidden', !authToggle.checked);
  });

  // --- MAIL FROM / RCPT TO → show send test option ---
  function checkEnvelopeFields() {
    const hasEnvelope = mailFromInput.value.trim() && rcptToInput.value.trim();
    sendTestWrapper.classList.toggle('hidden', !hasEnvelope);
    if (!hasEnvelope) {
      sendTestCheckbox.checked = false;
    }
  }

  mailFromInput.addEventListener('input', checkEnvelopeFields);
  rcptToInput.addEventListener('input', checkEnvelopeFields);

  // --- Export dropdown ---
  btnExport.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!exportDropdown.contains(e.target)) {
      exportMenu.classList.add('hidden');
    }
  });

  exportOptions.forEach(opt => {
    opt.addEventListener('click', () => {
      const format = opt.dataset.format;
      SmtpExport.export(events, hostInput.value, format);
      exportMenu.classList.add('hidden');
    });
  });

  // --- Clear button ---
  btnClear.addEventListener('click', () => {
    clearTerminal();
  });

  // --- Form submit ---
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (isRunning) {
      // Abort current test
      if (abortController) {
        abortController.abort();
      }
      return;
    }

    startTest();
  });

  // --- Start SMTP test ---
  async function startTest() {
    // Collect config
    const config = {
      host: hostInput.value.trim(),
      port: parseInt(portInput.value),
      security: document.querySelector('input[name="security"]:checked').value,
      auth: authToggle.checked,
      username: authToggle.checked ? usernameInput.value.trim() : null,
      password: authToggle.checked ? passwordInput.value : null,
      mailFrom: mailFromInput.value.trim() || null,
      rcptTo: rcptToInput.value.trim() || null,
      sendTestEmail: sendTestCheckbox.checked,
    };

    // Validate
    if (!config.host) {
      hostInput.focus();
      return;
    }

    // Clear previous results
    clearTerminal();
    events = [];

    // Update UI state
    isRunning = true;
    btnTest.classList.add('running');
    btnTest.querySelector('span').textContent = 'Stop Test';
    btnTest.querySelector('.btn-icon').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    btnExport.disabled = true;
    setStatus('running', 'Testing...');

    // Disable form inputs
    setFormDisabled(true);

    abortController = new AbortController();

    try {
      const response = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        appendLogLine('error', new Date().toISOString(), err.error || `HTTP ${response.status}`);
        endTest(true);
        return;
      }

      // Read SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              events.push(event);
              appendLogLine(event.type, event.timestamp, event.data);
            } catch (e) {
              // Invalid JSON, skip
            }
          }
        }
      }

      endTest(false);

    } catch (error) {
      if (error.name === 'AbortError') {
        appendLogLine('info', new Date().toISOString(), 'Test aborted by user');
        endTest(false);
      } else {
        appendLogLine('error', new Date().toISOString(), `Connection failed: ${error.message}`);
        endTest(true);
      }
    }
  }

  // --- End test ---
  function endTest(hasError) {
    isRunning = false;
    abortController = null;

    btnTest.classList.remove('running');
    btnTest.querySelector('span').textContent = 'Run Test';
    btnTest.querySelector('.btn-icon').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    btnExport.disabled = events.length === 0;

    setFormDisabled(false);
    setStatus(hasError ? 'error' : 'complete', hasError ? 'Error' : 'Complete');

    // Clear sensitive fields
    clearCredentials();
  }

  // --- Clear credentials from memory ---
  function clearCredentials() {
    usernameInput.value = '';
    passwordInput.value = '';
  }

  // --- Terminal rendering ---
  const prefixMap = {
    sent: 'C:',
    received: 'S:',
    info: 'ℹ',
    error: '✖',
    tls: '🔒',
    complete: '✔',
  };

  function appendLogLine(type, timestamp, data) {
    // Remove welcome message if present
    const welcome = terminalLog.querySelector('.terminal-welcome');
    if (welcome) welcome.remove();

    const line = document.createElement('div');
    line.className = `log-line type-${type}`;

    const time = new Date(timestamp).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });

    // Build with textContent to prevent XSS
    const tsSpan = document.createElement('span');
    tsSpan.className = 'log-timestamp';
    tsSpan.textContent = time;

    const prefixSpan = document.createElement('span');
    prefixSpan.className = 'log-prefix';
    prefixSpan.textContent = prefixMap[type] || '·';

    const contentSpan = document.createElement('span');
    contentSpan.className = 'log-content';
    contentSpan.textContent = data;

    line.appendChild(tsSpan);
    line.appendChild(prefixSpan);
    line.appendChild(contentSpan);

    terminalLog.appendChild(line);

    // Auto-scroll to bottom
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  function clearTerminal() {
    terminalLog.innerHTML = '';
    events = [];
    btnExport.disabled = true;
    setStatus('', 'Ready');

    // Re-add welcome message
    const welcome = document.createElement('div');
    welcome.className = 'terminal-welcome';
    welcome.innerHTML = `
      <p>Welcome to <strong>SMTP Tester</strong></p>
      <p class="dim">Configure your SMTP server settings and click <strong>Run Test</strong> to start.</p>
      <p class="dim">The SMTP conversation will appear here in real-time.</p>
    `;
    terminalLog.appendChild(welcome);
  }

  // --- Status indicator ---
  function setStatus(state, text) {
    statusIndicator.className = `status-indicator ${state}`;
    statusText.textContent = text;
  }

  // --- Disable/enable form ---
  function setFormDisabled(disabled) {
    const inputs = form.querySelectorAll('input:not(#auth-toggle):not([name="security"]):not(#send-test-email)');
    inputs.forEach(input => input.disabled = disabled);
    presetBtns.forEach(btn => btn.disabled = disabled);
    securityRadios.forEach(radio => radio.disabled = disabled);
    authToggle.disabled = disabled;
    sendTestCheckbox.disabled = disabled;
  }

  // --- Cleanup on page unload ---
  window.addEventListener('beforeunload', () => {
    clearCredentials();
    if (abortController) abortController.abort();
  });

  // --- Initial state ---
  checkPort25();
  checkEnvelopeFields();
})();
