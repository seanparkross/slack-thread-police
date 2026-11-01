import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Config } from "./config.js";

/**
 * The System One client. `baseURL` can point at any `/v1/systemone`-compatible server (such as
 * llama.cpp's llama-server) to swap the hosted Jev model for a self-hosted one.
 */
export function createDecisionClient(config: Config): TypeSafeClient {
  const { apiKey, baseURL, model, timeoutMs, compression } = config.decision;
  return new TypeSafeClient({
    apiKey,
    defaultModel: model,
    timeout: timeoutMs,
    // A nudge that arrives long after the message is worse than none, so retry once at most.
    retry: { maxRetries: 1 },
    // The SDK's `debug` level logs request bodies, which hold message text; cap it at `info`.
    logLevel: config.logLevel === "debug" ? "info" : "warn",
    ...(baseURL !== undefined && { baseURL }),
    ...(compression !== undefined && { compression }),
  });
}
