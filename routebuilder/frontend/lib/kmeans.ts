export type Point = { lat: number; lng: number };

// Squared Euclidean is fine for clustering at city scale where lat/lng are
// approximately Cartesian over short ranges.
function sqrDist(a: Point, b: Point): number {
  const dy = a.lat - b.lat;
  const dx = a.lng - b.lng;
  return dy * dy + dx * dx;
}

// Deterministic 2-means: seed with the two most-distant points so a Split
// always returns the same partition for the same input.
export function splitInto2(points: Point[], iterations = 25): number[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  let i0 = 0;
  let i1 = 1;
  let maxD = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = sqrDist(points[i], points[j]);
      if (d > maxD) {
        maxD = d;
        i0 = i;
        i1 = j;
      }
    }
  }

  const centers: Point[] = [
    { lat: points[i0].lat, lng: points[i0].lng },
    { lat: points[i1].lat, lng: points[i1].lng },
  ];
  const assignments = new Array<number>(n).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const d0 = sqrDist(points[i], centers[0]);
      const d1 = sqrDist(points[i], centers[1]);
      const next = d0 <= d1 ? 0 : 1;
      if (assignments[i] !== next) {
        assignments[i] = next;
        changed = true;
      }
    }
    if (!changed) break;

    for (let k = 0; k < 2; k++) {
      let count = 0;
      let lat = 0;
      let lng = 0;
      for (let i = 0; i < n; i++) {
        if (assignments[i] === k) {
          lat += points[i].lat;
          lng += points[i].lng;
          count += 1;
        }
      }
      if (count > 0) {
        centers[k] = { lat: lat / count, lng: lng / count };
      }
    }
  }

  return assignments;
}
