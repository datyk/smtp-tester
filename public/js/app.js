/**
 * SMTP Tester v2.0 — Frontend Application
 * Handles form interaction, SSE streaming, terminal rendering,
 * theme toggle, keyboard shortcuts, and clipboard copy.
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
  const btnTest = document.getElementById('btn-test');
  const btnExport = document.getElementById('btn-export');
  const btnClear = document.getElementById('btn-clear');
  const btnCopy = document.getElementById('btn-copy');
  const exportDropdown = document.getElementById('export-dropdown');
  const exportMenu = document.getElementById('export-menu');
  const exportOptions = document.querySelectorAll('.export-option');
  const presetBtns = document.querySelectorAll('.preset-btn');
  const terminalLog = document.getElementById('terminal-log');
  const terminalBody = document.getElementById('terminal-body');
  const statusIndicator = document.getElementById('test-status');
  const statusText = statusIndicator.querySelector('.status-text');
  const themeToggle = document.getElementById('theme-toggle');

  // --- State ---
  let isRunning = false;
  let abortController = null;
  let events = [];

  // --- Theme toggle ---
  function initTheme() {
    const saved = localStorage.getItem('smtp-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  }

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('smtp-theme', next);
  });

  initTheme();

  // --- Port preset buttons ---
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const port = btn.dataset.port;
      const security = btn.dataset.security;

      portInput.value = port;
      document.getElementById(`security-${security}`).checked = true;

      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // --- Port input change ---
  portInput.addEventListener('input', () => {
    const port = parseInt(portInput.value);

    // Update preset button active state
    presetBtns.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.port) === port);
    });
  });

  // --- Security change ---
  securityRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      // Future: could sync port preset buttons here
    });
  });


  // --- Auth toggle ---
  authToggle.addEventListener('change', () => {
    authFields.classList.toggle('hidden', !authToggle.checked);
  });

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

  // --- Copy to clipboard ---
  btnCopy.addEventListener('click', async () => {
    if (events.length === 0) return;

    const text = events.map(e => {
      const prefixes = { sent: 'C:', received: 'S:', info: 'ℹ', error: '✖', tls: '🔒', complete: '✔' };
      const time = new Date(e.timestamp).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      return `[${time}] ${prefixes[e.type] || '·'} ${e.data}`;
    }).join('\n');

    try {
      await navigator.clipboard.writeText(text);
      // Brief visual feedback
      const origTitle = btnCopy.title;
      btnCopy.title = 'Copied!';
      btnCopy.style.color = 'var(--text-link)';
      setTimeout(() => {
        btnCopy.title = origTitle;
        btnCopy.style.color = '';
      }, 1500);
    } catch (e) {
      // Fallback for older browsers
      console.warn('Clipboard write failed:', e);
    }
  });

  // --- Clear button ---
  btnClear.addEventListener('click', () => {
    clearTerminal();
  });

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    // Ctrl+Enter → Run test
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      if (!isRunning) {
        form.requestSubmit();
      }
    }
    // Ctrl+K → Clear log
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      clearTerminal();
    }
    // Escape → Stop running test
    if (e.key === 'Escape' && isRunning && abortController) {
      abortController.abort();
    }
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
    const securityValue = document.querySelector('input[name="security"]:checked').value;
    const config = {
      host: hostInput.value.trim(),
      port: parseInt(portInput.value),
      security: securityValue,
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
    if (!config.mailFrom) {
      mailFromInput.focus();
      return;
    }
    if (!config.rcptTo) {
      rcptToInput.focus();
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
    btnCopy.disabled = true;
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
              appendLogLine(event.type, event.timestamp, event.data, event.elapsed);
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
    btnCopy.disabled = events.length === 0;

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

  function appendLogLine(type, timestamp, data, elapsed) {
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

    // Add timing badge if available
    if (elapsed !== undefined && elapsed !== null) {
      const timingSpan = document.createElement('span');
      timingSpan.className = 'log-timing';
      timingSpan.textContent = `${elapsed}ms`;
      line.appendChild(timingSpan);
    }

    terminalLog.appendChild(line);

    // Auto-scroll to bottom
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  function clearTerminal() {
    terminalLog.innerHTML = '';
    events = [];
    btnExport.disabled = true;
    btnCopy.disabled = true;
    setStatus('', 'Ready');

    // Re-add welcome message (using DOM methods for XSS consistency)
    const welcome = document.createElement('div');
    welcome.className = 'terminal-welcome';

    const p1 = document.createElement('p');
    const strong1 = document.createElement('strong');
    strong1.textContent = 'SMTP Tester';
    p1.textContent = 'Welcome to ';
    p1.appendChild(strong1);

    const p2 = document.createElement('p');
    p2.className = 'dim';
    const strong2 = document.createElement('strong');
    strong2.textContent = 'Run Test';
    p2.textContent = 'Configure your SMTP server settings and click ';
    p2.appendChild(strong2);
    p2.appendChild(document.createTextNode(' to start.'));

    const p3 = document.createElement('p');
    p3.className = 'dim';
    p3.textContent = 'The SMTP conversation will appear here in real-time.';

    welcome.appendChild(p1);
    welcome.appendChild(p2);
    welcome.appendChild(p3);
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
})();
