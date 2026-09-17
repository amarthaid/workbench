// Telemetry init is wrapped in try/catch — server must boot even when
// OpenTelemetry deps are partially installed or mismatched (e.g. local
// dev with hoisted v2 resources vs locked v1 in workspace).
import { trace, SpanStatusCode } from "@opentelemetry/api";

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const resourcesPkg = require("@opentelemetry/resources");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // ATTR_* are the 1.x+ constants; SemanticResourceAttributes is a deprecated
  // shim that the 2.x line still exports but no longer documents.
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerInstrumentations } = require("@opentelemetry/instrumentation");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");

  // v2 exposes resourceFromAttributes; v1 exposes Resource constructor.
  const buildResource = resourcesPkg.resourceFromAttributes
    ? resourcesPkg.resourceFromAttributes
    : (attrs: Record<string, unknown>) => new resourcesPkg.Resource(attrs);

  const resource = buildResource({
    [ATTR_SERVICE_NAME]: "a-workbench",
    [ATTR_SERVICE_VERSION]: "0.1.0",
  });

  const provider = new NodeTracerProvider({ resource });
  provider.register();

  // Both of these paths carry a single-use credential in the URL itself — the
  // vault one-time link and the jot upload token. HTTP instrumentation records
  // the path as `http.target`, so a span for either would put the credential
  // wherever spans go. No exporter is configured today (`traceExporter:
  // undefined`), but that is a default someone will change; the span must
  // never exist in the first place.
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req: { url?: string }) =>
          /^\/(api\/vault\/otl|j\/upload)\//.test(req.url ?? ""),
      }),
    ],
  });

  const sdk = new NodeSDK({ resource, traceExporter: undefined });
  sdk.start();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  // eslint-disable-next-line no-console
  console.warn(`[telemetry] disabled: ${msg}`);
}

export const tracer = trace.getTracer("a-workbench");

export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err });
      span.recordException(err);
      throw e;
    } finally {
      span.end();
    }
  });
}
