// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP6_FIND_AND_CLICK' || message.type === 'WAIT_FOR_SURFACE' || message.type === 'RESEND_VERIFICATION_CODE' || message.type === 'RECOVER_PASSWORD_TIMEOUT') {
    resetStopState();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
          log(`Step ${message.step || 6}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.type === 'STEP6_FIND_AND_CLICK') {
        log(`Step 6: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'RESEND_VERIFICATION_CODE') {
        log(`Step ${message.step}: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'RECOVER_PASSWORD_TIMEOUT') {
        log(`Step ${message.step || 3}: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister();
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 6: return await step6_findAndClick(message.payload);
        default: throw new Error(`signup-page.js does not handle step ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup verification code
      return await fillVerificationCode(message.step, message.payload);
    case 'STEP6_FIND_AND_CLICK':
      return await step6_findAndClick(message.payload);
    case 'WAIT_FOR_SURFACE':
      return await waitForSurfacePayload(message.payload);
    case 'RESEND_VERIFICATION_CODE':
      return await resendVerificationCode(message.step, message.payload);
    case 'RECOVER_PASSWORD_TIMEOUT':
      return await recoverPasswordTimeoutFromBackground(message.payload);
  }
}

async function recoverPasswordTimeoutFromBackground(payload = {}) {
  const recovered = await recoverPasswordAfterTimeout({
    fallbackPassword: payload.password || '',
    context: 'background-step3-retry',
  });
  return { recovered, url: location.href };
}

async function ensureAuthSurfaceReady(step, timeout = 15000) {
  await waitForDocumentReady('interactive', timeout);
  await sleep(140);
  log(`Step ${step}: Page ready state is ${document.readyState}`);
}

async function waitForAnySelector(selectors, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return { element: el, selector };
    }
    await sleep(120);
  }
  return null;
}

async function waitForPostClickTransition(step, previousUrl, selectors, timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    if (location.href !== previousUrl) {
      await waitForDocumentReady('interactive', 5000).catch(() => {});
      log(`Step ${step}: URL changed after click to ${location.href}`);
      return { type: 'url', value: location.href };
    }

    const found = await waitForAnySelector(selectors, 400);
    if (found) {
      log(`Step ${step}: Next page surface detected via ${found.selector}`);
      return { type: 'selector', value: found.selector };
    }
  }

  throw new Error(`Step ${step}: Page did not transition in time after click. URL: ${location.href}`);
}

async function waitForSurfacePayload(payload = {}) {
  const {
    step = 'surface',
    selectors = [],
    timeout = 15000,
    minReadyState = 'interactive',
  } = payload;

  await ensureAuthSurfaceReady(step, timeout);
  if (!selectors.length) {
    return { readyState: document.readyState, url: location.href };
  }

  const found = await waitForAnySelector(selectors, timeout);
  if (!found) {
    throw new Error(`Step ${step}: Expected next page surface not found within ${timeout}ms. URL: ${location.href}`);
  }

  log(`Step ${step}: Surface confirmed by ${found.selector} at readyState ${document.readyState}`);
  return {
    selector: found.selector,
    readyState: document.readyState,
    url: location.href,
    minReadyState,
  };
}

// ============================================================
// Step 2: Click Register
// ============================================================

async function step2_clickRegister() {
  await ensureAuthSurfaceReady(2);
  log('Step 2: Looking for Register/Sign up button...');

  let registerBtn = null;
  try {
    registerBtn = await waitForElementByText(
      'a, button, [role="button"], [role="link"]',
      /sign\s*up|register|create\s*account|注册/i,
      10000
    );
  } catch {
    // Some pages may have a direct link
    try {
      registerBtn = await waitForElement('a[href*="signup"], a[href*="register"]', 5000);
    } catch {
      throw new Error(
        'Could not find Register/Sign up button. ' +
        'Check auth page DOM in DevTools. URL: ' + location.href
      );
    }
  }

  await humanPause(450, 1200);
  const previousUrl = location.href;
  simulateClick(registerBtn);
  log('Step 2: Clicked Register button');
  await waitForPostClickTransition(2, previousUrl, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[type="password"]',
    'input[name="name"]',
    'input[name="code"]',
  ], 15000);
  reportComplete(2);
}

// ============================================================
// Step 3: Fill Email & Password
// ============================================================

const PASSWORD_RETRY_ATTEMPTS_KEY = '__multipage_password_retry_attempts';

function isCreateAccountPasswordPage() {
  return /\/create-account\/password/i.test(location.pathname)
    || Boolean(document.querySelector('form[action*="/create-account/password"]'));
}

function getPasswordRetryAttempts() {
  try {
    return Number(window.sessionStorage.getItem(PASSWORD_RETRY_ATTEMPTS_KEY) || '0');
  } catch {
    return 0;
  }
}

function setPasswordRetryAttempts(value) {
  try {
    window.sessionStorage.setItem(PASSWORD_RETRY_ATTEMPTS_KEY, String(Math.max(0, Number(value) || 0)));
  } catch {}
}

function findPasswordErrorRetryButton() {
  const direct = document.querySelector('button[data-dd-action-name="Try again"]');
  if (direct) return direct;

  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.find((button) => /重试|try\s*again|retry/i.test((button.textContent || '').trim())) || null;
}

function isPasswordTimeoutErrorSurfacePresent() {
  const titleText = String(document.querySelector('h1, [role="heading"]')?.textContent || '').trim();
  const subtitleText = String(document.querySelector('._subtitle_o5zvr_13, [class*="subtitle"]')?.textContent || '').trim();
  const fullText = `${titleText} ${subtitleText}`.trim();
  return /糟糕|出错|error|oops|timed out|timeout/i.test(fullText);
}

async function getPasswordForRecovery(fallbackPassword = '') {
  const preferred = String(fallbackPassword || '').trim();
  if (preferred) return preferred;

  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'signup-page' });
    return String(state?.password || '').trim();
  } catch {
    return '';
  }
}

function canAttemptPasswordRecoveryFromState(state) {
  const statuses = state?.stepStatuses || {};
  const step3 = statuses[3];
  const step4 = statuses[4];
  const step5 = statuses[5];

  if (step5 === 'running' || step5 === 'completed') return false;
  if (step3 === 'completed' || step3 === 'running') return true;
  if (step4 === 'pending' || step4 === 'running' || step4 === 'failed') return true;
  return false;
}

async function recoverPasswordAfterTimeout(options = {}) {
  const { fallbackPassword = '', context = 'unknown' } = options;

  if (!isCreateAccountPasswordPage()) return false;

  const attempts = getPasswordRetryAttempts();
  if (attempts >= 3) {
    log(`Step 3: Password timeout recovery skipped (attempt limit reached, context=${context}).`, 'warn');
    return false;
  }

  let state = null;
  try {
    state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'signup-page' });
  } catch {}

  if (state && !canAttemptPasswordRecoveryFromState(state)) {
    return false;
  }

  const retryBtn = findPasswordErrorRetryButton();
  if (retryBtn && isPasswordTimeoutErrorSurfacePresent()) {
    await humanPause(300, 800);
    simulateClick(retryBtn);
    log(`Step 3: Password page timed out. Clicked "重试" (context=${context}).`, 'warn');
    await sleep(1200);
  }

  const passwordInput = document.querySelector('input[type="password"], input[name="password"]');
  if (!passwordInput) {
    return false;
  }

  const password = await getPasswordForRecovery(fallbackPassword);
  if (!password) {
    log('Step 3: Password recovery skipped because no saved password was found.', 'warn');
    return false;
  }

  if (!String(passwordInput.value || '').trim()) {
    await humanPause(280, 760);
    fillInput(passwordInput, password);
    log('Step 3: Refilled password after retry.');
  }

  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步|注册|创建|create|sign\s*up/i, 4000).catch(() => null);

  if (!submitBtn) {
    return false;
  }

  setPasswordRetryAttempts(attempts + 1);
  await humanPause(260, 720);
  simulateClick(submitBtn);
  log(`Step 3: Submitted password page after retry (attempt ${attempts + 1}, context=${context}).`, 'ok');
  return true;
}

async function startPasswordTimeoutRecoveryWatcher(password) {
  const startedAt = Date.now();
  const timeoutMs = 25000;

  while (Date.now() - startedAt < timeoutMs) {
    if (!isCreateAccountPasswordPage()) {
      return;
    }

    try {
      const recovered = await recoverPasswordAfterTimeout({
        fallbackPassword: password,
        context: 'post-submit-watcher',
      });
      if (recovered) {
        return;
      }
    } catch (err) {
      log(`Step 3: Password retry watcher failed: ${err.message || err}`, 'warn');
      return;
    }

    await sleep(800);
  }
}

async function autoRecoverPasswordTimeoutOnPageLoad() {
  if (!isCreateAccountPasswordPage()) return;
  await sleep(380);
  await recoverPasswordAfterTimeout({ context: 'page-load' });
}

void autoRecoverPasswordTimeoutOnPageLoad().catch((err) => {
  log(`Step 3: Auto password retry init failed: ${err.message || err}`, 'warn');
});

async function step3_fillEmailPassword(payload) {
  const { email } = payload;
  if (!email) throw new Error('No email provided. Paste email in Side Panel first.');

  await ensureAuthSurfaceReady(3);
  log(`Step 3: Filling email: ${email}`);

  // Find email input
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email"], input[placeholder*="Email"]',
      10000
    );
  } catch {
    throw new Error('Could not find email input field on signup page. URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('Step 3: Email filled');

  // Check if password field is on the same page
  let passwordInput = document.querySelector('input[type="password"]');

  if (!passwordInput) {
    // Need to submit email first to get to password page
    log('Step 3: No password field yet, submitting email first...');
    const submitBtn = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);

    if (submitBtn) {
      await humanPause(400, 1100);
      simulateClick(submitBtn);
      log('Step 3: Submitted email, waiting for password field...');
      await sleep(1200);
    }

    try {
      passwordInput = await waitForElement('input[type="password"]', 10000);
    } catch {
      throw new Error('Could not find password input after submitting email. URL: ' + location.href);
    }
  }

  if (!payload.password) throw new Error('No password provided. Step 3 requires a generated password.');
  await humanPause(600, 1500);
  fillInput(passwordInput, payload.password);
  log('Step 3: Password filled');

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  reportComplete(3, { email });

  // Submit the form (page will navigate away after this)
  await sleep(250);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(500, 1300);
    simulateClick(submitBtn);
    log('Step 3: Form submitted');
    void startPasswordTimeoutRecoveryWatcher(payload.password);
  }
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('No verification code provided.');

  await ensureAuthSurfaceReady(step);
  log(`Step ${step}: Filling verification code: ${code}`);

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(
      'input[name="code"], input[name="otp"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"], input[placeholder*="Code"], input[inputmode="numeric"]',
      10000
    );
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`Step ${step}: Found single-digit code inputs, filling individually...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      await sleep(1000);
      reportComplete(step);
      return;
    }
    throw new Error('Could not find verification code input. URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`Step ${step}: Code filled`);

  // Report complete BEFORE submit (page may navigate away)
  reportComplete(step);

  // Submit
  await sleep(250);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`Step ${step}: Verification submitted`);
  }
}

