export function divide(a, b) {
  if (typeof a !== "number" || typeof b !== "number") {
    throw new TypeError("Inputs must be numbers");
  }

  if (b === 0) {
    throw new Error("Division by zero");
  }

  return a / b;
}

export function calculateDiscount(price, percentage) {
  if (price < 0 || percentage < 0) {
    throw new Error("Negative values are not allowed");
  }

  if (percentage > 100) {
    throw new Error("Discount percentage cannot exceed 100");
  }

  return price - (price * percentage) / 100;
}

export function factorial(n) {
  if (!Number.isInteger(n)) {
    throw new TypeError("Input must be an integer");
  }

  if (n < 0) {
    throw new Error("Negative numbers are not allowed");
  }

  if (n === 0 || n === 1) {
    return 1;
  }

  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}