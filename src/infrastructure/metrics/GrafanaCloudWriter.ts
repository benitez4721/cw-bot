import { pushTimeseries } from 'prometheus-remote-write';
import type { Registry } from 'prom-client';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'GrafanaCloudWriter' });

interface PromValue {
  value: number;
  labels?: Record<string, string | number>;
  metricName?: string;
}

interface PromMetric {
  name: string;
  type: string;
  values: PromValue[];
}

interface Timeseries {
  labels: { __name__: string; [key: string]: string };
  samples: { value: number; timestamp?: number }[];
}

export interface GrafanaCloudWriterOptions {
  registry: Registry;
  url: string;
  username: string;
  apiKey: string;
  intervalMs?: number;
}

export class GrafanaCloudWriter {
  private readonly registry: Registry;
  private readonly url: string;
  private readonly username: string;
  private readonly apiKey: string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: GrafanaCloudWriterOptions) {
    this.registry = options.registry;
    this.url = options.url;
    this.username = options.username;
    this.apiKey = options.apiKey;
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.push(), this.intervalMs);
    log.info({ intervalMs: this.intervalMs }, 'started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async push(): Promise<void> {
    try {
      const metrics =
        (await this.registry.getMetricsAsJSON()) as unknown as PromMetric[];
      const series = toTimeseries(metrics);
      if (series.length === 0) return;
      const result = await pushTimeseries(series, {
        url: this.url,
        auth: { username: this.username, password: this.apiKey },
      });
      if (result.status >= 300) {
        log.warn(
          {
            status: result.status,
            statusText: result.statusText,
            err: result.errorMessage,
          },
          'remote_write non-2xx',
        );
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'remote_write failed',
      );
    }
  }
}

function toTimeseries(metrics: PromMetric[]): Timeseries[] {
  const out: Timeseries[] = [];
  const ts = Date.now();
  for (const metric of metrics) {
    for (const v of metric.values) {
      const labels: { __name__: string; [key: string]: string } = {
        __name__: v.metricName ?? metric.name,
      };
      if (v.labels) {
        for (const [k, val] of Object.entries(v.labels)) {
          labels[k] = String(val);
        }
      }
      out.push({ labels, samples: [{ value: v.value, timestamp: ts }] });
    }
  }
  return out;
}
