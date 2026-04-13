// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  skipped: '\u00BB',    // »
  failed: '\u2717',     // ✗
  stopped: '\u25A0',    // ■
};
const WORKFLOW_STEPS = [1, 2, 3, 4, 5, 6, 7];
const TOTAL_STEPS = WORKFLOW_STEPS.length;

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const appTitle = document.getElementById('app-title');
const btnVersion = document.getElementById('btn-version');
const displayVersion = document.getElementById('display-version');
const displayElapsed = document.getElementById('display-elapsed');
const displayAverageDuration = document.getElementById('display-average-duration');
const displaySuccessRate = document.getElementById('display-success-rate');
const checkboxDeleteBlockedAccount = document.getElementById('checkbox-delete-blocked-account');
const rowMailProvider = document.getElementById('row-mail-provider');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const btnFetchEmail = document.getElementById('btn-fetch-email');
const btnCopyEmail = document.getElementById('btn-copy-email');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const btnCopyPassword = document.getElementById('btn-copy-password');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const stepsProgress = document.getElementById('steps-progress');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const autoContinueBar = document.getElementById('auto-continue-bar');
const btnClearLog = document.getElementById('btn-clear-log');
const selectLanguage = document.getElementById('select-language');
const selectOauthProvider = document.getElementById('select-oauth-provider');
const rowCpaAuthUrl = document.getElementById('row-cpa-auth-url');
const inputVpsUrl = document.getElementById('input-vps-url');
const btnPasteVpsUrl = document.getElementById('btn-paste-vps-url');
const rowCpaAuthKey = document.getElementById('row-cpa-auth-key');
const inputCpaManagementKey = document.getElementById('input-cpa-management-key');
const rowSub2apiBaseUrl = document.getElementById('row-sub2api-base-url');
const inputSub2apiBaseUrl = document.getElementById('input-sub2api-base-url');
const rowSub2apiApiKey = document.getElementById('row-sub2api-api-key');
const inputSub2apiApiKey = document.getElementById('input-sub2api-api-key');
const selectMailProvider = document.getElementById('select-mail-provider');
const rowMicrosoftManagerUrl = document.getElementById('row-microsoft-manager-url');
const inputMicrosoftManagerUrl = document.getElementById('input-microsoft-manager-url');
const rowMicrosoftManagerToken = document.getElementById('row-microsoft-manager-token');
const inputMicrosoftManagerToken = document.getElementById('input-microsoft-manager-token');
const rowMicrosoftManagerMode = document.getElementById('row-microsoft-manager-mode');
const selectMicrosoftManagerMode = document.getElementById('select-microsoft-manager-mode');
const rowMicrosoftManagerKeyword = document.getElementById('row-microsoft-manager-keyword');
const inputMicrosoftManagerKeyword = document.getElementById('input-microsoft-manager-keyword');
const rowMicrosoftManagerAliasToggle = document.getElementById('row-microsoft-manager-alias-toggle');
const checkboxMicrosoftManagerUseAliases = document.getElementById('checkbox-microsoft-manager-use-aliases');
const inputRunCount = document.getElementById('input-run-count');
const autoHint = document.getElementById('auto-hint');
let currentLanguage = localStorage.getItem('multipage-language') || 'zh-CN';
let lastKnownState = null;
let runMetricsTicker = null;
let activeRunStartMs = 0;
let activeRunKey = '';
const completedRunDurationsMs = [];
const finishedRunKeys = new Set();
const successfulRunKeys = new Set();
const manifestInfo = chrome.runtime.getManifest();
const releaseRepo = 'Msg-Lbo/MSRegFlow';
const currentManifestVersion = normalizeVersionValue(manifestInfo.version || '0.0.0');
const currentManifestVersionLabel = formatVersionLabel(currentManifestVersion);
let latestReleaseVersion = '';
let latestReleaseUrl = `https://github.com/${releaseRepo}/releases`;
let hasNewRelease = false;
let isVersionCheckFinished = false;
let versionCheckInFlight = false;
let hasShownNewReleaseToast = false;

function normalizeMailProviderValue(rawValue) {
  void rawValue;
  return 'microsoft-manager';
}

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

const AUTO_BUTTON_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