async function resendVerificationCode(step, payload = {}) {
  await ensureAuthSurfaceReady(step);
  log(`Step ${step}: Trying to resend verification code...`);

  const resendBtn = await findVerificationResendButton(payload.timeout || 10000);
  await waitForButtonEnabled(resendBtn);

  await humanPause(400, 900);
  simulateClick(resendBtn);
  await sleep(700);

  const resentAt = Date.now();
  log(`Step ${step}: Verification code resend triggered`);
  return { resentAt };
}

async function findVerificationResendButton(timeout = 10000) {
  const selector = [
    'button[type="submit"][name="intent"][value="resend"]',
    'button[name="intent"][value="resend"]',
    'button[type="submit"][value="resend"]',
  ].join(', ');

  try {
    return await waitForElement(selector, timeout);
  } catch {
    try {
      return await waitForElementByText('button', /重新发送电子邮件|重新发送|resend email|resend/i, Math.max(3000, timeout / 2));
    } catch {
      throw new Error('Could not find the resend button on the verification page. URL: ' + location.href);
    }
  }
}

// ============================================================
// Step 6: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

function isCodexConsentPage() {
  return /\/sign-in-with-chatgpt\/codex\/consent/i.test(location.pathname)
    || Boolean(document.querySelector('form[action*="/sign-in-with-chatgpt/codex/consent"]'));
}

