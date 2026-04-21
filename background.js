// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const HUMAN_STEP_DELAY_MIN = 250;
const HUMAN_STEP_DELAY_MAX = 900;
const TOTAL_STEPS = 7;
const AUTO_RUN_STEP_SEQUENCE = [1, 2, 3, 4, 5, 6, 7];
const SUB2API_POST_IMPORT_DEFAULTS = Object.freeze({
  maxConcurrency: 10,
  loadFactor: 10,
  priority: 1,
  billingMultiplier: 1,
});

initializeSessionStorageAccess().catch(() => {});
bootstrapPersistentSettings().catch((err) => {
  console.warn(LOG_PREFIX, 'Failed to bootstrap persistent settings:', err?.message || err);
});

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending',
  },
  autoRunning: false,
  autoRunCurrentRun: 0,
  autoRunTotalRuns: 1,
  autoRunPausedPhase: null,
  language: 'zh-CN',
  oauthUrl: null,
  deleteAbusedMicrosoftAccount: false,
  email: null,
  password: null,
  accounts: [], // Successfully completed accounts: { email, password, createdAt }
  lastEmailTimestamp: null,
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  oauthProvider: 'cpaauth', // 'cpaauth' or 'sub2api'
  vpsUrl: '',
  cpaManagementKey: '',
  cpaAuthState: null,
  sub2apiBaseUrl: '',
  sub2apiAdminApiKey: '',
  sub2apiSessionId: null,
  sub2apiRuntimeCredential: '',
  sub2apiSelectedGroupIds: [],
  customPassword: '',
  mailProvider: 'microsoft-manager',
  microsoftManagerUrl: '',
  microsoftManagerToken: '',
  microsoftManagerMode: 'graph',
  microsoftManagerKeyword: '',
  microsoftManagerUseAliases: false,
  blockedMicrosoftEmails: {},
};

const PERSISTENT_SETTING_KEYS = [
  'language',
  'oauthProvider',
  'vpsUrl',
  'cpaManagementKey',
  'sub2apiBaseUrl',
  'sub2apiAdminApiKey',
  'sub2apiSelectedGroupIds',
  'deleteAbusedMicrosoftAccount',
  'customPassword',
  'mailProvider',
  'microsoftManagerUrl',
  'microsoftManagerToken',
  'microsoftManagerMode',
  'microsoftManagerKeyword',
  'microsoftManagerUseAliases',
];

function normalizePersistentSettings(raw = {}) {
  return {
    language: String(raw.language || DEFAULT_STATE.language),
    oauthProvider: normalizeOauthProvider(raw.oauthProvider || DEFAULT_STATE.oauthProvider),
    vpsUrl: String(raw.vpsUrl || ''),
    cpaManagementKey: String(raw.cpaManagementKey || ''),
    sub2apiBaseUrl: String(raw.sub2apiBaseUrl || ''),
    sub2apiAdminApiKey: String(raw.sub2apiAdminApiKey || ''),
    sub2apiSelectedGroupIds: normalizeSub2apiGroupIds(raw.sub2apiSelectedGroupIds),
    deleteAbusedMicrosoftAccount: Boolean(raw.deleteAbusedMicrosoftAccount),
    customPassword: String(raw.customPassword || ''),
    mailProvider: normalizeMailProvider(raw.mailProvider || DEFAULT_STATE.mailProvider),
    microsoftManagerUrl: String(raw.microsoftManagerUrl || ''),
    microsoftManagerToken: String(raw.microsoftManagerToken || ''),
    microsoftManagerMode: normalizeMicrosoftManagerMode(raw.microsoftManagerMode || DEFAULT_STATE.microsoftManagerMode),
    microsoftManagerKeyword: String(raw.microsoftManagerKeyword || ''),
    microsoftManagerUseAliases: Boolean(raw.microsoftManagerUseAliases),
  };
}

function pickPersistentSettings(source = {}) {
  const updates = {};
  for (const key of PERSISTENT_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      updates[key] = source[key];
    }
  }
  return updates;
}

async function getPersistentSettings() {
  const stored = await chrome.storage.local.get(PERSISTENT_SETTING_KEYS);
  return normalizePersistentSettings(stored);
}

async function persistSettingsIfNeeded(source = {}) {
  const updates = pickPersistentSettings(source);
  if (!Object.keys(updates).length) return;
  await chrome.storage.local.set(updates);
}

async function bootstrapPersistentSettings() {
  const localSettings = await chrome.storage.local.get(PERSISTENT_SETTING_KEYS);
  const hasLocal = Object.keys(localSettings).some((key) => localSettings[key] !== undefined);
  if (hasLocal) return;

  const sessionSettings = await chrome.storage.session.get(PERSISTENT_SETTING_KEYS);
  const seed = pickPersistentSettings(sessionSettings);
  if (!Object.keys(seed).length) return;

  await chrome.storage.local.set(seed);
  console.log(LOG_PREFIX, 'Bootstrapped persistent settings from current session storage.');
}

async function getState() {
  const [state, persistentSettings] = await Promise.all([
    chrome.storage.session.get(null),
    getPersistentSettings(),
  ]);

  const merged = {
    ...DEFAULT_STATE,
    ...persistentSettings,
    ...state,
    stepStatuses: {
      ...DEFAULT_STATE.stepStatuses,
      ...(state.stepStatuses || {}),
    },
  };

  return {
    ...merged,
    oauthProvider: normalizeOauthProvider(merged.oauthProvider),
    mailProvider: normalizeMailProvider(merged.mailProvider),
    microsoftManagerMode: normalizeMicrosoftManagerMode(merged.microsoftManagerMode),
    sub2apiSelectedGroupIds: normalizeSub2apiGroupIds(merged.sub2apiSelectedGroupIds),
  };
}

function normalizeSub2apiGroupIds(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  const unique = new Set();
  for (const item of rawValue) {
    const normalized = String(item ?? '').trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
}

function normalizeOauthProvider(rawValue) {
  return String(rawValue || '').trim().toLowerCase() === 'sub2api' ? 'sub2api' : 'cpaauth';
}

function normalizeMailProvider(rawValue) {
  void rawValue;
  return 'microsoft-manager';
}

function isSub2apiOauthProvider(state) {
  return normalizeOauthProvider(state?.oauthProvider) === 'sub2api';
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

async function setEmailState(email) {
  await setState({ email });
  broadcastDataUpdate({ email });
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function recordCompletedAccount() {
  const state = await getState();
  const email = String(state.email || '').trim();
  const password = String(state.password || '').trim();

  if (!email) return;

  const accounts = Array.isArray(state.accounts) ? [...state.accounts] : [];
  const existingIndex = accounts.findIndex(account => String(account?.email || '').trim() === email);
  const record = {
    email,
    password,
    createdAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = {
      ...accounts[existingIndex],
      ...record,
    };
  } else {
    accounts.push(record);
  }

  await setState({ accounts });
}

async function setManualEmailState(email) {
  const trimmedEmail = String(email || '').trim();
  await setState({ email: trimmedEmail });
  broadcastDataUpdate({ email: trimmedEmail });
}

function getErrorMessage(error) {
  if (typeof error === 'string') return error;
  return String(error?.message || error || 'Unknown error');
}

function normalizeMicrosoftManagerBaseUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '';
  }
}

function normalizeMicrosoftManagerMode(rawValue) {
  const mode = String(rawValue || '').trim().toLowerCase();
  return mode === 'imap' ? 'imap' : 'graph';
}

async function requestMicrosoftManagerApi(state, path, options = {}) {
  const baseUrl = normalizeMicrosoftManagerBaseUrl(state.microsoftManagerUrl);
  if (!baseUrl) {
    throw new Error('Microsoft Account Manager URL is empty or invalid.');
  }

  const token = String(state.microsoftManagerToken || '').trim();
  if (!token) {
    throw new Error('Microsoft Account Manager token is empty.');
  }

  const url = new URL(path, `${baseUrl}/`);
  if (options.query && typeof options.query === 'object') {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      const normalizedValue = String(value).trim();
      if (!normalizedValue) continue;
      url.searchParams.set(key, normalizedValue);
    }
  }

  const headers = {
    'x-mail-api-token': token,
    ...options.headers,
  };

  const init = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url.toString(), init);
  } catch (err) {
    throw new Error(`Microsoft Account Manager request failed: ${getErrorMessage(err)}`);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = String(payload?.message || payload?.error || `${response.status} ${response.statusText}`).trim();
    throw new Error(`Microsoft Account Manager request failed: ${message}`);
  }

  return payload;
}

function normalizeMicrosoftManagerAccount(raw) {
  const id = Number(raw?.id || 0);
  const account = String(raw?.account || '').trim();
  if (!account) return null;
  return {
    id: Number.isFinite(id) ? id : 0,
    account,
    remark: String(raw?.remark || '').trim(),
  };
}

function normalizeEmailKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMicrosoftManagerAlias(raw, parentAccount = '') {
  const id = Number(raw?.id || 0);
  const aliasEmail = String(raw?.aliasEmail || raw?.email || '').trim();
  if (!aliasEmail) return null;

  return {
    id: Number.isFinite(id) ? id : 0,
    aliasEmail,
    account: String(raw?.account || parentAccount || '').trim(),
    remark: String(raw?.remark || '').trim(),
    isRegistered: Boolean(raw?.isRegistered),
  };
}

function isMicrosoftManagerRegisteredRemark(remark) {
  const value = String(remark || '').trim().toLowerCase();
  if (!value) return false;
  return value === '已注册' || value.includes('已注册') || value.includes('registered');
}

function isMicrosoftManagerBlockedRemark(remark) {
  const value = String(remark || '').trim();
  return value === '已封禁'
    || value === '封禁'
    || value === '触发手机'
    || /服务滥用|service abuse|abuse mode|add-phone|phone challenge|phone verification/i.test(value);
}

function isMicrosoftManagerAliasRegistered(alias) {
  if (!alias) return false;
  if (Boolean(alias.isRegistered)) return true;
  return isMicrosoftManagerRegisteredRemark(alias.remark);
}

function getBlockedMicrosoftEmailMap(state) {
  return state?.blockedMicrosoftEmails && typeof state.blockedMicrosoftEmails === 'object'
    ? { ...state.blockedMicrosoftEmails }
    : {};
}