const I18N = {
  'zh-CN': {
    titleRunCount: '运行次数',
    titleAutoRun: '自动执行全部步骤',
    titleFetchEmail: '自动获取 Microsoft 账号',
    titleFetchEmailMicrosoftManager: '自动获取 Microsoft 账号',
    titleStop: '停止当前流程',
    titleReset: '重置全部步骤',
    titleTheme: '切换主题',
    titleVersionBadge: '点击查看版本更新',
    titleSkipStep: '跳过这一步',
    titleClearLog: '清空日志',
    labelCpaAuth: 'CPA Auth',
    labelOauthTarget: 'OAuth',
    labelLanguage: '语言',
    labelBlockedAccountPolicy: '封号处理',
    labelVerify: '验证',
    labelMicrosoftManager: 'MS 管理',
    labelToken: '令牌',
    labelMode: '模式',
    labelKeyword: '筛选',
    labelAliasPool: '别名池',
    labelCpaManagementKey: 'CPA Key',
    labelSub2api: 'Sub2API',
    labelSub2apiApiKey: 'API Key',
    labelEmail: '邮箱',
    labelPassword: '密码',
    labelOauth: 'OAuth',
    labelCallback: '回调',
    labelElapsed: '计时',
    labelAverageDuration: '平均用时',
    labelSuccessRate: '成功率',
    microsoftManagerEmailName: 'Microsoft 账号',
    blockedAccountPolicy: '邮箱被封 (AADSTS70000) 时删除账号；未勾选则跳过并换号',
    microsoftManagerUseAliases: '勾选后自动取号使用“主邮箱+别名邮箱”；不勾选仅使用主邮箱',
    mailProviderMicrosoftManager: 'Microsoft Account Manager API',
    microsoftManagerModeGraph: 'Graph',
    microsoftManagerModeImap: 'IMAP',
    oauthProviderCpaAuth: 'CPA Auth',
    oauthProviderSub2api: 'Sub2API',
    placeholderCpaAuth: 'http://ip:port 或 /management.html#/oauth',
    placeholderCpaManagementKey: '填写明文 Management Key（不要填 $2... 加密串）',
    placeholderSub2apiBaseUrl: 'https://你的-sub2api域名',
    placeholderSub2apiApiKey: '可留空；或填写 x-api-key / Bearer token',
    placeholderMicrosoftManagerUrl: 'https://你的-manager域名',
    placeholderMicrosoftManagerToken: '填写 MAIL_API_TOKEN',
    placeholderMicrosoftManagerKeyword: '可选关键词，用于筛选账号',
    placeholderEmailMicrosoftManager: '使用 Auto 获取 Microsoft 账号，或手动粘贴',
    placeholderPassword: '留空则自动生成',
    waiting: '等待中...',
    btnAuto: '自动',
    btnStop: '停止',
    btnContinue: '继续',
    btnCopy: '复制',
    btnPaste: '粘贴',
    btnClear: '清空',
    btnSkip: '跳过',
    btnShow: '显示',
    btnHide: '隐藏',
    sectionWorkflow: '流程',
    sectionConsole: '控制台',
    step1: '获取 OAuth 链接',
    step2: '打开注册页',
    step3: '填写邮箱 / 密码',
    step4: '获取注册验证码',
    step5: '填写姓名 / 生日',
    step6: 'OAuth 自动确认',
    step7: '回调验证 / 导入',
    statusRunning: ({ step }) => `第 ${step} 步执行中...`,
    statusFailed: ({ step }) => `第 ${step} 步失败`,
    statusStopped: ({ step }) => `第 ${step} 步已停止`,
    statusAllFinished: '全部步骤已完成',
    statusSkipped: ({ step }) => `第 ${step} 步已跳过`,
    statusDone: ({ step }) => `第 ${step} 步完成`,
    statusReady: '就绪',
    autoHintEmailMicrosoftManager: '使用 Auto 获取 Microsoft 账号邮箱，或手动粘贴后继续',
    autoHintError: '自动运行被错误中断。修复问题或跳过失败步骤后继续',
    fetchedEmail: ({ email }) => `已获取 ${email}`,
    autoFetchFailed: ({ message }) => `自动获取失败：${message}`,
    pleaseEnterEmailFirst: '请先粘贴邮箱地址或点击 Auto',
    skipFailed: ({ message }) => `跳过失败：${message}`,
    stepSkippedToast: ({ step }) => `第 ${step} 步已跳过`,
    stoppingFlow: '正在停止当前流程...',
    continueNeedEmail: '请先获取或粘贴邮箱地址',
    continueFailed: ({ message }) => `继续失败：${message}`,
    confirmReset: '要重置全部步骤和数据吗？',
    copiedValue: ({ label }) => `已复制${label}`,
    copiedValueFallback: ({ label }) => `已复制 ${label}`,
    copyFailed: ({ label, message }) => `${label}复制失败：${message}`,
    nothingToCopy: ({ label }) => `${label}为空，无法复制`,
    pastedCpaAuth: '已从剪贴板粘贴 CPA Auth 地址',
    pasteFailed: ({ message }) => `粘贴失败：${message}`,
    clipboardEmpty: '剪贴板为空',
    clipboardNoUsefulText: '剪贴板中没有可用内容',
    autoRunRunning: ({ runLabel }) => `运行中${runLabel}`,
    autoRunPaused: ({ runLabel }) => `已暂停${runLabel}`,
    autoRunInterrupted: ({ runLabel }) => `已中断${runLabel}`,
    versionChecking: '版本检查中...',
    versionTooltipLatest: ({ version }) => `当前已是最新版本 ${version}`,
    versionTooltipUpdateAvailable: ({ current, latest }) => `发现新版本 ${latest}（当前 ${current}），点击查看`,
    versionTooltipCheckFailed: '版本检查失败，点击查看 Releases',
    newVersionFound: ({ latest }) => `发现新版本 ${latest}，点击标题旁版本号查看`,
  },
  'en-US': {
    titleRunCount: 'Number of runs',
    titleAutoRun: 'Run all steps automatically',
    titleFetchEmail: 'Fetch a Microsoft account automatically',
    titleFetchEmailMicrosoftManager: 'Fetch a Microsoft account automatically',
    titleStop: 'Stop current flow',
    titleReset: 'Reset all steps',
    titleTheme: 'Toggle theme',
    titleVersionBadge: 'Click to view version updates',
    titleSkipStep: 'Skip this step',
    titleClearLog: 'Clear log',
    labelCpaAuth: 'CPA Auth',
    labelOauthTarget: 'OAuth',
    labelLanguage: 'Language',
    labelBlockedAccountPolicy: 'Blocked Handling',
    labelVerify: 'Verify',
    labelMicrosoftManager: 'MSMgr',
    labelToken: 'Token',
    labelMode: 'Mode',
    labelKeyword: 'Filter',
    labelAliasPool: 'Alias Pool',
    labelCpaManagementKey: 'CPA Key',
    labelSub2api: 'Sub2API',
    labelSub2apiApiKey: 'API Key',
    labelEmail: 'Email',
    labelPassword: 'Password',
    labelOauth: 'OAuth',
    labelCallback: 'Callback',
    labelElapsed: 'Elapsed',
    labelAverageDuration: 'Avg Time',
    labelSuccessRate: 'Success Rate',
    microsoftManagerEmailName: 'Microsoft account',
    blockedAccountPolicy: 'On AADSTS70000: checked=delete account, unchecked=skip and switch to next',
    microsoftManagerUseAliases: 'Use primary + alias addresses when fetching emails automatically; if unchecked, only primary addresses are used',
    mailProviderMicrosoftManager: 'Microsoft Account Manager API',
    microsoftManagerModeGraph: 'Graph',
    microsoftManagerModeImap: 'IMAP',
    oauthProviderCpaAuth: 'CPA Auth',
    oauthProviderSub2api: 'Sub2API',
    placeholderCpaAuth: 'http://ip:port or /management.html#/oauth',
    placeholderCpaManagementKey: 'Plaintext management key (not $2... hash)',
    placeholderSub2apiBaseUrl: 'https://your-sub2api-host',
    placeholderSub2apiApiKey: 'Optional; use x-api-key or Bearer token',
    placeholderMicrosoftManagerUrl: 'https://your-manager-domain',
    placeholderMicrosoftManagerToken: 'Use MAIL_API_TOKEN',
    placeholderMicrosoftManagerKeyword: 'Optional keyword for account filter',
    placeholderEmailMicrosoftManager: 'Use Auto to fetch a Microsoft account, or paste manually',
    placeholderPassword: 'Leave blank to auto-generate',
    waiting: 'Waiting...',
    btnAuto: 'Auto',
    btnStop: 'Stop',
    btnContinue: 'Continue',
    btnCopy: 'Copy',
    btnPaste: 'Paste',
    btnClear: 'Clear',
    btnSkip: 'Skip',
    btnShow: 'Show',
    btnHide: 'Hide',
    sectionWorkflow: 'Workflow',
    sectionConsole: 'Console',
    step1: 'Get OAuth Link',
    step2: 'Open Signup',
    step3: 'Fill Email / Password',
    step4: 'Get Signup Code',
    step5: 'Fill Name / Birthday',
    step6: 'OAuth Auto Confirm',
    step7: 'Callback Verify / Import',
    statusRunning: ({ step }) => `Step ${step} running...`,
    statusFailed: ({ step }) => `Step ${step} failed`,
    statusStopped: ({ step }) => `Step ${step} stopped`,
    statusAllFinished: 'All steps finished',
    statusSkipped: ({ step }) => `Step ${step} skipped`,
    statusDone: ({ step }) => `Step ${step} done`,
    statusReady: 'Ready',
    autoHintEmailMicrosoftManager: 'Use Auto to fetch a Microsoft account email, or paste manually, then continue',
    autoHintError: 'Auto run was interrupted by an error. Fix it or skip the failed step, then continue',
    fetchedEmail: ({ email }) => `Fetched ${email}`,
    autoFetchFailed: ({ message }) => `Auto fetch failed: ${message}`,
    pleaseEnterEmailFirst: 'Please paste email address or use Auto first',
    skipFailed: ({ message }) => `Skip failed: ${message}`,
    stepSkippedToast: ({ step }) => `Step ${step} skipped`,
    stoppingFlow: 'Stopping current flow...',
    continueNeedEmail: 'Please fetch or paste an email address first!',
    continueFailed: ({ message }) => `Continue failed: ${message}`,
    confirmReset: 'Reset all steps and data?',
    copiedValue: ({ label }) => `Copied ${label}`,
    copiedValueFallback: ({ label }) => `${label} copied`,
    copyFailed: ({ label, message }) => `Failed to copy ${label}: ${message}`,
    nothingToCopy: ({ label }) => `${label} is empty`,
    pastedCpaAuth: 'Pasted CPA Auth URL from clipboard',
    pasteFailed: ({ message }) => `Paste failed: ${message}`,
    clipboardEmpty: 'Clipboard is empty',
    clipboardNoUsefulText: 'Clipboard does not contain usable text',
    autoRunRunning: ({ runLabel }) => `Running${runLabel}`,
    autoRunPaused: ({ runLabel }) => `Paused${runLabel}`,
    autoRunInterrupted: ({ runLabel }) => `Interrupted${runLabel}`,
    versionChecking: 'Checking version...',
    versionTooltipLatest: ({ version }) => `You are on the latest version ${version}`,
    versionTooltipUpdateAvailable: ({ current, latest }) => `New version ${latest} available (current ${current}), click to view`,
    versionTooltipCheckFailed: 'Version check failed, click to view releases',
    newVersionFound: ({ latest }) => `New version ${latest} found. Click the header version badge to view`,
  },
};

