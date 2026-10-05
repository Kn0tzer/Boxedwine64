// Shared numeric PNG gate: a uniform clear color never proves geometry.
import { inflateSync } from 'node:zlib';
export function trianglePixels(png) {
  let width, height, channels, pos = 8;
  const data = [];
  while (pos + 12 <= png.length) {
    const n = png.readUInt32BE(pos), type = png.toString('ascii', pos + 4, pos + 8), b = png.subarray(pos + 8, pos + 8 + n);
    if (type === 'IHDR') {
      width = b.readUInt32BE(0); height = b.readUInt32BE(4);
      channels = ({ 2: 3, 6: 4 })[b[9]];
      if (b[8] !== 8 || !channels) throw new Error('Unsupported PNG pixel encoding');
    } else if (type === 'IDAT') data.push(b);
    pos += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels, rgb = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const a = x >= channels ? rgb[y * stride + x - channels] : 0;
    const b = y ? rgb[(y - 1) * stride + x] : 0;
    const c = y && x >= channels ? rgb[(y - 1) * stride + x - channels] : 0;
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    const f = raw[y * (stride + 1)];
    const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
    if (predictor === undefined) throw new Error('Invalid PNG row filter');
    rgb[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
  }
  const at = (x, y) => [...rgb.subarray((y * width + x) * channels, (y * width + x) * channels + 3)];
  const displayPoint = (x, y) => at(Math.min(width - 1, Math.floor(x * width / 480)), Math.min(height - 1, Math.floor(y * height / 360)));
  const bg = at(5, 5), close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 8);
  let nonBackground = 0, red = 0, green = 0, blue = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const c = at(x, y);
    if (!close(c, bg)) {
      nonBackground++;
      if (c[0] > c[1] + 20 && c[0] > c[2] + 20) red++;
      if (c[1] > c[0] + 20 && c[1] > c[2] + 20) green++;
      if (c[2] > c[0] + 20 && c[2] > c[1] + 20) blue++;
    }
  }
  // Expected tri9 vertices: red (240,60), green (420,300), blue (60,300).
  // Test stable interior points plus exterior background, so clear-only fails.
  const points = { red: displayPoint(240, 85), green: displayPoint(380, 280), blue: displayPoint(100, 280), exterior: displayPoint(20, 180), center: displayPoint(240, 220) };
  const expectedTriangleArea = width * height * 0.25;
  const triangle = nonBackground > expectedTriangleArea * 0.7 && nonBackground < expectedTriangleArea * 1.3
    && red > 3000 && green > 3000 && blue > 3000 && close(points.exterior, bg)
    && points.red[0] > points.red[1] + 50 && points.red[0] > points.red[2] + 50
    && points.green[1] > points.green[0] + 50 && points.green[1] > points.green[2] + 50
    && points.blue[2] > points.blue[0] + 50 && points.blue[2] > points.blue[1] + 50;
  return { width, height, background: bg, nonBackground, expectedTriangleArea, red, green, blue, points, triangle };
}