function isMicrosoftEmailBlocked(blockedMap, email) {
  const exactKey = String(email || '').trim();
  const normalizedKey = normalizeEmailKey(email);
  if (!normalizedKey) return false;
  return Boolean(blockedMap[normalizedKey] || blockedMap[exactKey]);
}

function isPotentialMicrosoftAliasEmail(email) {
  const normalized = String(email || '').trim();
  const atIndex = normalized.indexOf('@');
  if (atIndex <= 0) return false;
  const localPart = normalized.slice(0, atIndex);
  return localPart.includes('+');
}

async function markMicrosoftEmailBlocked(email) {
  const normalizedEmail = String(email || '').trim();
  if (!normalizedEmail) return;

  const state = await getState();
  const blockedMap = getBlockedMicrosoftEmailMap(state);
  blockedMap[normalizeEmailKey(normalizedEmail)] = true;
  await setState({ blockedMicrosoftEmails: blockedMap });
}

async function listMicrosoftManagerAccounts(state, options = {}) {
  const keyword = String(options.keyword ?? state.microsoftManagerKeyword ?? '').trim();
  const payload = await requestMicrosoftManagerApi(state, '/api/open/accounts', {
    method: 'GET',
    query: { keyword },
  });

  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map(item => normalizeMicrosoftManagerAccount(item))
    .filter(Boolean)
    .filter(item => item.account.includes('@'));
}

async function listMicrosoftManagerAliasesByAccount(state, accountEmail) {
  const normalizedAccountEmail = String(accountEmail || '').trim();
  if (!normalizedAccountEmail) return [];

  const payload = await requestMicrosoftManagerApi(state, '/api/open/aliases', {
    method: 'GET',
    query: { account: normalizedAccountEmail },
  });

  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .map(item => normalizeMicrosoftManagerAlias(item, normalizedAccountEmail))
    .filter(Boolean);
}

function findExactMicrosoftManagerAccounts(accounts, email) {
  const normalizedEmail = normalizeEmailKey(email);
  if (!normalizedEmail) return [];

  return accounts
    .filter(item => normalizeEmailKey(item?.account) === normalizedEmail)
    .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));
}

async function deleteMicrosoftManagerAccountByEmail(state, email) {
  const accounts = await listMicrosoftManagerAccounts(state, { keyword: email });
  const matches = findExactMicrosoftManagerAccounts(accounts, email);

  if (!matches.length) {
    throw new Error(`${email} was not found in Microsoft Account Manager account list.`);
  }

  const target = matches[0];
  const id = Number(target?.id || 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`No valid account id found for ${email}.`);
  }

  await requestMicrosoftManagerApi(state, `/api/open/accounts/${id}`, {
    method: 'DELETE',
  });
}

async function updateMicrosoftManagerAccountRemarkByEmail(state, email, remark) {
  const normalizedEmail = String(email || '').trim();
  const normalizedRemark = String(remark || '').trim();

  if (!normalizedEmail) {
    throw new Error('No email was provided for Microsoft Account Manager remark update.');
  }
  if (!normalizedRemark) {
    throw new Error('No remark text was provided for Microsoft Account Manager remark update.');
  }

  const accounts = await listMicrosoftManagerAccounts(state, { keyword: normalizedEmail });
  const matches = findExactMicrosoftManagerAccounts(accounts, normalizedEmail);

  if (!matches.length) {
    throw new Error(`${normalizedEmail} was not found in Microsoft Account Manager account list.`);
  }

  const target = matches[0];
  const id = Number(target?.id || 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`No valid account id found for ${normalizedEmail}.`);
  }

  await requestMicrosoftManagerApi(state, `/api/open/accounts/${id}/remark`, {
    method: 'PATCH',
    body: { remark: normalizedRemark },
  });
}

function isMicrosoftManagerNotFoundError(message) {
  const normalized = String(message || '').trim().toLowerCase();
  return normalized.includes('404') || normalized.includes('not found') || normalized.includes('不存在');
}

async function tryUpdateMicrosoftManagerAliasStatusByEmail(state, email, payload = {}) {
  const normalizedEmail = String(email || '').trim();
  if (!normalizedEmail) return false;

  const body = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'remark')) {
    body.remark = payload.remark;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'isRegistered')) {
    body.isRegistered = Boolean(payload.isRegistered);
  }
  if (!Object.keys(body).length) {
    throw new Error('No alias status payload provided.');
  }

  const encodedEmail = encodeURIComponent(normalizedEmail);
  try {
    await requestMicrosoftManagerApi(state, `/api/open/aliases/${encodedEmail}/remark`, {
      method: 'PATCH',
      body,
    });
    return true;
  } catch (err) {
    const message = getErrorMessage(err);
    if (isMicrosoftManagerNotFoundError(message)) {
      return false;
    }
    throw err;
  }
}

async function updateMicrosoftManagerEmailStatusByEmail(state, email, payload = {}) {
  const normalizedEmail = String(email || '').trim();
  if (!normalizedEmail) {
    throw new Error('No email was provided for Microsoft status update.');
  }

  const aliasUpdated = await tryUpdateMicrosoftManagerAliasStatusByEmail(state, normalizedEmail, payload);
  if (aliasUpdated) {
    return { target: 'alias' };
  }

  const remark = String(payload?.remark || '').trim();
  if (!remark) {
    throw new Error('No remark text was provided for Microsoft account status update.');
  }

  await updateMicrosoftManagerAccountRemarkByEmail(state, normalizedEmail, remark);
  return { target: 'account' };
}

async function listMicrosoftManagerEmailCandidates(state, accounts) {
  const blockedMap = getBlockedMicrosoftEmailMap(state);
  const useAliases = Boolean(state.microsoftManagerUseAliases);
  const seenEmails = new Set();
  const stats = {
    scannedAccounts: 0,
    skippedPrimary: 0,
    scannedAliases: 0,
    skippedAliases: 0,
  };

  const normalizeCandidate = (candidate) => {
    const email = String(candidate?.email || '').trim();
    if (!email) return null;
    const key = normalizeEmailKey(email);
    if (!key || seenEmails.has(key)) return null;
    seenEmails.add(key);
    return {
      ...candidate,
      email,
      emailKey: key,
    };
  };

  for (const account of accounts) {
    stats.scannedAccounts += 1;
    const primaryEmail = String(account?.account || '').trim();
    if (!primaryEmail) continue;

    const primaryBlocked = isMicrosoftManagerRegisteredRemark(account?.remark)
      || isMicrosoftManagerBlockedRemark(account?.remark)
      || isMicrosoftEmailBlocked(blockedMap, primaryEmail);

    if (!primaryBlocked) {
      const normalizedPrimary = normalizeCandidate({
        email: primaryEmail,
        source: 'account',
        accountId: Number(account?.id || 0),
        primaryEmail,
      });
      if (normalizedPrimary) {
        return {
          selected: normalizedPrimary,
          stats,
        };
      }
    } else {
      stats.skippedPrimary += 1;
    }

    if (!useAliases) continue;

    let aliases = [];
    try {
      aliases = await listMicrosoftManagerAliasesByAccount(state, primaryEmail);
    } catch (err) {
      await addLog(`Microsoft Manager: Failed to load aliases for ${primaryEmail}, skip aliases for this account: ${getErrorMessage(err)}`, 'warn');
      continue;
    }

    for (const alias of aliases) {
      stats.scannedAliases += 1;
      const aliasEmail = String(alias?.aliasEmail || '').trim();
      if (!aliasEmail) {
        stats.skippedAliases += 1;
        continue;
      }
      if (isMicrosoftManagerAliasRegistered(alias)) {
        stats.skippedAliases += 1;
        continue;
      }
      if (isMicrosoftManagerBlockedRemark(alias?.remark)) {
        stats.skippedAliases += 1;
        continue;
      }
      if (isMicrosoftEmailBlocked(blockedMap, aliasEmail)) {
        stats.skippedAliases += 1;
        continue;
      }

      const normalizedAlias = normalizeCandidate({
        email: aliasEmail,
        source: 'alias',
        aliasId: Number(alias?.id || 0),
        accountId: Number(account?.id || 0),
        primaryEmail,
      });
      if (normalizedAlias) {
        return {
          selected: normalizedAlias,
          stats,
        };
      }
    }
  }

  return {
    selected: null,
    stats,
  };
}

async function fetchMicrosoftManagerEmail(options = {}) {
  const state = await getState();
  const accounts = await listMicrosoftManagerAccounts(state, {
    keyword: options.keyword,
  });

  if (!accounts.length) {
    throw new Error('No account found in Microsoft Account Manager.');
  }

  const { selected, stats } = await listMicrosoftManagerEmailCandidates(state, accounts);
  await addLog(
    `Microsoft Manager: Candidate scan -> accounts ${stats.scannedAccounts}, skipped primary ${stats.skippedPrimary}, aliases ${stats.scannedAliases}, skipped aliases ${stats.skippedAliases}, alias mode ${state.microsoftManagerUseAliases ? 'on' : 'off'}`
  );

  if (!selected?.email) {
    if (Boolean(state.microsoftManagerUseAliases)) {
      throw new Error('No available email found after sequential check: all primary/alias emails are marked as 已注册/已封禁 or blocked.');
    }
    throw new Error('No available account found. All Microsoft accounts are marked as 已注册/已封禁 or blocked in this run.');
  }

  await setEmailState(selected.email);
  if (selected.source === 'alias') {
    await addLog(
      `Microsoft Manager: Selected alias ${selected.email} (primary ${selected.primaryEmail || 'unknown'})`,
      'ok'
    );
  } else {
    await addLog(`Microsoft Manager: Selected account ${selected.email}`, 'ok');
  }
  return selected.email;
}

