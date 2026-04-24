// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const HUMAN_STEP_DELAY_MIN = 250;
const HUMAN_STEP_DELAY_MAX = 900;
const TOTAL_STEPS = 8;
const AUTO_RUN_STEP_SEQUENCE = [1, 2, 3, 4, 5, 6, 7, 8];
const SUB2API_POST_IMPORT_DEFAULTS = Object.freeze({
  maxConcurrency: 10,
  loadFactor: 10,
  priority: 1,
  billingMultiplier: 1,
});
const HEROSMS_RUNTIME_STATE_SET = new Set([
  'idle',
  'running',
  'waiting_code',
  'submitting_code',
  'completed',
  'failed',
  'cancelled',
]);

function createHeroSmsRuntimeState() {
  return {
    state: 'idle',
    activationId: '',
    maskedPhone: '',
    detail: '',
    error: '',
    updatedAt: 0,
  };
}

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
    6: 'pending', 7: 'pending', 8: 'pending',
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
  heroSmsEnabled: false,
  heroSmsApiKey: '',
  heroSmsCountryId: 0,
  heroSmsCountryMeta: null,
  heroSmsBalanceLabel: '',
  heroSmsServiceCode: '',
  heroSmsOperator: '',
  heroSmsMaxPrice: '',
  heroSmsFixedPrice: false,
  heroSmsRuntime: createHeroSmsRuntimeState(),
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
  'heroSmsEnabled',
  'heroSmsApiKey',
  'heroSmsCountryId',
  'heroSmsCountryMeta',
  'heroSmsServiceCode',
  'heroSmsOperator',
  'heroSmsMaxPrice',
  'heroSmsFixedPrice',
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
    heroSmsEnabled: Boolean(raw.heroSmsEnabled),
    heroSmsApiKey: String(raw.heroSmsApiKey || ''),
    heroSmsCountryId: normalizeHeroSmsCountryId(raw.heroSmsCountryId),
    heroSmsCountryMeta: normalizeHeroSmsCountryMeta(raw.heroSmsCountryMeta),
    heroSmsServiceCode: String(raw.heroSmsServiceCode || '').trim().toLowerCase(),
    heroSmsOperator: normalizeHeroSmsOperator(raw.heroSmsOperator),
    heroSmsMaxPrice: normalizeHeroSmsMaxPrice(raw.heroSmsMaxPrice),
    heroSmsFixedPrice: Boolean(raw.heroSmsFixedPrice),
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
    heroSmsEnabled: Boolean(merged.heroSmsEnabled),
    heroSmsApiKey: normalizeHeroSmsApiKey(merged.heroSmsApiKey),
    heroSmsCountryId: normalizeHeroSmsCountryId(merged.heroSmsCountryId),
    heroSmsCountryMeta: normalizeHeroSmsCountryMeta(merged.heroSmsCountryMeta),
    heroSmsServiceCode: String(merged.heroSmsServiceCode || '').trim().toLowerCase(),
    heroSmsOperator: normalizeHeroSmsOperator(merged.heroSmsOperator),
    heroSmsMaxPrice: normalizeHeroSmsMaxPrice(merged.heroSmsMaxPrice),
    heroSmsFixedPrice: Boolean(merged.heroSmsFixedPrice),
    heroSmsRuntime: normalizeHeroSmsRuntime(merged.heroSmsRuntime),
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