function t(key, vars = {}) {
  const pack = I18N[currentLanguage] || I18N['zh-CN'];
  const fallbackPack = I18N['zh-CN'];
  const value = pack[key] ?? fallbackPack[key] ?? key;
  if (typeof value === 'function') return value(vars);
  return String(value).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

function setAutoRunButton(label) {
  btnAutoRun.innerHTML = `${AUTO_BUTTON_ICON} ${label}`;
}

function normalizeVersionValue(rawValue) {
  return String(rawValue || '')
    .trim()
    .replace(/^refs\/tags\//i, '')
    .replace(/^v/i, '');
}

function formatVersionLabel(versionValue) {
  const normalized = normalizeVersionValue(versionValue);
  return normalized ? `v${normalized}` : 'v0.0.0';
}

function parseVersionParts(versionValue) {
  const normalized = normalizeVersionValue(versionValue);
  if (!normalized) return [];

  return normalized
    .split('.')
    .map(part => {
      const matched = String(part || '').match(/\d+/);
      return matched ? Number(matched[0]) : 0;
    });
}

function compareVersionValues(leftVersion, rightVersion) {
  const left = parseVersionParts(leftVersion);
  const right = parseVersionParts(rightVersion);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index++) {
    const leftPart = Number(left[index] || 0);
    const rightPart = Number(right[index] || 0);
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }

  return 0;
}

function getVersionBadgeTitle() {
  if (!isVersionCheckFinished) {
    return t('versionChecking');
  }

  if (hasNewRelease) {
    return t('versionTooltipUpdateAvailable', {
      current: currentManifestVersionLabel,
      latest: formatVersionLabel(latestReleaseVersion),
    });
  }

  if (latestReleaseVersion) {
    return t('versionTooltipLatest', {
      version: formatVersionLabel(latestReleaseVersion),
    });
  }

  return t('versionTooltipCheckFailed');
}

function renderVersionBadge() {
  if (appTitle) {
    appTitle.textContent = String(manifestInfo.name || 'MSRegFlow');
  }

  if (displayVersion) {
    displayVersion.textContent = currentManifestVersionLabel;
  }

  if (!btnVersion) return;

  btnVersion.classList.toggle('has-update', hasNewRelease);
  const title = getVersionBadgeTitle();
  btnVersion.title = title;
  btnVersion.setAttribute('aria-label', title);
}

async function checkLatestReleaseVersion() {
  if (versionCheckInFlight) return;

  versionCheckInFlight = true;
  isVersionCheckFinished = false;
  renderVersionBadge();

  try {
    const response = await fetch(`https://api.github.com/repos/${releaseRepo}/releases/latest`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const latestTag = normalizeVersionValue(payload?.tag_name || '');
    const latestUrl = String(payload?.html_url || '').trim();

    latestReleaseVersion = latestTag;
    if (latestUrl) {
      latestReleaseUrl = latestUrl;
    }

    hasNewRelease = latestTag
      ? compareVersionValues(latestTag, currentManifestVersion) > 0
      : false;

    isVersionCheckFinished = true;
    renderVersionBadge();

    if (hasNewRelease && !hasShownNewReleaseToast) {
      hasShownNewReleaseToast = true;
      showToast(t('newVersionFound', { latest: formatVersionLabel(latestTag) }), 'warn', 4200);
    }
  } catch (err) {
    latestReleaseVersion = '';
    hasNewRelease = false;
    isVersionCheckFinished = true;
    renderVersionBadge();
    console.warn('Version check failed:', err);
  } finally {
    versionCheckInFlight = false;
  }
}

function getVersionOpenUrl() {
  const currentReleaseUrl = `https://github.com/${releaseRepo}/releases/tag/${currentManifestVersion}`;
  if (hasNewRelease && latestReleaseUrl) {
    return latestReleaseUrl;
  }
  if (latestReleaseVersion) {
    return currentReleaseUrl;
  }
  return latestReleaseUrl || currentReleaseUrl;
}

async function openVersionPage() {
  const url = getVersionOpenUrl();
  try {
    await chrome.tabs.create({ url, active: true });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function calculateAverageRunDurationMs() {
  if (!completedRunDurationsMs.length) return 0;
  const total = completedRunDurationsMs.reduce((sum, duration) => sum + duration, 0);
  return Math.round(total / completedRunDurationsMs.length);
}

function renderRunMetrics() {
  if (displayElapsed) {
    displayElapsed.textContent = activeRunStartMs
      ? formatDuration(Date.now() - activeRunStartMs)
      : '--:--';
  }

  if (displayAverageDuration) {
    const averageMs = calculateAverageRunDurationMs();
    displayAverageDuration.textContent = averageMs > 0 ? formatDuration(averageMs) : '--:--';
  }

  if (displaySuccessRate) {
    const attempts = finishedRunKeys.size;
    const successes = successfulRunKeys.size;
    displaySuccessRate.textContent = attempts > 0
      ? `${((successes / attempts) * 100).toFixed(1)}%`
      : '--';
  }
}

function startRunMetricsTicker() {
  if (runMetricsTicker !== null) return;
  runMetricsTicker = setInterval(() => {
    renderRunMetrics();
  }, 1000);
}

function stopRunMetricsTickerIfIdle() {
  if (activeRunStartMs) return;
  if (runMetricsTicker === null) return;
  clearInterval(runMetricsTicker);
  runMetricsTicker = null;
}

function beginRunMetrics(flowStartTimeMs) {
  const normalizedStartMs = Number(flowStartTimeMs || 0);
  if (!Number.isFinite(normalizedStartMs) || normalizedStartMs <= 0) {
    return;
  }

  const newRunKey = String(Math.trunc(normalizedStartMs));

  if (activeRunStartMs && activeRunKey && activeRunKey !== newRunKey) {
    finishActiveRunMetrics(false, Number(activeRunKey));
  }

  activeRunStartMs = normalizedStartMs;
  activeRunKey = newRunKey;
  startRunMetricsTicker();
  renderRunMetrics();
}

function finishActiveRunMetrics(success, flowStartTimeMs = 0) {
  if (!activeRunStartMs) return;

  const durationMs = Math.max(0, Date.now() - activeRunStartMs);
  const resolvedKey = String(Math.trunc(Number(flowStartTimeMs || activeRunKey || activeRunStartMs) || 0));

  if (resolvedKey && !finishedRunKeys.has(resolvedKey)) {
    finishedRunKeys.add(resolvedKey);
    if (success) {
      successfulRunKeys.add(resolvedKey);
      completedRunDurationsMs.push(durationMs);
    }
  }

  activeRunStartMs = 0;
  activeRunKey = '';
  stopRunMetricsTickerIfIdle();
  renderRunMetrics();
}

function syncRunMetricsFromState(state) {
  if (!state || !state.stepStatuses) return;

  const flowStartTimeMs = Number(state.flowStartTime || 0);
  const stepStatuses = Object.values(state.stepStatuses || {});
  const hasRunning = stepStatuses.includes('running');
  const hasFailedOrStopped = stepStatuses.some(status => status === 'failed' || status === 'stopped');
  const allProgressed = stepStatuses.length > 0
    && stepStatuses.every(status => status === 'completed' || status === 'skipped');

  if (flowStartTimeMs > 0) {
    beginRunMetrics(flowStartTimeMs);
  } else if (!hasRunning && activeRunStartMs) {
    finishActiveRunMetrics(false, 0);
  }

  if (!activeRunStartMs) {
    renderRunMetrics();
    return;
  }

  if (allProgressed) {
    finishActiveRunMetrics(true, flowStartTimeMs);
    return;
  }

  if (hasFailedOrStopped && !hasRunning) {
    finishActiveRunMetrics(false, flowStartTimeMs);
    return;
  }

  renderRunMetrics();
}

function resetRunMetrics() {
  activeRunStartMs = 0;
  activeRunKey = '';
  completedRunDurationsMs.length = 0;
  finishedRunKeys.clear();
  successfulRunKeys.clear();
  stopRunMetricsTickerIfIdle();
  renderRunMetrics();
}

function getCopyLabel(kind) {
  if (currentLanguage === 'zh-CN') {
    if (kind === 'email') return '邮箱';
    if (kind === 'password') return '密码';
    return '内容';
  }
  if (kind === 'email') return 'email';
  if (kind === 'password') return 'password';
  return 'value';
}

function getEmailSourceLabel() {
  return t('microsoftManagerEmailName');
}

function getFetchEmailTitle() {
  return t('titleFetchEmailMicrosoftManager');
}

function getEmailPlaceholderText() {
  return t('placeholderEmailMicrosoftManager');
}

function getAutoHintText() {
  return t('autoHintEmailMicrosoftManager');
}

function isSub2apiOauthProviderSelected() {
  return selectOauthProvider.value === 'sub2api';
}

function updateOauthProviderUI() {
  const useSub2api = isSub2apiOauthProviderSelected();
  rowCpaAuthUrl.style.display = useSub2api ? 'none' : '';
  rowCpaAuthKey.style.display = useSub2api ? 'none' : '';
  rowSub2apiBaseUrl.style.display = useSub2api ? '' : 'none';
  rowSub2apiApiKey.style.display = useSub2api ? '' : 'none';
}

function applyLanguage(language) {
  currentLanguage = I18N[language] ? language : 'zh-CN';
  localStorage.setItem('multipage-language', currentLanguage);
  document.documentElement.lang = currentLanguage;
  if (selectLanguage) {
    selectLanguage.value = currentLanguage;
  }

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    node.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    const key = node.dataset.i18nPlaceholder;
    node.placeholder = t(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    const key = node.dataset.i18nTitle;
    node.title = t(key);
  });

  inputPassword.placeholder = t('placeholderPassword');
  if (!displayOauthUrl.classList.contains('has-value')) {
    displayOauthUrl.textContent = t('waiting');
  }
  if (!displayLocalhostUrl.classList.contains('has-value')) {
    displayLocalhostUrl.textContent = t('waiting');
  }
  updateOauthProviderUI();
  updateMailProviderUI();
  updateEmailSourceUI();
  syncPasswordToggleLabel();
  updateProgressCounter();
  renderVersionBadge();
  if (lastKnownState) {
    updateStatusDisplay(lastKnownState);
  } else {
    displayStatus.textContent = t('statusReady');
  }
  renderRunMetrics();
}

async function saveVpsUrlValue(value) {
  const vpsUrl = String(value || '').trim();
  inputVpsUrl.value = vpsUrl;
  if (!vpsUrl) return;
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { vpsUrl },
  });
}

async function copyTextValue(value, kind) {
  const trimmed = String(value || '').trim();
  const label = getCopyLabel(kind);
  if (!trimmed) {
    showToast(t('nothingToCopy', { label }), 'warn');
    return;
  }

  try {
    await navigator.clipboard.writeText(trimmed);
    showToast(t('copiedValue', { label }), 'success', 2000);
  } catch (err) {
    showToast(t('copyFailed', { label, message: err.message || err }), 'error');
  }
}

async function pasteCpaAuthFromClipboard(options = {}) {
  const { silentIfFilled = false } = options;
  if (silentIfFilled && inputVpsUrl.value.trim()) return;

  try {
    const text = String(await navigator.clipboard.readText() || '').trim();
    if (!text) {
      showToast(t('clipboardEmpty'), 'warn');
      return;
    }
    await saveVpsUrlValue(text);
    showToast(t('pastedCpaAuth'), 'success', 2000);
  } catch (err) {
    showToast(t('pasteFailed', { message: err.message || err }), 'warn');
  }
}

function showToast(message, type = 'error', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove());
}