function stripHtmlTags(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractVerificationCodeFromText(text) {
  const normalized = String(text || '');

  const matchCn = normalized.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = normalized.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = normalized.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

function parseReceivedAtMs(value) {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function findMicrosoftManagerCode(messages, payload = {}) {
  const senderFilters = Array.isArray(payload.senderFilters) ? payload.senderFilters : [];
  const subjectFilters = Array.isArray(payload.subjectFilters) ? payload.subjectFilters : [];
  const filterAfterTimestamp = Number(payload.filterAfterTimestamp || 0);

  for (const message of messages) {
    const receivedAt = parseReceivedAtMs(message?.receivedAt);
    if (filterAfterTimestamp && receivedAt && receivedAt <= filterAfterTimestamp) {
      continue;
    }

    const sender = String(message?.from || '').trim().toLowerCase();
    const subject = String(message?.subject || '').trim().toLowerCase();
    const preview = String(message?.preview || '').trim();
    const content = stripHtmlTags(String(message?.content || '').trim());
    const combinedText = [subject, sender, preview, content]
      .filter(Boolean)
      .join(' ');
    const combinedLower = combinedText.toLowerCase();

    const senderMatch = senderFilters.some(filter => {
      const keyword = String(filter || '').trim().toLowerCase();
      return keyword && (sender.includes(keyword) || combinedLower.includes(keyword));
    });
    const subjectMatch = subjectFilters.some(filter => {
      const keyword = String(filter || '').trim().toLowerCase();
      return keyword && (subject.includes(keyword) || combinedLower.includes(keyword));
    });
    const keywordMatch = /openai|chatgpt|verify|verification|confirm|login|验证码|代码/.test(combinedLower);

    const code = extractVerificationCodeFromText(combinedText);
    if (!code) continue;
    if (!senderMatch && !subjectMatch && !keywordMatch) continue;

    return {
      code,
      emailTimestamp: receivedAt || Date.now(),
      mailId: String(message?.id || '').trim(),
      subject: String(message?.subject || '').trim(),
    };
  }

  return null;
}

async function pollMicrosoftManagerCode(state, step, pollPayload = {}) {
  const targetEmail = String(pollPayload.targetEmail || state.email || '').trim();
  if (!targetEmail) {
    throw new Error('No email address provided for Microsoft Account Manager polling.');
  }

  const mode = normalizeMicrosoftManagerMode(state.microsoftManagerMode);
  const maxAttempts = Math.max(1, Number(pollPayload.maxAttempts || 20));
  const intervalMs = Math.max(500, Number(pollPayload.intervalMs || 3000));

  let lastErrorMessage = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    await addLog(`Step ${step}: Polling Microsoft Account Manager... attempt ${attempt}/${maxAttempts}`);

    try {
      const payload = await requestMicrosoftManagerApi(state, '/api/open/messages', {
        method: 'POST',
        body: {
          account: targetEmail,
          mode,
        },
      });

      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const found = findMicrosoftManagerCode(messages, pollPayload);
      if (found?.code) {
        await addLog(`Step ${step}: Found code in Microsoft Account Manager (${found.subject || 'no subject'})`, 'ok');
        return {
          ok: true,
          code: found.code,
          emailTimestamp: found.emailTimestamp,
          mailId: found.mailId,
        };
      }
    } catch (err) {
      lastErrorMessage = getErrorMessage(err);
      await addLog(`Step ${step}: Microsoft Account Manager poll failed on attempt ${attempt}: ${lastErrorMessage}`, 'warn');

      if (isMicrosoftServiceAbuseError(lastErrorMessage)) {
        throw new Error(lastErrorMessage);
      }
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  const timeoutSec = (maxAttempts * intervalMs / 1000).toFixed(0);
  if (lastErrorMessage) {
    return {
      error: `No matching verification email found after ${timeoutSec}s. Last error: ${lastErrorMessage}`,
    };
  }

  return {
    error: `No matching verification email found in Microsoft Account Manager after ${timeoutSec}s.`,
  };
}

function isMicrosoftServiceAbuseError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('aadsts70000')
    || message.includes('service abuse mode')
    || message.includes('abuse mode')
    || message.includes('服务滥用');
}

function isMicrosoftPhoneChallengeError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('add-phone')
    || message.includes('/add-phone')
    || message.includes('phone challenge')
    || message.includes('phone verification')
    || message.includes('触发手机');
}

async function reopenSignupForReplacementEmail(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL available to restart signup with replacement email.');
  }
  if (!state.email) {
    throw new Error('No replacement email available to restart signup.');
  }

  await addLog('Step 4: Reopening signup flow with replacement email...', 'warn');
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  try {
    await executeStep2(state);
  } catch (err) {
    await addLog(`Step 4: Step 2 retry skipped: ${getErrorMessage(err)}`, 'warn');
  }

  await executeStep3(state);
}

async function handleMicrosoftServiceAbuseDuringStep4(state, context = {}) {
  const currentEmail = String(state.email || '').trim();
  const deleteBlocked = Boolean(state.deleteAbusedMicrosoftAccount);

  if (!currentEmail) {
    throw new Error('Current email is empty when handling blocked-account fallback.');
  }

  await addLog(`Step 4: Detected blocked account (${currentEmail}) with AADSTS70000.`, 'warn');
  await markMicrosoftEmailBlocked(currentEmail);

  const aliasEmail = isPotentialMicrosoftAliasEmail(currentEmail);

  if (deleteBlocked) {
    if (aliasEmail) {
      try {
        const result = await updateMicrosoftManagerEmailStatusByEmail(state, currentEmail, {
          remark: '已封禁',
          isRegistered: false,
        });
        await addLog(
          `Step 4: Current email is an alias and cannot be deleted directly, marked as 已封禁 (${result.target}).`,
          'warn'
        );
      } catch (err) {
        await addLog(`Step 4: Failed to mark blocked alias ${currentEmail}: ${getErrorMessage(err)}`, 'warn');
      }
    } else {
      try {
        await deleteMicrosoftManagerAccountByEmail(state, currentEmail);
        await addLog(`Step 4: Blocked email ${currentEmail} has been deleted from Microsoft Manager.`, 'ok');
      } catch (err) {
        await addLog(`Step 4: Failed to delete blocked email ${currentEmail}: ${getErrorMessage(err)}`, 'warn');
      }
    }
  } else {
    try {
      const result = await updateMicrosoftManagerEmailStatusByEmail(state, currentEmail, {
        remark: '已封禁',
        isRegistered: false,
      });
      await addLog(`Step 4: Blocked email ${currentEmail} marked as 已封禁 (${result.target}).`, 'ok');
    } catch (err) {
      await addLog(`Step 4: Failed to mark blocked email ${currentEmail}: ${getErrorMessage(err)}`, 'warn');
    }
  }

  const previousEmail = currentEmail;
  const replacementEmail = await fetchConfiguredEmail({ generateNew: true });
  if (!replacementEmail) {
    throw new Error('No replacement email available after blocked-account fallback.');
  }
  if (String(replacementEmail).trim() === previousEmail) {
    throw new Error('Replacement email is the same as blocked email. Please prepare more accounts in Microsoft Manager.');
  }

  await addLog(
    `Step 4: Switched to replacement email ${replacementEmail} (${context.round || 1}/${context.maxRounds || 1}).`,
    'ok'
  );

  const refreshed = await getState();
  await reopenSignupForReplacementEmail(refreshed);
}

async function handleMicrosoftPhoneChallengeDuringStep4(state, context = {}) {
  const shouldRestartSignup = context.restartSignup !== false;
  const currentEmail = String(state.email || '').trim();
  if (!currentEmail) {
    throw new Error('Current email is empty when handling phone-challenge fallback.');
  }

  await addLog(`Step 4: Detected add-phone challenge for ${currentEmail}. Marking as 触发手机 and switching email...`, 'warn');
  await markMicrosoftEmailBlocked(currentEmail);

  try {
    const result = await updateMicrosoftManagerEmailStatusByEmail(state, currentEmail, {
      remark: '触发手机',
      isRegistered: false,
    });
    await addLog(`Step 4: ${currentEmail} marked as 触发手机 (${result.target}).`, 'ok');
  } catch (err) {
    await addLog(`Step 4: Failed to mark ${currentEmail} as 触发手机: ${getErrorMessage(err)}`, 'warn');
  }

  const previousEmail = currentEmail;
  const replacementEmail = await fetchConfiguredEmail({ generateNew: true });
  if (!replacementEmail) {
    throw new Error('No replacement email available after add-phone fallback.');
  }
  if (String(replacementEmail).trim() === previousEmail) {
    throw new Error('Replacement email is the same as add-phone email. Please prepare more accounts/aliases in Microsoft Manager.');
  }

  await addLog(
    `Step 4: Switched to replacement email ${replacementEmail} after add-phone (${context.round || 1}/${context.maxRounds || 1}).`,
    'ok'
  );

  if (!shouldRestartSignup) {
    return;
  }

  const refreshed = await getState();
  await reopenSignupForReplacementEmail(refreshed);
}

async function fetchConfiguredEmail(options = {}) {
  return fetchMicrosoftManagerEmail(options);
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const persistentSettings = await getPersistentSettings();
  const prev = await chrome.storage.session.get([
    'seenCodes',
    'seenInbucketMailIds',
    'accounts',
    'manualAliasUsage',
    'tabRegistry',
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    ...persistentSettings,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
    manualAliasUsage: prev.manualAliasUsage && typeof prev.manualAliasUsage === 'object' ? prev.manualAliasUsage : {},
    tabRegistry: prev.tabRegistry || {},
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

    const registry = await getTabRegistry();
    if (sameUrl) {
      await chrome.tabs.update(tabId, { active: true });
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

      if (shouldReloadOnReuse) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        await chrome.tabs.reload(tabId);

        await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
          const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      // For dynamically injected pages like the CPA Auth panel, re-inject immediately.
      if (options.inject) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
        await new Promise(r => setTimeout(r, 250));
      }

      return tabId;
    }

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, { url, active: true });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (CPA Auth panel), re-inject after navigation
    if (options.inject) {
      if (options.injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [options.injectSource],
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 250));

    return tabId;
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url, active: true });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (CPA Auth panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

async function skipStep(step) {
  const stepNum = Number(step);
  if (!Number.isInteger(stepNum) || stepNum < 1 || stepNum > TOTAL_STEPS) {
    throw new Error(`Invalid step to skip: ${step}`);
  }

  const state = await getState();
  const currentStatus = state.stepStatuses?.[stepNum] || 'pending';
  if (currentStatus === 'running') {
    throw new Error(`Cannot skip step ${stepNum} while it is running.`);
  }

  await setStepStatus(stepNum, 'skipped');
  await addLog(`Step ${stepNum} skipped by user`, 'warn');
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function clearStopRequest() {
  stopRequested = false;
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 6 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 6 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

let stopRequested = false;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`Step ${message.step} stopped by user`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
        notifyStepError(message.step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setManualEmailState(message.payload.email);
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'SKIP_STEP': {
      const step = message.payload?.step;
      await skipStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setManualEmailState(message.payload.email);
      }
      await continueAutoRun();
      return { ok: true };
    }

    case 'CONTINUE_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setManualEmailState(message.payload.email);
      }
      await continueAutoRun();
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.language !== undefined) updates.language = message.payload.language;
      if (message.payload.oauthProvider !== undefined) updates.oauthProvider = normalizeOauthProvider(message.payload.oauthProvider);
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.cpaManagementKey !== undefined) updates.cpaManagementKey = message.payload.cpaManagementKey;
      if (message.payload.sub2apiBaseUrl !== undefined) {
        updates.sub2apiBaseUrl = message.payload.sub2apiBaseUrl;
        updates.sub2apiRuntimeCredential = '';
      }
      if (message.payload.sub2apiAdminApiKey !== undefined) {
        updates.sub2apiAdminApiKey = message.payload.sub2apiAdminApiKey;
        updates.sub2apiRuntimeCredential = '';
      }
      if (message.payload.sub2apiSelectedGroupIds !== undefined) {
        updates.sub2apiSelectedGroupIds = normalizeSub2apiGroupIds(message.payload.sub2apiSelectedGroupIds);
      }
      if (message.payload.deleteAbusedMicrosoftAccount !== undefined) updates.deleteAbusedMicrosoftAccount = Boolean(message.payload.deleteAbusedMicrosoftAccount);
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = normalizeMailProvider(message.payload.mailProvider);
      if (message.payload.microsoftManagerUrl !== undefined) updates.microsoftManagerUrl = message.payload.microsoftManagerUrl;
      if (message.payload.microsoftManagerToken !== undefined) updates.microsoftManagerToken = message.payload.microsoftManagerToken;
      if (message.payload.microsoftManagerMode !== undefined) updates.microsoftManagerMode = normalizeMicrosoftManagerMode(message.payload.microsoftManagerMode);
      if (message.payload.microsoftManagerKeyword !== undefined) updates.microsoftManagerKeyword = message.payload.microsoftManagerKeyword;
      if (message.payload.microsoftManagerUseAliases !== undefined) updates.microsoftManagerUseAliases = Boolean(message.payload.microsoftManagerUseAliases);
      await setState(updates);
      await persistSettingsIfNeeded(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setManualEmailState(message.payload.email);
      return { ok: true, email: message.payload.email };
    }

    case 'FETCH_AUTO_EMAIL': {
      clearStopRequest();
      const email = await fetchConfiguredEmail(message.payload || {});
      return { ok: true, email };
    }

    case 'FETCH_SUB2API_GROUPS': {
      clearStopRequest();
      const groups = await fetchSub2apiGroups();
      return { ok: true, groups };
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 6:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
    case 7:
      await recordCompletedAccount();
      await markMicrosoftManagerEmailRegisteredAfterImport();
      break;
  }
}

