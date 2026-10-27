export type CoordinateSystem = "wgs84" | "gcj02";
export interface GeoPoint { readonly latitude: number; readonly longitude: number; readonly crs?: CoordinateSystem }

/** 高德使用 GCJ-02，OSM/OSRM 使用 WGS84；境外不加偏移。缺省兼容历史 WGS84 接口。 */
export function convertPoint(point: GeoPoint, target: CoordinateSystem): GeoPoint {
  if ((point.crs ?? "wgs84") === target) return { ...point, crs: target };
  const { latitude: lat, longitude: lon } = point;
  if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return { ...point, crs: target };
  if (target === "gcj02") return { ...offset(lat, lon), crs: target };
  // 迭代逆解，避免仅减一次偏移产生米级残差。
  let result = { latitude: lat, longitude: lon };
  for (let i = 0; i < 8; i++) {
    const mapped = offset(result.latitude, result.longitude);
    result = { latitude: result.latitude + lat - mapped.latitude, longitude: result.longitude + lon - mapped.longitude };
  }
  return { ...result, crs: target };
}

function offset(lat: number, lon: number): GeoPoint {
  const x = lon - 105, y = lat - 35, pi = Math.PI;
  let dLat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  let dLon = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  dLat += (20*Math.sin(6*x*pi) + 20*Math.sin(2*x*pi))*2/3;
  dLat += (20*Math.sin(y*pi) + 40*Math.sin(y*pi/3))*2/3;
  dLat += (160*Math.sin(y*pi/12) + 320*Math.sin(y*pi/30))*2/3;
  dLon += (20*Math.sin(6*x*pi) + 20*Math.sin(2*x*pi))*2/3;
  dLon += (20*Math.sin(x*pi) + 40*Math.sin(x*pi/3))*2/3;
  dLon += (150*Math.sin(x*pi/12) + 300*Math.sin(x*pi/30))*2/3;
  const rad = lat*pi/180, magic = 1 - 0.006693421622965943*Math.sin(rad)**2, sqrt = Math.sqrt(magic);
  return { latitude: lat + dLat*180/((6378245*(1-0.006693421622965943))/(magic*sqrt)*pi), longitude: lon + dLon*180/(6378245/sqrt*Math.cos(rad)*pi) };
}
