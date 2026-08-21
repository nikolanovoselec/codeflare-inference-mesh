/**
 * Where this Worker answers from, as the setup flow and the gateway both need to know it.
 *
 * The custom domain wins once provisioned, because that is the hostname the console and
 * the agents are told to use; otherwise the deployment falls back to its workers.dev origin.
 */
import { cleanString } from './http'

export function publicWorkerOrigin(configuredUrl: string | undefined, requestUrl: string): string {
  return usableWorkerBaseUrl(configuredUrl) ?? new URL(requestUrl).origin
}

export function usableWorkerBaseUrl(value: string | undefined): string | undefined {
  const cleaned = cleanString(value)
  if (!cleaned || cleaned.includes('<your-subdomain>')) return undefined
  return cleaned
}
