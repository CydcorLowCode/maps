export type LatLngPoint = { lat: number; lng: number };

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(a: LatLngPoint, b: LatLngPoint): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(x));
}

// Returns clusters as arrays of indices into `points`.
// Mirrors the backend single-link gap clustering with small-cluster merge.
export function clusterByGap<T extends LatLngPoint>(
  points: T[],
  epsMeters: number,
  minSize: number,
): number[][] {
  const n = points.length;
  if (n === 0) return [];
  const parents = Array.from({ length: n }, (_, i) => i);

  const find = (i: number): number => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parents[ri] = rj;
  };

  if (epsMeters > 0) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (haversineMeters(points[i], points[j]) <= epsMeters) {
          union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let bucket = groups.get(r);
    if (!bucket) {
      bucket = [];
      groups.set(r, bucket);
    }
    bucket.push(i);
  }
  let clusters = [...groups.values()];

  if (minSize > 1 && clusters.length > 1) {
    const big = clusters.filter((c) => c.length >= minSize);
    const small = clusters.filter((c) => c.length < minSize);
    if (big.length > 0) {
      for (const s of small) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let k = 0; k < big.length; k++) {
          let minD = Infinity;
          for (const i of s) {
            for (const j of big[k]) {
              const d = haversineMeters(points[i], points[j]);
              if (d < minD) minD = d;
            }
          }
          if (minD < bestDist) {
            bestDist = minD;
            bestIdx = k;
          }
        }
        big[bestIdx].push(...s);
      }
      clusters = big;
    }
  }

  return clusters;
}
