import { registerApiRoute } from '@mastra/core/server';
import { runtimeMetrics, type RuntimeMetrics } from '../../observability/metrics.ts';

/** GET /metrics in Prometheus text exposition format, served by the existing Mastra server. */
export function createMetricsRoute(metrics: Pick<RuntimeMetrics, 'render' | 'contentType'> = runtimeMetrics) {
  return registerApiRoute('/metrics', {
    method: 'GET',
    handler: async (c) => {
      try {
        return c.body(await metrics.render(), 200, { 'Content-Type': metrics.contentType, 'Cache-Control': 'no-store' });
      } catch {
        return c.text('metrics unavailable\n', 500);
      }
    },
  });
}
