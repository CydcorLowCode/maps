// Google Encoded Polyline Algorithm Format decoder.
// ORS returns geometry in this format with precision 5 by default.
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm

export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = Math.pow(10, precision);
  const len = encoded.length;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < len) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