function normalizeHeroSmsCountryId(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

function normalizeHeroSmsDialCode(rawValue) {
  let digits = String(rawValue || '').replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  return digits;
}

function normalizeHeroSmsRuntimeState(rawValue) {
  const state = String(rawValue || '').trim().toLowerCase();
  return HEROSMS_RUNTIME_STATE_SET.has(state) ? state : 'idle';
}

function normalizeHeroSmsRuntime(rawValue) {
  const source = rawValue && typeof rawValue === 'object' ? rawValue : {};
  const updatedAt = Number(source.updatedAt);
  return {
    state: normalizeHeroSmsRuntimeState(source.state),
    activationId: normalizeHeroSmsActivationId(source.activationId),
    maskedPhone: String(source.maskedPhone || '').trim(),
    detail: String(source.detail || '').trim(),
    error: String(source.error || '').trim(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

function normalizeHeroSmsCountryMeta(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') return null;

  const id = normalizeHeroSmsCountryId(rawValue.id || rawValue.countryId || rawValue.country);
  if (!id) return null;

  const displayName = String(rawValue.displayName || '').trim();
  const eng = String(rawValue.eng || '').trim();
  const chn = String(rawValue.chn || '').trim();
  const rus = String(rawValue.rus || '').trim();
  const dialCode = normalizeHeroSmsDialCode(
    rawValue.dialCode
    || rawValue.phoneCode
    || rawValue.phone_code
    || rawValue.prefix
  );
  const costNumber = Number(rawValue.cost);
  const countNumber = Number(rawValue.count);

  return {
    id,
    displayName: displayName || chn || eng || rus || `#${id}`,
    eng,
    chn,
    rus,
    dialCode,
    cost: Number.isFinite(costNumber) ? costNumber : null,
    count: Number.isFinite(countNumber) ? Math.trunc(countNumber) : null,
  };
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

const HEROSMS_STUB_ENDPOINT = 'https://hero-sms.com/stubs/handler_api.php';
const HEROSMS_SERVICE_KEYWORDS = ['openai'];
const HEROSMS_OPENAI_ALIAS_CODES = ['dr'];
const HEROSMS_ACTIVATION_STATUS_READY = '1';
const HEROSMS_ACTIVATION_STATUS_COMPLETE = '6';
const HEROSMS_ACTIVATION_STATUS_CANCEL = '8';
const HEROSMS_SMS_POLL_MAX_ATTEMPTS = 24;
const HEROSMS_SMS_POLL_INTERVAL_MS = 5000;

function normalizeHeroSmsApiKey(rawValue) {
  return String(rawValue || '').trim();
}

function normalizeHeroSmsServiceCode(rawValue) {
  return String(rawValue || '').trim().toLowerCase();
}

function normalizeHeroSmsOperator(rawValue) {
  return String(rawValue || '').trim().toLowerCase();
}

function normalizeHeroSmsMaxPrice(rawValue) {
  const value = String(rawValue ?? '').trim().replace(',', '.');
  if (!value) return '';

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return numeric.toFixed(6).replace(/\.?0+$/, '');
}

function parseHeroSmsErrorFromText(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  const knownErrorPrefixes = [
    'NO_KEY',
    'BAD_KEY',
    'BAD_ACTION',
    'BAD_SERVICE',
    'BAD_STATUS',
    'BANNED',
    'ERROR_SQL',
    'NO_NUMBERS',
    'NO_BALANCE',
    'NO_MONEY',
    'ACCOUNT_BLOCKED',
    'STATUS_CANCEL',
  ];

  const upperValue = value.toUpperCase();
  for (const prefix of knownErrorPrefixes) {
    if (upperValue.startsWith(prefix)) {
      return value;
    }
  }

  return '';
}

function tryParseHeroSmsJson(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function requestHeroSmsStubAction(state, action, params = {}) {
  const apiKey = normalizeHeroSmsApiKey(state?.heroSmsApiKey);
  if (!apiKey) {
    throw new Error('HeroSMS API Key is empty.');
  }

  const url = new URL(HEROSMS_STUB_ENDPOINT);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('action', String(action || '').trim());

  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });
  } catch (err) {
    throw new Error(`HeroSMS request failed: ${getErrorMessage(err)}`);
  }

  const text = String(await response.text() || '').trim();
  if (!response.ok) {
    throw new Error(`HeroSMS request failed: ${response.status} ${response.statusText}${text ? ` ${text}` : ''}`.trim());
  }

  const knownError = parseHeroSmsErrorFromText(text);
  if (knownError) {
    throw new Error(`HeroSMS error: ${knownError}`);
  }

  return text;
}

function normalizeHeroSmsCountryRecord(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') return null;

  const id = normalizeHeroSmsCountryId(rawValue.id || rawValue.countryId || rawValue.country);
  if (!id) return null;

  const eng = String(rawValue.eng || rawValue.english || '').trim();
  const chn = String(rawValue.chn || rawValue.chinese || '').trim();
  const rus = String(rawValue.rus || rawValue.russian || '').trim();
  const dialCode = normalizeHeroSmsDialCode(
    rawValue.dialCode
    || rawValue.phoneCode
    || rawValue.phone_code
    || rawValue.prefix
  );

  return {
    id,
    eng,
    chn,
    rus,
    dialCode,
    displayName: String(rawValue.displayName || chn || eng || rus || `#${id}`).trim(),
  };
}

function normalizeHeroSmsCountriesPayload(rawPayload) {
  const records = [];

  if (Array.isArray(rawPayload)) {
    records.push(...rawPayload);
  } else if (rawPayload && typeof rawPayload === 'object') {
    if (Array.isArray(rawPayload.countries)) {
      records.push(...rawPayload.countries);
    } else {
      for (const [key, value] of Object.entries(rawPayload)) {
        if (!value || typeof value !== 'object') continue;
        records.push({ id: key, ...value });
      }
    }
  }

  const normalized = records
    .map(item => normalizeHeroSmsCountryRecord(item))
    .filter(Boolean);

  const deduped = new Map();
  for (const item of normalized) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()].sort((left, right) => left.id - right.id);
}

function normalizeHeroSmsServiceRecord(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') return null;

  const code = String(rawValue.code || rawValue.service || rawValue.id || '').trim().toLowerCase();
  if (!code) return null;

  const name = String(rawValue.name || rawValue.title || code).trim();
  return { code, name };
}

function normalizeHeroSmsServicesPayload(rawPayload) {
  let services = [];

  if (Array.isArray(rawPayload)) {
    services = rawPayload;
  } else if (rawPayload && typeof rawPayload === 'object') {
    if (Array.isArray(rawPayload.services)) {
      services = rawPayload.services;
    } else if (rawPayload.services && typeof rawPayload.services === 'object') {
      services = Object.entries(rawPayload.services).map(([code, name]) => ({ code, name }));
    }
  }

  const normalized = services
    .map(item => normalizeHeroSmsServiceRecord(item))
    .filter(Boolean);

  const deduped = new Map();
  for (const service of normalized) {
    deduped.set(service.code, service);
  }

  return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function isHeroSmsOpenAiService(service) {
  if (!service || typeof service !== 'object') return false;

  const code = String(service.code || '').trim().toLowerCase();
  const name = String(service.name || '').trim().toLowerCase();
  if (!code && !name) return false;

  if (HEROSMS_OPENAI_ALIAS_CODES.includes(code)) {
    return true;
  }

  const normalized = `${code} ${name}`.trim();
  return HEROSMS_SERVICE_KEYWORDS.some(keyword => normalized.includes(keyword));
}

function resolveHeroSmsOpenAiService(state, services = []) {
  const preferredCode = String(state?.heroSmsServiceCode || '').trim().toLowerCase();
  const normalizedServices = Array.isArray(services) ? services : [];
  const openAiServices = normalizedServices.filter(item => isHeroSmsOpenAiService(item));

  if (preferredCode && openAiServices.length) {
    const preferredMatch = openAiServices.find(item => item.code === preferredCode);
    if (preferredMatch) {
      return preferredMatch;
    }
  }

  const byStrictKeyword = openAiServices.find((service) => {
    const value = `${service.code} ${service.name}`.toLowerCase();
    return value.includes('openai');
  });
  if (byStrictKeyword) return byStrictKeyword;

  const byAliasCode = openAiServices.find(service => HEROSMS_OPENAI_ALIAS_CODES.includes(service.code));
  if (byAliasCode) return byAliasCode;

  if (openAiServices.length) {
    return openAiServices[0];
  }

  return null;
}

function extractHeroSmsPriceRecord(node, serviceCode = '') {
  if (!node || typeof node !== 'object') return null;

  if (Number.isFinite(Number(node.cost))) {
    const cost = Number(node.cost);
    const count = Number(node.count);
    const physicalCount = Number(node.physicalCount);
    return {
      cost,
      count: Number.isFinite(count) ? Math.trunc(count) : null,
      physicalCount: Number.isFinite(physicalCount) ? Math.trunc(physicalCount) : null,
    };
  }

  if (serviceCode && node[serviceCode] && typeof node[serviceCode] === 'object') {
    return extractHeroSmsPriceRecord(node[serviceCode], '');
  }

  for (const value of Object.values(node)) {
    if (!value || typeof value !== 'object') continue;
    const nested = extractHeroSmsPriceRecord(value, '');
    if (nested) return nested;
  }

  return null;
}

function parseHeroSmsPriceMapByCountry(rawPayload, serviceCode = '') {
  const map = new Map();
  if (!rawPayload || typeof rawPayload !== 'object') return map;

  const sourceEntries = Array.isArray(rawPayload)
    ? rawPayload.flatMap(item => (item && typeof item === 'object' ? Object.entries(item) : []))
    : Object.entries(rawPayload);

  for (const [countryKey, serviceMap] of sourceEntries) {
    const countryId = normalizeHeroSmsCountryId(countryKey);
    if (!countryId) continue;

    const priceRecord = extractHeroSmsPriceRecord(serviceMap, serviceCode);
    if (!priceRecord) continue;
    map.set(countryId, priceRecord);
  }

  return map;
}

function parseHeroSmsOperatorsPayload(rawPayload, countryId = 0) {
  const normalizedCountryId = normalizeHeroSmsCountryId(countryId);
  let operators = [];

  if (Array.isArray(rawPayload)) {
    operators = rawPayload;
  } else if (rawPayload && typeof rawPayload === 'object') {
    if (rawPayload.countryOperators && typeof rawPayload.countryOperators === 'object') {
      const map = rawPayload.countryOperators;
      const countryKey = String(normalizedCountryId || '');
      if (countryKey && Array.isArray(map[countryKey])) {
        operators = map[countryKey];
      } else {
        operators = Object.values(map).flatMap(item => (Array.isArray(item) ? item : []));
      }
    } else if (Array.isArray(rawPayload.operators)) {
      operators = rawPayload.operators;
    }
  }

  const unique = new Set();
  for (const item of operators) {
    const operator = normalizeHeroSmsOperator(item);
    if (!operator) continue;
    unique.add(operator);
  }

  return [...unique.values()].sort((left, right) => left.localeCompare(right));
}

function normalizeHeroSmsTierCount(rawValue) {
  const count = Number(rawValue);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.trunc(count);
}

function pushHeroSmsTierEntry(bucket = [], priceRaw, countRaw = null) {
  const price = Number(String(priceRaw ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(price) || price <= 0) return;

  bucket.push({
    price,
    count: normalizeHeroSmsTierCount(countRaw),
  });
}

function collectHeroSmsTierEntries(rawMap, bucket = []) {
  if (!rawMap || typeof rawMap !== 'object') {
    return bucket;
  }

  if (Array.isArray(rawMap)) {
    for (const item of rawMap) {
      if (!item || typeof item !== 'object') continue;

      const itemPrice = item.price ?? item.cost ?? item.value ?? item.bid ?? item.rate ?? item.maxPrice;
      if (itemPrice !== undefined) {
        const itemCount = item.count ?? item.quantity ?? item.total ?? item.available ?? item.amount ?? item.cnt;
        pushHeroSmsTierEntry(bucket, itemPrice, itemCount);
      }

      collectHeroSmsTierEntries(item, bucket);
    }
    return bucket;
  }

  for (const [key, value] of Object.entries(rawMap)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nestedPrice = value.price ?? value.cost ?? value.value ?? value.bid ?? value.rate ?? value.maxPrice;
      const nestedCount = value.count ?? value.quantity ?? value.total ?? value.available ?? value.amount ?? value.cnt;
      if (nestedPrice !== undefined) {
        pushHeroSmsTierEntry(bucket, nestedPrice, nestedCount);
      } else {
        pushHeroSmsTierEntry(bucket, key, nestedCount);
      }

      collectHeroSmsTierEntries(value, bucket);
      continue;
    }

    pushHeroSmsTierEntry(bucket, key, value);
  }

  return bucket;
}

function mergeHeroSmsPriceEntries(entries = []) {
  const priceMap = new Map();

  for (const entry of entries) {
    const price = Number(entry?.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    const key = price.toFixed(6);
    if (!priceMap.has(key)) {
      priceMap.set(key, {
        price,
        count: null,
      });
    }

    const target = priceMap.get(key);
    const count = Number(entry?.count);
    if (Number.isFinite(count) && count >= 0) {
      target.count = (Number.isFinite(target.count) ? target.count : 0) + Math.trunc(count);
    }
  }

  return [...priceMap.values()].sort((left, right) => right.price - left.price);
}

function collectHeroSmsTopCountryPriceEntries(rawNode, targetCountryId, bucket = [], hintedCountryId = 0, targetServiceCode = '') {
  if (!rawNode || typeof rawNode !== 'object') {
    return bucket;
  }

  const normalizedServiceCode = normalizeHeroSmsServiceCode(targetServiceCode);

  if (!Array.isArray(rawNode) && normalizedServiceCode) {
    const directServiceBranch = rawNode[normalizedServiceCode];
    if (directServiceBranch && typeof directServiceBranch === 'object') {
      collectHeroSmsTopCountryPriceEntries(directServiceBranch, targetCountryId, bucket, hintedCountryId, '');
      return bucket;
    }

    const nodeServiceCode = normalizeHeroSmsServiceCode(
      rawNode.service
      || rawNode.serviceCode
      || rawNode.code
    );
    if (nodeServiceCode && nodeServiceCode !== normalizedServiceCode) {
      return bucket;
    }
  }

  if (Array.isArray(rawNode)) {
    for (const item of rawNode) {
      collectHeroSmsTopCountryPriceEntries(item, targetCountryId, bucket, hintedCountryId, targetServiceCode);
    }
    return bucket;
  }

  const nodeCountryId = normalizeHeroSmsCountryId(
    rawNode.country
    || rawNode.countryId
    || hintedCountryId
  );
  const isTargetCountry = !targetCountryId || (nodeCountryId && nodeCountryId === targetCountryId);

  if (isTargetCountry) {
    const tierSources = [
      rawNode.physicalPriceMap,
      rawNode.priceMap,
      rawNode.prices,
      rawNode.priceList,
      rawNode.price_list,
      rawNode.bids,
    ];

    for (const source of tierSources) {
      if (source && typeof source === 'object') {
        collectHeroSmsTierEntries(source, bucket);
      }
    }
  }

  if (isTargetCountry) {
    const fallbackPrice = Number(rawNode.price ?? rawNode.retail_price ?? rawNode.cost);
    if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
      const fallbackCount = Number(rawNode.count ?? rawNode.physicalCountForDefaultPrice ?? rawNode.physicalTotalCount);
      bucket.push({
        price: fallbackPrice,
        count: Number.isFinite(fallbackCount) ? Math.max(0, Math.trunc(fallbackCount)) : null,
      });
    }
  }

  for (const [key, value] of Object.entries(rawNode)) {
    if (!value || typeof value !== 'object') continue;

    if (
      key === 'physicalPriceMap'
      || key === 'priceMap'
      || key === 'prices'
      || key === 'priceList'
      || key === 'price_list'
      || key === 'bids'
    ) {
      continue;
    }

    let nextHintedCountryId = nodeCountryId || hintedCountryId;
    if (/^\d+$/.test(String(key))) {
      const keyedCountryId = normalizeHeroSmsCountryId(key);
      if (keyedCountryId) {
        nextHintedCountryId = keyedCountryId;
      }
    }

    collectHeroSmsTopCountryPriceEntries(value, targetCountryId, bucket, nextHintedCountryId, targetServiceCode);
  }

  return bucket;
}

function parseHeroSmsTopCountriesPriceOptions(rawPayload, countryId = 0, serviceCode = '') {
  const targetCountryId = normalizeHeroSmsCountryId(countryId);
  const entries = collectHeroSmsTopCountryPriceEntries(rawPayload, targetCountryId, [], 0, serviceCode);
  return mergeHeroSmsPriceEntries(entries);
}

function collectHeroSmsPriceEntriesByCountry(rawNode, targetCountryId, targetServiceCode = '', bucket = [], hintedCountryId = 0) {
  if (!rawNode || typeof rawNode !== 'object') {
    return bucket;
  }

  const normalizedServiceCode = normalizeHeroSmsServiceCode(targetServiceCode);

  if (!Array.isArray(rawNode) && normalizedServiceCode) {
    const directServiceBranch = rawNode[normalizedServiceCode];
    if (directServiceBranch && typeof directServiceBranch === 'object') {
      collectHeroSmsPriceEntriesByCountry(directServiceBranch, targetCountryId, '', bucket, hintedCountryId);
      return bucket;
    }

    const nodeServiceCode = normalizeHeroSmsServiceCode(
      rawNode.service
      || rawNode.serviceCode
      || rawNode.code
    );
    if (nodeServiceCode && nodeServiceCode !== normalizedServiceCode) {
      return bucket;
    }
  }

  if (Array.isArray(rawNode)) {
    for (const item of rawNode) {
      collectHeroSmsPriceEntriesByCountry(item, targetCountryId, targetServiceCode, bucket, hintedCountryId);
    }
    return bucket;
  }

  const nodeCountryId = normalizeHeroSmsCountryId(
    rawNode.country
    || rawNode.countryId
    || rawNode.country_code
    || hintedCountryId
  );
  const isTargetCountry = !targetCountryId || (nodeCountryId && nodeCountryId === targetCountryId);

  if (isTargetCountry) {
    pushHeroSmsTierEntry(
      bucket,
      rawNode.cost ?? rawNode.price ?? rawNode.retail_price,
      rawNode.count ?? rawNode.quantity ?? rawNode.total ?? rawNode.available
    );

    const tierSources = [
      rawNode.physicalPriceMap,
      rawNode.priceMap,
      rawNode.prices,
      rawNode.priceList,
      rawNode.price_list,
      rawNode.bids,
    ];

    for (const source of tierSources) {
      if (source && typeof source === 'object') {
        collectHeroSmsTierEntries(source, bucket);
      }
    }
  }

  for (const [key, value] of Object.entries(rawNode)) {
    if (value && typeof value === 'object') {
      let nextHintedCountryId = nodeCountryId || hintedCountryId;
      if (/^\d+$/.test(String(key))) {
        const keyedCountryId = normalizeHeroSmsCountryId(key);
        if (keyedCountryId) {
          nextHintedCountryId = keyedCountryId;
        }
      }

      collectHeroSmsPriceEntriesByCountry(value, targetCountryId, targetServiceCode, bucket, nextHintedCountryId);
      continue;
    }

    if (!isTargetCountry) {
      continue;
    }

    const numericKeyPrice = Number(String(key || '').trim().replace(',', '.'));
    if (Number.isFinite(numericKeyPrice) && numericKeyPrice > 0) {
      pushHeroSmsTierEntry(bucket, numericKeyPrice, value);
    }
  }

  return bucket;
}

function parseHeroSmsPriceOptionsByCountry(rawPayload, countryId = 0, serviceCode = '') {
  const targetCountryId = normalizeHeroSmsCountryId(countryId);
  const entries = collectHeroSmsPriceEntriesByCountry(rawPayload, targetCountryId, serviceCode, [], 0);
  return mergeHeroSmsPriceEntries(entries);
}

function parseHeroSmsBalance(rawText) {
  const value = String(rawText || '').trim();
  const matched = value.match(/ACCESS_BALANCE\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (matched) {
    return matched[1];
  }

  if (Number.isFinite(Number(value))) {
    return String(Number(value));
  }

  return '';
}

function parseHeroSmsMinActivationSeconds(rawText) {
  const value = String(rawText || '');
  const matched = value.match(/minActivationTime"?\s*[:=]\s*(\d{1,5})/i);
  if (matched) {
    const seconds = Number(matched[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.trunc(seconds);
    }
  }
  return 120;
}

function buildHeroSmsServiceCandidates(state, extraCodes = []) {
  const preferredCode = String(state?.heroSmsServiceCode || '').trim().toLowerCase();
  const normalizedExtra = Array.isArray(extraCodes)
    ? extraCodes.map(code => String(code || '').trim().toLowerCase())
    : [];

  return [
    preferredCode,
    ...normalizedExtra,
  ].filter((code, index, list) => code && list.indexOf(code) === index);
}

function normalizeHeroSmsActivationId(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  const digitsOnly = value.replace(/\D/g, '');
  return digitsOnly || value;
}

function normalizeHeroSmsPhoneNumber(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  const hasPlus = value.startsWith('+');
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

function maskHeroSmsPhoneNumber(rawValue) {
  const digits = String(rawValue || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 6) return digits;
  return `${digits.slice(0, 3)}***${digits.slice(-3)}`;
}

function parseHeroSmsGetNumberResponse(rawText) {
  const value = String(rawText || '').trim();
  if (!value) return null;

  const textMatch = value.match(/^ACCESS_NUMBER\s*:?\s*([^:]+)\s*:\s*(.+)$/i);
  if (textMatch) {
    const activationId = normalizeHeroSmsActivationId(textMatch[1]);
    const phoneNumber = normalizeHeroSmsPhoneNumber(textMatch[2]);
    if (activationId && phoneNumber) {
      return {
        activationId,
        phoneNumber,
        raw: value,
      };
    }
  }

  const jsonPayload = tryParseHeroSmsJson(value);
  if (jsonPayload && typeof jsonPayload === 'object') {
    const activationId = normalizeHeroSmsActivationId(
      jsonPayload.activationId
      || jsonPayload.id
      || jsonPayload.requestId
    );
    const phoneNumber = normalizeHeroSmsPhoneNumber(
      jsonPayload.phoneNumber
      || jsonPayload.phone
      || jsonPayload.number
      || jsonPayload.msisdn
    );

    if (activationId && phoneNumber) {
      return {
        activationId,
        phoneNumber,
        raw: value,
      };
    }
  }

  return null;
}

function parseHeroSmsActivationStatus(rawText) {
  const value = String(rawText || '').trim();
  if (!value) {
    return { state: 'unknown', raw: '' };
  }

  const statusOkMatch = value.match(/^STATUS_OK\s*:?\s*([0-9]{3,10})$/i);
  if (statusOkMatch) {
    return {
      state: 'code',
      code: statusOkMatch[1],
      raw: value,
    };
  }

  if (/^STATUS_WAIT/i.test(value)) {
    return { state: 'wait', raw: value };
  }

  if (/^STATUS_CANCEL/i.test(value) || /^ACCESS_CANCEL/i.test(value) || /^NO_ACTIVATION/i.test(value)) {
    return { state: 'cancel', raw: value };
  }

  const directCodeMatch = value.match(/\b([0-9]{4,10})\b/);
  if (directCodeMatch && !/^STATUS_/i.test(value)) {
    return {
      state: 'code',
      code: directCodeMatch[1],
      raw: value,
    };
  }

  return { state: 'unknown', raw: value };
}

async function resolveHeroSmsServiceCodeFromApi(state) {
  const servicesRaw = await requestHeroSmsStubAction(state, 'getServicesList', { lang: 'cn' });
  const servicesPayload = tryParseHeroSmsJson(servicesRaw);
  if (!servicesPayload) {
    throw new Error(`HeroSMS getServicesList returned non-JSON response: ${servicesRaw}`);
  }

  const services = normalizeHeroSmsServicesPayload(servicesPayload);
  const targetService = resolveHeroSmsOpenAiService(state, services);
  if (!targetService?.code) {
    throw new Error('Failed to locate OpenAI/ChatGPT/Codex service in HeroSMS service list.');
  }

  const updates = {
    heroSmsServiceCode: targetService.code,
  };
  await setState(updates);
  await persistSettingsIfNeeded(updates);

  return targetService.code;
}

async function requestHeroSmsActivationNumber(state, countryId) {
  const normalizedCountryId = normalizeHeroSmsCountryId(countryId);
  if (!normalizedCountryId) {
    throw new Error('HeroSMS region is not selected.');
  }

  const selectedOperator = normalizeHeroSmsOperator(state?.heroSmsOperator);
  const selectedMaxPrice = normalizeHeroSmsMaxPrice(state?.heroSmsMaxPrice);
  const selectedFixedPrice = Boolean(state?.heroSmsFixedPrice);

  const resolvedServiceCode = await resolveHeroSmsServiceCodeFromApi(state);

  const customFilters = [];
  if (selectedOperator) {
    customFilters.push(`operator=${selectedOperator}`);
  }
  if (selectedMaxPrice) {
    customFilters.push(`${selectedFixedPrice ? 'fixedPrice' : 'maxPrice'}=${selectedMaxPrice}`);
  }
  if (customFilters.length) {
    await addLog(`HeroSMS: using custom filters for ${resolvedServiceCode} (${customFilters.join(', ')})`, 'info');
  }

  const triedServiceCodes = new Set();
  let lastError = null;

  async function tryGetNumberByService(serviceCode) {
    if (!serviceCode || triedServiceCodes.has(serviceCode)) {
      return null;
    }
    triedServiceCodes.add(serviceCode);

    try {
      const requestParams = {
        service: serviceCode,
        country: normalizedCountryId,
      };

      if (selectedOperator) {
        requestParams.operator = selectedOperator;
      }
      if (selectedMaxPrice) {
        requestParams.maxPrice = selectedMaxPrice;
        if (selectedFixedPrice) {
          requestParams.fixedPrice = 'true';
        }
      }

      const numberRaw = await requestHeroSmsStubAction(state, 'getNumber', requestParams);
      const parsed = parseHeroSmsGetNumberResponse(numberRaw);
      if (!parsed) {
        throw new Error(`HeroSMS getNumber returned unexpected response: ${numberRaw}`);
      }

      const updates = {
        heroSmsServiceCode: serviceCode,
      };
      await setState(updates);
      await persistSettingsIfNeeded(updates);

      return {
        ...parsed,
        serviceCode,
      };
    } catch (err) {
      lastError = err;
      const message = getErrorMessage(err);
      if (/NO_BALANCE|NO_MONEY|BAD_KEY|BANNED|ACCOUNT_BLOCKED/i.test(message)) {
        throw err;
      }
      return null;
    }
  }

  const candidateCodes = buildHeroSmsServiceCandidates({ heroSmsServiceCode: resolvedServiceCode });
  for (const serviceCode of candidateCodes) {
    const result = await tryGetNumberByService(serviceCode);
    if (result) return result;
  }

  throw new Error(
    `HeroSMS getNumber failed for OpenAI service ${resolvedServiceCode} in country #${normalizedCountryId}${lastError ? `: ${getErrorMessage(lastError)}` : ''}`
  );
}

async function setHeroSmsActivationStatus(state, activationId, status, options = {}) {
  const normalizedActivationId = normalizeHeroSmsActivationId(activationId);
  const normalizedStatus = String(status || '').trim();
  if (!normalizedActivationId || !normalizedStatus) return '';

  try {
    return await requestHeroSmsStubAction(state, 'setStatus', {
      id: normalizedActivationId,
      status: normalizedStatus,
    });
  } catch (err) {
    const message = getErrorMessage(err);

    if (normalizedStatus === HEROSMS_ACTIVATION_STATUS_CANCEL && /EARLY_CANCEL_DENIED|minActivationTime/i.test(message)) {
      const minSeconds = parseHeroSmsMinActivationSeconds(message);
      if (!options.silent) {
        await addLog(
          `HeroSMS cancel denied for activation ${normalizedActivationId}: minimum active time is ${minSeconds}s.`,
          'warn'
        );
      }
      if (options.ignoreError) {
        return '';
      }
    }

    if (!options.silent) {
      await addLog(
        `HeroSMS setStatus(${normalizedStatus}) failed for activation ${normalizedActivationId}: ${message}`,
        'warn'
      );
    }
    if (options.ignoreError) {
      return '';
    }
    throw err;
  }
}

async function pollHeroSmsActivationCode(state, activationId, options = {}) {
  const step = Number(options.step || 6);
  const normalizedActivationId = normalizeHeroSmsActivationId(activationId);
  if (!normalizedActivationId) {
    throw new Error('HeroSMS activation id is missing.');
  }

  const maxAttempts = Math.max(1, Number(options.maxAttempts || HEROSMS_SMS_POLL_MAX_ATTEMPTS));
  const intervalMs = Math.max(1000, Number(options.intervalMs || HEROSMS_SMS_POLL_INTERVAL_MS));
  let lastStatusRaw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();

    let statusRaw = '';
    try {
      statusRaw = await requestHeroSmsStubAction(state, 'getStatus', {
        id: normalizedActivationId,
      });
    } catch (err) {
      const message = getErrorMessage(err);
      if (/STATUS_CANCEL|ACCESS_CANCEL|NO_ACTIVATION/i.test(message)) {
        throw new Error(`HeroSMS activation was cancelled: ${message}`);
      }
      throw err;
    }

    const parsedStatus = parseHeroSmsActivationStatus(statusRaw);
    lastStatusRaw = parsedStatus.raw || statusRaw;

    if (parsedStatus.state === 'code' && parsedStatus.code) {
      return parsedStatus.code;
    }

    if (parsedStatus.state === 'cancel') {
      throw new Error(`HeroSMS activation was cancelled: ${parsedStatus.raw || 'STATUS_CANCEL'}`);
    }

    if (typeof options.onStatus === 'function') {
      try {
        await options.onStatus({
          attempt,
          maxAttempts,
          status: parsedStatus.raw || 'STATUS_WAIT_CODE',
          state: parsedStatus.state,
        });
      } catch {}
    }

    if (attempt === 1 || attempt === maxAttempts || attempt % 4 === 0) {
      await addLog(
        `Step ${step}: HeroSMS waiting SMS (${attempt}/${maxAttempts}) - ${parsedStatus.raw || 'STATUS_WAIT_CODE'}`
      );
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  const timeoutSec = Math.round((maxAttempts * intervalMs) / 1000);
  throw new Error(`HeroSMS SMS code timeout after ${timeoutSec}s. Last status: ${lastStatusRaw || 'unknown'}`);
}

async function runHeroSmsPhoneVerificationFlow(state, options = {}) {
  const step = Number(options.step || 6);

  await updateHeroSmsRuntime({
    state: 'running',
    activationId: '',
    maskedPhone: '',
    detail: `Step ${step}: 准备 HeroSMS 手机验证...`,
    error: '',
  });

  if (!state?.heroSmsEnabled) {
    await updateHeroSmsRuntime({
      state: 'failed',
      detail: `Step ${step}: HeroSMS 未启用。`,
      error: 'HeroSMS is disabled.',
    });
    throw new Error('HeroSMS is disabled.');
  }

  const countryId = normalizeHeroSmsCountryId(state.heroSmsCountryId || state.heroSmsCountryMeta?.id);
  if (!countryId) {
    await updateHeroSmsRuntime({
      state: 'failed',
      detail: `Step ${step}: 未选择 HeroSMS 地区。`,
      error: 'HeroSMS region is not selected.',
    });
    throw new Error('HeroSMS region is not selected.');
  }

  const countryMeta = normalizeHeroSmsCountryMeta(state.heroSmsCountryMeta || { id: countryId });

  let countryApplied = null;
  let lastApplyError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      countryApplied = await applyHeroSmsCountryToAddPhone(state);
      if (countryApplied?.matched) {
        break;
      }
    } catch (err) {
      lastApplyError = err;
    }

    if (attempt < 3) {
      await sleepWithStop(1200);
    }
  }

  if (!countryApplied?.matched) {
    const applyMessage = lastApplyError
      ? getErrorMessage(lastApplyError)
      : 'Could not detect add-phone country selector on current page.';
    await updateHeroSmsRuntime({
      state: 'failed',
      detail: `Step ${step}: add-phone 地区匹配失败。`,
      error: applyMessage,
    });
    if (lastApplyError) {
      throw lastApplyError;
    }
    throw new Error('Could not detect add-phone country selector on current page.');
  }

  const selectedCountryLabel = countryApplied.selectedCountryLabel || countryMeta?.displayName || `#${countryId}`;

  await addLog(
    `Step ${step}: add-phone country selected: ${selectedCountryLabel}.`,
    'ok'
  );
  await updateHeroSmsRuntime({
    state: 'running',
    detail: `Step ${step}: 已选择地区 ${selectedCountryLabel}。`,
    error: '',
  });

  const activation = await requestHeroSmsActivationNumber(state, countryId);
  const maskedPhone = maskHeroSmsPhoneNumber(activation.phoneNumber);
  await addLog(
    `Step ${step}: HeroSMS number acquired (${maskedPhone}), activation #${activation.activationId}, service ${activation.serviceCode}.`,
    'ok'
  );
  await updateHeroSmsRuntime({
    state: 'waiting_code',
    activationId: activation.activationId,
    maskedPhone,
    detail: `Step ${step}: 已取号，正在提交手机号。`,
    error: '',
  });

  let activationDone = false;
  try {
    const submitPhoneResponse = await sendToContentScript('signup-page', {
      type: 'FILL_ADD_PHONE_NUMBER',
      source: 'background',
      payload: {
        phoneNumber: activation.phoneNumber,
        countryId,
        countryMeta,
        activationId: activation.activationId,
        serviceCode: activation.serviceCode,
      },
    });

    if (submitPhoneResponse?.error) {
      throw new Error(submitPhoneResponse.error);
    }
    if (!submitPhoneResponse?.submitted && !submitPhoneResponse?.alreadyWaitingCode && !submitPhoneResponse?.codeSurface) {
      throw new Error('HeroSMS phone number submission did not reach code input surface.');
    }

    await setHeroSmsActivationStatus(state, activation.activationId, HEROSMS_ACTIVATION_STATUS_READY, {
      silent: true,
      ignoreError: true,
    });

    await updateHeroSmsRuntime({
      state: 'waiting_code',
      activationId: activation.activationId,
      maskedPhone,
      detail: `Step ${step}: 手机号已提交，等待短信验证码。`,
      error: '',
    });

    const smsCode = await pollHeroSmsActivationCode(state, activation.activationId, {
      step,
      onStatus: async ({ attempt, maxAttempts, status }) => {
        if (attempt === 1 || attempt === maxAttempts || attempt % 2 === 0) {
          await updateHeroSmsRuntime({
            state: 'waiting_code',
            activationId: activation.activationId,
            maskedPhone,
            detail: `Step ${step}: 等待短信 ${attempt}/${maxAttempts} (${status})`,
            error: '',
          });
        }
      },
    });

    await updateHeroSmsRuntime({
      state: 'submitting_code',
      activationId: activation.activationId,
      maskedPhone,
      detail: `Step ${step}: 已收到短信验证码，正在提交。`,
      error: '',
    });

    const submitCodeResponse = await sendToContentScript('signup-page', {
      type: 'FILL_ADD_PHONE_CODE',
      source: 'background',
      payload: { code: smsCode },
    });

    if (submitCodeResponse?.error) {
      throw new Error(submitCodeResponse.error);
    }
    if (!submitCodeResponse?.submitted) {
      throw new Error('HeroSMS SMS code submission was not confirmed by page script.');
    }

    await setHeroSmsActivationStatus(state, activation.activationId, HEROSMS_ACTIVATION_STATUS_COMPLETE, {
      silent: true,
      ignoreError: true,
    });
    activationDone = true;

    await updateHeroSmsRuntime({
      state: 'completed',
      activationId: activation.activationId,
      maskedPhone,
      detail: `Step ${step}: 手机验证完成。`,
      error: '',
    });

    await addLog(`Step ${step}: HeroSMS SMS code submitted successfully.`, 'ok');

    return {
      activationId: activation.activationId,
      phoneNumber: activation.phoneNumber,
      maskedPhone,
      serviceCode: activation.serviceCode,
      countryId,
      selectedCountryLabel,
    };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    if (!activationDone) {
      await setHeroSmsActivationStatus(state, activation.activationId, HEROSMS_ACTIVATION_STATUS_CANCEL, {
        silent: true,
        ignoreError: true,
      });
    }

    await updateHeroSmsRuntime({
      state: isStopError(err) ? 'cancelled' : 'failed',
      activationId: activation.activationId,
      maskedPhone,
      detail: isStopError(err)
        ? `Step ${step}: 流程已停止，号码已取消。`
        : `Step ${step}: 手机验证失败。`,
      error: isStopError(err) ? '' : errorMessage,
    });

    throw err;
  }
}

async function fetchHeroSmsRegions(options = {}) {
  const state = await getState();
  void options;

  if (!state.heroSmsEnabled) {
    throw new Error('HeroSMS is disabled. Enable it in side panel first.');
  }

  const countriesRaw = await requestHeroSmsStubAction(state, 'getCountries');
  const countriesPayload = tryParseHeroSmsJson(countriesRaw);
  if (!countriesPayload) {
    throw new Error(`HeroSMS getCountries returned non-JSON response: ${countriesRaw}`);
  }

  const countries = normalizeHeroSmsCountriesPayload(countriesPayload);
  if (!countries.length) {
    throw new Error('HeroSMS getCountries returned an empty list.');
  }

  const servicesRaw = await requestHeroSmsStubAction(state, 'getServicesList', { lang: 'cn' });
  const servicesPayload = tryParseHeroSmsJson(servicesRaw);
  if (!servicesPayload) {
    throw new Error(`HeroSMS getServicesList returned non-JSON response: ${servicesRaw}`);
  }

  const services = normalizeHeroSmsServicesPayload(servicesPayload);
  const targetService = resolveHeroSmsOpenAiService(state, services);
  if (!targetService?.code) {
    throw new Error('Failed to locate OpenAI/ChatGPT/Codex service in HeroSMS service list.');
  }

  let priceMap = new Map();

  try {
    const pricesRaw = await requestHeroSmsStubAction(state, 'getPrices', { service: targetService.code });
    const pricesPayload = tryParseHeroSmsJson(pricesRaw);
    if (pricesPayload) {
      const parsedPriceMap = parseHeroSmsPriceMapByCountry(pricesPayload, targetService.code);
      if (parsedPriceMap.size) {
        priceMap = parsedPriceMap;
      }
    }
  } catch {}

  if (!priceMap.size) {
    await addLog(`HeroSMS: OpenAI service ${targetService.code} returned no price map, using region list without cost sort hint.`, 'warn');
  }

  const mergedCountries = countries
    .map((country) => {
      const priced = priceMap.get(country.id);
      return {
        ...country,
        cost: priced?.cost ?? null,
        count: priced?.count ?? null,
      };
    })
    .sort((left, right) => {
      const leftCost = Number.isFinite(Number(left.cost)) ? Number(left.cost) : Number.POSITIVE_INFINITY;
      const rightCost = Number.isFinite(Number(right.cost)) ? Number(right.cost) : Number.POSITIVE_INFINITY;
      if (leftCost !== rightCost) return leftCost - rightCost;
      return left.id - right.id;
    });

  const balanceRaw = await requestHeroSmsStubAction(state, 'getBalance');
  const balance = parseHeroSmsBalance(balanceRaw);
  const updates = {
    heroSmsServiceCode: targetService.code,
    heroSmsBalanceLabel: balance,
  };
  await setState(updates);
  await persistSettingsIfNeeded(updates);

  return {
    countries: mergedCountries,
    balance,
    balanceLabel: balance,
    serviceCode: targetService.code,
    serviceName: targetService.name,
    selectedCountryId: normalizeHeroSmsCountryId(state.heroSmsCountryId),
  };
}

async function fetchHeroSmsCustomOptions(options = {}) {
  const state = await getState();

  if (!state.heroSmsEnabled) {
    throw new Error('HeroSMS is disabled. Enable it in side panel first.');
  }

  const countryId = normalizeHeroSmsCountryId(options.countryId || state.heroSmsCountryId || state.heroSmsCountryMeta?.id);
  if (!countryId) {
    throw new Error('HeroSMS region is not selected.');
  }

  const serviceCode = await resolveHeroSmsServiceCodeFromApi(state);
  const selectedOperator = normalizeHeroSmsOperator(state.heroSmsOperator);
  let operators = [];
  let priceOptions = [];
  let tierPriceOptions = [];
  let operatorError = '';
  let priceError = '';
  const tierCandidateEntries = [];

  try {
    const operatorsRaw = await requestHeroSmsStubAction(state, 'getOperators', { country: countryId });
    const operatorsPayload = tryParseHeroSmsJson(operatorsRaw);
    if (operatorsPayload) {
      operators = parseHeroSmsOperatorsPayload(operatorsPayload, countryId);
    }
  } catch (err) {
    operatorError = getErrorMessage(err);
  }

  const operatorProbeValues = [selectedOperator, 'any', ''];
  const topRequestPlans = [];

  for (const operator of operatorProbeValues) {
    for (const freePrice of ['true', '1']) {
      const topRankParams = {
        service: serviceCode,
        country: countryId,
        freePrice,
      };
      const topParams = {
        service: serviceCode,
        country: countryId,
        freePrice,
      };

      if (operator) {
        topRankParams.operator = operator;
        topParams.operator = operator;
      }

      topRequestPlans.push({ action: 'getTopCountriesByServiceRank', params: topRankParams });
      topRequestPlans.push({ action: 'getTopCountriesByService', params: topParams });

      const pricesByCountryParams = {
        service: serviceCode,
        country: countryId,
        freePrice,
      };
      const pricesAllCountryParams = {
        service: serviceCode,
        freePrice,
      };

      if (operator) {
        pricesByCountryParams.operator = operator;
        pricesAllCountryParams.operator = operator;
      }

      topRequestPlans.push({ action: 'getPrices', params: pricesByCountryParams });
      topRequestPlans.push({ action: 'getPrices', params: pricesAllCountryParams });
    }
  }

  const dedupPlanMap = new Map();
  for (const plan of topRequestPlans) {
    const signature = `${plan.action}|${Object.entries(plan.params)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')}`;
    if (!dedupPlanMap.has(signature)) {
      dedupPlanMap.set(signature, plan);
    }
  }

  const dedupedTopRequestPlans = [...dedupPlanMap.values()];

  for (const plan of dedupedTopRequestPlans) {
    try {
      const topRaw = await requestHeroSmsStubAction(state, plan.action, plan.params);
      const topPayload = tryParseHeroSmsJson(topRaw);
      if (!topPayload) {
        continue;
      }

      const parsedTopTiers = /^getTopCountriesByService/i.test(plan.action)
        ? parseHeroSmsTopCountriesPriceOptions(topPayload, countryId, serviceCode)
        : [];
      const parsedPriceTiers = plan.action === 'getPrices'
        ? parseHeroSmsPriceOptionsByCountry(topPayload, countryId, serviceCode)
        : [];
      const parsedTiers = [...parsedTopTiers, ...parsedPriceTiers];

      if (parsedTiers.length) {
        tierCandidateEntries.push(...parsedTiers);
      }
    } catch {}
  }

  if (tierCandidateEntries.length) {
    const tierMap = new Map();

    for (const option of tierCandidateEntries) {
      const price = Number(option?.price);
      if (!Number.isFinite(price) || price <= 0) continue;

      const key = price.toFixed(6);
      if (!tierMap.has(key)) {
        tierMap.set(key, {
          price,
          count: null,
        });
      }

      const target = tierMap.get(key);
      const count = Number(option?.count);
      if (Number.isFinite(count) && count >= 0) {
        target.count = (Number.isFinite(target.count) ? target.count : 0) + Math.trunc(count);
      }
    }

    tierPriceOptions = [...tierMap.values()].sort((left, right) => right.price - left.price);
  }

  try {
    const pricesRaw = await requestHeroSmsStubAction(state, 'getPrices', {
      service: serviceCode,
      country: countryId,
    });
    const pricesPayload = tryParseHeroSmsJson(pricesRaw);
    if (pricesPayload) {
      priceOptions = parseHeroSmsPriceOptionsByCountry(pricesPayload, countryId, serviceCode);
    }
  } catch (err) {
    priceError = getErrorMessage(err);
  }

  if (tierPriceOptions.length) {
    const merged = new Map();

    for (const option of tierPriceOptions) {
      const price = Number(option?.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      merged.set(price.toFixed(6), {
        price,
        count: Number.isFinite(Number(option?.count)) ? Math.max(0, Math.trunc(Number(option.count))) : null,
      });
    }

    for (const option of priceOptions) {
      const price = Number(option?.price);
      if (!Number.isFinite(price) || price <= 0) continue;

      const key = price.toFixed(6);
      if (!merged.has(key)) {
        merged.set(key, {
          price,
          count: Number.isFinite(Number(option?.count)) ? Math.max(0, Math.trunc(Number(option.count))) : null,
        });
      }
    }

    priceOptions = [...merged.values()].sort((left, right) => right.price - left.price);
  }

  if (!priceOptions.length) {
    const fallbackMeta = normalizeHeroSmsCountryMeta(
      options.countryMeta
      || state.heroSmsCountryMeta
      || { id: countryId }
    );
    const fallbackCost = Number(fallbackMeta?.cost);
    const fallbackCount = Number(fallbackMeta?.count);
    if (Number.isFinite(fallbackCost) && fallbackCost > 0) {
      priceOptions = [{
        price: fallbackCost,
        count: Number.isFinite(fallbackCount) ? Math.max(0, Math.trunc(fallbackCount)) : null,
      }];
    }
  }

  if (!operators.length && !priceOptions.length && operatorError && priceError) {
    throw new Error(`Failed to load HeroSMS custom options: operators(${operatorError}) prices(${priceError})`);
  }

  return {
    countryId,
    serviceCode,
    operators,
    priceOptions,
    selectedOperator: normalizeHeroSmsOperator(state.heroSmsOperator),
    selectedMaxPrice: normalizeHeroSmsMaxPrice(state.heroSmsMaxPrice),
    selectedFixedPrice: Boolean(state.heroSmsFixedPrice),
  };
}

async function applyHeroSmsCountryToAddPhone(state) {
  if (!state?.heroSmsEnabled) {
    return { matched: false };
  }

  const countryId = normalizeHeroSmsCountryId(state.heroSmsCountryId || state.heroSmsCountryMeta?.id);
  if (!countryId) {
    throw new Error('HeroSMS region is not selected.');
  }

  const countryMeta = normalizeHeroSmsCountryMeta(state.heroSmsCountryMeta || { id: countryId });
  const response = await sendToContentScript('signup-page', {
    type: 'SELECT_ADD_PHONE_COUNTRY',
    source: 'background',
    payload: {
      countryId,
      countryMeta,
    },
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  return {
    matched: Boolean(response?.matched),
    selectedCountryLabel: String(response?.selectedCountryLabel || countryMeta?.displayName || `#${countryId}`),
    selectedCountryValue: String(response?.selectedCountryValue || ''),
  };
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

async function updateHeroSmsRuntime(patch = {}, options = {}) {
  const state = await getState();
  const current = normalizeHeroSmsRuntime(state.heroSmsRuntime);
  const next = normalizeHeroSmsRuntime({
    ...(options.reset ? createHeroSmsRuntimeState() : current),
    ...patch,
    updatedAt: Date.now(),
  });

  await setState({ heroSmsRuntime: next });
  broadcastDataUpdate({ heroSmsRuntime: next });
  return next;
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
  const shouldRestartSignup = context.restartSignup !== false;
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

  if (!shouldRestartSignup) {
    return;
  }

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
      if (message.payload.heroSmsEnabled !== undefined) updates.heroSmsEnabled = Boolean(message.payload.heroSmsEnabled);
      if (message.payload.heroSmsApiKey !== undefined) {
        updates.heroSmsApiKey = normalizeHeroSmsApiKey(message.payload.heroSmsApiKey);
        updates.heroSmsBalanceLabel = '';
        updates.heroSmsServiceCode = '';
      }
      if (message.payload.heroSmsCountryId !== undefined) {
        updates.heroSmsCountryId = normalizeHeroSmsCountryId(message.payload.heroSmsCountryId);
      }
      if (message.payload.heroSmsCountryMeta !== undefined) {
        updates.heroSmsCountryMeta = normalizeHeroSmsCountryMeta(message.payload.heroSmsCountryMeta);
      }
      if (message.payload.heroSmsServiceCode !== undefined) {
        updates.heroSmsServiceCode = String(message.payload.heroSmsServiceCode || '').trim().toLowerCase();
      }
      if (message.payload.heroSmsOperator !== undefined) {
        updates.heroSmsOperator = normalizeHeroSmsOperator(message.payload.heroSmsOperator);
      }
      if (message.payload.heroSmsMaxPrice !== undefined) {
        updates.heroSmsMaxPrice = normalizeHeroSmsMaxPrice(message.payload.heroSmsMaxPrice);
      }
      if (message.payload.heroSmsFixedPrice !== undefined) {
        updates.heroSmsFixedPrice = Boolean(message.payload.heroSmsFixedPrice);
      }
      if (updates.heroSmsMaxPrice === '') {
        updates.heroSmsFixedPrice = false;
      }
      if (updates.heroSmsCountryMeta && updates.heroSmsCountryId === undefined) {
        updates.heroSmsCountryId = normalizeHeroSmsCountryId(updates.heroSmsCountryMeta.id);
      }
      if (updates.heroSmsCountryId === 0) {
        updates.heroSmsCountryMeta = null;
      }
      const shouldResetHeroSmsRuntime =
        (updates.heroSmsEnabled !== undefined && !updates.heroSmsEnabled)
        || (updates.heroSmsApiKey !== undefined && !updates.heroSmsApiKey)
        || (updates.heroSmsCountryId !== undefined && updates.heroSmsCountryId === 0);
      if (shouldResetHeroSmsRuntime) {
        updates.heroSmsRuntime = createHeroSmsRuntimeState();
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
      if (updates.heroSmsRuntime !== undefined) {
        broadcastDataUpdate({ heroSmsRuntime: updates.heroSmsRuntime });
      }
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

    case 'FETCH_HEROSMS_REGIONS': {
      clearStopRequest();
      const data = await fetchHeroSmsRegions(message.payload || {});
      return { ok: true, ...data };
    }

    case 'FETCH_HEROSMS_CUSTOM_OPTIONS': {
      clearStopRequest();
      const data = await fetchHeroSmsCustomOptions(message.payload || {});
      return { ok: true, ...data };
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
    case 7:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
    case 8:
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

  try {
    const runtime = normalizeHeroSmsRuntime((await getState()).heroSmsRuntime);
    if (runtime.state === 'running' || runtime.state === 'waiting_code' || runtime.state === 'submitting_code') {
      await updateHeroSmsRuntime({
        state: 'cancelled',
        detail: '流程已停止。',
        error: '',
      });
    }
  } catch {}

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
      case 6: await executeStep6Profile(state); break;
      case 7: await executeStep6(state, 7); break;
      case 8: await executeStep7(state, 8); break;
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
  const stepTimeoutMs = step === 5 ? 240000 : 120000;
  const promise = waitForStepComplete(step, stepTimeoutMs);
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
    5: 900,
    6: 1500,
    7: 900,
    8: 700,
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

async function applySub2apiPostImportSettings(state, accountId, authCredential, stepNumber = 7) {
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
        `Step ${stepNumber}: Sub2API account #${accountId} settings updated (并发 ${SUB2API_POST_IMPORT_DEFAULTS.maxConcurrency} / 负载 ${SUB2API_POST_IMPORT_DEFAULTS.loadFactor} / 优先级 ${SUB2API_POST_IMPORT_DEFAULTS.priority} / 计费倍率 ${SUB2API_POST_IMPORT_DEFAULTS.billingMultiplier}; 分组 ${selectedGroups} 个)`,
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
    throw new Error('No callback URL. Complete the OAuth confirm step first.');
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
    const successSelectors = [
      'input[name="name"]',
      'input[placeholder*="全名"]',
      '[role="spinbutton"][data-type="year"]',
      'input[name="birthday"]',
      'input[name="age"]',
    ];
    if (current.heroSmsEnabled) {
      successSelectors.push(
        'input[name="phone"]',
        'input[type="tel"]',
        'select[name="country"]',
        'select[id*="country"]'
      );
    }

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
          successSelectors,
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
        successSelectors,
      });
      return;
    } catch (err) {
      const abuseError = isMicrosoftServiceAbuseError(err);
      const phoneChallengeError = isMicrosoftPhoneChallengeError(err);
      const shouldAutoRecover = Boolean(current.autoRunning);

      if (!abuseError && !phoneChallengeError) {
        throw err;
      }

      if (round >= maxSwitchRounds) {
        throw new Error(`Step 4: ${getErrorMessage(err)}. Reached maximum blocked-account retry rounds (${maxSwitchRounds}).`);
      }

      if (phoneChallengeError) {
        if (current.heroSmsEnabled) {
          await addLog('Step 4: add-phone challenge detected. HeroSMS phone verification will run in step 5.', 'warn');
          await completeBackgroundStep(4, {});
          return;
        }

        await handleMicrosoftPhoneChallengeDuringStep4(current, {
          round,
          maxRounds: maxSwitchRounds,
          restartSignup: shouldAutoRecover,
        });
        if (!shouldAutoRecover) {
          throw new Error('Step 4: Detected add-phone challenge. Email has been marked and replaced. Please rerun from step 3.');
        }
      } else {
        await handleMicrosoftServiceAbuseDuringStep4(current, {
          round,
          maxRounds: maxSwitchRounds,
          restartSignup: shouldAutoRecover,
        });
        if (!shouldAutoRecover) {
          throw new Error('Step 4: Detected blocked-account abuse. Email has been handled and replaced. Please rerun from step 3.');
        }
      }
    }
  }
}

// ============================================================
// Step 5: HeroSMS Phone Verification (add-phone)
// ============================================================

async function executeStep5(state) {
  const current = state || await getState();

  if (!current.heroSmsEnabled) {
    await addLog('Step 5: HeroSMS is disabled, skipping phone verification step.', 'warn');
    await setStepStatus(5, 'skipped');
    notifyStepComplete(5, { skipped: true, reason: 'heroSmsDisabled' });
    return;
  }

  let addPhoneDetected = false;
  try {
    const surface = await sendToContentScript('signup-page', {
      type: 'CHECK_ADD_PHONE_SURFACE',
      source: 'background',
      payload: {},
    });
    addPhoneDetected = Boolean(surface?.isAddPhoneSurface);
  } catch (err) {
    await addLog(`Step 5: Failed to detect add-phone surface: ${getErrorMessage(err)}`, 'warn');
  }

  if (!addPhoneDetected) {
    await addLog('Step 5: add-phone surface not detected. Skipping phone verification step.', 'warn');
    await setStepStatus(5, 'skipped');
    notifyStepComplete(5, { skipped: true, reason: 'addPhoneNotDetected' });
    return;
  }

  await addLog('Step 5: add-phone detected. Starting HeroSMS phone verification...', 'info');
  const heroResult = await runHeroSmsPhoneVerificationFlow(current, { step: 5 });
  await addLog(`Step 5: HeroSMS phone verification completed (${heroResult.maskedPhone || 'number hidden'}).`, 'ok');

  try {
    await waitForSignupSurface({
      step: 5,
      selectors: [
        'input[name="name"]',
        'input[placeholder*="全名"]',
        '[role="spinbutton"][data-type="year"]',
        'input[name="birthday"]',
        'input[name="age"]',
      ],
      timeout: 30000,
    }, 30000);
  } catch (err) {
    await addLog(`Step 5: Profile form not ready after phone verification: ${getErrorMessage(err)}`, 'warn');
  }

  await completeBackgroundStep(5, {
    heroSmsPhoneVerified: true,
    heroSmsActivationId: heroResult.activationId,
  });
}

// ============================================================
// Step 6: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep6Profile(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 6: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 7: Complete OAuth (auto click + localhost listener)
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

async function finalizeStep6WithCallbackUrl(callbackUrl, stepNumber = 6) {
  const oauthStep = Number(stepNumber || 6);
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

  await addLog(`Step ${oauthStep}: Captured localhost URL: ${callbackUrl}`, 'ok');
  await completeBackgroundStep(oauthStep, { localhostUrl: callbackUrl });
}

async function executeStep6(state, stepNumber = 6) {
  const oauthStep = Number(stepNumber || 6);
  const stepLabel = `Step ${oauthStep}`;

  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  const existingCallbackUrl = await findExistingLocalCallbackUrl(state);
  if (existingCallbackUrl) {
    await addLog(`${stepLabel}: Existing localhost callback already detected. Reusing it.`, 'warn');
    await finalizeStep6WithCallbackUrl(existingCallbackUrl, oauthStep);
    return;
  }

  await addLog(`${stepLabel}: Setting up localhost redirect listener...`);

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
            await finalizeStep6WithCallbackUrl(callbackUrl, oauthStep);
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
            await finalizeStep6WithCallbackUrl(details.url, oauthStep);
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
          await addLog(`${stepLabel}: Switched to auth page. Preparing continue click...`);
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog(`${stepLabel}: Auth tab reopened. Preparing continue click...`);
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

            await addLog(`${stepLabel}: Auth page helper disconnected, reinjecting and retrying...`, 'warn');
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
          await addLog(`${stepLabel}: Current page is not consent yet (likely /about-you). Continue clicked once, waiting for consent page...`, 'warn');

          await waitForSignupSurface({
            step: oauthStep,
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
            await addLog(`${stepLabel}: Continue button clicked. Waiting for localhost redirect...`, 'ok');
            await sleepWithStop(700);
          }

          if (!resolved) {
            await clickWithDebugger(signupTabId, clickResult?.rect);
            await addLog(`${stepLabel}: Debugger click dispatched as fallback, waiting for redirect...`);
          }
        }
      } catch (err) {
        if (resolved) {
          return;
        }

        const message = getErrorMessage(err);
        const phoneChallengeError = isMicrosoftPhoneChallengeError(message);
        if (phoneChallengeError) {
          const current = await getState();

          if (current.heroSmsEnabled) {
            try {
              const heroResult = await runHeroSmsPhoneVerificationFlow(current, { step: oauthStep });
              await addLog(
                `${stepLabel}: add-phone challenge handled by HeroSMS (${heroResult.maskedPhone || 'number hidden'}).`,
                'ok'
              );

              const callbackAfterHero = await findExistingLocalCallbackUrl();
              if (callbackAfterHero) {
                resolved = true;
                cleanupAll();
                await finalizeStep6WithCallbackUrl(callbackAfterHero, oauthStep);
                resolve();
                return;
              }

              const signupTabId = await getTabId('signup-page');
              if (signupTabId) {
                await chrome.tabs.update(signupTabId, { active: true });
                try {
                  const retryClickResult = await sendToContentScript('signup-page', {
                    type: 'STEP6_FIND_AND_CLICK',
                    source: 'background',
                    payload: { dryRun: false },
                  });

                  if (retryClickResult?.error) {
                    await addLog(
                      `${stepLabel}: HeroSMS verified but continue-click retry failed: ${retryClickResult.error}`,
                      'warn'
                    );
                  } else if (retryClickResult?.directClicked) {
                    await addLog(`${stepLabel}: HeroSMS verified. Continue button clicked again, waiting for localhost redirect...`, 'ok');
                    await sleepWithStop(700);

                    const callbackAfterRetry = await findExistingLocalCallbackUrl();
                    if (callbackAfterRetry) {
                      resolved = true;
                      cleanupAll();
                      await finalizeStep6WithCallbackUrl(callbackAfterRetry, oauthStep);
                      resolve();
                      return;
                    }

                    if (retryClickResult?.rect) {
                      try {
                        await clickWithDebugger(signupTabId, retryClickResult.rect);
                        await addLog(`${stepLabel}: HeroSMS verified. Debugger click dispatched as fallback, waiting for localhost redirect...`);
                      } catch (debugErr) {
                        await addLog(
                          `${stepLabel}: HeroSMS verified but debugger fallback click failed: ${getErrorMessage(debugErr)}`,
                          'warn'
                        );
                      }
                    }
                  } else {
                    await addLog(`${stepLabel}: HeroSMS verified. Waiting for localhost redirect...`, 'info');
                  }
                } catch (retryErr) {
                  await addLog(
                    `${stepLabel}: HeroSMS verified but continue-click retry failed: ${getErrorMessage(retryErr)}`,
                    'warn'
                  );
                }
              }

              return;
            } catch (heroErr) {
              resolved = true;
              cleanupAll();
              reject(new Error(`${stepLabel}: HeroSMS phone verification failed: ${getErrorMessage(heroErr)}`));
              return;
            }
          }

          try {
            await handleMicrosoftPhoneChallengeDuringStep4(current, {
              round: 1,
              maxRounds: 1,
              restartSignup: false,
            });
          } catch (fallbackErr) {
            await addLog(`${stepLabel}: add-phone fallback handling failed: ${getErrorMessage(fallbackErr)}`, 'warn');
          }
          resolved = true;
          cleanupAll();
          reject(new Error(`${stepLabel}: Detected add-phone challenge. Email has been marked and replaced. Please rerun from step 3.`));
          return;
        }

        await addLog(
          `${stepLabel}: Auto click was not completed (${message}). Please click consent manually; still waiting for localhost redirect...`,
          'warn'
        );
      }
    })();
  });
}

// ============================================================
// Step 8: Callback verify/import (CPA API / CPA panel / Sub2API)
// ============================================================

async function executeStep7(state, stepNumber = 7) {
  const importStep = Number(stepNumber || 7);

  if (isSub2apiOauthProvider(state)) {
    await executeStep7WithSub2api(state, importStep);
    return;
  }

  if (shouldUseCpaManagementApi(state)) {
    await executeStep7WithCpaApi(state, importStep);
    return;
  }

  if (!state.localhostUrl) {
    throw new Error(`No localhost URL. Complete step ${Math.max(1, importStep - 1)} first.`);
  }
  if (!state.vpsUrl) {
    throw new Error('CPA Auth URL not set. Please enter the CPA Auth URL in the side panel.');
  }

  await addLog(`Step ${importStep}: Opening CPA Auth panel...`);

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
  await addLog(`Step ${importStep}: Filling callback URL...`);
  await chrome.tabs.sendMessage(tabId, {
    type: 'EXECUTE_STEP',
    step: importStep,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl },
  });
}

async function executeStep7WithCpaApi(state, stepNumber = 7) {
  const importStep = Number(stepNumber || 7);

  if (!state.localhostUrl) {
    throw new Error(`No localhost URL. Complete step ${Math.max(1, importStep - 1)} first.`);
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
    await addLog(`Step ${importStep}: Callback state (${callback.state}) differs from stored CPA state (${oauthState}). Using callback state.`, 'warn');
    oauthState = callback.state;
  }

  await addLog(`Step ${importStep}: Forwarding OAuth callback to CPA Management API...`);
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
      await addLog(`Step ${importStep}: Callback already submitted (${message}). Continue polling status...`, 'warn');
    } else {
      throw err;
    }
  }

  await addLog(`Step ${importStep}: Confirming OAuth completion via CPA Management API...`);
  await waitForCpaAuthStatusReady(state, oauthState, {
    maxAttempts: 40,
    intervalMs: 2000,
  });

  await setState({ cpaAuthState: null });
  await addLog(`Step ${importStep}: CPA import/authentication completed.`, 'ok');

  await completeBackgroundStep(importStep, {
    cpaAuthState: oauthState,
  });
}

async function executeStep7WithSub2api(state, stepNumber = 7) {
  const importStep = Number(stepNumber || 7);

  if (!state.localhostUrl) {
    throw new Error(`No localhost URL. Complete step ${Math.max(1, importStep - 1)} first.`);
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

  await addLog(`Step ${importStep}: Importing account to Sub2API...`);
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

    await addLog(`Step ${importStep}: Sub2API auth failed, trying dashboard session token fallback...`, 'warn');
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
      await applySub2apiPostImportSettings(state, accountId, authCredential, importStep);
    } catch (err) {
      await addLog(`Step ${importStep}: Sub2API post-import settings update failed: ${getErrorMessage(err)}`, 'warn');
    }
  }

  if (accountId > 0) {
    await addLog(`Step ${importStep}: Sub2API account created #${accountId}${accountName ? ` (${accountName})` : ''}`, 'ok');
  } else {
    await addLog(`Step ${importStep}: Sub2API import completed${accountName ? ` (${accountName})` : ''}`, 'ok');
  }

  await completeBackgroundStep(importStep, {
    sub2apiAccountId: accountId || null,
    sub2apiAccountName: accountName || null,
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
