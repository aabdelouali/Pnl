export class Random {
  constructor(seed = 1) {
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 1;
    }
  }

  next() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }

  float(min = 0, max = 1) {
    return min + (max - min) * this.next();
  }

  int(minInclusive, maxExclusive) {
    if (maxExclusive <= minInclusive) {
      return minInclusive;
    }
    return Math.floor(this.float(minInclusive, maxExclusive));
  }

  pick(array) {
    return array[this.int(0, array.length)];
  }

  gaussian(mean = 0, stdDev = 1) {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = Math.max(this.next(), 1e-12);
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    return mean + z0 * stdDev;
  }
}
