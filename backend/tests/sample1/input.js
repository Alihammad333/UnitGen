import axios from "axios";
import { readFileSync } from "fs";
import * as path from "path";

export function divide(a, b) {
  if (b === 0) {
    throw new Error("Division by zero");
  }
  return a / b;
}

export async function fetchUser(id) {
  const file = path.join("data", "x.txt");
  const txt = readFileSync(file, "utf8");
  const res = await axios.get(`/user/${id}`);
  return { id, txt, data: res.data };
}