async function markMicrosoftManagerEmailRegisteredAfterImport() {
  const state = await getState();
  if (normalizeMailProvider(state.mailProvider) !== 'microsoft-manager') return;

  const email = String(state.email || '').trim();
  if (!email) return;

  try {
    const result = await updateMicrosoftManagerEmailStatusByEmail(state, email, {
      remark: '已注册',
      isRegistered: true,
    });
    await addLog(`Microsoft Manager: Updated status for ${email} -> 已注册 (${result.target})`, 'ok');
  } catch (err) {
    await addLog(`Microsoft Manager: Failed to update status for ${email}: ${getErrorMessage(err)}`, 'warn');
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('Stop requested. Cancelling current operations...', 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  await markRunningStepsStopped();
  autoRunActive = false;
  autoRunPausedPhase = 'stopped';
  await syncAutoRunState({ autoRunning: false });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);
  await humanStepDelay();

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    const flowStartTime = Date.now();
    await setState({ flowStartTime });
    broadcastDataUpdate({ flowStartTime });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`Step ${step} stopped by user`, 'warn');
      throw err;
    }
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  throwIfStopped();
  const promise = waitForStepComplete(step, 120000);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 450));
  }
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let autoRunPausedPhase = null;

function getAutoRunStatusMessage(phase, currentRun, totalRuns) {
  return { type: 'AUTO_RUN_STATUS', payload: { phase, currentRun, totalRuns } };
}

async function syncAutoRunState(overrides = {}) {
  await setState({
    autoRunning: autoRunActive,
    autoRunCurrentRun,
    autoRunTotalRuns,
    autoRunPausedPhase,
    ...overrides,
  });
}

function getAutoStepDelay(step) {
  const delayMap = {
    1: 1200,
    2: 1100,
    3: 1500,
    4: 1100,
    5: 1500,
    6: 900,
    7: 700,
  };
  return delayMap[step] || 0;
}

async function waitForSignupSurface(payload, timeout = 20000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const tabId = await getTabId('signup-page');
    if (!tabId) {
      throw new Error('Signup/auth tab is not available.');
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'WAIT_FOR_SURFACE',
        source: 'background',
        payload: {
          timeout: Math.min(5000, timeout),
          ...payload,
        },
      });
      if (response?.error) {
        throw new Error(response.error);
      }
      return response;
    } catch (err) {
      if (isMicrosoftPhoneChallengeError(err) || isMicrosoftServiceAbuseError(err)) {
        throw err;
      }
      lastError = err;
      await sleepWithStop(160);
    }
  }

  throw new Error(`Signup page surface wait failed: ${getErrorMessage(lastError)}`);
}

function getOauthConsentSurfaceSelectors() {
  return [
    'form[action*="/sign-in-with-chatgpt/codex/consent"]',
    'div._ctas_1maco_29',
    'button[type="submit"][data-dd-action-name="Continue"]',
    'form[action*="/consent"] button[type="submit"]',
    'a[href="https://chatgpt.com"]',
  ];
}

function getAutoResumeStep(state) {
  const statuses = state?.stepStatuses || {};

  for (const step of AUTO_RUN_STEP_SEQUENCE) {
    const status = statuses[step];
    if (status === 'failed' || status === 'stopped' || status === 'running') {
      return step;
    }
  }

  for (const step of AUTO_RUN_STEP_SEQUENCE) {
    if (statuses[step] === 'pending') {
      return step;
    }
  }

  return null;
}

async function ensureAutoRunEmailReady(run, totalRuns) {
  const currentState = await getState();
  if (currentState.email) return;

  let emailReady = false;

  try {
    const email = await fetchConfiguredEmail({ generateNew: true });
    await addLog(`=== Run ${run}/${totalRuns} — Email ready: ${email} ===`, 'ok');
    emailReady = true;
  } catch (err) {
    await addLog(`Auto email fetch failed: ${err.message}`, 'warn');
  }

  if (!emailReady) {
    const pauseHint = 'Generate or paste an email address, then continue';
    await addLog(`=== Run ${run}/${totalRuns} PAUSED: ${pauseHint} ===`, 'warn');
    autoRunPausedPhase = 'waiting_email';
    await syncAutoRunState();
    chrome.runtime.sendMessage(getAutoRunStatusMessage('waiting_email', run, totalRuns)).catch(() => {});

    await waitForResume();

    autoRunPausedPhase = null;
    await syncAutoRunState();

    const resumedState = await getState();
    if (!resumedState.email) {
      throw new Error('Cannot resume: no email address.');
    }
  }
}