function isAboutYouPage() {
  return /\/about-you/i.test(location.pathname)
    || Boolean(document.querySelector('form[action="/about-you"]'));
}

async function step6_findAndClick(options = {}) {
  const { dryRun = false } = options;
  await ensureAuthSurfaceReady(6);
  log('Step 6: Looking for OAuth consent "继续" button...');

  const continueBtn = await findContinueButton();
  await waitForButtonEnabled(continueBtn);

  await humanPause(350, 900);
  continueBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  continueBtn.focus();
  await sleep(120);

  const rect = getSerializableRect(continueBtn);
  const pageUrl = location.href;
  const consentPage = isCodexConsentPage();
  const aboutYouPage = isAboutYouPage();

  if (dryRun) {
    log('Step 6: Continue button probe completed (dry-run).');
    return {
      rect,
      buttonText: (continueBtn.textContent || '').trim(),
      url: pageUrl,
      isConsentPage: consentPage,
      isAboutYouPage: aboutYouPage,
      dryRun: true,
    };
  }

  await humanPause(350, 900);
  simulateClick(continueBtn);
  log('Step 6: Continue button clicked directly in page script.');

  let redirected = false;
  try {
    await waitForUrlChange(pageUrl, 2500);
    redirected = true;
  } catch {
    redirected = false;
  }

  log('Step 6: Found "继续" button and prepared debugger click coordinates.');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: pageUrl,
    urlAfter: location.href,
    isConsentPage: consentPage,
    isAboutYouPage: aboutYouPage,
    directClicked: true,
    redirected,
  };
}

