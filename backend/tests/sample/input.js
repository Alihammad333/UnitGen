/**
 * @class DataStreamProcessor
 * This is the refined version with inline exports for your framework to detect.
 */
export class DataStreamProcessor {
  constructor(windowSize = 3) {
    this.windowSize = windowSize;
    this.buffer = [];
    this.cache = new Map();
  }

  /**
   * Challenge 1: Async state management. 
   * Testing if UnitGen handles Promises and buffer shifts correctly.
   */
  async process(value) {
    if (typeof value !== 'number' || isNaN(value)) {
      throw new TypeError("Stream input must be a valid number");
    }

    // Artificial delay to test if UnitGen uses 'await' in generated tests
    await new Promise(resolve => setTimeout(resolve, 50));

    this.buffer.push(value);
    if (this.buffer.length > this.windowSize) {
      this.buffer.shift();
    }

    const sum = this.buffer.reduce((acc, val, idx) => acc + val * (idx + 1), 0);
    const weightSum = (this.buffer.length * (this.buffer.length + 1)) / 2;
    const result = sum / weightSum;

    this.cache.set(Date.now(), result);
    return parseFloat(result.toFixed(4));
  }

  /**
   * Challenge 2: Data transformation and math.
   * Testing if Assertion Enhancer can calculate variance accurately.
   */
  getStatistics(msThreshold) {
    const now = Date.now();
    const relevantValues = Array.from(this.cache.entries())
      .filter(([timestamp]) => now - timestamp < msThreshold)
      .map(([, val]) => val);

    if (relevantValues.length === 0) return { mean: 0, variance: 0 };

    const mean = relevantValues.reduce((a, b) => a + b, 0) / relevantValues.length;
    const variance = relevantValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / relevantValues.length;

    return {
      mean: parseFloat(mean.toFixed(4)),
      variance: parseFloat(variance.toFixed(4))
    };
  }
}

/**
 * Challenge 3: Independent Function
 * Testing if your tool picks up both classes and stand-alone functions.
 */
export function validateThreshold(val) {
    return val >= 0 && val <= 1000;
}