async function executeAutoRunSteps(run, totalRuns, options = {}) {
  const { resumeFromCurrentState = false } = options;
  const state = await getState();
  let startStep = resumeFromCurrentState ? getAutoResumeStep(state) : 1;

  if (!startStep) return;

  if (resumeFromCurrentState) {
    await addLog(`=== Run ${run}/${totalRuns} — Resuming from step ${startStep} ===`, 'warn');
  }

  if (startStep <= 2) {
    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('running', run, totalRuns)).catch(() => {});

    for (let step = startStep; step <= 2; step++) {
      const currentState = await getState();
      const stepStatus = currentState.stepStatuses?.[step];
      if (stepStatus === 'completed' || stepStatus === 'skipped') continue;
      await executeStepAndWait(step, getAutoStepDelay(step));
    }
    startStep = 3;
  }

  let needsPhase2 = false;
  for (const step of AUTO_RUN_STEP_SEQUENCE) {
    if (step < startStep) continue;
    const stepStatus = (await getState()).stepStatuses?.[step];
    if (stepStatus !== 'completed' && stepStatus !== 'skipped') {
      needsPhase2 = true;
      break;
    }
  }

  if (!needsPhase2) return;

  await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
  chrome.runtime.sendMessage(getAutoRunStatusMessage('running', run, totalRuns)).catch(() => {});

  await ensureAutoRunEmailReady(run, totalRuns);

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
  }

  for (const step of AUTO_RUN_STEP_SEQUENCE) {
    if (step < Math.max(3, startStep)) continue;
    const currentState = await getState();
    const stepStatus = currentState.stepStatuses?.[step];
    if (stepStatus === 'completed' || stepStatus === 'skipped') continue;
    if (step === 3 && !currentState.email) {
      await ensureAutoRunEmailReady(run, totalRuns);
    }
    await executeStepAndWait(step, getAutoStepDelay(step));
  }
}

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns, options = {}) {
  const { startRun = 1, preserveCurrentRunState = false } = options;
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  autoRunPausedPhase = null;
  await syncAutoRunState({ autoRunning: true });

  for (let run = startRun; run <= totalRuns; run++) {
    autoRunCurrentRun = run;
    autoRunPausedPhase = null;
    await syncAutoRunState();

    const isResumingRun = preserveCurrentRunState && run === startRun;
    if (!isResumingRun) {
      // Reset everything at the start of each run (keep CPA Auth/mail settings)
      const prevState = await getState();
      const keepSettings = {
        oauthProvider: normalizeOauthProvider(prevState.oauthProvider),
        vpsUrl: prevState.vpsUrl,
        sub2apiBaseUrl: prevState.sub2apiBaseUrl,
        sub2apiAdminApiKey: prevState.sub2apiAdminApiKey,
        sub2apiSelectedGroupIds: normalizeSub2apiGroupIds(prevState.sub2apiSelectedGroupIds),
        mailProvider: prevState.mailProvider,
        microsoftManagerUrl: prevState.microsoftManagerUrl,
        microsoftManagerToken: prevState.microsoftManagerToken,
        microsoftManagerMode: prevState.microsoftManagerMode,
        microsoftManagerKeyword: prevState.microsoftManagerKeyword,
        microsoftManagerUseAliases: Boolean(prevState.microsoftManagerUseAliases),
        autoRunning: true,
        autoRunCurrentRun: run,
        autoRunTotalRuns: totalRuns,
        autoRunPausedPhase: null,
      };
      await resetState();
      await setState(keepSettings);
      // Tell side panel to reset all UI
      chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
      await sleepWithStop(220);
    }

    try {
      throwIfStopped();
      chrome.runtime.sendMessage(getAutoRunStatusMessage('running', run, totalRuns)).catch(() => {});

      await executeAutoRunSteps(run, totalRuns, { resumeFromCurrentState: isResumingRun });

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');

    } catch (err) {
      if (isStopError(err)) {
        await addLog(`Run ${run}/${totalRuns} stopped by user`, 'warn');
        chrome.runtime.sendMessage(getAutoRunStatusMessage('stopped', run, totalRuns)).catch(() => {});
      } else {
        autoRunPausedPhase = 'error';
        autoRunActive = false;
        await syncAutoRunState({ autoRunning: false });
        await addLog(`Run ${run}/${totalRuns} failed: ${err.message}`, 'error');
        chrome.runtime.sendMessage(getAutoRunStatusMessage('error', run, totalRuns)).catch(() => {});
        clearStopRequest();
        return;
      }
      break; // Stop on error
    }
  }

  const completedRuns = autoRunCurrentRun;
  if (stopRequested) {
    await addLog(`=== Stopped after ${Math.max(0, completedRuns - 1)}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('stopped', completedRuns, autoRunTotalRuns)).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('complete', completedRuns, autoRunTotalRuns)).catch(() => {});
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage(getAutoRunStatusMessage('stopped', completedRuns, autoRunTotalRuns)).catch(() => {});
  }
  autoRunActive = false;
  autoRunPausedPhase = null;
  await syncAutoRunState({ autoRunning: false, autoRunPausedPhase: null });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeWaiter) {
    autoRunPausedPhase = null;
    await syncAutoRunState();
    resumeWaiter.resolve();
    resumeWaiter = null;
  }
}

async function continueAutoRun() {
  const state = await getState();

  if (resumeWaiter) {
    await resumeAutoRun();
    return;
  }

  if (autoRunActive) {
    throw new Error('Auto run is already active.');
  }

  const currentRun = Number(state.autoRunCurrentRun || autoRunCurrentRun || 0);
  const totalRuns = Number(state.autoRunTotalRuns || autoRunTotalRuns || 1);
  if (!currentRun) {
    throw new Error('No interrupted auto run found.');
  }

  const resumeStep = getAutoResumeStep(state);
  const startRun = resumeStep ? currentRun : currentRun + 1;
  if (startRun > totalRuns) {
    throw new Error('There is no interrupted auto run to continue.');
  }

  autoRunLoop(totalRuns, {
    startRun,
    preserveCurrentRunState: Boolean(resumeStep),
  }); // fire-and-forget
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  if (isSub2apiOauthProvider(state)) {
    await executeStep1WithSub2api(state);
    return;
  }

  if (shouldUseCpaManagementApi(state)) {
    await executeStep1WithCpaApi(state);
    return;
  }

  if (!state.vpsUrl) {
    throw new Error('No CPA Auth URL configured. Enter the CPA Auth address in Side Panel first.');
  }
  await addLog('Step 1: Opening CPA Auth panel...');
  await reuseOrCreateTab('vps-panel', state.vpsUrl, {
    inject: ['content/utils.js', 'content/vps-panel.js'],
    reloadIfSameUrl: true,
  });

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

async function executeStep1WithCpaApi(state) {
  await addLog('Step 1: Requesting OAuth URL from CPA Management API...');
  await setState({ cpaAuthState: null });

  const payload = await requestCpaManagementApi(state, 'codex-auth-url', {
    method: 'GET',
  });

  const oauthUrl = String(payload?.url || payload?.auth_url || '').trim();
  const oauthState = String(payload?.state || '').trim();

  if (!oauthUrl || !oauthState) {
    throw new Error('CPA management API did not return url/state.');
  }

  await setState({ cpaAuthState: oauthState });
  await addLog(`Step 1: CPA OAuth URL ready (${oauthUrl.slice(0, 80)}...)`, 'ok');
  await completeBackgroundStep(1, { oauthUrl });
}

async function executeStep1WithSub2api(state) {
  await addLog('Step 1: Requesting OAuth URL from Sub2API...');

  let authCredential = String(state.sub2apiAdminApiKey || state.sub2apiRuntimeCredential || '').trim();
  if (!authCredential) {
    authCredential = await resolveSub2apiCredentialFromDashboard(state);
  }

  let data;
  try {
    data = await requestSub2apiAdminApi(state, 'admin/openai/generate-auth-url', {
      method: 'POST',
      body: {},
      authCredential,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    const isAuthError = /invalid admin api key|invalid token|authorization required|unauthorized|forbidden/i.test(message);
    if (!isAuthError) {
      throw err;
    }

    await addLog('Step 1: Sub2API auth failed, trying dashboard session token fallback...', 'warn');
    const fallbackCredential = await resolveSub2apiCredentialFromDashboard({
      ...state,
      sub2apiRuntimeCredential: '',
    });
    data = await requestSub2apiAdminApi(state, 'admin/openai/generate-auth-url', {
      method: 'POST',
      body: {},
      authCredential: fallbackCredential,
    });
  }

  const oauthUrl = String(data?.auth_url || '').trim();
  const sessionId = String(data?.session_id || '').trim();
  if (!oauthUrl || !sessionId) {
    throw new Error('Sub2API did not return auth_url/session_id.');
  }

  await setState({ sub2apiSessionId: sessionId });
  await addLog(`Step 1: Sub2API OAuth URL ready (${oauthUrl.slice(0, 80)}...)`, 'ok');
  await completeBackgroundStep(1, { oauthUrl });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL...`);
  await reuseOrCreateTab('signup-page', state.oauthUrl);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  if (!state.email) {
    throw new Error('No email address. Paste email in Side Panel first.');
  }

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  await addLog(
    `Step 3: Filling email ${state.email}, password ${state.customPassword ? 'customized' : 'generated'} (${password.length} chars)`
  );
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email: state.email, password },
  });

  const step3SurfacePayload = {
    step: 3,
    selectors: [
      'input[name="code"]',
      'input[name="otp"]',
      'input[maxlength="1"]',
      'input[name="name"]',
      'input[placeholder*="全名"]',
      '[role="spinbutton"][data-type="year"]',
      'input[name="age"]',
    ],
  };

  try {
    await waitForSignupSurface(step3SurfacePayload);
  } catch (err) {
    const message = getErrorMessage(err);
    const isSurfaceTimeout = /expected next page surface not found|signup page surface wait failed/i.test(message);
    if (!isSurfaceTimeout) {
      throw err;
    }

    await addLog('Step 3: Detected possible password timeout page. Trying "重试" and rerunning step 3...', 'warn');

    try {
      await sendToContentScript('signup-page', {
        type: 'RECOVER_PASSWORD_TIMEOUT',
        step: 3,
        source: 'background',
        payload: { password },
      });
    } catch (recoverErr) {
      await addLog(`Step 3: Retry button recovery failed, fallback to rerun step 3. ${getErrorMessage(recoverErr)}`, 'warn');
    }

    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 3,
      source: 'background',
      payload: { email: state.email, password },
    });

    await waitForSignupSurface(step3SurfacePayload, 30000);
  }
}

// ============================================================
// Step 4: Get Signup Verification Code (Microsoft Account Manager API)
// ============================================================

function getMailConfig(state) {
  const provider = normalizeMailProvider(state.mailProvider);
  if (provider !== 'microsoft-manager') {
    return { error: 'Only Microsoft Account Manager API is supported in this build.' };
  }

  const managerUrl = normalizeMicrosoftManagerBaseUrl(state.microsoftManagerUrl);
  const managerToken = String(state.microsoftManagerToken || '').trim();
  const mode = normalizeMicrosoftManagerMode(state.microsoftManagerMode);

  if (!managerUrl) {
    return { error: 'Microsoft Account Manager URL is empty or invalid.' };
  }
  if (!managerToken) {
    return { error: 'Microsoft Account Manager token is empty.' };
  }

  return {
    source: 'microsoft-manager',
    label: `Microsoft Account Manager (${mode.toUpperCase()})`,
    mode,
    usesApi: true,
  };
}

function normalizeCpaManagementApiRoot(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    let apiPath = parsed.pathname.replace(/\/+$/, '') || '';

    const panelPathMatch = apiPath.match(/^(.*)\/management(?:\.html)?$/i);
    if (panelPathMatch) {
      apiPath = panelPathMatch[1] || '';
    }

    const managementMatch = apiPath.match(/^(.*?\/v0\/management)(?:\/.*)?$/i);
    if (managementMatch) {
      apiPath = managementMatch[1];
    }

    if (!apiPath || apiPath === '/') {
      apiPath = '/v0/management';
    } else if (!/\/v0\/management$/i.test(apiPath)) {
      apiPath = `${apiPath}/v0/management`;
    }

    return `${parsed.origin}${apiPath}`;
  } catch {
    return '';
  }
}

function buildCpaManagementApiUrl(apiRoot, path, query = {}) {
  const root = String(apiRoot || '').replace(/\/+$/, '');
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(`${root}/${normalizedPath}`);

  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      const normalizedValue = String(value).trim();
      if (!normalizedValue) continue;
      url.searchParams.set(key, normalizedValue);
    }
  }

  return url.toString();
}

function shouldUseCpaManagementApi(state) {
  return Boolean(String(state?.cpaManagementKey || '').trim());
}