// ============================================================
// State Restore on load
// ============================================================

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
    lastKnownState = state;
    applyLanguage(state.language || currentLanguage);

    if (state.oauthUrl) {
      displayOauthUrl.textContent = state.oauthUrl;
      displayOauthUrl.classList.add('has-value');
    }
    if (state.localhostUrl) {
      displayLocalhostUrl.textContent = state.localhostUrl;
      displayLocalhostUrl.classList.add('has-value');
    }
    if (state.email) {
      inputEmail.value = state.email;
    }
    syncPasswordField(state);
    if (state.vpsUrl) {
      inputVpsUrl.value = state.vpsUrl;
    }
    if (state.cpaManagementKey) {
      inputCpaManagementKey.value = state.cpaManagementKey;
    }
    if (state.oauthProvider) {
      selectOauthProvider.value = state.oauthProvider;
    }
    if (state.sub2apiBaseUrl) {
      inputSub2apiBaseUrl.value = state.sub2apiBaseUrl;
    }
    if (state.sub2apiAdminApiKey) {
      inputSub2apiApiKey.value = state.sub2apiAdminApiKey;
    }
    checkboxDeleteBlockedAccount.checked = Boolean(state.deleteAbusedMicrosoftAccount);
    if (state.language) {
      selectLanguage.value = state.language;
    }
    if (state.mailProvider) {
      selectMailProvider.value = normalizeMailProviderValue(state.mailProvider);
    } else {
      selectMailProvider.value = 'microsoft-manager';
    }
    if (state.microsoftManagerUrl) {
      inputMicrosoftManagerUrl.value = state.microsoftManagerUrl;
    }
    if (state.microsoftManagerToken) {
      inputMicrosoftManagerToken.value = state.microsoftManagerToken;
    }
    if (state.microsoftManagerMode) {
      selectMicrosoftManagerMode.value = state.microsoftManagerMode;
    }
    if (state.microsoftManagerKeyword) {
      inputMicrosoftManagerKeyword.value = state.microsoftManagerKeyword;
    }
    checkboxMicrosoftManagerUseAliases.checked = Boolean(state.microsoftManagerUseAliases);

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logs) {
      for (const entry of state.logs) {
        appendLog(entry);
      }
    }

    updateStatusDisplay(state);
    updateProgressCounter();
    updateOauthProviderUI();
    updateMailProviderUI();
    updateEmailSourceUI();

    if (state.autoRunPausedPhase === 'waiting_email') {
      autoContinueBar.dataset.reason = 'waiting_email';
      autoHint.textContent = getAutoHintText();
      autoContinueBar.style.display = 'flex';
      btnAutoRun.disabled = false;
      inputRunCount.disabled = false;
    } else if (state.autoRunPausedPhase === 'error') {
      autoContinueBar.dataset.reason = 'error';
      autoHint.textContent = t('autoHintError');
      autoContinueBar.style.display = 'flex';
      btnAutoRun.disabled = false;
      inputRunCount.disabled = false;
    }
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

