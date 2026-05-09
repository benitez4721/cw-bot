import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('REDIS_URL no esta seteada en el entorno');
  process.exit(1);
}

const redacted = url.replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1***$2');
console.log(`[redis:flush] target=${redacted}`);

const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });

try {
  await redis.connect();
  const before = await redis.dbsize();
  console.log(`[redis:flush] keys antes: ${before}`);

  await redis.flushdb();

  const after = await redis.dbsize();
  console.log(`[redis:flush] keys despues: ${after}`);
  console.log(`[redis:flush] eliminadas: ${before - after}`);
} catch (err) {
  console.error('[redis:flush] error:', err);
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
