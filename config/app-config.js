window.RosterProConfig = {
  environment: "production",
  apiBaseUrl: "https://script.google.com/macros/s/AKfycbzKZF96HT5Ufvy6F-z7Tlj_gQTNp2fPyPIaHgWmZ3Zc0ZR4G6cu7lXauiBU7ivFX6yfEg/exec",
  sync: {
    enabled: true,
    intervalMs: 15000,
    scheduleIntervalMs: 3000,
    dashboardRefreshMs: 45000,
    staffRefreshMs: 60000
  },
  performance: {
    hoursHistoryPageSize: 250,
    apiTimeoutMs: 18000,
    apiRetryAttempts: 3
  }
};