function syncPasswordField(state) {
  inputPassword.value = state.customPassword || state.password || '';
}

function updateMailProviderUI() {
  selectMailProvider.value = normalizeMailProviderValue(selectMailProvider.value);
  const useMicrosoftManager = true;
  rowMailProvider.style.display = '';
  selectMailProvider.disabled = selectMailProvider.options.length <= 1;
  rowMicrosoftManagerUrl.style.display = useMicrosoftManager ? '' : 'none';
  rowMicrosoftManagerToken.style.display = useMicrosoftManager ? '' : 'none';
  rowMicrosoftManagerMode.style.display = useMicrosoftManager ? '' : 'none';
  rowMicrosoftManagerKeyword.style.display = useMicrosoftManager ? '' : 'none';
  rowMicrosoftManagerAliasToggle.style.display = useMicrosoftManager ? '' : 'none';
}

function updateEmailSourceUI() {
  inputEmail.placeholder = getEmailPlaceholderText();
  autoHint.textContent = getAutoHintText();
  btnFetchEmail.disabled = false;
  btnFetchEmail.title = getFetchEmailTitle();
}

async function syncRuntimeSettingsBeforeExecution() {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: {
      oauthProvider: selectOauthProvider.value,
      vpsUrl: inputVpsUrl.value.trim(),
      cpaManagementKey: inputCpaManagementKey.value.trim(),
      sub2apiBaseUrl: inputSub2apiBaseUrl.value.trim(),
      sub2apiAdminApiKey: inputSub2apiApiKey.value.trim(),
      deleteAbusedMicrosoftAccount: checkboxDeleteBlockedAccount.checked,
      customPassword: inputPassword.value,
      mailProvider: normalizeMailProviderValue(selectMailProvider.value),
      microsoftManagerUrl: inputMicrosoftManagerUrl.value.trim(),
      microsoftManagerToken: inputMicrosoftManagerToken.value.trim(),
      microsoftManagerMode: selectMicrosoftManagerMode.value,
      microsoftManagerKeyword: inputMicrosoftManagerKeyword.value.trim(),
      microsoftManagerUseAliases: checkboxMicrosoftManagerUseAliases.checked,
    },
  });
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }

  updateButtonStates();
  updateProgressCounter();
}