function looksLikeBcryptHash(rawValue) {
  const value = String(rawValue || '').trim();
  return /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

async function requestCpaManagementApi(state, path, options = {}) {
  const apiRoot = normalizeCpaManagementApiRoot(state.vpsUrl);
  if (!apiRoot) {
    throw new Error('CPA Auth URL is empty or invalid. Please configure CPA Auth address first.');
  }

  const managementKey = String(state.cpaManagementKey || '').trim();
  if (!managementKey) {
    throw new Error('CPA Management Key is empty. Fill it in Side Panel to use CPA API mode.');
  }
  if (looksLikeBcryptHash(managementKey)) {
    throw new Error('CPA Management Key looks like a hashed value ($2...). Please use the original plaintext key, not the encrypted secret-key in CPA config.');
  }

  const url = buildCpaManagementApiUrl(apiRoot, path, options.query);
  const headers = {
    Accept: 'application/json',
    'X-Management-Key': managementKey,
    ...(options.headers || {}),
  };

  const init = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new Error(`CPA management request failed: ${getErrorMessage(err)}`);
  }

  let payload = null;
  let responseText = '';
  try {
    payload = await response.json();
  } catch {
    try {
      responseText = await response.text();
    } catch {
      responseText = '';
    }
  }

  if (!response.ok) {
    const message = String(
      payload?.error
      || payload?.message
      || payload?.detail
      || responseText
      || `${response.status} ${response.statusText}`
    ).trim();

    if (/invalid management key/i.test(message)) {
      throw new Error('CPA management request failed: invalid management key. Use the plaintext Management Key (not encrypted $2... value in config).');
    }

    throw new Error(`CPA management request failed: ${message}`);
  }

  const status = String(payload?.status || '').trim().toLowerCase();
  if (status === 'error') {
    const message = String(payload?.error || payload?.message || 'Unknown error').trim();
    throw new Error(`CPA management request failed: ${message}`);
  }

  return payload && typeof payload === 'object' ? payload : {};
}

async function waitForCpaAuthStatusReady(state, oauthState, options = {}) {
  const stateValue = String(oauthState || '').trim();
  if (!stateValue) {
    throw new Error('No CPA OAuth state found. Please rerun step 1 first.');
  }

  const maxAttempts = Math.max(1, Number(options.maxAttempts || 40));
  const intervalMs = Math.max(800, Number(options.intervalMs || 2000));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();

    if (attempt === 1 || attempt % 5 === 0) {
    await addLog(`Step 7: Checking CPA Auth status... (${attempt}/${maxAttempts})`);
    }

    const payload = await requestCpaManagementApi(state, 'get-auth-status', {
      method: 'GET',
      query: { state: stateValue },
    });

    const status = String(payload?.status || '').trim().toLowerCase();
    if (status === 'ok') {
      return payload;
    }

    if (status === 'error') {
      const message = String(payload?.error || 'Authentication failed.').trim();
      throw new Error(`CPA Auth reported error: ${message}`);
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  throw new Error('CPA Auth is still waiting for callback. Please rerun from step 1 and retry.');
}

function normalizeSub2apiApiRoot(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    let apiPath = parsed.pathname.replace(/\/+$/, '') || '';

    // Users may paste dashboard URLs like /admin or /admin/acc.
    // Convert them back to API root automatically.
    if (/^\/admin(?:\/|$)/i.test(apiPath)) {
      apiPath = '';
    }

    // If path already contains /api/v1, keep the prefix only.
    const apiV1Match = apiPath.match(/^(.*?\/api\/v1)(?:\/.*)?$/i);
    if (apiV1Match) {
      apiPath = apiV1Match[1];
    }

    if (!apiPath || apiPath === '/') {
      apiPath = '/api/v1';
    } else if (!/\/api\/v1$/i.test(apiPath)) {
      apiPath = `${apiPath}/api/v1`;
    }

    return `${parsed.origin}${apiPath}`;
  } catch {
    return '';
  }
}

function normalizeSub2apiDashboardUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    let path = parsed.pathname.replace(/\/+$/, '') || '';

    if (/\/api\/v1/i.test(path)) {
      path = '';
    }

    if (!/^\/admin(?:\/|$)/i.test(path)) {
      path = '/admin/accounts';
    }

    return `${parsed.origin}${path}`;
  } catch {
    return '';
  }
}

