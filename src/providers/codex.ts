/**
 * Codex provider container config — passes the ChatGPT OAuth access token
 * into the container so the agent-runner can call the Codex API.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const env: Record<string, string> = {};
  const token = ctx.hostEnv.OPENAI_ACCESS_TOKEN;
  if (token) {
    env.OPENAI_ACCESS_TOKEN = token;
  }
  return { env };
});