function getVisibleStepEntries(stepStatuses = {}) {
  return WORKFLOW_STEPS.map((step) => [step, stepStatuses?.[step] || 'pending']);
}

function updateProgressCounter() {
  let completed = 0;
  document.querySelectorAll('.step-row').forEach(row => {
    if (row.classList.contains('completed') || row.classList.contains('skipped')) completed++;
  });
  stepsProgress.textContent = `${completed} / ${TOTAL_STEPS}`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('skipped')) statuses[step] = 'skipped';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else if (row.classList.contains('stopped')) statuses[step] = 'stopped';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');

  for (const step of WORKFLOW_STEPS) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    const skipBtn = document.querySelector(`.step-skip-btn[data-step="${step}"]`);
    if (!btn) continue;

    const currentStatus = statuses[step];
    const prevStep = step > 1 ? step - 1 : null;

    if (anyRunning) {
      btn.disabled = true;
      if (skipBtn) skipBtn.disabled = true;
    } else if (prevStep === null) {
      btn.disabled = false;
    } else {
      const prevStatus = statuses[prevStep];
      btn.disabled = !(
        prevStatus === 'completed'
        || prevStatus === 'skipped'
        || currentStatus === 'failed'
        || currentStatus === 'completed'
        || currentStatus === 'stopped'
        || currentStatus === 'skipped'
      );
    }

    if (skipBtn) {
      skipBtn.disabled = !(currentStatus === 'failed' || currentStatus === 'stopped');
    }
  }

  updateStopButtonState(anyRunning || autoContinueBar.style.display !== 'none');
}