async function resolveSub2apiCredentialFromDashboard(state) {
  const dashboardUrl = normalizeSub2apiDashboardUrl(state.sub2apiBaseUrl);
  if (!dashboardUrl) {
    throw new Error('Sub2API URL is empty or invalid.');
  }

  await addLog('Sub2API: No API credential set, trying to reuse admin login session from dashboard...', 'warn');

  await reuseOrCreateTab('sub2api-panel', dashboardUrl, {
    inject: ['content/utils.js', 'content/sub2api-panel.js'],
    injectSource: 'sub2api-panel',
  });

  const response = await sendToContentScript('sub2api-panel', {
    type: 'GET_SUB2API_AUTH_TOKEN',
    source: 'background',
    payload: {},
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  const token = String(response?.token || '').trim();
  if (!token) {
    throw new Error('No Sub2API admin token found. Please log in to Sub2API admin page first, then retry.');
  }

  const credential = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  await setState({ sub2apiRuntimeCredential: credential });
  await addLog('Sub2API: Admin login token detected and will be used for API requests.', 'ok');
  return credential;
}

function buildSub2apiApiUrl(apiRoot, path) {
  const root = String(apiRoot || '').replace(/\/+$/, '');
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  return `${root}/${normalizedPath}`;
}

async function requestSub2apiAdminApi(state, path, options = {}) {
  const apiRoot = normalizeSub2apiApiRoot(state.sub2apiBaseUrl);
  if (!apiRoot) {
    throw new Error('Sub2API URL is empty or invalid.');
  }

  const adminApiCredential = String(
    options.authCredential
      || state.sub2apiAdminApiKey
      || state.sub2apiRuntimeCredential
      || ''
  ).trim();

  const url = buildSub2apiApiUrl(apiRoot, path);
  const baseHeaders = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  async function sendSub2apiRequest(headers) {
    const init = {
      method: options.method || 'GET',
      headers,
    };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new Error(`Sub2API request failed: ${getErrorMessage(err)}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const responseCode = Number(payload?.code);
    const responseMessage = String(payload?.message || payload?.detail || '').trim();
    const responseData = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;

    if (!response.ok) {
      const fallbackMessage = `${response.status} ${response.statusText}`.trim();
      throw new Error(`Sub2API request failed: ${responseMessage || fallbackMessage}`);
    }

    if (Number.isFinite(responseCode) && responseCode !== 0) {
      throw new Error(`Sub2API request failed: ${responseMessage || `code ${responseCode}`}`);
    }

    return responseData;
  }

  if (!adminApiCredential) {
    return sendSub2apiRequest({ ...baseHeaders });
  }

  if (/^Bearer\s+/i.test(adminApiCredential)) {
    return sendSub2apiRequest({
      ...baseHeaders,
      Authorization: adminApiCredential,
    });
  }

  try {
    return await sendSub2apiRequest({
      ...baseHeaders,
      'x-api-key': adminApiCredential,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    if (!/invalid admin api key/i.test(message)) {
      throw err;
    }

    await addLog('Sub2API auth fallback: x-api-key rejected, retrying as Bearer token...', 'warn');

    return sendSub2apiRequest({
      ...baseHeaders,
      Authorization: `Bearer ${adminApiCredential}`,
    });
  }
}

function normalizeSub2apiGroupOption(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const idNumber = Number(
    raw.id
    ?? raw.group_id
    ?? raw.groupId
    ?? raw.value
    ?? raw.key
    ?? 0
  );
  const id = Number.isFinite(idNumber) && idNumber > 0 ? String(Math.trunc(idNumber)) : '';

  const name = String(
    raw.name
    ?? raw.group_name
    ?? raw.groupName
    ?? raw.title
    ?? raw.label
    ?? raw.display_name
    ?? ''
  ).trim();

  if (!id) return null;
  return {
    id,
    name: name || `Group ${id}`,
  };
}

function collectSub2apiGroupOptions(node, output, depth = 0) {
  if (!node || depth > 6) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      const normalized = normalizeSub2apiGroupOption(item);
      if (normalized) {
        output.push(normalized);
        continue;
      }
      if (item && typeof item === 'object') {
        collectSub2apiGroupOptions(item, output, depth + 1);
      }
    }
    return;
  }

  if (typeof node !== 'object') return;

  for (const value of Object.values(node)) {
    if (!value || typeof value !== 'object') continue;
    collectSub2apiGroupOptions(value, output, depth + 1);
  }
}

function dedupeAndSortSub2apiGroupOptions(groups) {
  const map = new Map();
  for (const group of groups) {
    if (!group?.id) continue;
    map.set(group.id, {
      id: String(group.id),
      name: String(group.name || `Group ${group.id}`),
    });
  }

  return [...map.values()].sort((left, right) => {
    const leftName = String(left.name || '').toLowerCase();
    const rightName = String(right.name || '').toLowerCase();
    if (leftName === rightName) return String(left.id).localeCompare(String(right.id));
    return leftName.localeCompare(rightName);
  });
}

async function fetchSub2apiGroups() {
  const state = await getState();
  let authCredential = String(state.sub2apiAdminApiKey || state.sub2apiRuntimeCredential || '').trim();
  if (!authCredential) {
    authCredential = await resolveSub2apiCredentialFromDashboard(state);
  }

  const candidates = [
    { method: 'GET', path: 'admin/groups' },
    { method: 'GET', path: 'admin/groups/all' },
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const data = await requestSub2apiAdminApi(state, candidate.path, {
        method: candidate.method,
        authCredential,
        body: candidate.body,
      });

      const found = [];
      collectSub2apiGroupOptions(data, found);
      const groups = dedupeAndSortSub2apiGroupOptions(found);

      if (!groups.length) {
        continue;
      }

      await addLog(`Sub2API: Loaded ${groups.length} group options from ${candidate.path}`, 'ok');
      return groups;
    } catch (err) {
      lastError = new Error(`${candidate.method} ${candidate.path}: ${getErrorMessage(err)}`);
    }
  }

  if (lastError) {
    throw new Error(`Failed to load Sub2API groups: ${getErrorMessage(lastError)}`);
  }
  throw new Error('Failed to load Sub2API groups: no available group endpoint returned data.');
}

function buildSub2apiAccountSettingsPayload(state, accountId) {
  const selectedGroupIds = normalizeSub2apiGroupIds(state.sub2apiSelectedGroupIds);
  const numericGroupIds = selectedGroupIds
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value) && value > 0);

  const payload = {
    max_concurrency: SUB2API_POST_IMPORT_DEFAULTS.maxConcurrency,
    concurrency: SUB2API_POST_IMPORT_DEFAULTS.maxConcurrency,
    load_factor: SUB2API_POST_IMPORT_DEFAULTS.loadFactor,
    priority: SUB2API_POST_IMPORT_DEFAULTS.priority,
    rate_multiplier: SUB2API_POST_IMPORT_DEFAULTS.billingMultiplier,
    id: accountId,
  };

  if (numericGroupIds.length > 0) {
    payload.group_ids = numericGroupIds;
  }

  return payload;
}

async function applySub2apiPostImportSettings(state, accountId, authCredential) {
  const payload = buildSub2apiAccountSettingsPayload(state, accountId);
  const selectedGroups = Array.isArray(payload.group_ids) ? payload.group_ids.length : 0;

  const candidates = [
    { method: 'PUT', path: `admin/accounts/${accountId}` },
    { method: 'POST', path: 'admin/accounts/bulk-update', body: {
      account_ids: [accountId],
      concurrency: SUB2API_POST_IMPORT_DEFAULTS.maxConcurrency,
      load_factor: SUB2API_POST_IMPORT_DEFAULTS.loadFactor,
      priority: SUB2API_POST_IMPORT_DEFAULTS.priority,
      rate_multiplier: SUB2API_POST_IMPORT_DEFAULTS.billingMultiplier,
      ...(Array.isArray(payload.group_ids) ? { group_ids: payload.group_ids } : {}),
    } },
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      await requestSub2apiAdminApi(state, candidate.path, {
        method: candidate.method,
        authCredential,
        body: candidate.body || payload,
      });

      await addLog(
        `Step 7: Sub2API account #${accountId} settings updated (并发 ${SUB2API_POST_IMPORT_DEFAULTS.maxConcurrency} / 负载 ${SUB2API_POST_IMPORT_DEFAULTS.loadFactor} / 优先级 ${SUB2API_POST_IMPORT_DEFAULTS.priority} / 计费倍率 ${SUB2API_POST_IMPORT_DEFAULTS.billingMultiplier}; 分组 ${selectedGroups} 个)`,
        'ok'
      );
      return;
    } catch (err) {
      lastError = new Error(`${candidate.method} ${candidate.path}: ${getErrorMessage(err)}`);
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function parseOAuthCallbackParams(callbackUrl) {
  const value = String(callbackUrl || '').trim();
  if (!value) {
    throw new Error('No callback URL. Complete step 6 first.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Callback URL is invalid.');
  }

  const code = String(parsed.searchParams.get('code') || '').trim();
  const state = String(parsed.searchParams.get('state') || '').trim();
  const oauthError = String(parsed.searchParams.get('error') || '').trim();
  const oauthErrorDescription = String(parsed.searchParams.get('error_description') || '').trim();

  if (oauthError) {
    const detail = oauthErrorDescription || oauthError;
    throw new Error(
      `OAuth callback returned error: ${detail}. Usually this means OAuth session/CSRF mismatch. Please rerun from step 1 to get a fresh OAuth URL, then continue.`
    );
  }

  if (!code || !state) {
    throw new Error('Callback URL is missing code/state query parameters. Please rerun from step 1 and retry.');
  }

  return {
    code,
    state,
    callbackUrl: parsed.toString(),
    redirectUri: `${parsed.origin}${parsed.pathname}`,
  };
}

async function completeBackgroundStep(step, payload = {}) {
  await setStepStatus(step, 'completed');
  await addLog(`Step ${step} completed`, 'ok');
  await handleStepData(step, payload);
  notifyStepComplete(step, payload);
}

async function pollVerificationCodeWithAutoResend(options) {
  const {
    step,
    mail,
    pollPayload,
    successSelectors,
    successMessage,
    resendRounds = 3,
    customPoll = null,
  } = options;

  let currentFilterAfter = pollPayload.filterAfterTimestamp || 0;

  for (let round = 1; round <= resendRounds; round++) {
    const currentPayload = {
      ...pollPayload,
      filterAfterTimestamp: currentFilterAfter,
    };

    const result = customPoll
      ? await customPoll(currentPayload)
      : await sendToContentScript(mail.source, {
          type: 'POLL_EMAIL',
          step,
          source: 'background',
          payload: currentPayload,
        });

    if (result?.code) {
      await setState({ lastEmailTimestamp: result.emailTimestamp || Date.now() });
      await addLog(`Step ${step}: ${successMessage}: ${result.code}`);

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error(`Signup page tab was closed. Cannot fill step ${step} verification code.`);
      }

      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step,
        source: 'background',
        payload: { code: result.code },
      });
      await waitForSignupSurface({
        step,
        selectors: successSelectors,
      });
      return;
    }

    const pollError = result?.error || `No verification code returned for step ${step}.`;
    if (round >= resendRounds) {
      throw new Error(pollError);
    }

    await addLog(`Step ${step}: No verification email received on round ${round}/${resendRounds}. Trying to resend code...`, 'warn');

    const signupTabId = await getTabId('signup-page');
    if (!signupTabId) {
      throw new Error(`Signup page tab was closed. Cannot resend step ${step} verification code.`);
    }

    await chrome.tabs.update(signupTabId, { active: true });
    const resendResponse = await sendToContentScript('signup-page', {
      type: 'RESEND_VERIFICATION_CODE',
      step,
      source: 'background',
      payload: {},
    });

    if (resendResponse?.error) {
      throw new Error(resendResponse.error);
    }

    currentFilterAfter = resendResponse?.resentAt || Date.now();
    await addLog(`Step ${step}: Resend triggered. Waiting for a fresh verification email...`, 'info');
  }
}

async function executeStep4(state) {
  const maxSwitchRounds = 5;

  for (let round = 1; round <= maxSwitchRounds; round++) {
    const current = await getState();
    const pollPayload = {
      filterAfterTimestamp: current.flowStartTime || state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'forward'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
      targetEmail: current.email,
      maxAttempts: 20,
      intervalMs: 3000,
    };

    const mail = getMailConfig(current);
    if (mail.error) throw new Error(mail.error);

    try {
      if (mail.usesApi) {
        await addLog(`Step 4: Polling verification code via ${mail.label}...`);
        await pollVerificationCodeWithAutoResend({
          step: 4,
          mail,
          pollPayload,
          successMessage: 'Got verification code',
          successSelectors: [
            'input[name="name"]',
            'input[placeholder*="全名"]',
            '[role="spinbutton"][data-type="year"]',
            'input[name="birthday"]',
            'input[name="age"]',
          ],
          customPoll: (currentPayload) => pollMicrosoftManagerCode(current, 4, currentPayload),
        });
        return;
      }

      await addLog(`Step 4: Opening ${mail.label}...`);

      const alive = await isTabAlive(mail.source);
      if (alive) {
        if (mail.navigateOnReuse) {
          await reuseOrCreateTab(mail.source, mail.url, {
            inject: mail.inject,
            injectSource: mail.injectSource,
          });
        } else {
          const tabId = await getTabId(mail.source);
          await chrome.tabs.update(tabId, { active: true });
        }
      } else {
        await reuseOrCreateTab(mail.source, mail.url, {
          inject: mail.inject,
          injectSource: mail.injectSource,
        });
      }

      await pollVerificationCodeWithAutoResend({
        step: 4,
        mail,
        pollPayload,
        successMessage: 'Got verification code',
        successSelectors: [
          'input[name="name"]',
          'input[placeholder*="全名"]',
          '[role="spinbutton"][data-type="year"]',
          'input[name="birthday"]',
          'input[name="age"]',
        ],
      });
      return;
    } catch (err) {
      const abuseError = isMicrosoftServiceAbuseError(err);
      const phoneChallengeError = isMicrosoftPhoneChallengeError(err);

      if (!abuseError && !phoneChallengeError) {
        throw err;
      }

      if (round >= maxSwitchRounds) {
        throw new Error(`Step 4: ${getErrorMessage(err)}. Reached maximum blocked-account retry rounds (${maxSwitchRounds}).`);
      }

      if (phoneChallengeError) {
        await handleMicrosoftPhoneChallengeDuringStep4(current, {
          round,
          maxRounds: maxSwitchRounds,
        });
      } else {
        await handleMicrosoftServiceAbuseDuringStep4(current, {
          round,
          maxRounds: maxSwitchRounds,
        });
      }
    }
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

function isLocalCallbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const isLocalHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    if (!isLocalHost) return false;

    const code = String(parsed.searchParams.get('code') || '').trim();
    const state = String(parsed.searchParams.get('state') || '').trim();
    const error = String(parsed.searchParams.get('error') || '').trim();

    if (code && state) return true;
    if (error) return true;

    // Guardrail: reject unrelated localhost pages (e.g. CPA dashboard at localhost:8080).
    // Callback URLs should carry OAuth query params.
    return false;
  } catch {
    return false;
  }
}

function getPostLoginSurfaceFlagsFromUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const pathname = String(parsed.pathname || '').toLowerCase();
    return {
      isConsentPage: /\/sign-in-with-chatgpt\/codex\/consent/.test(pathname),
      isAboutYouPage: /\/about-you/.test(pathname),
      isCallbackUrl: isLocalCallbackUrl(parsed.toString()),
      url: parsed.toString(),
    };
  } catch {
    return {
      isConsentPage: false,
      isAboutYouPage: false,
      isCallbackUrl: false,
      url: '',
    };
  }
}

async function findExistingLocalCallbackUrl(state = null) {
  const currentState = state || await getState();

  const stateUrl = String(currentState?.localhostUrl || '').trim();
  if (isLocalCallbackUrl(stateUrl)) {
    return stateUrl;
  }

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    try {
      const signupTab = await chrome.tabs.get(signupTabId);
      const signupUrl = String(signupTab?.url || signupTab?.pendingUrl || '').trim();
      if (isLocalCallbackUrl(signupUrl)) {
        return signupUrl;
      }
    } catch {}
  }

  const tabs = await chrome.tabs.query({});
  tabs.sort((a, b) => Number(b?.lastAccessed || 0) - Number(a?.lastAccessed || 0));

  for (const tab of tabs) {
    const candidateUrl = String(tab?.url || tab?.pendingUrl || '').trim();
    if (isLocalCallbackUrl(candidateUrl)) {
      return candidateUrl;
    }
  }

  return '';
}