async function findContinueButton() {
  try {
    return await waitForElement(
      'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107',
      10000
    );
  } catch {
    try {
      return await waitForElementByText('button', /继续|Continue/, 5000);
    } catch {
      throw new Error('Could not find "继续" button on OAuth consent page. URL: ' + location.href);
    }
  }
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('"继续" button stayed disabled for too long. URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('"继续" button has no clickable size after scrolling. URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('No birthday or age data provided.');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`Step 5: Filling name: ${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('Could not find name input. URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`Step 5: Name filled: ${fullName}`);

  let birthdayMode = false;
  let ageInput = null;

  for (let i = 0; i < 100; i++) {
    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');

    // Some pages include a hidden birthday input even though the real UI is "age".
    // In that case we must prioritize filling age to satisfy required validation.
    if (ageInput) break;

    if ((yearSpinner && monthSpinner && daySpinner) || hiddenBirthday) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('Birthday field detected, but no birthday data provided.');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');

    if (yearSpinner && monthSpinner && daySpinner) {
      log('Step 5: Birthday fields detected, filling birthday...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`Step 5: Birthday filled: ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set: ${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('Age field detected, but no age data provided.');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`Step 5: Age filled: ${resolvedAge}`);

    // Some age-mode pages still submit a hidden birthday field.
    // Keep it aligned with generated data so backend validation won't reject.
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday && hasBirthdayData) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step 5: Hidden birthday input set (age mode): ${dateStr}`);
    }
  } else {
    throw new Error('Could not find birthday or age input. URL: ' + location.href);
  }

  // Click "完成帐户创建" button
  await sleep(250);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  // Report complete BEFORE submit (page navigates to add-phone after this)
  reportComplete(5);

  if (completeBtn) {
    await humanPause(500, 1300);
    simulateClick(completeBtn);
    log('Step 5: Clicked "完成帐户创建"');
  }
}