function updateStopButtonState(active) {
  btnStop.disabled = !active;
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;
  lastKnownState = state;
  syncRunMetricsFromState(state);
  const visibleEntries = getVisibleStepEntries(state.stepStatuses);

  statusBar.className = 'status-bar';

  const running = visibleEntries.find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = t('statusRunning', { step: running[0] });
    statusBar.classList.add('running');
    return;
  }

  const failed = visibleEntries.find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = t('statusFailed', { step: failed[0] });
    statusBar.classList.add('failed');
    return;
  }

  const stopped = visibleEntries.find(([, s]) => s === 'stopped');
  if (stopped) {
    displayStatus.textContent = t('statusStopped', { step: stopped[0] });
    statusBar.classList.add('stopped');
    return;
  }

  const allProgressed = visibleEntries.every(([, s]) => s === 'completed' || s === 'skipped');
  if (allProgressed) {
    displayStatus.textContent = t('statusAllFinished');
    statusBar.classList.add('completed');
    return;
  }

  const lastProgressed = visibleEntries
    .filter(([, s]) => s === 'completed' || s === 'skipped')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastProgressed) {
    displayStatus.textContent = state.stepStatuses[lastProgressed] === 'skipped'
      ? t('statusSkipped', { step: lastProgressed })
      : t('statusDone', { step: lastProgressed });
  } else {
    displayStatus.textContent = t('statusReady');
  }
}

function appendLog(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const levelLabel = entry.level.toUpperCase();
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;
  const displayMessage = String(entry.message || '');

  const stepMatch = entry.message.match(/Step (\d+)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(displayMessage)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function fetchConfiguredEmail() {
  const defaultLabel = t('btnAuto');
  btnFetchEmail.disabled = true;
  btnFetchEmail.textContent = '...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_AUTO_EMAIL',
      source: 'sidepanel',
      payload: { generateNew: true },
    });

    if (response?.error) {
      throw new Error(response.error);
    }
    if (!response?.email) {
      throw new Error('Email was not returned.');
    }

    inputEmail.value = response.email;
    showToast(t('fetchedEmail', { email: response.email }), 'success', 2500);
    return response.email;
  } catch (err) {
    showToast(t('autoFetchFailed', { message: err.message }), 'error');
    throw err;
  } finally {
    btnFetchEmail.disabled = false;
    btnFetchEmail.textContent = defaultLabel;
  }
}

function syncPasswordToggleLabel() {
  btnTogglePassword.textContent = inputPassword.type === 'password' ? t('btnShow') : t('btnHide');
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    await syncRuntimeSettingsBeforeExecution();
    if (step === 3) {
      const email = inputEmail.value.trim();
      if (!email) {
        showToast(t('pleaseEnterEmailFirst'), 'warn');
        return;
      }
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step, email } });
    } else {
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
    }
  });
});

document.querySelectorAll('.step-skip-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    const response = await chrome.runtime.sendMessage({
      type: 'SKIP_STEP',
      source: 'sidepanel',
      payload: { step },
    });
    if (response?.error) {
      showToast(t('skipFailed', { message: response.error }), 'error');
      return;
    }
    showToast(t('stepSkippedToast', { step }), 'warn', 2000);
  });
});

btnFetchEmail.addEventListener('click', async () => {
  await fetchConfiguredEmail().catch(() => {});
});

btnCopyEmail.addEventListener('click', async () => {
  await copyTextValue(inputEmail.value, 'email');
});

btnCopyPassword.addEventListener('click', async () => {
  await copyTextValue(inputPassword.value, 'password');
});

btnPasteVpsUrl.addEventListener('click', async () => {
  await pasteCpaAuthFromClipboard();
});

btnTogglePassword.addEventListener('click', () => {
  inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
  syncPasswordToggleLabel();
});

btnVersion.addEventListener('click', async () => {
  if (!isVersionCheckFinished && !versionCheckInFlight) {
    await checkLatestReleaseVersion();
  }
  await openVersionPage();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_FLOW', source: 'sidepanel', payload: {} });
  showToast(t('stoppingFlow'), 'warn', 2000);
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  const totalRuns = parseInt(inputRunCount.value) || 1;
  resetRunMetrics();
  btnAutoRun.disabled = true;
  inputRunCount.disabled = true;
  setAutoRunButton(t('autoRunRunning', { runLabel: '' }));
  await syncRuntimeSettingsBeforeExecution();
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
});

btnAutoContinue.addEventListener('click', async () => {
  const reason = autoContinueBar.dataset.reason || 'waiting_email';
  const email = inputEmail.value.trim();
  if (reason === 'waiting_email' && !email) {
    showToast(t('continueNeedEmail'), 'warn');
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'CONTINUE_AUTO_RUN',
    source: 'sidepanel',
    payload: { email },
  });
  if (response?.error) {
    showToast(t('continueFailed', { message: response.error }), 'error');
    return;
  }
  autoContinueBar.style.display = 'none';
  autoContinueBar.dataset.reason = '';
});

// Reset
btnReset.addEventListener('click', async () => {
  if (confirm(t('confirmReset'))) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    displayOauthUrl.textContent = t('waiting');
    displayOauthUrl.classList.remove('has-value');
    displayLocalhostUrl.textContent = t('waiting');
    displayLocalhostUrl.classList.remove('has-value');
    inputEmail.value = '';
    displayStatus.textContent = t('statusReady');
    statusBar.className = 'status-bar';
    logArea.innerHTML = '';
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    inputRunCount.disabled = false;
    setAutoRunButton(t('btnAuto'));
    autoContinueBar.style.display = 'none';
    updateStopButtonState(false);
    updateButtonStates();
    updateProgressCounter();
    resetRunMetrics();
  }
});

// Clear log
btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