async function finalizeStep6WithCallbackUrl(callbackUrl) {
  await setState({ localhostUrl: callbackUrl });

  let callbackError = '';
  let callbackErrorDescription = '';
  try {
    const parsed = new URL(callbackUrl);
    callbackError = String(parsed.searchParams.get('error') || '').trim();
    callbackErrorDescription = String(parsed.searchParams.get('error_description') || '').trim();
  } catch {}

  if (callbackError) {
    const detail = callbackErrorDescription || callbackError;
    throw new Error(
      `OAuth callback returned error: ${detail}. Usually this means OAuth session/CSRF mismatch. Please rerun from step 1 to get a fresh OAuth URL, then continue.`
    );
  }

  await addLog(`Step 6: Captured localhost URL: ${callbackUrl}`, 'ok');
  await completeBackgroundStep(6, { localhostUrl: callbackUrl });
}

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  const existingCallbackUrl = await findExistingLocalCallbackUrl(state);
  if (existingCallbackUrl) {
    await addLog('Step 6: Existing localhost callback already detected. Reusing it.', 'warn');
    await finalizeStep6WithCallbackUrl(existingCallbackUrl);
    return;
  }

  await addLog('Step 6: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    let resolved = false;
    let resolveCaptureWait = null;
    let stopWatcher = null;
    const captureWait = new Promise((resolveCapture) => {
      resolveCaptureWait = resolveCapture;
    });

    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
    };

    const cleanupAll = () => {
      cleanupListener();
      clearTimeout(timeout);
      clearTimeout(stopWatcher);
    };

    const timeout = setTimeout(() => {
      (async () => {
        if (resolved) return;

        try {
          const callbackUrl = await findExistingLocalCallbackUrl();
          if (callbackUrl) {
            resolved = true;
            cleanupAll();
            await finalizeStep6WithCallbackUrl(callbackUrl);
            resolve();
            return;
          }
        } catch {}

        cleanupAll();
        reject(new Error('Localhost redirect not captured after 120s. Step 6 click may have been blocked.'));
      })();
    }, 120000);

    const watchStopRequested = () => {
      if (resolved) return;
      if (stopRequested) {
        resolved = true;
        cleanupAll();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      stopWatcher = setTimeout(watchStopRequested, 120);
    };
    watchStopRequested();

    webNavListener = (details) => {
      if (!isLocalCallbackUrl(details.url) || resolved) {
        return;
      }

      resolved = true;
      console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
      cleanupAll();
      if (resolveCaptureWait) resolveCaptureWait(details.url);

      (async () => {
        try {
          await finalizeStep6WithCallbackUrl(details.url);
          resolve();
        } catch (err) {
          reject(err);
        }
      })();
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    // Step 6 runs on the consent screen ("使用 ChatGPT 登录到 Codex").
    // The new flow may briefly stay on "/about-you" first.
    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 6: Switched to auth page. Preparing continue click...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('Step 6: Auth tab reopened. Preparing continue click...');
        }

        async function requestStep6Click(payload = {}) {
          try {
            return await sendToContentScript('signup-page', {
              type: 'STEP6_FIND_AND_CLICK',
              source: 'background',
              payload,
            });
          } catch (sendErr) {
            const sendMessage = getErrorMessage(sendErr);
            const disconnected = /receiving end does not exist|could not establish connection/i.test(sendMessage);
            if (!disconnected) {
              throw sendErr;
            }

            await addLog('Step 6: Auth page helper disconnected, reinjecting and retrying...', 'warn');
            await chrome.scripting.executeScript({
              target: { tabId: signupTabId },
              files: ['content/utils.js', 'content/signup-page.js'],
            });
            await new Promise((r) => setTimeout(r, 180));
            return chrome.tabs.sendMessage(signupTabId, {
              type: 'STEP6_FIND_AND_CLICK',
              source: 'background',
              payload,
            });
          }
        }

        let clickResult = await requestStep6Click({ dryRun: false });

        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        if (!clickResult?.isConsentPage) {
          await addLog('Step 6: Current page is not consent yet (likely /about-you). Continue clicked once, waiting for consent page...', 'warn');

          await waitForSignupSurface({
            step: 6,
            selectors: getOauthConsentSurfaceSelectors(),
            timeout: 20000,
          }, 20000);

          if (!resolved) {
            clickResult = await requestStep6Click({ dryRun: false });
            if (clickResult?.error) {
              throw new Error(clickResult.error);
            }
          }
        }

        if (!resolved) {
          if (clickResult?.directClicked) {
            await addLog('Step 6: Continue button clicked. Waiting for localhost redirect...', 'ok');
            await sleepWithStop(700);
          }

          if (!resolved) {
            await clickWithDebugger(signupTabId, clickResult?.rect);
            await addLog('Step 6: Debugger click dispatched as fallback, waiting for redirect...');
          }
        }
      } catch (err) {
        if (resolved) {
          return;
        }

        const message = getErrorMessage(err);
        const phoneChallengeError = isMicrosoftPhoneChallengeError(message);
        if (phoneChallengeError) {
          try {
            const current = await getState();
            await handleMicrosoftPhoneChallengeDuringStep4(current, {
              round: 1,
              maxRounds: 1,
              restartSignup: false,
            });
          } catch (fallbackErr) {
            await addLog(`Step 6: add-phone fallback handling failed: ${getErrorMessage(fallbackErr)}`, 'warn');
          }
          resolved = true;
          cleanupAll();
          reject(new Error('Step 6: Detected add-phone challenge. Email has been marked and replaced. Please rerun from step 3.'));
          return;
        }

        await addLog(
          `Step 6: Auto click was not completed (${message}). Please click consent manually; still waiting for localhost redirect...`,
          'warn'
        );
      }
    })();
  });
}

// ============================================================
// Step 7: Callback verify/import (CPA API / CPA panel / Sub2API)
// ============================================================

async function executeStep7(state) {
  if (isSub2apiOauthProvider(state)) {
    await executeStep7WithSub2api(state);
    return;
  }

  if (shouldUseCpaManagementApi(state)) {
    await executeStep7WithCpaApi(state);
    return;
  }

  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 6 first.');
  }
  if (!state.vpsUrl) {
    throw new Error('CPA Auth URL not set. Please enter the CPA Auth URL in the side panel.');
  }

  await addLog('Step 7: Opening CPA Auth panel...');

  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    // Create new tab
    const tab = await chrome.tabs.create({ url: state.vpsUrl, active: true });
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }

  // Inject scripts directly and wait for them to be ready
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/utils.js', 'content/vps-panel.js'],
  });
  await new Promise(r => setTimeout(r, 450));

  // Send command directly — bypass queue/ready mechanism
  await addLog(`Step 7: Filling callback URL...`);
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: 7,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
}

async function executeStep7WithCpaApi(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 6 first.');
  }

  const callback = parseOAuthCallbackParams(state.localhostUrl);

  let oauthState = String(state.cpaAuthState || '').trim();
  if (!oauthState) {
    oauthState = callback.state;
  }

  if (!oauthState) {
    throw new Error('No CPA OAuth state found. Please rerun step 1 first.');
  }

  if (callback.state && callback.state !== oauthState) {
    await addLog(`Step 7: Callback state (${callback.state}) differs from stored CPA state (${oauthState}). Using callback state.`, 'warn');
    oauthState = callback.state;
  }

  await addLog('Step 7: Forwarding OAuth callback to CPA Management API...');
  try {
    await requestCpaManagementApi(state, 'oauth-callback', {
      method: 'POST',
      body: {
        provider: 'codex',
        redirect_url: callback.callbackUrl,
        code: callback.code,
        state: oauthState,
        error: '',
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    if (/already|duplicate|exists|processed|handled/i.test(message)) {
      await addLog(`Step 7: Callback already submitted (${message}). Continue polling status...`, 'warn');
    } else {
      throw err;
    }
  }

  await addLog('Step 7: Confirming OAuth completion via CPA Management API...');
  await waitForCpaAuthStatusReady(state, oauthState, {
    maxAttempts: 40,
    intervalMs: 2000,
  });

  await setState({ cpaAuthState: null });
  await addLog('Step 7: CPA import/authentication completed.', 'ok');

  await completeBackgroundStep(7, {
    cpaAuthState: oauthState,
  });
}

async function executeStep7WithSub2api(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 6 first.');
  }

  const sessionId = String(state.sub2apiSessionId || '').trim();
  if (!sessionId) {
    throw new Error('No Sub2API session_id. Please rerun step 1 first.');
  }

  const callback = parseOAuthCallbackParams(state.localhostUrl);
  let authCredential = String(state.sub2apiAdminApiKey || state.sub2apiRuntimeCredential || '').trim();
  if (!authCredential) {
    authCredential = await resolveSub2apiCredentialFromDashboard(state);
  }

  await addLog('Step 7: Importing account to Sub2API...');
  let created;
  try {
    created = await requestSub2apiAdminApi(state, 'admin/openai/create-from-oauth', {
      method: 'POST',
      authCredential,
      body: {
        session_id: sessionId,
        code: callback.code,
        state: callback.state,
        redirect_uri: callback.redirectUri,
        name: String(state.email || '').trim() || undefined,
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    const isAuthError = /invalid admin api key|invalid token|authorization required|unauthorized|forbidden/i.test(message);
    if (!isAuthError) {
      throw err;
    }

    await addLog('Step 7: Sub2API auth failed, trying dashboard session token fallback...', 'warn');
    const fallbackCredential = await resolveSub2apiCredentialFromDashboard({
      ...state,
      sub2apiRuntimeCredential: '',
    });
    authCredential = fallbackCredential;
    created = await requestSub2apiAdminApi(state, 'admin/openai/create-from-oauth', {
      method: 'POST',
      authCredential: fallbackCredential,
      body: {
        session_id: sessionId,
        code: callback.code,
        state: callback.state,
        redirect_uri: callback.redirectUri,
        name: String(state.email || '').trim() || undefined,
      },
    });
  }

  await setState({ sub2apiSessionId: null });

  const accountId = Number(
    created?.id
    || created?.account_id
    || created?.accountId
    || created?.account?.id
    || 0
  );
  const accountName = String(created?.name || state.email || '').trim();

  if (accountId > 0) {
    try {
      await applySub2apiPostImportSettings(state, accountId, authCredential);
    } catch (err) {
      await addLog(`Step 7: Sub2API post-import settings update failed: ${getErrorMessage(err)}`, 'warn');
    }
  }

  if (accountId > 0) {
    await addLog(`Step 7: Sub2API account created #${accountId}${accountName ? ` (${accountName})` : ''}`, 'ok');
  } else {
    await addLog(`Step 7: Sub2API import completed${accountName ? ` (${accountName})` : ''}`, 'ok');
  }

  await completeBackgroundStep(7, {
    sub2apiAccountId: accountId || null,
    sub2apiAccountName: accountName || null,
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
