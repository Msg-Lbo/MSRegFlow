// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXECUTE_STEP' || message.type === 'FILL_CODE' || message.type === 'STEP6_FIND_AND_CLICK' || message.type === 'WAIT_FOR_SURFACE' || message.type === 'RESEND_VERIFICATION_CODE' || message.type === 'RECOVER_PASSWORD_TIMEOUT' || message.type === 'SELECT_ADD_PHONE_COUNTRY' || message.type === 'FILL_ADD_PHONE_NUMBER' || message.type === 'FILL_ADD_PHONE_CODE' || message.type === 'CHECK_ADD_PHONE_SURFACE') {
    const reportedStep = Number(message.step || message?.payload?.step || 0) || null;
    resetStopState();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
          log(`Step ${reportedStep || 6}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.type === 'STEP6_FIND_AND_CLICK') {
        log(`Step 6: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'RESEND_VERIFICATION_CODE') {
        log(`Step ${reportedStep || 'surface'}: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'WAIT_FOR_SURFACE') {
        log(`Step ${reportedStep || 'surface'}: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'RECOVER_PASSWORD_TIMEOUT') {
        log(`Step ${reportedStep || 3}: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'SELECT_ADD_PHONE_COUNTRY') {
        log(`add-phone: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      if (message.type === 'FILL_ADD_PHONE_NUMBER' || message.type === 'FILL_ADD_PHONE_CODE' || message.type === 'CHECK_ADD_PHONE_SURFACE') {
        log(`add-phone: ${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      reportError(reportedStep, err.message);
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
        case 6: return await step5_fillNameBirthday(message.payload, 6);
        case 7: return await step6_findAndClick(message.payload);
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
    case 'SELECT_ADD_PHONE_COUNTRY':
      return await selectAddPhoneCountry(message.payload);
    case 'FILL_ADD_PHONE_NUMBER':
      return await fillAddPhonePhoneNumber(message.payload);
    case 'FILL_ADD_PHONE_CODE':
      return await fillAddPhoneSmsCode(message.payload);
    case 'CHECK_ADD_PHONE_SURFACE':
      return {
        isAddPhoneSurface: isAddPhoneSurface(),
        url: location.href,
      };
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

  if (isAddPhoneSurface()) {
    throw new Error('在点击 OAuth 同意按钮前检测到手机验证页面。URL: ' + location.href);
  }

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

/**
 * 判断当前是否处于 add-phone 手机验证页面。
 * @returns {boolean}
 */
function isAddPhonePhoneEntrySurface() {
  if (/\/add-phone/i.test(location.pathname)) return true;
  const phoneInput = document.querySelector('input[name="phone"], input[type="tel"]');
  const countrySelect = document.querySelector('select[name="country"], select[id*="country"]');
  const countryTrigger = document.querySelector('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]');
  const countryListbox = document.querySelector('[role="listbox"]');
  return Boolean(phoneInput && (countrySelect || countryTrigger || countryListbox));
}

function isAddPhoneCodeVerificationSurface() {
  if (/\/phone-verification/i.test(location.pathname)) return true;
  if (document.querySelector('form[action*="/phone-verification"]')) return true;

  const codeSurface = getAddPhoneCodeSurface();
  if (!codeSurface) return false;

  const validateButton = document.querySelector(
    'button[name="intent"][value="validate"], button[type="submit"][name="intent"][value="validate"], button[type="submit"]'
  );
  return Boolean(validateButton);
}

function isAddPhoneSurface() {
  return isAddPhonePhoneEntrySurface() || isAddPhoneCodeVerificationSurface();
}

/**
 * 标准化国家名称文本，便于中英文和空格差异匹配。
 * @param {string} rawText
 * @returns {string}
 */
function normalizeCountryToken(rawText) {
  return String(rawText || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/**
 * 从 HeroSMS 国家信息中提取候选匹配词。
 * @param {Object} payload
 * @returns {string[]}
 */
function collectAddPhoneCountryTokens(payload = {}) {
  const meta = payload?.countryMeta && typeof payload.countryMeta === 'object'
    ? payload.countryMeta
    : {};

  const rawValues = [
    payload?.countryName,
    meta.displayName,
    meta.chn,
    meta.eng,
    meta.rus,
  ];

  const tokens = new Set();
  for (const raw of rawValues) {
    const normalized = normalizeCountryToken(raw);
    if (normalized.length >= 2) {
      tokens.add(normalized);
    }
  }

  return [...tokens];
}

/**
 * 在 add-phone 国家下拉中匹配 HeroSMS 所选地区。
 * @param {HTMLSelectElement} countrySelect
 * @param {Object} payload
 * @returns {HTMLOptionElement | null}
 */
function findAddPhoneCountryOption(countrySelect, payload = {}) {
  const targetTokens = collectAddPhoneCountryTokens(payload);
  if (!targetTokens.length) {
    return null;
  }

  let fuzzyMatched = null;
  for (const option of countrySelect.options) {
    const optionLabel = String(option.textContent || option.innerText || '').trim();
    const optionToken = normalizeCountryToken(optionLabel);
    if (!optionToken) continue;

    for (const token of targetTokens) {
      if (optionToken === token) {
        return option;
      }
      if (!fuzzyMatched && (optionToken.includes(token) || token.includes(optionToken))) {
        fuzzyMatched = option;
      }
    }
  }

  return fuzzyMatched;
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function collectAddPhoneCountryDialCodes(payload = {}) {
  const meta = payload?.countryMeta && typeof payload.countryMeta === 'object'
    ? payload.countryMeta
    : {};

  const values = [
    payload?.dialCode,
    meta.dialCode,
    meta.phoneCode,
    meta.phone_code,
    meta.prefix,
  ];

  const dialCodes = new Set();
  for (const value of values) {
    const normalized = normalizeDialCodeValue(value);
    if (normalized) {
      dialCodes.add(normalized);
    }
  }

  return [...dialCodes];
}

function getAddPhoneCountryListbox() {
  const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
  for (const listbox of listboxes) {
    if (!isElementVisible(listbox)) continue;
    if (listbox.querySelector('[role="option"]')) return listbox;
  }

  for (const listbox of listboxes) {
    if (isElementVisible(listbox)) return listbox;
  }

  return null;
}

function findAddPhoneCountryTrigger() {
  const phoneInput = getAddPhonePhoneInput() || document.querySelector('input[name="phone"], input[type="tel"]');
  const scope = phoneInput?.closest('form') || document;

  const rawCandidates = Array.from(new Set([
    ...scope.querySelectorAll('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]'),
    ...scope.querySelectorAll('button, [role="button"]'),
  ]));

  let best = null;
  let bestScore = -Infinity;

  for (const candidate of rawCandidates) {
    if (!isElementVisible(candidate)) continue;

    const text = String(candidate.textContent || '').replace(/\s+/g, ' ').trim();
    const ariaLabel = String(candidate.getAttribute('aria-label') || '').trim();
    const attrs = `${candidate.id || ''} ${candidate.className || ''} ${candidate.getAttribute('name') || ''}`.toLowerCase();

    let score = 0;
    if (candidate.getAttribute('aria-haspopup') === 'listbox') score += 6;
    if (candidate.querySelector('.PhoneInputCountryIconImg, .PhoneInputCountryIcon')) score += 5;
    if (/\+\s*\(?\s*\d{1,4}\s*\)?/.test(text)) score += 4;
    if (/country|phone|国家|地区|区号/i.test(`${text} ${ariaLabel} ${attrs}`)) score += 3;

    if (phoneInput) {
      const candidateRect = candidate.getBoundingClientRect();
      const phoneRect = phoneInput.getBoundingClientRect();
      const distance = Math.abs(candidateRect.left - phoneRect.left) + Math.abs(candidateRect.top - phoneRect.top);
      score += Math.max(0, 4 - (distance / 140));
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= 4 ? best : null;
}

async function ensureAddPhoneCountryListboxOpened() {
  let listbox = getAddPhoneCountryListbox();
  if (listbox) return listbox;

  const trigger = findAddPhoneCountryTrigger();
  if (!trigger) return null;

  await humanPause(150, 320);
  simulateClick(trigger);

  for (let i = 0; i < 10; i++) {
    await sleep(100);
    listbox = getAddPhoneCountryListbox();
    if (listbox) return listbox;
  }

  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
  trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));

  for (let i = 0; i < 8; i++) {
    await sleep(100);
    listbox = getAddPhoneCountryListbox();
    if (listbox) return listbox;
  }

  return null;
}

function getAddPhoneListboxOptionLabel(option) {
  return String(option?.textContent || option?.innerText || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findAddPhoneCountryOptionInListbox(listbox, payload = {}) {
  if (!listbox) return null;

  const targetTokens = collectAddPhoneCountryTokens(payload);
  const targetDialCodes = collectAddPhoneCountryDialCodes(payload);

  let fuzzyMatched = null;
  let dialMatched = null;

  const options = Array.from(listbox.querySelectorAll('[role="option"]'));
  for (const option of options) {
    const label = getAddPhoneListboxOptionLabel(option);
    const optionToken = normalizeCountryToken(label);
    if (!optionToken) continue;

    for (const token of targetTokens) {
      if (optionToken === token) {
        return option;
      }
      if (!fuzzyMatched && (optionToken.includes(token) || token.includes(optionToken))) {
        fuzzyMatched = option;
      }
    }

    if (!dialMatched && targetDialCodes.length) {
      const optionDialCode = normalizeDialCodeValue(extractDialCodeFromCountryLabel(label));
      if (optionDialCode && targetDialCodes.includes(optionDialCode)) {
        dialMatched = option;
      }
    }
  }

  return fuzzyMatched || dialMatched;
}

async function findAddPhoneCountryOptionByScroll(listbox, payload = {}) {
  let matched = findAddPhoneCountryOptionInListbox(listbox, payload);
  if (matched) return matched;

  const scrollContainer = listbox;
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  if (maxScrollTop <= 0) {
    return null;
  }

  const scrollStep = Math.max(140, Math.floor(scrollContainer.clientHeight * 0.85));

  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(120);

  matched = findAddPhoneCountryOptionInListbox(scrollContainer, payload);
  if (matched) return matched;

  let guard = 0;
  while (scrollContainer.scrollTop < maxScrollTop - 2 && guard < 120) {
    const nextTop = Math.min(maxScrollTop, scrollContainer.scrollTop + scrollStep);
    if (nextTop <= scrollContainer.scrollTop) break;

    scrollContainer.scrollTop = nextTop;
    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(120);

    matched = findAddPhoneCountryOptionInListbox(scrollContainer, payload);
    if (matched) return matched;

    guard += 1;
  }

  return null;
}

/**
 * 在 add-phone 页面自动切换国家/地区。
 * @param {Object} payload
 * @returns {Promise<{matched:boolean, selectedCountryLabel?:string, selectedCountryValue?:string, url:string}>}
 */
async function selectAddPhoneCountry(payload = {}) {
  await ensureAuthSurfaceReady('add-phone', 15000);

  if (!isAddPhonePhoneEntrySurface()) {
    return {
      matched: false,
      url: location.href,
    };
  }

  const countrySelect = document.querySelector('select[name="country"], select[id*="country"]');
  if (countrySelect && countrySelect.options && countrySelect.options.length) {
    const matchedOption = findAddPhoneCountryOption(countrySelect, payload);
    if (!matchedOption) {
      const fallbackTarget = String(
        payload?.countryMeta?.displayName
        || payload?.countryMeta?.chn
        || payload?.countryMeta?.eng
        || payload?.countryMeta?.rus
        || payload?.countryId
        || ''
      ).trim();

      const availableSamples = Array.from(countrySelect.options)
        .slice(0, 8)
        .map(option => String(option.textContent || option.innerText || '').trim())
        .filter(Boolean)
        .join(', ');

      throw new Error(
        `未找到与 HeroSMS 地区匹配的国家选项：${fallbackTarget || '[unknown]'}。URL: ${location.href}。`
        + `可用选项示例：${availableSamples || 'N/A'}`
      );
    }

    fillSelect(countrySelect, matchedOption.value);
    await sleep(120);

    const selectedCountryLabel = String(matchedOption.textContent || matchedOption.innerText || '').trim();
    const selectedCountryValue = String(matchedOption.value || '').trim();
    log(`add-phone: Selected country ${selectedCountryLabel} (${selectedCountryValue})`, 'ok');

    return {
      matched: true,
      selectedCountryLabel,
      selectedCountryValue,
      url: location.href,
    };
  }

  const listbox = await ensureAddPhoneCountryListboxOpened();
  if (!listbox) {
    throw new Error('未找到手机验证页面的国家选择控件。URL: ' + location.href);
  }

  const matchedListboxOption = await findAddPhoneCountryOptionByScroll(listbox, payload);
  if (!matchedListboxOption) {
    const fallbackTarget = String(
      payload?.countryMeta?.displayName
      || payload?.countryMeta?.chn
      || payload?.countryMeta?.eng
      || payload?.countryMeta?.rus
      || payload?.countryId
      || ''
    ).trim();

    const availableSamples = Array.from(listbox.querySelectorAll('[role="option"]'))
      .slice(0, 8)
      .map(option => getAddPhoneListboxOptionLabel(option))
      .filter(Boolean)
      .join(', ');

    throw new Error(
      `未找到与 HeroSMS 地区匹配的国家选项：${fallbackTarget || '[unknown]'}。URL: ${location.href}。`
      + `当前可见选项示例：${availableSamples || 'N/A'}`
    );
  }

  matchedListboxOption.scrollIntoView({ block: 'nearest' });
  await sleep(80);
  simulateClick(matchedListboxOption);
  await sleep(120);

  const selectedCountryLabel = getAddPhoneListboxOptionLabel(matchedListboxOption);
  const selectedCountryValue = String(
    matchedListboxOption.getAttribute('data-key')
    || matchedListboxOption.id
    || ''
  ).trim();
  log(`add-phone: Selected country ${selectedCountryLabel} (${selectedCountryValue || '--'})`, 'ok');

  return {
    matched: true,
    selectedCountryLabel,
    selectedCountryValue,
    url: location.href,
  };
}

function isInteractiveInput(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.type === 'hidden') return false;
  return true;
}

function getAddPhonePhoneInput() {
  const selectors = [
    'input[name="phone"]',
    'input[type="tel"]',
    'input[inputmode="tel"]',
    'input[autocomplete="tel"]',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (isInteractiveInput(el)) return el;
  }

  return null;
}

function getAddPhoneCodeSurface() {
  const singleSelectors = [
    'input[name="code"]',
    'input[name="otp"]',
    'input[autocomplete="one-time-code"]',
    'input[aria-label*="code" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="验证码"]',
    'input[inputmode="numeric"][maxlength]:not([maxlength="1"])',
  ];

  for (const selector of singleSelectors) {
    const el = document.querySelector(selector);
    if (!isInteractiveInput(el)) continue;

    const inputName = String(el.name || el.id || '').toLowerCase();
    if (inputName.includes('phone')) continue;
    return {
      mode: 'single',
      input: el,
      inputs: [el],
    };
  }

  const singleDigitInputs = Array.from(document.querySelectorAll('input[maxlength="1"]'))
    .filter(isInteractiveInput);
  if (singleDigitInputs.length >= 4) {
    return {
      mode: 'multi',
      input: null,
      inputs: singleDigitInputs,
    };
  }

  return null;
}

function findAddPhoneActionButton(pattern) {
  const candidates = Array.from(document.querySelectorAll('button[type="submit"], button, [role="button"]'));
  for (const node of candidates) {
    const text = String(node.textContent || '').trim();
    if (!text || !pattern.test(text)) continue;
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
    return node;
  }
  return document.querySelector('button[type="submit"]');
}

function extractDialCodeFromCountryLabel(text) {
  const match = String(text || '').match(/\+\s*\(?\s*(\d{1,4})\s*\)?/);
  return match ? match[1] : '';
}

function normalizeDialCodeValue(rawValue) {
  let digits = String(rawValue || '').replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  return digits;
}

function collectAddPhoneDialCodes(countrySelect, countryMeta = {}) {
  const selectedLabel = String(countrySelect?.selectedOptions?.[0]?.textContent || '').trim();
  const candidates = new Set();

  const values = [
    countryMeta?.dialCode,
    countryMeta?.phoneCode,
    extractDialCodeFromCountryLabel(selectedLabel),
  ];

  for (const value of values) {
    const digits = normalizeDialCodeValue(value);
    if (digits) {
      candidates.add(digits);
    }
  }

  return [...candidates].sort((a, b) => b.length - a.length);
}

function prefersInternationalPhoneInput(phoneInput) {
  const text = `${phoneInput?.placeholder || ''} ${phoneInput?.value || ''}`.toLowerCase();
  return /\+\d|international|country\s*code|国家码|区号/.test(text);
}

function buildAddPhoneNumberCandidates(rawPhone, countrySelect, countryMeta = {}, phoneInput = null) {
  const normalizedRaw = String(rawPhone || '').trim();
  let digits = normalizedRaw.replace(/\D/g, '');
  if (normalizedRaw.startsWith('00')) {
    digits = digits.slice(2);
  }

  const withPlus = digits ? `+${digits}` : '';
  const localCandidates = [];

  const dialCodes = collectAddPhoneDialCodes(countrySelect, countryMeta);
  for (const dialCode of dialCodes) {
    if (!digits.startsWith(dialCode)) continue;
    const local = digits.slice(dialCode.length);
    if (local.length >= 4) {
      localCandidates.push(local);
    }
  }

  const ordered = prefersInternationalPhoneInput(phoneInput)
    ? [withPlus, digits, ...localCandidates, normalizedRaw]
    : [...localCandidates, digits, withPlus, normalizedRaw];

  return ordered
    .map(item => String(item || '').trim())
    .filter((item, index, list) => item && list.indexOf(item) === index);
}

function detectAddPhoneInputErrorText() {
  const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const patterns = [
    /invalid phone/i,
    /phone number is invalid/i,
    /please enter a valid/i,
    /手机号无效/i,
    /号码无效/i,
    /请输入有效/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }

  return '';
}

async function waitForAddPhoneCodeSurface(timeout = 14000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const surface = getAddPhoneCodeSurface();
    if (surface) {
      return {
        found: true,
        ...surface,
        url: location.href,
      };
    }

    await sleep(140);
  }

  return {
    found: false,
    url: location.href,
  };
}

async function fillAddPhonePhoneNumber(payload = {}) {
  await ensureAuthSurfaceReady('add-phone-number', 15000);
  const existingCodeSurface = getAddPhoneCodeSurface();
  if (existingCodeSurface) {
    return {
      submitted: true,
      alreadyWaitingCode: true,
      codeSurface: true,
      url: location.href,
    };
  }

  if (!isAddPhonePhoneEntrySurface()) {
    throw new Error('当前不在手机验证页面，无法填写手机号。URL: ' + location.href);
  }

  const rawPhone = String(payload?.phoneNumber || '').trim();
  if (!rawPhone) {
    throw new Error('未提供 HeroSMS 手机号。');
  }

  const countrySelect = document.querySelector('select[name="country"], select[id*="country"]');
  const phoneInput = getAddPhonePhoneInput() || await waitForElement(
    'input[name="phone"], input[type="tel"], input[inputmode="tel"], input[autocomplete="tel"]',
    10000
  );

  const candidates = buildAddPhoneNumberCandidates(rawPhone, countrySelect, payload?.countryMeta || {}, phoneInput);
  if (!candidates.length) {
    throw new Error(`HeroSMS 手机号格式无效：${rawPhone}`);
  }

  let lastFailure = '';
  const maxCandidates = Math.min(3, candidates.length);

  for (let index = 0; index < maxCandidates; index++) {
    const candidate = candidates[index];

    fillInput(phoneInput, candidate);
    await sleep(120);

    const submitButton = findAddPhoneActionButton(/发送|获取|下一步|继续|提交|send|next|continue|submit|verify|code/i);
    if (submitButton) {
      await waitForButtonEnabled(submitButton, 5000).catch(() => {});
      await humanPause(320, 820);
      simulateClick(submitButton);
    } else {
      phoneInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      phoneInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }

    const codeSurface = await waitForAddPhoneCodeSurface(index === 0 ? 14000 : 8000);
    if (codeSurface.found) {
      log(`add-phone: Phone submitted with candidate ${candidate}.`, 'ok');
      return {
        submitted: true,
        candidate,
        codeSurface: true,
        url: location.href,
      };
    }

    const hint = detectAddPhoneInputErrorText();
    lastFailure = `手机号候选 ${candidate} 未进入短信验证码页面。${hint ? `页面提示：${hint}。` : ''}`;

    if (!hint || index === maxCandidates - 1) {
      break;
    }

    await sleep(300);
  }

  throw new Error(`${lastFailure || '手机验证页面提交手机号失败。'} URL: ${location.href}`);
}

function fillAddPhoneCodeInputs(surface, code) {
  if (surface.mode === 'single' && surface.input) {
    fillInput(surface.input, code);
    return;
  }

  const digits = String(code || '').trim().split('');
  const targets = Array.isArray(surface.inputs) ? surface.inputs : [];
  for (let i = 0; i < targets.length && i < digits.length; i++) {
    fillInput(targets[i], digits[i]);
  }
}

async function fillAddPhoneSmsCode(payload = {}) {
  const code = String(payload?.code || '').trim();
  if (!code) {
    throw new Error('未提供 HeroSMS 短信验证码。');
  }

  await ensureAuthSurfaceReady('add-phone-code', 15000);

  const surface = await waitForAddPhoneCodeSurface(15000);
  if (!surface.found) {
    throw new Error('未找到手机验证页面的短信验证码输入框。URL: ' + location.href);
  }

  fillAddPhoneCodeInputs(surface, code);
  await sleep(120);

  const beforeUrl = location.href;

  const submitButton = findAddPhoneActionButton(/验证|确认|继续|下一步|提交|完成|verify|confirm|continue|next|submit|done/i);
  if (submitButton) {
    await waitForButtonEnabled(submitButton, 5000).catch(() => {});
    await humanPause(320, 820);
    simulateClick(submitButton);
  }

  try {
    await waitForUrlChange(beforeUrl, 12000);
  } catch {}

  log('add-phone: SMS code submitted.', 'ok');
  return {
    submitted: true,
    urlBefore: beforeUrl,
    urlAfter: location.href,
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

async function step5_fillNameBirthday(payload, reportedStep = 5) {
  const step = Number(reportedStep || 5);
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('No name data provided.');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('No birthday or age data provided.');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`Step ${step}: Filling name: ${fullName}`);

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
  log(`Step ${step}: Name filled: ${fullName}`);

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
      log(`Step ${step}: Birthday fields detected, filling birthday...`);

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
      log(`Step ${step}: Birthday filled: ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step ${step}: Hidden birthday input set: ${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('Age field detected, but no age data provided.');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`Step ${step}: Age filled: ${resolvedAge}`);

    // Some age-mode pages still submit a hidden birthday field.
    // Keep it aligned with generated data so backend validation won't reject.
    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday && hasBirthdayData) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Step ${step}: Hidden birthday input set (age mode): ${dateStr}`);
    }
  } else {
    throw new Error('Could not find birthday or age input. URL: ' + location.href);
  }

  // Click "完成帐户创建" button
  await sleep(250);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);

  // Report complete BEFORE submit (page navigates to add-phone after this)
  reportComplete(step);

  if (completeBtn) {
    await humanPause(500, 1300);
    simulateClick(completeBtn);
    log(`Step ${step}: Clicked "完成帐户创建"`);
  }
}