// Save settings on change
inputEmail.addEventListener('change', async () => {
  const email = inputEmail.value.trim();
  if (email) {
    await chrome.runtime.sendMessage({ type: 'SAVE_EMAIL', source: 'sidepanel', payload: { email } });
  }
});

inputVpsUrl.addEventListener('change', async () => {
  const vpsUrl = inputVpsUrl.value.trim();
  if (vpsUrl) {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTING', source: 'sidepanel', payload: { vpsUrl } });
  }
});

inputVpsUrl.addEventListener('click', async () => {
  await pasteCpaAuthFromClipboard({ silentIfFilled: true });
});

inputCpaManagementKey.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { cpaManagementKey: inputCpaManagementKey.value.trim() },
  });
});

selectOauthProvider.addEventListener('change', async () => {
  updateOauthProviderUI();
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { oauthProvider: selectOauthProvider.value },
  });
});

inputSub2apiBaseUrl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { sub2apiBaseUrl: inputSub2apiBaseUrl.value.trim() },
  });
});

inputSub2apiApiKey.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { sub2apiAdminApiKey: inputSub2apiApiKey.value.trim() },
  });
});

inputPassword.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { customPassword: inputPassword.value },
  });
});

checkboxDeleteBlockedAccount.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { deleteAbusedMicrosoftAccount: checkboxDeleteBlockedAccount.checked },
  });
});

selectMailProvider.addEventListener('change', async () => {
  selectMailProvider.value = normalizeMailProviderValue(selectMailProvider.value);
  updateMailProviderUI();
  updateEmailSourceUI();
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING', source: 'sidepanel',
    payload: { mailProvider: normalizeMailProviderValue(selectMailProvider.value) },
  });
});

selectLanguage.addEventListener('change', async () => {
  applyLanguage(selectLanguage.value || 'zh-CN');
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { language: currentLanguage },
  });
});

inputMicrosoftManagerUrl.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { microsoftManagerUrl: inputMicrosoftManagerUrl.value.trim() },
  });
});

inputMicrosoftManagerToken.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { microsoftManagerToken: inputMicrosoftManagerToken.value.trim() },
  });
});

selectMicrosoftManagerMode.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { microsoftManagerMode: selectMicrosoftManagerMode.value },
  });
});

inputMicrosoftManagerKeyword.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { microsoftManagerKeyword: inputMicrosoftManagerKeyword.value.trim() },
  });
});

checkboxMicrosoftManagerUseAliases.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { microsoftManagerUseAliases: checkboxMicrosoftManagerUseAliases.checked },
  });
});

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      if (message.payload.level === 'error') {
        showToast(String(message.payload.message || ''), 'error');
      }
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay);
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          syncPasswordField(state);
          if (state.oauthUrl) {
            displayOauthUrl.textContent = state.oauthUrl;
            displayOauthUrl.classList.add('has-value');
          }
          if (state.localhostUrl) {
            displayLocalhostUrl.textContent = state.localhostUrl;
            displayLocalhostUrl.classList.add('has-value');
          }
        });
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      // Full UI reset for next run
      displayOauthUrl.textContent = t('waiting');
      displayOauthUrl.classList.remove('has-value');
      displayLocalhostUrl.textContent = t('waiting');
      displayLocalhostUrl.classList.remove('has-value');
      inputEmail.value = '';
      displayStatus.textContent = t('statusReady');
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      updateStopButtonState(false);
      updateProgressCounter();
      renderRunMetrics();
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.email) {
        inputEmail.value = message.payload.email;
      }
      if (message.payload.password !== undefined) {
        inputPassword.value = message.payload.password || '';
      }
      if (message.payload.oauthUrl) {
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
      }
      if (message.payload.localhostUrl) {
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
      }
      if (message.payload.flowStartTime) {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' })
          .then(updateStatusDisplay)
          .catch(() => {});
      }
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns } = message.payload;
      const runLabel = totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      switch (phase) {
        case 'waiting_email':
          autoContinueBar.dataset.reason = 'waiting_email';
          autoHint.textContent = getAutoHintText();
          autoContinueBar.style.display = 'flex';
          setAutoRunButton(t('autoRunPaused', { runLabel }));
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          updateStopButtonState(true);
          break;
        case 'error':
          autoContinueBar.dataset.reason = 'error';
          autoHint.textContent = t('autoHintError');
          autoContinueBar.style.display = 'flex';
          setAutoRunButton(t('autoRunInterrupted', { runLabel }));
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          updateStopButtonState(false);
          finishActiveRunMetrics(false, Number(lastKnownState?.flowStartTime || 0));
          break;
        case 'running':
          autoContinueBar.dataset.reason = '';
          autoContinueBar.style.display = 'none';
          setAutoRunButton(t('autoRunRunning', { runLabel }));
          btnAutoRun.disabled = true;
          inputRunCount.disabled = true;
          updateStopButtonState(true);
          break;
        case 'complete':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          setAutoRunButton(t('btnAuto'));
          autoContinueBar.style.display = 'none';
          autoContinueBar.dataset.reason = '';
          updateStopButtonState(false);
          break;
        case 'stopped':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          setAutoRunButton(t('btnAuto'));
          autoContinueBar.style.display = 'none';
          autoContinueBar.dataset.reason = '';
          updateStopButtonState(false);
          finishActiveRunMetrics(false, Number(lastKnownState?.flowStartTime || 0));
          break;
      }
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' })
        .then(updateStatusDisplay)
        .catch(() => {});
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('multipage-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('multipage-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Init
// ============================================================

initTheme();
applyLanguage(currentLanguage);
renderVersionBadge();
restoreState().then(() => {
  syncPasswordToggleLabel();
  updateButtonStates();
  checkLatestReleaseVersion().catch(() => {});
});
