/**
 * Thrown when a request BODY fails to parse as JSON. Every handler that reads a JSON body
 * routes its parse failure through this type so the router's top-level catch answers a single
 * `400 invalid_json` — while a server-side JSON.parse fault (stored-record reads, decrypt)
 * stays an uncaught error and still surfaces as an audited `500`.
 */
export class InvalidJsonBodyError extends Error {}
