/**
 * GET /api/advisor/distance?origins=<lat,lng>&destinations=<lat,lng>
 *
 * Proxy for the Google Maps Distance Matrix API; the key stays server-side. The client only ever
 * sends one "lat,lng" pair per side (see normalizeCoord in the Advisor distance service), so that
 * is all that is accepted: otherwise any signed-in user could spend the key on arbitrary queries.
 * The Google response is returned unchanged on success; upstream error details are not forwarded.
 */

import { guard } from '../_lib/guard.js';
import { send } from '../_lib/respond.js';

const DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const MAX_PARAM_LENGTH = 64;
const NUMBER = /^-?\d{1,3}(?:\.\d{1,17})?$/;

/** Parses exactly one "lat,lng" pair. Returns "lat,lng" (normalised) or null. */
export function parseCoordinatePair(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PARAM_LENGTH) return null;
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length !== 2 || !parts.every((p) => NUMBER.test(p))) return null;
  const [lat, lng] = parts.map(Number);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return null;
  return `${lat},${lng}`;
}

export default async function handler(req, res) {
  if (!(await guard(req, res, 'advisor'))) return;

  const { origins, destinations } = req.query || {};
  if (origins === undefined || destinations === undefined) {
    return send(res, 400, { error: 'Missing required parameters: origins and destinations.' });
  }
  const origin = parseCoordinatePair(origins);
  const destination = parseCoordinatePair(destinations);
  if (!origin || !destination) {
    return send(res, 400, { error: 'origins and destinations must each be a single "latitude,longitude" pair.' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY environment variable is not set.');
    return send(res, 500, { error: 'The distance service is not configured on the server.' });
  }

  const url = `${DISTANCE_MATRIX_URL}?${new URLSearchParams({ origins: origin, destinations: destination, units: 'metric', key: apiKey })}`;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    console.error('Network error reaching Google Distance Matrix API:', err.message);
    return send(res, 502, { error: 'Could not reach the distance service.' });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return send(res, 502, { error: 'Unreadable response from the distance service.' });
  }

  if (!response.ok || data.status === 'REQUEST_DENIED') {
    console.error('Google Distance Matrix error:', data.error_message || data.status || `HTTP ${response.status}`);
    return send(res, 502, { error: 'The distance service could not complete the request.' });
  }

  return send(res, 200, data);
}
