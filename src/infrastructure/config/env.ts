export const env = {
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST,
  TZ: process.env.TZ,
  TRADESTATION_CLIENT_ID: process.env.TRADESTATION_CLIENT_ID,
  TRADESTATION_CLIENT_SECRET: process.env.TRADESTATION_CLIENT_SECRET,
  TRADESTATION_REFRESH_TOKEN: process.env.TRADESTATION_REFRESH_TOKEN,
  TRADESTATION_ACCOUNT_ID: process.env.TRADESTATION_ACCOUNT_ID,
  TRADESTATION_SIM_URL:
    process.env.TRADESTATION_SIM_URL || 'https://sim.api.tradestation.com',
  TRADESTATION_LIVE_URL:
    process.env.TRADESTATION_LIVE_URL || 'https://api.tradestation.com',
  TRADESTATION_SIGNIN_URL:
    process.env.TRADESTATION_SIGNIN_URL || 'https://signin.tradestation.com',
  CW_ENABLED: (process.env.CW_ENABLED ?? 'true').toLowerCase() !== 'false',
  CW_WS_URL:
    process.env.CW_WS_URL || 'wss://app.chartswatcher.com/api/v1/websocket',
  CW_USER_ID: process.env.CW_USER_ID,
  CW_API_KEY: process.env.CW_API_KEY,
  CW_CONFIG_ID: process.env.CW_CONFIG_ID,
  ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY,
  ALPHA_VANTAGE_BASE_URL:
    process.env.ALPHA_VANTAGE_BASE_URL || 'https://www.alphavantage.co/query',
  ALPHA_VANTAGE_MIN_INTERVAL_MS:
    Number(process.env.ALPHA_VANTAGE_MIN_INTERVAL_MS) || 250,
  TWELVEDATA_API_KEY: process.env.TWELVEDATA_API_KEY,
  TWELVEDATA_BASE_URL:
    process.env.TWELVEDATA_BASE_URL || 'https://api.twelvedata.com',
  TWELVEDATA_MIN_INTERVAL_MS:
    Number(process.env.TWELVEDATA_MIN_INTERVAL_MS) || 7500,
  POLYGON_API_KEY: process.env.POLYGON_API_KEY,
  POLYGON_WS_URL:
    process.env.POLYGON_WS_URL || 'wss://socket.polygon.io/stocks',
  BOOTSTRAP_BARS: Number(process.env.BOOTSTRAP_BARS) || 200,
  DECISION_ENABLED:
    (process.env.DECISION_ENABLED ?? 'true').toLowerCase() !== 'false',
  REDIS_URL: process.env.REDIS_URL,
  API_TOKEN: process.env.API_TOKEN,
  LOGTAIL_SOURCE_TOKEN: process.env.LOGTAIL_SOURCE_TOKEN,
  BETTERSTACK_HEARTBEAT_URL: process.env.BETTERSTACK_HEARTBEAT_URL,
  GRAFANA_CLOUD_PROM_URL: process.env.GRAFANA_CLOUD_PROM_URL,
  GRAFANA_CLOUD_PROM_USERNAME: process.env.GRAFANA_CLOUD_PROM_USERNAME,
  GRAFANA_CLOUD_PROM_API_KEY: process.env.GRAFANA_CLOUD_PROM_API_KEY,
};
