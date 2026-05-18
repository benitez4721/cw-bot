// Raised by IndicatorPort adapters when the underlying bar cache for a symbol
// is missing or too short to compute the requested indicator. The application
// layer uses this to trigger a re-bootstrap of the cache (e.g. when an
// operator manually flushes Redis while the bot keeps running).
export class CacheUnderfilledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheUnderfilledError';
  }
}
