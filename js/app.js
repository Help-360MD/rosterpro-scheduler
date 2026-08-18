(function () {
  "use strict";

  var appConfig = window.RosterProConfig || {};
  var BACKEND_URL = appConfig.apiBaseUrl || "https://script.google.com/macros/s/AKfycbzWae2_Tq2-OOTP8_qbRqjMG-sDMI6_6SjQeXkrCfzlRdbFNufm7rCSjZv66FgAssIozQ/exec";
  var syncConfig = appConfig.sync || {};
  var performanceConfig = appConfig.performance || {};
  var OVERTIME_LIMIT = 40;
  var seed = window.RosterProSeed || {
    brand: {
      toolName: "RosterPro",
      clinicName: "Stetho MD",
      poweredBy: "Help360 MD",
      supportPhone: "(321) 999-9553",
      assets: { clinicLogo: "", partnerLogo: "", productLogo: "" }
    },
    defaultMonth: "2026-06",
    defaultLocation: "Tampa",
    staff: [],
    schedules: {},
    locations: [],
    localAccounts: []
  };
  var storagePrefix = "rosterpro.v1.";
  var state = {
    brand: seed.brand,
    staff: [],
    schedules: {},
    locations: [],
    accounts: [],
    hoursHistory: [],
    hoursRangeRows: [],
    hoursSummary: [],
    user: null,
    view: "dashboard",
    month: seed.defaultMonth,
    location: seed.defaultLocation,
    selectedDate: null,
    scheduleDuty: "Front Desk",
    selectedScheduleStaffId: "",
    staffFilter: "",
    locationFilter: "All",
    hoursFilter: "",
    hoursStatusFilter: "All",
    hoursStartDate: seed.defaultMonth + "-01",
    hoursEndDate: seed.defaultMonth + "-30",
    hoursSort: "weeklyDesc",
    hoursLoadedRange: "",
    hoursLoading: false,
    syncVersions: {},
    syncTimer: null,
    scheduleSyncTimer: null,
    syncInFlight: false,
    scheduleSyncInFlight: false,
    lastSyncAt: "",
    pendingWrites: 0,
    pendingScheduleRefresh: false,
    lastScheduleInputAt: 0,
    tempPasswordLogin: null,
    darkMode: false
  };

  var weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  var shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var fullMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var scheduleDuties = [
    "Front Desk",
    "Insurance Verification",
    "Referrals",
    "Appointment Scheduling",
    "Phone Management",
    "Scribe",
    "Billing",
    "Coding",
    "Provider Coverage",
    "Clinical Support"
  ];

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getStored(key, fallback) {
    try {
      var raw = localStorage.getItem(storagePrefix + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function setStored(key, value) {
    localStorage.setItem(storagePrefix + key, JSON.stringify(value));
  }

  async function apiCall(action, data, options) {
    options = options || {};
    var attempts = options.attempts || performanceConfig.apiRetryAttempts || 3;
    var timeout = options.timeout || performanceConfig.apiTimeoutMs || 18000;
    var lastError = null;

    for (var attempt = 1; attempt <= attempts; attempt += 1) {
      var controller = window.AbortController ? new AbortController() : null;
      var timer = controller ? setTimeout(function () {
        controller.abort();
      }, timeout) : null;
      try {
        var response = await fetch(BACKEND_URL, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "text/plain;charset=utf-8"
          },
          body: JSON.stringify({
            action: action,
            data: data || {},
            requestId: "rp-" + Date.now() + "-" + Math.random().toString(16).slice(2)
          }),
          signal: controller ? controller.signal : undefined
        });
        var text = await response.text();
        var payload = parseApiPayload(text);
        if (!response.ok) {
          throw new Error(payload.error || "Backend returned status " + response.status + ".");
        }
        validateApiPayload(payload);
        if (!payload.ok) {
          throw new Error(payload.error || "Backend request failed.");
        }
        return payload.data;
      } catch (error) {
        lastError = error;
        if (attempt === attempts || options.retry === false) break;
        await sleep(300 * attempt);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    throw friendlyBackendError(lastError);
  }

  function parseApiPayload(text) {
    try {
      return JSON.parse(text || "{}");
    } catch (error) {
      throw new Error("Backend returned an invalid JSON response.");
    }
  }

  function validateApiPayload(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.ok !== "boolean") {
      throw new Error("Backend response was missing the required ok status.");
    }
  }

  function friendlyBackendError(error) {
    var message = error && error.name === "AbortError"
      ? "Backend request timed out. Please try again."
      : error && error.message
        ? error.message
        : "Unable to reach the RosterPro backend.";
    return new Error(message);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function setSyncStatus(status, label) {
    var pill = $("#syncStatusPill");
    if (!pill) return;
    pill.className = "pill sync-pill sync-" + status;
    pill.innerHTML = "<span class=\"sync-dot\"></span>" + escapeHtml(label || status);
  }

  function startSyncLoop() {
    if (syncConfig.enabled === false) return;
    var interval = Math.max(15000, Number(syncConfig.intervalMs || 20000));
    var scheduleInterval = Math.max(3000, Number(syncConfig.scheduleIntervalMs || 3000));
    if (!state.syncTimer) {
      state.syncTimer = setInterval(function () {
        syncNow("interval");
      }, interval);
    }
    if (!state.scheduleSyncTimer) {
      state.scheduleSyncTimer = setInterval(function () {
        syncScheduleNow("schedule-interval");
      }, scheduleInterval);
    }
    syncNow("start");
    syncScheduleNow("start");
  }

  function stopSyncLoop() {
    if (state.syncTimer) {
      clearInterval(state.syncTimer);
      state.syncTimer = null;
    }
    if (state.scheduleSyncTimer) {
      clearInterval(state.scheduleSyncTimer);
      state.scheduleSyncTimer = null;
    }
    state.syncInFlight = false;
    state.scheduleSyncInFlight = false;
  }

  async function syncNow(reason) {
    if (!state.user || state.syncInFlight || state.pendingWrites > 0) return;
    state.syncInFlight = true;
    setSyncStatus("loading", reason === "start" ? "Syncing" : "Checking");
    try {
      var range = {
        startDate: state.hoursStartDate,
        endDate: state.hoursEndDate
      };
      var payload = await apiCall("getChanges", {
        versions: state.syncVersions || {},
        month: state.month,
        location: state.location,
        hoursRange: range,
        only: ["staff", "locations", "hours"]
      }, { attempts: 1, retry: false, timeout: 12000 });
      applySyncPayload(payload || {});
      state.lastSyncAt = payload && payload.serverTime ? payload.serverTime : new Date().toISOString();
      setSyncStatus("synced", lastUpdatedLabel(state.lastSyncAt));
    } catch (error) {
      setSyncStatus("offline", "Offline");
    } finally {
      state.syncInFlight = false;
    }
  }

  async function syncScheduleNow(reason) {
    if (!state.user || state.scheduleSyncInFlight || state.syncInFlight || state.pendingWrites > 0) return;
    state.scheduleSyncInFlight = true;
    var visible = reason !== "schedule-interval";
    if (visible) {
      setSyncStatus("loading", "Updating");
      setCalendarSyncing(true);
    }
    try {
      var payload = await apiCall("getScheduleMonth", {
        month: state.month,
        location: state.location,
        includeLookups: false,
        includeHours: false
      }, { attempts: 1, retry: false, timeout: 8000 });
      applyScheduleMonthPayload(payload || {}, { liveSchedule: true, silent: !visible, render: state.view === "schedule" });
      state.lastSyncAt = payload && payload.serverTime ? payload.serverTime : new Date().toISOString();
      setSyncStatus("synced", lastUpdatedLabel(state.lastSyncAt));
    } catch (error) {
      if (visible) {
        setSyncStatus("offline", "Offline");
      }
    } finally {
      if (visible) setCalendarSyncing(false);
      state.scheduleSyncInFlight = false;
    }
  }

  function setCalendarSyncing(active) {
    var preview = $(".calendar-preview");
    if (!preview) return;
    preview.classList.toggle("is-syncing", Boolean(active));
  }

  function applySyncPayload(payload, options) {
    options = options || {};
    var changed = payload.changed || {};
    if (payload.staff) {
      state.staff = payload.staff;
      setStored("staff", state.staff);
    }
    if (payload.locations) {
      state.locations = payload.locations;
      setStored("locations", state.locations);
      fillControls();
    }
    if (payload.schedules) {
      mergeScheduleStore(payload.schedules, payload.scheduleScope);
      setStored("schedules", state.schedules);
      state.hoursHistory = buildHoursHistory(state.schedules, state.staff);
      state.hoursRangeRows = [];
      state.hoursLoadedRange = "";
      state.hoursSummary = summarizeHours(filterHoursHistory(state.hoursHistory));
    }
    if (payload.hoursHistory) {
      state.hoursRangeRows = payload.hoursHistory;
      state.hoursLoadedRange = (payload.hoursRange && payload.hoursRange.startDate ? payload.hoursRange.startDate : state.hoursStartDate) + "|" + (payload.hoursRange && payload.hoursRange.endDate ? payload.hoursRange.endDate : state.hoursEndDate);
    }
    if (payload.hoursSummary) {
      state.hoursSummary = payload.hoursSummary;
    }
    if (payload.versions) {
      state.syncVersions = Object.assign({}, state.syncVersions, payload.versions);
      setStored("syncVersions", state.syncVersions);
    }
    if (changed.staff || changed.locations || changed.schedules || changed.hours) {
      renderChangedViews(changed, options);
    }
  }

  function applyScheduleMonthPayload(payload, options) {
    options = options || {};
    if (Array.isArray(payload.staff)) {
      state.staff = payload.staff;
      setStored("staff", state.staff);
    }
    if (Array.isArray(payload.locations)) {
      state.locations = payload.locations;
      setStored("locations", state.locations);
      fillControls();
    }
    if (payload.schedules && payload.scheduleScope) {
      mergeScheduleStore(payload.schedules, payload.scheduleScope);
      setStored("schedules", state.schedules);
      state.hoursHistory = buildHoursHistory(state.schedules, state.staff);
      state.hoursRangeRows = [];
      state.hoursLoadedRange = "";
      state.hoursSummary = summarizeHours(filterHoursHistory(state.hoursHistory));
    }
    if (payload.hoursHistory) {
      state.hoursRangeRows = payload.hoursHistory;
      state.hoursLoadedRange = (payload.hoursRange && payload.hoursRange.startDate ? payload.hoursRange.startDate : state.hoursStartDate) + "|" + (payload.hoursRange && payload.hoursRange.endDate ? payload.hoursRange.endDate : state.hoursEndDate);
    }
    if (payload.hoursSummary) {
      state.hoursSummary = payload.hoursSummary;
    }
    if (payload.versions) {
      state.syncVersions = Object.assign({}, state.syncVersions, payload.versions);
      setStored("syncVersions", state.syncVersions);
    }
    if (options.render) {
      renderChangedViews({ schedules: true, hours: Boolean(payload.hoursSummary || payload.hoursHistory), staff: Array.isArray(payload.staff), locations: Array.isArray(payload.locations) }, options);
    }
  }

  function mergeScheduleStore(incoming, scope) {
    if (!scope || (!scope.month && !scope.location)) {
      state.schedules = incoming || {};
      return;
    }
    Object.keys(incoming || {}).forEach(function (month) {
      state.schedules[month] = state.schedules[month] || {};
      Object.keys(incoming[month] || {}).forEach(function (location) {
        state.schedules[month][location] = incoming[month][location];
      });
    });
  }

  function renderChangedViews(changed, options) {
    options = options || {};
    if (state.view === "dashboard" && (changed.staff || changed.schedules || changed.hours)) {
      renderDashboard();
      return;
    }
    if (state.view === "staff" && changed.staff) {
      renderStaff();
      return;
    }
    if (state.view === "locations" && (changed.locations || changed.staff)) {
      renderLocations();
      return;
    }
    if (state.view === "hours" && (changed.hours || changed.staff || changed.schedules)) {
      renderHours();
      return;
    }
    if (state.view === "reports" && (changed.staff || changed.schedules || changed.hours)) {
      renderReports();
      return;
    }
    if (state.view === "schedule" && changed.schedules) {
      if (!options.force && isScheduleEditorActivelyEditing()) {
        if (!state.pendingScheduleRefresh) {
          showToast("Live schedule update is ready. Finish typing to refresh.");
        }
        state.pendingScheduleRefresh = true;
        setSyncStatus("synced", "Live update ready");
      } else {
        state.pendingScheduleRefresh = false;
        renderSchedule();
      }
    }
  }

  function isScheduleEditorActivelyEditing() {
    var field = $("#dayAssignments");
    if (!field || document.activeElement !== field) return false;
    return isScheduleEditorDirty() && Date.now() - (state.lastScheduleInputAt || 0) < 5000;
  }

  function isScheduleEditorDirty() {
    if (!state.selectedDate || !$("#dayAssignments")) return false;
    var current = $("#dayAssignments").value.trim();
    var saved = (ensureSchedule(state.month, state.location).days[state.selectedDate] || []).join("\n").trim();
    return current !== saved;
  }

  function flushPendingScheduleRefresh() {
    if (!state.pendingScheduleRefresh || isScheduleEditorDirty()) return;
    state.pendingScheduleRefresh = false;
    renderSchedule();
  }

  function lastUpdatedLabel(value) {
    var date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) date = new Date();
    return "Last updated by " + date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function requestScheduleScopeSync() {
    state.syncVersions = Object.assign({}, state.syncVersions, { schedules: "" });
    syncScheduleNow("scope");
  }

  async function refreshScheduleFromGoogleSheet(force) {
    if (!state.user || state.pendingWrites > 0) return;
    setRefreshBusy(true);
    setCalendarSyncing(true);
    setSyncStatus("loading", "Refreshing");
    try {
      var range = monthRange(state.month);
      var payload = await apiCall("getScheduleMonth", {
        month: state.month,
        location: state.location,
        includeLookups: true,
        includeHours: true,
        hoursRange: range
      }, { attempts: 2, retry: true, timeout: 15000 });
      applyScheduleMonthPayload(payload || {}, { render: true, force: Boolean(force) });
      state.lastSyncAt = payload && payload.serverTime ? payload.serverTime : new Date().toISOString();
      setSyncStatus("synced", lastUpdatedLabel(state.lastSyncAt));
      showToast("Schedule refreshed from Google Sheet");
    } catch (error) {
      setSyncStatus("offline", "Offline");
      showToast("Google Sheet refresh failed. " + error.message);
    } finally {
      setCalendarSyncing(false);
      setRefreshBusy(false);
    }
  }

  async function loadData() {
    var localFallback = {
      brand: clone(seed.brand),
      staff: getStored("staff", clone(seed.staff)),
      schedules: getStored("schedules", clone(seed.schedules)),
      locations: getStored("locations", clone(seed.locations)),
      accounts: getStored("accounts", clone(seed.localAccounts)),
      versions: getStored("syncVersions", {})
    };

    try {
      setSyncStatus("loading", "Loading");
      var gasData = await apiCall("getBootstrap");
      return {
        brand: gasData.brand || localFallback.brand,
        staff: Array.isArray(gasData.staff) ? gasData.staff : localFallback.staff,
        schedules: gasData.schedules && typeof gasData.schedules === "object" ? gasData.schedules : {},
        locations: Array.isArray(gasData.locations) ? gasData.locations : localFallback.locations,
        accounts: Array.isArray(gasData.accounts) ? gasData.accounts : localFallback.accounts,
        hoursHistory: gasData.hoursHistory || [],
        hoursSummary: gasData.hoursSummary || [],
        versions: gasData.versions || {}
      };
    } catch (error) {
      showToast("Backend unavailable. Using local data.");
      setSyncStatus("offline", "Offline");
      return localFallback;
    }
  }

  async function init() {
    bindBaseEvents();
    state.brand = clone(seed.brand);
    applyBranding();
    var data = await loadData();
    state.brand = data.brand;
    state.staff = data.staff;
    state.schedules = data.schedules;
    state.locations = data.locations;
    state.accounts = data.accounts;
    state.hoursHistory = data.hoursHistory && data.hoursHistory.length ? data.hoursHistory : buildHoursHistory(state.schedules, state.staff);
    state.hoursRangeRows = state.hoursHistory;
    state.hoursSummary = data.hoursSummary && data.hoursSummary.length ? data.hoursSummary : summarizeHours(filterHoursHistory(state.hoursHistory));
    state.syncVersions = data.versions || getStored("syncVersions", {});
    state.user = getStored("session", null) || sessionStorage.getItem(storagePrefix + "session");
    if (typeof state.user === "string") {
      state.user = JSON.parse(state.user);
    }
    state.darkMode = getStored("darkMode", false);
    applyBranding();
    applyTheme();
    fillControls();
    if (state.user) {
      showApp();
      startSyncLoop();
    } else {
      showLogin();
    }
    if (state.syncVersions && Object.keys(state.syncVersions).length) {
      setSyncStatus("synced", "Synced");
    }
  }

  function applyBranding() {
    document.title = state.brand.toolName + " - " + state.brand.clinicName;
    $all("[data-brand='tool']").forEach(function (node) {
      node.textContent = state.brand.toolName;
    });
    $all("[data-brand='clinic']").forEach(function (node) {
      node.textContent = state.brand.clinicName;
    });
    $all("[data-brand='powered']").forEach(function (node) {
      node.textContent = state.brand.poweredBy;
    });
    $all("[data-brand='phone']").forEach(function (node) {
      node.textContent = state.brand.supportPhone;
      if (node.tagName === "A") {
        node.href = "tel:" + state.brand.supportPhone.replace(/[^\d+]/g, "");
      }
    });
    $all("[data-logo='clinic']").forEach(function (node) {
      node.src = state.brand.assets.clinicLogo;
    });
    $all("[data-logo='partner']").forEach(function (node) {
      node.src = state.brand.assets.partnerLogo;
    });
    $all("[data-logo='product']").forEach(function (node) {
      node.src = state.brand.assets.productLogo;
    });
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.darkMode ? "dark" : "light";
    var toggle = $("#darkModeToggle");
    if (toggle) {
      toggle.checked = state.darkMode;
    }
  }

  function showLogin() {
    $("#loginView").hidden = false;
    $("#appShell").hidden = true;
    $("#loginForm").hidden = false;
    $("#setPasswordForm").hidden = true;
    $("#newPassword").value = "";
    $("#confirmNewPassword").value = "";
    $("#setPasswordError").hidden = true;
  }

  function showApp() {
    $("#loginView").hidden = true;
    $("#appShell").hidden = false;
    render();
  }

  function bindBaseEvents() {
    $("#loginForm").addEventListener("submit", onLogin);
    $("#setPasswordForm").addEventListener("submit", onSetNewPassword);
    $("#backToLoginBtn").addEventListener("click", function () {
      state.tempPasswordLogin = null;
      showLogin();
    });
    $("#togglePassword").addEventListener("change", function (event) {
      $("#password").type = event.target.checked ? "text" : "password";
    });
    $("#forgotPasswordBtn").addEventListener("click", onForgotPassword);
    $("#logoutBtn").addEventListener("click", logout);
    $("#darkModeToggle").addEventListener("change", function (event) {
      state.darkMode = event.target.checked;
      setStored("darkMode", state.darkMode);
      applyTheme();
    });
    $all("[data-view]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.view = button.dataset.view;
        render();
      });
    });
    $("#staffSearch").addEventListener("input", debounce(function (event) {
      state.staffFilter = event.target.value.trim().toLowerCase();
      renderStaff();
    }, 120));
    $("#staffLocationFilter").addEventListener("change", function (event) {
      state.locationFilter = event.target.value;
      renderStaff();
    });
    $("#addStaffBtn").addEventListener("click", function () {
      openStaffForm();
    });
    $("#closeDrawerBtn").addEventListener("click", closeDrawer);
    $("#drawer").addEventListener("click", onDrawerClick);
    $("#scheduleMonth").addEventListener("change", function (event) {
      state.month = event.target.value;
      state.selectedDate = null;
      renderSchedule();
      requestScheduleScopeSync();
    });
    $("#scheduleLocation").addEventListener("change", function (event) {
      state.location = event.target.value;
      state.selectedDate = null;
      renderSchedule();
      requestScheduleScopeSync();
    });
    $("#scheduleDutySelect").addEventListener("change", function (event) {
      state.scheduleDuty = event.target.value;
      renderScheduleGuidance();
    });
    $("#scheduleStaffSelect").addEventListener("change", function (event) {
      state.selectedScheduleStaffId = event.target.value;
      renderScheduleGuidance();
    });
    $("#addScheduleStaffBtn").addEventListener("click", function () {
      addSelectedStaffToDay(state.selectedScheduleStaffId);
    });
    $("#printScheduleBtn").addEventListener("click", function () {
      window.print();
    });
    $("#refreshScheduleBtn").addEventListener("click", function () {
      refreshScheduleFromGoogleSheet(true);
    });
    $("#exportScheduleCsvBtn").addEventListener("click", exportScheduleCsv);
    $("#exportStaffCsvBtn").addEventListener("click", exportStaffCsv);
    $("#exportHoursCsvBtn").addEventListener("click", exportHoursCsv);
    $("#resetLocalDataBtn").addEventListener("click", resetLocalData);
    $("#saveDayBtn").addEventListener("click", saveSelectedDay);
    $("#copyPreviousWeekBtn").addEventListener("click", copyPreviousWeek);
    $("#addNextMonthBtn").addEventListener("click", addNextScheduleMonth);
    $("#dayAssignments").addEventListener("input", function () {
      state.lastScheduleInputAt = Date.now();
    });
    $("#dayAssignments").addEventListener("blur", flushPendingScheduleRefresh);
    $("#dayAssignments").addEventListener("input", debounce(function () {
      renderScheduleGuidance();
    }, 120));
    $("#staffRecommendations").addEventListener("click", function (event) {
      var button = event.target.closest("[data-recommend-staff]");
      if (!button) return;
      state.selectedScheduleStaffId = button.dataset.recommendStaff;
      $("#scheduleStaffSelect").value = state.selectedScheduleStaffId;
      renderScheduleGuidance();
      addSelectedStaffToDay(state.selectedScheduleStaffId);
    });
    $("#hoursSearch").addEventListener("input", debounce(function (event) {
      state.hoursFilter = event.target.value.trim().toLowerCase();
      renderHours();
    }, 120));
    $("#hoursStatusFilter").addEventListener("change", function (event) {
      state.hoursStatusFilter = event.target.value;
      renderHours();
    });
    $("#hoursSort").addEventListener("change", function (event) {
      state.hoursSort = event.target.value;
      renderHours();
    });
    $("#hoursStartDate").addEventListener("change", function (event) {
      state.hoursStartDate = event.target.value;
      state.hoursLoadedRange = "";
      state.hoursRangeRows = [];
      renderHours();
    });
    $("#hoursEndDate").addEventListener("change", function (event) {
      state.hoursEndDate = event.target.value;
      state.hoursLoadedRange = "";
      state.hoursRangeRows = [];
      renderHours();
    });
    $("#scheduleCalendar").addEventListener("click", function (event) {
      var cell = event.target.closest("[data-date]");
      if (!cell) return;
      state.selectedDate = cell.dataset.date;
      renderSchedule();
    });
  }

  async function onLogin(event) {
    event.preventDefault();
    var username = $("#username").value.trim();
    var password = $("#password").value;
    try {
      var serverUser = await apiCall("login", { username: username, password: password });
      if (serverUser.mustChangePassword) {
        state.tempPasswordLogin = serverUser;
        $("#password").value = "";
        $("#loginError").hidden = true;
        showSetPasswordForm();
        return;
      }
      state.user = serverUser;
      if ($("#rememberMe").checked) {
        setStored("session", state.user);
      } else {
        sessionStorage.setItem(storagePrefix + "session", JSON.stringify(state.user));
      }
      $("#password").value = "";
      $("#loginError").hidden = true;
      showApp();
      startSyncLoop();
      return;
    } catch (error) {
      // Local preview can still sign in with the bundled seed account if the deployed backend is unreachable.
    }
    var account = state.accounts.find(function (candidate) {
      return candidate.username.toLowerCase() === username.toLowerCase() && candidate.status === "Active";
    });
    var hash = await sha256(username.toLowerCase() + ":" + password);
    if (!account || account.passwordHash !== hash) {
      $("#loginError").textContent = "Username or password is incorrect.";
      $("#loginError").hidden = false;
      return;
    }
    state.user = {
      username: account.username,
      fullName: account.fullName,
      role: account.role,
      staffId: account.staffId
    };
    if ($("#rememberMe").checked) {
      setStored("session", state.user);
    } else {
      sessionStorage.setItem(storagePrefix + "session", JSON.stringify(state.user));
    }
    $("#password").value = "";
    $("#loginError").hidden = true;
    showApp();
    startSyncLoop();
  }

  function showSetPasswordForm() {
    $("#loginForm").hidden = true;
    $("#setPasswordForm").hidden = false;
    $("#newPassword").focus();
  }

  async function onSetNewPassword(event) {
    event.preventDefault();
    var newPassword = $("#newPassword").value;
    var confirmPassword = $("#confirmNewPassword").value;
    if (!state.tempPasswordLogin) {
      showLogin();
      return;
    }
    if (newPassword.length < 8) {
      $("#setPasswordError").textContent = "Password must be at least 8 characters.";
      $("#setPasswordError").hidden = false;
      return;
    }
    if (newPassword !== confirmPassword) {
      $("#setPasswordError").textContent = "Passwords do not match.";
      $("#setPasswordError").hidden = false;
      return;
    }
    try {
      var user = await apiCall("changePassword", {
        username: state.tempPasswordLogin.username,
        resetId: state.tempPasswordLogin.resetId,
        newPassword: newPassword
      });
      state.tempPasswordLogin = null;
      state.user = user;
      setStored("session", state.user);
      $("#newPassword").value = "";
      $("#confirmNewPassword").value = "";
      $("#setPasswordError").hidden = true;
      showApp();
      startSyncLoop();
      showToast("Password updated");
    } catch (error) {
      $("#setPasswordError").textContent = error.message || "Password could not be updated.";
      $("#setPasswordError").hidden = false;
    }
  }

  async function sha256(text) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Secure hashing is not available in this browser.");
    }
    var encoded = new TextEncoder().encode(text);
    var buffer = await window.crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(buffer)).map(function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  async function onForgotPassword() {
    var username = $("#username").value.trim();
    if (username) {
      try {
        await apiCall("requestPasswordReset", { identifier: username });
        showToast("Password reset sent");
      } catch (error) {
        showToast("Reset could not be sent");
      }
      return;
    }
    showToast("Enter a username first");
  }

  function logout() {
    localStorage.removeItem(storagePrefix + "session");
    sessionStorage.removeItem(storagePrefix + "session");
    stopSyncLoop();
    state.user = null;
    showLogin();
  }

  function fillControls() {
    var locationOptions = state.locations.map(function (location) {
      return "<option value=\"" + escapeHtml(location.name) + "\">" + escapeHtml(location.name) + "</option>";
    }).join("");
    $("#scheduleLocation").innerHTML = locationOptions;
    $("#scheduleLocation").value = state.location;
    $("#staffLocationFilter").innerHTML = "<option>All</option>" + locationOptions;
    var monthOptions = getScheduleMonths().map(function (monthKey) {
      return "<option value=\"" + monthKey + "\">" + monthTitle(monthKey) + "</option>";
    }).join("");
    $("#scheduleMonth").innerHTML = monthOptions;
    $("#scheduleMonth").value = state.month;
    $("#scheduleDutySelect").innerHTML = scheduleDuties.map(function (duty) {
      return "<option value=\"" + escapeAttr(duty) + "\">" + escapeHtml(duty) + "</option>";
    }).join("");
    $("#scheduleDutySelect").value = state.scheduleDuty;
    var monthEnd = new Date(monthParts(state.month).year, monthParts(state.month).month, 0).getDate();
    state.hoursStartDate = state.month + "-01";
    state.hoursEndDate = state.month + "-" + String(monthEnd).padStart(2, "0");
    $("#hoursStartDate").value = state.hoursStartDate;
    $("#hoursEndDate").value = state.hoursEndDate;
  }

  function getScheduleMonths() {
    var months = Object.keys(state.schedules);
    if (!months.includes(state.month)) {
      months.push(state.month);
    }
    return months.sort();
  }

  function addNextScheduleMonth() {
    var months = getScheduleMonths();
    var nextMonth = addMonthsToKey(months[months.length - 1] || state.month, 1);
    state.schedules[nextMonth] = state.schedules[nextMonth] || {};
    state.locations.forEach(function (location) {
      state.schedules[nextMonth][location.name] = state.schedules[nextMonth][location.name] || {
        location: location.name,
        month: nextMonth,
        footerNote: location.printNote || "",
        days: {}
      };
    });
    state.month = nextMonth;
    state.selectedDate = null;
    fillControls();
    renderSchedule();
    showToast("Added " + monthTitle(nextMonth));
  }

  function addMonthsToKey(monthKey, amount) {
    var parts = monthParts(monthKey);
    var date = new Date(parts.year, parts.month - 1 + amount, 1);
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }

  function render() {
    $all("[data-view]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.view === state.view);
    });
    $all(".view").forEach(function (view) {
      view.classList.toggle("active", view.id === state.view + "View");
    });
    $("#currentUserName").textContent = state.user ? state.user.fullName : "";
    $("#currentUserRole").textContent = state.user ? state.user.role : "";
    var titles = {
      dashboard: ["Dashboard", state.brand.clinicName + " workforce snapshot"],
      staff: ["Staff Directory", state.staff.length + " active records"],
      schedule: ["Monthly Schedule", state.location + " - " + monthTitle(state.month)],
      hours: ["Hours Monitoring", state.hoursStartDate + " through " + state.hoursEndDate],
      locations: ["Locations", state.locations.length + " offices and work groups"],
      reports: ["Reports", "Coverage, utilization, and exports"],
      settings: ["Settings", state.brand.toolName + " configuration"]
    };
    $("#pageTitle").textContent = titles[state.view][0];
    $("#pageKicker").textContent = titles[state.view][1];
    if (state.view === "dashboard") renderDashboard();
    if (state.view === "staff") renderStaff();
    if (state.view === "schedule") renderSchedule();
    if (state.view === "hours") renderHours();
    if (state.view === "locations") renderLocations();
    if (state.view === "reports") renderReports();
    if (state.view === "settings") renderSettings();
  }

  function renderDashboard() {
    var todayKey = toDateKey(new Date());
    var todayStaff = uniqueNamesForDate(todayKey);
    var upcoming = countUpcomingShifts(14);
    var openDays = countOpenDays();
    var currentWeek = weekRange(new Date());
    var currentMonth = monthRange(state.month);
    var weeklySummary = summarizeHours(filterHoursHistory(state.hoursHistory, { startDate: currentWeek.start, endDate: currentWeek.end }));
    var monthlySummary = summarizeHours(filterHoursHistory(state.hoursHistory, { startDate: currentMonth.start, endDate: currentMonth.end }));
    var weeklyTotals = totalHours(weeklySummary);
    var monthlyTotals = totalHours(monthlySummary);
    var nearOvertime = weeklySummary.filter(function (item) {
      return item.weeklyHours >= 36 && item.weeklyHours <= 40;
    });
    var inOvertime = weeklySummary.filter(function (item) {
      return item.weeklyHours > 40;
    });
    $("#metricTotalStaff").textContent = state.staff.length;
    $("#metricWorkingToday").textContent = todayStaff.length;
    $("#metricUpcomingShifts").textContent = upcoming;
    $("#metricOpenShifts").textContent = openDays;
    $("#metricLocations").textContent = state.locations.length;
    $("#metricRegularHours").textContent = formatHours(weeklyTotals.regular);
    $("#metricOvertimeHours").textContent = formatHours(weeklyTotals.overtime);
    $("#metricWeeklyHours").textContent = formatHours(weeklyTotals.total);
    $("#metricMonthlyHours").textContent = formatHours(monthlyTotals.total);
    $("#todayScheduleList").innerHTML = todayStaff.length
      ? todayStaff.map(function (name) {
        return "<div class=\"mini-row\"><strong>" + escapeHtml(name) + "</strong><span class=\"pill teal\">" + escapeHtml(todayKey) + "</span></div>";
      }).join("")
      : "<p class=\"help-text\">No schedule entries for " + escapeHtml(todayKey) + ".</p>";
    $("#nearOvertimeList").innerHTML = nearOvertime.length ? nearOvertime.map(function (item) {
      return "<div class=\"mini-row\"><strong>" + escapeHtml(item.staffName) + "</strong><span class=\"pill gold\">" + formatHours(item.weeklyHours) + " hrs</span></div>";
    }).join("") : "<p class=\"help-text\">No employees near overtime.</p>";
    $("#overtimeList").innerHTML = inOvertime.length ? inOvertime.map(function (item) {
      return "<div class=\"mini-row\"><strong>" + escapeHtml(item.staffName) + "</strong><span class=\"pill red\">" + formatHours(item.weeklyHours) + " hrs</span></div>";
    }).join("") : "<p class=\"help-text\">No employees currently in overtime.</p>";
    $("#topWorkedList").innerHTML = monthlySummary.slice(0, 5).map(function (item) {
      return "<div class=\"mini-row\"><strong>" + escapeHtml(item.staffName) + "</strong><span class=\"pill teal\">" + formatHours(item.monthlyHours) + " hrs</span></div>";
    }).join("");
    $("#recentChangesList").innerHTML = [
      "Seeded staff directory from the two Stetho MD PDFs.",
      "Loaded June 2026 Tampa print schedule.",
      "Loaded June 2026 Zephyrhills print schedule.",
      "Added HoursHistory tracking with 40-hour overtime warnings.",
      "Permanent administrators created: Usama Mazhar, Farhana Rahman, Fozia Kanwal, Muhammad Asman."
    ].map(function (item) {
      return "<div class=\"mini-row\"><span>" + escapeHtml(item) + "</span></div>";
    }).join("");
    $("#quickActionsList").innerHTML = [
      ["Print Schedule", "schedule"],
      ["Staff Directory", "staff"],
      ["Hours Monitoring", "hours"],
      ["Export Reports", "reports"]
    ].map(function (item) {
      return "<button class=\"secondary-btn\" data-jump=\"" + item[1] + "\">" + item[0] + "</button>";
    }).join("");
    $all("[data-jump]", $("#quickActionsList")).forEach(function (button) {
      button.addEventListener("click", function () {
        state.view = button.dataset.jump;
        render();
      });
    });
  }

  function uniqueNamesForDate(dateKey) {
    var names = [];
    var monthBucket = state.schedules[state.month] || {};
    Object.keys(monthBucket).forEach(function (locationName) {
      var day = monthBucket[locationName].days[dateKey] || [];
      names = names.concat(day);
    });
    return Array.from(new Set(names.map(cleanScheduleName))).filter(Boolean);
  }

  function countUpcomingShifts(daysAhead) {
    var count = 0;
    var today = new Date();
    for (var index = 0; index < daysAhead; index += 1) {
      var date = addDays(today, index);
      count += uniqueNamesForDate(toDateKey(date)).length;
    }
    return count;
  }

  function countOpenDays() {
    var schedule = ensureSchedule(state.month, state.location);
    return calendarDates(state.month).filter(function (date) {
      return date.getMonth() === monthParts(state.month).month - 1 && !(schedule.days[toDateKey(date)] || []).length;
    }).length;
  }

  function renderStaff() {
    var tbody = $("#staffTableBody");
    var filtered = state.staff.filter(function (staff) {
      var haystack = [
        staff.fullName,
        staff.email,
        staff.phoneNumber,
        staff.personalPhoneNumber,
        staff.jobTitle,
        staff.department,
        staff.officeLocation,
        staff.athenaUser
      ].join(" ").toLowerCase();
      var matchesText = !state.staffFilter || haystack.includes(state.staffFilter);
      var matchesLocation = state.locationFilter === "All" || staff.officeLocation === state.locationFilter;
      return matchesText && matchesLocation;
    }).sort(function (a, b) {
      return a.fullName.localeCompare(b.fullName);
    });
    $("#staffCountLabel").textContent = filtered.length + " shown";
    tbody.innerHTML = filtered.map(function (staff) {
      return [
        "<tr>",
        "<td><button class=\"staff-name-btn\" data-staff-id=\"" + escapeHtml(staff.staffId) + "\">" + escapeHtml(staff.fullName) + "</button></td>",
        "<td><a href=\"mailto:" + escapeAttr(staff.email) + "\">" + escapeHtml(staff.email) + "</a></td>",
        "<td>" + phoneLink(staff.phoneNumber) + "</td>",
        "<td>" + phoneLink(staff.personalPhoneNumber) + "</td>",
        "<td>" + escapeHtml(staff.jobTitle) + "</td>",
        "<td>" + escapeHtml(staff.department) + "</td>",
        "<td>" + escapeHtml(staff.officeLocation) + "</td>",
        "<td><span class=\"pill teal\">" + escapeHtml(staff.employmentStatus || "Active") + "</span></td>",
        "</tr>"
      ].join("");
    }).join("");
    $all("[data-staff-id]", tbody).forEach(function (button) {
      button.addEventListener("click", function () {
        openStaffProfile(button.dataset.staffId);
      });
    });
  }

  function openStaffProfile(staffId) {
    var staff = state.staff.find(function (item) {
      return item.staffId === staffId;
    });
    if (!staff) return;
    $("#drawerTitle").textContent = staff.fullName;
    $("#drawerSubtitle").textContent = staff.jobTitle + " - " + staff.officeLocation;
    $("#drawerBody").innerHTML = [
      "<div class=\"toolbar\" style=\"margin-bottom:14px\">",
      "<button class=\"secondary-btn\" data-drawer-action=\"edit\" data-staff-id=\"" + escapeHtml(staff.staffId) + "\">Edit</button>",
      "<button class=\"secondary-btn\" data-drawer-action=\"admin\" data-staff-id=\"" + escapeHtml(staff.staffId) + "\">Make Administrator</button>",
      "<button class=\"danger-btn\" data-drawer-action=\"delete\" data-staff-id=\"" + escapeHtml(staff.staffId) + "\">Delete</button>",
      "</div>",
      "<dl class=\"profile-grid\">",
      profileField("Employee ID", staff.staffId),
      profileField("Email", "<a href=\"mailto:" + escapeAttr(staff.email) + "\">" + escapeHtml(staff.email) + "</a>", true),
      profileField("Office Phone", phoneLink(staff.phoneNumber), true),
      profileField("Extension", staff.extension),
      profileField("Personal Phone", phoneLink(staff.personalPhoneNumber), true),
      profileField("Department", staff.department),
      profileField("Primary Specialty", staff.primarySpecialty),
      profileField("Location", staff.officeLocation),
      profileField("Time Zone", staff.timeZone),
      profileField("Verified Date", staff.verifiedDate),
      profileField("Preferred Days", staff.preferredWorkingDays),
      profileField("Preferred Shift", staff.preferredShiftTime),
      profileField("Available Locations", staff.availableLocations),
      profileField("Athena User", staff.athenaUser),
      profileField("Strengths", staff.strengths),
      profileField("Responsibilities", getStaffResponsibilities(staff).join(", ")),
      profileField("Skill Levels", formatSkillLevelsText(getStaffSkillLevels(staff))),
      profileField("Scheduling Preferences", staff.schedulingPreferences),
      profileField("Special Instructions", staff.specialInstructions),
      profileField("Notes", staff.notes),
      "</dl>"
    ].join("");
    openDrawer();
  }

  function openAdminForm(staff) {
    if (!staff) return;
    var account = state.accounts.find(function (item) {
      return item.staffId === staff.staffId;
    }) || {};
    var suggestedUsername = account.username || makeUsername(staff.fullName);
    var needsPassword = !account.username;
    $("#drawerTitle").textContent = "Administrator Access";
    $("#drawerSubtitle").textContent = staff.fullName;
    $("#drawerBody").innerHTML = [
      "<form id=\"adminForm\" class=\"two-column-form\">",
      inputField("username", "Username", suggestedUsername, true),
      "<label class=\"field\"><span>Role</span><select class=\"select\" name=\"role\"><option value=\"Administrator\"" + ((account.role || "Administrator") === "Administrator" ? " selected" : "") + ">Administrator</option><option value=\"Manager\"" + (account.role === "Manager" ? " selected" : "") + ">Manager</option><option value=\"Scheduler\"" + (account.role === "Scheduler" ? " selected" : "") + ">Scheduler</option></select></label>",
      inputField("password", needsPassword ? "Password" : "New Password", "", needsPassword, "password"),
      inputField("confirmPassword", needsPassword ? "Confirm Password" : "Confirm New Password", "", needsPassword, "password"),
      "<p class=\"help-text\" style=\"grid-column:1 / -1\">Create or update this staff member's RosterPro administrator login. Passwords must be at least 8 characters.</p>",
      "<div class=\"form-actions\" style=\"grid-column:1 / -1\">",
      "<button type=\"button\" class=\"ghost-btn\" data-drawer-action=\"cancel\">Cancel</button>",
      "<button type=\"submit\" class=\"primary-btn\">Save Administrator</button>",
      "</div>",
      "</form>"
    ].join("");
    $("#adminForm").addEventListener("submit", function (event) {
      event.preventDefault();
      saveAdminForm(staff.staffId);
    });
    openDrawer();
  }

  function profileField(label, value, raw) {
    var display = value || "-";
    return "<div><dt>" + escapeHtml(label) + "</dt><dd>" + (raw ? display : escapeHtml(display)) + "</dd></div>";
  }

  function phoneLink(value) {
    var display = String(value || "").trim();
    if (!display) return "-";
    var dial = display.replace(/[^\d+]/g, "");
    if (!dial || /will be added/i.test(display)) return escapeHtml(display);
    return "<a href=\"tel:" + escapeAttr(dial) + "\">" + escapeHtml(display) + "</a>";
  }

  function openStaffForm(staff) {
    var isEdit = Boolean(staff);
    var item = staff || {};
    var preferredShift = parsePreferredShiftInputs(item.preferredShiftTime);
    $("#drawerTitle").textContent = isEdit ? "Edit Staff" : "Add Staff";
    $("#drawerSubtitle").textContent = isEdit ? item.fullName : "New staff record";
    $("#drawerBody").innerHTML = [
      "<form id=\"staffForm\" class=\"two-column-form\">",
      inputField("fullName", "Full Name", item.fullName, true),
      inputField("email", "Email", item.email, true, "email"),
      inputField("phoneNumber", "Office Phone Number", item.phoneNumber, false, "tel"),
      inputField("extension", "Extension", item.extension),
      inputField("personalPhoneNumber", "Personal Phone Number", item.personalPhoneNumber, false, "tel"),
      inputField("jobTitle", "Job Title", item.jobTitle, true),
      inputField("department", "Department", item.department),
      selectField("officeLocation", "Office Location", item.officeLocation),
      inputField("primarySpecialty", "Primary Specialty", item.primarySpecialty),
      inputField("timeZone", "Time Zone", item.timeZone || "EST"),
      inputField("verifiedDate", "Verified Date", item.verifiedDate, false, "date"),
      timeField("preferredShiftStart", "Shift Start Preference", preferredShift.start),
      timeField("preferredShiftEnd", "Shift End Preference", preferredShift.end),
      inputField("preferredWorkingDays", "Preferred Working Days", item.preferredWorkingDays),
      inputField("availableLocations", "Available Locations", item.availableLocations),
      inputField("athenaUser", "Athena User", item.athenaUser),
      inputField("employmentStatus", "Employment Status", item.employmentStatus || "Active"),
      "<label class=\"field\" style=\"grid-column:1 / -1\"><span>Notes</span><textarea class=\"textarea\" name=\"notes\">" + escapeHtml(item.notes || "") + "</textarea></label>",
      "<label class=\"field\" style=\"grid-column:1 / -1\"><span>Strengths</span><textarea class=\"textarea\" name=\"strengths\">" + escapeHtml(item.strengths || "") + "</textarea></label>",
      "<label class=\"field\" style=\"grid-column:1 / -1\"><span>Scheduling Preferences</span><textarea class=\"textarea\" name=\"schedulingPreferences\">" + escapeHtml(item.schedulingPreferences || "") + "</textarea></label>",
      "<div class=\"form-actions\" style=\"grid-column:1 / -1\">",
      "<button type=\"button\" class=\"ghost-btn\" data-drawer-action=\"cancel\">Cancel</button>",
      "<button type=\"submit\" class=\"primary-btn\">Save Staff</button>",
      "</div>",
      "</form>"
    ].join("");
    $("#staffForm").addEventListener("submit", function (event) {
      event.preventDefault();
      saveStaffForm(item.staffId);
    });
    openDrawer();
  }

  function inputField(name, label, value, required, type) {
    return "<label class=\"field\"><span>" + escapeHtml(label) + "</span><input class=\"input\" name=\"" + escapeAttr(name) + "\" type=\"" + (type || "text") + "\" value=\"" + escapeAttr(value || "") + "\"" + (required ? " required" : "") + "></label>";
  }

  function timeField(name, label, value) {
    return "<label class=\"field\"><span>" + escapeHtml(label) + "</span><input class=\"input\" name=\"" + escapeAttr(name) + "\" type=\"time\" step=\"900\" value=\"" + escapeAttr(value || "") + "\"></label>";
  }

  function selectField(name, label, value) {
    var options = state.locations.map(function (location) {
      return "<option value=\"" + escapeAttr(location.name) + "\"" + (location.name === value ? " selected" : "") + ">" + escapeHtml(location.name) + "</option>";
    }).join("");
    return "<label class=\"field\"><span>" + escapeHtml(label) + "</span><select class=\"select\" name=\"" + escapeAttr(name) + "\">" + options + "</select></label>";
  }

  function saveStaffForm(staffId) {
    var form = $("#staffForm");
    var record = staffId ? state.staff.find(function (staff) { return staff.staffId === staffId; }) : {};
    var data = new FormData(form);
    var preferredStart = String(data.get("preferredShiftStart") || "").trim();
    var preferredEnd = String(data.get("preferredShiftEnd") || "").trim();
    if ((preferredStart && !preferredEnd) || (!preferredStart && preferredEnd)) {
      showToast("Select both preferred start and end times.");
      return;
    }
    if (preferredStart && preferredEnd && preferredStart === preferredEnd) {
      showToast("Preferred shift start and end cannot match.");
      return;
    }
    Array.from(data.entries()).forEach(function (entry) {
      if (entry[0] === "preferredShiftStart" || entry[0] === "preferredShiftEnd") return;
      record[entry[0]] = entry[1].trim();
    });
    record.preferredShiftTime = preferredStart && preferredEnd
      ? timeInputToText(preferredStart) + " - " + timeInputToText(preferredEnd)
      : "";
    if (!staffId) {
      record.staffId = nextStaffId();
      record.employmentStatus = record.employmentStatus || "Active";
      state.staff.push(record);
    }
    persistStaff();
    closeDrawer();
    renderStaff();
    showToast("Staff saved");
  }

  function makeUsername(fullName) {
    var pieces = String(fullName || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!pieces.length) return "";
    var base = pieces.length === 1 ? pieces[0] : pieces[0].charAt(0) + pieces[pieces.length - 1];
    return base.replace(/[^a-z0-9]/g, "");
  }

  async function saveAdminForm(staffId) {
    var staff = state.staff.find(function (item) {
      return item.staffId === staffId;
    });
    if (!staff) return;
    var existing = state.accounts.find(function (item) {
      return item.staffId === staffId;
    });
    var form = $("#adminForm");
    var data = new FormData(form);
    var username = String(data.get("username") || "").trim().toLowerCase();
    var role = String(data.get("role") || "Administrator").trim() || "Administrator";
    var password = String(data.get("password") || "");
    var confirmPassword = String(data.get("confirmPassword") || "");
    var requiresPassword = !existing || !existing.username;

    if (!username) {
      showToast("Enter a username.");
      return;
    }
    if (requiresPassword || password || confirmPassword) {
      if (password.length < 8) {
        showToast("Password must be at least 8 characters.");
        return;
      }
      if (password !== confirmPassword) {
        showToast("Passwords do not match.");
        return;
      }
    } else {
      password = "";
    }

    state.pendingWrites += 1;
    setSyncStatus("loading", "Saving");
    try {
      var account = await apiCall("saveUserAccount", {
        staffId: staff.staffId,
        username: username,
        password: password,
        role: role
      });
      var index = state.accounts.findIndex(function (item) {
        return item.staffId === account.staffId || String(item.username || "").toLowerCase() === username;
      });
      if (index >= 0) {
        state.accounts[index] = account;
      } else {
        state.accounts.push(account);
      }
      setStored("accounts", state.accounts);
      setSyncStatus("synced", "Saved");
      showToast("Administrator access saved");
      openStaffProfile(staff.staffId);
    } catch (error) {
      setSyncStatus("offline", "Offline");
      showToast("Could not save admin access. " + error.message);
    } finally {
      state.pendingWrites = Math.max(0, state.pendingWrites - 1);
    }
  }

  function nextStaffId() {
    var max = state.staff.reduce(function (highest, staff) {
      var number = Number(String(staff.staffId || "").replace(/\D/g, ""));
      return Math.max(highest, number);
    }, 0);
    return "ST-" + String(max + 1).padStart(3, "0");
  }

  function onDrawerClick(event) {
    var button = event.target.closest("[data-drawer-action]");
    if (!button) return;
    var action = button.dataset.drawerAction;
    if (action === "cancel") closeDrawer();
    if (action === "edit") {
      var staff = state.staff.find(function (item) {
        return item.staffId === button.dataset.staffId;
      });
      openStaffForm(staff);
    }
    if (action === "admin") {
      var adminStaff = state.staff.find(function (item) {
        return item.staffId === button.dataset.staffId;
      });
      openAdminForm(adminStaff);
    }
    if (action === "delete") {
      deleteStaff(button.dataset.staffId);
    }
  }

  function deleteStaff(staffId) {
    var staff = state.staff.find(function (item) {
      return item.staffId === staffId;
    });
    if (!staff) return;
    var confirmed = window.confirm("Delete " + staff.fullName + "?");
    if (!confirmed) return;
    state.staff = state.staff.filter(function (item) {
      return item.staffId !== staffId;
    });
    persistStaff();
    closeDrawer();
    renderStaff();
    showToast("Staff deleted");
  }

  function openDrawer() {
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    $("#drawer").classList.remove("open");
    $("#drawer").setAttribute("aria-hidden", "true");
  }

  function renderSchedule() {
    $("#scheduleLocation").value = state.location;
    $("#scheduleMonth").value = state.month;
    ensureSchedule(state.month, state.location);
    $("#scheduleCalendar").innerHTML = buildCalendarHtml(state.month, state.location, true);
    var dateTitle = state.selectedDate ? longDateTitle(state.selectedDate) : "Select a date";
    $("#selectedDateTitle").textContent = dateTitle;
    var dayEntries = state.selectedDate ? ensureSchedule(state.month, state.location).days[state.selectedDate] || [] : [];
    $("#dayAssignments").value = dayEntries.join("\n");
    $("#saveDayBtn").disabled = !state.selectedDate;
    $("#copyPreviousWeekBtn").disabled = !state.selectedDate;
    renderScheduleGuidance();
  }

  function ensureSchedule(monthKey, locationName) {
    state.schedules[monthKey] = state.schedules[monthKey] || {};
    state.schedules[monthKey][locationName] = state.schedules[monthKey][locationName] || {
      location: locationName,
      month: monthKey,
      footerNote: (state.locations.find(function (location) { return location.name === locationName; }) || {}).printNote || "",
      days: {}
    };
    return state.schedules[monthKey][locationName];
  }

  function buildCalendarHtml(monthKey, locationName, interactive) {
    var schedule = ensureSchedule(monthKey, locationName);
    var templateClass = locationName === "Tampa" ? "tampa-template" : "zephyrhills-template";
    var isTampa = locationName === "Tampa";
    var strong = isTampa ? " strong-lines" : "";
    var dates = calendarDates(monthKey);
    var supportLogo = state.brand.assets && state.brand.assets.partnerLogo
      ? "<img src=\"" + escapeAttr(state.brand.assets.partnerLogo) + "\" alt=\"" + escapeAttr(state.brand.poweredBy || "Help360 MD") + "\">"
      : "";
    var parts = [
      "<section class=\"print-calendar " + templateClass + "\">",
      "<div class=\"print-calendar-header\"><div class=\"print-location\">" + escapeHtml(locationName) + "</div><div class=\"print-month\">" + escapeHtml(monthTitle(monthKey)) + "</div></div>",
      "<div class=\"month-grid" + strong + "\">",
      weekdays.map(function (weekday) {
        return "<div class=\"weekday-cell\">" + weekday + "</div>";
      }).join("")
    ];

    dates.forEach(function (date, index) {
      var key = toDateKey(date);
      var inMonth = key.slice(0, 7) === monthKey;
      var entries = schedule.days[key] || [];
      var weekIndex = Math.floor(index / 7);
      var classes = ["day-cell"];
      if (!inMonth) classes.push("outside-month");
      if (!isTampa && weekIndex % 2 === 1) classes.push("alt-band");
      if (isTampa && (date.getDay() === 0 || date.getDay() === 6)) classes.push("weekend-day");
      if (getHolidayName(key)) classes.push("holiday-day");
      if (interactive) classes.push("clickable-day");
      if (state.selectedDate === key) classes.push("selected");
      parts.push("<div class=\"" + classes.join(" ") + "\"" + (interactive ? " data-date=\"" + key + "\"" : "") + ">");
      parts.push("<div class=\"day-cell-head\"><span class=\"day-number\">" + date.getDate() + "</span></div>");
      parts.push("<div class=\"day-list\">" + entries.map(function (entry) {
        return "<span>" + escapeHtml(entry) + "</span>";
      }).join("") + "</div>");
      parts.push("</div>");
    });

    parts.push("</div>");
    parts.push("<div class=\"print-bottom-row\"><div class=\"print-support\">" + supportLogo + "<span>For help call: " + escapeHtml(state.brand.supportPhone || "(321) 999-9553") + "</span></div><div class=\"print-footer-note\">" + escapeHtml(schedule.footerNote || "") + "</div></div>");
    parts.push("</section>");
    return parts.join("");
  }

  function assignmentRosterHtml(entry, dateKey, locationName, staffLookup) {
    var staff = (staffLookup || {})[cleanScheduleName(entry).toLowerCase()] || {};
    var shift = deriveShiftTimes(entry, dateKey, locationName, staff);
    return "<span class=\"staff-chip\"><strong>" + escapeHtml(cleanScheduleName(entry) || entry) + "</strong><em>" + escapeHtml(shift.startTime + " - " + shift.endTime) + "</em></span>";
  }

  function getHolidayName(dateKey) {
    var date = parseDateKey(dateKey);
    var monthDay = dateKey.slice(5);
    if (monthDay === "01-01") return "New Year";
    if (monthDay === "06-19") return "Juneteenth";
    if (monthDay === "07-04") return "Independence Day";
    if (monthDay === "12-25") return "Christmas";
    if (date.getMonth() === 10 && date.getDay() === 4 && Math.ceil(date.getDate() / 7) === 4) return "Thanksgiving";
    return "";
  }

  function renderScheduleGuidance() {
    var staffSelect = $("#scheduleStaffSelect");
    var insight = $("#selectedStaffInsight");
    var recommendationList = $("#staffRecommendations");
    var addButton = $("#addScheduleStaffBtn");
    if (!staffSelect || !insight || !recommendationList || !addButton) return;

    var activeStaff = state.staff.filter(function (staff) {
      return String(staff.employmentStatus || "Active").toLowerCase() === "active";
    }).sort(function (a, b) {
      return a.fullName.localeCompare(b.fullName);
    });
    staffSelect.innerHTML = "<option value=\"\">Select staff</option>" + activeStaff.map(function (staff) {
      return "<option value=\"" + escapeAttr(staff.staffId) + "\">" + escapeHtml(staff.fullName) + "</option>";
    }).join("");
    staffSelect.value = state.selectedScheduleStaffId || "";
    addButton.disabled = !state.selectedDate || !state.selectedScheduleStaffId;

    var selected = findStaffById(state.selectedScheduleStaffId);
    if (selected) {
      insight.hidden = false;
      insight.innerHTML = buildStaffInsightHtml(selected, state.selectedDate || state.month + "-01", state.scheduleDuty);
    } else {
      insight.hidden = true;
      insight.innerHTML = "";
    }

    if (!state.selectedDate) {
      recommendationList.innerHTML = "<p class=\"help-text\">Select a date first.</p>";
      return;
    }

    var recommendations = recommendStaffForShift(state.selectedDate, state.scheduleDuty).slice(0, 6);
    recommendationList.innerHTML = recommendations.length ? recommendations.map(function (item) {
      return [
        "<button class=\"recommendation-card\" type=\"button\" data-recommend-staff=\"" + escapeAttr(item.staff.staffId) + "\">",
        "<span class=\"recommendation-head\"><strong>" + escapeHtml(item.staff.fullName) + "</strong><span class=\"pill " + statusPillClass(item.status) + "\">" + escapeHtml(item.status) + "</span></span>",
        "<span class=\"help-text\">" + escapeHtml(item.reason) + "</span>",
        "<span class=\"recommendation-meta\">",
        "<span class=\"pill\">" + item.score + " match</span>",
        "<span class=\"pill\">" + formatHours(item.weeklyHours) + " weekly hrs</span>",
        "<span class=\"pill\">" + escapeHtml(item.staff.officeLocation || "-") + "</span>",
        "</span>",
        "</button>"
      ].join("");
    }).join("") : "<p class=\"help-text\">No active staff match this filter.</p>";
  }

  function addSelectedStaffToDay(staffId) {
    if (!state.selectedDate) {
      showToast("Select a schedule date first.");
      return;
    }
    var staff = findStaffById(staffId);
    if (!staff) {
      showToast("Select a staff member first.");
      return;
    }
    var textarea = $("#dayAssignments");
    var lines = textarea.value.split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
    var cleanStaffName = cleanScheduleName(staff.fullName).toLowerCase();
    var alreadyAssigned = lines.some(function (line) {
      return cleanScheduleName(line).toLowerCase() === cleanStaffName;
    });
    if (alreadyAssigned) {
      showToast(staff.fullName + " is already listed for this date.");
      return;
    }
    var shift = deriveShiftTimes(staff.fullName, state.selectedDate, state.location, staff);
    lines.push(staff.fullName + " (" + shift.startTime + "-" + shift.endTime + ")");
    textarea.value = lines.join("\n");
    renderScheduleGuidance();
  }

  function buildStaffInsightHtml(staff, dateKey, duty) {
    var shift = deriveShiftTimes(staff.fullName, dateKey, state.location, staff);
    var weekHours = weeklyHoursForStaff(staff, dateKey, state.schedules);
    var strengths = getStaffStrengths(staff);
    var responsibilities = getStaffResponsibilities(staff);
    var skillLevels = getStaffSkillLevels(staff);
    return [
      "<div class=\"staff-insight-head\">",
      "<div><strong>" + escapeHtml(staff.fullName) + "</strong><span class=\"help-text\">" + escapeHtml(staff.jobTitle || "-") + " - " + escapeHtml(staff.officeLocation || "-") + "</span></div>",
      "<span class=\"pill " + statusPillClass(hoursStatus(weekHours)) + "\">" + formatHours(weekHours) + " weekly hrs</span>",
      "</div>",
      "<div class=\"qualification-grid\">",
      qualificationList("Strengths", strengths),
      qualificationList("Responsibilities", responsibilities),
      skillLevelList(skillLevels),
      "<div><strong>Preferred Shift</strong><div class=\"help-text\">" + escapeHtml(shift.startTime + " - " + shift.endTime) + "</div></div>",
      "<div><strong>Duty Match</strong><div class=\"help-text\">" + escapeHtml(duty) + " - " + escapeHtml(staffMatchesDuty(staff, duty) ? "Qualified" : "Review") + "</div></div>",
      "</div>"
    ].join("");
  }

  function qualificationList(label, items) {
    var safeItems = (items || []).length ? items : ["Not listed"];
    return "<div><strong>" + escapeHtml(label) + "</strong><ul>" + safeItems.map(function (item) {
      return "<li>" + escapeHtml(item) + "</li>";
    }).join("") + "</ul></div>";
  }

  function skillLevelList(items) {
    var safeItems = (items || []).length ? items : [{ skill: "General Scheduling", level: "Review" }];
    return "<div><strong>Skill Level</strong><ul>" + safeItems.map(function (item) {
      return "<li>" + escapeHtml(item.skill) + " - " + escapeHtml(item.level) + "</li>";
    }).join("") + "</ul></div>";
  }

  function recommendStaffForShift(dateKey, duty) {
    return state.staff.filter(function (staff) {
      return String(staff.employmentStatus || "Active").toLowerCase() === "active";
    }).map(function (staff) {
      var weeklyHours = weeklyHoursForStaff(staff, dateKey, state.schedules);
      var match = scoreStaffForShift(staff, dateKey, duty, weeklyHours);
      return {
        staff: staff,
        score: match.score,
        reason: match.reason,
        weeklyHours: weeklyHours,
        status: hoursStatus(weeklyHours)
      };
    }).sort(function (a, b) {
      return b.score - a.score || a.weeklyHours - b.weeklyHours || a.staff.fullName.localeCompare(b.staff.fullName);
    });
  }

  function scoreStaffForShift(staff, dateKey, duty, weeklyHours) {
    var score = 0;
    var reasons = [];
    if (staffMatchesDuty(staff, duty)) {
      score += 42;
      reasons.push(duty);
    }
    if (staffLocationMatches(staff, state.location)) {
      score += 18;
      reasons.push("location");
    }
    if (staffAvailableOnDate(staff, dateKey)) {
      score += 14;
      reasons.push("availability");
    }
    if (preferredShiftFits(staff, state.location, dateKey)) {
      score += 10;
      reasons.push("preferred shift");
    }
    if (weeklyHours <= 35) {
      score += 12;
      reasons.push("hours capacity");
    } else if (weeklyHours <= OVERTIME_LIMIT) {
      score += 2;
      reasons.push("near limit");
    } else {
      score -= 30;
      reasons.push("overtime");
    }
    if (isStaffAssignedOnDate(staff, dateKey)) {
      score -= 20;
      reasons.push("already assigned");
    }
    return {
      score: Math.max(0, Math.round(score)),
      reason: reasons.length ? reasons.join(", ") : "general coverage"
    };
  }

  async function saveSelectedDay() {
    if (!state.selectedDate) return;
    var entries = $("#dayAssignments").value.split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
    var warnings = buildOvertimeWarnings(state.selectedDate, entries);
    if (warnings.length) {
      var proceed = window.confirm(warnings.join("\n") + "\n\nAdministrators may proceed, but this schedule will be flagged. Save anyway?");
      if (!proceed) return;
    }
    state.pendingScheduleRefresh = false;
    await persistScheduleDay(state.selectedDate, state.location, entries);
  }

  async function copyPreviousWeek() {
    if (!state.selectedDate) return;
    var schedule = ensureSchedule(state.month, state.location);
    var previous = toDateKey(addDays(parseDateKey(state.selectedDate), -7));
    var entries = clone(schedule.days[previous] || []);
    var warnings = buildOvertimeWarnings(state.selectedDate, entries);
    if (warnings.length) {
      var proceed = window.confirm(warnings.join("\n") + "\n\nAdministrators may proceed, but this duplicated schedule will be flagged. Save anyway?");
      if (!proceed) return;
    }
    state.pendingScheduleRefresh = false;
    await persistScheduleDay(state.selectedDate, state.location, entries, "Copied previous week");
  }

  function renderLocations() {
    $("#locationsGrid").innerHTML = state.locations.map(function (location) {
      var count = state.staff.filter(function (staff) {
        return staff.officeLocation === location.name;
      }).length;
      return [
        "<article class=\"location-card\">",
        "<h3>" + escapeHtml(location.name) + "</h3>",
        "<p class=\"help-text\">" + escapeHtml(location.manager || "No manager listed") + "</p>",
        "<p><a href=\"tel:" + escapeAttr((location.phoneNumber || "").replace(/[^\d+]/g, "")) + "\">" + escapeHtml(location.phoneNumber || "") + "</a></p>",
        "<span class=\"pill teal\">" + count + " staff</span>",
        "<p class=\"help-text\">" + escapeHtml(location.printNote || "") + "</p>",
        "</article>"
      ].join("");
    }).join("");
  }

  function renderReports() {
    var byLocation = state.locations.map(function (location) {
      return {
        label: location.name,
        value: state.staff.filter(function (staff) { return staff.officeLocation === location.name; }).length
      };
    });
    var byDepartment = groupCount(state.staff, "department");
    $("#locationReport").innerHTML = reportBars(byLocation);
    $("#departmentReport").innerHTML = reportBars(byDepartment);
    $("#coverageReport").innerHTML = reportBars(Object.keys(ensureSchedule(state.month, state.location).days).map(function (date) {
      return { label: date, value: ensureSchedule(state.month, state.location).days[date].length };
    }).slice(0, 12));
    var currentWeek = weekRange(new Date());
    var currentMonth = monthRange(state.month);
    var weeklySummary = summarizeHours(filterHoursHistory(state.hoursHistory, { startDate: currentWeek.start, endDate: currentWeek.end })).sort(hoursSorter("weeklyDesc"));
    var monthlyRows = filterHoursHistory(state.hoursHistory, { startDate: currentMonth.start, endDate: currentMonth.end });
    $("#weeklyHoursReport").innerHTML = reportBars(weeklySummary.slice(0, 10).map(function (item) {
      return { label: item.staffName, value: item.weeklyHours };
    }));
    $("#overtimeReport").innerHTML = reportBars(weeklySummary.filter(function (item) {
      return item.overtimeHours > 0 || item.weeklyHours >= OVERTIME_LIMIT;
    }).map(function (item) {
      return { label: item.staffName, value: item.overtimeHours || item.weeklyHours };
    }));
    $("#hoursByLocationReport").innerHTML = reportBars(groupHours(monthlyRows, "location"));
    $("#hoursByDepartmentReport").innerHTML = reportBars(groupHours(monthlyRows, "department"));
  }

  function renderHours() {
    $("#hoursStartDate").value = state.hoursStartDate;
    $("#hoursEndDate").value = state.hoursEndDate;
    $("#hoursStatusFilter").value = state.hoursStatusFilter;
    $("#hoursSort").value = state.hoursSort;
    maybeRefreshHoursRange();
    var rows = state.hoursRangeRows.length ? state.hoursRangeRows : filterHoursHistory(state.hoursHistory, {
      startDate: state.hoursStartDate,
      endDate: state.hoursEndDate
    });
    var summary = summarizeHours(rows).filter(function (item) {
      var matchesSearch = !state.hoursFilter || (item.staffName + " " + item.department + " " + item.location).toLowerCase().indexOf(state.hoursFilter) !== -1;
      var matchesStatus = state.hoursStatusFilter === "All" || item.status === state.hoursStatusFilter;
      return matchesSearch && matchesStatus;
    });
    summary.sort(hoursSorter(state.hoursSort));
    var totals = totalHours(summary);

    $("#hoursRegularTotal").textContent = formatHours(totals.regular);
    $("#hoursOvertimeTotal").textContent = formatHours(totals.overtime);
    $("#hoursScheduledTotal").textContent = formatHours(totals.total);
    $("#hoursStaffCount").textContent = summary.length;

    $("#hoursTableBody").innerHTML = summary.map(function (item) {
      return [
        "<tr>",
        "<td><strong>" + escapeHtml(item.staffName) + "</strong><div class=\"help-text\">" + escapeHtml(item.department || "-") + "</div></td>",
        "<td>" + formatHours(item.weeklyHours) + "</td>",
        "<td>" + formatHours(item.monthlyHours) + "</td>",
        "<td>" + formatHours(item.overtimeHours) + "</td>",
        "<td>" + formatHours(item.totalScheduledHours) + "</td>",
        "<td><span class=\"status-dot " + statusClass(item.status) + "\"></span><span class=\"pill " + statusPillClass(item.status) + "\">" + escapeHtml(item.status) + "</span></td>",
        "</tr>"
      ].join("");
    }).join("");

    var historyRows = rows.filter(function (row) {
      return !state.hoursFilter || (row.staffName + " " + row.department + " " + row.location).toLowerCase().indexOf(state.hoursFilter) !== -1;
    }).sort(function (a, b) {
      return b.shiftDate.localeCompare(a.shiftDate) || a.staffName.localeCompare(b.staffName);
    });
    $("#hoursHistoryBody").innerHTML = historyRows.slice(0, 250).map(function (row) {
      return [
        "<tr>",
        "<td>" + escapeHtml(row.shiftDate) + "</td>",
        "<td>" + escapeHtml(row.staffName) + "</td>",
        "<td>" + escapeHtml(row.startTime || "-") + " - " + escapeHtml(row.endTime || "-") + "</td>",
        "<td>" + formatHours(row.hoursWorked) + "</td>",
        "<td>" + formatHours(row.regularHours) + "</td>",
        "<td>" + formatHours(row.overtimeHours) + "</td>",
        "<td>" + escapeHtml(row.location || "-") + "</td>",
        "</tr>"
      ].join("");
    }).join("");
    $("#hoursHistoryCount").textContent = historyRows.length + " history rows" + (state.hoursLoading ? " - loading" : "");
  }

  function maybeRefreshHoursRange() {
    var rangeKey = state.hoursStartDate + "|" + state.hoursEndDate;
    if (state.hoursLoading || state.hoursLoadedRange === rangeKey) return;
    state.hoursLoading = true;
    apiCall("getHoursHistory", {
      startDate: state.hoursStartDate,
      endDate: state.hoursEndDate
    }).then(function (rows) {
      if (Array.isArray(rows)) {
        state.hoursRangeRows = rows;
      }
      state.hoursLoadedRange = rangeKey;
    }).catch(function () {
      state.hoursRangeRows = filterHoursHistory(state.hoursHistory, {
        startDate: state.hoursStartDate,
        endDate: state.hoursEndDate
      });
      state.hoursLoadedRange = rangeKey;
    }).finally(function () {
      state.hoursLoading = false;
      if (state.view === "hours") renderHours();
    });
  }

  function renderSettings() {
    $("#settingsClinicName").textContent = state.brand.clinicName;
    $("#settingsPoweredBy").textContent = state.brand.poweredBy;
    $("#settingsPhone").textContent = state.brand.supportPhone;
    $("#settingsStaffCount").textContent = state.staff.length;
    $("#settingsScheduleCount").textContent = Object.keys(state.schedules).length;
  }

  function reportBars(items) {
    var max = Math.max.apply(null, items.map(function (item) { return item.value; }).concat([1]));
    return items.map(function (item) {
      var width = Math.max(4, Math.round(item.value / max * 100));
      return "<div class=\"mini-row\"><span>" + escapeHtml(item.label) + "</span><span class=\"pill\">" + item.value + "</span></div><div style=\"height:8px;background:var(--panel-soft);border-radius:8px;margin:0 0 8px\"><div style=\"height:8px;width:" + width + "%;background:var(--teal);border-radius:8px\"></div></div>";
    }).join("");
  }

  function groupCount(items, key) {
    var map = {};
    items.forEach(function (item) {
      var label = item[key] || "Unassigned";
      map[label] = (map[label] || 0) + 1;
    });
    return Object.keys(map).sort().map(function (label) {
      return { label: label, value: map[label] };
    });
  }

  function groupHours(items, key) {
    var map = {};
    items.forEach(function (item) {
      var label = item[key] || "Unassigned";
      map[label] = (map[label] || 0) + Number(item.hoursWorked || 0);
    });
    return Object.keys(map).sort().map(function (label) {
      return { label: label, value: roundHours(map[label]) };
    });
  }

  function buildHoursHistory(schedules, staffRecords) {
    var staffLookup = buildStaffLookup(staffRecords);
    var entries = [];
    Object.keys(schedules || {}).forEach(function (monthKey) {
      Object.keys(schedules[monthKey] || {}).forEach(function (locationName) {
        var schedule = schedules[monthKey][locationName];
        Object.keys(schedule.days || {}).forEach(function (dateKey) {
          (schedule.days[dateKey] || []).forEach(function (assignment) {
            var staff = staffLookup[cleanScheduleName(assignment).toLowerCase()] || {};
            var shift = deriveShiftTimes(assignment, dateKey, locationName, staff);
            entries.push({
              staffId: staff.staffId || "",
              staffName: assignment,
              cleanName: cleanScheduleName(assignment),
              shiftDate: dateKey,
              startTime: shift.startTime,
              endTime: shift.endTime,
              hoursWorked: calculateHours(shift.startTime, shift.endTime),
              location: locationName,
              department: staff.department || "",
              weekKey: getWeekYear(dateKey) + "-W" + getWeekNumber(dateKey)
            });
          });
        });
      });
    });
    entries.sort(function (a, b) {
      return (a.staffId || a.cleanName).localeCompare(b.staffId || b.cleanName) || a.shiftDate.localeCompare(b.shiftDate);
    });
    var weeklyTotals = {};
    return entries.map(function (entry) {
      var key = (entry.staffId || entry.cleanName.toLowerCase()) + "|" + entry.weekKey;
      var used = weeklyTotals[key] || 0;
      var regular = Math.min(entry.hoursWorked, Math.max(0, OVERTIME_LIMIT - used));
      var overtime = Math.max(0, entry.hoursWorked - regular);
      weeklyTotals[key] = used + entry.hoursWorked;
      var date = parseDateKey(entry.shiftDate);
      return {
        historyId: entry.staffId + "-" + entry.shiftDate + "-" + entry.cleanName,
        staffId: entry.staffId,
        staffName: entry.cleanName,
        date: entry.shiftDate,
        weekNumber: getWeekNumber(entry.shiftDate),
        month: date.getMonth() + 1,
        year: date.getFullYear(),
        shiftDate: entry.shiftDate,
        startTime: entry.startTime,
        endTime: entry.endTime,
        hoursWorked: roundHours(entry.hoursWorked),
        regularHours: roundHours(regular),
        overtimeHours: roundHours(overtime),
        location: entry.location,
        department: entry.department,
        createdAt: new Date().toISOString()
      };
    });
  }

  function summarizeHours(rows) {
    var summary = {};
    rows.forEach(function (row) {
      var key = row.staffId || row.staffName.toLowerCase();
      summary[key] = summary[key] || {
        staffId: row.staffId,
        staffName: row.staffName,
        weeklyHours: 0,
        monthlyHours: 0,
        yearlyHours: 0,
        totalScheduledHours: 0,
        regularHours: 0,
        overtimeHours: 0,
        location: row.location,
        department: row.department,
        status: "Green"
      };
      summary[key].weeklyHours += Number(row.hoursWorked || 0);
      summary[key].monthlyHours += Number(row.hoursWorked || 0);
      summary[key].yearlyHours += Number(row.hoursWorked || 0);
      summary[key].totalScheduledHours += Number(row.hoursWorked || 0);
      summary[key].regularHours += Number(row.regularHours || 0);
      summary[key].overtimeHours += Number(row.overtimeHours || 0);
    });
    return Object.keys(summary).map(function (key) {
      var item = summary[key];
      item.weeklyHours = roundHours(item.weeklyHours);
      item.monthlyHours = roundHours(item.monthlyHours);
      item.yearlyHours = roundHours(item.yearlyHours);
      item.totalScheduledHours = roundHours(item.totalScheduledHours);
      item.regularHours = roundHours(item.regularHours);
      item.overtimeHours = roundHours(item.overtimeHours);
      item.status = hoursStatus(item.weeklyHours);
      return item;
    });
  }

  function filterHoursHistory(rows, filters) {
    filters = filters || {};
    var start = filters.startDate ? parseDateKey(filters.startDate) : null;
    var end = filters.endDate ? parseDateKey(filters.endDate) : null;
    return (rows || []).filter(function (row) {
      var date = parseDateKey(row.shiftDate);
      if (start && date < start) return false;
      if (end && date > end) return false;
      return true;
    });
  }

  function buildStaffLookup(staffRecords) {
    var lookup = {};
    (staffRecords || []).forEach(function (staff) {
      var full = cleanScheduleName(staff.fullName || "").toLowerCase();
      var first = full.split(/\s+/)[0];
      lookup[full] = staff;
      lookup[first] = lookup[first] || staff;
      if (staff.staffId) lookup[String(staff.staffId).toLowerCase()] = staff;
    });
    lookup["dr. rahman"] = lookup["farhana rahman"] || lookup["farhana"];
    lookup["gabi"] = lookup["gabriel renato"] || lookup["gabriel"];
    lookup["gabriel"] = lookup["gabriel renato"] || lookup["gabriel"];
    lookup["rajeshwary"] = lookup["rajeshwari borkar"] || lookup["rajeshwari"];
    lookup["camilla"] = lookup["camila mccalen"] || lookup["camila"];
    lookup["camila"] = lookup["camila mccalen"] || lookup["camila"];
    lookup["lillian"] = lookup["lilian adams"] || lookup["lilian"];
    return lookup;
  }

  function findStaffById(staffId) {
    return state.staff.find(function (staff) {
      return String(staff.staffId || "") === String(staffId || "");
    });
  }

  function getStaffStrengths(staff) {
    var items = splitQualificationText(staff.strengths);
    if (isFarhanaRahman(staff)) {
      items = items.concat(["Front Desk", "Insurance Verification", "Referrals", "Appointment Scheduling", "Phone Management"]);
    }
    if (/scribe/i.test(staff.jobTitle + " " + staff.department + " " + staff.notes)) items.push("Scribe");
    if (/billing/i.test(staff.jobTitle + " " + staff.department + " " + staff.strengths)) items.push("Billing");
    if (/coding/i.test(staff.jobTitle + " " + staff.department + " " + staff.strengths)) items.push("Coding");
    if (/front desk|office/i.test(staff.jobTitle + " " + staff.department + " " + staff.strengths)) items.push("Front Desk");
    if (/provider|physician|nurse/i.test(staff.jobTitle + " " + staff.department)) items.push("Clinical Support");
    return uniqueText(items);
  }

  function getStaffResponsibilities(staff) {
    var items = splitQualificationText(staff.responsibilities)
      .concat(splitQualificationText(staff.schedulingPreferences))
      .concat(getStaffStrengths(staff));
    if (isFarhanaRahman(staff)) {
      items = items.concat(["Front Desk", "Insurance Verification", "Referrals", "Appointment Scheduling", "Phone Management"]);
    }
    if (/provider|physician/i.test(staff.jobTitle + " " + staff.department)) items.push("Provider Coverage");
    if (/billing/i.test(staff.department + " " + staff.jobTitle)) items.push("Billing");
    if (/remote/i.test(staff.officeLocation + " " + staff.notes)) items.push("Remote Coverage");
    return uniqueText(items).slice(0, 8);
  }

  function getStaffSkillLevels(staff) {
    var levels = [];
    if (Array.isArray(staff.skillLevels)) {
      levels = levels.concat(staff.skillLevels);
    } else if (staff.skillLevels && typeof staff.skillLevels === "object") {
      Object.keys(staff.skillLevels).forEach(function (skill) {
        levels.push({ skill: skill, level: staff.skillLevels[skill] });
      });
    }
    levels = levels.concat(parseSkillLevels(staff.specialInstructions));
    if (isFarhanaRahman(staff)) {
      levels = levels.concat([
        { skill: "Insurance Verification", level: "Expert" },
        { skill: "Referrals", level: "Advanced" },
        { skill: "Scheduling", level: "Expert" }
      ]);
    }
    if (!levels.length) {
      getStaffStrengths(staff).slice(0, 4).forEach(function (strength) {
        levels.push({ skill: strength, level: "Advanced" });
      });
    }
    return uniqueSkillLevels(levels).slice(0, 8);
  }

  function splitQualificationText(value) {
    return String(value || "")
      .replace(/Skill Level:/gi, "")
      .split(/[,;|/\n\r]+/)
      .map(function (item) { return item.trim(); })
      .filter(Boolean);
  }

  function parseSkillLevels(value) {
    var levels = [];
    splitQualificationText(value).forEach(function (item) {
      var match = item.match(/^(.+?)\s*(?:->|-|:)\s*(Expert|Advanced|Intermediate|Basic|Review)$/i);
      if (match) {
        levels.push({ skill: match[1].trim(), level: titleCase(match[2]) });
      }
    });
    return levels;
  }

  function uniqueText(items) {
    var seen = {};
    return (items || []).map(function (item) {
      return String(item || "").trim();
    }).filter(function (item) {
      var key = item.toLowerCase();
      if (!item || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function uniqueSkillLevels(items) {
    var seen = {};
    return (items || []).filter(function (item) {
      var key = String(item.skill || "").toLowerCase();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function formatSkillLevelsText(items) {
    return (items || []).map(function (item) {
      return item.skill + " - " + item.level;
    }).join(", ");
  }

  function isFarhanaRahman(staff) {
    return cleanScheduleName(staff.fullName || "").toLowerCase() === "farhana rahman";
  }

  function staffMatchesDuty(staff, duty) {
    var key = normalizeDuty(duty);
    var haystack = getStaffStrengths(staff).concat(getStaffResponsibilities(staff)).concat(getStaffSkillLevels(staff).map(function (item) {
      return item.skill;
    })).join(" ").toLowerCase();
    return normalizeDuty(haystack).indexOf(key) !== -1 || key.indexOf("scheduling") !== -1 && haystack.indexOf("appointment") !== -1;
  }

  function normalizeDuty(value) {
    return String(value || "").toLowerCase().replace(/appointment/g, "scheduling").replace(/[^a-z0-9]+/g, " ").trim();
  }

  function staffLocationMatches(staff, locationName) {
    var locations = String(staff.availableLocations || staff.officeLocation || "").toLowerCase();
    return locations.indexOf(String(locationName || "").toLowerCase()) !== -1 || locations.indexOf("all") !== -1 || String(staff.officeLocation || "").toLowerCase() === String(locationName || "").toLowerCase();
  }

  function staffAvailableOnDate(staff, dateKey) {
    var preferred = String(staff.preferredWorkingDays || "").toLowerCase();
    if (!preferred || /not listed/.test(preferred)) return true;
    var date = parseDateKey(dateKey);
    var weekday = weekdays[(date.getDay() + 6) % 7].toLowerCase();
    return preferred.indexOf(weekday) !== -1 || preferred.indexOf(state.month.toLowerCase()) !== -1 || preferred.indexOf(String(date.getDate())) !== -1;
  }

  function preferredShiftFits(staff, locationName, dateKey) {
    var preferred = parseTimeRange(staff.preferredShiftTime || "");
    if (!preferred) return true;
    var defaultShift = deriveShiftTimes("", dateKey, locationName, {});
    return calculateHours(preferred.startTime, preferred.endTime) >= Math.min(6, calculateHours(defaultShift.startTime, defaultShift.endTime));
  }

  function weeklyHoursForStaff(staff, dateKey, schedules) {
    var range = weekRange(parseDateKey(dateKey));
    var history = buildHoursHistory(schedules || state.schedules, state.staff);
    var cleanName = cleanScheduleName(staff.fullName || "").toLowerCase();
    return filterHoursHistory(history, range).reduce(function (total, row) {
      var sameId = staff.staffId && row.staffId === staff.staffId;
      var sameName = cleanScheduleName(row.staffName).toLowerCase() === cleanName;
      return sameId || sameName ? total + Number(row.hoursWorked || 0) : total;
    }, 0);
  }

  function isStaffAssignedOnDate(staff, dateKey) {
    var schedule = ensureSchedule(state.month, state.location);
    var entries = schedule.days[dateKey] || [];
    var cleanName = cleanScheduleName(staff.fullName || "").toLowerCase();
    return entries.some(function (entry) {
      return cleanScheduleName(entry).toLowerCase() === cleanName;
    });
  }

  function deriveShiftTimes(assignment, dateKey, locationName, staff) {
    var explicit = parseTimeRange(assignment);
    if (explicit) return explicit;
    var staffRange = parseTimeRange(staff.preferredShiftTime || "");
    if (staffRange) return staffRange;
    var day = parseDateKey(dateKey).getDay();
    if (locationName === "Zephyrhills") {
      if (day === 6) return { startTime: "7:30 AM", endTime: "2:00 PM" };
      return { startTime: "7:30 AM", endTime: "6:00 PM" };
    }
    if (locationName === "Remote") return { startTime: "8:00 AM", endTime: "5:00 PM" };
    return { startTime: "8:00 AM", endTime: "5:00 PM" };
  }

  function parseTimeRange(text) {
    var match = String(text || "").match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return null;
    var startMeridiem = match[3] || (Number(match[1]) > 12 ? "" : "AM");
    var endMeridiem = match[6] || (Number(match[4]) > 12 ? "" : "PM");
    return {
      startTime: formatTimeText(match[1], match[2], startMeridiem),
      endTime: formatTimeText(match[4], match[5], endMeridiem)
    };
  }

  function formatTimeText(hour, minute, meridiem) {
    var total = Number(hour) * 60 + Number(minute || 0);
    if (!meridiem) return minutesToTimeText(total);
    return minutesToTimeText(normalizeTimeMinutes(Number(hour), Number(minute || 0), meridiem));
  }

  function parsePreferredShiftInputs(value) {
    var range = parseTimeRange(value || "");
    return {
      start: range ? timeTextToInput(range.startTime) : "08:00",
      end: range ? timeTextToInput(range.endTime) : "17:00"
    };
  }

  function timeInputToText(value) {
    var parts = String(value || "").split(":").map(Number);
    return minutesToTimeText((parts[0] || 0) * 60 + (parts[1] || 0));
  }

  function timeTextToInput(value) {
    var minutes = parseTimeMinutes(value);
    if (minutes === null) return "";
    minutes %= 24 * 60;
    return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  }

  function minutesToTimeText(totalMinutes) {
    var minutesInDay = 24 * 60;
    var normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
    var hour24 = Math.floor(normalized / 60);
    var minute = normalized % 60;
    var meridiem = hour24 >= 12 ? "PM" : "AM";
    var hour12 = hour24 % 12 || 12;
    return hour12 + ":" + String(minute).padStart(2, "0") + " " + meridiem;
  }

  function normalizeTimeMinutes(hour, minute, meridiem) {
    var value = hour;
    var label = String(meridiem || "").toUpperCase();
    if (label === "PM" && value !== 12) value += 12;
    if (label === "AM" && value === 12) value = 0;
    return value * 60 + minute;
  }

  function calculateHours(startTime, endTime) {
    var start = parseTimeMinutes(startTime);
    var end = parseTimeMinutes(endTime);
    if (start === null || end === null) return 0;
    if (end <= start) end += 24 * 60;
    return (end - start) / 60;
  }

  function parseTimeMinutes(value) {
    var match = String(value || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return null;
    var hour = Number(match[1]);
    var minute = Number(match[2] || 0);
    var meridiem = match[3] ? match[3].toUpperCase() : "";
    if (!meridiem) {
      if (hour > 23 || minute > 59) return null;
      return hour * 60 + minute;
    }
    return normalizeTimeMinutes(hour, minute, meridiem);
  }

  function buildOvertimeWarnings(dateKey, entries) {
    var draft = clone(state.schedules);
    draft[state.month] = draft[state.month] || {};
    draft[state.month][state.location] = clone(ensureSchedule(state.month, state.location));
    draft[state.month][state.location].days[dateKey] = entries;
    var range = weekRange(parseDateKey(dateKey));
    var history = buildHoursHistory(draft, state.staff);
    var summary = summarizeHours(filterHoursHistory(history, range));
    var entryNames = entries.map(function (entry) {
      return cleanScheduleName(entry).toLowerCase();
    });
    return summary.filter(function (item) {
      return item.weeklyHours >= OVERTIME_LIMIT && entryNames.indexOf(item.staffName.toLowerCase()) !== -1;
    }).map(function (item) {
      var label = item.weeklyHours > OVERTIME_LIMIT ? "Overtime Alert" : "Warning";
      var overtime = Math.max(0, item.weeklyHours - OVERTIME_LIMIT);
      return label + ": Adding this shift will increase " + item.staffName + "'s weekly total to " + formatHours(item.weeklyHours) + " hours" + (overtime > 0 ? ", resulting in " + formatHours(overtime) + " overtime hours." : ".");
    });
  }

  function hoursSorter(sortKey) {
    return function (a, b) {
      if (sortKey === "nameAsc") return a.staffName.localeCompare(b.staffName);
      if (sortKey === "overtimeDesc") return b.overtimeHours - a.overtimeHours || a.staffName.localeCompare(b.staffName);
      if (sortKey === "monthlyDesc") return b.monthlyHours - a.monthlyHours || a.staffName.localeCompare(b.staffName);
      return b.weeklyHours - a.weeklyHours || a.staffName.localeCompare(b.staffName);
    };
  }

  function totalHours(items) {
    return items.reduce(function (totals, item) {
      totals.regular += Number(item.regularHours || 0);
      totals.overtime += Number(item.overtimeHours || 0);
      totals.total += Number(item.totalScheduledHours || item.weeklyHours || 0);
      return totals;
    }, { regular: 0, overtime: 0, total: 0 });
  }

  function hoursStatus(weeklyHours) {
    if (weeklyHours > OVERTIME_LIMIT) return "Overtime Alert";
    if (weeklyHours >= 36) return "Warning";
    return "Green";
  }

  function statusClass(status) {
    if (status === "Overtime Alert") return "status-red";
    if (status === "Warning") return "status-yellow";
    return "status-green";
  }

  function statusPillClass(status) {
    if (status === "Overtime Alert") return "red";
    if (status === "Warning") return "gold";
    return "teal";
  }

  function weekRange(date) {
    var start = addDays(date, -((date.getDay() + 6) % 7));
    var end = addDays(start, 6);
    return { startDate: toDateKey(start), endDate: toDateKey(end), start: toDateKey(start), end: toDateKey(end) };
  }

  function monthRange(monthKey) {
    var parts = monthParts(monthKey);
    var end = new Date(parts.year, parts.month, 0).getDate();
    return { startDate: monthKey + "-01", endDate: monthKey + "-" + String(end).padStart(2, "0"), start: monthKey + "-01", end: monthKey + "-" + String(end).padStart(2, "0") };
  }

  function getWeekNumber(dateKey) {
    var date = parseDateKey(dateKey);
    var target = new Date(date.valueOf());
    var dayNumber = (date.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNumber + 3);
    var firstThursday = new Date(target.getFullYear(), 0, 4);
    var firstDayNumber = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - firstDayNumber + 3);
    return 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  }

  function getWeekYear(dateKey) {
    var date = parseDateKey(dateKey);
    var target = new Date(date.valueOf());
    var dayNumber = (date.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNumber + 3);
    return target.getFullYear();
  }

  function roundHours(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function formatHours(value) {
    var rounded = roundHours(value);
    return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(2);
  }

  function persistStaff() {
    setStored("staff", state.staff);
    state.pendingWrites += 1;
    setSyncStatus("loading", "Saving");
    apiCall("saveStaffRecords", { records: state.staff }).then(function (result) {
      if (result && result.versions) {
        state.syncVersions = result.versions;
        setStored("syncVersions", state.syncVersions);
      }
      setSyncStatus("synced", "Saved");
    }).catch(function (error) {
      showToast("Staff saved locally. " + error.message);
      setSyncStatus("offline", "Offline");
    }).finally(function () {
      state.pendingWrites = Math.max(0, state.pendingWrites - 1);
    });
  }

  function persistScheduleDay(dateKey, locationName, entries, successMessage) {
    state.pendingWrites += 1;
    setSyncStatus("loading", "Saving");
    setCalendarSyncing(true);
    setScheduleSaveBusy(true);
    return apiCall("saveScheduleDayAndReturnMonth", {
      date: dateKey,
      location: locationName,
      entries: entries
    }, { attempts: 1, retry: false, timeout: 40000 }).then(function (result) {
      applyScheduleMonthPayload(result || {}, { render: true, force: true });
      state.lastSyncAt = result && result.serverTime ? result.serverTime : new Date().toISOString();
      setSyncStatus("synced", lastUpdatedLabel(state.lastSyncAt));
      showToast(successMessage || "Schedule saved from Google Sheet");
    }).catch(function (error) {
      showToast("Google Sheet save failed. Schedule was not changed. " + error.message);
      setSyncStatus("offline", "Offline");
    }).finally(function () {
      state.pendingWrites = Math.max(0, state.pendingWrites - 1);
      setCalendarSyncing(false);
      setScheduleSaveBusy(false);
    });
  }

  function setScheduleSaveBusy(active) {
    var saveButton = $("#saveDayBtn");
    if (!saveButton) return;
    saveButton.disabled = Boolean(active) || !state.selectedDate;
    saveButton.textContent = active ? "Saving..." : "Save Day";
  }

  function setRefreshBusy(active) {
    var refreshButton = $("#refreshScheduleBtn");
    if (!refreshButton) return;
    refreshButton.disabled = Boolean(active);
    refreshButton.textContent = active ? "Refreshing..." : "Refresh from Google Sheet";
  }

  function resetLocalData() {
    var confirmed = window.confirm("Reset local RosterPro data to the delivered seed records?");
    if (!confirmed) return;
    ["staff", "schedules", "locations", "accounts", "session", "syncVersions"].forEach(function (key) {
      localStorage.removeItem(storagePrefix + key);
    });
    state.staff = clone(seed.staff);
    state.schedules = clone(seed.schedules);
    state.locations = clone(seed.locations);
    state.accounts = clone(seed.localAccounts);
    state.syncVersions = {};
    fillControls();
    render();
    showToast("Local data reset");
  }

  function exportStaffCsv() {
    var headers = ["FullName", "Email", "OfficePhoneNumber", "PersonalPhoneNumber", "JobTitle", "Department", "OfficeLocation", "EmploymentStatus"];
    var rows = state.staff.map(function (staff) {
      return [staff.fullName, staff.email, staff.phoneNumber, staff.personalPhoneNumber, staff.jobTitle, staff.department, staff.officeLocation, staff.employmentStatus];
    });
    downloadCsv("rosterpro-staff.csv", [headers].concat(rows));
  }

  function exportScheduleCsv() {
    var schedule = ensureSchedule(state.month, state.location);
    var rows = [["Date", "Location", "StaffName"]];
    Object.keys(schedule.days).sort().forEach(function (date) {
      schedule.days[date].forEach(function (name) {
        rows.push([date, state.location, name]);
      });
    });
    downloadCsv("rosterpro-" + state.location.toLowerCase() + "-" + state.month + ".csv", rows);
  }

  function exportHoursCsv() {
    var rows = state.hoursRangeRows.length ? state.hoursRangeRows : filterHoursHistory(state.hoursHistory, {
      startDate: state.hoursStartDate,
      endDate: state.hoursEndDate
    });
    rows = rows.filter(function (row) {
      return !state.hoursFilter || (row.staffName + " " + row.department + " " + row.location).toLowerCase().indexOf(state.hoursFilter) !== -1;
    });
    var csvRows = [["StaffName", "ShiftDate", "WeekNumber", "StartTime", "EndTime", "HoursWorked", "RegularHours", "OvertimeHours", "Location", "Department"]];
    rows.forEach(function (row) {
      csvRows.push([row.staffName, row.shiftDate, row.weekNumber, row.startTime, row.endTime, row.hoursWorked, row.regularHours, row.overtimeHours, row.location, row.department]);
    });
    downloadCsv("rosterpro-hours-" + state.hoursStartDate + "-to-" + state.hoursEndDate + ".csv", csvRows);
  }

  function downloadCsv(filename, rows) {
    var csv = rows.map(function (row) {
      return row.map(csvCell).join(",");
    }).join("\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    var text = String(value == null ? "" : value);
    return "\"" + text.replace(/"/g, "\"\"") + "\"";
  }

  function monthParts(monthKey) {
    var parts = monthKey.split("-").map(Number);
    return { year: parts[0], month: parts[1] };
  }

  function monthTitle(monthKey) {
    var parts = monthParts(monthKey);
    return fullMonths[parts.month - 1] + " " + parts.year;
  }

  function calendarDates(monthKey) {
    var parts = monthParts(monthKey);
    var first = new Date(parts.year, parts.month - 1, 1);
    var last = new Date(parts.year, parts.month, 0);
    var mondayOffset = (first.getDay() + 6) % 7;
    var start = addDays(first, -mondayOffset);
    var total = Math.ceil((mondayOffset + last.getDate()) / 7) * 7;
    var dates = [];
    for (var index = 0; index < total; index += 1) {
      dates.push(addDays(start, index));
    }
    return dates;
  }

  function parseDateKey(key) {
    var parts = key.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function toDateKey(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function addDays(date, days) {
    var next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    next.setDate(next.getDate() + days);
    return next;
  }

  function longDateTitle(key) {
    var date = parseDateKey(key);
    return weekdays[(date.getDay() + 6) % 7] + ", " + shortMonths[date.getMonth()] + " " + date.getDate() + ", " + date.getFullYear();
  }

  function cleanScheduleName(name) {
    return String(name || "").replace(/\s*\([^)]*\)/g, "").trim();
  }

  function debounce(fn, wait) {
    var timer;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(null, args);
      }, wait);
    };
  }

  function showToast(message) {
    var toast = $("#toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () {
      toast.hidden = true;
    }, 2200);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function titleCase(value) {
    return String(value || "").toLowerCase().replace(/\b\w/g, function (letter) {
      return letter.toUpperCase();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
